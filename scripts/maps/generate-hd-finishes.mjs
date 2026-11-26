/**
 * Generates high-definition, seamlessly tileable 512x512x6 procedural architectural
 * height/detail finishes for the 9 performance arenas.
 *
 * Each layer is engineered for unmistakable visual & tactile differentiation:
 *   0: Dressed concrete / ashlar stone slabs (crisp formwork joints, aggregate speckles, tie holes)
 *   1: Brushed industrial metal (anisotropic brush streaks, clean interior weld seam, neutral edges!)
 *   2: Weathered crate / plank wood (5 pronounced planks, wavy grain fibers, plank tone variation)
 *   3: Troweled lime plaster / stucco (organic soft stucco clouds, micro-pores, ZERO grid lines)
 *   4: Cobble pavers & packed sand/gravel ground (coarse granular grit, worn stone & dust patches)
 *   5: Staggered brickwork / masonry (10x4 crisp courses, deep mortar grooves, aged brick relief)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SIDE = 512;

// [label, worldPeriodMetres, detailContrast]
const RECIPES = [
  ['Architectural concrete ashlar', 2.88, 0.62],
  ['Brushed industrial metal', 1.44, 0.44],
  ['Weathered plank wood', 1.72, 0.60],
  ['Troweled lime plaster', 3.40, 0.36],
  ['Cobble gravel & sand', 2.10, 0.64],
  ['Weathered masonry brick', 2.24, 0.66],
];

// Periodic hash (wraps seamlessly at [periodX, periodY])
function hash2(ix, iy, px, py, seed) {
  const x = ((ix % px) + px) % px;
  const y = ((iy % py) + py) % py;
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smooth(t) {
  return t * t * (3 - 2 * t);
}

// Seamlessly tileable 2D value noise over u,v in [0,1)
function tileNoise(u, v, px, py, seed) {
  const fx = u * px;
  const fy = v * py;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = smooth(fx - ix);
  const ty = smooth(fy - iy);
  const a = hash2(ix, iy, px, py, seed);
  const b = hash2(ix + 1, iy, px, py, seed);
  const c = hash2(ix, iy + 1, px, py, seed);
  const d = hash2(ix + 1, iy + 1, px, py, seed);
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

function fbm(u, v, baseX, baseY, octaves, seed) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let px = baseX;
  let py = baseY;
  for (let o = 0; o < octaves; o++) {
    sum += amp * tileNoise(u, v, px, py, seed + o * 97);
    norm += amp;
    amp *= 0.5;
    px *= 2;
    py *= 2;
  }
  return sum / norm;
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

function mortarMask(coord, width) {
  const f = coord - Math.floor(coord);
  const d = Math.min(f, 1 - f);
  return 1 - smoothstep(width * 0.30, width, d);
}

function generateLayer(index) {
  const buf = new Float32Array(SIDE * SIDE);
  for (let y = 0; y < SIDE; y++) {
    const v = y / SIDE;
    for (let x = 0; x < SIDE; x++) {
      const u = x / SIDE;
      let val = 0.5;

      if (index === 0) {
        // Layer 0: Architectural Concrete / Dressed Ashlar Slabs (3x2 panels + aggregate speckles + recessed joints)
        const rows = 3;
        const cols = 2;
        const row = Math.floor(v * rows);
        const shift = (row % 2) * 0.5;
        const col = Math.floor((u * cols + shift) % cols);
        const blockTone = (hash2(col, row, cols, rows, 11) - 0.5) * 0.16;
        const nCoarse = fbm(u, v, 8, 8, 4, 101) - 0.5;
        const aggregate = fbm(u, v, 36, 36, 3, 211) - 0.5;
        const speckles = tileNoise(u, v, 96, 96, 251) - 0.5;
        const warp = (tileNoise(u, v, 16, 16, 307) - 0.5) * 0.012;
        const hJoint = mortarMask(v * rows + warp, 0.028);
        const vJoint = mortarMask(u * cols + shift + warp, 0.020);
        const seam = Math.max(hJoint, vJoint);
        // Subtle formwork tie-hole dimples in slab centers
        const lu = ((u * cols + shift) % 1 + 1) % 1;
        const lv = (v * rows) % 1;
        const tieDist = Math.min(
          Math.hypot(lu - 0.25, lv - 0.5),
          Math.hypot(lu - 0.75, lv - 0.5),
        );
        const tieHole = (1 - smoothstep(0.018, 0.036, tieDist)) * 0.22;
        const bevel = smoothstep(0.025, 0.09, lv) * (1 - smoothstep(0.09, 0.20, lv)) * 0.07;
        val = 0.54 + blockTone + nCoarse * 0.22 + aggregate * 0.18 + speckles * 0.10 + bevel - seam * 0.40 - tieHole;
      } else if (index === 1) {
        // Layer 1: Brushed Industrial Metal (crisp horizontal anisotropic streaks + subtle interior seam; edges strictly neutral!)
        const streakBroad = fbm(u, v, 4, 48, 3, 401) - 0.5;
        const streakSharp = tileNoise(u, v, 8, 128, 419) - 0.5;
        const scratchFine = tileNoise(u, v, 16, 192, 421) - 0.5;
        const patina = fbm(u, v, 12, 12, 3, 433) - 0.5;
        const sheenWave = Math.sin((u * 2 + v * 2) * Math.PI * 2) * 0.035;
        // Interior panel weld seam at v=0.5 (never touches tile boundary!)
        const midSeam = 1 - smoothstep(0.003, 0.011, Math.abs(v - 0.5));
        const edgeHighlight = (1 - smoothstep(0.011, 0.024, Math.abs(v - 0.515))) * 0.08;
        val = 0.51 + streakBroad * 0.30 + streakSharp * 0.22 + scratchFine * 0.12 + patina * 0.14 + sheenWave + edgeHighlight - midSeam * 0.20;
      } else if (index === 2) {
        // Layer 2: Weathered Crate / Plank Wood (5 pronounced planks + wavy fibrous wood grain + rings + deep grooves)
        const planks = 5;
        const pIdx = Math.floor(v * planks);
        const pShift = hash2(pIdx, 0, planks, 1, 503);
        const pTone = (hash2(pIdx, 1, planks, 2, 521) - 0.5) * 0.22;
        const grain = fbm(u + pShift, v, 4, 40, 4, 541) - 0.5;
        const fiber = tileNoise(u + pShift, v, 12, 128, 563) - 0.5;
        const warp = (tileNoise(u, v, 6, 8, 577) - 0.5) * 0.045;
        const ring = Math.sin((v * planks * 6.5 + grain * 5.2 + warp * 10.0) * Math.PI) * 0.095;
        const seam = mortarMask(v * planks, 0.055);
        // Subtle plank end-joint staggered per plank
        const endU = (u + pShift * 1.37) % 1;
        const endJoint = mortarMask(endU, 0.014) * 0.85;
        const groove = Math.max(seam, endJoint);
        val = 0.54 + pTone + grain * 0.30 + fiber * 0.16 + ring - groove * 0.46;
      } else if (index === 3) {
        // Layer 3: Troweled Lime Plaster / Stucco (soft organic clouds + fine chalk pores; NO hard seams!)
        const trowel = fbm(u, v, 5, 5, 4, 601) - 0.5;
        const sweep = fbm(u * 0.8 + v * 0.2, v, 8, 6, 3, 613) - 0.5;
        const pores = fbm(u, v, 24, 24, 3, 619) - 0.5;
        const fineChalk = tileNoise(u, v, 96, 96, 641) - 0.5;
        val = 0.50 + trowel * 0.32 + sweep * 0.18 + pores * 0.14 + fineChalk * 0.07;
      } else if (index === 4) {
        // Layer 4: Desert Cobble / Gravel & Packed Sand Ground (coarse tactile pebble grit + worn paver joints + wind sand)
        const rows = 6;
        const cols = 4;
        const row = Math.floor(v * rows);
        const shift = (row % 2) * 0.5;
        const col = Math.floor((u * cols + shift) % cols);
        const slabTone = (hash2(col, row, cols, rows, 701) - 0.5) * 0.18;
        const warpX = (tileNoise(u, v, 16, 16, 719) - 0.5) * 0.04;
        const warpY = (tileNoise(u, v, 16, 16, 733) - 0.5) * 0.04;
        const jU = mortarMask(u * cols + shift + warpX, 0.062);
        const jV = mortarMask(v * rows + warpY, 0.072);
        const joint = Math.max(jU, jV);
        const sandRipple = Math.sin((u * 4 + v * 2 + fbm(u, v, 6, 6, 2, 751) * 1.6) * Math.PI * 2) * 0.055;
        const gravel = fbm(u, v, 28, 28, 4, 769) - 0.5;
        const pebble = tileNoise(u, v, 112, 112, 773) - 0.5;
        const sandPatch = smoothstep(0.30, 0.72, fbm(u, v, 4, 4, 3, 787));
        const cobble = 0.55 + slabTone + gravel * 0.28 + pebble * 0.18 - joint * 0.40;
        const sand = 0.49 + sandRipple + gravel * 0.30 + pebble * 0.16;
        val = cobble * (1 - sandPatch * 0.44) + sand * (sandPatch * 0.44);
      } else {
        // Layer 5: Weathered Brickwork / Masonry (10x4 crisp courses + deep recessed mortar + weathered brick relief)
        const rows = 10;
        const cols = 4;
        const row = Math.floor(v * rows);
        const shift = (row % 2) * 0.5;
        const col = Math.floor((u * cols + shift) % cols);
        const brickTone = (hash2(col, row, cols, rows, 809) - 0.5) * 0.24;
        const warp = (tileNoise(u, v, 24, 24, 823) - 0.5) * 0.024;
        const jH = mortarMask(v * rows + warp, 0.095);
        const jV = mortarMask(u * cols + shift + warp, 0.055);
        const mortar = Math.max(jH, jV);
        const rough = fbm(u, v, 28, 28, 4, 839) - 0.5;
        const fine = tileNoise(u, v, 96, 96, 853) - 0.5;
        const plasterPatch = smoothstep(0.64, 0.84, fbm(u, v, 4, 4, 3, 857));
        const brick = 0.56 + brickTone + rough * 0.22 + fine * 0.10 - mortar * 0.48;
        const skim = 0.52 + rough * 0.14;
        val = brick * (1 - plasterPatch * 0.38) + skim * (plasterPatch * 0.38);
      }

      buf[y * SIDE + x] = val;
    }
  }

  // Center mean at 0.50 and quantize to 6-bit [0..63] matching unpack()
  let mean = 0;
  for (let i = 0; i < buf.length; i++) mean += buf[i];
  mean /= buf.length;
  const out = new Uint8Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    out[i] = Math.round(clamp01(buf[i] - mean + 0.5) * 63);
  }
  return out;
}

const layers = RECIPES.map((_, i) => generateLayer(i));
const stack = Buffer.concat(layers.map((l) => Buffer.from(l)));
const sha256 = crypto.createHash('sha256').update(stack).digest('hex');

// Row-delta encode identically to bake-arena-finishes.py
const delta = new Uint8Array(stack.length);
for (let rowStart = 0; rowStart < stack.length; rowStart += SIDE) {
  let prev = 0;
  for (let i = rowStart; i < rowStart + SIDE; i++) {
    delta[i] = (stack[i] - prev) & 255;
    prev = stack[i];
  }
}

const packed = zlib.gzipSync(Buffer.from(delta), { level: 9 }).toString('base64');
const fields = { side: SIDE, finishes: RECIPES, sha256, packed };
const outPath = path.join(ROOT, 'client/arena-finishes/shared.js');
fs.writeFileSync(
  outPath,
  '// Generated by scripts/maps/generate-hd-finishes.mjs\n' +
    Object.entries(fields)
      .map(([k, v]) => `export const ${k}=${JSON.stringify(v)};\n`)
      .join(''),
  'utf8',
);

console.log(
  `Generated HD architectural finishes (${RECIPES.length} x ${SIDE}x${SIDE}): ${Math.round(Buffer.byteLength(packed) / 1024)} KB base64, sha256=${sha256}`,
);
