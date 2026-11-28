/**
 * Optional static-host runtime bridge for Bilibili Toy (<=128 MB package) and external CDNs.
 *
 * When the frontend HTML/JS/CSS is served directly from the game server (/perf/),
 * globalThis.__CS2_STATIC_RUNTIME__ is undefined and every helper transparently
 * preserves existing same-origin behavior.
 *
 * When hosted statically on Toy or an external static host, runtime-config.js defines:
 *   globalThis.__CS2_STATIC_RUNTIME__ = {
 *     gameServerOrigin: 'https://ws.example.com',      // WS + tiny JSON room APIs ONLY
 *     assetBaseURL: 'https://cdn.example.com/assets/', // External CDN for optional assets
 *     mapBaseURL: 'https://cdn.example.com/maps/',     // External CDN for non-bundled maps
 *     bundledAssets: [...],                            // Paths present locally inside Toy
 *     bundledGzAssets: [...],                          // Paths stored as .gz locally inside Toy
 *     bundledMaps: [...],                              // Map IDs stored locally inside Toy
 *     bundledMapsGz: true,                             // Map binaries stored as .gz inside Toy
 *   };
 */

let cachedSource = null;
let cachedRuntime = null;
let dynamicCdnOverride = null;
const ACTIVE_ORIGIN_KEY = 'cs2.activeGameOrigin.v1';
const ORIGIN_BACKOFF_MS = 60_000;
const failedOriginUntil = new Map();

function cleanOrigin(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim());
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    return u.origin;
  } catch {
    return null;
  }
}

function cleanBaseURL(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim());
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    if (!u.pathname.endsWith('/')) u.pathname += '/';
    return u.href;
  } catch {
    return null;
  }
}

function readStoredOrigin() {
  try {
    return cleanOrigin(globalThis.sessionStorage?.getItem(ACTIVE_ORIGIN_KEY) || '');
  } catch {
    return null;
  }
}

function writeStoredOrigin(origin) {
  try {
    if (origin) globalThis.sessionStorage?.setItem(ACTIVE_ORIGIN_KEY, origin);
    else globalThis.sessionStorage?.removeItem(ACTIVE_ORIGIN_KEY);
  } catch {}
}

export function getStaticRuntime() {
  const raw = globalThis.__CS2_STATIC_RUNTIME__;
  if (!raw || typeof raw !== 'object') {
    cachedSource = null;
    cachedRuntime = null;
    return null;
  }
  if (raw === cachedSource && cachedRuntime) return cachedRuntime;
  const gameServerOrigins = [];
  const pushOrigin = (v) => {
    const c = cleanOrigin(v);
    if (c && !gameServerOrigins.includes(c)) gameServerOrigins.push(c);
  };
  if (Array.isArray(raw.gameServerOrigins)) {
    for (const item of raw.gameServerOrigins) pushOrigin(item);
  }
  pushOrigin(raw.gameServerOrigin);
  const gameServerOrigin = gameServerOrigins[0] || null;
  const assetBaseURL = cleanBaseURL(raw.assetBaseURL);
  const mapBaseURL = cleanBaseURL(raw.mapBaseURL);
  const bundledAssetSet = new Set(Array.isArray(raw.bundledAssets) ? raw.bundledAssets : []);
  const bundledGzAssetSet = new Set(Array.isArray(raw.bundledGzAssets) ? raw.bundledGzAssets : []);
  const bundledMapSet = new Set(Array.isArray(raw.bundledMaps) ? raw.bundledMaps : []);
  cachedSource = raw;
  cachedRuntime = Object.freeze({
    gameServerOrigin,
    gameServerOrigins: Object.freeze(gameServerOrigins),
    assetBaseURL,
    mapBaseURL,
    bundledAssetSet,
    bundledGzAssetSet,
    bundledMapSet,
    bundledMapsGz: raw.bundledMapsGz !== false,
    bundledMapsBinExt: typeof raw.bundledMapsBinExt === 'string' ? raw.bundledMapsBinExt : '',
    staticPlayPath: typeof raw.staticPlayPath === 'string' && raw.staticPlayPath ? raw.staticPlayPath : './play.html',
    staticLobbyPath: typeof raw.staticLobbyPath === 'string' && raw.staticLobbyPath ? raw.staticLobbyPath : './',
  });
  return cachedRuntime;
}

export function setDynamicCdnConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') {
    dynamicCdnOverride = null;
    return;
  }
  const assetBaseURL = cleanBaseURL(cfg.assetBaseURL);
  const mapBaseURL = cleanBaseURL(cfg.mapBaseURL);
  if (assetBaseURL || mapBaseURL) {
    dynamicCdnOverride = Object.freeze({ assetBaseURL, mapBaseURL });
  }
}

