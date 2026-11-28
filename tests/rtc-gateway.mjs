import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import dgram from 'node:dgram';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createGameSocket, markRtcBackoff, resetRtcBackoff, rtcOfferUrlForSocket } from '../client/rtc-transport.js';

const repo = fileURLToPath(new URL('../', import.meta.url));
const packs = process.env.PERF_MAP_ROOT || path.join(repo, 'artifacts/performance-maps/maps-v1');
const installed = existsSync(path.join(packs, 'de_dust2', 'compiled/map.json'));

let ndc = null;
try {
  const mod = await import('node-datachannel');
  ndc = mod.default || mod;
} catch {}

async function pickFreeUdpPort() {
  const sock = dgram.createSocket('udp4');
  await new Promise((resolve, reject) => {
    sock.once('error', reject);
    sock.bind(0, '127.0.0.1', resolve);
  });
  const { port } = sock.address();
  await new Promise((resolve) => sock.close(resolve));
  return port;
}

class FakeWebSocket extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
    this.bufferedAmount = 0;
    this.sent = [];
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.dispatchEvent(new Event('open'));
    });
  }
  send(data) {
    this.sent.push(data);
    queueMicrotask(() => {
      if (this.readyState !== 1) return;
      this.dispatchEvent(Object.assign(new Event('message'), { data: `ws-echo:${data}` }));
    });
  }
  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event('close'), { code, reason, wasClean: code === 1000 }));
  }
}

test('rtcOfferUrlForSocket maps perf play WebSocket URLs and rejects non-perf URLs', () => {
  assert.equal(
    rtcOfferUrlForSocket('wss://cs2-ws.apikeygame.top/perf/play/de_dust2/ws?token=abc'),
    'https://cs2-ws.apikeygame.top/perf/play/de_dust2/rtc-offer?token=abc'
  );
  assert.equal(
    rtcOfferUrlForSocket('http://127.0.0.1:3240/perf/quality/play/de_mirage/ws'),
    'http://127.0.0.1:3240/perf/quality/play/de_mirage/rtc-offer'
  );
  assert.equal(rtcOfferUrlForSocket('ws://127.0.0.1:3000/ws'), null);
  assert.equal(rtcOfferUrlForSocket('not-a-url'), null);
});

test('createGameSocket opens direct UDP DataChannel when offer succeeds and never falls back to WS', async () => {
  resetRtcBackoff();
  let wsConstructed = 0;
  let lastDc = null;
  class MockWebSocket extends FakeWebSocket {
    constructor(url) { wsConstructed++; super(url); }
  }
  class MockPeerConnection extends EventTarget {
    constructor() {
      super();
      this.iceGatheringState = 'complete';
      this.connectionState = 'new';
      this.iceConnectionState = 'new';
    }
    createDataChannel(label) {
      assert.equal(label, 'cs2');
      lastDc = {
        readyState: 'connecting',
        bufferedAmount: 0,
        sent: [],
        send(data) {
          this.sent.push(data);
          queueMicrotask(() => this.onmessage?.({ data: `udp-echo:${data}` }));
        },
        close() { this.readyState = 'closed'; },
      };
      return lastDc;
    }
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n' }; }
    async setLocalDescription(desc) { this.localDescription = desc; }
    async setRemoteDescription(desc) {
      assert.equal(desc.type, 'answer');
      queueMicrotask(() => {
        lastDc.readyState = 'open';
        lastDc.onopen?.();
      });
    }
    close() { this.connectionState = 'closed'; }
  }

  const phases = [];
  const sock = createGameSocket('wss://cs2-ws.apikeygame.top/perf/play/de_dust2/ws', {
    onStatus: ({ phase }) => phases.push(phase),
    WebSocketCtor: MockWebSocket,
    PeerConnectionCtor: MockPeerConnection,
    fetchFn: async (url, init) => {
      assert.equal(url, 'https://cs2-ws.apikeygame.top/perf/play/de_dust2/rtc-offer');
      assert.equal(init.method, 'POST');
      assert.equal(init.headers['Content-Type'], 'text/plain;charset=UTF-8');
      return { ok: true, status: 200, async json() { return { ok: true, type: 'answer', sdp: 'v=0\r\nanswer\r\n' }; } };
    },
  });

  await new Promise((resolve) => sock.addEventListener('open', resolve, { once: true }));
  assert.equal(sock.transportMode, 'UDP');
  assert.equal(wsConstructed, 0);
  assert.deepEqual(phases, ['udp-connecting', 'udp-open']);

  const echoed = new Promise((resolve) => sock.addEventListener('message', (e) => resolve(e.data), { once: true }));
  sock.send('hello-udp');
  assert.equal(await echoed, 'udp-echo:hello-udp');

  // Regression guard for the roomCosmeticsChanged Stage-03 hang:
  // close() must set readyState === 3 immediately AND emit 'close' asynchronously
  // so code running right after close() (like settle(newAppearance)) always wins the race.
  const order = [];
  const closed = new Promise((resolve) => sock.addEventListener('close', () => { order.push('close-event'); resolve(); }, { once: true }));
  sock.close(1000, 'cosmetics');
  order.push('after-close-call');
  assert.equal(sock.readyState, 3);
  await closed;
  assert.deepEqual(order, ['after-close-call', 'close-event']);
});

