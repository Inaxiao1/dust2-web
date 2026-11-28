/**
 * Zero-server in-browser authoritative CS2 bot match host.
 * Runs the exact same GameRoom + PrivateMapBots + shared physics engine locally
 * inside the browser with a WebSocket-compatible loopback surface (`transportMode: 'LOCAL'`),
 * giving players 0 ms ping even when offline, on poor networks, or when online nodes are full.
 */
import { GameRoom, TICK_RATE, SNAPSHOT_RATE } from '../server/game.js';
import { snapshotForSide, snapshotForPlayer } from '../server/snapshot-view.js';
import { MapTacticalGraph } from '../server/map-tactical-graph.js';
import { PrivateMapBots } from '../server/private-map-bots.js';
import { edgeGoals } from '../scripts/maps/navigation-movement.mjs';
import { sightBlocked, raycastGrenadeWorld, raycastWorldContact } from '../shared/physics.js';
import { MIRAGE_JUMP_IDENTITY, MIRAGE_JUMP_LINKS } from '../shared/private-map-jump-links.js';
import { PrivateMapBreakables } from '../shared/private-map-breakables.js';
import { CLIENT_BUILD, RULES_VERSION, ASSET_VERSION } from '../shared/online-build.js';
import { PRIMARY_WEAPONS } from '../shared/weapons.js';
import { normalizeSkinLoadout } from '../shared/skins.js';
import { normalizeAgentLoadout } from '../shared/agents.js';
import { normalizeBotDifficulty } from '../shared/bot-difficulty.js';
import { botCount } from '../shared/match-rules.js';
import { isMusicKit } from '../shared/music-kits.js';

const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSED = 3;

function buildLazyEdgePlans(graph, jumpLinks) {
  const cache = new Map();
  for (const link of jumpLinks) {
    cache.set(`${link.navFrom}>${link.navTo}`, { mode: 'scripted-jump', link });
  }
  return {
    get(key) {
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const sep = key.indexOf('>');
      if (sep <= 0) return null;
      const aId = Number(key.slice(0, sep));
      const bId = Number(key.slice(sep + 1));
      const a = graph.nodes.get(aId);
      const b = graph.nodes.get(bId);
      if (!a || !b) {
        cache.set(key, null);
        return null;
      }
      const dy = (b.y || 0) - (a.y || 0);
      const mode = dy > 0.32 ? 'jump' : (a.crouch || b.crouch ? 'crouch' : 'walk');
      const plan = { mode, goals: edgeGoals(a, b, mode) };
      cache.set(key, plan);
      return plan;
    },
  };
}

function buildLocalPrivateMapRuntime({ mapConfig, meta, nav, breakableCollision }) {
  const jumpLinks = mapConfig?.id === MIRAGE_JUMP_IDENTITY.mapId
    && mapConfig?.sourceSha256 === MIRAGE_JUMP_IDENTITY.sourceSha256
    && mapConfig?.physicsSha256 === MIRAGE_JUMP_IDENTITY.physicsSha256
    ? MIRAGE_JUMP_LINKS
    : [];
  const jumpEdgeSet = new Set(jumpLinks.map((l) => `${l.navFrom}>${l.navTo}`));
  const nodes = Array.isArray(nav) ? nav.map((n) => ({ ...n, neighbors: Array.isArray(n.neighbors) ? [...n.neighbors] : [] })) : [];
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  for (const link of jumpLinks) {
    const from = nodeById.get(link.navFrom);
    if (from && !from.neighbors.includes(link.navTo)) from.neighbors.push(link.navTo);
  }

  const graph = new MapTacticalGraph(meta, nodes, {
    standAllowed: () => true,
    edgeAllowed: (a, b) => jumpEdgeSet.has(`${a.id}>${b.id}`) || Math.abs((b.y || 0) - (a.y || 0)) < 1.65,
  });
  const plans = buildLazyEdgePlans(graph, jumpLinks);
  const activeBreakables = breakableCollision || new PrivateMapBreakables(mapConfig?.breakables || [], {});
  const glassTriangle = (index) => activeBreakables?.atTriangle?.(2, index)?.material === 'glass';
  const world = {
    raycastWorld: raycastGrenadeWorld,
    raycastContact: raycastWorldContact,
    clearSight(a, b, tolerance = 0.03) {
      const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      return d <= tolerance || !sightBlocked(a, { x: (b.x - a.x) / d, y: (b.y - a.y) / d, z: (b.z - a.z) / d }, d - tolerance, glassTriangle);
    },
  };

  return {
    mapId: mapConfig.mapId || mapConfig.id,
    mapSignature: mapConfig.mapSignature,
    config: mapConfig,
    meta,
    graph,
    plans,
    world,
    createBots: (room) => new PrivateMapBots(room, { graph, plans, world }),
    createBreakables: () => activeBreakables,
    activate: () => {},
  };
}

