/** Connect to the game over WebSocket, trying configured alternate origins first. */
const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSED = 3;

const WS_CANDIDATE_BACKOFF_MS = 5 * 60 * 1000;
const wsBackoffUntil = new Map();

export function resetWebSocketBackoff() {
  wsBackoffUntil.clear();
}

function buildWsCandidates(primaryWsUrl, wsFallbackUrls) {
  const now = Date.now();
  const preferred = [];
  if (Array.isArray(wsFallbackUrls)) {
    for (const candidate of wsFallbackUrls) {
      if (typeof candidate !== 'string' || !candidate || candidate === primaryWsUrl) continue;
      if ((wsBackoffUntil.get(candidate) || 0) > now) continue;
      if (!preferred.includes(candidate)) preferred.push(candidate);
    }
  }
  preferred.push(primaryWsUrl);
  return preferred;
}

export function createGameSocket(wsUrl, {
  wsConnectTimeoutMs = 3000,
  wsFallbackUrls = null,
  onStatus = null,
  WebSocketCtor = globalThis.WebSocket,
} = {}) {
  const wsCandidates = buildWsCandidates(wsUrl, wsFallbackUrls);

  const target = new EventTarget();
  let state = WS_CONNECTING;
  let activeWs = null;
  let activeWsUrl = wsUrl;
  let wsAttemptTimer = null;
  let wsCloseGuardTimer = null;
  let closedByUser = false;
  let closeDispatched = false;

  const dispatch = (type, detail = {}) => {
    const ev = Object.assign(new Event(type), detail);
    target.dispatchEvent(ev);
  };

  const dispatchCloseOnce = (detail, { async = false } = {}) => {
    if (closeDispatched) return;
    closeDispatched = true;
    if (wsAttemptTimer) { clearTimeout(wsAttemptTimer); wsAttemptTimer = null; }
    if (wsCloseGuardTimer) { clearTimeout(wsCloseGuardTimer); wsCloseGuardTimer = null; }
    const emit = () => dispatch('close', detail);
    if (async) queueMicrotask(emit);
    else emit();
  };

  const dialWsCandidate = (index, reason) => {
    if (closedByUser || state === WS_OPEN || state === WS_CLOSED) return;
    const candidateUrl = wsCandidates[index];
    const hasNext = index + 1 < wsCandidates.length;
    activeWsUrl = candidateUrl;
    let ws;
    try {
      ws = new WebSocketCtor(candidateUrl);
    } catch {
      if (hasNext) {
        wsBackoffUntil.set(candidateUrl, Date.now() + WS_CANDIDATE_BACKOFF_MS);
        dialWsCandidate(index + 1, 'ws-construct-error');
        return;
      }
      state = WS_CLOSED;
      dispatchCloseOnce({ code: 1006, reason: 'WS construct failed', wasClean: false }, { async: true });
      return;
    }
    activeWs = ws;
    let settledThisAttempt = false;
    const clearAttemptTimer = () => {
      if (wsAttemptTimer) { clearTimeout(wsAttemptTimer); wsAttemptTimer = null; }
    };
    const failoverNext = (failReason) => {
      if (settledThisAttempt || closedByUser || state === WS_OPEN || state === WS_CLOSED) return;
      settledThisAttempt = true;
      clearAttemptTimer();
      wsBackoffUntil.set(candidateUrl, Date.now() + WS_CANDIDATE_BACKOFF_MS);
      if (activeWs === ws) activeWs = null;
      try { ws.close(1000, failReason); } catch {}
      onStatus?.({ phase: 'ws-fallback', reason: failReason });
      dialWsCandidate(index + 1, failReason);
    };
    if (hasNext && wsConnectTimeoutMs > 0) {
      wsAttemptTimer = setTimeout(() => failoverNext('ws-candidate-timeout'), wsConnectTimeoutMs);
    }
    ws.addEventListener('open', () => {
      if (settledThisAttempt || activeWs !== ws) { try { ws.close(1000, 'superseded'); } catch {} return; }
      settledThisAttempt = true;
      clearAttemptTimer();
      if (closedByUser) { try { ws.close(1000, 'closed'); } catch {} return; }
      state = WS_OPEN;
      onStatus?.({ phase: 'ws-open', reason });
      dispatch('open');
    });
    ws.addEventListener('message', (e) => {
      if (activeWs !== ws || state === WS_CLOSED) return;
      dispatch('message', { data: e.data });
    });
    ws.addEventListener('error', () => {
      if (activeWs !== ws || state === WS_CLOSED) return;
      if (state === WS_CONNECTING && hasNext) {
        failoverNext('ws-candidate-error');
        return;
      }
      dispatch('error');
    });
    ws.addEventListener('close', (e) => {
      if (activeWs !== ws) return;
      if (state === WS_CONNECTING && hasNext && !closedByUser) {
        failoverNext('ws-candidate-closed');
        return;
      }
      clearAttemptTimer();
      if (state === WS_CLOSED && closeDispatched) return;
      state = WS_CLOSED;
      dispatchCloseOnce({ code: e.code, reason: e.reason || '', wasClean: !!e.wasClean });
    });
  };

  const handle = {
    get readyState() {
      if (state === WS_CLOSED) return WS_CLOSED;
      return activeWs ? activeWs.readyState : state;
    },
    transportMode: 'WS',
    get url() { return activeWsUrl; },
    get bufferedAmount() { return activeWs?.bufferedAmount || 0; },
    addEventListener(type, listener, options) { target.addEventListener(type, listener, options); },
    removeEventListener(type, listener, options) { target.removeEventListener(type, listener, options); },
    send(data) { activeWs?.send(data); },
    close(code = 1000, reason = '') {
      closedByUser = true;
      if (wsAttemptTimer) { clearTimeout(wsAttemptTimer); wsAttemptTimer = null; }
      if (activeWs) {
        try { activeWs.close(code, reason); } catch {}
        // Guard against a stalled CONNECTING WebSocket that delays or skips its native close event.
        if (!closeDispatched && !wsCloseGuardTimer) {
          wsCloseGuardTimer = setTimeout(() => {
            wsCloseGuardTimer = null;
            state = WS_CLOSED;
            dispatchCloseOnce({ code, reason, wasClean: code === 1000 });
          }, 1500);
        }
        return;
      }
      state = WS_CLOSED;
      dispatchCloseOnce({ code, reason, wasClean: code === 1000 }, { async: true });
    },
  };

  dialWsCandidate(0, 'ws-direct');
  return handle;
}
