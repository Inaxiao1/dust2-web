import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameSocket, resetWebSocketBackoff } from '../client/game-socket.js';

test('createGameSocket tries dynamic preferred wsFallbackUrls first and fails over to primary WS on error/timeout', async () => {
  resetWebSocketBackoff();
  const preferredUrl = 'wss://198.51.100.10:3244/perf/play/de_dust2/ws';
  const primaryUrl = 'wss://cs2-ws.apikeygame.top/perf/play/de_dust2/ws';
  const dialed = [];
  let failPreferredMode = null;

  class RoutedWebSocket extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 0;
      this.bufferedAmount = 0;
      dialed.push(url);
      if (url === preferredUrl && failPreferredMode === 'error') {
        queueMicrotask(() => {
          this.readyState = 3;
          this.dispatchEvent(new Event('error'));
          this.dispatchEvent(Object.assign(new Event('close'), { code: 1006, reason: 'connect failed', wasClean: false }));
        });
      } else if (url === preferredUrl && failPreferredMode === 'hang') {
        // Leave connecting forever to trigger wsConnectTimeoutMs failover
      } else {
        queueMicrotask(() => {
          if (this.readyState !== 0) return;
          this.readyState = 1;
          this.dispatchEvent(new Event('open'));
        });
      }
    }
    send(data) {
      queueMicrotask(() => {
        if (this.readyState !== 1) return;
        this.dispatchEvent(Object.assign(new Event('message'), { data: `${this.url}:${data}` }));
      });
    }
    close(code = 1000, reason = '') {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.dispatchEvent(Object.assign(new Event('close'), { code, reason, wasClean: code === 1000 }));
    }
  }

  // 1) Preferred mainland WS healthy -> connects directly to preferredUrl
  const s1 = createGameSocket(primaryUrl, {
    wsFallbackUrls: [preferredUrl],
    WebSocketCtor: RoutedWebSocket,
  });
  await new Promise((resolve) => s1.addEventListener('open', resolve, { once: true }));
  assert.equal(s1.transportMode, 'WS');
  assert.equal(s1.url, preferredUrl);
  assert.deepEqual(dialed, [preferredUrl]);
  s1.close();

  // 2) Preferred WS errors on connect -> automatically fails over to primaryUrl and backs off broken candidate
  dialed.length = 0;
  failPreferredMode = 'error';
  const s2 = createGameSocket(primaryUrl, {
    wsFallbackUrls: [preferredUrl],
    WebSocketCtor: RoutedWebSocket,
  });
  await new Promise((resolve) => s2.addEventListener('open', resolve, { once: true }));
  assert.equal(s2.url, primaryUrl);
  assert.deepEqual(dialed, [preferredUrl, primaryUrl]);
  s2.close();

  // Subsequent connect during backoff skips dead preferredUrl directly
  dialed.length = 0;
  const s3 = createGameSocket(primaryUrl, {
    wsFallbackUrls: [preferredUrl],
    WebSocketCtor: RoutedWebSocket,
  });
  await new Promise((resolve) => s3.addEventListener('open', resolve, { once: true }));
  assert.equal(s3.url, primaryUrl);
  assert.deepEqual(dialed, [primaryUrl]);
  s3.close();

  // 3) Preferred WS hangs -> times out after wsConnectTimeoutMs and fails over to primaryUrl
  resetWebSocketBackoff();
  dialed.length = 0;
  failPreferredMode = 'hang';
  const s4 = createGameSocket(primaryUrl, {
    wsConnectTimeoutMs: 40,
    wsFallbackUrls: [preferredUrl],
    WebSocketCtor: RoutedWebSocket,
  });
  await new Promise((resolve) => s4.addEventListener('open', resolve, { once: true }));
  assert.equal(s4.url, primaryUrl);
  assert.deepEqual(dialed, [preferredUrl, primaryUrl]);
  s4.close();
  resetWebSocketBackoff();
});
