import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { startGameServer } from '../server/index.js';
import { RULES_VERSION, ASSET_VERSION } from '../shared/online-build.js';
import { auditLogicSplit } from '../scripts/verify-logic-split.mjs';

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

test('auditLogicSplit confirms zero render, texture, audio, or HTML files in server logic bundle', () => {
  const report = auditLogicSplit();
  assert.equal(report.ok, true, `Unexpected media/UI files in logic bundle: ${report.forbiddenInLogic.join(', ')}`);
  assert.deepEqual(report.forbiddenInLogic, []);
  assert.ok(report.serverLogic.code.count > 0);
});

test('logicOnly mode blocks static assets/HTML while keeping health, ready, and WS gameplay functional', async () => {
  const app = await startGameServer({ port: 0, host: '127.0.0.1', logicOnly: true });
  const sockets = [];
  try {
    const base = `http://127.0.0.1:${app.port}`;
    for (const urlPath of ['/', '/index.html', '/assets/map/collision.json', '/nonexistent']) {
      const res = await fetch(base + urlPath);
      assert.equal(res.status, 404);
      const body = await res.json();
      assert.equal(body.error, 'STATIC_DISABLED_LOGIC_ONLY');
    }

    const readyRes = await fetch(base + '/ready');
    assert.equal(readyRes.status, 200);
    assert.deepEqual(await readyRes.json(), {
      ok: true, ready: true, draining: false, logicOnly: true, serveMapFiles: true, rooms: 0, humans: 0,
    });

    const healthRes = await fetch(base + '/health');
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    assert.equal(health.ready, true);
    assert.equal(health.draining, false);
    assert.equal(health.logicOnly, true);

    const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`);
    sockets.push(ws);
    await once(ws, 'open');
    const welcome = waitForMessage(ws, m => m.type === 'welcome');
    ws.send(JSON.stringify({ type: 'join', name: 'LogicTester', bots: 1, rulesVersion: RULES_VERSION, assetVersion: ASSET_VERSION }));
    const joined = await welcome;
    assert.equal(joined.type, 'welcome');
    const snapshot = await waitForMessage(ws, m => m.type === 'snapshot');
    assert.equal(snapshot.room, joined.room);
  } finally {
    for (const s of sockets) s.terminate();
    await app.close();
  }
});

test('serveMapFiles: false disables map geometry HTTP downloads while retaining signed /private-map.json', async () => {
  const mapRequests = [];
  const fakePrivateMap = {
    mapId: 'de_test',
    mapSignature: 'sig_1',
    config: { physicsSha256: 'hash_1' },
    handleRequest(req, res, pathname) {
      mapRequests.push(pathname);
      if (pathname === '/private-map.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'de_test', mapSignature: 'sig_1' }));
        return true;
      }
      if (pathname === '/maps/de_test/physics.f32') {
        res.writeHead(200);
        res.end('binary');
        return true;
      }
      return false;
    },
  };
  const app = await startGameServer({
    port: 0,
    host: '127.0.0.1',
    privateMap: fakePrivateMap,
    logicOnly: true,
    serveMapFiles: false,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const manifest = await fetch(base + '/private-map.json');
    assert.equal(manifest.status, 200);
    assert.equal((await manifest.json()).id, 'de_test');

    const mapAsset = await fetch(base + '/maps/de_test/physics.f32');
    assert.equal(mapAsset.status, 404);
    assert.equal((await mapAsset.json()).error, 'STATIC_DISABLED_LOGIC_ONLY');
    assert.deepEqual(mapRequests, ['/private-map.json']);
  } finally {
    await app.close();
  }
});

test('graceful drain marks /ready 503, rejects new joins with SERVER_DRAINING, and preserves active matches', async () => {
  const app = await startGameServer({
    port: 0,
    host: '127.0.0.1',
    logicOnly: true,
    drainToken: 'secret-drain-token',
    performanceDirectory: true,
  });
  const sockets = [];
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const ws1 = new WebSocket(`ws://127.0.0.1:${app.port}/ws`);
    sockets.push(ws1);
    await once(ws1, 'open');
    const welcomeP = waitForMessage(ws1, m => m.type === 'welcome');
    ws1.send(JSON.stringify({ type: 'join', name: 'ActivePlayer', bots: 1, rulesVersion: RULES_VERSION, assetVersion: ASSET_VERSION }));
    const welcome = await welcomeP;

    const badAuth = await fetch(base + '/drain', { method: 'POST', headers: { Authorization: 'Bearer wrong' } });
    assert.equal(badAuth.status, 401);

    const drainRes = await fetch(base + '/drain', { method: 'POST', headers: { Authorization: 'Bearer secret-drain-token' } });
    assert.equal(drainRes.status, 200);
    assert.deepEqual(await drainRes.json(), { ok: true, ready: false, draining: true, rooms: 1 });
    assert.equal(app.isDraining(), true);

    const readyRes = await fetch(base + '/ready');
    assert.equal(readyRes.status, 503);
    assert.equal((await readyRes.json()).draining, true);

    const dir = await (await fetch(base + '/room-directory.json')).json();
    assert.equal(dir.length, 1);
    assert.equal(dir[0].joinable, false);

    // Existing player still receives snapshots.
    const nextSnapshot = await waitForMessage(ws1, m => m.type === 'snapshot');
    assert.equal(nextSnapshot.room, welcome.room);

    // New player join is rejected cleanly.
    const ws2 = new WebSocket(`ws://127.0.0.1:${app.port}/ws`);
    sockets.push(ws2);
    await once(ws2, 'open');
    const errP = waitForMessage(ws2, m => m.type === 'error');
    ws2.send(JSON.stringify({ type: 'join', name: 'LatePlayer', bots: 0, rulesVersion: RULES_VERSION, assetVersion: ASSET_VERSION }));
    const err = await errP;
    assert.equal(err.code, 'SERVER_DRAINING');
  } finally {
    for (const s of sockets) s.terminate();
    await app.close();
  }
});

