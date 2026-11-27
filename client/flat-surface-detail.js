import {DataArrayTexture, RedFormat, RepeatWrapping, LinearFilter, LinearMipmapLinearFilter, Vector2, Vector3, Vector4} from 'three';
import {ladderFinishGLSL, shadeLadderGLSL} from './flat-ladder-finish.js';
import assignments from './map-finishes/assignments.json' with {type:'json'};
import {
  getArenaPbrAtlas,
  ARENA_PBR_PERIODS,
  getStoredVisualStyle,
  getSharedVisualStyleUniforms,
} from './arena-look-presets.js';

import arena from './arena-finishes/palette.json' with {type:'json'};
import plates from './plane-finishes.json' with {type:'json'};

let texturePromise, arenaPixels;
async function unpack({side, finishes, packed}) {
  const source = atob(packed);
  const compressed = new Uint8Array(source.length);
  for (let i = 0; i < source.length; ++i) compressed[i] = source.charCodeAt(i);
  let pixels;
  if (typeof DecompressionStream === 'function') {
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
    pixels = new Uint8Array(await new Response(stream).arrayBuffer());
  } else {
    const {gunzipSync} = await import('three/addons/libs/fflate.module.js');
    pixels = gunzipSync(compressed);
  }
  if (pixels.length !== side * side * finishes.length) throw Error('地图材质库长度不符');
  // Restore filtered rows in place. Six-bit tones expand into the GPU R8 layer.
  for (let start = 0; start < pixels.length; start += side) {
    let previous = 0;
    for (let i = start; i < start + side; i++) {
      previous = (previous + pixels[i]) & 255;
      pixels[i] = Math.round(previous * 255 / 63);
    }
  }
  return {pixels, side, finishes};
}

function makeTexture(pixels, side, finishes, profiles) {
  const texture = new DataArrayTexture(pixels, side, side, finishes.length);
  texture.name = 'Original Blender architectural finishes';
  texture.format = RedFormat;
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.anisotropy = 4;
  texture.generateMipmaps = true;
  texture.userData.finishes = finishes;
  texture.userData.profiles = profiles;
  texture.needsUpdate = true;
  return texture;
}

export async function loadFlatSurfaceDetail(mapId) {
  if (Object.hasOwn(arena.mapLayers, mapId)) {
    // Keep the decoded tiles shared while each map owns a disposable GPU texture.
    arenaPixels ??= import('./arena-finishes/shared.js').then(unpack).catch(error => {
      arenaPixels = undefined;
      throw error;
    });
    const {pixels, side, finishes} = await arenaPixels;
    const texture = makeTexture(pixels, side, finishes, {[mapId]:[0,4,1,1,[1,1,1]]});
    texture.name = mapId + ' arena surfaces';
    texture.userData.mapTiles = true;
    return texture;
  }
  texturePromise ??= import('./flat-surface-swatches.js').then(async source => {
    const {pixels,side,finishes} = await unpack(source);
    return makeTexture(pixels,side,finishes,source.profiles);
  }).catch(error => {
    texturePromise = undefined;
    throw error;
  });
  return texturePromise;
}

const finishUniforms = `
  uniform highp sampler2DArray uSurfaceDetail;
  uniform float uFinishScale[FINISH_COUNT];
  uniform float uFinishContrast[FINISH_COUNT];
  uniform int uTagLayer[6];
  uniform bool uFloorSlabs;
  uniform vec4 uMapFinish;
  uniform vec3 uGrainPigment;
  varying vec3 surfaceWorld;
  varying float surfaceClass;
  varying vec3 surfaceSmoothNormal;
  varying float hasSmoothNormal;

  vec2 groundUV(vec3 p) { return p.xz + p.y * vec2(.41,.73); }
  vec2 crossUV(vec3 p) {
    return vec2(-.61*p.x + .79*p.z + .66*p.y, .79*p.x + .61*p.z - .53*p.y) * 1.29;
  }
  float continuousFinish(vec3 p, vec3 dx, vec3 dy, float layer) {
    float first = textureGrad(uSurfaceDetail, vec3(groundUV(p),layer),groundUV(dx),groundUV(dy)).r;
    float crossGrain = textureGrad(uSurfaceDetail,vec3(crossUV(p)+vec2(.27,.63),layer),crossUV(dx),crossUV(dy)).r;
    return mix(first,crossGrain,.28);
  }
  float directionalFinish(vec3 p, vec3 dx, vec3 dy, float layer) {
    vec3 normal = abs(cross(dx,dy));
    float largest = max(max(normal.x,normal.y),max(normal.z,1e-20));
    vec3 weights = smoothstep(vec3(.73),vec3(1.),normal / largest);
    weights /= max(dot(weights,vec3(1.)),1e-10);
    float value = 0.;
    if (weights.x > 0.) value += weights.x * textureGrad(uSurfaceDetail,vec3(p.zy,layer),dx.zy,dy.zy).r;
    if (weights.y > 0.) value += weights.y * textureGrad(uSurfaceDetail,vec3(p.xz,layer),dx.xz,dy.xz).r;
    if (weights.z > 0.) value += weights.z * textureGrad(uSurfaceDetail,vec3(p.xy,layer),dx.xy,dy.xy).r;
    return value;
  }`;

export const MAP_ATMOSPHERE = {
  de_dust2: {
    sunDir: [-0.46, 0.80, 0.38],
    sun: [1.30, 1.15, 0.92],
    sky: [0.66, 0.84, 1.04],
    shadow: [0.54, 0.68, 0.86],
    bounce: [1.06, 0.88, 0.64],
    haze: [0.86, 0.82, 0.74],
    sunGlow: [1.14, 0.96, 0.70],
    accentWarm: [1.14, 1.01, 0.82],
    accentCool: [0.85, 0.91, 0.99],
    fogStrength: 0.24,
    // biomeA: [moss, sandDrift, plasterPeel, rustPatina]
    // biomeB: [stoneVariety, dampBase, grimeStreaks, tileBreak]
    biomeA: [0.04, 0.92, 0.72, 0.28],
    biomeB: [0.86, 0.32, 0.36, 0.84],
    mossColor: [0.16, 0.21, 0.11],
    sandColor: [0.42, 0.32, 0.18],
  },
  de_mirage: {
    sunDir: [-0.56, 0.70, 0.44],
    sun: [1.32, 1.10, 0.86],
    sky: [0.64, 0.82, 1.02],
    shadow: [0.52, 0.62, 0.82],
    bounce: [1.08, 0.82, 0.60],
    haze: [0.88, 0.80, 0.71],
    sunGlow: [1.18, 0.90, 0.64],
    accentWarm: [1.18, 0.96, 0.78],
    accentCool: [0.84, 0.90, 1.00],
    fogStrength: 0.26,
    biomeA: [0.08, 0.80, 0.80, 0.22],
    biomeB: [0.90, 0.36, 0.32, 0.85],
    mossColor: [0.15, 0.22, 0.12],
    sandColor: [0.41, 0.29, 0.17],
  },
  de_anubis: {
    sunDir: [0.56, 0.70, -0.44],
    sun: [1.34, 1.14, 0.86],
    sky: [0.60, 0.86, 1.04],
    shadow: [0.46, 0.68, 0.82],
    bounce: [1.10, 0.89, 0.62],
    haze: [0.88, 0.83, 0.72],
    sunGlow: [1.20, 0.96, 0.64],
    accentWarm: [1.19, 0.98, 0.76],
    accentCool: [0.80, 0.94, 0.99],
    fogStrength: 0.29,
    biomeA: [0.22, 0.86, 0.76, 0.20],
    biomeB: [0.95, 0.46, 0.32, 0.88],
    mossColor: [0.13, 0.23, 0.17],
    sandColor: [0.41, 0.30, 0.16],
  },
  de_inferno: {
    sunDir: [0.60, 0.66, 0.45],
    sun: [1.28, 1.09, 0.88],
    sky: [0.68, 0.82, 1.00],
    shadow: [0.54, 0.62, 0.80],
    bounce: [1.04, 0.82, 0.66],
    haze: [0.85, 0.81, 0.76],
    sunGlow: [1.16, 0.92, 0.68],
    accentWarm: [1.18, 0.94, 0.80],
    accentCool: [0.84, 0.90, 0.98],
    fogStrength: 0.27,
    biomeA: [0.38, 0.22, 0.70, 0.20],
    biomeB: [0.94, 0.56, 0.38, 0.86],
    mossColor: [0.15, 0.22, 0.10],
    sandColor: [0.33, 0.25, 0.17],
  },
  de_nuke: {
    sunDir: [-0.38, 0.84, 0.38],
    sun: [1.16, 1.15, 1.14],
    sky: [0.72, 0.88, 1.06],
    shadow: [0.54, 0.66, 0.82],
    bounce: [0.84, 0.90, 0.96],
    haze: [0.76, 0.84, 0.92],
    sunGlow: [1.04, 1.06, 1.10],
    accentWarm: [1.08, 1.02, 0.92],
    accentCool: [0.85, 0.93, 1.06],
    fogStrength: 0.22,
    biomeA: [0.06, 0.08, 0.14, 0.36],
    biomeB: [0.62, 0.36, 0.44, 0.78],
    mossColor: [0.13, 0.19, 0.13],
    sandColor: [0.22, 0.23, 0.24],
  },
  de_vertigo: {
    sunDir: [0.52, 0.74, 0.42],
    sun: [1.20, 1.16, 1.10],
    sky: [0.72, 0.90, 1.08],
    shadow: [0.56, 0.68, 0.86],
    bounce: [0.90, 0.91, 0.94],
    haze: [0.79, 0.87, 0.96],
    sunGlow: [1.08, 1.05, 0.98],
    accentWarm: [1.10, 1.03, 0.92],
    accentCool: [0.86, 0.94, 1.05],
    fogStrength: 0.24,
    biomeA: [0.02, 0.16, 0.18, 0.30],
    biomeB: [0.66, 0.28, 0.38, 0.78],
    mossColor: [0.15, 0.20, 0.14],
    sandColor: [0.29, 0.27, 0.24],
  },
  de_train: {
    sunDir: [-0.34, 0.85, 0.40],
    sun: [1.12, 1.10, 1.08],
    sky: [0.70, 0.80, 0.94],
    shadow: [0.50, 0.59, 0.74],
    bounce: [0.86, 0.84, 0.84],
    haze: [0.74, 0.79, 0.85],
    sunGlow: [0.98, 0.98, 1.00],
    accentWarm: [1.12, 0.98, 0.86],
    accentCool: [0.84, 0.92, 1.04],
    fogStrength: 0.30,
    biomeA: [0.24, 0.12, 0.44, 0.86],
    biomeB: [0.80, 0.64, 0.70, 0.84],
    mossColor: [0.13, 0.19, 0.11],
    sandColor: [0.20, 0.19, 0.17],
  },
  de_cache: {
    sunDir: [-0.50, 0.76, 0.41],
    sun: [1.18, 1.14, 1.00],
    sky: [0.72, 0.86, 0.96],
    shadow: [0.54, 0.64, 0.72],
    bounce: [0.88, 0.88, 0.78],
    haze: [0.78, 0.82, 0.79],
    sunGlow: [1.08, 1.02, 0.86],
    accentWarm: [1.12, 1.02, 0.85],
    accentCool: [0.84, 0.95, 0.91],
    fogStrength: 0.25,
    biomeA: [0.62, 0.18, 0.56, 0.76],
    biomeB: [0.84, 0.62, 0.64, 0.86],
    mossColor: [0.15, 0.23, 0.10],
    sandColor: [0.24, 0.22, 0.16],
  },
  de_ancient: {
    sunDir: [0.42, 0.78, -0.46],
    sun: [1.22, 1.18, 0.94],
    sky: [0.64, 0.86, 0.88],
    shadow: [0.44, 0.62, 0.66],
    bounce: [0.84, 0.90, 0.70],
    haze: [0.70, 0.80, 0.74],
    sunGlow: [1.08, 1.06, 0.78],
    accentWarm: [1.16, 1.04, 0.79],
    accentCool: [0.78, 0.95, 0.87],
    fogStrength: 0.32,
    biomeA: [0.90, 0.22, 0.48, 0.16],
    biomeB: [0.95, 0.68, 0.58, 0.90],
    mossColor: [0.15, 0.24, 0.09],
    sandColor: [0.24, 0.20, 0.13],
  },
};

