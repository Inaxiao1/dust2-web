import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CP_DIR = path.join(ROOT, 'control-plane');
const MAP_ROOT = path.join(ROOT, 'artifacts/performance-maps/maps-v1');
const CP_PORT = process.env.CP_PORT || '8080';
const GATEWAY_PORT = process.env.GATEWAY_PORT || '3240';
const JOIN_SECRET = process.env.JOIN_TOKEN_SECRET || 'local-dev-join-secret-32-bytes!!';
const WORKER_AUTH = process.env.WORKER_AUTH_TOKEN || 'local-dev-worker-auth-32-bytes!!';
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || `http://127.0.0.1:${GATEWAY_PORT},http://localhost:${GATEWAY_PORT},http://127.0.0.1:5179,http://localhost:5179,https://www.bilibilitoy.com`;

const tmp = mkdtempSync(path.join(tmpdir(), 'cs2-ha-dev-'));
const binPath = path.join(tmp, process.platform === 'win32' ? 'control-plane.exe' : 'control-plane');

console.log('[HA Dev] Building Go Control Plane...');
execFileSync('go', ['build', '-o', binPath, './cmd/control-plane'], { cwd: CP_DIR, stdio: 'inherit' });

const children = [];
let stopping = false;

function cleanup() {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try { child.kill('SIGTERM'); } catch {}
  }
  setTimeout(() => {
    rmSync(tmp, { recursive: true, force: true });
    process.exit(0);
  }, 400);
}
process.once('SIGINT', cleanup);
process.once('SIGTERM', cleanup);

const cp = spawn(binPath, [], {
  cwd: CP_DIR,
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: CP_PORT,
    JOIN_TOKEN_SECRET: JOIN_SECRET,
    WORKER_AUTH_TOKEN: WORKER_AUTH,
    ALLOWED_ORIGINS,
  },
  stdio: 'inherit',
});
children.push(cp);

await new Promise(resolve => setTimeout(resolve, 600));

const hasPerfMaps = existsSync(path.join(MAP_ROOT, 'de_dust2/compiled/map.json'));
const ALL_PERF_MAPS = ['de_dust2', 'de_mirage', 'de_inferno', 'de_nuke', 'de_ancient', 'de_anubis', 'de_cache', 'de_train', 'de_vertigo'];
const requestedMapsEnv = (process.env.HA_MAPS || '').trim();
let workerSpecs;
if (hasPerfMaps) {
  let selectedMaps;
  if (requestedMapsEnv === 'all') {
    selectedMaps = ALL_PERF_MAPS.filter(id => existsSync(path.join(MAP_ROOT, `${id}/compiled/map.json`)));
  } else if (requestedMapsEnv) {
    selectedMaps = requestedMapsEnv.split(',').map(s => s.trim()).filter(id => existsSync(path.join(MAP_ROOT, `${id}/compiled/map.json`)));
  } else {
    selectedMaps = existsSync(path.join(MAP_ROOT, 'de_mirage/compiled/map.json')) ? ['de_dust2', 'de_mirage'] : ['de_dust2', 'de_dust2'];
  }
  if (!selectedMaps.length) selectedMaps = ['de_dust2'];
  const mapCounts = new Map();
  workerSpecs = selectedMaps.map((mapId, idx) => {
    const seq = (mapCounts.get(mapId) || 0) + 1;
    mapCounts.set(mapId, seq);
    return { id: `worker-${mapId.replace(/^de_/, '')}-${seq}`, port: String(3001 + idx), mapId };
  });
} else {
  workerSpecs = [
    { id: 'worker-dust2-1', port: '3001', mapId: null },
    { id: 'worker-dust2-2', port: '3002', mapId: null },
  ];
}

for (const spec of workerSpecs) {
  const entry = spec.mapId ? 'server/private-map-server.js' : 'server/index.js';
  const worker = spawn(process.execPath, [entry], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: spec.port,
      DUST2_LOGIC_ONLY: '1',
      DUST2_SERVE_MAP_FILES: '0',
      DUST2_PRIVATE_MAX_ROOMS: '6',
      DUST2_RECONNECT_GRACE_MS: '30000',
      DUST2_ALLOWED_ORIGINS: ALLOWED_ORIGINS,
      DUST2_CONTROL_PLANE_URL: `http://127.0.0.1:${CP_PORT}`,
      DUST2_WORKER_ID: spec.id,
      DUST2_WORKER_AUTH_TOKEN: WORKER_AUTH,
      DUST2_JOIN_TOKEN_SECRET: JOIN_SECRET,
      DUST2_REQUIRE_JOIN_TOKEN: '1',
      ...(spec.mapId
        ? {
            DUSTII_GRID_VISION: '1',
            DUSTII_PERFORMANCE_DIRECTORY: '1',
            DUSTII_PRIVATE_MAP_ID: spec.mapId,
            DUSTII_PRIVATE_MAP_DIRECTORY: path.join(MAP_ROOT, spec.mapId),
            DUSTII_PRIVATE_LIBRARY_URL: '/perf',
          }
        : {}),
    },
    stdio: 'inherit',
  });
  children.push(worker);
}

if (hasPerfMaps && existsSync(path.join(ROOT, 'dist/private.html'))) {
  const gw = spawn(process.execPath, ['server/performance-maps.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: GATEWAY_PORT,
      PERF_HOST: '127.0.0.1',
      PERF_MAP_ROOT: MAP_ROOT,
      PERF_GAME_DIST: path.join(ROOT, 'dist'),
      PERF_CONTROL_PLANE_URL: `http://127.0.0.1:${CP_PORT}`,
      PERF_WORKER_AUTH_TOKEN: WORKER_AUTH,
    },
    stdio: 'inherit',
  });
  children.push(gw);
}

console.log(`
===========================================================
 随时随地CS HA Local Cluster Ready
 - Go Control Plane : http://127.0.0.1:${CP_PORT}/api/v1/health
 - Map Pools API    : http://127.0.0.1:${CP_PORT}/api/v1/maps
 - CP Metrics       : http://127.0.0.1:${CP_PORT}/metrics
 - Battle Workers   : ${workerSpecs.map(w => `${w.id}(${w.mapId || 'legacy'})->ws://127.0.0.1:${w.port}/ws`).join(', ')}
 - Lobby Frontend   : http://127.0.0.1:${GATEWAY_PORT}/perf/ (Control-Plane Federated)
   Tip: set HA_MAPS=all or HA_MAPS=de_dust2,de_mirage,de_inferno to launch more maps
===========================================================
`);
