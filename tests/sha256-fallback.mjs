import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sha256Hex, sha256HexPure } from '../shared/sha256.js';

function nodeSha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

test('pure-JS SHA-256 matches Node crypto across boundary lengths and binary payloads', async () => {
  const cases = [
    new Uint8Array(0),
    new TextEncoder().encode('abc'),
    new TextEncoder().encode('随时随地CS · de_anubis 私有地图校验'),
    new Uint8Array(55).fill(0x61),
    new Uint8Array(56).fill(0x62),
    new Uint8Array(63).fill(0x63),
    new Uint8Array(64).fill(0x64),
    new Uint8Array(65).fill(0x65),
    new Uint8Array(128).map((_, i) => (i * 37 + 11) & 0xff),
  ];

  // Include a sliced subarray with non-zero byteOffset and a 256 KB binary payload.
  const parent = new Uint8Array(200).map((_, i) => (i * 73 + 5) & 0xff);
  cases.push(parent.subarray(17, 151));

  const large = new Uint8Array(262144);
  for (let i = 0; i < large.length; i++) large[i] = ((i * 1103515245 + 12345) >>> 16) & 0xff;
  cases.push(large);

  for (const sample of cases) {
    const expected = nodeSha256(sample);
    assert.equal(sha256HexPure(sample), expected);
    assert.equal(await sha256Hex(sample), expected);
  }

  assert.equal(sha256HexPure('[]'), nodeSha256('[]'));
  assert.equal(await sha256Hex(large.buffer), nodeSha256(large));
});

test('sha256Hex transparently falls back when crypto.subtle is unavailable (non-HTTPS)', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const payload = new TextEncoder().encode('http://192.0.2.10:3240/perf/play/de_anubis/');
  const expected = nodeSha256(payload);
  try {
    Object.defineProperty(globalThis, 'crypto', {
      value: { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) },
      configurable: true,
      writable: true,
    });
    assert.equal(globalThis.crypto.subtle, undefined);
    assert.equal(await sha256Hex(payload), expected);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
  }
});