export function createLocalBotSocket({ mapConfig, meta, nav, breakableCollision = null, onStatus = null } = {}) {
  const target = new EventTarget();
  let state = WS_CONNECTING;
  let room = null;
  let playerId = null;
  let tickTimer = null;
  let tickNumber = 0;
  let closed = false;

  const dispatch = (type, detail = {}) => {
    const ev = Object.assign(new Event(type), detail);
    target.dispatchEvent(ev);
  };

  const emitToClient = (payload) => {
    if (closed || state !== WS_OPEN) return;
    dispatch('message', { data: JSON.stringify(payload) });
  };

  const emitError = (code, message) => emitToClient({ type: 'error', code, message });

  const localRuntime = mapConfig && meta && nav
    ? buildLocalPrivateMapRuntime({ mapConfig, meta, nav, breakableCollision })
    : null;

  const dummyServerSocket = {
    get readyState() { return state; },
    bufferedAmount: 0,
    send() {},
    close() {},
  };

  const stopLoop = () => {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  };

  const startLoop = () => {
    stopLoop();
    tickNumber = 0;
    const snapInterval = Math.max(1, Math.round(TICK_RATE / SNAPSHOT_RATE));
    tickTimer = setInterval(() => {
      if (closed || state !== WS_OPEN || !room || !playerId) {
        stopLoop();
        return;
      }
      if (typeof document !== 'undefined' && document.hidden) return;
      tickNumber++;
      try {
        room.tick(1 / TICK_RATE);
        if (tickNumber % snapInterval === 0) {
          const snapshot = room.snapshot();
          const side = room.players.get(playerId)?.team;
          const sideSnap = snapshotForSide(snapshot, side);
          const playerSnap = snapshotForPlayer(sideSnap, playerId);
          emitToClient(playerSnap);
        }
      } catch (err) {
        console.error('[local-bot-server] tick failed:', err);
      }
    }, Math.round(1000 / TICK_RATE));
  };

  const handleClientMessage = (raw) => {
    if (closed || state !== WS_OPEN) return;
    let msg;
    try {
      msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!msg || typeof msg !== 'object') return;
    } catch {
      return;
    }

    if (msg.type === 'ping') {
      emitToClient({ type: 'pong', time: typeof msg.time === 'number' ? msg.time : null, serverTime: Date.now() });
      return;
    }

    if (msg.type === 'join') {
      stopLoop();
      const mode = msg.mode === 'deathmatch' ? 'deathmatch' : 'defuse';
      const team = ['T', 'CT'].includes(msg.team) ? msg.team : 'auto';
      const bots = botCount(msg.bots);
      const botDifficulty = normalizeBotDifficulty(msg.botDifficulty);
      const primary = PRIMARY_WEAPONS.includes(msg.primary) ? msg.primary : 'auto';
      const name = (typeof msg.name === 'string' ? msg.name : 'Player').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 20) || 'Player';
      const settings = {
        name,
        room: 'LOCAL',
        mode,
        team,
        bots,
        botDifficulty,
        primary,
        musicKit: isMusicKit(msg.musicKit) ? msg.musicKit : undefined,
        visibility: 'private',
        weaponLoadout: msg.weaponLoadout,
        skins: normalizeSkinLoadout(msg.skins),
        agents: normalizeAgentLoadout(msg.agents),
        movementProtocol: msg.movementProtocol === 1 ? 1 : 0,
        shotProtocol: msg.shotProtocol === 1 ? 1 : 0,
        resumeToken: null,
        playerUid: null,
      };
      try {
        room = new GameRoom('LOCAL', {
          mode,
          bots,
          botDifficulty,
          visibility: 'private',
          privateMap: localRuntime,
        });
        const player = room.addHuman(dummyServerSocket, settings);
        playerId = player.id;
        emitToClient({
          type: 'welcome',
          ...(localRuntime ? {
            mapId: localRuntime.mapId,
            mapSignature: localRuntime.mapSignature,
            physicsSha256: localRuntime.config.physicsSha256,
          } : {}),
          clientBuild: CLIENT_BUILD,
          rulesVersion: RULES_VERSION,
          assetVersion: ASSET_VERSION,
          id: player.id,
          room: 'LOCAL',
          mode: room.mode,
          team: player.team,
          teamId: player.teamId,
          hostId: room.hostId,
          desiredBots: room.desiredBots,
          botCount: room.botCount,
          botDifficulty: room.botDifficulty,
          match: room.matchSnapshot(),
          tickRate: TICK_RATE,
          snapshotRate: SNAPSHOT_RATE,
          serverTime: Date.now(),
          protocol: 1,
          binaryProtocol: 0,
          snapshotDelta: 0,
          resumeToken: null,
          resumed: false,
          reconnectGraceMs: 0,
          movementProtocol: 1,
          shotProtocol: 1,
        });
        const initialSnap = snapshotForSide(room.snapshot({ drainEvents: false }), player.team);
        emitToClient(snapshotForPlayer(initialSnap, player.id));
        startLoop();
      } catch (err) {
        emitError('JOIN_FAILED', err?.message || '本地人机对局启动失败');
      }
      return;
    }

    if (!room || !playerId) return;

    if (msg.type === 'input') {
      room.receiveInput(playerId, msg);
    } else if (msg.type === 'buy') {
      const res = room.buy(playerId, msg.weapon);
      if (!res.ok) emitError('BUY_REJECTED', res.message);
      else emitToClient({ type: 'purchase', ...res });
    } else if (msg.type === 'refund') {
      const res = room.refund(playerId, msg.weapon);
      if (!res.ok) emitError('BUY_REJECTED', res.message);
      else emitToClient({ type: 'refund', ...res });
    } else if (msg.type === 'dropWeapon') {
      const res = room.dropWeapon(playerId);
      if (!res.ok) emitError('DROP_REJECTED', res.message);
      else emitToClient({ type: 'weaponDropped', ...res });
    } else if (msg.type === 'takeBot') {
      const res = room.takeBot(playerId, typeof msg.botId === 'string' ? msg.botId : null);
      if (!res.ok) emitError('BOT_CONTROL_REJECTED', res.message);
      else emitToClient({ type: 'botControl', ...res });
    } else if (msg.type === 'takeSeat' || msg.type === 'setSeatBot') {
      const res = msg.type === 'takeSeat'
        ? room.takeSeat(playerId, msg.team, msg.seat)
        : room.setSeatBot(playerId, msg.team, msg.seat, msg.enabled);
      if (!res.ok) emitError('SEAT_REJECTED', res.message);
      else emitToClient({ type: 'seatUpdated', ...res });
    } else if (msg.type === 'setBots') {
      const res = room.setBots(playerId, msg.bots);
      if (!res.ok) emitError('BOTS_REJECTED', res.message);
      else emitToClient({ type: 'botsUpdated', ...res });
    } else if (msg.type === 'setBotDifficulty') {
      const res = room.setBotDifficulty(playerId, msg.botDifficulty);
      if (!res.ok) emitError('BOT_DIFFICULTY_REJECTED', res.message);
      else emitToClient({ type: 'botDifficultyUpdated', ...res });
    } else if (msg.type === 'setWeaponLoadout') {
      const res = room.setWeaponLoadout(playerId, msg.weaponLoadout);
      if (!res.ok) emitError('LOADOUT_REJECTED', res.message);
      else emitToClient({ type: 'weaponLoadoutUpdated', ...res });
    } else if (msg.type === 'equipSkin') {
      const res = room.equipSkin(playerId, msg.weapon, msg.skin);
      if (!res.ok) emitError('SKIN_REJECTED', res.message);
      else emitToClient({ type: 'skinEquipped', ...res });
    } else if (msg.type === 'equipAgent') {
      const res = room.equipAgent(playerId, msg.agent);
      if (!res.ok) emitError('AGENT_REJECTED', res.message);
      else emitToClient({ type: 'agentEquipped', ...res });
    } else if (msg.type === 'equipMusic') {
      const player = room.players.get(playerId);
      if (!player || !isMusicKit(msg.kit)) {
        emitError('MUSIC_REJECTED', '无效的音乐盒。');
      } else if (player.musicKit !== msg.kit) {
        player.musicKit = msg.kit;
        room.emit('music_equipped', { playerId: player.id, musicKit: player.musicKit });
      }
    } else if (msg.type === 'chat') {
      const res = room.chat(playerId, msg.text, msg.channel);
      if (!res.ok) emitError('CHAT_REJECTED', res.message);
    } else if (msg.type === 'requestWeapon' || msg.type === 'donateWeapon') {
      const res = msg.type === 'requestWeapon'
        ? room.requestWeapon(playerId, msg.weapon)
        : room.donateWeapon(playerId, msg.playerId, msg.weapon);
      if (!res.ok) emitError('TEAM_GEAR_REJECTED', res.message);
      else emitToClient({ type: 'teamGear', ...res });
    }
  };

  const handle = {
    get readyState() { return state; },
    get transportMode() { return 'LOCAL'; },
    get hasUnreliable() { return false; },
    get url() { return 'local://bot-match'; },
    get bufferedAmount() { return 0; },
    addEventListener(type, listener, options) { target.addEventListener(type, listener, options); },
    removeEventListener(type, listener, options) { target.removeEventListener(type, listener, options); },
    send(data) { handleClientMessage(data); },
    sendUnreliable(data) { handleClientMessage(data); },
    close(code = 1000, reason = '') {
      if (closed) return;
      closed = true;
      stopLoop();
      state = WS_CLOSED;
      room = null;
      playerId = null;
      queueMicrotask(() => dispatch('close', { code, reason, wasClean: code === 1000 }));
    },
  };

  queueMicrotask(() => {
    if (closed) return;
    state = WS_OPEN;
    onStatus?.({ phase: 'local-open', reason: 'offline-bot-mode' });
    dispatch('open');
  });

  return handle;
}