test('allowedOrigins enforces CORS headers and WebSocket origin whitelist while permitting originless clients', async () => {
  const app = await startGameServer({
    port: 0,
    host: '127.0.0.1',
    logicOnly: true,
    allowedOrigins: 'https://cdn.example.com,https://app.example.com',
  });
  const sockets = [];
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const preflight = await fetch(base + '/health', {
      method: 'OPTIONS',
      headers: { Origin: 'https://cdn.example.com' },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://cdn.example.com');

    const disallowed = await fetch(base + '/health', {
      headers: { Origin: 'https://evil.example.com' },
    });
    assert.equal(disallowed.headers.get('access-control-allow-origin'), null);

    // Browser-spoofed disallowed WS origin is rejected with 403.
    const badWs = new WebSocket(`ws://127.0.0.1:${app.port}/ws`, { headers: { Origin: 'https://evil.example.com' } });
    badWs.on('error', () => {});
    const [, unexpected] = await once(badWs, 'unexpected-response');
    assert.equal(unexpected.statusCode, 403);
    unexpected.resume();
    badWs.terminate();

    // Allowed WS origin connects.
    const goodWs = new WebSocket(`ws://127.0.0.1:${app.port}/ws`, { headers: { Origin: 'https://app.example.com' } });
    sockets.push(goodWs);
    await once(goodWs, 'open');

    // Native/non-browser client without Origin header also connects.
    const nativeWs = new WebSocket(`ws://127.0.0.1:${app.port}/ws`);
    sockets.push(nativeWs);
    await once(nativeWs, 'open');
  } finally {
    for (const s of sockets) if (s.readyState === WebSocket.OPEN) s.terminate();
    await app.close();
  }
});

test('performance-maps gateway honors PERF_MAP_BASE_URL, PERF_DISABLE_LOCAL_ASSETS, PERF_LOGIC_GATEWAY_ONLY, and SIGUSR2 drain', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dust2-logic-gw-'));
  await mkdir(path.join(root, 'assets'));
  await writeFile(path.join(root, 'assets/bundle.js'), 'console.log(1);');
  await writeFile(path.join(root, 'catalog.json'), '{"maps":[]}');
  const child = spawn(process.execPath, ['server/performance-maps.js'], {
    env: {
      ...process.env,
      PORT: '0',
      PERF_MAP_ROOT: root,
      PERF_GAME_DIST: root,
      PERF_ASSET_BASE_URL: 'https://cdn.example.com/assets/',
      PERF_MAP_BASE_URL: 'https://cdn.example.com/maps/',
      PERF_DISABLE_LOCAL_ASSETS: '1',
      PERF_LOGIC_GATEWAY_ONLY: '1',
      PERF_ALLOWED_ORIGINS: 'https://cdn.example.com',
    },
    stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
  });
  const closed = once(child, 'exit');
  t.after(async () => {
    if (child.connected) child.disconnect();
    await closed;
    await rm(root, { recursive: true, force: true });
  });
  const [output] = await once(child.stdout, 'data', { signal: AbortSignal.timeout(15000) });
  const base = output.toString().match(/http:\/\/127\.0\.0\.1:\d+/)[0];

  const cfgRes = await fetch(base + '/perf/download-config.json', { headers: { Origin: 'https://cdn.example.com' } });
  assert.equal(cfgRes.status, 200);
  assert.equal(cfgRes.headers.get('access-control-allow-origin'), 'https://cdn.example.com');
  assert.deepEqual(await cfgRes.json(), {
    schemaVersion: 1,
    assetBaseURL: 'https://cdn.example.com/assets/',
    mapBaseURL: 'https://cdn.example.com/maps/',
    fallbackToGameServer: false,
  });

  const assetRes = await fetch(base + '/perf/assets/bundle.js');
  assert.equal(assetRes.status, 404);
  assert.equal((await assetRes.json()).error, 'LOCAL_ASSETS_DISABLED');

  const uiRes = await fetch(base + '/perf/');
  assert.equal(uiRes.status, 404);
  assert.equal((await uiRes.json()).error, 'UI_DISABLED_LOGIC_GATEWAY');

  const readyBefore = await fetch(base + '/perf/ready');
  assert.equal(readyBefore.status, 200);
  const health = await (await fetch(base + '/perf/health')).json();
  assert.equal(health.disableLocalAssets, true);
  assert.equal(health.logicGatewayOnly, true);

  const gwMetricsRes = await fetch(base + '/perf/metrics');
  assert.equal(gwMetricsRes.status, 200);
  const gwMetricsText = await gwMetricsRes.text();
  assert.match(gwMetricsText, /cs2_gateway_up 1/);
  assert.match(gwMetricsText, /cs2_gateway_ready 1/);

  const mapsApiRes = await fetch(base + '/perf/api/maps');
  assert.equal(mapsApiRes.status, 200);
  const mapsApiJson = await mapsApiRes.json();
  assert.equal(mapsApiJson.ok, true);
  assert.equal(Array.isArray(mapsApiJson.maps), true);

  child.kill('SIGUSR2');
  await new Promise(r => setTimeout(r, 100));
  const readyAfter = await fetch(base + '/perf/ready');
  assert.equal(readyAfter.status, 503);
  assert.equal((await readyAfter.json()).draining, true);
});

