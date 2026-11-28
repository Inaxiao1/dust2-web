import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createTelemetryStore } from '../server/telemetry-store.js';
import { createPlayerTelemetry } from '../server/player-telemetry.js';

const repo = fileURLToPath(new URL('../', import.meta.url));
const packs = process.env.PERF_MAP_ROOT || path.join(repo, 'artifacts/performance-maps/maps-v1');
const installed = fs.existsSync(path.join(packs, 'de_dust2', 'compiled/map.json'));

test('telemetry store hashes IPs with persistent salt, rotates & compresses to .ndjson.gz, and prunes under disk budget', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs2-tel-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const store = createTelemetryStore({
    dir,
    maxFileBytes: 256 * 1024,
    maxTotalBytes: 5 * 1024 * 1024,
    maxDays: 7,
    flushIntervalMs: 60000,
  });

  const rawIp = '203.0.113.42';
  const h1 = store.hashIp(`::ffff:${rawIp}`);
  const h2 = store.hashIp(`${rawIp}, 10.0.0.1`);
  assert.match(h1, /^[a-f0-9]{12}$/);
  assert.equal(h1, h2);
  assert.notEqual(h1, rawIp);

  for (let i = 0; i < 2400; i++) {
    store.record({ k: 'sess', m: 'de_dust2', r: 'ABC123', tr: i % 2 ? 'udp' : 'ws', uid: `toy_${i}`, iph: h1, nm: 'Tester', dur: 120, net: { p50: 42, p95: 55 } });
  }
  await store.flush();
  // Give background gzip compression a moment to finish
  for (let i = 0; i < 30; i++) {
    const files = fs.readdirSync(dir);
    if (files.some((f) => f.endsWith('.ndjson.gz'))) break;
    await delay(50);
  }
  await store.close();

  const files = fs.readdirSync(dir);
  const gzFiles = files.filter((f) => f.endsWith('.ndjson.gz'));
  assert.ok(gzFiles.length >= 1, `Expected rotated .ndjson.gz archive, got ${JSON.stringify(files)}`);
  const decompressed = zlib.gunzipSync(fs.readFileSync(path.join(dir, gzFiles[0]))).toString('utf8');
  assert.ok(!decompressed.includes(rawIp), 'Raw IP must never be written to telemetry logs');
  assert.ok(decompressed.includes(`"iph":"${h1}"`));

  // Salt persists across restarts
  const store2 = createTelemetryStore({ dir, flushIntervalMs: 60000 });
  assert.equal(store2.hashIp(rawIp), h1);
  await store2.close();
});

test('player telemetry tracks real RTT, detects anti-cheat anomalies with cooldown, and strips PII from live snapshots', () => {
  const events = [];
  const tel = createPlayerTelemetry({
    mapId: 'de_dust2',
    hashIp: (ip) => 'hash_' + ip.slice(-4),
    emitEvent: (ev) => events.push(ev),
  });

  tel.startSession({
    playerId: 'p1',
    uid: 'BILIBILI_SECRET_TOY_OPENID_999',
    ip: '198.51.100.88',
    name: 'SharpAim',
    room: 'ROOM01',
    mode: 'defuse',
    transport: 'udp',
  });

  // Network samples
  tel.recordClientPing('p1', { rtt: 42, fps: 144 });
  tel.recordClientPing('p1', { rtt: 48, fps: 140 });
  tel.recordClientPing('p1', { rtt: 44, fps: 142 });

  // Live network snapshot MUST NOT leak uid, ipHash, or name
  const live = tel.liveNetworkSnapshot();
  assert.equal(live.humans, 1);
  assert.equal(live.udp, 1);
  assert.equal(live.ws, 0);
  assert.equal(live.rtts[0].ms, 44);
  const serializedLive = JSON.stringify(live);
  assert.ok(!serializedLive.includes('BILIBILI_SECRET_TOY_OPENID_999'));
  assert.ok(!serializedLive.includes('SharpAim'));
  assert.ok(!serializedLive.includes('198.51.100.88'));

  // Simulate extreme 110-degree snap within 50ms into a headshot kill -> AIM_SNAP_HS
  const t0 = 1_700_000_000_000;
  tel.recordInput('p1', { yaw: 0, pitch: 0 }, true, true, t0);
  tel.recordInput('p1', { yaw: 2.0, pitch: 0.1 }, true, true, t0 + 50); // ~115 deg
  const fakeRoom = {
    players: new Map([
      ['p1', { id: 'p1', x: 0, y: 0, z: 0, yaw: 2.0, pitch: 0.1 }],
      ['bot1', { id: 'bot1', x: 20, y: 0, z: 0 }],
    ]),
  };
  tel.observeRoomEvents(fakeRoom, [
    { type: 'shot', shooterId: 'p1', aim: { yaw: 2.0, pitch: 0.1 } },
    { type: 'hit', shooterId: 'p1', damage: 112 },
    { type: 'kill', killerId: 'p1', victimId: 'bot1', weapon: 'ak47', headshot: true },
  ], t0 + 60);

  // Trigger HS_OUTLIER (8/8 headshots)
  for (let i = 0; i < 7; i++) {
    tel.observeRoomEvents(fakeRoom, [
      { type: 'kill', killerId: 'p1', victimId: 'bot1', weapon: 'ak47', headshot: true },
    ], t0 + 1000 + i * 500);
  }

  // Trigger SHOT_REJECT_BURST (10 rapid rejects in 10s)
  for (let i = 0; i < 10; i++) {
    tel.recordShotRejected('p1', 'not_ready', t0 + 5000 + i * 100);
  }

  // Trigger HIGH_INPUT_RATE (500 inputs in 5.05s = ~99 Hz)
  tel.startSession({ playerId: 'p2', uid: 'speed_uid', ip: '198.51.100.99', name: 'Speedy', room: 'ROOM01', mode: 'defuse', transport: 'ws' });
  const tRate = Date.now();
  for (let i = 0; i < 500; i++) {
    tel.recordInput('p2', { yaw: 0, pitch: 0 }, true, true, tRate + i * 10);
  }
  tel.recordInput('p2', { yaw: 0, pitch: 0 }, true, true, tRate + 5050);

  const sess = tel.finishSession('p1', 'normal', t0 + 60000);
  assert.equal(sess.k, 'sess');
  assert.equal(sess.tr, 'udp');
  assert.equal(sess.uid, 'BILIBILI_SECRET_TOY_OPENID_999');
  assert.equal(sess.cmb.k, 8);
  assert.equal(sess.cmb.hs, 8);
  assert.equal(sess.cmb.snapHs, 1);
  assert.equal(sess.cmb.rej, 10);
  assert.equal(sess.net.p50, 44);

  const rules = new Set(events.filter((e) => e.k === 'ac').map((e) => e.rule));
  assert.ok(rules.has('AIM_SNAP_HS'));
  assert.ok(rules.has('HS_OUTLIER'));
  assert.ok(rules.has('SHOT_REJECT_BURST'));
  assert.ok(rules.has('HIGH_INPUT_RATE'));
});

