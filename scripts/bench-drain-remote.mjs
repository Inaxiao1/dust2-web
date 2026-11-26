import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { WebSocket } from 'ws';
import { BINARY_PROTOCOL_VERSION, encodeInputBinary } from '../shared/binary-protocol.js';
import { ASSET_VERSION, CLIENT_BUILD, RULES_VERSION } from '../shared/online-build.js';

const execFileAsync = promisify(execFile);
const BASE_HTTP = (process.env.BENCH_BASE_URL || 'https://game.example.com/cs2').replace(/\/+$/, '');
const ORIGIN = process.env.BENCH_ORIGIN || 'https://game.example.com';
const DRAIN_CMD = process.env.DRAIN_CMD || '';

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { Origin: ORIGIN, ...(opts.headers || {}) },
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, ok: res.ok, data };
}

async function createRoom(name) {
  const res = await fetchJson(`${BASE_HTTP}/api/v1/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mapId: 'de_dust2', mode: 'deathmatch', bots: 4, visibility: 'private', playerName: name }),
  });
  if (!res.ok) throw new Error(`createRoom failed: ${res.status} ${JSON.stringify(res.data)}`);
  return { ...res.data, wsUrl: res.data.workerWsUrl || res.data.wsUrl };
}

async function joinRoom(room, name) {
  const ws = new WebSocket(room.wsUrl, { headers: { Origin: ORIGIN }, perMessageDeflate: false });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('WS open timeout')), 10000);
    ws.once('open', () => { clearTimeout(t); resolve(); });
    ws.once('error', err => { clearTimeout(t); reject(err); });
  });
  let binarySnaps = 0;
  let closedEarly = false;
  let joinedResolve, joinedReject;
  const joinedP = new Promise((res, rej) => { joinedResolve = res; joinedReject = rej; });
  ws.on('close', () => { closedEarly = true; });
  ws.on('message', (data, isBinary) => {
    if (isBinary) { binarySnaps += 1; return; }
    const msg = JSON.parse(data.toString('utf8'));
    if (msg.type === 'welcome') joinedResolve(msg);
    if (msg.type === 'error') joinedReject(new Error(`${msg.code}: ${msg.message}`));
  });
  ws.send(JSON.stringify({
    type: 'join', name, room: room.roomCode, joinToken: room.joinToken,
    mode: 'deathmatch', bots: 4, visibility: 'private',
    clientBuild: CLIENT_BUILD, rulesVersion: RULES_VERSION, assetVersion: ASSET_VERSION,
    binaryProtocol: BINARY_PROTOCOL_VERSION,
  }));
  await joinedP;
  return {
    ws,
    getSnaps: () => binarySnaps,
    isClosed: () => closedEarly,
    sendTick: (seq) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(encodeInputBinary({ seq, forward: 1, right: 0, yaw: 0.5, pitch: 0, slot: 1 }));
      }
    },
    close: () => new Promise(resolve => {
      if (ws.readyState === WebSocket.CLOSED) return resolve();
      ws.once('close', () => resolve());
      ws.close();
      setTimeout(() => { try { ws.terminate(); } catch {} resolve(); }, 2000);
    }),
  };
}

async function sleep(ms) { await new Promise(r => setTimeout(r, ms)); }

async function main() {
  if (!DRAIN_CMD) throw new Error('Set DRAIN_CMD with {WORKER_PORT} placeholder to trigger remote localhost /drain');

  // 1. Open active Room A
  const roomA = await createRoom('DrainSurvivor');
  const clientA = await joinRoom(roomA, 'DrainSurvivor');
  const drainedWorkerId = roomA.workerId;
  const workerShort = drainedWorkerId.endsWith('1') ? 'w1' : 'w2';
  const workerPort = drainedWorkerId.endsWith('1') ? '19101' : '19102';
  const otherWorkerId = drainedWorkerId.endsWith('1') ? 's156-worker-2' : 's156-worker-1';

  await sleep(1000);
  const snapsBeforeDrain = clientA.getSnaps();

  // 2. Trigger POST /drain on the worker hosting Room A
  const drainStarted = performance.now();
  const cmd = DRAIN_CMD.replaceAll('{WORKER_PORT}', workerPort);
  const { stdout: drainOut } = await execFileAsync('bash', ['-lc', cmd]);

  // 3. Verify /ready returns 503 immediately
  const readyRes = await fetchJson(`${BASE_HTTP}/${workerShort}/ready`);

  // 4. Wait until Control Plane sees drainingWorkers === 1
  let cpAfter = null;
  let cpDetectMs = 0;
  for (let i = 0; i < 20; i++) {
    const r = await fetchJson(`${BASE_HTTP}/api/v1/health`);
    if (r.data?.stats?.drainingWorkers === 1 && r.data?.stats?.activeWorkers === 1) {
      cpAfter = r.data;
      cpDetectMs = Math.round((performance.now() - drainStarted) * 100) / 100;
      break;
    }
    await sleep(150);
  }

  // 5. Create 4 new rooms and verify 100% land on the healthy non-draining worker
  const routedWorkers = [];
  for (let i = 0; i < 4; i++) {
    const r = await createRoom(`NewPlayer${i + 1}`);
    routedWorkers.push(r.workerId);
  }

  // 6. Keep sending inputs on Room A for 3s to prove zero drops on the draining worker
  const snapsAtDrain = clientA.getSnaps();
  for (let i = 1; i <= 30; i++) {
    clientA.sendTick(i);
    await sleep(100);
  }
  const snapsAfterDrain = clientA.getSnaps();
  const survived = !clientA.isClosed() && (snapsAfterDrain - snapsAtDrain) >= 20;

  await clientA.close();
  await sleep(500);

  const result = {
    drainedWorkerId,
    expectedFailoverWorkerId: otherWorkerId,
    drainEndpointOutput: drainOut.trim(),
    readyHttpStatusAfterDrain: readyRes.status,
    readyBodyAfterDrain: readyRes.data,
    controlPlaneDetectMs: cpDetectMs,
    controlPlaneStatsAfterDrain: cpAfter?.stats || null,
    newRoomsRoutedTo: routedWorkers,
    allNewRoomsAvoidedDrainingWorker: routedWorkers.every(w => w === otherWorkerId),
    existingRoomSnapsBeforeDrain: snapsBeforeDrain,
    existingRoomSnapsDuring3sDrain: snapsAfterDrain - snapsAtDrain,
    existingRoomZeroDrops: survived,
  };

  console.log(JSON.stringify(result, null, 2));
  if (!result.allNewRoomsAvoidedDrainingWorker || !result.existingRoomZeroDrops || result.readyHttpStatusAfterDrain !== 503) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('[drain-bench] FATAL:', err);
  process.exit(1);
});
