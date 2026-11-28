/**
 * Dual-transport game socket:
 *   1. Prefer direct WebRTC DataChannel (UDP -> game server) for lowest latency & zero relay bandwidth.
 *   2. Automatically fall back to standard WebSocket within `rtcTimeoutMs` (default 1800ms) whenever
 *      WebRTC is unsupported, signaling returns non-200, or UDP is blocked by the user's network/firewall.
 *
 * Implements the standard WebSocket event & method surface (`addEventListener`, `send`, `close`,
 * `readyState`, plus `transportMode: 'UDP' | 'WS'`) so client game code needs zero protocol changes.
 */

const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

const RTC_BACKOFF_MS = 5 * 60 * 1000;
let rtcBackoffUntil = 0;

export function resetRtcBackoff() {
  rtcBackoffUntil = 0;
}

export function markRtcBackoff(durationMs = RTC_BACKOFF_MS) {
  rtcBackoffUntil = Math.max(rtcBackoffUntil, Date.now() + Math.max(1000, Number(durationMs) || RTC_BACKOFF_MS));
}

export function rtcOfferUrlForSocket(wsUrl) {
  try {
    const parsed = new URL(wsUrl);
    if (!/^\/perf\/(?:quality\/)?play\/de_[a-z0-9]+\/ws$/.test(parsed.pathname)) return null;
    parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
    parsed.pathname = parsed.pathname.replace(/\/ws$/, '/rtc-offer');
    return parsed.href;
  } catch {
    return null;
  }
}

