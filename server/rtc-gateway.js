import EventEmitter from 'node:events';
import os from 'node:os';

const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

function detectLocalIPv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const info of list || []) {
      if (info && info.family === 'IPv4' && !info.internal) return info.address;
    }
  }
  return '127.0.0.1';
}

function rewriteSdpCandidates(rawSdp, candidates, { localIp, publicIp }) {
  const mapIp = (text) => {
    if (!publicIp || publicIp === localIp) return text;
    return text.replaceAll(localIp, publicIp);
  };
  const isPublicMode = Boolean(publicIp && publicIp !== '127.0.0.1');
  const lines = mapIp(rawSdp).split(/\r?\n/).filter((line) => {
    if (!line.trim()) return false;
    if (!line.startsWith('a=candidate:')) return true;
    if (isPublicMode && !line.includes(` ${publicIp} `)) return false;
    return true;
  });
  const seen = new Set(lines.filter((l) => l.startsWith('a=candidate:')));
  for (const raw of candidates) {
    const line = mapIp(raw.startsWith('a=') ? raw : `a=${raw}`).trim();
    if (!line) continue;
    if (isPublicMode && !line.includes(` ${publicIp} `)) continue;
    if (!seen.has(line)) {
      seen.add(line);
      lines.push(line);
    }
  }
  return lines.join('\r\n') + '\r\n';
}

/**
 * WebSocket-compatible wrapper around a node-datachannel DataChannel + PeerConnection,
 * allowing WebRTC direct UDP clients to reuse the exact same map & multi-shard router.
 */
class RtcSocketAdapter extends EventEmitter {
  constructor(pc, dc, onDispose, { bindMessage = true } = {}) {
    super();
    this.pc = pc;
    this.dc = dc;
    this.dcUnreliable = null;
    this.onDispose = onDispose;
    this.readyState = WS_OPEN;
    this._cs2Alive = true;
    this._lastMessageAt = Date.now();
    this._closed = false;
    this._disconnectTimer = null;

    if (bindMessage) {
      dc.onMessage((msg) => this._onDataChannelMessage(msg));
    }
    dc.onClosed(() => this._finalize(1000, 'DataChannel closed'));
    dc.onError((err) => {
      this.emit('error', new Error(String(err || 'DataChannel error')));
      this._finalize(1011, 'DataChannel error');
    });
    pc.onStateChange((state) => {
      if (state === 'connected') {
        if (this._disconnectTimer) {
          clearTimeout(this._disconnectTimer);
          this._disconnectTimer = null;
        }
        this._cs2Alive = true;
      } else if (state === 'disconnected') {
        if (!this._disconnectTimer && !this._closed) {
          this._disconnectTimer = setTimeout(() => this._finalize(1006, 'ICE disconnected'), 4500);
          this._disconnectTimer.unref?.();
        }
      } else if (state === 'failed' || state === 'closed') {
        this._finalize(1006, `ICE ${state}`);
      }
    });
  }

  attachUnreliable(dcUnreliable) {
    if (this._closed || !dcUnreliable || this.dcUnreliable) return;
    this.dcUnreliable = dcUnreliable;
    dcUnreliable.onMessage((msg) => this._onDataChannelMessage(msg));
    dcUnreliable.onClosed(() => {
      if (this.dcUnreliable === dcUnreliable) this.dcUnreliable = null;
    });
    dcUnreliable.onError(() => {
      if (this.dcUnreliable === dcUnreliable) this.dcUnreliable = null;
    });
  }

  get hasUnreliable() {
    if (this._closed || !this.dcUnreliable) return false;
    try { return Boolean(this.dcUnreliable.isOpen?.()); } catch { return false; }
  }

  _onDataChannelMessage(msg) {
    if (this._closed) return;
    this._cs2Alive = true;
    this._lastMessageAt = Date.now();
    const isBinary = typeof msg !== 'string';
    const payload = isBinary ? Buffer.from(msg) : Buffer.from(msg, 'utf8');
    this.emit('message', payload, isBinary);
  }

