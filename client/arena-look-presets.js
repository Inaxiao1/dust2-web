import {
  DataArrayTexture,
  RGBAFormat,
  RepeatWrapping,
  LinearFilter,
  LinearMipmapLinearFilter,
} from 'three';
import { mobileDevice } from './device-profile.js';
import { preferences } from './persistence.js';

export const VISUAL_STYLE_KEY = 'dust2.visual-style.v1';

/**
 * Two production visual styles sharing a single Float32-computed RGBA8 PBR atlas
 * (0 MB extra VRAM, 0 ms instant in-match switching via 3 vec4 uniforms):
 *   - cinematic   (高精电影, default): richest sandstone/brick/stone/wood relief, crisp mortar depth, dramatic sun/shadow
 *   - competitive (竞技清透): broader clean architectural surfaces, lifted shadow readability, razor-sharp enemy silhouettes
 */
export const VISUAL_STYLE_PRESETS = [
  {
    id: 'cinematic',
    name: '高精电影',
    badge: '默认 · 写实精细',
    summary: '细腻砖石真法线、深邃接缝与层次光影，与竞技档同帧率零掉帧',
    swatch: 'linear-gradient(125deg, #c9975a 0%, #7d5939 52%, #29384a 100%)',
    // lookA: [texScaleMult, normalStrength, albedoContrast, creviceDepth]
    // lookB: [edgeCrispness, propDetail, colorVariety, sunContrast]
    // lookC: [smoothNormalWeight, specStrength, ambientLift, saturation]
    lookA: [1.34, 0.82, 0.76, 0.56],
    lookB: [0.28, 0.72, 1.10, 1.18],
    lookC: [0.34, 1.38, 0.92, 1.10],
  },
  {
    id: 'competitive',
    name: '竞技清透',
    badge: '清晰索敌 · 极简噪点',
    summary: '宽幅顺滑墙面与提亮暗角可读性，轮廓硬朗，人物最易一眼识别',
    swatch: 'linear-gradient(125deg, #dcc498 0%, #98a9b8 55%, #476175 100%)',
    lookA: [0.84, 0.28, 0.38, 0.24],
    lookB: [0.44, 0.26, 0.68, 0.96],
    lookC: [0.10, 0.88, 1.12, 1.04],
  },
];

export const ARENA_PBR_PERIODS = [
  2.95, // 0: Carved ashlar stone / architectural concrete slabs
  2.05, // 1: Brushed industrial steel panels
  2.15, // 2: Fine architectural timber planks
  3.10, // 3: Refined troweled lime plaster / stucco
  2.70, // 4: Worn courtyard paving flagstones & drifted sand
  2.35, // 5: Weathered masonry terracotta brickwork
];

let cachedPbrAtlas = null;

export function normalizeVisualStyle(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'competitive' || raw === 'b') return 'competitive';
  return 'cinematic';
}

export function getVisualStylePreset(id) {
  const norm = normalizeVisualStyle(id);
  return VISUAL_STYLE_PRESETS.find((p) => p.id === norm) || VISUAL_STYLE_PRESETS[0];
}

export function getStoredVisualStyle() {
  try {
    const param = new URLSearchParams(globalThis.location?.search || '').get('look');
    if (param) return normalizeVisualStyle(param);
    const saved = preferences.getItem(VISUAL_STYLE_KEY);
    if (saved) return normalizeVisualStyle(saved);
  } catch {
    // Ignore storage access errors in restricted webviews
  }
  return 'cinematic';
}

export function setStoredVisualStyle(value) {
  const id = normalizeVisualStyle(value);
  globalThis.__CS2_VISUAL_STYLE__ = id;
  try {
    preferences.setItem(VISUAL_STYLE_KEY, id);
  } catch {
    // ignore
  }
  return id;
}

export function applyVisualStyleUniforms(uniforms, styleId) {
  if (!uniforms?.uLookA) return;
  const p = getVisualStylePreset(styleId);
  uniforms.uLookA.value.set(...p.lookA);
  uniforms.uLookB.value.set(...p.lookB);
  uniforms.uLookC.value.set(...p.lookC);
}

