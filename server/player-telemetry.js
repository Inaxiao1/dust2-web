import { getWeapon } from '../shared/weapons.js';
import { percentiles } from './telemetry-store.js';

const RTT_RING_SIZE = 64;
const AIM_HISTORY_SIZE = 6;
const AC_COOLDOWN_MS = 30000;

function angleDeltaDeg(y1, p1, y2, p2) {
  let dy = y2 - y1;
  while (dy > Math.PI) dy -= Math.PI * 2;
  while (dy < -Math.PI) dy += Math.PI * 2;
  const dp = p2 - p1;
  return Math.hypot(dy, dp) * (180 / Math.PI);
}

function pushRing(arr, val, limit) {
  if (arr.length >= limit) arr.shift();
  arr.push(val);
}

/**
 * Lightweight per-worker player network, combat, and anti-cheat session tracker.
 * Accumulates flat numeric counters in RAM (~300 B/player) with zero hot-path disk I/O,
 * emitting one compact session record on leave/match-end and rate-limited anomaly alerts.
 */
export function createPlayerTelemetry({
  mapId = 'de_dust2',
  emitEvent = null,
  hashIp = (ip) => ip || '',
} = {}) {
  const sessions = new Map(); // playerId -> session state

  function emit(ev) {
    if (emitEvent) emitEvent(ev);
  }

  function triggerAnomaly(s, rule, sev, val, now = Date.now()) {
    const lastAt = s.acCooldowns[rule] || 0;
    if (now - lastAt < AC_COOLDOWN_MS) return;
    s.acCooldowns[rule] = now;
    s.acTriggered++;
    emit({
      t: Math.floor(now / 1000),
      k: 'ac',
      rule,
      sev,
      m: mapId,
      r: s.room,
      md: s.mode,
      tr: s.transport,
      uid: s.uid || 'anon',
      iph: s.ipHash,
      nm: s.name,
      val,
    });
  }

  function startSession({ playerId, uid, ip, name, room, mode, transport = 'ws' }) {
    const now = Date.now();
    const s = {
      playerId,
      uid: uid || null,
      ipHash: hashIp(ip),
      name: String(name || 'Player').slice(0, 20),
      room: String(room || ''),
      mode: String(mode || 'defuse'),
      transport: transport === 'udp' ? 'udp' : 'ws',
      joinedAt: now,
      // Network samples
      clientRtts: [],
      serverRtts: [],
      jitters: [],
      lastClientRtt: null,
      fpsSamples: [],
      lastInputWallAt: 0,
      pktGapMaxMs: 0,
      lastBigGapAt: 0,
      lastBigGapMs: 0,
      // Movement / rate samples
      inputs: 0,
      invalidInputs: 0,
      rateWinStart: now,
      rateWinCount: 0,
      hzMax: 0,
      spdMax: 0,
      speedStrikes: 0,
      aimRing: [],
      // Combat / anti-cheat samples
      shots: 0,
      hits: 0,
      headshots: 0,
      kills: 0,
      deaths: 0,
      assists: 0,
      dmg: 0,
      wallbangKills: 0,
      throughSmokeKills: 0,
      blindKills: 0,
      airKills: 0,
      noScopeKills: 0,
      killDistSum: 0,
      shotRejected: 0,
      rejectWin: [],
      snapMaxDeg: 0,
      snapHs: 0,
      acCooldowns: Object.create(null),
      acTriggered: 0,
    };
    sessions.set(playerId, s);
    return s;
  }

  function recordClientPing(playerId, { rtt, fps } = {}) {
    const s = sessions.get(playerId);
    if (!s) return;
    if (Number.isFinite(rtt) && rtt >= 1 && rtt <= 5000) {
      const clamped = Math.round(rtt);
      if (s.lastClientRtt !== null) {
        pushRing(s.jitters, Math.abs(clamped - s.lastClientRtt), RTT_RING_SIZE);
      }
      s.lastClientRtt = clamped;
      pushRing(s.clientRtts, clamped, RTT_RING_SIZE);
    }
    if (Number.isFinite(fps) && fps >= 1 && fps <= 1000) {
      pushRing(s.fpsSamples, Math.round(fps), 32);
    }
  }

  function recordServerRtt(playerId, rttMs) {
    const s = sessions.get(playerId);
    if (!s || !Number.isFinite(rttMs) || rttMs < 0.5 || rttMs > 5000) return;
    pushRing(s.serverRtts, Math.round(rttMs), RTT_RING_SIZE);
  }

  function recordInput(playerId, msg, valid, playerAlive, now = Date.now()) {
    const s = sessions.get(playerId);
    if (!s) return;
    if (!valid) {
      s.invalidInputs++;
      return;
    }
    s.inputs++;
    s.rateWinCount++;
    if (now - s.rateWinStart >= 5000) {
      const hz = (s.rateWinCount * 1000) / Math.max(1, now - s.rateWinStart);
      if (hz > s.hzMax) s.hzMax = Number(hz.toFixed(1));
      if (hz > 90 && s.rateWinCount > 450) {
        triggerAnomaly(s, 'HIGH_INPUT_RATE', 2, { hz: Number(hz.toFixed(1)), count: s.rateWinCount }, now);
      }
      s.rateWinStart = now;
      s.rateWinCount = 0;
    }
    if (playerAlive && s.lastInputWallAt > 0) {
      const gap = now - s.lastInputWallAt;
      if (gap < 15000 && gap > s.pktGapMaxMs) s.pktGapMaxMs = gap;
      if (gap >= 1200 && gap < 10000) {
        s.lastBigGapAt = now;
        s.lastBigGapMs = gap;
      }
    }
    s.lastInputWallAt = playerAlive ? now : 0;
    if (Number.isFinite(msg?.yaw) && Number.isFinite(msg?.pitch)) {
      pushRing(s.aimRing, { t: now, yaw: msg.yaw, pitch: msg.pitch }, AIM_HISTORY_SIZE);
    }
  }

  function recordShotRejected(playerId, reason, now = Date.now()) {
    const s = sessions.get(playerId);
    if (!s) return;
    s.shotRejected++;
    if (reason === 'not_ready' || reason === 'queue_full' || reason === 'empty') {
      s.rejectWin.push(now);
      while (s.rejectWin.length && now - s.rejectWin[0] > 10000) s.rejectWin.shift();
      if (s.rejectWin.length >= 10) {
        triggerAnomaly(s, 'SHOT_REJECT_BURST', 1, { count10s: s.rejectWin.length, reason }, now);
      }
    }
  }

  function samplePlayerSpeed(player, now = Date.now()) {
    if (!player || player.bot || !player.alive) return;
    const s = sessions.get(player.id);
    if (!s) return;
    const spd = Math.hypot(player.vx || 0, player.vz || 0);
    if (spd > s.spdMax) s.spdMax = Number(spd.toFixed(2));
    const maxCap = (getWeapon(player.weapon)?.maxSpeed || 6.5) * 1.45;
    if (player.grounded && spd > maxCap) {
      s.speedStrikes++;
      if (s.speedStrikes >= 5) {
        triggerAnomaly(s, 'SPEED_OUTLIER', 2, { spd: Number(spd.toFixed(2)), cap: Number(maxCap.toFixed(2)), wpn: player.weapon }, now);
        s.speedStrikes = 0;
      }
    } else if (s.speedStrikes > 0) {
      s.speedStrikes--;
    }
  }

  function recentAimSnapDeg(s, aim, now) {
    if (!aim || !Number.isFinite(aim.yaw) || !Number.isFinite(aim.pitch) || !s.aimRing.length) return 0;
    let maxDeg = 0;
    for (let i = s.aimRing.length - 1; i >= 0; i--) {
      const sample = s.aimRing[i];
      if (now - sample.t > 120) break;
      const deg = angleDeltaDeg(sample.yaw, sample.pitch, aim.yaw, aim.pitch);
      if (deg > maxDeg) maxDeg = deg;
    }
    return maxDeg;
  }

  function observeRoomEvents(room, events, now = Date.now()) {
    if (!Array.isArray(events) || !events.length) return;
    for (const ev of events) {
      if (!ev || typeof ev !== 'object') continue;
      if (ev.type === 'shot') {
        const s = sessions.get(ev.shooterId);
        if (!s) continue;
        s.shots++;
        const snap = recentAimSnapDeg(s, ev.aim, now);
        if (snap > s.snapMaxDeg) s.snapMaxDeg = Math.round(snap);
      } else if (ev.type === 'hit') {
        const s = sessions.get(ev.shooterId);
        if (!s) continue;
        s.hits++;
        s.dmg += Math.round(Number(ev.damage) || 0);
      } else if (ev.type === 'kill') {
        const victimSession = sessions.get(ev.victimId);
        if (victimSession) victimSession.deaths++;
        if (ev.assisterId) {
          const ast = sessions.get(ev.assisterId);
          if (ast) ast.assists++;
        }
        const s = sessions.get(ev.killerId);
        if (!s) continue;
        s.kills++;
        if (ev.headshot) s.headshots++;
        if (ev.wallbang || ev.penetrated) s.wallbangKills++;
        if (ev.throughSmoke) s.throughSmokeKills++;
        if (ev.attackerBlind) s.blindKills++;
        if (ev.attackerInAir) s.airKills++;
        if (ev.noScope) s.noScopeKills++;
        const killer = room.players.get(ev.killerId);
        const victim = room.players.get(ev.victimId);
        let killDist = 0;
        if (killer && victim) {
          killDist = Math.hypot((killer.x || 0) - (victim.x || 0), (killer.y || 0) - (victim.y || 0), (killer.z || 0) - (victim.z || 0));
          s.killDistSum += killDist;
        }
        if (ev.headshot && ev.weapon !== 'knife') {
          const snap = killer ? recentAimSnapDeg(s, { yaw: killer.yaw, pitch: killer.pitch }, now) : 0;
          if (snap >= 75) {
            s.snapHs++;
            triggerAnomaly(s, 'AIM_SNAP_HS', 2, {
              snapDeg: Math.round(snap),
              wpn: ev.weapon,
              dist: Number(killDist.toFixed(1)),
              k: s.kills,
              hsPct: Math.round((s.headshots / Math.max(1, s.kills)) * 100),
            }, now);
          }
        }
        if (s.kills >= 8) {
          const hsRatio = s.headshots / s.kills;
          if (hsRatio >= 0.85) {
            triggerAnomaly(s, 'HS_OUTLIER', 2, {
              k: s.kills,
              hs: s.headshots,
              hsPct: Math.round(hsRatio * 100),
              wb: s.wallbangKills,
              smk: s.throughSmokeKills,
            }, now);
          }
        }
        if (s.lastBigGapAt > 0 && now - s.lastBigGapAt <= 450) {
          triggerAnomaly(s, 'LAG_SWITCH', 2, {
            gapMs: s.lastBigGapMs,
            dtMs: now - s.lastBigGapAt,
            wpn: ev.weapon,
            hs: Boolean(ev.headshot),
          }, now);
        }
      }
    }
  }

  function finishSession(playerId, reason = 'normal', now = Date.now()) {
    const s = sessions.get(playerId);
    if (!s) return null;
    sessions.delete(playerId);
    const durSec = Math.max(1, Math.round((now - s.joinedAt) / 1000));
    const cRtt = percentiles(s.clientRtts);
    const sRtt = percentiles(s.serverRtts);
    const jit = percentiles(s.jitters);
    const fps = percentiles(s.fpsSamples);
    const record = {
      t: Math.floor(now / 1000),
      k: 'sess',
      m: mapId,
      r: s.room,
      md: s.mode,
      tr: s.transport,
      uid: s.uid || 'anon',
      iph: s.ipHash,
      nm: s.name,
      dur: durSec,
      res: reason,
      net: {
        ...(cRtt ? { n: cRtt.n, p50: cRtt.p50, p95: cRtt.p95, max: cRtt.max } : {}),
        ...(sRtt ? { srvP50: sRtt.p50, srvP95: sRtt.p95 } : {}),
        ...(jit ? { jit: jit.p50 } : {}),
        ...(fps ? { fps: fps.p50 } : {}),
        ...(s.pktGapMaxMs > 0 ? { gapMax: s.pktGapMaxMs } : {}),
      },
      cmb: {
        sh: s.shots,
        hit: s.hits,
        hs: s.headshots,
        k: s.kills,
        d: s.deaths,
        ast: s.assists,
        dmg: s.dmg,
        ...(s.wallbangKills ? { wb: s.wallbangKills } : {}),
        ...(s.throughSmokeKills ? { smk: s.throughSmokeKills } : {}),
        ...(s.blindKills ? { blk: s.blindKills } : {}),
        ...(s.airKills ? { air: s.airKills } : {}),
        ...(s.noScopeKills ? { nosc: s.noScopeKills } : {}),
        ...(s.kills ? { avgD: Number((s.killDistSum / s.kills).toFixed(1)) } : {}),
        ...(s.shotRejected ? { rej: s.shotRejected } : {}),
        ...(s.snapMaxDeg ? { snapMax: s.snapMaxDeg } : {}),
        ...(s.snapHs ? { snapHs: s.snapHs } : {}),
      },
      mov: {
        in: s.inputs,
        hz: Number((s.inputs / durSec).toFixed(1)),
        ...(s.hzMax ? { hzMax: s.hzMax } : {}),
        ...(s.invalidInputs ? { bad: s.invalidInputs } : {}),
        ...(s.spdMax ? { spdMax: s.spdMax } : {}),
      },
      ...(s.acTriggered ? { ac: s.acTriggered } : {}),
    };
    emit(record);
    return record;
  }

  /** Anonymous live network summary (zero PII / UID / IP / name) for gateway /perf/health aggregation. */
  function liveNetworkSnapshot() {
    let humans = 0, udp = 0, ws = 0;
    const rtts = [];
    for (const s of sessions.values()) {
      humans++;
      if (s.transport === 'udp') udp++;
      else ws++;
      // Prefer real client-measured RTT (2s cadence), fall back to server RTT probe if client is legacy.
      const latest = s.clientRtts.length
        ? s.clientRtts[s.clientRtts.length - 1]
        : (s.serverRtts.length ? s.serverRtts[s.serverRtts.length - 1] : null);
      if (latest !== null) rtts.push({ tr: s.transport, ms: latest });
    }
    return { humans, udp, ws, rtts };
  }

  function flushAll(reason = 'shutdown') {
    for (const id of [...sessions.keys()]) finishSession(id, reason);
  }

  return {
    startSession,
    recordClientPing,
    recordServerRtt,
    recordInput,
    recordShotRejected,
    samplePlayerSpeed,
    observeRoomEvents,
    finishSession,
    liveNetworkSnapshot,
    flushAll,
  };
}
