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

export function getStaticRuntime() {
  const raw = globalThis.__CS2_STATIC_RUNTIME__;
  if (!raw || typeof raw !== 'object') {
    cachedSource = null;
    cachedRuntime = null;
    return null;
  }
  if (raw === cachedSource && cachedRuntime) return cachedRuntime;
  const gameServerOrigin = cleanOrigin(raw.gameServerOrigin);
  const assetBaseURL = cleanBaseURL(raw.assetBaseURL);
  const mapBaseURL = cleanBaseURL(raw.mapBaseURL);
  const bundledAssetSet = new Set(Array.isArray(raw.bundledAssets) ? raw.bundledAssets : []);
  const bundledGzAssetSet = new Set(Array.isArray(raw.bundledGzAssets) ? raw.bundledGzAssets : []);
  const bundledMapSet = new Set(Array.isArray(raw.bundledMaps) ? raw.bundledMaps : []);
  cachedSource = raw;
  cachedRuntime = Object.freeze({
    gameServerOrigin,
    assetBaseURL,
    mapBaseURL,
    bundledAssetSet,
    bundledGzAssetSet,
    bundledMapSet,
    bundledMapsGz: raw.bundledMapsGz !== false,
    staticPlayPath: typeof raw.staticPlayPath === 'string' && raw.staticPlayPath ? raw.staticPlayPath : './play.html',
    staticLobbyPath: typeof raw.staticLobbyPath === 'string' && raw.staticLobbyPath ? raw.staticLobbyPath : './',
  });
  return cachedRuntime;
}

export function isStaticRuntime() {
  return Boolean(getStaticRuntime());
}

export function gameApiURL(pathAndQuery) {
  const rt = getStaticRuntime();
  if (!rt?.gameServerOrigin) return pathAndQuery;
  return new URL(pathAndQuery, rt.gameServerOrigin).href;
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
  if (rt.assetBaseURL) {
    return { url: new URL('./' + clean.slice('assets/'.length), rt.assetBaseURL), gz: false, source: 'cdn' };
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

/** Resolve a per-map file in static/Toy mode: Toy-bundled (.gz) first, then external CDN mapBaseURL. */
export function resolveStaticMapFile(mapId, relativeFile, pageBase) {
  const rt = getStaticRuntime();
  if (!rt) return null;
  const rel = String(relativeFile || '').replace(/^\/+/, '');
  const diskRel = COMPILED_MAP_FILES.has(rel) ? 'compiled/' + rel : rel;
  const base = new URL('.', pageBase);
  if (rt.bundledMapSet.has(mapId)) {
    const useGz = rt.bundledMapsGz && !diskRel.endsWith('.gz');
    return {
      url: new URL('./maps/' + mapId + '/' + diskRel + (useGz ? '.gz' : ''), base),
      gz: useGz,
      source: 'toy',
    };
  }
  if (rt.mapBaseURL) {
    return {
      url: new URL('./' + mapId + '/' + diskRel, rt.mapBaseURL),
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
  if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
    let out;
    if (typeof DecompressionStream === 'function') {
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'));
      out = new Uint8Array(await new Response(stream).arrayBuffer());
    } else {
      const { gunzipSync } = await import('three/addons/libs/fflate.module.js');
      out = gunzipSync(raw);
    }
    const headers = new Headers(response.headers);
    headers.delete('content-encoding');
    headers.set('content-length', String(out.byteLength));
    return new Response(out, { status: response.status, statusText: response.statusText, headers });
  }
  return new Response(raw, { status: response.status, statusText: response.statusText, headers: response.headers });
}