export function getMapAtmosphere(mapId) {
  return MAP_ATMOSPHERE[mapId] || MAP_ATMOSPHERE.de_dust2;
}

const arenaUniforms = `
  uniform vec3 uArenaBase[6];
  uniform vec3 uArenaKey;
  uniform vec3 uArenaLuma;
  uniform vec2 uSourcePlates[7];
  uniform vec3 uSunTint;
  uniform vec3 uSkyFill;
  uniform vec3 uShadowTint;
  uniform vec3 uGroundBounce;
  uniform vec3 uHazeColor;
  uniform vec3 uSunGlow;
  uniform vec3 uAccentWarm;
  uniform vec3 uAccentCool;
  uniform vec4 uBiomeA;
  uniform vec4 uBiomeB;
  uniform vec3 uMossColor;
  uniform vec3 uSandColor;
  uniform float uFogStrength;
  uniform float uHighQuality;
  varying vec2 vBakedLight;
  varying float vHasBakedLight;

  vec3 arenaNormal(vec3 n) {
    return n * inversesqrt(max(dot(n,n),1e-20));
  }

  vec3 srgbToLin(vec3 c) {
    return pow(max(c, vec3(0.0001)), vec3(2.2));
  }

  // Rotated irrational-scale macro lookup in the ALREADY-bound uSurfaceDetail atlas (1 lookup):
  // breaks up visible wallpaper tiling over 10-30m facades & courtyards and drives crisp organic
  // masks for jungle moss, peeling stucco, wind-blown sand drifts, and rust patina.
  float macroSurfaceSample(vec3 p, vec3 dx, vec3 dy, float macroLayer) {
    const float sc = 0.095;
    vec3 mp = p * sc;
    vec3 mdx = dx * sc;
    vec3 mdy = dy * sc;
    // Rotate 37 degrees around Y so macro features never align with primary tile seams
    vec2 uv  = vec2(0.80 * mp.x - 0.60 * mp.z + 0.47 * mp.y, 0.60 * mp.x + 0.80 * mp.z - 0.39 * mp.y);
    vec2 dux = vec2(0.80 * mdx.x - 0.60 * mdx.z + 0.47 * mdx.y, 0.60 * mdx.x + 0.80 * mdx.z - 0.39 * mdx.y);
    vec2 duy = vec2(0.80 * mdy.x - 0.60 * mdy.z + 0.47 * mdy.y, 0.60 * mdy.x + 0.80 * mdy.z - 0.39 * mdy.y);
    return textureGrad(uSurfaceDetail, vec3(uv + vec2(0.31, 0.17), macroLayer), dux, duy).r;
  }

  // Multi-octave organic world-space variation fields:
  // x = macro architectural weathering/moisture, y = broad warm/cool color zone drift, z = medium patch variation
  vec3 macroWeather3(vec3 p, float macroTex) {
    float a = sin(p.x * 0.27 + p.z * 0.19 + sin(p.y * 0.41) * 1.4);
    float b = sin(p.x * 0.11 - p.z * 0.23 + p.y * 0.17);
    float c = sin((p.x + p.z) * 0.53 - p.y * 0.31);
    float w1 = (a * 0.45 + b * 0.35 + c * 0.20) * 0.5 + 0.5;

    float d1 = sin(p.x * 0.17 - p.z * 0.31 + sin(p.x * 0.08 + p.z * 0.09) * 1.6);
    float d2 = cos(p.x * 0.09 + p.z * 0.14 - p.y * 0.24);
    float w2 = (d1 * 0.58 + d2 * 0.42) * 0.5 + 0.5;

    float m1 = sin(p.x * 0.74 - p.z * 0.63 + p.y * 0.52);
    float m2 = cos(p.x * 0.49 + p.z * 0.81 - p.y * 0.37);
    float w3 = clamp(((m1 * 0.55 + m2 * 0.45) * 0.5 + 0.5) * 0.58 + macroTex * 0.42, 0.0, 1.0);
    return vec3(clamp(mix(w1, macroTex, 0.44), 0.0, 1.0), w2, w3);
  }

  // Extracts fallback GI cues from Source 2 vertex luminance when raytraced lightmap is absent,
  // or blends gently with real raytraced (sunVis, ao) for fine prop detail.
  vec2 extractBakedGI(float luminance, vec2 cuts) {
    float lowShadow = smoothstep(0.008, max(cuts.x * 1.18, 0.12), luminance);
    float midLight  = smoothstep(cuts.x * 0.50, max(cuts.y * 1.22, 0.26), luminance);
    float hiSun     = smoothstep(cuts.x * 0.90, max(cuts.y * 1.35, 0.34), luminance);
    float ao = 0.22 + 0.38 * lowShadow + 0.42 * midLight;
    float sunMask = clamp(0.04 + 0.52 * midLight + 0.44 * hiSun, 0.0, 1.0);
    return vec2(ao, sunMask);
  }

  // Combines offline raytraced BVH lightmap (sunVis, hemisphere AO) with subtle Source 2 detail.
  vec2 resolveBakedGI(float luminance, vec2 cuts) {
    vec2 srcGI = extractBakedGI(luminance, cuts);
    if (vHasBakedLight > 0.5) {
      float raySun = vBakedLight.x;
      float rayAO = vBakedLight.y;
      float ao = clamp(mix(0.18, 1.05, pow(rayAO, 0.95)) * mix(0.80, 1.10, srcGI.x), 0.14, 1.08);
      float sun = clamp(raySun * mix(0.78, 1.04, srcGI.y), 0.0, 1.0);
      return vec2(ao, sun);
    }
    return srcGI;
  }

  // Multi-material architectural color & biome overlay engine:
  //   - Per-block / per-stone / per-brick / per-plank chromatic split (locked 100% to mortar boundaries!)
  //   - Per-map biome overlays: jungle moss/lichen, wind-blown desert sand drifts, peeling stucco->brick,
  //     damp wall bases, rain-drip grime streaks & oxidized iron rust patina!
  // Returns modified linear albedo AND outputs extra roughness/moss/peel hints via inout float detail.
  vec3 applyArchitecturalColorVariation(
    vec3 pigment, vec3 worldPos, vec3 N, inout float detail, float macroTex, vec3 weather, float bakedAO, int layer
  ) {
    float macro = weather.x;
    float drift = weather.y;
    float patchVal = weather.z;
    float variety = uBiomeB.x;

    // Per-block tone split derived gently from each block's height tone (clean architectural variation, zero visual clutter)
    float blockVar = clamp((detail - 0.5) * 1.55, -0.40, 0.40);
    float grooveMask = 1.0 - smoothstep(0.18, 0.36, detail);

    vec3 warmLin = mix(vec3(1.0), uAccentWarm, 0.80);
    vec3 coolLin = mix(vec3(1.0), uAccentCool, 0.80);
    // Clean mineral temperature split: warm sunlit stone/stucco alongside subtle cool shaded blocks
    float mineralMix = clamp(drift * 0.48 + patchVal * 0.32 + blockVar * 0.48 + 0.14, 0.0, 1.0);
    vec3 tempShift = mix(coolLin, warmLin, mineralMix);

    float upFace = smoothstep(0.55, 0.90, N.y);
    float slopeFace = smoothstep(0.18, 0.65, N.y);
    float vertGrad = smoothstep(-2.5, 5.2, worldPos.y);
    float lowWall = (1.0 - upFace) * (1.0 - vertGrad);
    float rainStreak = sin(worldPos.x * 0.85 + worldPos.z * 0.78 + macroTex * 3.0) * 0.5 + 0.5;
    float grimeBand = (1.0 - upFace) * smoothstep(0.45, 0.88, rainStreak) * smoothstep(0.35, 0.82, macro) * uBiomeB.z * 0.45;

    // Biome jungle/coastal moss & lichen mask (clean, restrained & localized to damp crevices/ledges)
    float dampBias = clamp((1.0 - bakedAO) * 0.65 + lowWall * 0.52 + slopeFace * 0.38 + grooveMask * 0.38, 0.0, 1.20);
    float mossNoise = smoothstep(0.46, 0.80, macro * 0.58 + patchVal * 0.42 + (dampBias - 0.48) * 0.34);
    float mossMask = clamp(mossNoise * uBiomeA.x * (0.28 + 0.62 * dampBias), 0.0, 0.64);

    // Subtle anti-tiling modulation (gentle enough to break wallpaper repetition without adding noise)
    float antiTile = (macroTex - 0.5) * 0.10 * uBiomeB.w;
    detail = clamp(detail + antiTile * (1.0 - grooveMask * 0.78), 0.08, 0.92);

    if (layer == 0) {
      // Ashlar stone & architectural concrete: clean multi-tone blocks + subtle damp base & moss
      vec3 stoneAccent = mix(coolLin * vec3(0.89, 0.91, 0.95), warmLin * vec3(1.11, 1.02, 0.90), mineralMix);
      pigment *= mix(vec3(1.0), stoneAccent, 0.68 * variety);
      float paleStone = smoothstep(0.68, 0.90, patchVal * 0.55 + (detail - 0.38) * 0.65) * variety;
      pigment = mix(pigment, pigment * vec3(1.14, 1.11, 1.05), paleStone * 0.28);
      pigment *= 0.92 + macro * 0.16;
      pigment = mix(pigment, pigment * vec3(0.76, 0.75, 0.71), lowWall * 0.24 * uBiomeB.y);
      pigment = mix(pigment, pigment * vec3(0.82, 0.82, 0.79), grimeBand * 0.22);
      pigment = mix(pigment, mix(pigment * warmLin * 1.05, uSandColor, 0.30 * uBiomeA.y), upFace * 0.28);
      vec3 mossTone = mix(uMossColor * 0.86, uMossColor * 1.28, smoothstep(0.28, 0.78, patchVal));
      pigment = mix(pigment, mossTone, mossMask * 0.62);
    } else if (layer == 5) {
      // Clean masonry brickwork: tasteful warm terracotta / pale clay brick variety + subtle plaster
      float brickMix = clamp(0.48 + blockVar * 0.88 + (patchVal - 0.5) * 0.48, 0.0, 1.0);
      vec3 darkKiln = coolLin * vec3(0.76, 0.70, 0.68);
      vec3 terracotta = warmLin * vec3(1.20, 0.93, 0.76);
      vec3 paleClay = warmLin * vec3(1.16, 1.08, 0.94);
      vec3 brickTint = mix(mix(darkKiln, terracotta, smoothstep(0.0, 0.62, brickMix)), paleClay, smoothstep(0.62, 1.0, brickMix));
      pigment *= mix(vec3(1.0), brickTint, 0.72 * variety);
      pigment *= 0.92 + macro * 0.16;
      float skimMask = smoothstep(0.68, 0.86, macro * 0.65 + patchVal * 0.35) * uBiomeA.z * 0.42;
      vec3 plasterBase = srgbToLin(uArenaBase[3]) * (0.90 + patchVal * 0.16);
      pigment = mix(pigment, plasterBase, skimMask);
      detail = mix(detail, 0.51 + (macroTex - 0.5) * 0.08, skimMask * 0.55);
      pigment = mix(pigment, pigment * vec3(0.78, 0.76, 0.73), lowWall * 0.22 * uBiomeB.y);
      pigment = mix(pigment, uMossColor * 1.05, mossMask * 0.48);
    } else if (layer == 4) {
      // Clean courtyard flagstones & calm desert sand drifts
      float stonePick = clamp(0.50 + blockVar * 0.82 + (patchVal - 0.5) * 0.42, 0.0, 1.0);
      vec3 slateSlab = pigment * coolLin * vec3(0.84, 0.87, 0.91);
      vec3 buffSlab = pigment * warmLin * vec3(1.10, 1.03, 0.93);
      vec3 roseSlab = pigment * warmLin * vec3(1.12, 0.96, 0.87);
      vec3 stoneTone = mix(mix(slateSlab, buffSlab, smoothstep(0.0, 0.68, stonePick)), roseSlab, smoothstep(0.68, 1.0, stonePick));
      float sandDrift = smoothstep(0.45, 0.82, drift * 0.55 + macroTex * 0.45) * uBiomeA.y;
      float jointSand = grooveMask * uBiomeA.y * 0.55;
      float sandMask = clamp(sandDrift * 0.58 + jointSand * 0.42, 0.0, 0.72);
      vec3 sandTone = mix(pigment * warmLin * 1.08, uSandColor * (0.92 + patchVal * 0.18), 0.55);
      pigment = mix(stoneTone, sandTone, sandMask);
      detail = mix(detail, 0.49 + (macroTex - 0.5) * 0.10, sandDrift * 0.48);
      float jointMoss = clamp((grooveMask * 0.60 + smoothstep(0.50, 0.82, macro) * 0.45) * uBiomeA.x * (0.45 + 0.55 * (1.0 - bakedAO)), 0.0, 0.62);
      pigment = mix(pigment, mix(uMossColor * 0.88, uMossColor * 1.24, patchVal), jointMoss);
      pigment *= 0.92 + macro * 0.16;
    } else if (layer == 2) {
      // Clean weathered timber planks
      float plankPick = clamp(0.50 + blockVar * 0.88 + (patchVal - 0.5) * 0.34, 0.0, 1.0);
      vec3 darkWalnut = vec3(0.70, 0.58, 0.48);
      vec3 honeyCedar = vec3(1.18, 1.00, 0.78);
      vec3 sunDriftwood = vec3(0.98, 0.94, 0.88);
      vec3 woodShift = mix(mix(darkWalnut, honeyCedar, smoothstep(0.0, 0.70, plankPick)), sunDriftwood, smoothstep(0.70, 1.0, plankPick));
      pigment *= mix(vec3(1.0), woodShift, 0.68);
      pigment *= 0.93 + macro * 0.14;
      pigment = mix(pigment, uMossColor * 0.95, mossMask * 0.28);
    } else if (layer == 3) {
      // Smooth architectural lime plaster / stucco (clean readable walls, subtle tonal wash)
      pigment *= mix(vec3(1.0), tempShift, 0.62 * variety);
      pigment *= 0.93 + macro * 0.14;
      pigment = mix(pigment, mix(pigment * 0.82, uSandColor, 0.28 * uBiomeA.y), lowWall * 0.22 * uBiomeB.y);
      pigment = mix(pigment, pigment * vec3(0.84, 0.83, 0.80), grimeBand * 0.20);
      pigment = mix(pigment, pigment * warmLin * 1.04, upFace * 0.18);
      float peelMask = smoothstep(0.70, 0.86, macro * 0.60 + patchVal * 0.40) * uBiomeA.z * 0.36;
      vec3 underBrick = srgbToLin(uArenaBase[5]) * mix(vec3(0.90, 0.84, 0.78), warmLin * vec3(1.10, 0.95, 0.82), patchVal);
      pigment = mix(pigment, underBrick, peelMask);
      pigment = mix(pigment, uMossColor * 1.02, mossMask * 0.42);
    } else if (layer == 1) {
      // Sleek industrial steel with restrained patina & localized rust
      vec3 steelBase = mix(vec3(0.86, 0.94, 1.06), vec3(1.06, 1.03, 0.97), patchVal * 0.55);
      pigment *= steelBase;
      float rustMask = smoothstep(0.58, 0.86, macro * 0.60 + patchVal * 0.40 + (1.0 - bakedAO) * 0.18) * uBiomeA.w;
      vec3 rustColor = mix(vec3(0.28, 0.12, 0.06), vec3(0.40, 0.19, 0.09), patchVal);
      pigment = mix(pigment, rustColor, rustMask * 0.50);
    }
    return pigment;
  }

  // True physical LINEAR-space PBR + raytraced baked GI shading:
  //   Real cast shadows + 16-ray corner AO + clean quantization-free subtle relief for crisp FPS readability!
  vec3 shadeMaterialPBR(
    vec3 pigmentLin, vec3 N, vec3 viewDir, float bakedAO, float sunVis, float heightVal,
    float metallic, float specPower, float specAmt, float bumpStrength,
    float wrapDiffuse, float creviceDepth, vec3 creviceTintLin
  ) {
    vec3 bumpN = N;
    if (bumpStrength > 0.005) {
      float viewDist = length(cameraPosition - surfaceWorld);
      float distFade = 1.0 - smoothstep(9.0, 24.0, viewDist);
      float effBump = bumpStrength * distFade;
      if (effBump > 0.004) {
        vec3 dPosX = dFdx(surfaceWorld);
        vec3 dPosY = dFdy(surfaceWorld);
        float dHx = dFdx(heightVal);
        float dHy = dFdy(heightVal);
        vec3 surfGrad = cross(dPosY, N) * dHx + cross(N, dPosX) * dHy;
        float det = dot(dPosX, cross(dPosY, N));
        if (abs(det) > 1e-8) {
          // Softly clamp gradient so 6-bit height steps NEVER produce topographic contour ridges!
          vec3 clampedGrad = clamp(surfGrad / det, vec3(-0.38), vec3(0.38));
          bumpN = arenaNormal(N - effBump * clampedGrad);
        }
      }
    }

    float ndl = dot(bumpN, uArenaKey);
    float keyFacing = smoothstep(-0.08 - wrapDiffuse * 0.18, 0.62, ndl);
    // True cast-shadow sun term: strictly 0.0 inside real raytraced shadows!
    float directSun = keyFacing * sunVis;

    // Linear 3-way atmospheric GI ambient: keep sky/shadow/bounce chromaticity natural
    float upFactor = clamp(bumpN.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 skyLin = uSkyFill * 0.54;
    vec3 bounceLin = uGroundBounce * 0.48;
    vec3 shadowLin = uShadowTint * 0.42;
    vec3 hemi = mix(bounceLin * 0.72, skyLin * 0.96, upFactor);
    float oppFacing = max(-ndl, 0.0);
    vec3 bounceRim = bounceLin * (0.14 + 0.26 * oppFacing) * (0.30 + 0.70 * bakedAO) * (1.0 - 0.42 * upFactor);
    vec3 ambientGI = mix(shadowLin * 0.84, hemi, 0.34 + 0.66 * bakedAO) + bounceRim;

    // Warm crisp directional sunlight in linear radiometric intensity
    vec3 sunLin = uSunTint * 1.44;
    vec3 totalLight = ambientGI * (0.38 + 0.62 * bakedAO) + sunLin * directSun * (0.42 + 0.58 * bakedAO);

    // Restrained crevice micro-occlusion (soft architectural joints without heavy dark outlines)
    float grooveMask = 1.0 - smoothstep(0.18, 0.40, heightVal);
    vec3 shadedPigment = mix(pigmentLin, creviceTintLin, grooveMask * creviceDepth);
    float microAO = mix(1.0 - creviceDepth * 0.30, 1.04, clamp(heightVal * 1.24 - 0.12, 0.0, 1.0));
    vec3 lit = shadedPigment * mix(1.0, 0.66, metallic) * totalLight * microAO;

    // Micro-specular & grazing Fresnel sky sheen (only gleams where sun actually hits!)
    float ndv = max(dot(bumpN, viewDir), 0.0);
    float fresnel = pow(1.0 - ndv, mix(3.6, 4.4, metallic));
    vec3 H = arenaNormal(uArenaKey + viewDir);
    float ndh = max(dot(bumpN, H), 0.0);
    float roughMod = mix(0.84, 1.18, clamp(heightVal * 1.24 - 0.12, 0.0, 1.0));
    vec3 specTint = mix(sunLin, mix(sunLin, pigmentLin * 2.2 + vec3(0.08), 0.58), metallic);
    float spec = pow(ndh, specPower) * specAmt * roughMod * (0.45 + 0.90 * fresnel) * directSun * (0.45 + 0.55 * bakedAO);
    lit += specTint * spec;

    // Subtle grazing sky rim & metallic environment reflection in linear space
    if (metallic <= 0.01) {
      float rimMask = fresnel * (0.30 + 0.70 * upFactor) * bakedAO;
      lit += skyLin * (0.042 + 0.025 * uHighQuality) * rimMask * (0.72 + 0.28 * heightVal);
    } else {
      vec3 reflDir = reflect(-viewDir, bumpN);
      vec3 envRefl = mix(bounceLin * 0.65, skyLin * 1.35, smoothstep(-0.25, 0.55, reflDir.y));
      vec3 f0 = mix(vec3(0.04), pigmentLin * 0.88 + vec3(0.08), metallic);
      lit += envRefl * f0 * (0.18 + 0.65 * fresnel) * metallic * (0.68 + 0.40 * heightVal) * bakedAO;
    }

    return lit;
  }

  vec3 desertLitFinish(vec3 pigmentLin, vec3 N, vec3 viewDir, float bakedAO, float sunVis, float heightVal, int layer) {
    float hqBoost = mix(1.0, 1.12, uHighQuality);
    float metallic    = (layer == 1) ? 0.82 : 0.0;
    float specPower   = (layer == 1) ? 58.0 : (layer == 2) ? 28.0 : (layer == 4) ? 20.0 : (layer == 0) ? 16.0 : (layer == 5) ? 12.0 : 8.0;
    float specAmt     = ((layer == 1) ? 0.40 : (layer == 2) ? 0.10 : (layer == 4) ? 0.065 : (layer == 0) ? 0.040 : (layer == 5) ? 0.028 : 0.014) * mix(1.0, 1.18, uHighQuality);
    // Clean, restrained bump strength — eliminates noisy crumpled-foil relief while keeping tactile depth!
    float bumpStr     = ((layer == 1) ? 0.035 : (layer == 2) ? 0.070 : (layer == 3) ? 0.018 : (layer == 4) ? 0.062 : (layer == 5) ? 0.075 : 0.058) * hqBoost;
    float wrapDiff    = (layer == 3) ? 0.36 : (layer == 4) ? 0.14 : 0.04;
    float creviceDep  = (layer == 5) ? 0.34 : (layer == 2) ? 0.30 : (layer == 0) ? 0.26 : (layer == 4) ? 0.28 : (layer == 1) ? 0.18 : 0.10;

    // Linear crevice colors: dusty lime mortar on brick/ashlar, deep umber on wood, drifted sand/moss in cobble joints
    vec3 hazeLin = srgbToLin(uHazeColor * 0.82);
    vec3 creviceTint = pigmentLin * 0.56;
    if (layer == 5) creviceTint = mix(pigmentLin * 0.58, hazeLin * 0.68, 0.54);
    else if (layer == 2) creviceTint = pigmentLin * vec3(0.40, 0.34, 0.28);
    else if (layer == 4) creviceTint = mix(mix(pigmentLin * 0.55, uSandColor * 0.72, uBiomeA.y * 0.62), uMossColor * 0.78, uBiomeA.x * 0.48);
    else if (layer == 0) creviceTint = mix(mix(pigmentLin * 0.56, hazeLin * 0.48, 0.26), uMossColor * 0.75, uBiomeA.x * 0.42);
    else if (layer == 1) creviceTint = pigmentLin * 0.46;

    return shadeMaterialPBR(pigmentLin, N, viewDir, bakedAO, sunVis, heightVal, metallic, specPower, specAmt, bumpStr, wrapDiff, creviceDep, creviceTint);
  }

  // True LINEAR pigment mapper: converts sRGB palette swatches to physical linear reflectance
  // and blends faithfully with Source 2's linear vertex hues without double-gamma brightening!
  vec3 arenaPigment(vec3 source, vec3 baseSrgb) {
    vec3 baseLin = srgbToLin(baseSrgb);
    float luminance = dot(source, uArenaLuma);
    float hi = max(source.r, max(source.g, source.b));
    float lo = min(source.r, min(source.g, source.b));
    float chroma = (hi - lo) / max(hi + 0.05, 0.12);
    float lumaGate = smoothstep(0.035, 0.14, luminance);
    float subtleHue = 0.44 * smoothstep(0.04, 0.22, chroma);
    float landmark = 0.68 * smoothstep(0.20, 0.48, chroma);
    float accent = clamp(subtleHue + landmark, 0.0, 1.0) * lumaGate;
    float targetPeak = mix(0.16, 0.42, smoothstep(0.08, 0.52, hi));
    vec3 normalizedSource = source * (targetPeak / max(hi, 0.10));
    float nsLuma = dot(normalizedSource, uArenaLuma);
    normalizedSource = mix(vec3(nsLuma), normalizedSource, 1.10);
    float baseBlend = clamp(0.40 * lumaGate + accent * 0.76, 0.14, 0.94);
    return clamp(mix(baseLin, normalizedSource, baseBlend), 0.015, 0.68);
  }

  // Linear aerial perspective + directional golden Mie sun-inscattering + calibrated linear ACES filmic curve
  // (Three.js #include <colorspace_fragment> performs the final linear -> sRGB conversion cleanly!)
  vec3 applyDesertAtmosphere(vec3 colorLin, vec3 worldPos, vec3 viewDir) {
    float dist = length(cameraPosition - worldPos);
    float heightAtten = 1.0 - smoothstep(4.0, 26.0, worldPos.y) * 0.28;
    float fog = smoothstep(22.0, 136.0, dist) * (uFogStrength * 0.85) * heightAtten;
    float sunAlign = max(dot(-viewDir, uArenaKey), 0.0);
    float mie = pow(sunAlign, 4.5);
    vec3 hazeLin = srgbToLin(uHazeColor * 0.88);
    vec3 glowLin = srgbToLin(uSunGlow * 0.92);
    vec3 fogTint = mix(hazeLin, glowLin, mie * 0.56);
    vec3 graded = mix(colorLin, fogTint, fog);
    graded += glowLin * (mie * fog * 0.10);
    vec3 x = max(graded * 0.92, vec3(0.0));
    vec3 aces = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
    float luma = dot(aces, uArenaLuma);
    vec3 vibrant = mix(vec3(luma), aces, 1.05);
    return clamp(vibrant, 0.0, 1.0);
  }
`;

