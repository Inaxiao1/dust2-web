import { performance } from 'node:perf_hooks';
import { WebSocket } from 'ws';
import {
  BINARY_PROTOCOL_VERSION,
  encodeInputBinary,
} from '../shared/binary-protocol.js';
import { ASSET_VERSION, CLIENT_BUILD, RULES_VERSION } from '../shared/online-build.js';

const BASE_HTTP = (process.env.BENCH_BASE_URL || 'https://game.example.com/cs2').replace(/\/+$/, '');
const ORIGIN = process.env.BENCH_ORIGIN || 'https://game.example.com';
const STAGES = (process.env.BENCH_STAGES || '2,6,12,20,28')
  .split(',')
  .map(v => Number(v.trim()))
  .filter(v => Number.isInteger(v) && v > 0);
const WORKER_COUNT = Math.max(1, Number(process.env.BENCH_WORKERS) || 2);
const STAGE_DURATION_MS = Number(process.env.BENCH_STAGE_MS) || 8000;
const BANDWIDTH_DURATION_MS = Number(process.env.BENCH_BW_MS) || 6000;

function stats(values) {
  if (!values.length) return { count: 0, min: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0, stddev: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const avg = sum / sorted.length;
  const variance = sorted.reduce((acc, v) => acc + (v - avg) ** 2, 0) / sorted.length;
  const pct = p => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
  const r = n => Math.round(n * 100) / 100;
  return {
    count: sorted.length,
    min: r(sorted[0]),
    avg: r(avg),
    p50: r(pct(0.5)),
    p95: r(pct(0.95)),
    p99: r(pct(0.99)),
    max: r(sorted[sorted.length - 1]),
    stddev: r(Math.sqrt(variance)),
  };
}

async function fetchJson(url, opts = {}, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const started = performance.now();
    try {
      const res = await fetch(url, {
        ...opts,
        headers: {
          Origin: ORIGIN,
          ...(opts.headers || {}),
        },
      });
      const text = await res.text();
      const elapsedMs = performance.now() - started;
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
      return { status: res.status, ok: res.ok, elapsedMs, data };
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(200 * (attempt + 1));
    }
  }
  throw lastErr;
}