test('battle worker exposes Prometheus /metrics with tick quantiles and token rejection counters', async () => {
  const app = await startGameServer({
    port: 0,
    host: '127.0.0.1',
    logicOnly: true,
    requireJoinToken: true,
    joinTokenSecret: 'metrics-worker-secret-32-bytes!!',
  });
  let ws;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`);
    await once(ws, 'open');
    const errPromise = once(ws, 'message');
    ws.send(JSON.stringify({ type: 'join', name: 'NoToken', mode: 'deathmatch', bots: 0 }));
    const [raw] = await errPromise;
    assert.equal(JSON.parse(raw.toString()).code, 'JOIN_TOKEN_REQUIRED');

    const res = await fetch(`http://127.0.0.1:${app.port}/metrics`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/plain/);
    const body = await res.text();
    assert.match(body, /cs2_worker_up\{map_id="de_dust2"\} 1/);
    assert.match(body, /cs2_worker_ready\{map_id="de_dust2"\} 1/);
    assert.match(body, /cs2_worker_tick_ms\{map_id="de_dust2",quantile="0\.99"\}/);
    assert.match(body, /cs2_worker_join_token_rejected_total\{map_id="de_dust2"\} 1/);

    app.beginDrain();
    const drainedBody = await (await fetch(`http://127.0.0.1:${app.port}/metrics`)).text();
    assert.match(drainedBody, /cs2_worker_ready\{map_id="de_dust2"\} 0/);
    assert.match(drainedBody, /cs2_worker_draining\{map_id="de_dust2"\} 1/);
  } finally {
    if (ws && ws.readyState === WebSocket.OPEN) ws.terminate();
    await app.close();
  }
});

test('ended matches are immediately hidden from room directory and deleted when closed', async () => {
  const app = await startGameServer({
    port: 0,
    host: '127.0.0.1',
    logicOnly: true,
    performanceDirectory: true,
    reconnectGraceMs: 30000,
  });
  let ws;
  try {
    const base = `http://127.0.0.1:${app.port}`;
    ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`);
    await once(ws, 'open');
    const welcomeP = waitForMessage(ws, m => m.type === 'welcome');
    ws.send(JSON.stringify({ type: 'join', name: 'Finisher', bots: 0, rulesVersion: RULES_VERSION, assetVersion: ASSET_VERSION }));
    const welcome = await welcomeP;

    const liveDir = await (await fetch(base + '/room-directory.json')).json();
    assert.equal(liveDir.length, 1);
    assert.equal(liveDir[0].code, welcome.room);

    const room = app.rooms.get(welcome.room);
    room.endMatch('A', 'test complete');
    assert.ok(room.matchEndedWallAt > 0);

    const endedDir = await (await fetch(base + '/room-directory.json')).json();
    assert.equal(endedDir.length, 0);

    // Closing socket on an ended room deletes it immediately instead of waiting reconnectGraceMs.
    const closedP = once(ws, 'close');
    ws.terminate();
    await closedP;
    await new Promise(r => setTimeout(r, 30));
    assert.equal(app.rooms.has(welcome.room), false);
  } finally {
    if (ws && ws.readyState === WebSocket.OPEN) ws.terminate();
    await app.close();
  }
});