export function createGameSocket(wsUrl, {
  rtcTimeoutMs = 2500,
  enableRtc = true,
  onStatus = null,
  WebSocketCtor = globalThis.WebSocket,
  PeerConnectionCtor = globalThis.RTCPeerConnection,
  fetchFn = globalThis.fetch,
} = {}) {
  const offerUrl = enableRtc && PeerConnectionCtor && fetchFn && Date.now() >= rtcBackoffUntil
    ? rtcOfferUrlForSocket(wsUrl)
    : null;

  if (!offerUrl) {
    onStatus?.({ phase: 'ws-direct', reason: enableRtc ? 'backoff-or-unsupported' : 'forced-ws' });
    const ws = new WebSocketCtor(wsUrl);
    ws.transportMode = 'WS';
    ws.addEventListener?.('open', () => onStatus?.({ phase: 'ws-open', reason: 'direct' }), { once: true });
    return ws;
  }

  const target = new EventTarget();
  let state = WS_CONNECTING;
  let transportMode = 'CONNECTING';
  let activeWs = null;
  let pc = null;
  let dc = null;
  let abortController = new AbortController();
  let fallbackTimer = null;
  let wsCloseGuardTimer = null;
  let closedByUser = false;
  let fellBack = false;
  let closeDispatched = false;

  const dispatch = (type, detail = {}) => {
    const ev = Object.assign(new Event(type), detail);
    target.dispatchEvent(ev);
  };

  const dispatchCloseOnce = (detail, { async = false } = {}) => {
    if (closeDispatched) return;
    closeDispatched = true;
    if (wsCloseGuardTimer) { clearTimeout(wsCloseGuardTimer); wsCloseGuardTimer = null; }
    const emit = () => dispatch('close', detail);
    if (async) queueMicrotask(emit);
    else emit();
  };

  const cleanupRtc = () => {
    if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
    try { abortController?.abort(); } catch {}
    abortController = null;
    if (dc) {
      dc.onopen = dc.onmessage = dc.onclose = dc.onerror = null;
      try { dc.close(); } catch {}
      dc = null;
    }
    if (pc) {
      pc.oniceconnectionstatechange = pc.onconnectionstatechange = null;
      try { pc.close(); } catch {}
      pc = null;
    }
  };

  const switchToWebSocket = (markBackoff = false, reason = 'rtc-fallback') => {
    if (fellBack || closedByUser || state === WS_OPEN || state === WS_CLOSED) return;
    fellBack = true;
    if (markBackoff) markRtcBackoff();
    cleanupRtc();
    transportMode = 'WS';
    onStatus?.({ phase: 'ws-fallback', reason });
    const ws = new WebSocketCtor(wsUrl);
    activeWs = ws;
    ws.addEventListener('open', () => {
      if (closedByUser) { try { ws.close(1000, 'closed'); } catch {} return; }
      state = WS_OPEN;
      onStatus?.({ phase: 'ws-open', reason });
      dispatch('open');
    });
    ws.addEventListener('message', (e) => {
      if (state === WS_CLOSED) return;
      dispatch('message', { data: e.data });
    });
    ws.addEventListener('error', () => {
      if (state === WS_CLOSED) return;
      dispatch('error');
    });
    ws.addEventListener('close', (e) => {
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
    get transportMode() { return transportMode; },
    get url() { return wsUrl; },
    get bufferedAmount() {
      if (activeWs) return activeWs.bufferedAmount;
      if (dc) return dc.bufferedAmount || 0;
      return 0;
    },
    addEventListener(type, listener, options) { target.addEventListener(type, listener, options); },
    removeEventListener(type, listener, options) { target.removeEventListener(type, listener, options); },
    send(data) {
      if (activeWs) {
        activeWs.send(data);
        return;
      }
      if (dc && dc.readyState === 'open') {
        dc.send(data);
      }
    },
    close(code = 1000, reason = '') {
      closedByUser = true;
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
      const wasOpen = state === WS_OPEN;
      state = WS_CLOSED;
      cleanupRtc();
      // Match native WebSocket semantics: never fire 'close' synchronously inside close().
      if (wasOpen || !fellBack) {
        dispatchCloseOnce({ code, reason, wasClean: code === 1000 }, { async: true });
      }
    },
  };

  // Start fast WebRTC UDP negotiation with automatic fallback to WS.
  (async () => {
    try {
      onStatus?.({ phase: 'udp-connecting', reason: 'offer' });
      fallbackTimer = setTimeout(() => switchToWebSocket(true, 'timeout'), rtcTimeoutMs);
      pc = new PeerConnectionCtor({ iceServers: [] });
      dc = pc.createDataChannel('cs2', { ordered: true });

      dc.onopen = () => {
        if (fellBack || closedByUser) { cleanupRtc(); return; }
        if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
        state = WS_OPEN;
        transportMode = 'UDP';
        onStatus?.({ phase: 'udp-open', reason: 'connected' });
        dispatch('open');
      };
      dc.onmessage = (e) => {
        if (state !== WS_OPEN || closedByUser) return;
        dispatch('message', { data: e.data });
      };
      dc.onclose = () => {
        if (fellBack || state === WS_CLOSED) return;
        if (state === WS_OPEN) {
          state = WS_CLOSED;
          cleanupRtc();
          dispatchCloseOnce({ code: 1006, reason: 'UDP channel closed', wasClean: false });
        } else {
          switchToWebSocket(true, 'dc-closed');
        }
      };
      dc.onerror = () => {
        if (state === WS_CONNECTING) switchToWebSocket(true, 'dc-error');
      };
      pc.onconnectionstatechange = () => {
        const s = pc?.connectionState;
        if (s === 'failed' || s === 'closed') {
          if (state === WS_CONNECTING) switchToWebSocket(true, `pc-${s}`);
          else if (state === WS_OPEN) {
            state = WS_CLOSED;
            cleanupRtc();
            dispatchCloseOnce({ code: 1006, reason: `UDP ${s}`, wasClean: false });
          }
        }
      };
      pc.oniceconnectionstatechange = () => {
        const s = pc?.iceConnectionState;
        if (s === 'failed' || (s === 'disconnected' && state === WS_CONNECTING)) {
          if (state === WS_CONNECTING) switchToWebSocket(true, `ice-${s}`);
          else if (state === WS_OPEN) {
            state = WS_CLOSED;
            cleanupRtc();
            dispatchCloseOnce({ code: 1006, reason: 'UDP ICE failed', wasClean: false });
          }
        }
      };

      const offer = await pc.createOffer();
      if (fellBack || closedByUser) return;
      await pc.setLocalDescription(offer);
      if (fellBack || closedByUser) return;

      // Give browser up to 80ms to include local host candidate (server also discovers prflx on first STUN packet).
      if (pc.iceGatheringState !== 'complete') {
        await new Promise((resolve) => {
          const t = setTimeout(resolve, 80);
          const onChange = () => {
            if (pc?.iceGatheringState === 'complete') {
              clearTimeout(t);
              pc.removeEventListener?.('icegatheringstatechange', onChange);
              resolve();
            }
          };
          pc.addEventListener?.('icegatheringstatechange', onChange);
        });
      }
      if (fellBack || closedByUser) return;

      // Use text/plain so cross-origin Toy clients avoid an extra CORS OPTIONS preflight round-trip.
      const res = await fetchFn(offerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({ type: 'offer', sdp: pc.localDescription.sdp }),
        signal: abortController.signal,
      });
      if (fellBack || closedByUser) return;
      if (!res.ok) {
        // Server does not have WebRTC enabled (404/503) -> fall back immediately without penalizing UDP.
        switchToWebSocket(res.status === 404, `offer-${res.status}`);
        return;
      }
      const answer = await res.json();
      if (fellBack || closedByUser) return;
      if (!answer?.ok || answer.type !== 'answer' || typeof answer.sdp !== 'string') {
        switchToWebSocket(false, 'bad-answer');
        return;
      }
      await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    } catch {
      if (!closedByUser && state === WS_CONNECTING) {
        switchToWebSocket(false, 'rtc-exception');
      }
    }
  })();

  return handle;
}
