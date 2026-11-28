import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { CLIENT_BUILD, RULES_VERSION, ASSET_VERSION } from '../shared/online-build.js';
import { fetchGameApi, getActiveGameOrigin, resetGameOriginFailures, setDynamicCdnConfig, resolveStaticAsset } from '../shared/static-runtime.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAP_ROOT = path.join(ROOT, 'artifacts/performance-maps/maps-v1');
const HAS_MAPS = fs.existsSync(path.join(MAP_ROOT, 'de_dust2/compiled/map.json'));

function startGateway(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server/performance-maps.js'], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`Gateway boot timed out:\n${out}\n${err}`));
    }, 15000);
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
      const m = /http:\/\/127\.0\.0\.1:(\d+)\/perf\//.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve({ child, port: Number(m[1]), origin: `http://127.0.0.1:${m[1]}` });
      }
    });
    child.stderr.on('data', (chunk) => { err += chunk.toString(); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Gateway exited (${code}):\n${out}\n${err}`));
    });
  });
}

function connectAndJoin(wsUrl, mapCfg, extra = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`Timed out waiting for welcome/error on ${wsUrl}`));
    }, 10000);
    ws.once('error', (e) => { clearTimeout(timer); reject(e); });
    ws.once('open', () => {
      ws.send(JSON.stringify({
        type: 'join',
        clientBuild: CLIENT_BUILD,
        rulesVersion: RULES_VERSION,
        assetVersion: ASSET_VERSION,
        mapId: mapCfg.mapId,
        mapSignature: mapCfg.mapSignature,
        physicsSha256: mapCfg.physicsSha256,
        name: 'ClusterTester',
        mode: 'defuse',
        team: 'CT',
        bots: 0,
        ...extra,
      }));
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'welcome' || msg.type === 'error') {
        clearTimeout(timer);
        resolve({ ws, msg });
      }
    });
  });
}

test('per-server PERF_MAX_HUMANS cap rejects overflow and cluster federation routes new rooms to healthy peer', { skip: !HAS_MAPS }, async () => {
  const nodeB = await startGateway({
    PORT: '0',
    PERF_HOST: '127.0.0.1',
    PERF_NODE_ID: 'nodeB',
    PERF_NODE_LABEL: '节点二',
    PERF_MAX_HUMANS: '1',
    PERF_MAX_WORKERS: '2',
    PERF_SHARD_MAPS: 'de_dust2:1',
    PERF_RTC_UDP_PORT: '0',
    DUST2_PRIVATE_MAX_ROOMS: '4',
  });
  const nodeA = await startGateway({
    PORT: '0',
    PERF_HOST: '127.0.0.1',
    PERF_NODE_ID: 'nodeA',
    PERF_NODE_LABEL: '节点一',
    PERF_MAX_HUMANS: '1',
    PERF_MAX_WORKERS: '2',
    PERF_SHARD_MAPS: 'de_dust2:1',
    PERF_RTC_UDP_PORT: '0',
    PERF_CLUSTER_PEERS: `nodeB|节点二|${nodeB.origin}`,
    DUST2_PRIVATE_MAX_ROOMS: '4',
  });
  const sockets = [];
  try {
    const cfgA = await fetch(`${nodeA.origin}/perf/play/de_dust2/private-map.json`).then((r) => r.json());
    const cfgB = await fetch(`${nodeB.origin}/perf/play/de_dust2/private-map.json`).then((r) => r.json());

    // 1. Fill nodeA to its 1-human hard cap.
    const firstA = await connectAndJoin(`ws://127.0.0.1:${nodeA.port}/perf/play/de_dust2/ws`, cfgA);
    sockets.push(firstA.ws);
    assert.equal(firstA.msg.type, 'welcome', 'first join on nodeA should succeed');

    // 2. Second direct join on nodeA must be rejected by PERF_MAX_HUMANS=1.
    const overflowA = await connectAndJoin(`ws://127.0.0.1:${nodeA.port}/perf/play/de_dust2/ws`, cfgA);
    sockets.push(overflowA.ws);
    assert.equal(overflowA.msg.type, 'error');
    assert.equal(overflowA.msg.code, 'SERVER_FULL');

    // 3. With nodeA full (1/1) and nodeB empty (0/1), nodeA's dynamic private-map.json & quick-join route to nodeB!
    const routedCfg = await fetch(`${nodeA.origin}/perf/play/de_dust2/private-map.json`).then((r) => r.json());
    assert.equal(routedCfg.nodeId, 'nodeB');
    assert.deepEqual(routedCfg.wsOrigins, [nodeB.origin]);

    const qj = await fetch(`${nodeA.origin}/perf/quick-join.json?mode=defuse&preferredMap=de_dust2`).then((r) => r.json());
    assert.equal(qj.action, 'create');
    assert.equal(qj.nodeId, 'nodeB');
    assert.ok(qj.joinUrl.includes('node=nodeB'), `expected node=nodeB in ${qj.joinUrl}`);

    // 4. Fill nodeB to 1/1; wait for peer poll; verify merged rooms & cluster-full state.
    const firstB = await connectAndJoin(`ws://127.0.0.1:${nodeB.port}/perf/play/de_dust2/ws`, cfgB);
    sockets.push(firstB.ws);
    assert.equal(firstB.msg.type, 'welcome', 'first join on nodeB should succeed');

    let qjFull = null;
    let mergedDir = null;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 300));
      mergedDir = await fetch(`${nodeA.origin}/perf/rooms.json`).then((r) => r.json());
      qjFull = await fetch(`${nodeA.origin}/perf/quick-join.json?mode=defuse&preferredMap=de_dust2`).then((r) => r.json());
      if (qjFull.action === 'full' && mergedDir.rooms.some((r) => r.nodeId === 'nodeB')) break;
    }
    assert.ok(mergedDir.rooms.some((r) => r.code === firstA.msg.room && r.nodeId === 'nodeA'), 'nodeA room visible');
    assert.ok(mergedDir.rooms.some((r) => r.code === firstB.msg.room && r.nodeId === 'nodeB'), 'nodeB room merged');
    assert.equal(mergedDir.cluster?.full, true);
    assert.equal(mergedDir.cluster?.totalCapacity, 2);
    assert.equal(qjFull.action, 'full');
    assert.equal(qjFull.clusterFull, true);
  } finally {
    for (const s of sockets) { try { s.close(); } catch {} }
    try { nodeA.child.kill('SIGTERM'); } catch {}
    try { nodeB.child.kill('SIGTERM'); } catch {}
  }
});

