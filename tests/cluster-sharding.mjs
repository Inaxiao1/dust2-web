import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { CLIENT_BUILD, RULES_VERSION, ASSET_VERSION } from '../shared/online-build.js';

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
