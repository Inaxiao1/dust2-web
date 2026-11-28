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
  rtcTimeoutMs = 1800,
  enableRtc = true,
  WebSocketCtor = globalThis.WebSocket,
  PeerConnectionCtor = globalThis.RTCPeerConnection,
  fetchFn = globalThis.fetch,
} = {}) {
  const offerUrl = enableRtc && PeerConnectionCtor && fetchFn && Date.now() >= rtcBackoffUntil
    ? rtcOfferUrlForSocket(wsUrl)
    : null;

  if (!offerUrl) {
    const ws = new WebSocketCtor(wsUrl);
    ws.transportMode = 'WS';
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
  let closedByUser = false;
  let fellBack = false;

  const dispatch = (type, detail = {}) => {
    const ev = Object.assign(new Event(type), detail);
    target.dispatchEvent(ev);
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

  const switchToWebSocket = (markBackoff = false) => {
    if (fellBack || closedByUser || state === WS_OPEN || state === WS_CLOSED) return;
    fellBack = true;
    if (markBackoff) rtcBackoffUntil = Date.now() + RTC_BACKOFF_MS;
    cleanupRtc();
    transportMode = 'WS';
    const ws = new WebSocketCtor(wsUrl);
    activeWs = ws;
    ws.addEventListener('open', () => {
      if (closedByUser) { try { ws.close(1000, 'closed'); } catch {} return; }
      state = WS_OPEN;
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
      if (state === WS_CLOSED) return;
      state = WS_CLOSED;
      dispatch('close', { code: e.code, reason: e.reason || '', wasClean: !!e.wasClean });
    });
  };

  const handle = {
    get readyState() { return activeWs ? activeWs.readyState : state; },
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
        return;
      }
      const wasOpen = state === WS_OPEN;
      state = WS_CLOSED;
      cleanupRtc();
      if (wasOpen || !fellBack) {
        dispatch('close', { code, reason, wasClean: code === 1000 });
      }
    },
  };

  // Start fast WebRTC UDP negotiation with automatic fallback to WS.
  (async () => {
    try {
      fallbackTimer = setTimeout(() => switchToWebSocket(true), rtcTimeoutMs);
      pc = new PeerConnectionCtor({ iceServers: [] });
      dc = pc.createDataChannel('cs2', { ordered: true });

      dc.onopen = () => {
        if (fellBack || closedByUser) { cleanupRtc(); return; }
        if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
        state = WS_OPEN;
        transportMode = 'UDP';
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
          dispatch('close', { code: 1006, reason: 'UDP channel closed', wasClean: false });
        } else {
          switchToWebSocket(true);
        }
      };
      dc.onerror = () => {
        if (state === WS_CONNECTING) switchToWebSocket(true);
      };
      pc.onconnectionstatechange = () => {
        const s = pc?.connectionState;
        if (s === 'failed' || s === 'closed') {
          if (state === WS_CONNECTING) switchToWebSocket(true);
          else if (state === WS_OPEN) {
            state = WS_CLOSED;
            cleanupRtc();
            dispatch('close', { code: 1006, reason: `UDP ${s}`, wasClean: false });
          }
        }
      };
      pc.oniceconnectionstatechange = () => {
        const s = pc?.iceConnectionState;
        if (s === 'failed') {
          if (state === WS_CONNECTING) switchToWebSocket(true);
          else if (state === WS_OPEN) {
            state = WS_CLOSED;
            cleanupRtc();
            dispatch('close', { code: 1006, reason: 'UDP ICE failed', wasClean: false });
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

      const res = await fetchFn(offerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'offer', sdp: pc.localDescription.sdp }),
        signal: abortController.signal,
      });
      if (fellBack || closedByUser) return;
      if (!res.ok) {
        // Server does not have WebRTC enabled (404/503) -> fall back immediately without penalizing UDP.
        switchToWebSocket(res.status === 404);
        return;
      }
      const answer = await res.json();
      if (fellBack || closedByUser) return;
      if (!answer?.ok || answer.type !== 'answer' || typeof answer.sdp !== 'string') {
        switchToWebSocket(false);
        return;
      }
      await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    } catch {
      if (!closedByUser && state === WS_CONNECTING) {
        switchToWebSocket(false);
      }
    }
  })();

  return handle;
}
