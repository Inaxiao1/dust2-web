import test from 'node:test';
import assert from 'node:assert/strict';
import { ToyIdentity, isToyEnvironment } from '../scripts/maps/mode-ui/toy-identity.js';

function memoryStorage() {
  const map = new Map();
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  };
}

test('isToyEnvironment detects Bilibili Toy hosts and rejects non-Toy hosts', () => {
  assert.equal(isToyEnvironment({ location: { href: 'https://www.bilibilitoy.com/game/cs' } }, {}), true);
  assert.equal(isToyEnvironment({ location: { href: 'https://www.bilibili.com/toy/cs2/index.html' } }, {}), true);
  assert.equal(isToyEnvironment({ location: { href: 'http://127.0.0.1:3240/perf/' } }, { referrer: '' }), false);
});

test('ToyIdentity resolves authenticated Toy OpenID & nickname automatically via SDK', async () => {
  const storage = memoryStorage();
  const sdk = {
    async getUserProfile() {
      return { toyOpenId: 'toy_open_99887766', nickname: '夜露干员', avatar: 'https://i0.hdslb.com/a.jpg' };
    },
  };
  const identity = new ToyIdentity({ sdk, storage, window: { location: { href: 'https://www.bilibilitoy.com/' } }, document: {} });
  const state = await identity.init();
  assert.equal(state.source, 'toy');
  assert.equal(state.authenticated, true);
  assert.equal(state.uid, 'toy_open_99887766');
  assert.equal(state.displayName, '夜露干员');
  assert.equal(state.shortId, '887766');
  assert.equal(state.avatar, 'https://i0.hdslb.com/a.jpg');
});

test('ToyIdentity assigns persistent non-UGC guest operator ID outside Toy environment', async () => {
  const storage = memoryStorage();
  const a = new ToyIdentity({ storage, window: { location: { href: 'http://127.0.0.1:3240/perf/' } }, document: { referrer: '' } });
  const s1 = await a.init();
  assert.equal(s1.source, 'guest');
  assert.match(s1.displayName, /^干员#[A-F0-9]{5}$/);

  const b = new ToyIdentity({ storage, window: { location: { href: 'http://127.0.0.1:3240/perf/' } }, document: { referrer: '' } });
  const s2 = await b.init();
  assert.equal(s2.displayName, s1.displayName);
  assert.equal(s2.uid, s1.uid);
});