/** Updates every live PBR arena material in the scene instantaneously (0 ms, zero recompilation). */
export function applyVisualStyleToScene(root, styleId) {
  const id = normalizeVisualStyle(styleId);
  globalThis.__CS2_VISUAL_STYLE__ = id;
  if (!root?.traverse) return id;
  root.traverse((obj) => {
    if (!obj.isMesh) return;
    for (const mat of [].concat(obj.material || [])) {
      if (!mat?.userData?.arenaPbrEnabled) continue;
      mat.userData.visualStyle = id;
      if (mat.userData.surfaceUniforms) {
        applyVisualStyleUniforms(mat.userData.surfaceUniforms, id);
      }
    }
  });
  return id;
}

function hash2(ix, iy, px, py, seed) {
  const x = ix >= 0 ? ix % px : ((ix % px) + px) % px;
  const y = iy >= 0 ? iy % py : ((iy % py) + py) % py;
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) * 2.3283064365386963e-10;
}

function tileNoise(u, v, px, py, seed) {
  let fu = u - Math.floor(u);
  let fv = v - Math.floor(v);
  fu *= px;
  fv *= py;
  const ix = fu | 0;
  const iy = fv | 0;
  const rx = fu - ix;
  const ry = fv - iy;
  const tx = rx * rx * (3 - 2 * rx);
  const ty = ry * ry * (3 - 2 * ry);
  const a = hash2(ix, iy, px, py, seed);
  const b = hash2(ix + 1, iy, px, py, seed);
  const c = hash2(ix, iy + 1, px, py, seed);
  const d = hash2(ix + 1, iy + 1, px, py, seed);
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
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
    px <<= 1;
    py <<= 1;
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
  const d = f < 1 - f ? f : 1 - f;
  return 1 - smoothstep(width * 0.25, width, d);
}

function sampleIntervals(t, stops) {
  const w = t - Math.floor(t);
  const last = stops.length - 2;
  for (let i = 0; i <= last; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (w < b || i === last) {
      const span = b - a > 1e-5 ? b - a : 1e-5;
      const d1 = w - a;
      const d2 = b - w;
      return { idx: i, local: clamp01(d1 / span), distEdge: d1 < d2 ? d1 : d2 };
    }
  }
  return { idx: 0, local: 0, distEdge: 0 };
}

const ASHLAR_ROWS = [0, 0.21, 0.39, 0.61, 0.80, 1.0];
const ASHLAR_COLS = [
  [0, 0.34, 0.67, 1.0],
  [0, 0.20, 0.53, 0.81, 1.0],
  [0, 0.41, 0.74, 1.0],
  [0, 0.26, 0.58, 1.0],
  [0, 0.31, 0.62, 0.86, 1.0],
];
const PLANK_ROWS = [0, 0.17, 0.33, 0.51, 0.67, 0.84, 1.0];
const FLAG_ROWS = [0, 0.17, 0.32, 0.50, 0.66, 0.83, 1.0];
const FLAG_COLS = [
  [0, 0.29, 0.61, 1.0],
  [0, 0.20, 0.49, 0.78, 1.0],
  [0, 0.36, 0.69, 1.0],
  [0, 0.24, 0.54, 0.84, 1.0],
  [0, 0.33, 0.65, 1.0],
  [0, 0.22, 0.51, 0.76, 1.0],
];
const BRICK_A = [0, 0.23, 0.36, 0.59, 0.72, 0.90, 1.0];
const BRICK_B = [0, 0.12, 0.35, 0.48, 0.71, 0.84, 1.0];