export function getEffectiveCdnBases() {
  const rt = getStaticRuntime();
  return {
    assetBaseURL: dynamicCdnOverride?.assetBaseURL || rt?.assetBaseURL || null,
    mapBaseURL: dynamicCdnOverride?.mapBaseURL || rt?.mapBaseURL || null,
  };
}

export function getGameServerOrigins() {
  const rt = getStaticRuntime();
  const list = rt?.gameServerOrigins || [];
  if (list.length <= 1) return [...list];
  const now = Date.now();
  const stored = readStoredOrigin();
  const healthy = [];
  const backedOff = [];
  if (stored && list.includes(stored)) {
    const until = failedOriginUntil.get(stored) || 0;
    if (until <= now) healthy.push(stored);
  }
  for (const origin of list) {
    if (healthy.includes(origin)) continue;
    const until = failedOriginUntil.get(origin) || 0;
    if (until <= now) healthy.push(origin);
    else backedOff.push(origin);
  }
  return [...healthy, ...backedOff];
}

export function getActiveGameOrigin() {
  const list = getGameServerOrigins();
  return list[0] || null;
}

export function setActiveGameOrigin(origin) {
  const clean = cleanOrigin(origin);
  if (!clean) return;
  failedOriginUntil.delete(clean);
  writeStoredOrigin(clean);
}

export function markGameOriginFailed(origin, backoffMs = ORIGIN_BACKOFF_MS) {
  const clean = cleanOrigin(origin);
  if (!clean) return;
  failedOriginUntil.set(clean, Date.now() + Math.max(1000, Number(backoffMs) || ORIGIN_BACKOFF_MS));
  if (readStoredOrigin() === clean) writeStoredOrigin(null);
}

export function resetGameOriginFailures() {
  failedOriginUntil.clear();
  writeStoredOrigin(null);
}

export function isStaticRuntime() {
  return Boolean(getStaticRuntime());
}

export function gameApiURL(pathAndQuery, originOverride = null) {
  const origin = cleanOrigin(originOverride) || getActiveGameOrigin();
  if (!origin) return pathAndQuery;
  return new URL(pathAndQuery, origin).href;
}

const FAILOVER_HTTP_STATUS = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526]);

/**
 * Fetch a game-server JSON/API endpoint with automatic multi-origin failover.
 * Returns { response, origin } (and preserves same-origin behavior when not in static runtime).
 */
export async function fetchGameApi(pathAndQuery, options = {}) {
  const { timeoutMs = 3500, fetcher = globalThis.fetch, signal: callerSignal, ...fetchInit } = options;
  const origins = getGameServerOrigins();
  if (!origins.length) {
    const response = await fetcher(pathAndQuery, { ...fetchInit, signal: callerSignal });
    return { response, origin: null };
  }
  let lastError = null;
  let lastResponse = null;
  let lastOrigin = origins[0];
  for (const origin of origins) {
    if (callerSignal?.aborted) throw callerSignal.reason || new DOMException('Aborted', 'AbortError');
    const url = new URL(pathAndQuery, origin).href;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
    const onCallerAbort = () => ctrl.abort(callerSignal.reason);
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    try {
      const response = await fetcher(url, { ...fetchInit, signal: ctrl.signal });
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
      if (FAILOVER_HTTP_STATUS.has(response.status)) {
        markGameOriginFailed(origin);
        lastResponse = response;
        lastOrigin = origin;
        continue;
      }
      setActiveGameOrigin(origin);
      return { response, origin };
    } catch (err) {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
      if (callerSignal?.aborted) throw err;
      markGameOriginFailed(origin);
      lastError = err;
      lastOrigin = origin;
    }
  }
  if (lastResponse) return { response: lastResponse, origin: lastOrigin };
  throw lastError || new Error('所有游戏服务器入口暂时不可用');
}

export function lobbyHref(search = '') {
  const rt = getStaticRuntime();
  const base = rt ? rt.staticLobbyPath : '/perf/';
  if (!search) return base;
  return base + (search.startsWith('?') || search.startsWith('#') ? search : '?' + search);
}

export function matchHref(mapId, params = '', quality = false) {
  const rt = getStaticRuntime();
  const q = params instanceof URLSearchParams ? new URLSearchParams(params) : new URLSearchParams(String(params || '').replace(/^\?/, ''));
  if (rt) {
    q.set('map', mapId);
    if (quality) q.set('quality', '1');
    return rt.staticPlayPath + '?' + q.toString();
  }
  const qs = q.toString();
  return '/perf/' + (quality ? 'quality/' : '') + 'play/' + mapId + '/' + (qs ? '?' + qs : '');
}