test('hot-reloadable cluster-config.json updates node caps, acceptNewRooms, peers, and CDN without restart', { skip: !HAS_MAPS }, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs2-cluster-cfg-'));
  const cfgPath = path.join(tmpDir, 'cluster-config.json');
  const nodeB = await startGateway({
    PORT: '0',
    PERF_HOST: '127.0.0.1',
    PERF_NODE_ID: 'nodeB',
    PERF_NODE_LABEL: '节点二',
    PERF_MAX_HUMANS: '5',
    PERF_MAX_WORKERS: '2',
    PERF_SHARD_MAPS: 'de_dust2:1',
    PERF_RTC_UDP_PORT: '0',
    DUST2_PRIVATE_MAX_ROOMS: '4',
  });
  const writeCfg = (obj) => fs.writeFileSync(cfgPath, JSON.stringify(obj, null, 2));
  writeCfg({
    version: 1,
    cdn: { assetBaseURL: 'https://cdn-a.example.com/assets/', mapBaseURL: 'https://cdn-a.example.com/maps/' },
    nodes: [
      { id: 'nodeA', label: '主节点', origin: 'http://127.0.0.1:1', publicWsOrigin: 'https://a.example.com', enabled: true, acceptNewRooms: true, maxHumans: 10, hardMaxHumans: 10, weight: 1 },
      { id: 'nodeB', label: '备节点', origin: nodeB.origin, publicWsOrigin: nodeB.origin, enabled: true, acceptNewRooms: true, maxHumans: 5, hardMaxHumans: 5, weight: 1 },
    ],
  });
  const nodeA = await startGateway({
    PORT: '0',
    PERF_HOST: '127.0.0.1',
    PERF_NODE_ID: 'nodeA',
    PERF_CLUSTER_CONFIG: cfgPath,
    PERF_MAX_WORKERS: '2',
    PERF_SHARD_MAPS: 'de_dust2:1',
    PERF_RTC_UDP_PORT: '0',
    DUST2_PRIVATE_MAX_ROOMS: '4',
  });
  const sockets = [];
  try {
    // Wait for initial peer poll
    let h1 = null;
    for (let i = 0; i < 15; i++) {
      h1 = await fetch(`${nodeA.origin}/perf/health`).then((r) => r.json());
      if (h1.cluster?.nodes?.some((n) => n.id === 'nodeB' && n.healthy)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(h1.config?.version, 1);
    assert.equal(h1.node.maxHumans, 10);
    assert.equal(h1.node.acceptNewRooms, true);
    const dl1 = await fetch(`${nodeA.origin}/perf/download-config.json`).then((r) => r.json());
    assert.equal(dl1.assetBaseURL, 'https://cdn-a.example.com/assets/');

    // Hot-edit config: put nodeA into drain (acceptNewRooms: false), change CDN to cdn-b, reload WITHOUT restart!
    writeCfg({
      version: 2,
      cdn: { assetBaseURL: 'https://cdn-b.example.com/assets/', mapBaseURL: 'https://cdn-b.example.com/maps/' },
      nodes: [
        { id: 'nodeA', label: '主节点(维护中)', origin: nodeA.origin, publicWsOrigin: nodeA.origin, enabled: true, acceptNewRooms: false, maxHumans: 2, hardMaxHumans: 2, weight: 1 },
        { id: 'nodeB', label: '备节点', origin: nodeB.origin, publicWsOrigin: nodeB.origin, enabled: true, acceptNewRooms: true, maxHumans: 5, hardMaxHumans: 5, weight: 1 },
      ],
    });
    const reloadRes = await fetch(`${nodeA.origin}/perf/internal/reload-config`, { method: 'POST' }).then((r) => r.json());
    assert.equal(reloadRes.ok, true);
    assert.equal(reloadRes.config.version, 2);
    assert.equal(reloadRes.node.acceptNewRooms, false);
    assert.equal(reloadRes.cdn.assetBaseURL, 'https://cdn-b.example.com/assets/');

    // Quick-join & private-map.json MUST now route away from draining nodeA to nodeB!
    const qj = await fetch(`${nodeA.origin}/perf/quick-join.json?mode=defuse&preferredMap=de_dust2`).then((r) => r.json());
    assert.equal(qj.action, 'create');
    assert.equal(qj.nodeId, 'nodeB');

    const mapCfg = await fetch(`${nodeA.origin}/perf/play/de_dust2/private-map.json`).then((r) => r.json());
    assert.equal(mapCfg.nodeId, 'nodeB');
    assert.deepEqual(mapCfg.wsOrigins, [nodeB.origin]);

    // Direct new-room join to draining nodeA must be rejected with NODE_DRAINING.
    const drainReject = await connectAndJoin(`ws://127.0.0.1:${nodeA.port}/perf/play/de_dust2/ws`, mapCfg);
    sockets.push(drainReject.ws);
    assert.equal(drainReject.msg.type, 'error');
    assert.equal(drainReject.msg.code, 'NODE_DRAINING');

    // Public /perf/config.json reflects v2 + new CDN.
    const pubCfg = await fetch(`${nodeA.origin}/perf/config.json`).then((r) => r.json());
    assert.equal(pubCfg.version, 2);
    assert.equal(pubCfg.cdn.assetBaseURL, 'https://cdn-b.example.com/assets/');

    // Corrupt JSON on disk must be safely ignored without crashing or losing v2 state.
    fs.writeFileSync(cfgPath, '{ invalid json');
    const badReload = await fetch(`${nodeA.origin}/perf/internal/reload-config`, { method: 'POST' }).then((r) => r.json());
    assert.equal(badReload.reloaded, false);
    assert.equal(badReload.node.acceptNewRooms, false);
    assert.equal(badReload.cdn.assetBaseURL, 'https://cdn-b.example.com/assets/');
  } finally {
    for (const s of sockets) { try { s.close(); } catch {} }
    try { nodeA.child.kill('SIGTERM'); } catch {}
    try { nodeB.child.kill('SIGTERM'); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('static-runtime fetchGameApi automatically fails over across gameServerOrigins and applies dynamic CDN override', async () => {
  const prevRt = globalThis.__CS2_STATIC_RUNTIME__;
  try {
    globalThis.__CS2_STATIC_RUNTIME__ = {
      gameServerOrigin: 'https://dead-hk.example.com',
      gameServerOrigins: [
        'https://dead-hk.example.com',
        'https://bad-gateway.example.com',
        'https://healthy-node.example.com',
      ],
      assetBaseURL: 'https://old-cdn.example.com/assets/',
      mapBaseURL: 'https://old-cdn.example.com/maps/',
      bundledAssets: [],
      bundledGzAssets: [],
      bundledMaps: [],
    };
    resetGameOriginFailures();
    const attempts = [];
    const fakeFetch = async (url) => {
      attempts.push(url);
      if (url.startsWith('https://dead-hk.example.com')) throw new TypeError('network down');
      if (url.startsWith('https://bad-gateway.example.com')) return new Response('bad gateway', { status: 502 });
      return new Response(JSON.stringify({ ok: true, rooms: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const res1 = await fetchGameApi('/perf/rooms.json', { fetcher: fakeFetch });
    assert.equal(res1.origin, 'https://healthy-node.example.com');
    assert.equal(res1.response.status, 200);
    assert.equal(attempts.length, 3);
    assert.equal(getActiveGameOrigin(), 'https://healthy-node.example.com');

    // Subsequent request should immediately hit the healthy origin first (0 wasted attempts on dead HK!)
    attempts.length = 0;
    const res2 = await fetchGameApi('/perf/health', { fetcher: fakeFetch });
    assert.equal(res2.origin, 'https://healthy-node.example.com');
    assert.deepEqual(attempts, ['https://healthy-node.example.com/perf/health']);

    // Dynamic CDN override updates resolveStaticAsset without changing runtime-config.js
    setDynamicCdnConfig({ assetBaseURL: 'https://new-cdn.example.com/assets/', mapBaseURL: 'https://new-cdn.example.com/maps/' });
    const resolved = resolveStaticAsset('assets/skins/ak47.glb', 'https://toy.example.com/play.html');
    assert.equal(resolved.url.href, 'https://new-cdn.example.com/assets/skins/ak47.glb');
  } finally {
    setDynamicCdnConfig(null);
    resetGameOriginFailures();
    globalThis.__CS2_STATIC_RUNTIME__ = prevRt;
  }
});