async function createRoomViaCP({ mode = 'deathmatch', bots = 9, visibility = 'private', name = 'BenchPlayer' } = {}) {
  const res = await fetchJson(`${BASE_HTTP}/api/v1/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mapId: 'de_dust2',
      mode,
      bots,
      visibility,
      playerName: name,
    }),
  });
  if (!res.ok) {
    throw new Error(`POST /api/v1/rooms failed (${res.status}): ${JSON.stringify(res.data)}`);
  }
  return { ...res.data, wsUrl: res.data.workerWsUrl || res.data.wsUrl, httpMs: res.elapsedMs };
}

async function openAndJoinClient({
  wsUrl,
  roomCode,
  joinToken,
  mode = 'deathmatch',
  bots = 9,
  visibility = 'private',
  name = 'BenchPlayer',
  binaryProtocol = 2,
}) {
  const connectStarted = performance.now();
  const ws = new WebSocket(wsUrl, {
    headers: { Origin: ORIGIN },
    perMessageDeflate: false,
  });

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`WS connect timeout: ${wsUrl}`)), 10000);
    ws.once('open', () => { clearTimeout(t); resolve(); });
    ws.once('error', err => { clearTimeout(t); reject(err); });
  });
  const wsConnectMs = performance.now() - connectStarted;

  let bytesIn = 0;
  let bytesOut = 0;
  let binaryFramesIn = 0;
  let jsonFramesIn = 0;
  let snapshotFramesIn = 0;
  let lastSnapshotAt = 0;
  const snapshotIntervals = [];
  const pongRtts = [];
  const pendingPings = new Map();
  let joinedResolve = null;
  let joinedReject = null;
  const joinedPromise = new Promise((resolve, reject) => {
    joinedResolve = resolve;
    joinedReject = reject;
  });
  const joinTimer = setTimeout(() => joinedReject(new Error(`WS join timeout for room ${roomCode}`)), 10000);

  ws.on('message', (data, isBinary) => {
    const byteLen = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data);
    bytesIn += byteLen;
    if (isBinary) {
      binaryFramesIn += 1;
      snapshotFramesIn += 1;
      const now = performance.now();
      if (lastSnapshotAt > 0) snapshotIntervals.push(now - lastSnapshotAt);
      lastSnapshotAt = now;
      return;
    }
    jsonFramesIn += 1;
    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    if (msg.type === 'welcome') {
      clearTimeout(joinTimer);
      joinedResolve(msg);
    } else if (msg.type === 'error') {
      clearTimeout(joinTimer);
      joinedReject(new Error(`Server error ${msg.code}: ${msg.message}`));
    } else if (msg.type === 'pong') {
      const sentAt = pendingPings.get(msg.time);
      if (sentAt !== undefined) {
        pongRtts.push(performance.now() - sentAt);
        pendingPings.delete(msg.time);
      }
    } else if (msg.type === 'snapshot') {
      snapshotFramesIn += 1;
      const now = performance.now();
      if (lastSnapshotAt > 0) snapshotIntervals.push(now - lastSnapshotAt);
      lastSnapshotAt = now;
    }
  });

  const joinPayload = JSON.stringify({
    type: 'join',
    name,
    room: roomCode,
    joinToken,
    mode,
    bots,
    visibility,
    clientBuild: CLIENT_BUILD,
    rulesVersion: RULES_VERSION,
    assetVersion: ASSET_VERSION,
    ...(binaryProtocol === 2 ? { binaryProtocol: BINARY_PROTOCOL_VERSION } : {}),
  });
  bytesOut += Buffer.byteLength(joinPayload);
  ws.send(joinPayload);

  const joined = await joinedPromise;
  const joinTotalMs = performance.now() - connectStarted;

  let seq = 1;
  const sendInput = (useBinary) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const angle = (seq * 0.08) % (Math.PI * 2);
    const input = {
      type: 'input',
      seq: seq++,
      forward: Math.sin(angle) > 0 ? 1 : -1,
      right: Math.cos(angle) > 0 ? 1 : -1,
      yaw: angle,
      pitch: 0.02 * Math.sin(angle),
      jump: seq % 60 === 0,
      crouch: false,
      walk: false,
      fire: seq % 15 === 0,
      fire2: false,
      reload: false,
      interact: false,
      slot: 1,
    };
    if (useBinary) {
      const bin = encodeInputBinary(input);
      bytesOut += bin.byteLength;
      ws.send(bin);
    } else {
      const txt = JSON.stringify(input);
      bytesOut += Buffer.byteLength(txt);
      ws.send(txt);
    }
  };

  let pingSeq = 1;
  const sendPing = () => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const token = pingSeq++;
    pendingPings.set(token, performance.now());
    const txt = JSON.stringify({ type: 'ping', time: token });
    bytesOut += Buffer.byteLength(txt);
    ws.send(txt);
  };

  const resetCounters = () => {
    bytesIn = 0;
    bytesOut = 0;
    binaryFramesIn = 0;
    jsonFramesIn = 0;
    snapshotFramesIn = 0;
    lastSnapshotAt = 0;
    snapshotIntervals.length = 0;
  };

  const getMetrics = () => ({
    bytesIn,
    bytesOut,
    binaryFramesIn,
    jsonFramesIn,
    snapshotFramesIn,
    snapshotIntervals: [...snapshotIntervals],
    pongRtts: [...pongRtts],
  });

  const close = () => new Promise(resolve => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.once('close', () => resolve());
    ws.close();
    setTimeout(() => { try { ws.terminate(); } catch {} resolve(); }, 2000);
  });

  return {
    ws,
    joined,
    wsConnectMs,
    joinTotalMs,
    sendInput,
    sendPing,
    resetCounters,
    getMetrics,
    close,
  };
}

async function sampleClusterHealth() {
  const [cp, ...workerRes] = await Promise.all([
    fetchJson(`${BASE_HTTP}/api/v1/health`),
    ...Array.from({ length: WORKER_COUNT }, (_, i) => fetchJson(`${BASE_HTTP}/w${i + 1}/health`)),
  ]);
  const workers = {};
  workerRes.forEach((r, i) => {
    workers[`w${i + 1}`] = r.data;
  });
  return {
    cp: cp.data,
    w1: workers.w1,
    w2: workers.w2 || workers.w1,
    workers,
  };
}

async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function benchControlPlaneHttp() {
  // Warmup
  await fetchJson(`${BASE_HTTP}/api/v1/health`);

  const healthSeq = [];
  for (let i = 0; i < 30; i++) {
    const r = await fetchJson(`${BASE_HTTP}/api/v1/health`);
    if (!r.ok) throw new Error(`health HTTP ${r.status}`);
    healthSeq.push(r.elapsedMs);
  }

  const roomsSeq = [];
  for (let i = 0; i < 20; i++) {
    const r = await fetchJson(`${BASE_HTTP}/api/v1/rooms`);
    if (!r.ok) throw new Error(`rooms HTTP ${r.status}`);
    roomsSeq.push(r.elapsedMs);
  }

  const concWorkers = 12;
  const concRounds = 4;
  const concStarted = performance.now();
  const concTimes = [];
  let concErrors = 0;
  await Promise.all(
    Array.from({ length: concWorkers }, async () => {
      for (let r = 0; r < concRounds; r++) {
        try {
          const res = await fetchJson(`${BASE_HTTP}/api/v1/health`);
          if (res.ok) concTimes.push(res.elapsedMs);
          else concErrors++;
        } catch {
          concErrors++;
        }
      }
    })
  );
  const concTotalMs = performance.now() - concStarted;

  return {
    healthSequentialMs: stats(healthSeq),
    roomsSequentialMs: stats(roomsSeq),
    healthConcurrent: {
      concurrency: concWorkers,
      totalRequests: concWorkers * concRounds,
      okCount: concTimes.length,
      errorCount: concErrors,
      totalMs: Math.round(concTotalMs * 100) / 100,
      qps: Math.round((concTimes.length / (concTotalMs / 1000)) * 10) / 10,
      latencyMs: stats(concTimes),
    },
  };
}

async function benchWsLatency() {
  const room = await createRoomViaCP({ mode: 'deathmatch', bots: 9, name: 'RTTProbe' });
  const client = await openAndJoinClient({
    wsUrl: room.wsUrl,
    roomCode: room.roomCode,
    joinToken: room.joinToken,
    mode: 'deathmatch',
    bots: 9,
    name: 'RTTProbe',
    binaryProtocol: 2,
  });

  // 60 application-level ping/pong frames over live WSS
  for (let i = 0; i < 60; i++) {
    client.sendPing();
    await sleep(50);
  }
  await sleep(300);

  const m = client.getMetrics();
  await client.close();
  await sleep(400);

  return {
    workerId: room.workerId,
    roomCreateHttpMs: Math.round(room.httpMs * 100) / 100,
    wsConnectMs: Math.round(client.wsConnectMs * 100) / 100,
    joinTotalMs: Math.round(client.joinTotalMs * 100) / 100,
    rttMs: stats(m.pongRtts),
  };
}

async function measureProtocolBandwidth(binaryProtocol) {
  const room = await createRoomViaCP({
    mode: 'deathmatch',
    bots: 9,
    name: binaryProtocol === 2 ? 'BW_BinV2' : 'BW_JsonV1',
  });
  const client = await openAndJoinClient({
    wsUrl: room.wsUrl,
    roomCode: room.roomCode,
    joinToken: room.joinToken,
    mode: 'deathmatch',
    bots: 9,
    name: binaryProtocol === 2 ? 'BW_BinV2' : 'BW_JsonV1',
    binaryProtocol,
  });

  // Let match initialize & warm up for 1s
  await sleep(1000);
  client.resetCounters();

  const started = performance.now();
  const inputTimer = setInterval(() => client.sendInput(binaryProtocol === 2), 33);
  await sleep(BANDWIDTH_DURATION_MS);
  clearInterval(inputTimer);
  const durationSec = (performance.now() - started) / 1000;

  const m = client.getMetrics();
  await client.close();
  await sleep(500);

  const inKBps = (m.bytesIn / 1024) / durationSec;
  const outKBps = (m.bytesOut / 1024) / durationSec;
  const avgSnapBytes = m.snapshotFramesIn ? m.bytesIn / m.snapshotFramesIn : 0;

  return {
    protocol: binaryProtocol === 2 ? 'binary-v2' : 'json-v1',
    workerId: room.workerId,
    durationSec: Math.round(durationSec * 100) / 100,
    bytesIn: m.bytesIn,
    bytesOut: m.bytesOut,
    inKBps: Math.round(inKBps * 100) / 100,
    outKBps: Math.round(outKBps * 100) / 100,
    snapshotFrames: m.snapshotFramesIn,
    snapshotsPerSec: Math.round((m.snapshotFramesIn / durationSec) * 100) / 100,
    avgBytesPerSnapshot: Math.round(avgSnapBytes * 10) / 10,
    snapshotIntervalMs: stats(m.snapshotIntervals),
  };
}

async function benchConcurrencyStage(roomCount) {
  const clients = [];
  const workerCounts = {};
  const createTimes = [];

  for (let i = 0; i < roomCount; i++) {
    const room = await createRoomViaCP({
      mode: 'deathmatch',
      bots: 9,
      visibility: 'private',
      name: `Load${i + 1}`,
    });
    createTimes.push(room.httpMs);
    workerCounts[room.workerId] = (workerCounts[room.workerId] || 0) + 1;

    const client = await openAndJoinClient({
      wsUrl: room.wsUrl,
      roomCode: room.roomCode,
      joinToken: room.joinToken,
      mode: 'deathmatch',
      bots: 9,
      visibility: 'private',
      name: `Load${i + 1}`,
      binaryProtocol: 2,
    });
    clients.push(client);
  }

  // Warmup 1s, then run 30Hz input + periodic ping across all clients
  await sleep(1000);
  for (const c of clients) c.resetCounters();

  const inputTimer = setInterval(() => {
    for (const c of clients) c.sendInput(true);
  }, 33);
  const pingTimer = setInterval(() => {
    for (let i = 0; i < Math.min(4, clients.length); i++) clients[i].sendPing();
  }, 250);

  await sleep(Math.floor(STAGE_DURATION_MS * 0.65));
  const midHealth = await sampleClusterHealth();
  await sleep(Math.floor(STAGE_DURATION_MS * 0.35));

  clearInterval(inputTimer);
  clearInterval(pingTimer);
  await sleep(250);

  const endHealth = await sampleClusterHealth();
  const allRtts = [];
  const allSnapIntervals = [];
  let totalBytesIn = 0;
  let totalSnapshots = 0;
  for (const c of clients) {
    const m = c.getMetrics();
    allRtts.push(...m.pongRtts);
    allSnapIntervals.push(...m.snapshotIntervals);
    totalBytesIn += m.bytesIn;
    totalSnapshots += m.snapshotFramesIn;
  }

  await Promise.all(clients.map(c => c.close()));
  await sleep(1200);

  const workerSummaries = {};
  for (let i = 1; i <= WORKER_COUNT; i++) {
    const key = `w${i}`;
    workerSummaries[key] = {
      rooms: midHealth.workers[key]?.rooms,
      players: midHealth.workers[key]?.players,
      rssMiB: endHealth.workers[key]?.memory?.rssMiB,
      heapMiB: endHealth.workers[key]?.memory?.heapMiB,
      perf: endHealth.workers[key]?.performance,
    };
  }

  return {
    rooms: roomCount,
    totalPlayers: roomCount * 10,
    workerDistribution: workerCounts,
    roomCreateHttpMs: stats(createTimes),
    underLoadRttMs: stats(allRtts),
    snapshotIntervalMs: stats(allSnapIntervals),
    aggregateDownlinkKBps: Math.round(((totalBytesIn / 1024) / (STAGE_DURATION_MS / 1000)) * 10) / 10,
    totalSnapshotsReceived: totalSnapshots,
    ...workerSummaries,
  };
}

async function main() {
  const startedAt = new Date().toISOString();
  console.error(`[bench] target=${BASE_HTTP} origin=${ORIGIN} stages=${STAGES.join(',')}`);

  const preHealth = await sampleClusterHealth();
  console.error(`[bench] pre-check: cp.activeWorkers=${preHealth.cp.stats?.activeWorkers} w1.ok=${preHealth.w1.ok} w2.ok=${preHealth.w2.ok}`);

  const skipPrelude = process.env.BENCH_SKIP_PRELUDE === '1';
  let http = null;
  let wsLatency = null;
  let bwJson = null;
  let bwBin = null;
  let downlinkSavingPct = 0;
  let uplinkSavingPct = 0;

  if (!skipPrelude) {
    console.error('[bench] 1/4 HTTP Control Plane latency & concurrency...');
    http = await benchControlPlaneHttp();

    console.error('[bench] 2/4 WSS connect/join + 60-sample RTT & jitter...');
    wsLatency = await benchWsLatency();

    console.error('[bench] 3/4 Bandwidth comparison: JSON v1 vs Binary v2 (10 players, 30Hz input)...');
    bwJson = await measureProtocolBandwidth(0);
    bwBin = await measureProtocolBandwidth(2);
    downlinkSavingPct = bwJson.inKBps > 0
      ? Math.round((1 - bwBin.inKBps / bwJson.inKBps) * 1000) / 10
      : 0;
    uplinkSavingPct = bwJson.outKBps > 0
      ? Math.round((1 - bwBin.outKBps / bwJson.outKBps) * 1000) / 10
      : 0;
  }

  console.error('[bench] 4/4 Multi-room concurrency stress ramp...');
  const stages = [];
  for (const count of STAGES) {
    console.error(`[bench]   stage ${count} rooms (${count * 10} players) for ${STAGE_DURATION_MS}ms...`);
    stages.push(await benchConcurrencyStage(count));
  }

  const postHealth = await sampleClusterHealth();

  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    target: BASE_HTTP,
    preHealth: {
      cp: preHealth.cp,
      w1Mem: preHealth.w1.memory,
      w2Mem: preHealth.w2.memory,
    },
    http,
    wsLatency,
    bandwidth: {
      jsonV1: bwJson,
      binaryV2: bwBin,
      downlinkSavingPct,
      uplinkSavingPct,
    },
    concurrencyStages: stages,
    postHealth: {
      cp: postHealth.cp,
      w1Rooms: postHealth.w1.rooms,
      w2Rooms: postHealth.w2.rooms,
      w1Mem: postHealth.w1.memory,
      w2Mem: postHealth.w2.memory,
    },
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch(err => {
  console.error('[bench] FATAL:', err);
  process.exit(1);
});