/** Parse either /perf/(quality/)?play/<mapId>/ or .../play.html?map=<mapId> */
export function parseMatchRoute(urlLike) {
  const u = urlLike instanceof URL ? urlLike : new URL(String(urlLike), 'http://localhost');
  const pathMatch = /^\/perf\/(quality\/)?play\/(de_[a-z0-9_]+)\/$/.exec(u.pathname);
  if (pathMatch) {
    return { mapId: pathMatch[2], quality: Boolean(pathMatch[1]), isStaticPlay: false };
  }
  const mapParam = u.searchParams.get('map');
  if (/(?:^|\/)play\.html$/i.test(u.pathname) && /^de_[a-z0-9_]+$/.test(mapParam || '')) {
    return { mapId: mapParam, quality: u.searchParams.get('quality') === '1', isStaticPlay: true };
  }
  return null;
}

/** Resolve an `assets/...` relative path in static/Toy mode: Toy-bundled first, then external CDN. */
export function resolveStaticAsset(assetRelPath, pageBase) {
  const rt = getStaticRuntime();
  if (!rt) return null;
  const clean = String(assetRelPath || '').replace(/^\/+/, '');
  if (!clean.startsWith('assets/')) return null;
  const base = new URL('.', pageBase);
  if (rt.bundledGzAssetSet.has(clean)) {
    return { url: new URL('./' + clean + '.gz', base), gz: true, source: 'toy' };
  }
  if (rt.bundledAssetSet.has(clean)) {
    return { url: new URL('./' + clean, base), gz: false, source: 'toy' };
  }
  const { assetBaseURL } = getEffectiveCdnBases();
  if (assetBaseURL) {
    return { url: new URL('./' + clean.slice('assets/'.length), assetBaseURL), gz: false, source: 'cdn' };
  }
  return null;
}

const COMPILED_MAP_FILES = new Set([
  'map.json',
  'nav.json',
  'physics.f32',
  'physics.vidx',
  'physics-mask.u8',
  'physics-groups.json',
]);

const NON_WEB_MAP_BIN_EXT = /\.(?:mgp|vidx|u8|f32)$/i;

/** Resolve a per-map file in static/Toy mode: Toy-bundled (.gz) first, then external CDN mapBaseURL. */
export function resolveStaticMapFile(mapId, relativeFile, pageBase) {
  const rt = getStaticRuntime();
  if (!rt) return null;
  const rel = String(relativeFile || '').replace(/^\/+/, '');
  const diskRel = COMPILED_MAP_FILES.has(rel) ? 'compiled/' + rel : rel;
  const base = new URL('.', pageBase);
  if (rt.bundledMapSet.has(mapId)) {
    const mappedRel =
      rt.bundledMapsBinExt && NON_WEB_MAP_BIN_EXT.test(diskRel)
        ? diskRel + rt.bundledMapsBinExt
        : diskRel;
    const useGz = rt.bundledMapsGz && !mappedRel.endsWith('.gz');
    return {
      url: new URL('./maps/' + mapId + '/' + mappedRel + (useGz ? '.gz' : ''), base),
      gz: useGz,
      source: 'toy',
    };
  }
  const { mapBaseURL } = getEffectiveCdnBases();
  if (mapBaseURL) {
    return {
      url: new URL('./' + mapId + '/' + diskRel, mapBaseURL),
      gz: false,
      source: 'cdn',
    };
  }
  return null;
}

/** Transparently gunzip a Response body when raw gzip bytes (magic 0x1f 0x8b) are served without HTTP Content-Encoding. */
export async function maybeGunzipResponse(response) {
  if (!response?.ok) return response;
  const raw = new Uint8Array(await response.arrayBuffer());
  const headers = new Headers(response.headers);
  headers.delete('content-encoding');
  if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
    let out;
    if (typeof DecompressionStream === 'function') {
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'));
      out = new Uint8Array(await new Response(stream).arrayBuffer());
    } else {
      const { gunzipSync } = await import('three/addons/libs/fflate.module.js');
      out = gunzipSync(raw);
    }
    headers.set('content-length', String(out.byteLength));
    return new Response(out, { status: response.status, statusText: response.statusText, headers });
  }
  headers.set('content-length', String(raw.byteLength));
  return new Response(raw, { status: response.status, statusText: response.statusText, headers });
}