function synthLayer(index, side) {
  const count = side * side;
  const height = new Float32Array(count);
  const albedo = new Float32Array(count);
  const crevice = new Float32Array(count);
  const invSide = 1 / side;

  for (let y = 0; y < side; y++) {
    const v = y * invSide;
    const rowOff = y * side;
    for (let x = 0; x < side; x++) {
      const u = x * invSide;
      const idx = rowOff + x;
      let h = 0.5;
      let a = 0.5;
      let c = 1.0;

      if (index === 0) {
        const wu = (tileNoise(u, v, 6, 6, 107) - 0.5) * 0.006;
        const wv = (tileNoise(u, v, 6, 6, 113) - 0.5) * 0.005;
        const rInfo = sampleIntervals(v + wv, ASHLAR_ROWS);
        const cInfo = sampleIntervals(u + wu, ASHLAR_COLS[rInfo.idx % ASHLAR_COLS.length]);
        const bTone = (hash2(cInfo.idx, rInfo.idx, 8, 8, 17) - 0.5) * 0.24;
        const bOffU = hash2(cInfo.idx, rInfo.idx, 8, 8, 43);
        const bOffV = hash2(cInfo.idx, rInfo.idx, 8, 8, 61);

        const macroStone = (fbm(u + bOffU, v + bOffV, 6, 6, 2, 127) - 0.5) * 0.14;
        const fineSand = (tileNoise(u + bOffU, v + bOffV, 24, 24, 139) - 0.5) * 0.06;
        const microPore = (tileNoise(u, v, 64, 64, 151) - 0.5) * 0.028;
        const strata = (tileNoise(u * 0.5 + bOffU, v * 1.8 + bOffV, 5, 12, 163) - 0.5) * 0.07;

        const jw = 0.0068;
        const jh = 1 - smoothstep(jw * 0.18, jw, rInfo.distEdge);
        const jv = 1 - smoothstep(jw * 0.18, jw * 0.92, cInfo.distEdge);
        const seam = jh > jv ? jh : jv;
        const edgeBevel =
          smoothstep(0.004, 0.022, rInfo.distEdge) *
          smoothstep(0.004, 0.020, cInfo.distEdge);

        h = 0.42 + edgeBevel * 0.24 + bTone * 0.35 + macroStone * 0.55 + strata * 0.5 + fineSand + microPore - seam * 0.36;
        a = 0.52 + bTone + macroStone * 0.85 + strata * 0.75 + fineSand * 0.75 - seam * 0.22;
        c = 1.0 - seam * 0.88;
      } else if (index === 1) {
        const brush = (fbm(u, v, 4, 36, 2, 211) - 0.5) * 0.095;
        const fineBrush = (tileNoise(u, v, 8, 96, 223) - 0.5) * 0.04;
        const patina = (tileNoise(u, v, 5, 5, 229) - 0.5) * 0.07;
        const sh = 1 - smoothstep(0.0025, 0.0075, Math.abs(v - 0.50));
        const sv = v > 0.50
          ? 1 - smoothstep(0.0025, 0.0070, Math.abs(u - 0.36))
          : 1 - smoothstep(0.0025, 0.0070, Math.abs(u - 0.68));
        const seam = sh > sv * 0.85 ? sh : sv * 0.85;
        const ru = ((u * 5 + 0.5) % 1) - 0.5;
        const rv1 = Math.abs(v - 0.455);
        const rv2 = Math.abs(v - 0.545);
        const rv = rv1 < rv2 ? rv1 : rv2;
        const rivet = (1 - smoothstep(0.0035, 0.0085, Math.hypot(ru * 0.20, rv))) * 0.18;
        const panelDelta = v > 0.50 ? (u < 0.36 ? 0.05 : -0.04) : (u < 0.68 ? -0.03 : 0.04);

        h = 0.55 + brush * 0.6 + fineBrush * 0.4 + rivet - seam * 0.35;
        a = 0.50 + panelDelta + brush + fineBrush * 0.6 + patina - seam * 0.18;
        c = 1.0 - seam * 0.80;
      } else if (index === 2) {
        const pInfo = sampleIntervals(v, PLANK_ROWS);
        const pShift = hash2(pInfo.idx, 0, 8, 1, 307);
        const pTone = (hash2(pInfo.idx, 1, 8, 2, 313) - 0.5) * 0.24;
        const endU = (u + pShift * 1.37) - Math.floor(u + pShift * 1.37);
        const half = endU < 0.5 ? 0 : 1;
        const halfTone = (hash2(pInfo.idx, half, 8, 2, 331) - 0.5) * 0.09;
        const uS = u + pShift + half * 0.41;

        const grain = (fbm(uS, v, 3, 28, 2, 347) - 0.5) * 0.18;
        const fiber = (tileNoise(uS, v, 8, 96, 359) - 0.5) * 0.055;
        const ring = Math.sin((pInfo.local * 4.5 + grain * 3.0) * Math.PI) * 0.055;
        const seamH = 1 - smoothstep(0.0022, 0.0072, pInfo.distEdge);
        const seamV = Math.max(mortarMask(endU, 0.008), mortarMask(endU + 0.5, 0.008)) * 0.80;
        const seam = seamH > seamV ? seamH : seamV;
        const bevel = smoothstep(0.004, 0.020, pInfo.distEdge);

        h = 0.44 + bevel * 0.20 + grain * 0.65 + fiber + ring * 0.7 - seam * 0.38;
        a = 0.52 + pTone + halfTone + grain + ring + fiber * 0.6 - seam * 0.26;
        c = 1.0 - seam * 0.90;
      } else if (index === 3) {
        const broad = (fbm(u, v, 4, 4, 2, 401) - 0.5) * 0.16;
        const trowel = (fbm(u * 0.82 + v * 0.18, v * 0.92 - u * 0.12, 8, 6, 2, 419) - 0.5) * 0.09;
        const fineSand = (tileNoise(u, v, 28, 28, 433) - 0.5) * 0.045;
        const microChalk = (tileNoise(u, v, 72, 72, 449) - 0.5) * 0.024;
        h = 0.50 + broad * 0.35 + trowel * 0.45 + fineSand * 0.85 + microChalk * 0.7;
        a = 0.50 + broad * 0.95 + trowel * 0.65 + fineSand * 0.65 + microChalk * 0.35;
        c = 0.96 + (broad + trowel) * 0.12;
      } else if (index === 4) {
        const wu = (tileNoise(u, v, 6, 6, 503) - 0.5) * 0.009;
        const wv = (tileNoise(u, v, 6, 6, 509) - 0.5) * 0.008;
        const rInfo = sampleIntervals(v + wv, FLAG_ROWS);
        const cInfo = sampleIntervals(u + wu, FLAG_COLS[rInfo.idx % FLAG_COLS.length]);
        const sTone = (hash2(cInfo.idx, rInfo.idx, 8, 8, 521) - 0.5) * 0.24;
        const offU = hash2(cInfo.idx, rInfo.idx, 8, 8, 541);
        const offV = hash2(cInfo.idx, rInfo.idx, 8, 8, 547);

        const jw = 0.0092;
        const jh = 1 - smoothstep(jw * 0.20, jw, rInfo.distEdge);
        const jv = 1 - smoothstep(jw * 0.20, jw, cInfo.distEdge);
        const joint = jh > jv ? jh : jv;
        const crown = smoothstep(0.006, 0.032, rInfo.distEdge) * smoothstep(0.006, 0.032, cInfo.distEdge);
        const grit = (fbm(u + offU, v + offV, 16, 16, 2, 563) - 0.5) * 0.08;
        const fine = (tileNoise(u, v, 56, 56, 577) - 0.5) * 0.032;
        const sandPatch = smoothstep(0.42, 0.78, tileNoise(u, v, 3, 3, 587));
        const sandH = 0.44 + (tileNoise(u, v, 10, 10, 593) - 0.5) * 0.05 + fine * 0.6;

        const stoneH = 0.42 + crown * 0.26 + grit * 0.65 + fine - joint * 0.34;
        const stoneA = 0.53 + sTone + grit * 0.85 + fine * 0.5 - joint * 0.22;
        h = stoneH * (1 - sandPatch * 0.38) + sandH * (sandPatch * 0.38);
        a = stoneA * (1 - sandPatch * 0.34) + (0.49 + grit * 0.4) * (sandPatch * 0.34);
        c = 1.0 - joint * (0.82 - sandPatch * 0.35);
      } else {
        const rows = 10;
        const wu = (tileNoise(u, v, 8, 8, 607) - 0.5) * 0.006;
        const wv = (tileNoise(u, v, 8, 8, 613) - 0.5) * 0.005;
        const vWrap = (v + wv) - Math.floor(v + wv);
        const vS = vWrap * rows;
        const row = vS | 0;
        const lv = vS - row;
        const cInfo = sampleIntervals(u + wu, (row & 1) === 0 ? BRICK_A : BRICK_B);
        const bTone = (hash2(cInfo.idx, row, 10, 12, 617) - 0.5) * 0.28;
        const offU = hash2(cInfo.idx, row, 10, 12, 631);
        const offV = hash2(cInfo.idx, row, 10, 12, 641);

        const jh = mortarMask(vS, 0.105);
        const jv = 1 - smoothstep(0.0020, 0.0095, cInfo.distEdge);
        const mortar = jh > jv ? jh : jv;
        const dLv = lv < 1 - lv ? lv : 1 - lv;
        const bevel = smoothstep(0.06, 0.20, dLv) * smoothstep(0.004, 0.018, cInfo.distEdge);
        const clay = (fbm(u + offU, v + offV, 16, 16, 2, 653) - 0.5) * 0.09;
        const pore = (tileNoise(u, v, 64, 64, 661) - 0.5) * 0.032;

        h = 0.38 + bevel * 0.30 + bTone * 0.25 + clay * 0.65 + pore - mortar * 0.38;
        a = 0.53 + bTone + clay * 0.85 + pore * 0.5 - mortar * 0.24;
        c = 1.0 - mortar * 0.90;
      }

      height[idx] = clamp01(h);
      albedo[idx] = clamp01(a);
      crevice[idx] = clamp01(c);
    }
  }

  let meanA = 0;
  for (let i = 0; i < count; i++) meanA += albedo[i];
  meanA /= count;

  const rgba = new Uint8Array(count * 4);
  const normalScale = (index === 3 ? 2.4 : index === 1 ? 2.8 : 4.2) * (side / 512);
  const mask = side - 1;

  for (let y = 0; y < side; y++) {
    const ym = ((y - 1) & mask) * side;
    const y0 = y * side;
    const yp = ((y + 1) & mask) * side;
    for (let x = 0; x < side; x++) {
      const xm = (x - 1) & mask;
      const xp = (x + 1) & mask;
      const idx = y0 + x;
      const tl = height[ym + xm], tc = height[ym + x], tr = height[ym + xp];
      const ml = height[y0 + xm],                      mr = height[y0 + xp];
      const bl = height[yp + xm], bc = height[yp + x], br = height[yp + xp];
      const gx = (tr + 2 * mr + br) - (tl + 2 * ml + bl);
      const gy = (bl + 2 * bc + br) - (tl + 2 * tc + tr);
      const nx = Math.max(-1, Math.min(1, gx * normalScale));
      const ny = Math.max(-1, Math.min(1, gy * normalScale));

      const o = idx << 2;
      rgba[o] = (clamp01(albedo[idx] - meanA + 0.5) * 255 + 0.5) | 0;
      rgba[o + 1] = ((nx * 0.5 + 0.5) * 255 + 0.5) | 0;
      rgba[o + 2] = ((ny * 0.5 + 0.5) * 255 + 0.5) | 0;
      rgba[o + 3] = (crevice[idx] * 255 + 0.5) | 0;
    }
  }

  return rgba;
}

/**
 * Lazily generates and caches one shared RGBA8 Float32-normal PBR DataArrayTexture
 * across all 9 arenas: 512x512x6 (8 MB VRAM) on desktop, 256x256x6 (2 MB VRAM) on mobile.
 */
export function getArenaPbrAtlas() {
  if (cachedPbrAtlas) return cachedPbrAtlas;
  const side = mobileDevice() ? 256 : 512;
  const layerSize = side * side * 4;
  const combined = new Uint8Array(layerSize * ARENA_PBR_PERIODS.length);
  for (let i = 0; i < ARENA_PBR_PERIODS.length; i++) {
    combined.set(synthLayer(i, side), i * layerSize);
  }
  const tex = new DataArrayTexture(combined, side, side, ARENA_PBR_PERIODS.length);
  tex.name = `Arena Float32-computed RGBA8 PBR finishes (${side}x${side}x6)`;
  tex.format = RGBAFormat;
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.anisotropy = 4;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  cachedPbrAtlas = tex;
  return tex;
}