test('createGameSocket transparently falls back to WebSocket on RTC timeout or non-200 offer', async () => {
  resetRtcBackoff();
  class StalledPeerConnection extends EventTarget {
    constructor() { super(); this.iceGatheringState = 'complete'; }
    createDataChannel() { return { readyState: 'connecting', bufferedAmount: 0, send() {}, close() {} }; }
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\nstalled-offer\r\n' }; }
    async setLocalDescription(desc) { this.localDescription = desc; }
    async setRemoteDescription() {}
    close() {}
  }

  // Timeout fallback (simulating blocked UDP firewall)
  const sock1 = createGameSocket('wss://cs2-ws.apikeygame.top/perf/play/de_dust2/ws', {
    rtcTimeoutMs: 50,
    WebSocketCtor: FakeWebSocket,
    PeerConnectionCtor: StalledPeerConnection,
    fetchFn: async () => ({ ok: true, status: 200, async json() { return { ok: true, type: 'answer', sdp: 'v=0\r\nanswer\r\n' }; } }),
  });
  await new Promise((resolve) => sock1.addEventListener('open', resolve, { once: true }));
  assert.equal(sock1.transportMode, 'WS');
  const msg1 = new Promise((resolve) => sock1.addEventListener('message', (e) => resolve(e.data), { once: true }));
  sock1.send('fallback-ping');
  assert.equal(await msg1, 'ws-echo:fallback-ping');
  sock1.close();

  // Subsequent connection during backoff bypasses RTC immediately without delay
  let fetchCalled = 0;
  const sock2 = createGameSocket('wss://cs2-ws.apikeygame.top/perf/play/de_dust2/ws', {
    WebSocketCtor: FakeWebSocket,
    PeerConnectionCtor: StalledPeerConnection,
    fetchFn: async () => { fetchCalled++; throw new Error('should skip rtc during backoff'); },
  });
  await new Promise((resolve) => sock2.addEventListener('open', resolve, { once: true }));
  assert.equal(sock2.transportMode, 'WS');
  assert.equal(fetchCalled, 0);
  sock2.close();

  // Non-200 (503) fallback after backoff reset + status callback verification
  resetRtcBackoff();
  const fallbackPhases = [];
  const sock3 = createGameSocket('wss://cs2-ws.apikeygame.top/perf/play/de_dust2/ws', {
    onStatus: ({ phase }) => fallbackPhases.push(phase),
    WebSocketCtor: FakeWebSocket,
    PeerConnectionCtor: StalledPeerConnection,
    fetchFn: async () => ({ ok: false, status: 503, async json() { return { ok: false }; } }),
  });
  await new Promise((resolve) => sock3.addEventListener('open', resolve, { once: true }));
  assert.equal(sock3.transportMode, 'WS');
  assert.deepEqual(fallbackPhases, ['udp-connecting', 'ws-fallback', 'ws-open']);
  sock3.close();

  // Explicit markRtcBackoff (used by half-open UDP welcome watchdog) bypasses RTC immediately
  resetRtcBackoff();
  markRtcBackoff(60000);
  let fetchCalled4 = 0;
  const sock4 = createGameSocket('wss://cs2-ws.apikeygame.top/perf/play/de_dust2/ws', {
    WebSocketCtor: FakeWebSocket,
    PeerConnectionCtor: StalledPeerConnection,
    fetchFn: async () => { fetchCalled4++; throw new Error('should skip rtc after markRtcBackoff'); },
  });
  await new Promise((resolve) => sock4.addEventListener('open', resolve, { once: true }));
  assert.equal(sock4.transportMode, 'WS');
  assert.equal(fetchCalled4, 0);
  sock4.close();
  resetRtcBackoff();
});

