/**
 * Generates clean, competitive-readability 512x512x6 procedural architectural
 * height/detail finishes for the 9 performance arenas.
 *
 * Designed for crisp CS2/Valorant sightlines — spacious architectural scale,
 * smooth low-frequency tonal variation, restrained mortar seams, and ZERO
 * high-frequency visual clutter or quantization terracing:
 *   0: Broad coursed ashlar stone slabs (4 clean courses, gentle tone variety, soft mortar)
 *   1: Sleek brushed industrial steel panels (subtle fine brush, clean panel seams, neutral outer edges)
 *   2: Clean multi-plank timber (5 varied planks, smooth elongated wood grain, gentle seams)
 *   3: Smooth troweled lime plaster / stucco (broad atmospheric tonal clouds, zero noisy pitting)
 *   4: Clean courtyard flagstones & soft sand (5 spacious stone rows, worn bevels, calm sandy joints)
 *   5: Clean masonry brickwork (8 balanced courses, soft recessed mortar, warm/cool clay shifts)
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
  ['Coursed ashlar stone slabs', 4.45, 0.40],
  ['Brushed industrial steel', 2.40, 0.28],
  ['Weathered multi-plank timber', 2.60, 0.42],
  ['Smooth lime stucco', 5.20, 0.20],
  ['Clean courtyard flagstones', 3.85, 0.40],
  ['Clean masonry brickwork', 3.35, 0.42],
];

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

function tileNoise(u, v, px, py, seed) {
  const fx = ((u % 1) + 1) % 1 * px;
  const fy = ((v % 1) + 1) % 1 * py;
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
  return 1 - smoothstep(width * 0.25, width, d);
}

function sampleIrregularIntervals(t, stops) {
  const w = ((t % 1) + 1) % 1;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (w < b || i === stops.length - 2) {
      const span = Math.max(1e-5, b - a);
      const local = clamp01((w - a) / span);
      const distEdge = Math.min(w - a, b - w);
      return { idx: i, local, distEdge, span };
    }
  }
  return { idx: 0, local: 0, distEdge: 0, span: 1 };
}

// Spacious 4-course ashlar stone slabs (cleaner & calmer than cramped 6-course grids)
const ASHLAR_ROW_STOPS = [0, 0.26, 0.50, 0.77, 1.0];
const ASHLAR_COL_LAYOUTS = [
  [0, 0.38, 0.71, 1.0],
  [0, 0.23, 0.57, 1.0],
  [0, 0.44, 0.78, 1.0],
  [0, 0.30, 0.64, 1.0],
];

// Clean 5-plank timber layout
const PLANK_ROW_STOPS = [0, 0.21, 0.40, 0.62, 0.81, 1.0];

// Spacious 5-course courtyard flagstones (calm, wide architectural paving)
const FLAGSTONE_ROW_STOPS = [0, 0.21, 0.40, 0.61, 0.80, 1.0];
const FLAGSTONE_COL_LAYOUTS = [
  [0, 0.33, 0.68, 1.0],
  [0, 0.24, 0.56, 0.82, 1.0],
  [0, 0.41, 0.73, 1.0],
  [0, 0.28, 0.60, 1.0],
  [0, 0.36, 0.66, 0.88, 1.0],
];

// Balanced 8-course Flemish-bond brick layout
const BRICK_STOPS_A = [0, 0.25, 0.40, 0.65, 0.80, 1.0];
const BRICK_STOPS_B = [0, 0.14, 0.39, 0.54, 0.79, 1.0];

function generateLayer(index) {
  const buf = new Float32Array(SIDE * SIDE);
  for (let y = 0; y < SIDE; y++) {
    const v = y / SIDE;
    for (let x = 0; x < SIDE; x++) {
      const u = x / SIDE;
      let val = 0.5;

      if (index === 0) {
        // Layer 0: Broad Clean Coursed Ashlar Stone Slabs
        const warpU = (fbm(u, v, 4, 4, 2, 307) - 0.5) * 0.005;
        const warpV = (fbm(u, v, 4, 4, 2, 313) - 0.5) * 0.004;
        const rowInfo = sampleIrregularIntervals(v + warpV, ASHLAR_ROW_STOPS);
        const colStops = ASHLAR_COL_LAYOUTS[rowInfo.idx % ASHLAR_COL_LAYOUTS.length];
        const colInfo = sampleIrregularIntervals(u + warpU, colStops);

        const blockTone = (hash2(colInfo.idx, rowInfo.idx, 6, 6, 11) - 0.5) * 0.24;
        const bOffU = hash2(colInfo.idx, rowInfo.idx, 6, 6, 43);
        const bOffV = hash2(colInfo.idx, rowInfo.idx, 6, 6, 61);
        // Smooth broad limestone surface shading only — zero high-frequency noisy clutter!
        const broadCloud = (fbm(u + bOffU, v + bOffV, 4, 4, 2, 101) - 0.5) * 0.09;
        const strata = (fbm(u * 0.5 + bOffU, v * 1.4 + bOffV, 3, 6, 2, 137) - 0.5) * 0.05;

        const jointW = 0.0075;
        const hJoint = 1 - smoothstep(jointW * 0.22, jointW, rowInfo.distEdge);
        const vJoint = 1 - smoothstep(jointW * 0.22, jointW * 0.90, colInfo.distEdge);
        const seam = Math.max(hJoint, vJoint);

        const bevelTop = smoothstep(0.018, 0.065, rowInfo.local) * (1 - smoothstep(0.065, 0.16, rowInfo.local)) * 0.04;
        val = 0.53 + blockTone + broadCloud + strata + bevelTop - seam * 0.22;
      } else if (index === 1) {
        // Layer 1: Sleek Brushed Industrial Steel Panels (outer edges strictly neutral for test invariant!)
        const streakBroad = (fbm(u, v, 3, 20, 2, 401) - 0.5) * 0.11;
        const patina = (fbm(u, v, 4, 4, 2, 433) - 0.5) * 0.08;
        const sheenWave = Math.sin((u + v) * Math.PI * 2) * 0.02;

        const midSeamH = 1 - smoothstep(0.003, 0.009, Math.abs(v - 0.50));
        const subSeamV = v > 0.50
          ? 1 - smoothstep(0.003, 0.008, Math.abs(u - 0.36))
          : 1 - smoothstep(0.003, 0.008, Math.abs(u - 0.68));
        const panelSeam = Math.max(midSeamH, subSeamV * 0.80);
        const edgeHighlight = (1 - smoothstep(0.009, 0.022, Math.abs(v - 0.515))) * 0.04;

        const edgeFade = smoothstep(0.05, 0.15, Math.min(Math.min(u, 1 - u), Math.min(v, 1 - v)));
        const panelDelta = (v > 0.50 ? (u < 0.36 ? 0.045 : -0.035) : (u < 0.68 ? -0.025 : 0.04)) * edgeFade;

        const ru = ((u * 4 + 0.5) % 1) - 0.5;
        const rv = Math.min(Math.abs(v - 0.455), Math.abs(v - 0.545));
        const rivet = (1 - smoothstep(0.004, 0.010, Math.hypot(ru * 0.24, rv))) * 0.055;

        val = 0.50 + panelDelta + streakBroad + patina + sheenWave + edgeHighlight + rivet - panelSeam * 0.16;
      } else if (index === 2) {
        // Layer 2: Clean Multi-Plank Weathered Timber
        const pInfo = sampleIrregularIntervals(v, PLANK_ROW_STOPS);
        const pIdx = pInfo.idx;
        const pShift = hash2(pIdx, 0, 8, 1, 503);
        const pTone = (hash2(pIdx, 1, 8, 2, 521) - 0.5) * 0.22;

        const endU = ((u + pShift * 1.37) % 1 + 1) % 1;
        const boardHalf = endU < 0.5 ? 0 : 1;
        const halfTone = (hash2(pIdx, boardHalf, 8, 2, 533) - 0.5) * 0.08;
        const uShifted = u + pShift + boardHalf * 0.41;

        const grain = (fbm(uShifted, v, 3, 18, 2, 541) - 0.5) * 0.14;
        const lv = pInfo.local;
        const ring = Math.sin((lv * 3.5 + grain * 2.2) * Math.PI) * 0.035;
        const seam = 1 - smoothstep(0.003, 0.0085, pInfo.distEdge);
        const chamfer = smoothstep(0.03, 0.10, lv) * (1 - smoothstep(0.10, 0.22, lv)) * 0.035;
        const endJoint = Math.max(mortarMask(endU, 0.010), mortarMask(endU + 0.5, 0.010)) * 0.70;

        const groove = Math.max(seam, endJoint);
        val = 0.53 + pTone + halfTone + grain + ring + chamfer - groove * 0.28;
      } else if (index === 3) {
        // Layer 3: Ultra-Clean Smooth Lime Plaster / Stucco (broad calm tonal clouds, ZERO noisy grit/pitting!)
        const cloud = (fbm(u, v, 3, 3, 3, 601) - 0.5) * 0.13;
        const sweep = (fbm(u * 0.8 + v * 0.2, v * 0.9 - u * 0.1, 5, 4, 2, 613) - 0.5) * 0.06;
        const softWash = (fbm(u, v, 2, 5, 2, 691) - 0.5) * 0.04;
        val = 0.50 + cloud + sweep + softWash;
      } else if (index === 4) {
        // Layer 4: Clean Spacious Courtyard Flagstones & Calm Sand
        const warpU = (fbm(u, v, 5, 5, 2, 719) - 0.5) * 0.008;
        const warpV = (fbm(u, v, 5, 5, 2, 733) - 0.5) * 0.007;
        const rInfo = sampleIrregularIntervals(v + warpV, FLAGSTONE_ROW_STOPS);
        const cStops = FLAGSTONE_COL_LAYOUTS[rInfo.idx % FLAGSTONE_COL_LAYOUTS.length];
        const cInfo = sampleIrregularIntervals(u + warpU, cStops);

        const slabTone = (hash2(cInfo.idx, rInfo.idx, 8, 8, 701) - 0.5) * 0.24;
        const sOffU = hash2(cInfo.idx, rInfo.idx, 8, 8, 709);
        const sOffV = hash2(cInfo.idx, rInfo.idx, 8, 8, 715);

        const jointW = 0.010;
        const jV = 1 - smoothstep(jointW * 0.22, jointW, rInfo.distEdge);
        const jU = 1 - smoothstep(jointW * 0.22, jointW * 1.0, cInfo.distEdge);
        const joint = Math.max(jU, jV);

        const crown = smoothstep(0.03, 0.20, Math.min(cInfo.local, 1 - cInfo.local)) *
          smoothstep(0.04, 0.20, Math.min(rInfo.local, 1 - rInfo.local)) * 0.045;
        const stoneSoft = (fbm(u + sOffU, v + sOffV, 5, 5, 2, 769) - 0.5) * 0.08;
        const sandPatch = smoothstep(0.45, 0.80, fbm(u, v, 3, 3, 2, 787));

        const cobble = 0.54 + slabTone + crown + stoneSoft - joint * 0.22;
        const sand = 0.47 + (fbm(u, v, 4, 4, 2, 751) - 0.5) * 0.07;
        val = cobble * (1 - sandPatch * 0.32) + sand * (sandPatch * 0.32);
      } else {
        // Layer 5: Clean Balanced Masonry Brickwork (8 courses, calm mortar, smooth clay blocks)
        const rows = 8;
        const warpU = (fbm(u, v, 6, 6, 2, 823) - 0.5) * 0.005;
        const warpV = (fbm(u, v, 6, 6, 2, 827) - 0.5) * 0.004;
        const vScaled = (((v + warpV) % 1) + 1) % 1 * rows;
        const row = Math.floor(vScaled);
        const lv = vScaled - row;
        const stops = row % 2 === 0 ? BRICK_STOPS_A : BRICK_STOPS_B;
        const cInfo = sampleIrregularIntervals(u + warpU, stops);

        const brickTone = (hash2(cInfo.idx, row, 10, 12, 809) - 0.5) * 0.24;
        const bOffU = hash2(cInfo.idx, row, 10, 12, 811);
        const bOffV = hash2(cInfo.idx, row, 10, 12, 821);

        const jH = mortarMask(vScaled, 0.095);
        const jV = 1 - smoothstep(0.0025, 0.010, cInfo.distEdge);
        const mortar = Math.max(jH, jV);

        const edgeRelief = smoothstep(0.08, 0.24, lv) * (1 - smoothstep(0.76, 0.92, lv)) * 0.035;
        const claySoft = (fbm(u + bOffU, v + bOffV, 6, 6, 2, 839) - 0.5) * 0.07;
        const plasterPatch = smoothstep(0.66, 0.86, fbm(u, v, 3, 3, 2, 857));

        const brick = 0.54 + brickTone + edgeRelief + claySoft - mortar * 0.23;
        const skim = 0.50 + claySoft * 0.5;
        val = brick * (1 - plasterPatch * 0.30) + skim * (plasterPatch * 0.30);
      }

      buf[y * SIDE + x] = val;
    }
  }

  // Center mean at 0.50 and quantize to 6-bit [0..63] matching unpack() & flat-map-materials test
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
  `Generated clean architectural finishes (${RECIPES.length} x ${SIDE}x${SIDE}): ${Math.round(Buffer.byteLength(packed) / 1024)} KB base64, sha256=${sha256}`,
);