const miragePbrUniforms = `
  uniform highp sampler2DArray uPbrDetail;
  uniform float uPbrScale[6];
  uniform vec4 uLookA; // [texScaleMult, normalStrength, albedoContrast, creviceDepth]
  uniform vec4 uLookB; // [edgeCrispness, propDetail, colorVariety, sunContrast]
  uniform vec4 uLookC; // [smoothNormalWeight, specStrength, ambientLift, saturation]

  struct PbrSample {
    float albedo;
    float crevice;
    vec3 worldGrad;
  };

  PbrSample samplePbrTriplanar(vec3 p, vec3 dx, vec3 dy, vec3 geoN, float layer) {
    // Fast 1-tap dominant-axis projection (3x faster than 3-tap triplanar, razor-sharp on architectural walls/crates!)
    vec3 an = abs(geoN);
    vec2 uv, dux, duy;
    vec3 tVec, bVec;
    if (an.y >= an.x && an.y >= an.z) {
      uv = p.xz; dux = dx.xz; duy = dy.xz;
      tVec = vec3(1.0, 0.0, 0.0); bVec = vec3(0.0, 0.0, 1.0);
    } else if (an.x >= an.z) {
      uv = p.zy; dux = dx.zy; duy = dy.zy;
      tVec = vec3(0.0, 0.0, 1.0); bVec = vec3(0.0, 1.0, 0.0);
    } else {
      uv = p.xy; dux = dx.xy; duy = dy.xy;
      tVec = vec3(1.0, 0.0, 0.0); bVec = vec3(0.0, 1.0, 0.0);
    }
    vec4 s = textureGrad(uPbrDetail, vec3(uv, layer), dux, duy);
    vec2 dn = s.gb * 2.0 - 1.0;
    vec3 grad = tVec * dn.x + bVec * dn.y;
    grad -= geoN * dot(grad, geoN);
    return PbrSample(s.r, s.a, grad);
  }

  float mirageMacroSample(vec3 p, vec3 dx, vec3 dy) {
    const float sc = 0.095;
    vec3 mp = p * sc, mdx = dx * sc, mdy = dy * sc;
    vec2 uv  = vec2(0.80 * mp.x - 0.60 * mp.z + 0.47 * mp.y, 0.60 * mp.x + 0.80 * mp.z - 0.39 * mp.y);
    vec2 dux = vec2(0.80 * mdx.x - 0.60 * mdx.z + 0.47 * mdx.y, 0.60 * mdx.x + 0.80 * mdx.z - 0.39 * mdx.y);
    vec2 duy = vec2(0.80 * mdy.x - 0.60 * mdy.z + 0.47 * mdy.y, 0.60 * mdy.x + 0.80 * mdy.z - 0.39 * mdy.y);
    return textureGrad(uPbrDetail, vec3(uv + vec2(0.31, 0.17), 3.0), dux, duy).r;
  }

  vec3 shadeMiragePBR(
    vec3 pigmentLin, vec3 baseN, vec3 faceN, vec3 viewDir, float bakedAO, float sunVis,
    PbrSample pbr, float normalMult, float metallic, float specPower, float specAmt,
    float wrapDiff, float creviceMult, vec3 creviceTintLin, float edgeAmt
  ) {
    float viewDist = length(cameraPosition - surfaceWorld);
    float distFade = 1.0 - smoothstep(14.0, 44.0, viewDist);
    float effNorm = uLookA.y * normalMult * distFade;
    vec3 bumpN = effNorm > 0.004
      ? arenaNormal(baseN - pbr.worldGrad * effNorm)
      : baseN;

    float ndl = dot(bumpN, uArenaKey);
    float keyFacing = smoothstep(-0.06 - wrapDiff * 0.16, 0.60, ndl);
    float directSun = keyFacing * sunVis;

    float upFactor = clamp(bumpN.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 skyLin = uSkyFill * (0.52 * uLookC.z);
    vec3 bounceLin = uGroundBounce * (0.46 * uLookC.z);
    vec3 shadowLin = uShadowTint * (0.40 * uLookC.z);
    vec3 hemi = mix(bounceLin * 0.72, skyLin * 0.96, upFactor);
    float oppFacing = max(-ndl, 0.0);
    vec3 bounceRim = bounceLin * (0.14 + 0.26 * oppFacing) * (0.30 + 0.70 * bakedAO) * (1.0 - 0.42 * upFactor);
    vec3 ambientGI = mix(shadowLin * 0.84, hemi, 0.34 + 0.66 * bakedAO) + bounceRim;

    vec3 sunLin = uSunTint * (1.42 * uLookB.w);
    vec3 totalLight = ambientGI * (0.38 + 0.62 * bakedAO) + sunLin * directSun * (0.42 + 0.58 * bakedAO);

    // Clean mortar & seam occlusion driven by Float32-baked RGBA.a crevice mask
    float grooveMask = clamp(1.0 - pbr.crevice, 0.0, 1.0);
    float effCrev = clamp(uLookA.w * creviceMult, 0.0, 0.82);
    vec3 shadedPigment = mix(pigmentLin, creviceTintLin, grooveMask * effCrev);
    float microAO = mix(1.0 - effCrev * 0.44, 1.05, pbr.crevice);

    // Zero-derivative 3D architectural edge & corner contrast (no nested dFdx -> 120 FPS!)
    // Uses crisp raytraced AO corner steepness + geometric face-vs-smooth curvature!
    float smoothCurv = hasSmoothNormal > 0.5
      ? clamp((1.0 - max(dot(faceN, normalize(surfaceSmoothNormal)), 0.0)) * 3.2, 0.0, 1.0)
      : 0.0;
    float edgeStrength = edgeAmt * uLookB.x;
    // Deepen concave inner corners & sharpen convex sunlit ridges/bevels cleanly
    float concaveDip = 1.0 - (1.0 - smoothstep(0.16, 0.52, bakedAO)) * (0.28 * edgeStrength);
    float convexCrest = smoothstep(0.62, 0.92, bakedAO) * (0.18 * edgeStrength) + smoothCurv * (0.32 * edgeStrength);
    vec3 lit = shadedPigment * mix(1.0, 0.64, metallic) * totalLight * microAO * concaveDip;
    lit += pigmentLin * (sunLin * 0.28 * (0.25 + 0.75 * directSun) + skyLin * 0.36) * convexCrest;

    float ndv = max(dot(bumpN, viewDir), 0.0);
    float fresnel = pow(1.0 - ndv, mix(3.6, 4.4, metallic));
    vec3 H = arenaNormal(uArenaKey + viewDir);
    float ndh = max(dot(bumpN, H), 0.0);
    float roughMod = mix(0.76, 1.24, pbr.crevice);
    vec3 specTint = mix(sunLin, mix(sunLin, pigmentLin * 2.2 + vec3(0.08), 0.58), metallic);
    float spec = pow(ndh, specPower) * specAmt * uLookC.y * roughMod * (0.45 + 0.90 * fresnel) * directSun * (0.45 + 0.55 * bakedAO);
    lit += specTint * spec;

    if (metallic <= 0.01) {
      float rimMask = fresnel * (0.30 + 0.70 * upFactor) * bakedAO;
      lit += skyLin * (0.042 + 0.025 * uHighQuality) * rimMask * (0.72 + 0.28 * pbr.crevice);
    } else {
      vec3 reflDir = reflect(-viewDir, bumpN);
      vec3 envRefl = mix(bounceLin * 0.65, skyLin * 1.35, smoothstep(-0.25, 0.55, reflDir.y));
      vec3 f0 = mix(vec3(0.04), pigmentLin * 0.88 + vec3(0.08), metallic);
      lit += envRefl * f0 * (0.18 + 0.65 * fresnel) * metallic * (0.68 + 0.40 * pbr.crevice) * bakedAO;
    }

    return lit;
  }

  vec3 applyMirageAtmosphere(vec3 colorLin, vec3 worldPos, vec3 viewDir) {
    float dist = length(cameraPosition - worldPos);
    float heightAtten = 1.0 - smoothstep(4.0, 26.0, worldPos.y) * 0.28;
    float fog = smoothstep(24.0, 140.0, dist) * (uFogStrength * 0.78) * heightAtten;
    float sunAlign = max(dot(-viewDir, uArenaKey), 0.0);
    float mie = pow(sunAlign, 4.5);
    vec3 hazeLin = srgbToLin(uHazeColor * 0.88);
    vec3 glowLin = srgbToLin(uSunGlow * 0.92);
    vec3 fogTint = mix(hazeLin, glowLin, mie * 0.54);
    vec3 graded = mix(colorLin, fogTint, fog);
    graded += glowLin * (mie * fog * 0.09);
    vec3 x = max(graded * 0.92, vec3(0.0));
    vec3 aces = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
    float luma = dot(aces, uArenaLuma);
    vec3 vibrant = mix(vec3(luma), aces, uLookC.w);
    return clamp(vibrant, 0.0, 1.0);
  }
`;

