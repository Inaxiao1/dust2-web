import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { startGameServer } from '../server/index.js';
import { MinHeap } from '../shared/min-heap.js';
import { MapTacticalGraph } from '../server/map-tactical-graph.js';
import { encodeDeltaSnapshot, applyDeltaSnapshot } from '../shared/snapshot-delta.js';
import { RULES_VERSION, ASSET_VERSION } from '../shared/online-build.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTROL_PLANE_DIR = path.join(ROOT, 'control-plane');

async function openClient(url, headers = {}) {
  const ws = new WebSocket(url, { headers });
  const rawQueue = [];
  const listeners = new Set();
  ws.on('message', raw => {
    const text = raw.toString();
    const parsed = JSON.parse(text);
    rawQueue.push({ parsed, bytes: Buffer.byteLength(text, 'utf8') });
    for (const fn of listeners) fn();
  });
  await once(ws, 'open');
  return {
    ws,
    send: obj => ws.send(JSON.stringify(obj)),
    waitFor(predicate, timeoutMs = 5000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error('WS waitFor timeout'));
        }, timeoutMs);
        const check = () => {
          const idx = rawQueue.findIndex(item => predicate(item.parsed));
          if (idx >= 0) {
            clearTimeout(timer);
            listeners.delete(check);
            resolve(rawQueue.splice(idx, 1)[0]);
          }
        };
        listeners.add(check);
        check();
      });
    },
  };
}

test('MinHeap priority order and MapTacticalGraph optimal A* routing', () => {
  const heap = new MinHeap();
  for (const cost of [9, 2, 7, 1, 5, 3, 8, 1, 4]) heap.push({ id: cost, cost });
  const popped = [];
  while (heap.size) popped.push(heap.pop().cost);
  assert.deepEqual(popped, [1, 1, 2, 3, 4, 5, 7, 8, 9]);

  // Grid graph: shortest route must bypass high-penalty middle node.
  const areas = [
    { id: 1, hull: 0, x: 0, y: 0, z: 0, neighbors: [2, 3] },
    { id: 2, hull: 0, x: 5, y: 0, z: 0, neighbors: [1, 4] },
    { id: 3, hull: 0, x: 0, y: 0, z: 5, neighbors: [1, 4] },
    { id: 4, hull: 0, x: 5, y: 0, z: 5, neighbors: [2, 3] },
  ];
  const graph = new MapTacticalGraph({ id: 'de_dust2', sites: {} }, areas, {
    standAllowed: () => true,
    edgeAllowed: () => true,
  });
  const pathWithPenalty = graph.route(1, 4, { penalties: new Map([[2, 50]]) });
  assert.deepEqual(pathWithPenalty.map(n => n.id), [1, 3, 4]);
});

