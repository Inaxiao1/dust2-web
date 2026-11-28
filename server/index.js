import { isMusicKit, roomMusicKits } from '../shared/music-kits.js';
import {snapshotForSide,snapshotForPlayer} from './snapshot-view.js';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { PRIMARY_WEAPONS } from '../shared/weapons.js';
import { normalizeSkinLoadout } from '../shared/skins.js';
import { roomSkinPlan,roomAgentIds } from '../shared/room-cosmetics.js';
import { normalizeAgentLoadout } from '../shared/agents.js';
import {BOT_DIFFICULTIES,normalizeBotDifficulty} from '../shared/bot-difficulty.js';
import { botCount } from '../shared/match-rules.js';
import { initPhysics } from '../shared/physics.js';
import {MAP} from '../shared/map-data.js';
import { GameRoom, TICK_RATE, SNAPSHOT_RATE } from './game.js';
import {CLIENT_BUILD,RULES_VERSION,ASSET_VERSION,compatibilityError} from '../shared/online-build.js';
import {ServerPerformance} from './performance-metrics.js';
import {serverDownloadConfig,sendDownloadConfig} from './download-config.js';
import { verifyJoinToken } from './join-token.js';
import { startControlPlaneReporter } from './control-plane-client.js';
import { decodeInputBinary, encodeSnapshotBinary } from '../shared/binary-protocol.js';
import { encodeDeltaSnapshot } from '../shared/snapshot-delta.js';
import { createPlayerTelemetry } from './player-telemetry.js';
import { createTelemetryStore } from './telemetry-store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.webmanifest': 'application/manifest+json; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
let physicsReady = null;

async function loadPhysics() {
  if (!physicsReady) physicsReady = readFile(path.join(ROOT, 'public/assets/map/collision.json'), 'utf8').then(async source => {
    const { positions } = JSON.parse(source);
    if (!Array.isArray(positions) || positions.length < 9 || positions.length % 9) throw new Error('Invalid Dust2 collision geometry');
    const materials=await readFile(path.join(ROOT,'public/assets/map/penetration-materials.u8'));
    if(materials.length!==positions.length/9)throw new Error('Invalid Dust2 penetration material count');
    return initPhysics(positions,new Uint8Array(materials));
  }).catch(error => { physicsReady = null; throw error; });
  return physicsReady;
}

function send(socket, value) {
  if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount < 1024 * 1024) socket.send(JSON.stringify(value));
}

function error(socket, code, message) { send(socket, { type: 'error', code, message }); }

function parseAllowedOrigins(value) {
  if (!value || value === '*') return value === '*' ? '*' : null;
  const list = Array.isArray(value) ? value : String(value).split(',');
  const origins = new Set();
  for (const item of list) {
    const trimmed = String(item).trim();
    if (!trimmed) continue;
    if (trimmed === '*') return '*';
    origins.add(new URL(trimmed).origin);
  }
  return origins.size ? origins : null;
}