test('gateway keeps playerUid private from clients and exposes real player RTT in /perf/health + loopback /perf/internal/telemetry.json', { skip: !installed, timeout: 90000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs2-gw-tel-'));
  const gateway = spawn(process.execPath, ['server/performance-maps.js'], {
    cwd: repo,
    env: {
      ...process.env,
      PORT: '0',
      PERF_MAP_ROOT: packs,
      PERF_MAX_WORKERS: '2',
      PERF_SHARD_MAPS: 'de_dust2:2',
      PERF_STRICT_HEAVY_LOCK: '0',
      PERF_TELEMETRY_DIR: dir,
    },
    stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
    windowsHide: true,
  });
  const exited = once(gateway, 'exit');
  const sockets = new Set();
  t.after(async () => {
    for (const s of sockets) s.terminate();
    if (gateway.connected) gateway.disconnect();
    await exited;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  let log = '', origin;
  while (!origin) {
    const [chunk] = await once(gateway.stdout, 'data', { signal: AbortSignal.timeout(20000) });
    log += chunk;
    origin = log.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  }
  const config = await (await fetch(origin + '/perf/play/de_dust2/private-map.json', { signal: AbortSignal.timeout(75000) })).json();
  const ws = new WebSocket(origin.replace('http:', 'ws:') + '/perf/play/de_dust2/ws');
  sockets.add(ws);
  await once(ws, 'open', { signal: AbortSignal.timeout(10000) });

  const secretUid = 'TOY_OPENID_DO_NOT_LEAK_777';
  const nextJson = (pred) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws message timeout')), 10000);
    const onMsg = (raw) => {
      const m = JSON.parse(raw.toString());
      if (pred(m)) { clearTimeout(timer); ws.off('message', onMsg); resolve(m); }
    };
    ws.on('message', onMsg);
  });

  const welcomeP = nextJson((m) => m.type === 'welcome');
  const snapP = nextJson((m) => m.type === 'snapshot');
  ws.send(JSON.stringify({
    type: 'join',
    mapId: config.id,
    mapSignature: config.mapSignature,
    name: 'PrivacyCheck',
    playerUid: secretUid,
    room: 'TEL001',
    mode: 'deathmatch',
    bots: 0,
  }));
  const [welcome, snap] = await Promise.all([welcomeP, snapP]);
  assert.ok(!JSON.stringify(welcome).includes(secretUid), 'welcome must never echo playerUid');
  assert.ok(!JSON.stringify(snap).includes(secretUid), 'snapshot must never expose playerUid');

  // Send client ping carrying real RTT & FPS
  const pongP = nextJson((m) => m.type === 'pong');
  ws.send(JSON.stringify({ type: 'ping', time: 1000, rtt: 53, fps: 120, tr: 'w' }));
  await pongP;

  // Public /perf/health reports anonymous real player RTT without leaking playerUid or name
  const health = await (await fetch(origin + '/perf/health')).json();
  assert.ok(!JSON.stringify(health).includes(secretUid), '/perf/health must never leak playerUid');
  assert.ok(!JSON.stringify(health).includes('PrivacyCheck'), '/perf/health must never leak player names');
  assert.equal(health.network.humans, 1);
  assert.equal(health.network.rttWs.p50, 53);

  // Proxied requests to /perf/internal/telemetry.json must be rejected with 403
  const blocked = await fetch(origin + '/perf/internal/telemetry.json', { headers: { 'X-Forwarded-For': '203.0.113.9' } });
  assert.equal(blocked.status, 403);

  // Loopback admin telemetry works
  const adminTel = await (await fetch(origin + '/perf/internal/telemetry.json')).json();
  assert.equal(adminTel.ok, true);
  assert.equal(adminTel.network.humans, 1);

  // Close socket and confirm session record arrives in telemetry store
  ws.close(1000, 'bye');
  for (let i = 0; i < 40; i++) {
    const s = await (await fetch(origin + '/perf/internal/telemetry.json')).json();
    if (s.counters.sessions >= 1) {
      assert.equal(s.counters.sessions, 1);
      return;
    }
    await delay(100);
  }
  const endTel = await (await fetch(origin + '/perf/internal/telemetry.json')).json();
  assert.ok(endTel.counters.sessions >= 1, 'Expected session record to be ingested by gateway telemetry store');
});