test('Delta snapshots reconstruct exact state and cut steady-state payload size', { timeout: 25000 }, async t => {
  const app = await startGameServer({ port: 0, host: '127.0.0.1' });
  const sockets = [];
  t.after(async () => {
    for (const s of sockets) s.terminate();
    await app.close();
  });

  const c = await openClient(`ws://127.0.0.1:${app.port}/ws`);
  sockets.push(c.ws);
  c.send({
    type: 'join',
    name: 'DeltaOp',
    room: 'DELTA1',
    mode: 'deathmatch',
    team: 'CT',
    bots: 6,
    snapshotDelta: 1,
    rulesVersion: RULES_VERSION,
    assetVersion: ASSET_VERSION,
  });

  const welcome = (await c.waitFor(m => m.type === 'welcome')).parsed;
  assert.equal(welcome.snapshotDelta, 1);

  const initial = await c.waitFor(m => m.type === 'snapshot');
  let baseline = initial.parsed;
  assert.ok(initial.bytes > 1000);

  let deltaBytes = 0;
  let deltaCount = 0;
  for (let i = 0; i < 4; i++) {
    const pkt = await c.waitFor(m => m.type === 'snapshotDelta');
    deltaBytes += pkt.bytes;
    deltaCount++;
    const reconstructed = applyDeltaSnapshot(pkt.parsed, baseline);
    assert.equal(reconstructed.type, 'snapshot');
    assert.equal(reconstructed.room, 'DELTA1');
    assert.equal(reconstructed.players.length, baseline.players.length);
    const self = reconstructed.players.find(p => p.id === welcome.id);
    assert.ok(self && self.name === 'DeltaOp' && Array.isArray(self.inventory));
    baseline = reconstructed;
  }

  const avgDelta = deltaBytes / deltaCount;
  // Pure unit roundtrip check on stationary frame: unchanged fields must drop >70%.
  const stationary = { ...baseline, time: baseline.time + 66, events: [] };
  const stationaryDelta = encodeDeltaSnapshot(stationary, baseline);
  assert.deepEqual(applyDeltaSnapshot(stationaryDelta, baseline), stationary);
  const fullBytes = Buffer.byteLength(JSON.stringify(stationary), 'utf8');
  const compactBytes = Buffer.byteLength(JSON.stringify(stationaryDelta), 'utf8');
  assert.ok(compactBytes < fullBytes * 0.2, `expected stationary delta (${compactBytes}B) << full (${fullBytes}B)`);
  assert.ok(avgDelta < initial.bytes * 0.65, `expected live avg delta (${Math.round(avgDelta)}B) < 65% of full (${initial.bytes}B)`);
});

test('Reconnect grace preserves player KDA/money/host on abnormal drop and sweeps expired empty rooms', { timeout: 25000 }, async t => {
  const app = await startGameServer({ port: 0, host: '127.0.0.1', reconnectGraceMs: 1200 });
  const sockets = [];
  t.after(async () => {
    for (const s of sockets) s.terminate();
    await app.close();
  });

  // 1. Solo player drops abnormally -> room survives grace window and restores state on resumeToken.
  const c1 = await openClient(`ws://127.0.0.1:${app.port}/ws`);
  sockets.push(c1.ws);
  c1.send({
    type: 'join',
    name: 'ReconnectPro',
    playerUid: 'TOY-10001',
    room: 'RECON1',
    mode: 'deathmatch',
    team: 'T',
    bots: 2,
    reconnect: true,
    rulesVersion: RULES_VERSION,
    assetVersion: ASSET_VERSION,
  });
  const w1 = (await c1.waitFor(m => m.type === 'welcome')).parsed;
  assert.ok(w1.resumeToken);
  assert.equal(w1.resumed, false);

  const room = app.rooms.get('RECON1');
  const p1 = room.players.get(w1.id);
  p1.kills = 7;
  p1.deaths = 2;
  p1.assists = 3;
  p1.money = 9450;
  room.giveWeapon(p1, 'awp');

  // Simulate sudden network drop (TCP destroy -> close code 1006).
  const closed = once(c1.ws, 'close');
  c1.ws.terminate();
  await closed;
  await delay(80);
  assert.equal(app.rooms.has('RECON1'), true, 'room must stay alive during reconnect grace window');
  assert.equal(room.humanCount, 0);

  // Reconnect within grace window with resumeToken -> restores exact KDA, money, AWP, and hostId.
  const c1Back = await openClient(`ws://127.0.0.1:${app.port}/ws`);
  sockets.push(c1Back.ws);
  c1Back.send({
    type: 'join',
    name: 'ReconnectPro',
    playerUid: 'TOY-10001',
    room: 'RECON1',
    existing: true,
    reconnect: true,
    resumeToken: w1.resumeToken,
    rulesVersion: RULES_VERSION,
    assetVersion: ASSET_VERSION,
  });
  const w1Back = (await c1Back.waitFor(m => m.type === 'welcome')).parsed;
  assert.equal(w1Back.resumed, true);
  assert.equal(w1Back.team, 'T');
  assert.equal(w1Back.hostId, w1Back.id);
  const restored = room.players.get(w1Back.id);
  assert.equal(restored.kills, 7);
  assert.equal(restored.deaths, 2);
  assert.equal(restored.assists, 3);
  assert.equal(restored.money, 9450);
  assert.ok(restored.inventory.awp, 'AWP inventory should be preserved on reconnect');

  // Clean voluntary leave (code 1000) immediately deletes empty room without waiting for grace window.
  const cleanClosed = once(c1Back.ws, 'close');
  c1Back.ws.close(1000, 'leave');
  await cleanClosed;
  await delay(80);
  assert.equal(app.rooms.has('RECON1'), false, 'clean voluntary leave must delete empty room immediately');

  // 2. Abnormal drop without returning expires room after grace window.
  const c2 = await openClient(`ws://127.0.0.1:${app.port}/ws`);
  sockets.push(c2.ws);
  c2.send({
    type: 'join',
    name: 'DropAway',
    room: 'EXPRE1',
    mode: 'deathmatch',
    bots: 0,
    reconnect: true,
    rulesVersion: RULES_VERSION,
    assetVersion: ASSET_VERSION,
  });
  await c2.waitFor(m => m.type === 'welcome');
  const dropClosed = once(c2.ws, 'close');
  c2.ws.terminate();
  await dropClosed;
  await delay(100);
  assert.equal(app.rooms.has('EXPRE1'), true);
  await delay(1350);
  assert.equal(app.rooms.has('EXPRE1'), false, 'expired grace room must be swept automatically');
});