function applyCors(req, res, allowedOrigins) {
  if (!allowedOrigins) return;
  if (allowedOrigins === '*') {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function publicRoomDirectory(rooms, includeNames = false, draining = false) {
  const rows = [];
  for (const room of rooms.values()) {
    if (room.visibility !== 'public') continue;
    if (room.match?.status === 'ended' || room.round?.phase === 'matchEnded') continue;
    const players = [];
    for (const [id, socket] of room.clients) {
      if (socket.readyState === WebSocket.OPEN) players.push(room.players.get(id).name);
    }
    if (!players.length) continue;
    rows.push({
      code: room.code, mode: room.mode, botDifficulty: room.botDifficulty,
      humans: players.length, bots: room.botCount, capacity: room.humanCapacity,
      full: room.humanCount >= room.humanCapacity, joinable: !draining && room.joinable,
      ...(room.locked ? { locked: true } : {}),
      scores: { CT: room.scores.CT, T: room.scores.T }, phase: room.round.phase,
      ...(includeNames ? {players} : {})
    });
  }
  return rows.sort((a,b) => Number(b.joinable)-Number(a.joinable) || b.humans-a.humans || a.code.localeCompare(b.code));
}

function roomAppearance(room){
  const plan=roomSkinPlan(room),agentIds=roomAgentIds(room),musicKitIds=roomMusicKits(room);
  // A fixed-size revision keeps a full ten-player cosmetic list out of the
  // existing 4 KiB join packet. Sorting makes it independent of owner order.
  const signature=JSON.stringify([[...plan.activeSkinIds].sort(),[...plan.carriedSkinIds].sort(),[...plan.skinIds].sort(),agentIds,musicKitIds]);
  const revision=createHash('sha256').update(signature).digest('hex').slice(0,24);
  return {room:room.code,mode:room.mode,...plan,agentIds,musicKitIds,revision};
}

function joinSettings(msg) {
  const incompatible=compatibilityError(msg);if(incompatible)return {error:incompatible};
  // JSON objects can override toString/valueOf; do not coerce protocol fields.
  if (msg.name !== undefined && typeof msg.name !== 'string') return { error: '玩家名称必须是文字。' };
  if (msg.room !== undefined && typeof msg.room !== 'string') return { error: '房间码必须是文字。' };
  if (msg.password !== undefined && typeof msg.password !== 'string') return { error: '房间密码必须是文字。' };
  if (msg.visibility !== undefined && !['public','private'].includes(msg.visibility)) return { error: '无效的房间可见性。' };
  const name = (msg.name || 'Player').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 20) || 'Player';
  const room = (msg.room || '').trim().toUpperCase();
  const password = (msg.password || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24);
  if (room && !/^[A-Z0-9]{4,12}$/.test(room)) return { error: '房间码应为 4–12 位英文字母或数字。' };
  const mode = msg.mode === 'deathmatch' ? 'deathmatch' : 'defuse';
  const team = ['T', 'CT'].includes(msg.team) ? msg.team : 'auto';
  if(msg.bots!==undefined&&(!Number.isInteger(msg.bots)||msg.bots<0||msg.bots>9))return {error:'机器人数量必须为 0–9 的整数。'};
  if(msg.botDifficulty!==undefined&&!BOT_DIFFICULTIES.includes(msg.botDifficulty))return {error:'无效的人机难度。'};
  const bots = botCount(msg.bots),botDifficulty=normalizeBotDifficulty(msg.botDifficulty);
  if(msg.musicKit!==undefined&&!isMusicKit(msg.musicKit))return {error:'无效的音乐盒。'};
  const primary = PRIMARY_WEAPONS.includes(msg.primary) ? msg.primary : 'auto';
  const resumeToken = typeof msg.resumeToken === 'string' && /^[a-f0-9]{16,64}$/i.test(msg.resumeToken.trim()) ? msg.resumeToken.trim() : null;
  const playerUid = typeof msg.playerUid === 'string' && /^[A-Za-z0-9._:@-]{1,128}$/.test(msg.playerUid.trim()) ? msg.playerUid.trim() : null;
  return { name, room, password, mode, team, bots, botDifficulty, primary, musicKit:msg.musicKit, visibility:msg.visibility, weaponLoadout:msg.weaponLoadout,skins:normalizeSkinLoadout(msg.skins),agents:normalizeAgentLoadout(msg.agents),movementProtocol:msg.movementProtocol===1?1:0,shotProtocol:msg.shotProtocol===1?1:0, resumeToken, playerUid };
}

function tokensMatch(expected, actual) {
  if (typeof expected !== 'string' || typeof actual !== 'string') return false;
  const a = Buffer.from(expected), b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Start the authoritative server after loading collision geometry. No external services. */
export async function startGameServer({
  port = Number(process.env.PORT || 3000),
  host = process.env.HOST || '0.0.0.0',
  staticDir = path.join(ROOT, 'dist'),
  rules = {},
  privateMap = null,
  indexFile = 'index.html',
  performanceDirectory = false,
  logicOnly = process.env.DUST2_LOGIC_ONLY === '1',
  serveMapFiles = process.env.DUST2_SERVE_MAP_FILES !== '0',
  allowedOrigins = process.env.DUST2_ALLOWED_ORIGINS || null,
  drainToken = process.env.DUST2_DRAIN_TOKEN || null,
  joinTokenSecret = process.env.DUST2_JOIN_TOKEN_SECRET || null,
  requireJoinToken = process.env.DUST2_REQUIRE_JOIN_TOKEN === '1',
  workerId = process.env.DUST2_WORKER_ID || null,
  controlPlaneUrl = process.env.DUST2_CONTROL_PLANE_URL || null,
  workerAuthToken = process.env.DUST2_WORKER_AUTH_TOKEN || null,
  workerPublicWsUrl = process.env.DUST2_WORKER_WS_URL || null,
  heartbeatIntervalMs = Number(process.env.DUST2_HEARTBEAT_MS) || 3000,
  reconnectGraceMs = Math.max(0, Math.min(120000, Number(process.env.DUST2_RECONNECT_GRACE_MS ?? 30000))),
  matchEndCleanupMs = Math.max(0, Math.min(600000, Number(process.env.DUST2_MATCH_END_CLEANUP_MS ?? 60000))),
} = {}) {
  if(MAP.private&&(!privateMap||privateMap.mapSignature!==MAP.mapSignature))throw Error('A fixed private-map process cannot start a different map server');
  if(!privateMap)await loadPhysics();
  if (requireJoinToken && !joinTokenSecret) {
    throw Error('DUST2_JOIN_TOKEN_SECRET is required when DUST2_REQUIRE_JOIN_TOKEN=1');
  }
  const corsOrigins = parseAllowedOrigins(allowedOrigins);
  const rooms = new Map();
  const usedJTIs = new Map();
  const privateMaxRooms = Math.max(1, Math.min(24, Number(process.env.DUST2_PRIVATE_MAX_ROOMS) || 1));
  const maxRooms = privateMap ? privateMaxRooms : Math.max(1, Math.min(100, Number(process.env.MAX_ROOMS) || 12));
  const maxWsConnections = Math.max(20, Number(process.env.DUST2_MAX_WS_CONNECTIONS) || (maxRooms * 10 + 20));
  const startedAt = Date.now();
  const performanceMetrics=new ServerPerformance();
  const workerMetrics = { joinTokenRejected: 0, wsRateLimited: 0, wsConnectionsRejected: 0, slowClientDrops: 0 };
  const telemetryUrl = (process.env.PERF_TELEMETRY_URL || '').trim();
  const telemetryToken = (process.env.PERF_TELEMETRY_TOKEN || '').trim();
  const localTelemetryStore = (!telemetryUrl && process.env.PERF_TELEMETRY_DIR)
    ? createTelemetryStore({ dir: process.env.PERF_TELEMETRY_DIR })
    : null;
  const telemetryOutbox = [];
  let telemetryFlushing = false;
  let telemetrySessFlush = null;
  async function flushTelemetryOutbox() {
    if (!telemetryUrl || !telemetryToken || !telemetryOutbox.length || telemetryFlushing) return;
    telemetryFlushing = true;
    const batch = telemetryOutbox.splice(0, 64);
    try {
      await fetch(telemetryUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + telemetryToken },
        body: JSON.stringify({ events: batch }),
        signal: AbortSignal.timeout(3000),
      });
    } catch {} finally {
      telemetryFlushing = false;
    }
  }
  const telemetryFlushTimer = telemetryUrl && telemetryToken ? setInterval(() => { void flushTelemetryOutbox(); }, 5000) : null;
  telemetryFlushTimer?.unref?.();
  const telemetry = createPlayerTelemetry({
    mapId: privateMap?.mapId || MAP.id || 'de_dust2',
    hashIp: (ip) => (typeof ip === 'string' && /^[a-f0-9]{12}$/.test(ip) ? ip : (localTelemetryStore ? localTelemetryStore.hashIp(ip) : '')),
    emitEvent: (ev) => {
      if (localTelemetryStore) localTelemetryStore.record(ev);
      else if (telemetryUrl && telemetryToken) {
        if (telemetryOutbox.length < 512) telemetryOutbox.push(ev);
        if (ev.k === 'ac' || telemetryOutbox.length >= 16) void flushTelemetryOutbox();
        else if (ev.k === 'sess' && !telemetrySessFlush) {
          telemetrySessFlush = setTimeout(() => { telemetrySessFlush = null; void flushTelemetryOutbox(); }, 400);
          telemetrySessFlush.unref?.();
        }
      }
    },
  });
  const publicDir = path.join(ROOT, 'public');
  const downloadConfig=serverDownloadConfig();
  let draining = false;
  let reporter = null;
  const beginDrain = () => { draining = true; reporter?.reportNow(); };
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    applyCors(req, res, corsOrigins);
    if(!corsOrigins && req.url?.startsWith('/assets/'))res.setHeader('Access-Control-Allow-Origin','*');
    res.setHeader('Referrer-Policy', 'same-origin');
    if (corsOrigins && req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    let requestPath;
    try { requestPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch { res.writeHead(400); res.end('Bad URL'); return; }
    if (requestPath === '/drain') {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      if (!drainToken) { res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'DRAIN_DISABLED' })); return; }
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!tokensMatch(drainToken, token)) { res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'UNAUTHORIZED' })); return; }
      beginDrain();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, ready: false, draining: true, rooms: rooms.size }));
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    if(requestPath==='/download-config.json'){sendDownloadConfig(req,res,downloadConfig);return;}
    if (performanceDirectory && requestPath === '/room-directory.json') {
      res.writeHead(200, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(publicRoomDirectory(rooms, true, draining)));
      return;
    }
    if (performanceDirectory && requestPath === '/internal-rooms.json') {
      res.writeHead(200, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
      if (req.method === 'HEAD') { res.end(); return; }
      let humans = 0, bots = 0;
      const codes = [];
      for (const [code, room] of rooms) {
        codes.push(code);
        humans += room.humanCount;
        bots += room.botCount;
      }
      res.end(JSON.stringify({
        rooms: codes,
        totalRooms: rooms.size,
        maxRooms,
        humans,
        bots,
        tickP95Ms: performanceMetrics.snapshot().tickP95Ms,
        net: telemetry.liveNetworkSnapshot(),
      }));
      return;
    }
    if((serveMapFiles || requestPath === '/private-map.json') && privateMap?.handleRequest(req,res,requestPath))return;
    if (requestPath === '/ready') {
      const ready = !draining;
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ ok: true, ready, draining, logicOnly, serveMapFiles, rooms: rooms.size, humans: [...rooms.values()].reduce((n, r) => n + r.humanCount, 0) }));
      return;
    }
    if (requestPath === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      const memory = process.memoryUsage();
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ ok: true, ready: !draining, draining, logicOnly, serveMapFiles, service: privateMap?'dust2-private-game':'dust2-web',...(privateMap?{mapId:privateMap.mapId,mapSignature:privateMap.mapSignature,physicsSha256:privateMap.config.physicsSha256}:{}), release: process.env.DUST2_RELEASE || 'local', protocol: 1, tickRate: TICK_RATE, uptime: Math.round((Date.now() - startedAt) / 1000), rooms: rooms.size, humans: [...rooms.values()].reduce((n, r) => n + r.humanCount, 0), players: [...rooms.values()].reduce((n, r) => n + r.players.size, 0), memory: { rssMiB: Math.round(memory.rss / 1048576), heapMiB: Math.round(memory.heapUsed / 1048576) },performance:performanceMetrics.snapshot() })); return;
    }
    if (requestPath === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' });
      if (req.method === 'HEAD') { res.end(); return; }
      const mem = process.memoryUsage();
      const perf = performanceMetrics.snapshot();
      let humans = 0, players = 0;
      for (const r of rooms.values()) { humans += r.humanCount; players += r.players.size; }
      let binClients = 0, deltaClients = 0, fullClients = 0;
      for (const s of wss.clients) {
        if (!s.playerId) continue;
        if (s.binaryProtocol === 2) binClients++;
        else if (s.snapshotDelta === 1) deltaClients++;
        else fullClients++;
      }
      const mapLabel = (privateMap?.mapId || MAP.id || 'de_dust2').replace(/[^a-zA-Z0-9_]/g, '');
      const uptimeSec = ((Date.now() - startedAt) / 1000).toFixed(1);
      res.end([
        '# HELP cs2_worker_up Battle worker process availability.',
        '# TYPE cs2_worker_up gauge',
        `cs2_worker_up{map_id="${mapLabel}"} 1`,
        '# HELP cs2_worker_ready Whether worker accepts new rooms and joins.',
        '# TYPE cs2_worker_ready gauge',
        `cs2_worker_ready{map_id="${mapLabel}"} ${draining ? 0 : 1}`,
        '# HELP cs2_worker_draining Whether worker is draining.',
        '# TYPE cs2_worker_draining gauge',
        `cs2_worker_draining{map_id="${mapLabel}"} ${draining ? 1 : 0}`,
        '# HELP cs2_worker_uptime_seconds Worker uptime in seconds.',
        '# TYPE cs2_worker_uptime_seconds gauge',
        `cs2_worker_uptime_seconds{map_id="${mapLabel}"} ${uptimeSec}`,
        '# HELP cs2_worker_rooms Active rooms on this worker.',
        '# TYPE cs2_worker_rooms gauge',
        `cs2_worker_rooms{map_id="${mapLabel}"} ${rooms.size}`,
        '# HELP cs2_worker_humans Active human players on this worker.',
        '# TYPE cs2_worker_humans gauge',
        `cs2_worker_humans{map_id="${mapLabel}"} ${humans}`,
        '# HELP cs2_worker_players Active total players (humans + bots) on this worker.',
        '# TYPE cs2_worker_players gauge',
        `cs2_worker_players{map_id="${mapLabel}"} ${players}`,
        '# HELP cs2_worker_ws_connections Open WebSocket connections on this worker.',
        '# TYPE cs2_worker_ws_connections gauge',
        `cs2_worker_ws_connections{map_id="${mapLabel}"} ${wss.clients.size}`,
        '# HELP cs2_worker_clients_by_protocol Joined clients grouped by wire protocol.',
        '# TYPE cs2_worker_clients_by_protocol gauge',
        `cs2_worker_clients_by_protocol{map_id="${mapLabel}",protocol="binary_v2"} ${binClients}`,
        `cs2_worker_clients_by_protocol{map_id="${mapLabel}",protocol="json_delta"} ${deltaClients}`,
        `cs2_worker_clients_by_protocol{map_id="${mapLabel}",protocol="json_full"} ${fullClients}`,
        '# HELP cs2_worker_tick_ms Server simulation tick duration percentiles in ms.',
        '# TYPE cs2_worker_tick_ms gauge',
        `cs2_worker_tick_ms{map_id="${mapLabel}",quantile="0.5"} ${perf.tickP50Ms}`,
        `cs2_worker_tick_ms{map_id="${mapLabel}",quantile="0.95"} ${perf.tickP95Ms}`,
        `cs2_worker_tick_ms{map_id="${mapLabel}",quantile="0.99"} ${perf.tickP99Ms}`,
        `cs2_worker_tick_ms{map_id="${mapLabel}",quantile="max"} ${perf.tickMaxMs}`,
        '# HELP cs2_worker_late_ticks_total Simulation ticks exceeding 33.33ms budget.',
        '# TYPE cs2_worker_late_ticks_total counter',
        `cs2_worker_late_ticks_total{map_id="${mapLabel}"} ${perf.lateTicks}`,
        '# HELP cs2_worker_join_token_rejected_total Join attempts rejected due to missing, invalid, or replayed token.',
        '# TYPE cs2_worker_join_token_rejected_total counter',
        `cs2_worker_join_token_rejected_total{map_id="${mapLabel}"} ${workerMetrics.joinTokenRejected}`,
        '# HELP cs2_worker_ws_rate_limited_total Connections closed for message flood.',
        '# TYPE cs2_worker_ws_rate_limited_total counter',
        `cs2_worker_ws_rate_limited_total{map_id="${mapLabel}"} ${workerMetrics.wsRateLimited}`,
        '# HELP cs2_worker_ws_rejected_total Connections rejected at capacity.',
        '# TYPE cs2_worker_ws_rejected_total counter',
        `cs2_worker_ws_rejected_total{map_id="${mapLabel}"} ${workerMetrics.wsConnectionsRejected}`,
        '# HELP cs2_worker_slow_client_drops_total Clients disconnected for excessive send backpressure.',
        '# TYPE cs2_worker_slow_client_drops_total counter',
        `cs2_worker_slow_client_drops_total{map_id="${mapLabel}"} ${workerMetrics.slowClientDrops}`,
        '# HELP cs2_worker_process_rss_bytes Worker resident set size in bytes.',
        '# TYPE cs2_worker_process_rss_bytes gauge',
        `cs2_worker_process_rss_bytes{map_id="${mapLabel}"} ${mem.rss}`,
        '# HELP cs2_worker_process_heap_used_bytes Worker V8 heap used in bytes.',
        '# TYPE cs2_worker_process_heap_used_bytes gauge',
        `cs2_worker_process_heap_used_bytes{map_id="${mapLabel}"} ${mem.heapUsed}`,
        '',
      ].join('\n'));
      return;
    }
    if (logicOnly) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ ok: false, error: 'STATIC_DISABLED_LOGIC_ONLY', message: 'Static assets and client files are disabled in logic-only mode.' }));
      return;
    }
    if (requestPath.includes('\0') || requestPath.includes('\\')) { res.writeHead(400); res.end('Bad path'); return; }
    let found = null, info = null;
    for (const directory of [staticDir, publicDir]) {
      const base = path.resolve(directory), candidate = path.resolve(base, `.${requestPath === '/' ? '/'+indexFile : requestPath}`);
      if (!candidate.startsWith(base + path.sep)) continue;
      try { const candidateInfo = await stat(candidate); if (candidateInfo.isFile()) { found = candidate; info = candidateInfo; break; } } catch { /* Try the next permitted static root. */ }
    }
    if (!found && !path.extname(requestPath) && !requestPath.startsWith('/assets')) {
      const index = path.join(staticDir, indexFile);
      try { const candidateInfo = await stat(index); if (candidateInfo.isFile()) { found = index; info = candidateInfo; } } catch { /* The frontend has not been built yet. */ }
    }
    if (!found) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('文件不存在。请先运行 npm run build，然后打开游戏首页。'); return; }
    // Reuse the lookup's metadata and serve precompressed .br/.gz sidecars when accepted (zero runtime CPU cost).
    const acceptEncoding = String(req.headers['accept-encoding'] || '');
    const accepts = name => acceptEncoding.split(',').some(v => {
      const [coding, weight] = v.trim().toLowerCase().split(/\s*;\s*/);
      return coding === name && (weight === undefined || (/^q=(?:1(?:\.0{0,3})?|0\.\d{1,3})$/.test(weight) && Number(weight.slice(2)) > 0));
    });
    let servePath = found, serveInfo = info, encoding = null;
    if (accepts('br')) {
      try { const s = await stat(found + '.br'); if (s.isFile()) { servePath = found + '.br'; serveInfo = s; encoding = 'br'; } } catch {}
    }
    if (!encoding && accepts('gzip')) {
      try { const s = await stat(found + '.gz'); if (s.isFile()) { servePath = found + '.gz'; serveInfo = s; encoding = 'gzip'; } } catch {}
    }
    const headers = {
      'Content-Type': TYPES[path.extname(found).toLowerCase()] || 'application/octet-stream',
      'Content-Length': serveInfo.size,
      'Cache-Control': path.extname(found) === '.html' ? 'no-cache' : 'public, max-age=3600',
      'Vary': 'Accept-Encoding',
    };
    if (encoding) headers['Content-Encoding'] = encoding;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') res.end(); else { const stream = createReadStream(servePath); stream.on('error', () => res.destroy()); stream.pipe(res); }
  });
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: 4096,
    verifyClient: corsOrigins instanceof Set
      ? ({ origin }, callback) => callback(!origin || corsOrigins.has(origin), 403, 'Origin not allowed')
      : undefined,
    perMessageDeflate: {serverNoContextTakeover:true,clientNoContextTakeover:true,threshold:1024,concurrencyLimit:8,zlibDeflateOptions:{level:1,memLevel:7}}
  });
  wss.on('connection', (socket, req) => {
    // Disable Nagle's algorithm so 30Hz snapshots and ping/pong frames flush immediately with minimal jitter.
    try { req?.socket?.setNoDelay?.(true); socket?._socket?.setNoDelay?.(true); } catch {}
    // Rejected connections can still receive invalid frames while closing.
    socket.on('error', () => {});
    if (wss.clients.size > maxWsConnections) { workerMetrics.wsConnectionsRejected++; socket.close(1013, 'Server busy'); return; }
    socket.isAlive = true; socket.playerId = null; socket.roomCode = null; socket.binaryProtocol = 0; socket.lastBinaryPlayers = null;
    socket.snapshotDelta = 0; socket.lastDeltaSnap = null; socket.reconnectOptIn = false; socket.resumeToken = null;
    socket.ackDelta = 0; socket.nextSnapSid = 0; socket.clientAckSid = 0; socket.sentSnaps = null; socket.lastFullResyncAt = 0;
    socket.gatewayBufferedBytes = 0; socket.lastSnapshotSentAt = 0; socket.pendingEvents = []; socket.lastClientRtt = 0; socket.legacySkipToggle = false;
    socket.transport = req?.headers?.['x-cs2-transport'] === 'udp' ? 'udp' : 'ws';
    socket.fromGateway = req?.headers?.['x-cs2-gateway'] === '1';
    socket.ipHash = typeof req?.headers?.['x-cs2-client-ip-hash'] === 'string'
      ? req.headers['x-cs2-client-ip-hash'].slice(0, 16)
      : String(req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || '');
    socket.pingSentAt = 0;
    try { socket.handshakeToken = req?.url ? new URL(req.url, 'http://localhost').searchParams.get('token') : null; }
    catch { socket.handshakeToken = null; }
    socket.tokens = 150; socket.tokensAt = Date.now(); socket.strikes = 0; socket.connectedAt = Date.now(); socket.buyAt = 0;
    socket.on('pong', () => {
      socket.isAlive = true;
      if (!socket.fromGateway && socket.pingSentAt > 0 && socket.playerId) {
        telemetry.recordServerRtt(socket.playerId, performance.now() - socket.pingSentAt);
        socket.pingSentAt = 0;
      }
    });
    socket.on('message', (data, binary) => {
      const now = Date.now();
      socket.tokens = Math.min(150, socket.tokens + (now - socket.tokensAt) * 0.09); socket.tokensAt = now;
      if (socket.tokens < 1) { workerMetrics.wsRateLimited++; error(socket, 'RATE_LIMIT', '请求过于频繁。'); socket.close(1008, 'Rate limit'); return; }
      socket.tokens--;
      let msg;
      try {
        if (binary) {
          if (socket.binaryProtocol !== 2) throw new Error('binary');
          msg = decodeInputBinary(data);
          if (!msg) throw new Error('bad binary frame');
        } else {
          msg = JSON.parse(data.toString());
          if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw new Error('object');
        }
      }
      catch { error(socket, 'BAD_MESSAGE', '消息格式无效。'); if (++socket.strikes > 5) socket.close(1008, 'Bad messages'); return; }
      if (socket.fromGateway && msg.type === '_bp') {
        socket.tokens = Math.min(150, socket.tokens + 1);
        socket.gatewayBufferedBytes = Math.max(0, Number(msg.b) || 0);
        return;
      }
      const applyClientAck = (ackSid) => {
        if (!socket.ackDelta || !socket.sentSnaps || !Number.isInteger(ackSid)) return;
        if (ackSid === 0) {
          socket.clientAckSid = 0;
          return;
        }
        if (ackSid > socket.clientAckSid && socket.sentSnaps.has(ackSid)) {
          socket.clientAckSid = ackSid;
          for (const oldSid of socket.sentSnaps.keys()) {
            if (oldSid < ackSid) socket.sentSnaps.delete(oldSid);
            else break;
          }
        }
      };
      if (msg.type === 'snapAck') {
        socket.tokens = Math.min(150, socket.tokens + 0.5);
        applyClientAck(msg.ackSid);
        return;
      }
      if (msg.type === 'ping') {
        applyClientAck(msg.ackSid);
        const reportedRtt = Number(msg.rtt);
        if (Number.isFinite(reportedRtt) && reportedRtt >= 1 && reportedRtt <= 5000) socket.lastClientRtt = reportedRtt;
        if (socket.playerId) telemetry.recordClientPing(socket.playerId, { rtt: reportedRtt, fps: Number(msg.fps), tr: msg.tr });
        send(socket, { type: 'pong', time: typeof msg.time === 'number' ? msg.time : null, serverTime: now });
        return;
      }
      if(msg.type==='listRooms'){
        if(now-(socket.listRoomsAt||0)<1000)return;
        socket.listRoomsAt=now;
        send(socket,{type:'rooms',...(privateMap?{mapId:privateMap.mapId,mapSignature:privateMap.mapSignature,physicsSha256:privateMap.config.physicsSha256}:{}),rooms:publicRoomDirectory(rooms,false,draining)});return;
      }
      if (msg.type === 'roomCosmetics') {
        if (socket.playerId || now - (socket.cosmeticsAt || 0) < 1000) return;
        socket.cosmeticsAt = now;
        const code = typeof msg.room === 'string' ? msg.room.trim().toUpperCase() : '';
        const room = rooms.get(code);
        if (!room) { error(socket,'ROOM_GONE','房间已经关闭，请在大厅重新选择。'); return; }
        if (draining || !room.joinable) {
          error(socket, draining ? 'SERVER_DRAINING' : 'ROOM_UNAVAILABLE', draining ? '服务器正在下线维护，请从大厅选择其他节点。' : '房间已满或对局已结束，请在大厅重新选择。'); return;
        }
        send(socket,{type:'roomCosmetics',...roomAppearance(room)});
        return;
      }
      if (msg.type === 'join') {
        if (socket.playerId) { error(socket, 'ALREADY_JOINED', '当前连接已经加入房间。'); return; }
        if (draining) { error(socket, 'SERVER_DRAINING', '服务器正在下线维护，请从大厅进入其他可用节点。'); return; }
        if(privateMap&&(msg.mapId!==privateMap.mapId||msg.mapSignature!==privateMap.mapSignature)){error(socket,'MAP_MISMATCH','地图或碰撞版本不匹配，请重新载入当前地图。');return;}
        const suppliedToken = typeof msg.joinToken === 'string' && msg.joinToken ? msg.joinToken : socket.handshakeToken;
        let tokenClaims = null;
        if (requireJoinToken && !suppliedToken) {
          workerMetrics.joinTokenRejected++;
          error(socket, 'JOIN_TOKEN_REQUIRED', '请先通过大厅获取有效加入凭证。');
          return;
        }
        if (suppliedToken && (joinTokenSecret || requireJoinToken)) {
          const verified = verifyJoinToken(suppliedToken, joinTokenSecret, {
            expectedWorkerId: workerId,
            expectedMapId: privateMap?.mapId || null,
          });
          if (!verified.ok) { workerMetrics.joinTokenRejected++; error(socket, verified.code, verified.message); return; }
          tokenClaims = verified.claims;
          if (tokenClaims.jti && usedJTIs.has(tokenClaims.jti)) {
            workerMetrics.joinTokenRejected++;
            error(socket, 'JOIN_TOKEN_REPLAYED', '加入凭证已使用，请重新获取。');
            return;
          }
          const requestedRoom = typeof msg.room === 'string' ? msg.room.trim().toUpperCase() : '';
          if (requestedRoom && tokenClaims.roomCode && requestedRoom !== tokenClaims.roomCode) {
            workerMetrics.joinTokenRejected++;
            error(socket, 'TOKEN_ROOM_MISMATCH', '加入凭证与请求的房间不匹配。');
            return;
          }
        }
        const effectiveMsg = tokenClaims
          ? {
              ...msg,
              room: tokenClaims.roomCode || msg.room,
              mode: tokenClaims.mode || msg.mode,
              visibility: tokenClaims.visibility || msg.visibility,
              name: tokenClaims.playerName || msg.name,
              playerUid: tokenClaims.playerUid || msg.playerUid,
              existing: tokenClaims.action === 'join' ? true : msg.existing,
            }
          : msg;
        const settings = joinSettings(effectiveMsg);
        if (settings.error) { error(socket, 'BAD_JOIN', settings.error); return; }
        if (!settings.room) { do { settings.room = randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(settings.room)); }
        let room = rooms.get(settings.room), created = false;
        if(effectiveMsg.existing===true&&!room){error(socket,'ROOM_GONE','房间已经关闭，请在大厅选择有玩家的房间。');return;}
        if (room && effectiveMsg.existing === true && !room.joinable) {
          error(socket,'ROOM_UNAVAILABLE','房间已满或对局已结束，请在大厅重新选择。'); return;
        }
        if (room && room.locked && !room.hasValidResumeToken(settings.resumeToken, settings.playerUid)) {
          if (!settings.password) {
            error(socket, 'PASSWORD_REQUIRED', '该房间已设置密码，请输入房间密码后加入。');
            return;
          }
          if (!tokensMatch(room.password, settings.password)) {
            error(socket, 'WRONG_PASSWORD', '房间密码错误，请核对后重试。');
            return;
          }
        }
        const skipLegacyUdpCosmeticsBounce = socket.transport === 'udp' && effectiveMsg.rtcAsyncClose !== 1;
        if(room && effectiveMsg.existing===true && typeof effectiveMsg.appearanceRevision==='string' && !skipLegacyUdpCosmeticsBounce){
          const appearance=roomAppearance(room);
          if(appearance.revision!==effectiveMsg.appearanceRevision){
            send(socket,{type:'roomCosmeticsChanged',...appearance});
            return;
          }
        }
        if (!room) {
          if (rooms.size >= maxRooms) { error(socket, 'SERVER_FULL', '服务器当前房间数量已达上限。'); return; }
          room = new GameRoom(settings.room, { mode: settings.mode, bots: settings.bots, botDifficulty:settings.botDifficulty, visibility:settings.visibility, password:settings.password, rules, privateMap });
          room.onShotRejected = (pid, reason) => telemetry.recordShotRejected(pid, reason);
          rooms.set(settings.room, room); created = true;
        }
        try {
          const player = room.addHuman(socket, settings); socket.playerId = player.id; socket.roomCode = room.code;
          socket.binaryProtocol = msg.binaryProtocol === 2 ? 2 : 0;
          socket.snapshotDelta = socket.binaryProtocol === 0 && msg.snapshotDelta === 1 ? 1 : 0;
          socket.ackDelta = socket.snapshotDelta === 1 && msg.ackDelta === 1 ? 1 : 0;
          socket.nextSnapSid = 0;
          socket.clientAckSid = 0;
          socket.sentSnaps = socket.ackDelta ? new Map() : null;
          socket.lastFullResyncAt = 0;
          socket.reconnectOptIn = msg.reconnect === true;
          socket.resumeToken = player.resumeToken;
          telemetry.startSession({
            playerId: player.id,
            uid: player.playerUid,
            ip: socket.ipHash,
            name: player.name,
            room: room.code,
            mode: room.mode,
            transport: socket.transport,
          });
          if (tokenClaims?.jti) usedJTIs.set(tokenClaims.jti, tokenClaims.exp);
          reporter?.reportNow();
          send(socket, { type: 'welcome', ...(privateMap?{mapId:privateMap.mapId,mapSignature:privateMap.mapSignature,physicsSha256:privateMap.config.physicsSha256}:{}),clientBuild:CLIENT_BUILD,rulesVersion:RULES_VERSION,assetVersion:ASSET_VERSION,id: player.id, room: room.code, locked: room.locked, mode: room.mode, team: player.team,teamId:player.teamId,hostId:room.hostId,desiredBots:room.desiredBots,botCount:room.botCount,botDifficulty:room.botDifficulty,match:room.matchSnapshot(), tickRate: TICK_RATE, snapshotRate: SNAPSHOT_RATE, serverTime: now, protocol: 1, binaryProtocol: socket.binaryProtocol, snapshotDelta: socket.snapshotDelta, resumeToken: player.resumeToken, resumed: player.resumed === true, reconnectGraceMs, movementProtocol:1,shotProtocol:1 });
          const initialSnap = snapshotForSide(room.snapshot({ drainEvents: false }), player.team);
          if (socket.binaryProtocol === 2) {
            socket.lastBinaryPlayers = new Map(initialSnap.players.map(p => [p.id, { ...p }]));
            if (socket.readyState === WebSocket.OPEN) socket.send(encodeSnapshotBinary(initialSnap, null), { compress: false });
          } else if (socket.ackDelta === 1) {
            const playerSnap = snapshotForPlayer(initialSnap, player.id);
            const stateSnap = playerSnap.events?.length ? { ...playerSnap, events: [] } : playerSnap;
            socket.nextSnapSid = 1;
            socket.clientAckSid = 0;
            socket.sentSnaps.set(1, stateSnap);
            socket.lastFullResyncAt = now;
            send(socket, { ...playerSnap, sid: 1 });
          } else if (socket.snapshotDelta === 1) {
            const playerSnap = snapshotForPlayer(initialSnap, player.id);
            socket.lastDeltaSnap = playerSnap;
            send(socket, playerSnap);
          } else {
            send(socket, initialSnap);
          }
        } catch (e) { if (created) rooms.delete(room.code); error(socket, 'JOIN_FAILED', e.message); }
        return;
      }
      const room = rooms.get(socket.roomCode);
      if (!room || !socket.playerId) { error(socket, 'NOT_JOINED', '请先加入一个房间。'); return; }
      if(msg.type==='chat'){const result=room.chat(socket.playerId,msg.text,msg.channel);if(!result.ok)error(socket,'CHAT_REJECTED',result.message);}
      else if(msg.type==='requestWeapon'||msg.type==='donateWeapon'){const result=msg.type==='requestWeapon'?room.requestWeapon(socket.playerId,msg.weapon):room.donateWeapon(socket.playerId,msg.playerId,msg.weapon);if(!result.ok)error(socket,'TEAM_GEAR_REJECTED',result.message);else send(socket,{type:'teamGear',...result});}
      else if (msg.type === 'input') {
        if (msg.ackSid !== undefined) applyClientAck(msg.ackSid);
        const inputOk = room.receiveInput(socket.playerId, msg, { allowUnordered: socket.ackDelta === 1 && socket.transport === 'udp' });
        telemetry.recordInput(socket.playerId, msg, inputOk, Boolean(room.players.get(socket.playerId)?.alive));
        if (!inputOk) { if (++socket.strikes > 100) socket.close(1008, 'Invalid input'); }
      } else if(msg.type==='takeBot'){
        if(now-(socket.takeBotAt||0)<300)return;
        socket.takeBotAt=now;const result=room.takeBot(socket.playerId,typeof msg.botId==='string'?msg.botId:null);
        if(!result.ok)error(socket,'BOT_CONTROL_REJECTED',result.message);else send(socket,{type:'botControl',...result});
      } else if(msg.type==='takeSeat'||msg.type==='setSeatBot'){
        if(now-(socket.seatAt||0)<300){error(socket,'SEAT_RATE','请稍后再操作席位。');return;}
        socket.seatAt=now;const result=msg.type==='takeSeat'?room.takeSeat(socket.playerId,msg.team,msg.seat):room.setSeatBot(socket.playerId,msg.team,msg.seat,msg.enabled);
        if(!result.ok)error(socket,'SEAT_REJECTED',result.message);else send(socket,{type:'seatUpdated',...result});
      } else if(msg.type==='setWeaponLoadout'){
        if(now-(socket.setLoadoutAt||0)<500){error(socket,'LOADOUT_RATE','设置过于频繁，请稍后重试。');return;}
        socket.setLoadoutAt=now;const result=room.setWeaponLoadout(socket.playerId,msg.weaponLoadout);
        if(!result.ok)error(socket,'LOADOUT_REJECTED',result.message);else send(socket,{type:'weaponLoadoutUpdated',...result});
      } else if(msg.type==='setBotDifficulty'){
        if(now-(socket.setDifficultyAt||0)<250){error(socket,'BOT_DIFFICULTY_RATE','设置过于频繁，请稍后重试。');return;}
        socket.setDifficultyAt=now;const result=room.setBotDifficulty(socket.playerId,msg.botDifficulty);
        if(!result.ok)error(socket,'BOT_DIFFICULTY_REJECTED',result.message);else send(socket,{type:'botDifficultyUpdated',...result});
      } else if(msg.type==='setBots'){
        if(now-(socket.setBotsAt||0)<250){error(socket,'BOTS_RATE','设置过于频繁，请稍后重试。');return;}
        socket.setBotsAt=now;const result=room.setBots(socket.playerId,msg.bots);
        if(!result.ok)error(socket,'BOTS_REJECTED',result.message);else send(socket,{type:'botsUpdated',...result});
      } else if(msg.type==='dropWeapon'){
        if(now-(socket.dropWeaponAt||0)<250){error(socket,'DROP_RATE','丢弃过于频繁，请稍后重试。');return;}
        socket.dropWeaponAt=now;const result=room.dropWeapon(socket.playerId);
        if(!result.ok)error(socket,'DROP_REJECTED',result.message);else send(socket,{type:'weaponDropped',...result});
      } else if(msg.type==='equipSkin'){
        if(now-(socket.equipSkinAt||0)<250){error(socket,'SKIN_RATE','更换过于频繁，请稍后重试。');return;}
        socket.equipSkinAt=now;const result=room.equipSkin(socket.playerId,msg.weapon,msg.skin);
        if(!result.ok)error(socket,'SKIN_REJECTED',result.message);else send(socket,{type:'skinEquipped',...result});
      } else if(msg.type==='equipMusic'){
        const player=room.players.get(socket.playerId);
        if(!player||!isMusicKit(msg.kit)){error(socket,'MUSIC_REJECTED','无效的音乐盒。');return;}
        if(player.musicKit!==msg.kit){
          player.musicKit=msg.kit;
          room.emit('music_equipped',{playerId:player.id,musicKit:player.musicKit});
        }
      } else if(msg.type==='equipAgent'){
        if(now-(socket.equipAgentAt||0)<250){error(socket,'AGENT_RATE','更换过于频繁，请稍后重试。');return;}
        socket.equipAgentAt=now;const result=room.equipAgent(socket.playerId,msg.agent);
        if(!result.ok)error(socket,'AGENT_REJECTED',result.message);else send(socket,{type:'agentEquipped',...result});
      } else if(msg.type==='refund'){
        if(now-socket.buyAt<250){error(socket,'BUY_RATE','请稍后再退还。');return;}
        socket.buyAt=now;const result=room.refund(socket.playerId,msg.weapon);
        if(!result.ok)error(socket,'BUY_REJECTED',result.message);else send(socket,{type:'refund',...result});
      } else if (msg.type === 'buy') {
        if (now - socket.buyAt < 250) { error(socket, 'BUY_RATE', '购买操作过于频繁。'); return; }
        socket.buyAt = now;
        const result = room.buy(socket.playerId, msg.weapon);
        if (!result.ok) error(socket, 'BUY_REJECTED', result.message); else send(socket, { type: 'purchase', ...result });
      } else error(socket, 'UNKNOWN_MESSAGE', '不支持的消息类型。');
    });
    socket.on('close', (code) => {
      if (socket.playerId) telemetry.finishSession(socket.playerId, code === 1000 ? 'normal' : `code_${code}`);
      const room = rooms.get(socket.roomCode); if (!room) return;
      const matchEnded = room.match?.status === 'ended' || room.round?.phase === 'matchEnded';
      const abnormalDrop = !matchEnded && socket.reconnectOptIn && code !== 1000 && reconnectGraceMs > 0;
      if (!matchEnded && reconnectGraceMs > 0 && (room.humanCount > 1 || abnormalDrop)) {
        room.saveReconnectSession(socket.playerId, reconnectGraceMs);
      }
      room.removePlayer(socket.playerId);
      if (!room.humanCount) {
        if (abnormalDrop) {
          room.emptyExpiresAt = Date.now() + reconnectGraceMs;
        } else {
          rooms.delete(room.code);
        }
      } else {
        room.ensureBots();
        room.maybeStart();
      }
      reporter?.reportNow();
    });
  });
  let tickNumber = 0,lastTickAt=performance.now();
  const tickTimer = setInterval(() => {
    const tickStarted=performance.now(),delay=Math.max(0,tickStarted-lastTickAt-1000/TICK_RATE);lastTickAt=tickStarted;
    tickNumber++;
    const nowWall = Date.now();
    for (const [code, room] of rooms) {
      if (!room.humanCount && room.emptyExpiresAt) {
        if (nowWall >= room.emptyExpiresAt) {
          rooms.delete(code);
          reporter?.reportNow();
        }
        continue;
      }
      try {
        room.tick(1 / TICK_RATE);
        if (tickNumber % TICK_RATE === 0) {
          for (const pid of room.clients.keys()) telemetry.samplePlayerSpeed(room.players.get(pid));
        }
        if (tickNumber % (TICK_RATE / SNAPSHOT_RATE) === 0) {
          const snapshot = room.snapshot(), sideSnaps = new Map(), jsonViews = new Map(), deltaViews = new Map();
          telemetry.observeRoomEvents(room, snapshot.events);
          for (const socket of room.clients.values()) {
            if (socket.readyState === WebSocket.OPEN) {
              const effectiveBuffered = Math.max(socket.bufferedAmount || 0, socket.gatewayBufferedBytes || 0);
              if (socket.bufferedAmount > 1024 * 1024) { workerMetrics.slowClientDrops++; socket.close(1008, 'Client too slow'); continue; }
              const side = room.players.get(socket.playerId)?.team;
              if (!sideSnaps.has(side)) sideSnaps.set(side, snapshotForSide(snapshot, side));
              const sideSnap = sideSnaps.get(side);
              // Lossless backpressure coalescing:
              // 1) When client transport queue exceeds 24 KB, skip intermediate movement ticks while preserving events.
              // 2) For legacy single-channel ordered UDP clients experiencing SCTP queue buildup (reported RTT > 350ms),
              //    pace down to 7.5 Hz until the ordered stream drains back below 350ms.
              const legacyUdpBacklogged = socket.transport === 'udp' && !socket.ackDelta && socket.lastClientRtt > 350;
              if (legacyUdpBacklogged) socket.legacySkipToggle = !socket.legacySkipToggle;
              else socket.legacySkipToggle = false;
              const shouldCoalesce = (effectiveBuffered > 24576 && (nowWall - socket.lastSnapshotSentAt) < 250)
                || (legacyUdpBacklogged && socket.legacySkipToggle && !(sideSnap.events?.length));
              if (!socket.ackDelta && socket.snapshotDelta === 1 && socket.lastDeltaSnap && socket.binaryProtocol !== 2 && shouldCoalesce) {
                if (sideSnap.events?.length && socket.pendingEvents.length < 128) {
                  for (const ev of sideSnap.events) socket.pendingEvents.push(ev);
                }
                continue;
              }
              if (socket.binaryProtocol === 2) {
                const frame = encodeSnapshotBinary(sideSnap, socket.lastBinaryPlayers);
                socket.lastBinaryPlayers = new Map(sideSnap.players.map(p => [p.id, { ...p }]));
                socket.send(frame, { compress: false });
              } else if (socket.ackDelta === 1) {
                const playerSnap = snapshotForPlayer(sideSnap, socket.playerId);
                if (playerSnap.events?.length) {
                  // Gameplay events always travel on the reliable ordered channel for 100% delivery.
                  socket.send(JSON.stringify({ type: 'events', events: playerSnap.events }));
                }
                const stateSnap = playerSnap.events?.length ? { ...playerSnap, events: [] } : playerSnap;
                const sid = ++socket.nextSnapSid;
                socket.sentSnaps.set(sid, stateSnap);
                while (socket.sentSnaps.size > 30) {
                  const oldest = socket.sentSnaps.keys().next().value;
                  if (oldest === socket.clientAckSid && socket.sentSnaps.size > 1) {
                    const iter = socket.sentSnaps.keys();
                    iter.next();
                    socket.sentSnaps.delete(iter.next().value);
                  } else {
                    socket.sentSnaps.delete(oldest);
                  }
                }
                const baseSnap = socket.clientAckSid > 0 ? socket.sentSnaps.get(socket.clientAckSid) : null;
                if (baseSnap) {
                  const delta = encodeDeltaSnapshot(stateSnap, baseSnap);
                  // Keep "type":"snapshotDelta","sid":... first so gateway routes it onto unreliable 'cs2-u'.
                  const { type: _t, ...rest } = delta;
                  socket.send(JSON.stringify({ type: 'snapshotDelta', sid, baseSid: socket.clientAckSid, ...rest }));
                } else if (nowWall - socket.lastFullResyncAt >= 400) {
                  socket.lastFullResyncAt = nowWall;
                  socket.send(JSON.stringify({ ...stateSnap, sid }));
                }
              } else if (socket.snapshotDelta === 1 && socket.lastDeltaSnap) {
                const playerSnap = snapshotForPlayer(sideSnap, socket.playerId);
                let payload;
                if (socket.pendingEvents.length > 0) {
                  const merged = { ...playerSnap, events: [...socket.pendingEvents.splice(0), ...(playerSnap.events || [])] };
                  payload = JSON.stringify(encodeDeltaSnapshot(merged, socket.lastDeltaSnap));
                } else if (playerSnap === sideSnap) {
                  let byPrev = deltaViews.get(side);
                  if (!byPrev) { byPrev = new Map(); deltaViews.set(side, byPrev); }
                  payload = byPrev.get(socket.lastDeltaSnap);
                  if (payload === undefined) {
                    payload = JSON.stringify(encodeDeltaSnapshot(playerSnap, socket.lastDeltaSnap));
                    byPrev.set(socket.lastDeltaSnap, payload);
                  }
                } else {
                  payload = JSON.stringify(encodeDeltaSnapshot(playerSnap, socket.lastDeltaSnap));
                }
                socket.lastDeltaSnap = playerSnap;
                socket.send(payload);
              } else {
                if (socket.snapshotDelta === 1) {
                  const playerSnap = snapshotForPlayer(sideSnap, socket.playerId);
                  socket.lastDeltaSnap = playerSnap;
                  socket.send(JSON.stringify(playerSnap));
                } else {
                  if (!jsonViews.has(side)) jsonViews.set(side, JSON.stringify(sideSnap));
                  socket.send(jsonViews.get(side));
                }
              }
              socket.lastSnapshotSentAt = nowWall;
            }
          }
        }
      } catch (e) { console.error(`[room ${room.code}]`, e); for (const socket of room.clients.values()) error(socket, 'SIMULATION_ERROR', '房间模拟出现错误，请重新加入。'); }
    }
    performanceMetrics.record(performance.now()-tickStarted,delay);
  }, 1000 / TICK_RATE);
  const heartbeatTimer = setInterval(() => {
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    for (const [jti, exp] of usedJTIs) {
      if (nowSec > exp) usedJTIs.delete(jti);
    }
    for (const [code, room] of rooms) {
      room.pruneDisconnectedSessions(nowMs);
      if (matchEndCleanupMs > 0 && room.match?.status === 'ended' && room.matchEndedWallAt > 0 && nowMs - room.matchEndedWallAt >= matchEndCleanupMs) {
        rooms.delete(code);
        for (const sock of room.clients.values()) {
          try { if (sock.readyState === WebSocket.OPEN) sock.close(1000, 'Match ended'); } catch {}
        }
        reporter?.reportNow();
        continue;
      }
      if (!room.humanCount && room.emptyExpiresAt && nowMs >= room.emptyExpiresAt) {
        rooms.delete(code);
        reporter?.reportNow();
      }
    }
    for (const socket of wss.clients) {
      if (!socket.isAlive || (!socket.playerId && nowMs - socket.connectedAt > 20000)) { socket.terminate(); continue; }
      socket.isAlive = false;
      if (!socket.fromGateway) socket.pingSentAt = performance.now();
      socket.ping();
    }
  }, 10000);
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); }); }
  catch (e) { clearInterval(tickTimer); clearInterval(heartbeatTimer); wss.close(); throw e; }
  const actualPort = server.address().port;
  if (controlPlaneUrl) {
    const advertisedMapId = privateMap?.mapId || MAP.id || 'de_dust2';
    const effectiveWorkerId = workerId || `worker-${advertisedMapId}-${actualPort}`;
    reporter = startControlPlaneReporter({
      controlPlaneUrl,
      authToken: workerAuthToken,
      workerId: effectiveWorkerId,
      wsUrlProvider: () => workerPublicWsUrl || `ws://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}/ws`,
      maps: [advertisedMapId],
      maxRooms,
      intervalMs: heartbeatIntervalMs,
      getState: () => ({
        draining,
        tickP99Ms: performanceMetrics.snapshot().tickP99Ms || performanceMetrics.snapshot().tickP95Ms || 0,
        rooms: [...rooms.values()]
          .filter(r => r.match?.status !== 'ended' && r.round?.phase !== 'matchEnded')
          .map(r => {
          const playerNames = [];
          for (const [pid, sock] of r.clients) {
            if (sock.readyState === WebSocket.OPEN) {
              const pl = r.players.get(pid);
              if (pl) playerNames.push(pl.name);
            }
          }
          return {
            code: r.code,
            mapId: advertisedMapId,
            mode: r.mode,
            visibility: r.visibility,
            botDifficulty: r.botDifficulty,
            humans: playerNames.length,
            bots: r.botCount,
            capacity: r.humanCapacity,
            phase: r.round.phase,
            joinable: !draining && r.joinable,
            scores: { CT: r.scores.CT, T: r.scores.T },
            players: playerNames,
          };
        }),
      }),
    });
  }
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true; clearInterval(tickTimer); clearInterval(heartbeatTimer);
    if (telemetryFlushTimer) clearInterval(telemetryFlushTimer);
    telemetry.flushAll('shutdown');
    await flushTelemetryOutbox();
    await localTelemetryStore?.close();
    await reporter?.stop();
    for (const socket of wss.clients) socket.terminate();
    await Promise.all([new Promise(resolve => wss.close(resolve)), new Promise(resolve => server.close(resolve))]); rooms.clear();
  };
  return { server, wss, rooms, port: actualPort, maxRooms, close, beginDrain, isDraining: () => draining, reporter };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startGameServer().then(app => {
    console.log(`Dust2 Web ready: http://localhost:${app.port} | WebSocket /ws | Health /health`);
    process.on('SIGUSR2', () => { app.beginDrain(); console.log('Dust2 Web draining: new joins disabled'); });
    const stop = () => app.close().then(() => process.exit(0));
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  }).catch(e => { console.error('Dust2 Web failed to start:', e); process.exitCode = 1; });
}