  get bufferedAmount() {
    if (this._closed) return 0;
    try { return this.dc.bufferedAmount(); } catch { return 0; }
  }

  get rttMs() {
    if (this._closed) return null;
    try {
      const val = Number(this.pc.rtt?.());
      return Number.isFinite(val) && val >= 1 && val <= 5000 ? Math.round(val) : null;
    } catch {
      return null;
    }
  }

  send(data, opts = {}) {
    if (this._closed || this.readyState !== WS_OPEN) return;
    try {
      if (opts?.binary) {
        this.dc.sendMessageBinary(Buffer.isBuffer(data) ? data : Buffer.from(data));
      } else {
        const text = typeof data === 'string'
          ? data
          : (Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data).toString('utf8'));
        this.dc.sendMessage(text);
      }
    } catch {
      this._finalize(1011, 'Send failed');
    }
  }

  sendUnreliable(data, opts = {}) {
    if (this._closed || this.readyState !== WS_OPEN) return;
    const udc = this.dcUnreliable;
    if (udc) {
      try {
        if (udc.isOpen?.()) {
          if (opts?.binary) {
            udc.sendMessageBinary(Buffer.isBuffer(data) ? data : Buffer.from(data));
          } else {
            const text = typeof data === 'string'
              ? data
              : (Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data).toString('utf8'));
            udc.sendMessage(text);
          }
          return;
        }
      } catch {
        // Fall back to reliable channel if unreliable channel momentarily fails.
      }
    }
    this.send(data, opts);
  }

  ping() {
    if (this._closed) return;
    // WebRTC ICE consent freshness already validates UDP liveness; drop only long-silent dead peers.
    if (Date.now() - this._lastMessageAt > 90000) {
      this._finalize(1006, 'Idle timeout');
    } else {
      this._cs2Alive = true;
    }
  }

  close(code = 1000, reason = '') {
    this._finalize(code, typeof reason === 'string' ? reason : '');
  }

  terminate() {
    this._finalize(1006, 'Terminated');
  }

  _finalize(code, reason) {
    if (this._closed) return;
    this._closed = true;
    this.readyState = WS_CLOSING;
    if (this._disconnectTimer) {
      clearTimeout(this._disconnectTimer);
      this._disconnectTimer = null;
    }
    try { this.dcUnreliable?.close(); } catch {}
    this.dcUnreliable = null;
    try { this.dc.close(); } catch {}
    try { this.pc.close(); } catch {}
    this.readyState = WS_CLOSED;
    this.onDispose?.();
    this.emit('close', code, reason);
  }
}

/**
 * Create a single-port UDP-muxed WebRTC DataChannel gateway backed by node-datachannel.
 * Returns null if disabled or if the optional native dependency is unavailable.
 */
