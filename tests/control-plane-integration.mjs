import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { startGameServer } from '../server/index.js';
import { RULES_VERSION, ASSET_VERSION } from '../shared/online-build.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTROL_PLANE_DIR = path.join(ROOT, 'control-plane');
const JOIN_SECRET = 'integration-test-hmac-secret-32bytes!';
const WORKER_AUTH = 'integration-test-worker-auth-token!';

function waitForMessage(ws, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('WebSocket message timeout'));
    }, 6000);
    function onMessage(raw) {
      const msg = JSON.parse(raw.toString());
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(msg);
      }
    }
    ws.on('message', onMessage);
  });
}

test('Go Control Plane schedules rooms, signs JoinTokens, and routes around draining Node Battle Workers', { timeout: 30000 }, async t => {
  const buildDir = await mkdtemp(path.join(tmpdir(), 'cs2-cp-bin-'));
  const binPath = path.join(buildDir, process.platform === 'win32' ? 'control-plane.exe' : 'control-plane');
  execFileSync('go', ['build', '-o', binPath, './cmd/control-plane'], { cwd: CONTROL_PLANE_DIR, stdio: 'pipe' });

  const cpChild = spawn(binPath, [], {
    cwd: CONTROL_PLANE_DIR,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: '0',
      JOIN_TOKEN_SECRET: JOIN_SECRET,
      WORKER_AUTH_TOKEN: WORKER_AUTH,
      ALLOWED_ORIGINS: 'https://web-cdn.example.com',
      WORKER_TTL_SECONDS: '15',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const cpExited = once(cpChild, 'exit');

  const workers = new Map();
  const sockets = [];
  t.after(async () => {
    for (const s of sockets) if (s.readyState === WebSocket.OPEN) s.terminate();
    for (const w of workers.values()) await w.close();
    cpChild.kill('SIGTERM');
    await cpExited.catch(() => {});
    await rm(buildDir, { recursive: true, force: true });
  });

  const cpReadyLine = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('Control plane startup timeout')), 10000);
    cpChild.stdout.on('data', chunk => {
      buf += chunk.toString();
      for (const line of buf.split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.service === 'cs2-control-plane' && parsed.port > 0) {
            clearTimeout(timer);
            resolve(parsed);
            return;
          }
        } catch {
          // Ignore non-JSON log lines.
        }
      }
    });
  });

  const cpBase = `http://127.0.0.1:${cpReadyLine.port}`;

  const workerOpts = workerId => ({
    port: 0,
    host: '127.0.0.1',
    logicOnly: true,
    allowedOrigins: 'https://web-cdn.example.com',
    joinTokenSecret: JOIN_SECRET,
    requireJoinToken: true,
    workerId,
    controlPlaneUrl: cpBase,
    workerAuthToken: WORKER_AUTH,
    heartbeatIntervalMs: 300,
  });

  const workerA = await startGameServer(workerOpts('worker-dust2-a'));
  const workerB = await startGameServer(workerOpts('worker-dust2-b'));
  workers.set('worker-dust2-a', workerA);
  workers.set('worker-dust2-b', workerB);
  await Promise.all([workerA.reporter.ready, workerB.reporter.ready]);

  const health = await (await fetch(`${cpBase}/api/v1/health`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.stats.activeWorkers, 2);

  // 1. Direct WS join without JoinToken is rejected.
  const unauthWs = new WebSocket(`ws://127.0.0.1:${workerA.port}/ws`, { headers: { Origin: 'https://web-cdn.example.com' } });
  sockets.push(unauthWs);
  await once(unauthWs, 'open');
  const unauthErrP = waitForMessage(unauthWs, m => m.type === 'error');
  unauthWs.send(JSON.stringify({ type: 'join', name: 'NoToken', bots: 0, rulesVersion: RULES_VERSION, assetVersion: ASSET_VERSION }));
  assert.equal((await unauthErrP).code, 'JOIN_TOKEN_REQUIRED');

  // 2. Client requests room creation from Go Control Plane and connects directly to assigned Battle Worker.
  const createRes = await fetch(`${cpBase}/api/v1/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://web-cdn.example.com' },
    body: JSON.stringify({ mapId: 'de_dust2', mode: 'defuse', visibility: 'public', playerName: 'Alpha' }),
  });
  assert.equal(createRes.status, 201);
  assert.equal(createRes.headers.get('access-control-allow-origin'), 'https://web-cdn.example.com');
  const created = await createRes.json();
  assert.ok(['worker-dust2-a', 'worker-dust2-b'].includes(created.workerId));
  assert.ok(created.joinToken.startsWith('v2.'));

  // Using Alpha's token on the OTHER worker fails worker-binding verification.
  const otherWorker = workers.get(created.workerId === 'worker-dust2-a' ? 'worker-dust2-b' : 'worker-dust2-a');
  const wrongWorkerWs = new WebSocket(`ws://127.0.0.1:${otherWorker.port}/ws?token=${encodeURIComponent(created.joinToken)}`);
  sockets.push(wrongWorkerWs);
  await once(wrongWorkerWs, 'open');
  const wrongWorkerErrP = waitForMessage(wrongWorkerWs, m => m.type === 'error');
  wrongWorkerWs.send(JSON.stringify({ type: 'join', name: 'Alpha', bots: 0, rulesVersion: RULES_VERSION, assetVersion: ASSET_VERSION }));
  assert.equal((await wrongWorkerErrP).code, 'TOKEN_WORKER_MISMATCH');

  // Connecting to the assigned worker succeeds via handshake ?token=...
  const ws1 = new WebSocket(`${created.workerWsUrl}?token=${encodeURIComponent(created.joinToken)}`, {
    headers: { Origin: 'https://web-cdn.example.com' },
  });
  sockets.push(ws1);
  await once(ws1, 'open');
  const welcome1P = waitForMessage(ws1, m => m.type === 'welcome');
  ws1.send(JSON.stringify({ type: 'join', name: 'Alpha', bots: 4, rulesVersion: RULES_VERSION, assetVersion: ASSET_VERSION }));
  const welcome1 = await welcome1P;
  assert.equal(welcome1.room, created.roomCode);

  // Replaying the consumed JoinToken is rejected.
  const replayWs = new WebSocket(created.workerWsUrl);
  sockets.push(replayWs);
  await once(replayWs, 'open');
  const replayErrP = waitForMessage(replayWs, m => m.type === 'error');
  replayWs.send(JSON.stringify({ type: 'join', joinToken: created.joinToken, name: 'Replay', bots: 0, rulesVersion: RULES_VERSION, assetVersion: ASSET_VERSION }));
  assert.equal((await replayErrP).code, 'JOIN_TOKEN_REPLAYED');

  // 3. Global room directory shows the active room.
  const assignedWorker = workers.get(created.workerId);
  await assignedWorker.reporter.reportNow();
  const dir = await (await fetch(`${cpBase}/api/v1/rooms?mapId=de_dust2`)).json();
  assert.equal(dir.rooms.length, 1);
  assert.equal(dir.rooms[0].code, created.roomCode);
  assert.equal(dir.rooms[0].humans, 1);
  assert.equal(dir.rooms[0].joinable, true);

  // 4. Player 2 joins via Control Plane /join and passes joinToken in message body.
  const joinRes = await fetch(`${cpBase}/api/v1/rooms/${created.roomCode}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerName: 'Bravo' }),
  });
  assert.equal(joinRes.status, 200);
  const joined = await joinRes.json();
  assert.equal(joined.workerId, created.workerId);

  const ws2 = new WebSocket(joined.workerWsUrl);
  sockets.push(ws2);
  await once(ws2, 'open');
  const welcome2P = waitForMessage(ws2, m => m.type === 'welcome');
  ws2.send(JSON.stringify({ type: 'join', joinToken: joined.joinToken, name: 'Bravo', rulesVersion: RULES_VERSION, assetVersion: ASSET_VERSION }));
  const welcome2 = await welcome2P;
  assert.equal(welcome2.room, created.roomCode);
  assert.equal(assignedWorker.rooms.get(created.roomCode).humanCount, 2);

  // 5. Draining the assigned worker blocks joins on it, preserves active players, and routes new rooms to the healthy worker.
  assignedWorker.beginDrain();
  await assignedWorker.reporter.reportNow();

  const drainedJoin = await fetch(`${cpBase}/api/v1/rooms/${created.roomCode}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerName: 'Charlie' }),
  });
  assert.equal(drainedJoin.status, 409);

  const nextCreate = await fetch(`${cpBase}/api/v1/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mapId: 'de_dust2', mode: 'deathmatch', visibility: 'public', playerName: 'Delta' }),
  });
  assert.equal(nextCreate.status, 201);
  const nextCreated = await nextCreate.json();
  assert.notEqual(nextCreated.workerId, created.workerId);

  // Active players on the draining worker continue receiving snapshots.
  const liveSnap = await waitForMessage(ws1, m => m.type === 'snapshot');
  assert.equal(liveSnap.room, created.roomCode);
});
