/**
 * Zero-dependency multi-origin API failover for the standalone lobby UI (/perf/ui/ and Toy ./ui/).
 * Shares sessionStorage key `cs2.activeGameOrigin.v1` with `shared/static-runtime.js` so
 * a healthy origin discovered in the lobby is reused immediately when entering `play.html`.
 */
const ACTIVE_ORIGIN_KEY = 'cs2.activeGameOrigin.v1';
const ORIGIN_BACKOFF_MS = 60_000;
const FAILOVER_HTTP_STATUS = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526]);
const failedOriginUntil = new Map();

function cleanOrigin(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

function getRuntime() {
  const rt = globalThis.__CS2_STATIC_RUNTIME__;
  return rt && typeof rt === 'object' ? rt : null;
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

export function getConfiguredGameOrigins() {
  const rt = getRuntime();
  if (!rt) return [];
  const out = [];
  const push = (v) => {
    const c = cleanOrigin(v);
    if (c && !out.includes(c)) out.push(c);
  };
  if (Array.isArray(rt.gameServerOrigins)) {
    for (const item of rt.gameServerOrigins) push(item);
  }
  push(rt.gameServerOrigin);
  return out;
}

export function getOrderedGameOrigins() {
  const list = getConfiguredGameOrigins();
  if (list.length <= 1) return list;
  const now = Date.now();
  const stored = readStoredOrigin();
  const healthy = [];
  const backedOff = [];
  if (stored && list.includes(stored) && (failedOriginUntil.get(stored) || 0) <= now) {
    healthy.push(stored);
  }
  for (const origin of list) {
    if (healthy.includes(origin)) continue;
    if ((failedOriginUntil.get(origin) || 0) <= now) healthy.push(origin);
    else backedOff.push(origin);
  }
  return [...healthy, ...backedOff];
}

export function getActiveGameOrigin() {
  return getOrderedGameOrigins()[0] || null;
}

export function apiUrl(pathAndQuery, originOverride = null) {
  const origin = cleanOrigin(originOverride) || getActiveGameOrigin();
  return origin ? new URL(pathAndQuery, origin).href : pathAndQuery;
}

export function markGameOriginFailed(origin) {
  const clean = cleanOrigin(origin);
  if (!clean) return;
  failedOriginUntil.set(clean, Date.now() + ORIGIN_BACKOFF_MS);
  if (readStoredOrigin() === clean) writeStoredOrigin(null);
}

export function setActiveGameOrigin(origin) {
  const clean = cleanOrigin(origin);
  if (!clean) return;
  failedOriginUntil.delete(clean);
  writeStoredOrigin(clean);
}

export async function fetchGameApi(pathAndQuery, options = {}) {
  const { timeoutMs = 3500, signal: callerSignal, ...fetchInit } = options;
  const origins = getOrderedGameOrigins();
  if (!origins.length) {
    const response = await fetch(pathAndQuery, { ...fetchInit, signal: callerSignal });
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
    const onAbort = () => ctrl.abort(callerSignal.reason);
    callerSignal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await fetch(url, { ...fetchInit, signal: ctrl.signal });
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onAbort);
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
      callerSignal?.removeEventListener('abort', onAbort);
      if (callerSignal?.aborted) throw err;
      markGameOriginFailed(origin);
      lastError = err;
      lastOrigin = origin;
    }
  }
  if (lastResponse) return { response: lastResponse, origin: lastOrigin };
  throw lastError || new Error('所有游戏服务器暂不可用');
}