export function applySurfaceDetail(material, texture, mapId) {
  const profile = texture.userData.profiles[mapId] || [0, 4, 1, 1, [1, 1, 1]];
  const finishes = texture.userData.finishes;
  const local = texture.userData.mapTiles === true;
  const hasBaked = Boolean(local && material.userData.hasBakedLight);
  const arenaPbr = Boolean(hasBaked);
  const rules = local ? assignments[mapId] || {} : {};
  if (arenaPbr) material.userData.arenaPbrEnabled = true;
  material.customProgramCacheKey = () =>
    (local
      ? arenaPbr
        ? 'dust2-plane-finishes-v4-arena-pbr-'
        : 'dust2-plane-finishes-v3-'
      : 'dust2-architectural-surfaces-v4-') + finishes.length;
  material.onBeforeCompile = function onSurfaceDetailCompile(shader) {
    const target = this?.isMaterial ? this : material;
    Object.assign(shader.uniforms, {
      uSurfaceDetail: {value:texture},
      uFinishScale: {value:finishes.map(([,metres]) => 1 / metres)},
      uFinishContrast: {value:finishes.map(([, ,contrast]) => contrast)},
      uTagLayer: {value:[rules.plainConcrete ? 3 : profile[0],1,2,rules.plasterWall ? 0 : 3,profile[1],rules.brickWall ? 0 : 5]},
      uFloorSlabs: {value:!!rules.floorSlabs},
      uMapFinish: {value:new Vector4(...profile.slice(0,4))},
      uGrainPigment: {value:new Vector3(...profile[4])},
      uUseSmoothNormals: {value:target.userData.hasSmoothNormals ? 1.0 : 0.0},
    });
    if (local) {
      const atm = getMapAtmosphere(mapId);
      shader.uniforms.uArenaBase = {value:arena.mapLayers[mapId].map(rgb => new Vector3(...rgb))};
      shader.uniforms.uSourcePlates = {value:plates[mapId].map(pair => new Vector2(...pair))};
      shader.uniforms.uArenaKey = {value:new Vector3(...(atm.sunDir || arena.keyDirection)).normalize()};
      shader.uniforms.uArenaLuma = {value:new Vector3(...arena.sourceLuma)};
      shader.uniforms.uSunTint = {value:new Vector3(...atm.sun)};
      shader.uniforms.uSkyFill = {value:new Vector3(...atm.sky)};
      shader.uniforms.uShadowTint = {value:new Vector3(...atm.shadow)};
      shader.uniforms.uGroundBounce = {value:new Vector3(...atm.bounce)};
      shader.uniforms.uHazeColor = {value:new Vector3(...atm.haze)};
      shader.uniforms.uSunGlow = {value:new Vector3(...atm.sunGlow)};
      shader.uniforms.uAccentWarm = {value:new Vector3(...atm.accentWarm)};
      shader.uniforms.uAccentCool = {value:new Vector3(...atm.accentCool)};
      shader.uniforms.uBiomeA = {value:new Vector4(...(atm.biomeA || [0.2, 0.4, 0.4, 0.2]))};
      shader.uniforms.uBiomeB = {value:new Vector4(...(atm.biomeB || [0.8, 0.4, 0.4, 0.8]))};
      shader.uniforms.uMossColor = {value:new Vector3(...(atm.mossColor || [0.15, 0.22, 0.10]))};
      shader.uniforms.uSandColor = {value:new Vector3(...(atm.sandColor || [0.38, 0.29, 0.17]))};
      shader.uniforms.uFogStrength = {value:atm.fogStrength};
      shader.uniforms.uHighQuality = {value:target.userData.highQuality ? 1.0 : 0.0};
      if (arenaPbr) {
        const styleId = target.userData.visualStyle || globalThis.__CS2_VISUAL_STYLE__ || getStoredVisualStyle();
        const sharedLook = getSharedVisualStyleUniforms(styleId);
        shader.uniforms.uPbrDetail = {value:getArenaPbrAtlas()};
        shader.uniforms.uPbrScale = {value:ARENA_PBR_PERIODS.map(m => 1 / m)};
        shader.uniforms.uLookA = sharedLook.uLookA;
        shader.uniforms.uLookB = sharedLook.uLookB;
        shader.uniforms.uLookC = sharedLook.uLookC;
      }
      target.userData.surfaceUniforms = shader.uniforms;
      if (!Array.isArray(target.userData.surfaceUniformsList)) {
        target.userData.surfaceUniformsList = [];
      }
      if (!target.userData.surfaceUniformsList.includes(shader.uniforms)) {
        target.userData.surfaceUniformsList.push(shader.uniforms);
      }
    }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uUseSmoothNormals;
        ${hasBaked ? 'attribute vec2 aBakedLight;' : ''}
        varying vec3 surfaceWorld;
        varying float surfaceClass;
        varying vec3 surfaceSmoothNormal;
        varying float hasSmoothNormal;
        ${local ? 'varying vec2 vBakedLight;\nvarying float vHasBakedLight;' : ''}`)
      .replace('#include <color_vertex>', `#include <color_vertex>
        surfaceClass = 255.0;
        #ifdef USE_COLOR_ALPHA
          surfaceClass = floor(255.0 * color.a + 0.5);
          vColor.a = 1.0;
        #endif
        ${local ? (hasBaked ? 'vBakedLight = aBakedLight;\nvHasBakedLight = 1.0;' : 'vBakedLight = vec2(1.0, 1.0);\nvHasBakedLight = 0.0;') : ''}`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        surfaceWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
        surfaceSmoothNormal = uUseSmoothNormals > 0.5 ? normalize(mat3(modelMatrix) * normal) : vec3(0.0, 1.0, 0.0);
        hasSmoothNormal = uUseSmoothNormals;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n#define FINISH_COUNT ' + finishes.length + '\n' + finishUniforms + '\n' + (local ? arenaUniforms : '') + '\n' + (arenaPbr ? miragePbrUniforms : '') + '\n' + ladderFinishGLSL)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 dx = dFdx(surfaceWorld), dy = dFdy(surfaceWorld);
        vec3 flatN = cross(dx, dy);
        vec3 faceN = flatN * inversesqrt(max(dot(flatN, flatN), 1e-20));
        vec3 shadeN = hasSmoothNormal > 0.5
          ? normalize(mix(faceN, normalize(surfaceSmoothNormal), ${arenaPbr ? 'uLookC.x' : '0.45'}))
          : faceN;
        if (dot(shadeN, faceN) < 0.0) shadeN = -shadeN;

        if (surfaceClass >= .5 && surfaceClass < 6.5) {
          int tag = int(floor(surfaceClass + .5));
          int layer = uTagLayer[tag-1];
          if (tag == 1 && uFloorSlabs) {
            if (faceN.y > .74) layer = int(uMapFinish.y);
          }
          ${arenaPbr ? `
            float scale = uPbrScale[layer] * uLookA.x;
            vec3 position = surfaceWorld * scale;
            vec3 sdx = dx * scale, sdy = dy * scale;
            float minor = length(cross(sdx, sdy)) / max(max(length(sdx), length(sdy)), 1e-10);
            float visibility = 1.0 - smoothstep(0.18, 0.62, minor);
            PbrSample pbr = PbrSample(0.5, 1.0, vec3(0.0));
            if (visibility > 0.0) {
              pbr = samplePbrTriplanar(position, sdx, sdy, faceN, float(layer));
              pbr.albedo = mix(0.5, pbr.albedo, visibility);
              pbr.crevice = mix(1.0, pbr.crevice, visibility);
              pbr.worldGrad *= visibility;
            }
            float macroTex = mirageMacroSample(surfaceWorld, dx, dy);
            vec3 pig = arenaPigment(diffuseColor.rgb, uArenaBase[layer]);
            vec2 gi = resolveBakedGI(dot(diffuseColor.rgb, uArenaLuma), uSourcePlates[layer]);
            vec3 weather = macroWeather3(surfaceWorld, macroTex);
            float detail = pbr.albedo;
            if (faceN.y < -0.55) {
              pig *= vec3(0.76, 0.77, 0.80);
              detail = mix(detail, 0.50, 0.60);
              pbr.worldGrad *= 0.35;
              pbr.crevice = mix(pbr.crevice, 1.0, 0.55);
            }
            vec3 variedPig = applyArchitecturalColorVariation(pig, surfaceWorld, shadeN, detail, macroTex, weather, gi.x, layer);
            pig = mix(pig, variedPig, clamp(uLookB.z, 0.0, 1.25));
            float layerAlb = (layer == 2 || layer == 5) ? 0.92 : (layer == 0 || layer == 4) ? 0.82 : (layer == 1) ? 0.68 : 0.55;
            pig *= vec3(1.0) + uGrainPigment * (2.0 * detail - 1.0) * (uLookA.z * layerAlb);
            vec3 viewDir = arenaNormal(cameraPosition - surfaceWorld);
            float metallic   = (layer == 1) ? 0.84 : 0.0;
            float specPower  = (layer == 1) ? 60.0 : (layer == 2) ? 28.0 : (layer == 4) ? 22.0 : (layer == 0) ? 18.0 : (layer == 5) ? 14.0 : 10.0;
            float specAmt    = (layer == 1) ? 0.44 : (layer == 2) ? 0.12 : (layer == 4) ? 0.08 : (layer == 0) ? 0.052 : (layer == 5) ? 0.036 : 0.018;
            float normMult   = (layer == 3) ? 0.42 : (layer == 1) ? 0.58 : (layer == 5) ? 1.15 : (layer == 2) ? 1.05 : 0.95;
            float wrapDiff   = (layer == 3) ? 0.28 : (layer == 4) ? 0.12 : 0.04;
            float crevMult   = (layer == 5) ? 1.15 : (layer == 2) ? 1.05 : (layer == 0 || layer == 4) ? 0.92 : (layer == 1) ? 0.72 : 0.28;
            vec3 hazeLin = srgbToLin(uHazeColor * 0.84);
            vec3 creviceTint = pig * 0.56;
            if (layer == 5) creviceTint = mix(pig * 0.56, hazeLin * 0.68, 0.52);
            else if (layer == 2) creviceTint = pig * vec3(0.42, 0.35, 0.28);
            else if (layer == 4) creviceTint = mix(pig * 0.56, uSandColor * 0.76, uBiomeA.y * 0.58);
            else if (layer == 0) creviceTint = mix(pig * 0.58, hazeLin * 0.52, 0.30);
            else if (layer == 1) creviceTint = pig * 0.45;
            vec3 shaded = shadeMiragePBR(
              pig, shadeN, faceN, viewDir, gi.x, gi.y, pbr, normMult,
              metallic, specPower, specAmt, wrapDiff, crevMult, creviceTint, 1.0
            );
            diffuseColor.rgb = applyMirageAtmosphere(shaded, surfaceWorld, viewDir);
          ` : `
          float scale = uFinishScale[layer] * uMapFinish.z;
          vec3 position = surfaceWorld * scale;
          vec3 sdx = dx * scale, sdy = dy * scale;
          float minor = length(cross(sdx,sdy)) / max(max(length(sdx),length(sdy)),1e-10);
          float visibility = 1. - smoothstep(.18,.58,minor);
          float detail = 0.5;
          if (visibility > 0.) {
            bool alignedGrain = ${local ? 'true' : 'tag == 2 || tag == 3 || tag == 6'};
            detail = alignedGrain
              ? directionalFinish(position,sdx,sdy,float(layer))
              : continuousFinish(position,sdx,sdy,float(layer));
          }
          ${local ? `
            // One rotated macro sample in the same atlas breaks repetition & drives peeling stucco/moss/sand!
            float macroLayer = (layer == 3) ? 5.0 : 3.0;
            float macroTex = macroSurfaceSample(surfaceWorld, dx, dy, macroLayer);
            vec3 pig = arenaPigment(diffuseColor.rgb, uArenaBase[layer]);
            vec2 gi = resolveBakedGI(dot(diffuseColor.rgb, uArenaLuma), uSourcePlates[layer]);
            vec3 weather = macroWeather3(surfaceWorld, macroTex);
            // Gentle architectural transitions (keeps large surfaces varied without busy clutter)
            if (visibility > 0.0) {
              if (layer == 3 && uBiomeA.z > 0.25) {
                float peelZone = smoothstep(0.68, 0.86, weather.x * 0.60 + weather.z * 0.40) * uBiomeA.z * 0.34;
                if (peelZone > 0.002) {
                  float bs = uFinishScale[5];
                  float brickD = directionalFinish(surfaceWorld * bs, dx * bs, dy * bs, 5.0);
                  detail = mix(detail, brickD, peelZone);
                }
              } else if (layer == 0 && faceN.y > -0.55) {
                float erodeZone = smoothstep(0.66, 0.86, weather.x * 0.55 + weather.z * 0.45) * max(uBiomeA.z, uBiomeA.x * 0.70) * 0.26;
                if (erodeZone > 0.002) {
                  float ps = uFinishScale[3];
                  float plasterD = directionalFinish(surfaceWorld * ps, dx * ps, dy * ps, 3.0);
                  detail = mix(detail, plasterD, erodeZone);
                }
              } else if (layer == 4) {
                float earthZone = smoothstep(0.58, 0.84, weather.y * 0.55 + macroTex * 0.45) * max(uBiomeA.y, uBiomeA.x * 0.75) * 0.42;
                if (earthZone > 0.002) {
                  float es = uFinishScale[3] * 1.25;
                  float earthD = continuousFinish(surfaceWorld * es, dx * es, dy * es, 3.0);
                  detail = mix(detail, earthD, earthZone);
                }
              }
            }
            // Undersides / ceilings get distinct darker architectural soffit finish instead of bright wall/floor tiles
            if (faceN.y < -0.55) {
              pig *= vec3(0.76, 0.77, 0.80);
              detail = mix(detail, 0.49 + (macroTex - 0.5) * 0.08, 0.72);
            }
            pig = applyArchitecturalColorVariation(pig, surfaceWorld, shadeN, detail, macroTex, weather, gi.x, layer);
            float layerContrast = (layer == 2 || layer == 5) ? 0.52 : (layer == 4 || layer == 0) ? 0.46 : (layer == 1) ? 0.40 : 0.30;
            float strength = visibility * uFinishContrast[layer] * uMapFinish.w * layerContrast;
            pig *= vec3(1.) + uGrainPigment * (2. * detail - 1.) * strength;
            vec3 viewDir = arenaNormal(cameraPosition - surfaceWorld);
            diffuseColor.rgb = applyDesertAtmosphere(desertLitFinish(pig, shadeN, viewDir, gi.x, gi.y, mix(0.5, detail, visibility), layer), surfaceWorld, viewDir);
          ` : `
            if (visibility > 0.) {
              float strength = visibility * uFinishContrast[layer] * uMapFinish.w;
              diffuseColor.rgb *= vec3(1.) + uGrainPigment * (2.*detail - 1.) * strength;
            }
          `}
          `}
        }
        ${local ? (arenaPbr ? `
        if (surfaceClass > 254.5) {
          // All-arena untagged props, crates, wooden boxes, painted banners, trims, rocks & foliage:
          // True Float32-computed RGBA8 PBR normals + biome moss/foliage shading + crisp edge definition!
          vec3 src = diffuseColor.rgb;
          float hi = max(src.r, max(src.g, src.b)), lo = min(src.r, min(src.g, src.b));
          float chroma = (hi - lo) / max(hi + 0.08, 0.16);
          float y = dot(src, uArenaLuma);

          float wFoliage = smoothstep(0.015, 0.085, src.g - max(src.r * 0.92, src.b * 1.15)) * smoothstep(0.14, 0.36, chroma);
          float wUp      = (1.0 - wFoliage) * smoothstep(0.62, 0.84, faceN.y);
          float wWood    = (1.0 - wFoliage) * (1.0 - wUp) * smoothstep(0.06, 0.18, src.r - src.b) * smoothstep(0.02, 0.14, src.g - src.b) * (1.0 - smoothstep(0.48, 0.72, hi));
          float wMetal   = (1.0 - wFoliage) * (1.0 - wUp) * (1.0 - wWood) * smoothstep(0.015, 0.075, src.b - src.r) * (1.0 - smoothstep(0.32, 0.56, hi));

          int pLayerIdx = wWood > 0.35 ? 2 : (wMetal > 0.35 ? 1 : (wUp > 0.55 ? 4 : 3));
          float pLayer = float(pLayerIdx);
          float pScale = (pLayerIdx == 2 ? uPbrScale[2] : (pLayerIdx == 1 ? uPbrScale[1] : (pLayerIdx == 4 ? uPbrScale[4] : uPbrScale[3] * 1.18))) * uLookA.x;
          vec3 pp = surfaceWorld * pScale;
          vec3 pdx = dx * pScale, pdy = dy * pScale;
          float minor = length(cross(pdx, pdy)) / max(max(length(pdx), length(pdy)), 1e-10);
          float visibility = 1.0 - smoothstep(0.18, 0.62, minor);
          PbrSample pbr = PbrSample(0.5, 1.0, vec3(0.0));
          if (visibility > 0.0) {
            pbr = samplePbrTriplanar(pp, pdx, pdy, faceN, pLayer);
            pbr.albedo = mix(0.5, pbr.albedo, visibility);
            pbr.crevice = mix(1.0, pbr.crevice, visibility);
            pbr.worldGrad *= visibility;
          }

          float macroTex = mirageMacroSample(surfaceWorld, dx, dy);
          float srcPeak = max(hi, 0.06);
          float albedoPeak = mix(0.11, 0.43, smoothstep(0.03, 0.48, hi));
          vec3 pig = clamp(src * (albedoPeak / srcPeak), 0.015, 0.58);
          vec2 gi = resolveBakedGI(y, uSourcePlates[6]);
          vec3 weather = macroWeather3(surfaceWorld, macroTex);

          float neutralProp = (1.0 - smoothstep(0.20, 0.48, chroma)) * (1.0 - wFoliage);
          vec3 propTint = mix(uAccentCool, uAccentWarm, clamp(weather.y * 0.55 + weather.z * 0.45, 0.0, 1.0));
          pig *= mix(vec3(1.0), propTint, 0.24 * neutralProp * uLookB.z);
          pig *= 0.94 + weather.x * 0.12;
          float rockMoss = smoothstep(0.50, 0.82, weather.x * 0.56 + weather.z * 0.44 + (1.0 - gi.x) * 0.30 + max(shadeN.y, 0.0) * 0.24) * uBiomeA.x * neutralProp;
          pig = mix(pig, mix(uMossColor * 0.86, uMossColor * 1.28, weather.z), rockMoss * 0.50);
          if (wFoliage > 0.02) {
            vec3 leafShift = mix(vec3(0.78, 0.94, 0.72), vec3(1.18, 1.10, 0.68), weather.z);
            pig *= mix(vec3(1.0), leafShift, wFoliage * 0.58);
          }

          float paintedSign = smoothstep(0.24, 0.55, chroma);
          float propAmt = uLookB.y * mix(1.0, 0.35, max(paintedSign, wFoliage));
          pig *= vec3(1.0) + (2.0 * pbr.albedo - 1.0) * (0.42 * propAmt);

          vec3 viewDir = arenaNormal(cameraPosition - surfaceWorld);
          float metallic = wMetal * 0.80;
          float specPower = mix(mix(18.0, 30.0, wWood), 58.0, wMetal);
          float specAmt = mix(mix(0.045, 0.11, wWood), 0.38, wMetal);
          float normMult = mix(0.52, 0.95, max(wWood, wMetal)) * propAmt * 1.45;
          float crevMult = mix(0.35, 0.92, max(wWood, wUp)) * propAmt * 1.4;
          vec3 creviceTint = mix(pig * 0.62, pig * vec3(0.45, 0.38, 0.32), wWood);
          vec3 shaded = shadeMiragePBR(
            pig, shadeN, faceN, viewDir, gi.x, gi.y, pbr, normMult,
            metallic, specPower, specAmt, mix(0.14, 0.36, wFoliage), crevMult, creviceTint, 1.15
          );
          if (wFoliage > 0.05) {
            float trans = pow(max(dot(-viewDir, uArenaKey), 0.0), 2.5) * 0.45 + 0.25;
            shaded += pig * uSunTint * vec3(0.45, 0.55, 0.15) * trans * gi.y * wFoliage * 0.45;
          }
          diffuseColor.rgb = applyMirageAtmosphere(shaded, surfaceWorld, viewDir);
        }
        ` : `
        if (surfaceClass > 254.5) {
          // Untagged props, crates, painted panels, foliage, carved ruins, doors & landmarks:
          // Clean, low-noise surface shading so crates/banners stay crisp and never hurt enemy visibility!
          vec3 src = diffuseColor.rgb;
          float hi = max(src.r, max(src.g, src.b)), lo = min(src.r, min(src.g, src.b));
          float chroma = (hi - lo) / max(hi + 0.08, 0.16);
          float y = dot(src, uArenaLuma);

          float wFoliage = smoothstep(0.015, 0.085, src.g - max(src.r * 0.92, src.b * 1.15)) * smoothstep(0.14, 0.36, chroma);
          float wUp      = (1.0 - wFoliage) * smoothstep(0.60, 0.82, faceN.y);
          float wWood    = (1.0 - wFoliage) * (1.0 - wUp) * smoothstep(0.06, 0.18, src.r - src.b) * smoothstep(0.02, 0.14, src.g - src.b) * (1.0 - smoothstep(0.48, 0.72, hi));
          float wMetal   = (1.0 - wFoliage) * (1.0 - wUp) * (1.0 - wWood) * smoothstep(0.015, 0.075, src.b - src.r) * (1.0 - smoothstep(0.32, 0.56, hi));

          float macroTex = macroSurfaceSample(surfaceWorld, dx, dy, 3.0);
          float stoneScale = uFinishScale[3] * 0.90;
          vec3 pStone = surfaceWorld * stoneScale;
          vec3 dxS = dx * stoneScale, dyS = dy * stoneScale;
          float minor = length(cross(dxS, dyS)) / max(max(length(dxS), length(dyS)), 1e-10);
          float visibility = 1. - smoothstep(.18, .58, minor);
          float detail = 0.5;
          if (visibility > 0.) {
            float dStone = directionalFinish(pStone, dxS, dyS, 3.0);
            detail = dStone;
            if (wWood > 0.005) {
              float ws = uFinishScale[2];
              float dWood = directionalFinish(surfaceWorld * ws, dx * ws, dy * ws, 2.0);
              detail = mix(detail, dWood, wWood);
            } else if (wUp > 0.005) {
              float gs = uFinishScale[4];
              float dGround = directionalFinish(surfaceWorld * gs, dx * gs, dy * gs, 4.0);
              detail = mix(detail, dGround, wUp * 0.75);
            } else if (wMetal > 0.005) {
              float ms = uFinishScale[1];
              float dMetal = directionalFinish(surfaceWorld * ms, dx * ms, dy * ms, 1.0);
              detail = mix(detail, dMetal, wMetal);
            } else if (wFoliage > 0.005) {
              float vein = sin(surfaceWorld.x * 7.5 + surfaceWorld.z * 6.5 + surfaceWorld.y * 5.0) * 0.5 + 0.5;
              detail = mix(detail, 0.45 + vein * 0.14 + (macroTex - 0.5) * 0.08, wFoliage);
            }
          }

          // Recover clean linear albedo without double-darkening real raytraced shadows
          float srcPeak = max(hi, 0.06);
          float albedoPeak = mix(0.11, 0.43, smoothstep(0.03, 0.48, hi));
          vec3 pig = clamp(src * (albedoPeak / srcPeak), 0.015, 0.58);
          vec2 gi = resolveBakedGI(y, uSourcePlates[6]);
          vec3 weather = macroWeather3(surfaceWorld, macroTex);

          // Restrained mineral + biome patina on neutral untagged props (bright painted signs & crates stay clean!)
          float neutralStone = (1.0 - smoothstep(0.20, 0.48, chroma)) * (1.0 - wFoliage);
          vec3 propTint = mix(uAccentCool, uAccentWarm, clamp(weather.y * 0.55 + weather.z * 0.45, 0.0, 1.0));
          pig *= mix(vec3(1.0), propTint, 0.28 * neutralStone * uBiomeB.x);
          pig *= 0.94 + weather.x * 0.12;

          float rockMoss = smoothstep(0.50, 0.82, weather.x * 0.56 + weather.z * 0.44 + (1.0 - gi.x) * 0.30 + max(shadeN.y, 0.0) * 0.24) * uBiomeA.x * neutralStone;
          pig = mix(pig, mix(uMossColor * 0.86, uMossColor * 1.28, weather.z), rockMoss * 0.46);

          if (wFoliage > 0.02) {
            vec3 leafShift = mix(vec3(0.78, 0.94, 0.72), vec3(1.18, 1.10, 0.68), weather.z);
            pig *= mix(vec3(1.0), leafShift, wFoliage * 0.58);
          }

          // Smooth subtle tactile grain (zero harsh relief noise on white boxes & signs!)
          detail = clamp(detail + (macroTex - 0.5) * 0.08 * (1.0 - wFoliage), 0.12, 0.88);
          float paintedOrBright = max(smoothstep(0.20, 0.50, chroma), smoothstep(0.42, 0.68, hi));
          float grainScale = mix(0.16, 0.06, max(paintedOrBright, wFoliage));
          pig *= vec3(1.) + (2. * detail - 1.) * visibility * grainScale;

          vec3 viewDir = arenaNormal(cameraPosition - surfaceWorld);
          float metallic = wMetal * 0.76;
          float specPower = mix(mix(16.0, 28.0, wWood), 54.0, wMetal);
          float specAmt = mix(mix(0.038, 0.09, wWood), 0.32, wMetal) * mix(1.0, 1.16, uHighQuality);
          float bumpStr = mix(0.022, 0.055, max(wWood, wUp * 0.7)) * (1.0 - 0.72 * max(paintedOrBright, wFoliage));
          vec3 creviceTint = mix(pig * 0.68, pig * vec3(0.52, 0.46, 0.40), wWood);
          vec3 shaded = shadeMaterialPBR(
            pig, shadeN, viewDir, gi.x, gi.y, mix(0.5, detail, visibility),
            metallic, specPower, specAmt, bumpStr, mix(0.16, 0.38, wFoliage), 0.14 * (1.0 - max(paintedOrBright, wFoliage) * 0.65), creviceTint
          );
          // Warm botanical subsurface translucency when sun strikes leaves from behind/above
          if (wFoliage > 0.05) {
            float trans = pow(max(dot(-viewDir, uArenaKey), 0.0), 2.5) * 0.45 + 0.25;
            shaded += pig * uSunTint * vec3(0.45, 0.55, 0.15) * trans * gi.y * wFoliage * 0.45;
          }
          diffuseColor.rgb = applyDesertAtmosphere(shaded, surfaceWorld, viewDir);
        }
        `) : ''}
        ${shadeLadderGLSL}`);
  };
}