test('Federated /perf gateway + Go Control Plane + Battle Worker full quick-join flow', { timeout: 35000 }, async t => {
  const JOIN_SECRET = 'federated-test-join-secret-32bytes!';
  const WORKER_AUTH = 'federated-test-worker-auth-32bytes!';
  const workDir = await mkdtemp(path.join(tmpdir(), 'cs2-fed-arch-'));
  const binPath = path.join(workDir, process.platform === 'win32' ? 'control-plane.exe' : 'control-plane');
  await writeFile(path.join(workDir, 'catalog.json'), JSON.stringify({
    maps: [{ id: 'de_dust2', name: 'Dust II', nameZh: '炙热沙城 II' }],
  }));
  execFileSync('go', ['build', '-o', binPath, './cmd/control-plane'], { cwd: CONTROL_PLANE_DIR, stdio: 'pipe' });

  const cpChild = spawn(binPath, [], {
    cwd: CONTROL_PLANE_DIR,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: '0',
      JOIN_TOKEN_SECRET: JOIN_SECRET,
      WORKER_AUTH_TOKEN: WORKER_AUTH,
      ALLOWED_ORIGINS: '*',
      WORKER_TTL_SECONDS: '15',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const cpExited = once(cpChild, 'exit');

  const sockets = [];
  let worker = null;
  let gateway = null;
  let gwExited = null;
  t.after(async () => {
    for (const s of sockets) s.terminate();
    if (worker) await worker.close();
    if (gateway) {
      if (gateway.connected) gateway.disconnect();
      else gateway.kill();
      await gwExited.catch(() => {});
    }
    cpChild.kill('SIGTERM');
    await cpExited.catch(() => {});
    await rm(workDir, { recursive: true, force: true });
  });

  const cpReady = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('CP start timeout')), 10000);
    cpChild.stdout.on('data', chunk => {
      buf += chunk.toString();
      for (const line of buf.split('\n')) {
        try {
          const j = JSON.parse(line);
          if (j.service === 'cs2-control-plane' && j.port > 0) {
            clearTimeout(timer);
            resolve(j);
            return;
          }
        } catch {}
      }
    });
  });
  const cpBase = `http://127.0.0.1:${cpReady.port}`;

  worker = await startGameServer({
    port: 0,
    host: '127.0.0.1',
    logicOnly: true,
    allowedOrigins: '*',
    joinTokenSecret: JOIN_SECRET,
    requireJoinToken: true,
    workerId: 'worker-d2-fed-1',
    controlPlaneUrl: cpBase,
    workerAuthToken: WORKER_AUTH,
    heartbeatIntervalMs: 250,
  });
  await worker.reporter.ready;

  gateway = spawn(process.execPath, ['server/performance-maps.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: '0',
      PERF_MAP_ROOT: workDir,
      PERF_GAME_DIST: workDir,
      PERF_CONTROL_PLANE_URL: cpBase,
      PERF_WORKER_AUTH_TOKEN: WORKER_AUTH,
    },
    stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
  });
  gwExited = once(gateway, 'exit');
  const [gwOut] = await once(gateway.stdout, 'data', { signal: AbortSignal.timeout(10000) });
  const gwBase = gwOut.toString().match(/http:\/\/127\.0\.0\.1:\d+/)[0];

  const gwHealth = await fetch(gwBase + '/perf/health').then(r => r.json());
  assert.equal(gwHealth.controlPlane, true);
  assert.equal(gwHealth.workerMaxRooms, 6);

  // Player 1 triggers federated quick-join -> creates room & returns direct worker ticket.
  const qj1Res = await fetch(gwBase + '/perf/api/quick-join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'deathmatch', preferredMap: 'de_dust2', playerName: 'ToyHero1', playerUid: 'TOY-A1' }),
  });
  assert.equal(qj1Res.status, 201);
  const qj1 = await qj1Res.json();
  assert.equal(qj1.action, 'create');
  assert.equal(qj1.workerId, 'worker-d2-fed-1');
  assert.ok(qj1.joinToken.startsWith('v2.'));

  const ws1 = await openClient(`${qj1.workerWsUrl}?token=${encodeURIComponent(qj1.joinToken)}`);
  sockets.push(ws1.ws);
  ws1.send({ type: 'join', name: 'ToyHero1', bots: 2, snapshotDelta: 1, rulesVersion: RULES_VERSION, assetVersion: ASSET_VERSION });
  const w1 = (await ws1.waitFor(m => m.type === 'welcome')).parsed;
  assert.equal(w1.room, qj1.roomCode);

  await worker.reporter.reportNow();

  // /perf/rooms.json reflects live roster reported via Go Control Plane!
  const dir = await fetch(gwBase + '/perf/rooms.json').then(r => r.json());
  assert.equal(dir.controlPlane, true);
  assert.equal(dir.rooms.length, 1);
  assert.equal(dir.rooms[0].code, qj1.roomCode);
  assert.deepEqual(dir.rooms[0].players, ['ToyHero1']);

  // /perf/find-room.json resolves via Go Control Plane.
  const found = await fetch(gwBase + '/perf/find-room.json?code=' + qj1.roomCode).then(r => r.json());
  assert.equal(found.found, true);
  assert.equal(found.workerWsUrl, qj1.workerWsUrl);

  // Player 2 triggers federated quick-join -> joins Player 1's live room!
  const qj2Res = await fetch(gwBase + '/perf/api/quick-join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'deathmatch', preferredMap: 'de_dust2', playerName: 'ToyHero2', playerUid: 'TOY-B2' }),
  });
  assert.equal(qj2Res.status, 200);
  const qj2 = await qj2Res.json();
  assert.equal(qj2.action, 'join');
  assert.equal(qj2.roomCode, qj1.roomCode);

  const ws2 = await openClient(`${qj2.workerWsUrl}?token=${encodeURIComponent(qj2.joinToken)}`);
  sockets.push(ws2.ws);
  ws2.send({ type: 'join', name: 'ToyHero2', snapshotDelta: 1, rulesVersion: RULES_VERSION, assetVersion: ASSET_VERSION });
  const w2 = (await ws2.waitFor(m => m.type === 'welcome')).parsed;
  assert.equal(w2.room, qj1.roomCode);
  assert.equal(worker.rooms.get(qj1.roomCode).humanCount, 2);
});