test('WebRTC UDP DataChannel end-to-end join, delta snapshots, and multi-shard routing', { skip: !installed || !ndc, timeout: 90000 }, async (t) => {
  const udpPort = await pickFreeUdpPort();
  const gateway = spawn(process.execPath, ['server/performance-maps.js'], {
    cwd: repo,
    env: {
      ...process.env,
      PORT: '0',
      PERF_MAP_ROOT: packs,
      PERF_MAX_WORKERS: '4',
      PERF_SHARD_MAPS: 'de_dust2:2',
      PERF_SHARD_TARGET_ROOMS: '1',
      PERF_STRICT_HEAVY_LOCK: '0',
      PERF_RTC_UDP_PORT: String(udpPort),
    },
    stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
    windowsHide: true,
  });
  const exited = once(gateway, 'exit');
  const peers = new Set();
  t.after(async () => {
    for (const pc of peers) {
      try { pc.close(); } catch {}
    }
    if (gateway.connected) gateway.disconnect();
    await exited;
    try { ndc?.cleanup?.(); } catch {}
  });

  let log = '', origin;
  while (!origin) {
    const [chunk] = await once(gateway.stdout, 'data', { signal: AbortSignal.timeout(20000) });
    log += chunk;
    origin = log.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  }

  let health = null;
  for (let i = 0; i < 40; i++) {
    const res = await fetch(origin + '/perf/health', { signal: AbortSignal.timeout(5000) });
    health = await res.json();
    if (health.rtc?.enabled) break;
    await delay(50);
  }
  assert.equal(health.rtc?.enabled, true);
  assert.equal(health.rtc?.udpPort, udpPort);

  const configRes = await fetch(origin + '/perf/play/de_dust2/private-map.json', { signal: AbortSignal.timeout(75000) });
  assert.equal(configRes.status, 200);
  const config = await configRes.json();

  async function openRtcClient() {
    const pc = new ndc.PeerConnection('test-rtc-client-' + peers.size, { iceServers: [] });
    peers.add(pc);
    let localSdp = null;
    let gatherDone = false;
    const candidates = [];
    const offerReady = new Promise((resolve) => {
      const done = () => {
        if (localSdp && gatherDone) setTimeout(resolve, 20);
      };
      pc.onLocalDescription((sdp) => { localSdp = sdp; done(); });
      pc.onLocalCandidate((c) => { if (c) candidates.push(c); });
      pc.onGatheringStateChange((s) => { if (s === 'complete') { gatherDone = true; done(); } });
    });
    const dc = pc.createDataChannel('cs2');
    const dcOpen = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('RTC DataChannel open timeout')), 10000);
      dc.onOpen(() => { clearTimeout(timer); resolve(); });
      pc.onStateChange((s) => { if (s === 'failed') { clearTimeout(timer); reject(new Error('ICE failed')); } });
    });

    await offerReady;
    const offerSdp = localSdp.trimEnd() + '\r\n' + candidates.map((c) => (c.startsWith('a=') ? c : `a=${c}`)).join('\r\n') + '\r\n';
    const res = await fetch(origin + '/perf/play/de_dust2/rtc-offer', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ type: 'offer', sdp: offerSdp }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(res.status, 200);
    const answer = await res.json();
    assert.equal(answer.ok, true);
    assert.equal(answer.type, 'answer');
    assert.ok(!answer.sdp.includes('\r\n\r\n'), 'answer SDP must not contain blank lines (strict Chrome RFC 4566 parser)');
    assert.ok(answer.sdp.includes(String(udpPort)), 'answer SDP should advertise server UDP mux port');
    pc.setRemoteDescription(answer.sdp, 'answer');
    await dcOpen;

    const queue = [];
    const waiters = [];
    dc.onMessage((raw) => {
      const msg = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'));
      const idx = waiters.findIndex((w) => w.pred(msg));
      if (idx >= 0) {
        const [w] = waiters.splice(idx, 1);
        clearTimeout(w.timer);
        w.resolve(msg);
      } else {
        queue.push(msg);
      }
    });
    const nextMsg = (pred, timeoutMs = 10000) => {
      const idx = queue.findIndex(pred);
      if (idx >= 0) return Promise.resolve(queue.splice(idx, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('RTC message timeout')), timeoutMs);
        waiters.push({ pred, resolve, timer });
      });
    };
    return {
      pc,
      dc,
      send(obj) { dc.sendMessage(JSON.stringify(obj)); },
      nextMsg,
      close() {
        try { dc.close(); } catch {}
        try { pc.close(); } catch {}
        peers.delete(pc);
      },
    };
  }

  // Client 1: ping + create room + receive welcome and snapshot
  const c1 = await openRtcClient();
  c1.send({ type: 'ping', time: 4242 });
  const pong = await c1.nextMsg((m) => m.type === 'pong');
  assert.equal(pong.time, 4242);

  c1.send({
    type: 'join',
    mapId: config.id,
    mapSignature: config.mapSignature,
    name: 'RtcHost',
    room: 'RTC101',
    mode: 'deathmatch',
    bots: 0,
    snapshotDelta: 1,
  });
  const w1 = await c1.nextMsg((m) => m.type === 'welcome');
  assert.equal(w1.room, 'RTC101');
  const snap1 = await c1.nextMsg((m) => m.type === 'snapshot' || m.type === 'snapshotDelta');
  assert.ok(snap1.players?.length >= 1 || snap1.type === 'snapshotDelta');

  // Client 2 (legacy UDP without rtcAsyncClose): stale appearanceRevision must still welcome immediately
  // so existing published Toy builds cannot hit the synchronous-close Stage-03 hang.
  const c2 = await openRtcClient();
  c2.send({
    type: 'join',
    mapId: config.id,
    mapSignature: config.mapSignature,
    name: 'RtcLegacyGuest',
    room: 'RTC101',
    existing: true,
    appearanceRevision: '000000000000000000000000',
    mode: 'deathmatch',
    bots: 0,
    snapshotDelta: 1,
  });
  const w2 = await c2.nextMsg((m) => m.type === 'welcome');
  assert.equal(w2.room, 'RTC101');

  // Client 3 (updated UDP with rtcAsyncClose: 1): stale appearanceRevision receives roomCosmeticsChanged as designed.
  const c3 = await openRtcClient();
  c3.send({
    type: 'join',
    mapId: config.id,
    mapSignature: config.mapSignature,
    name: 'RtcUpdatedGuest',
    room: 'RTC101',
    existing: true,
    rtcAsyncClose: 1,
    appearanceRevision: '000000000000000000000000',
    mode: 'deathmatch',
    bots: 0,
    snapshotDelta: 1,
  });
  const changed = await c3.nextMsg((m) => m.type === 'roomCosmeticsChanged');
  assert.equal(changed.room, 'RTC101');
  c3.close();

  const midHealth = await (await fetch(origin + '/perf/health')).json();
  assert.ok(midHealth.rtc.activePeers >= 2);
  assert.ok(midHealth.rtc.opened >= 3);

  c1.close();
  c2.close();
  for (let i = 0; i < 40; i++) {
    const endHealth = await (await fetch(origin + '/perf/health')).json();
    if (endHealth.rtc.activePeers === 0) {
      assert.equal(endHealth.rtc.activePeers, 0);
      return;
    }
    await delay(100);
  }
  const finalHealth = await (await fetch(origin + '/perf/health')).json();
  assert.equal(finalHealth.rtc.activePeers, 0);
});
