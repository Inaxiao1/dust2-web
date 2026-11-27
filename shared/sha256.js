const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const textEncoder = new TextEncoder();

function toUint8Array(input) {
  if (typeof input === 'string') return textEncoder.encode(input);
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError('Expected string, ArrayBuffer, or ArrayBufferView for SHA-256');
}

function hexWord(word) {
  return (word >>> 0).toString(16).padStart(8, '0');
}

/**
 * Pure-JS FIPS 180-4 SHA-256 returning lowercase 64-char hex.
 * Used automatically when WebCrypto (`crypto.subtle`) is unavailable (e.g. plain HTTP IP origins).
 */
export function sha256HexPure(input) {
  const bytes = toUint8Array(input);
  const len = bytes.length;
  const W = new Int32Array(64);

  let h0 = 0x6a09e667 | 0;
  let h1 = 0xbb67ae85 | 0;
  let h2 = 0x3c6ef372 | 0;
  let h3 = 0xa54ff53a | 0;
  let h4 = 0x510e527f | 0;
  let h5 = 0x9b05688c | 0;
  let h6 = 0x1f83d9ab | 0;
  let h7 = 0x5be0cd19 | 0;

  const processBlock = (buf, offset) => {
    for (let i = 0; i < 16; i++) {
      const j = offset + (i << 2);
      W[i] = (buf[j] << 24) | (buf[j + 1] << 16) | (buf[j + 2] << 8) | buf[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const w15 = W[i - 15];
      const w2 = W[i - 2];
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + W[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }

    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  };

  const fullBlocksEnd = len & ~63;
  for (let offset = 0; offset < fullBlocksEnd; offset += 64) {
    processBlock(bytes, offset);
  }

  const rem = len - fullBlocksEnd;
  const tailLen = rem < 56 ? 64 : 128;
  const tail = new Uint8Array(tailLen);
  if (rem > 0) tail.set(bytes.subarray(fullBlocksEnd));
  tail[rem] = 0x80;

  const bitHi = Math.floor(len / 0x20000000);
  const bitLo = (len << 3) >>> 0;
  const lenOffset = tailLen - 8;
  tail[lenOffset] = (bitHi >>> 24) & 0xff;
  tail[lenOffset + 1] = (bitHi >>> 16) & 0xff;
  tail[lenOffset + 2] = (bitHi >>> 8) & 0xff;
  tail[lenOffset + 3] = bitHi & 0xff;
  tail[lenOffset + 4] = (bitLo >>> 24) & 0xff;
  tail[lenOffset + 5] = (bitLo >>> 16) & 0xff;
  tail[lenOffset + 6] = (bitLo >>> 8) & 0xff;
  tail[lenOffset + 7] = bitLo & 0xff;

  processBlock(tail, 0);
  if (tailLen === 128) processBlock(tail, 64);

  return (
    hexWord(h0) + hexWord(h1) + hexWord(h2) + hexWord(h3) +
    hexWord(h4) + hexWord(h5) + hexWord(h6) + hexWord(h7)
  );
}

/**
 * Compute lowercase hex SHA-256 using native WebCrypto when available,
 * transparently falling back to pure-JS SHA-256 in non-secure HTTP contexts.
 */
export async function sha256Hex(input) {
  const bytes = toUint8Array(input);
  const subtle = globalThis.crypto?.subtle;
  if (subtle && typeof subtle.digest === 'function') {
    try {
      const digest = await subtle.digest('SHA-256', bytes);
      const out = new Uint8Array(digest);
      let hex = '';
      for (let i = 0; i < out.length; i++) {
        hex += out[i].toString(16).padStart(2, '0');
      }
      return hex;
    } catch {
      // Fall through to pure-JS implementation if WebCrypto rejects in restricted webviews.
    }
  }
  return sha256HexPure(bytes);
}