export async function createRtcGateway({
  udpPort = Number(process.env.PERF_RTC_UDP_PORT || 0),
  publicIp = (process.env.PERF_RTC_PUBLIC_IP || '').trim(),
  localIp = (process.env.PERF_RTC_LOCAL_IP || '').trim() || detectLocalIPv4(),
  maxPeers = Math.max(20, Math.min(2000, Number(process.env.PERF_RTC_MAX_PEERS) || 500)),
  maxPending = 100,
  onClientSocket,
} = {}) {
  if (!Number.isInteger(udpPort) || udpPort < 1024 || udpPort > 65535) return null;
  let ndc;
  try {
    const mod = await import('node-datachannel');
    ndc = mod.default || mod;
  } catch {
    return null;
  }
  if (!ndc?.PeerConnection) return null;

  // Tune usrsctp for real-time FPS traffic: cap association send queue to 32 KB / 32 chunks so
  // cwnd drops never build multi-second bufferbloat, keep standard RFC 4960 CC (0, per libdatachannel
  // guidance to avoid alternative-CC stalls), and tighten RTO/SACK timers.
  try {
    ndc.setSctpSettings?.({
      recvBufferSize: 256 * 1024,
      sendBufferSize: 32 * 1024,
      maxChunksOnQueue: 32,
      initialCongestionWindow: 20,
      maxBurst: 16,
      congestionControlModule: 0,
      delayedSackTime: 20,
      minRetransmitTimeout: 120,
      initialRetransmitTimeout: 200,
      maxRetransmitTimeout: 1000,
    });
  } catch {}

  const activePeers = new Set();
  const pendingPeers = new Set();
  const effectivePublicIp = publicIp || localIp;
  let peerSeq = 0;
  let closed = false;

  // Keep one permanent anchor PeerConnection bound to the single UDP mux port so libjuice's
  // mux refcount never drops to 0. Without this, any map worker child process spawned while
  // a peer was connected inherits the UDP socket FD (libjuice omits SOCK_CLOEXEC), causing
  // re-bind failure ("Failed to gather local ICE candidates") after activePeers hits 0.
  let muxAnchorPc = null;
  try {
    muxAnchorPc = new ndc.PeerConnection('cs2-mux-anchor', {
      iceServers: [],
      enableIceUdpMux: true,
      portRangeBegin: udpPort,
      portRangeEnd: udpPort,
    });
    muxAnchorPc.createDataChannel('anchor');
  } catch {
    muxAnchorPc = null;
  }

  const stats = {
    offers: 0,
    opened: 0,
    rejected: 0,
    timedOut: 0,
  };

  function handleOffer(mapId, query, req, offerBody) {
    if (closed) return Promise.resolve({ status: 503, body: { ok: false, error: 'RTC_CLOSED' } });
    if (!offerBody || offerBody.type !== 'offer' || typeof offerBody.sdp !== 'string' || offerBody.sdp.length < 32 || offerBody.sdp.length > 32768) {
      return Promise.resolve({ status: 400, body: { ok: false, error: 'INVALID_SDP_OFFER' } });
    }
    if (activePeers.size >= maxPeers || pendingPeers.size >= maxPending) {
      stats.rejected++;
      return Promise.resolve({ status: 503, body: { ok: false, error: 'RTC_CAPACITY_FULL' } });
    }
    stats.offers++;

    return new Promise((resolve) => {
      const peerName = `cs2-${mapId}-${++peerSeq}`;
      let pc;
      try {
        pc = new ndc.PeerConnection(peerName, {
          iceServers: [],
          enableIceUdpMux: true,
          portRangeBegin: udpPort,
          portRangeEnd: udpPort,
        });
      } catch (err) {
        stats.rejected++;
        resolve({ status: 503, body: { ok: false, error: 'RTC_INIT_FAILED', detail: err?.message || '' } });
        return;
      }

      activePeers.add(pc);
      pendingPeers.add(pc);
      const candidates = [];
      let localSdp = null;
      let gatherDone = false;
      let answered = false;
      let dcAttached = false;

      const releasePeer = () => {
        pendingPeers.delete(pc);
        activePeers.delete(pc);
      };

      const handshakeTimer = setTimeout(() => {
        if (!dcAttached) {
          stats.timedOut++;
          releasePeer();
          try { pc.close(); } catch {}
        }
      }, 9000);
      handshakeTimer.unref?.();

      let answerTimer = null;
      const sendAnswer = () => {
        if (answered || !localSdp) return;
        answered = true;
        if (answerTimer) { clearTimeout(answerTimer); answerTimer = null; }
        const sdp = rewriteSdpCandidates(localSdp, candidates, { localIp, publicIp: effectivePublicIp });
        resolve({ status: 200, body: { ok: true, type: 'answer', sdp } });
      };

      pc.onLocalDescription((sdp) => {
        localSdp = sdp;
        if (gatherDone) setTimeout(sendAnswer, 15);
      });
      pc.onLocalCandidate((cand) => {
        if (cand) candidates.push(cand);
      });
      pc.onGatheringStateChange((state) => {
        if (state === 'complete') {
          gatherDone = true;
          if (localSdp) setTimeout(sendAnswer, 15);
        }
      });

      let adapter = null;
      let pendingUnreliableDc = null;
      pc.onDataChannel((dc) => {
        const label = dc.getLabel();
        if (label === 'cs2-u') {
          const bindUnreliable = () => {
            if (closed) return;
            if (adapter) adapter.attachUnreliable(dc);
            else pendingUnreliableDc = dc;
          };
          if (dc.isOpen()) bindUnreliable();
          else dc.onOpen(bindUnreliable);
          return;
        }
        if (dcAttached || label !== 'cs2') return;
        const earlyMessages = [];
        // Bind dc.onMessage exactly once so libdatachannel's initial mRecvQueue drain
        // can never be dropped across a handler replacement.
        dc.onMessage((msg) => {
          if (adapter) {
            adapter._onDataChannelMessage(msg);
          } else if (earlyMessages.length < 32) {
            earlyMessages.push(msg);
          }
        });
        const attach = () => {
          if (dcAttached || closed) return;
          dcAttached = true;
          clearTimeout(handshakeTimer);
          pendingPeers.delete(pc);
          stats.opened++;
          adapter = new RtcSocketAdapter(pc, dc, releasePeer, { bindMessage: false });
          if (pendingUnreliableDc) {
            adapter.attachUnreliable(pendingUnreliableDc);
            pendingUnreliableDc = null;
          }
          onClientSocket(mapId, query, req, adapter);
          for (const msg of earlyMessages.splice(0)) {
            adapter._onDataChannelMessage(msg);
          }
        };
        if (dc.isOpen()) attach();
        else dc.onOpen(attach);
      });

      pc.onStateChange((state) => {
        if (!dcAttached && (state === 'failed' || state === 'closed')) {
          clearTimeout(handshakeTimer);
          releasePeer();
          if (!answered) {
            answered = true;
            if (answerTimer) { clearTimeout(answerTimer); answerTimer = null; }
            resolve({ status: 503, body: { ok: false, error: 'RTC_HANDSHAKE_FAILED' } });
          }
        }
      });

      try {
        pc.setRemoteDescription(offerBody.sdp, 'offer');
      } catch (err) {
        clearTimeout(handshakeTimer);
        releasePeer();
        try { pc.close(); } catch {}
        const detail = String(err?.message || '');
        const isServerSide = /gather|bind|socket|candidate/i.test(detail);
        resolve({
          status: isServerSide ? 503 : 400,
          body: { ok: false, error: isServerSide ? 'RTC_GATHER_FAILED' : 'INVALID_REMOTE_SDP', detail },
        });
        return;
      }

      answerTimer = setTimeout(() => {
        if (!answered && localSdp) sendAnswer();
        else if (!answered) {
          answered = true;
          clearTimeout(handshakeTimer);
          releasePeer();
          try { pc.close(); } catch {}
          resolve({ status: 503, body: { ok: false, error: 'RTC_GATHER_TIMEOUT' } });
        }
      }, 600);
      answerTimer.unref?.();
    });
  }

  return {
    udpPort,
    publicIp: effectivePublicIp,
    handleOffer,
    status() {
      return {
        enabled: true,
        udpPort,
        activePeers: activePeers.size,
        pendingPeers: pendingPeers.size,
        ...stats,
      };
    },
    close({ cleanupNative = false } = {}) {
      if (closed) return;
      closed = true;
      for (const pc of [...activePeers]) {
        try { pc.close(); } catch {}
      }
      activePeers.clear();
      pendingPeers.clear();
      if (muxAnchorPc) {
        try { muxAnchorPc.close(); } catch {}
        muxAnchorPc = null;
      }
      if (cleanupNative) {
        try { ndc.cleanup?.(); } catch {}
      }
    },
  };
}
