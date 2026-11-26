import {DataArrayTexture, RedFormat, RepeatWrapping, LinearFilter, LinearMipmapLinearFilter, Vector2, Vector3, Vector4} from 'three';
import {ladderFinishGLSL, shadeLadderGLSL} from './flat-ladder-finish.js';
import assignments from './map-finishes/assignments.json' with {type:'json'};

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

const MAP_ATMOSPHERE = {
  de_dust2:   { sun: [1.18, 1.09, 0.95], sky: [0.78, 0.87, 0.98], bounce: [0.98, 0.86, 0.70], haze: [0.82, 0.80, 0.75] },
  de_mirage:  { sun: [1.16, 1.07, 0.94], sky: [0.78, 0.88, 0.98], bounce: [0.96, 0.84, 0.69], haze: [0.83, 0.79, 0.73] },
  de_anubis:  { sun: [1.20, 1.11, 0.95], sky: [0.75, 0.89, 0.99], bounce: [0.98, 0.88, 0.71], haze: [0.84, 0.81, 0.74] },
  de_inferno: { sun: [1.14, 1.06, 0.95], sky: [0.80, 0.88, 0.97], bounce: [0.92, 0.83, 0.74], haze: [0.81, 0.80, 0.78] },
  de_nuke:    { sun: [1.06, 1.09, 1.13], sky: [0.82, 0.90, 1.00], bounce: [0.80, 0.86, 0.92], haze: [0.76, 0.82, 0.88] },
  de_vertigo: { sun: [1.08, 1.10, 1.13], sky: [0.84, 0.92, 1.02], bounce: [0.84, 0.87, 0.92], haze: [0.79, 0.85, 0.92] },
  de_train:   { sun: [1.04, 1.06, 1.08], sky: [0.80, 0.85, 0.92], bounce: [0.82, 0.83, 0.86], haze: [0.75, 0.78, 0.82] },
  de_cache:   { sun: [1.06, 1.08, 1.04], sky: [0.82, 0.88, 0.91], bounce: [0.82, 0.85, 0.80], haze: [0.77, 0.81, 0.79] },
  de_ancient: { sun: [1.08, 1.11, 1.01], sky: [0.78, 0.89, 0.88], bounce: [0.78, 0.85, 0.74], haze: [0.72, 0.79, 0.75] },
};

const arenaUniforms = `
  uniform vec3 uArenaBase[6];
  uniform vec3 uArenaKey;
  uniform vec3 uArenaLuma;
  uniform vec2 uSourcePlates[7];
  uniform vec3 uSunTint;
  uniform vec3 uSkyFill;
  uniform vec3 uGroundBounce;
  uniform vec3 uHazeColor;
  uniform float uHighQuality;

  vec3 arenaNormal(vec3 n) {
    return n * inversesqrt(max(dot(n,n),1e-20));
  }

  // Cheap analytical world-space macro weathering (breaks tile repetition across large walls/floors)
  float macroWeather(vec3 p) {
    float a = sin(p.x * 0.27 + p.z * 0.19 + sin(p.y * 0.41) * 1.4);
    float b = sin(p.x * 0.11 - p.z * 0.23 + p.y * 0.17);
    float c = sin((p.x + p.z) * 0.53 - p.y * 0.31);
    return (a * 0.45 + b * 0.35 + c * 0.20) * 0.5 + 0.5;
  }

  // AO-preserving luminance response: preserves rich crevice & doorway contrast
  // while maintaining clear competitive visibility in dark corridors.
  float extractBakedAO(float luminance, vec2 cuts) {
    float lowShadow = smoothstep(0.015, max(cuts.x * 1.15, 0.12), luminance);
    float midLight  = smoothstep(cuts.x * 0.60, max(cuts.y * 1.25, 0.28), luminance);
    return 0.46 + 0.32 * lowShadow + 0.26 * midLight;
  }

  // Per-material surface shading profiles:
  //   0: concrete/stone   (matte aggregate, firm relief, subtle joint dust)
  //   1: brushed metal    (metallic Fresnel sky sheen, sharp tinted spec, dark diffuse)
  //   2: weathered wood   (deep warm umber plank grooves, satin sheen, strong fiber bump)
  //   3: lime plaster     (soft chalky wrap-diffuse, near-zero spec, aged blotches)
  //   4: cobble & sand    (gritty matte ground, dusty sediment in crevices, subtle quartz glint)
  //   5: brick masonry    (pale dusty lime mortar in deep seams vs warm matte brick faces)
  vec3 shadeMaterialPBR(
    vec3 pigment, vec3 N, vec3 viewDir, float bakedAO, float heightVal,
    float metallic, float specPower, float specAmt, float bumpStrength,
    float wrapDiffuse, float creviceDepth, vec3 creviceTint
  ) {
    vec3 dPosX = dFdx(surfaceWorld);
    vec3 dPosY = dFdy(surfaceWorld);
    float dHx = dFdx(heightVal);
    float dHy = dFdy(heightVal);
    vec3 surfGrad = cross(dPosY, N) * dHx + cross(N, dPosX) * dHy;
    float det = dot(dPosX, cross(dPosY, N));
    vec3 bumpN = abs(det) > 1e-8
      ? arenaNormal(N - bumpStrength * clamp(surfGrad / det, vec3(-2.1), vec3(2.1)))
      : N;

    float ndl = dot(bumpN, uArenaKey);
    float sunFactor = smoothstep(-0.18 - wrapDiffuse * 0.25, 0.68, ndl);
    vec3 hemi = mix(uGroundBounce * 0.78, uSkyFill * 0.96, clamp(bumpN.y * 0.5 + 0.5, 0.0, 1.0));
    vec3 direct = uSunTint * (0.44 + 0.74 * sunFactor);
    vec3 light = mix(hemi, direct, mix(0.56, 0.46, wrapDiffuse) + 0.34 * sunFactor) * bakedAO;

    // Distinct crevice micro-occlusion + material-specific seam/mortar tint
    float grooveMask = 1.0 - smoothstep(0.18, 0.42, heightVal);
    vec3 shadedPigment = mix(pigment, creviceTint, grooveMask * creviceDepth);
    float microAO = mix(1.0 - creviceDepth * 0.42, 1.08, clamp(heightVal * 1.35 - 0.16, 0.0, 1.0));
    vec3 lit = shadedPigment * mix(1.0, 0.78, metallic) * light * microAO;

    // Micro-specular & grazing Fresnel environment sheen
    float ndv = max(dot(bumpN, viewDir), 0.0);
    float fresnel = pow(1.0 - ndv, mix(3.2, 4.0, metallic));
    vec3 H = arenaNormal(uArenaKey + viewDir);
    float ndh = max(dot(bumpN, H), 0.0);
    // Scratches / raised grain gleam slightly brighter on metal and stone
    float roughMod = mix(0.75, 1.28, clamp(heightVal * 1.4 - 0.15, 0.0, 1.0));
    vec3 specTint = mix(uSunTint, mix(uSunTint, pigment * 1.45 + vec3(0.12), 0.62), metallic);
    float spec = pow(ndh, specPower) * specAmt * roughMod * (0.55 + 0.95 * fresnel) * smoothstep(-0.02, 0.42, ndl) * bakedAO;
    lit += specTint * spec;

    // Metallic grazing sky/ground reflection gives steel & doors unmistakable industrial sheen
    if (metallic > 0.01) {
      vec3 reflDir = reflect(-viewDir, bumpN);
      vec3 envRefl = mix(uGroundBounce * 0.62, uSkyFill * 1.18, smoothstep(-0.25, 0.55, reflDir.y));
      vec3 f0 = mix(vec3(0.08), pigment * 0.92 + vec3(0.16), metallic);
      lit += envRefl * f0 * (0.14 + 0.56 * fresnel) * metallic * (0.65 + 0.55 * heightVal) * bakedAO;
    }

    return lit;
  }

  vec3 desertLitFinish(vec3 pigment, vec3 N, vec3 viewDir, float bakedAO, float heightVal, int layer) {
    float hqBoost = mix(1.0, 1.25, uHighQuality);
    float metallic    = (layer == 1) ? 0.82 : 0.0;
    float specPower   = (layer == 1) ? 54.0 : (layer == 2) ? 26.0 : (layer == 4) ? 18.0 : (layer == 0) ? 12.0 : (layer == 5) ? 10.0 : 8.0;
    float specAmt     = ((layer == 1) ? 0.46 : (layer == 2) ? 0.15 : (layer == 4) ? 0.095 : (layer == 0) ? 0.055 : (layer == 5) ? 0.04 : 0.02) * mix(1.0, 1.25, uHighQuality);
    float bumpStr     = ((layer == 1) ? 0.28 : (layer == 2) ? 0.48 : (layer == 3) ? 0.25 : (layer == 4) ? 0.46 : (layer == 5) ? 0.54 : 0.40) * hqBoost;
    float wrapDiff    = (layer == 3) ? 0.55 : (layer == 4) ? 0.20 : 0.08;
    float creviceDep  = (layer == 5) ? 0.62 : (layer == 2) ? 0.52 : (layer == 0) ? 0.36 : (layer == 4) ? 0.38 : (layer == 1) ? 0.26 : 0.18;

    // Material-authentic crevice colors: pale dusty lime mortar on brick, deep dark umber on wood planks, dusty sand on cobbles!
    vec3 creviceTint = pigment * 0.72;
    if (layer == 5) creviceTint = mix(pigment * 0.74, uHazeColor * 0.76, 0.58);
    else if (layer == 2) creviceTint = pigment * vec3(0.56, 0.50, 0.44);
    else if (layer == 4) creviceTint = mix(pigment * 0.76, uGroundBounce * 0.52, 0.42);
    else if (layer == 0) creviceTint = mix(pigment * 0.74, uHazeColor * 0.58, 0.24);
    else if (layer == 1) creviceTint = pigment * 0.62;

    return shadeMaterialPBR(pigment, N, viewDir, bakedAO, heightVal, metallic, specPower, specAmt, bumpStr, wrapDiff, creviceDep, creviceTint);
  }

  // Safe color-preserving pigment mapper: prevents dark shadowed vertices from blowing up into
  // neon paint while faithfully retaining authentic CS2 wall accents, trims & landmarks.
  vec3 arenaPigment(vec3 source, vec3 base) {
    float luminance = dot(source, uArenaLuma);
    float hi = max(source.r, max(source.g, source.b));
    float lo = min(source.r, min(source.g, source.b));
    // Stabilized denominator prevents dim shadowed noise from reading as high chroma!
    float chroma = (hi - lo) / max(hi + 0.08, 0.16);
    float lumaGate = smoothstep(0.08, 0.24, luminance);
    float fadedPaint = 0.24 * smoothstep(0.10, 0.34, chroma);
    float landmark = 0.64 * smoothstep(0.28, 0.60, chroma);
    float accent = (fadedPaint + landmark) * lumaGate;
    float targetPeak = mix(0.58, 0.76, smoothstep(0.14, 0.55, hi));
    vec3 normalizedSource = source * (targetPeak / max(hi, 0.18));
    float nsLuma = dot(normalizedSource, uArenaLuma);
    normalizedSource = mix(vec3(nsLuma), normalizedSource, 0.84);
    // Keep subtle authentic tonal variation from source even on neutral walls
    float baseBlend = clamp(0.12 * lumaGate + accent * 0.82, 0.0, 0.86);
    return mix(base, normalizedSource, baseBlend);
  }

  vec3 applyDesertAtmosphere(vec3 color, vec3 worldPos) {
    float dist = length(cameraPosition - worldPos);
    float fog = smoothstep(34.0, 134.0, dist) * 0.24;
    vec3 graded = mix(color, uHazeColor, fog);
    graded = clamp(graded, 0.0, 1.35);
    return graded * (graded * 0.18 + 0.88) / (graded * 0.24 + 0.82);
  }
`;

export function applySurfaceDetail(material, texture, mapId) {
  const profile = texture.userData.profiles[mapId] || [0, 4, 1, 1, [1, 1, 1]];
  const finishes = texture.userData.finishes;
  const local = texture.userData.mapTiles === true;
  const rules = local ? assignments[mapId] || {} : {};
  material.customProgramCacheKey = () => (local ? 'dust2-plane-finishes-v3-' : 'dust2-architectural-surfaces-v4-') + finishes.length;
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, {
      uSurfaceDetail: {value:texture},
      uFinishScale: {value:finishes.map(([,metres]) => 1 / metres)},
      uFinishContrast: {value:finishes.map(([, ,contrast]) => contrast)},
      uTagLayer: {value:[rules.plainConcrete ? 3 : profile[0],1,2,rules.plasterWall ? 0 : 3,profile[1],rules.brickWall ? 0 : 5]},
      uFloorSlabs: {value:!!rules.floorSlabs},
      uMapFinish: {value:new Vector4(...profile.slice(0,4))},
      uGrainPigment: {value:new Vector3(...profile[4])},
      uUseSmoothNormals: {value:material.userData.hasSmoothNormals ? 1.0 : 0.0},
    });
    if (local) {
      const atm = MAP_ATMOSPHERE[mapId] || MAP_ATMOSPHERE.de_dust2;
      shader.uniforms.uArenaBase = {value:arena.mapLayers[mapId].map(rgb => new Vector3(...rgb))};
      shader.uniforms.uSourcePlates = {value:plates[mapId].map(pair => new Vector2(...pair))};
      shader.uniforms.uArenaKey = {value:new Vector3(...arena.keyDirection).normalize()};
      shader.uniforms.uArenaLuma = {value:new Vector3(...arena.sourceLuma)};
      shader.uniforms.uSunTint = {value:new Vector3(...atm.sun)};
      shader.uniforms.uSkyFill = {value:new Vector3(...atm.sky)};
      shader.uniforms.uGroundBounce = {value:new Vector3(...atm.bounce)};
      shader.uniforms.uHazeColor = {value:new Vector3(...atm.haze)};
      shader.uniforms.uHighQuality = {value:material.userData.highQuality ? 1.0 : 0.0};
      material.userData.surfaceUniforms = shader.uniforms;
    }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uUseSmoothNormals;\nvarying vec3 surfaceWorld;\nvarying float surfaceClass;\nvarying vec3 surfaceSmoothNormal;\nvarying float hasSmoothNormal;')
      .replace('#include <color_vertex>', `#include <color_vertex>
        surfaceClass = 255.0;
        #ifdef USE_COLOR_ALPHA
          surfaceClass = floor(255.0 * color.a + 0.5);
          vColor.a = 1.0;
        #endif`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        surfaceWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
        surfaceSmoothNormal = uUseSmoothNormals > 0.5 ? normalize(mat3(modelMatrix) * normal) : vec3(0.0, 1.0, 0.0);
        hasSmoothNormal = uUseSmoothNormals;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n#define FINISH_COUNT ' + finishes.length + '\n' + finishUniforms + '\n' + (local ? arenaUniforms : '') + '\n' + ladderFinishGLSL)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 dx = dFdx(surfaceWorld), dy = dFdy(surfaceWorld);
        vec3 flatN = cross(dx, dy);
        vec3 faceN = flatN * inversesqrt(max(dot(flatN, flatN), 1e-20));
        vec3 shadeN = hasSmoothNormal > 0.5
          ? normalize(mix(faceN, normalize(surfaceSmoothNormal), 0.82))
          : faceN;
        if (dot(shadeN, faceN) < 0.0) shadeN = -shadeN;

        if (surfaceClass >= .5 && surfaceClass < 6.5) {
          int tag = int(floor(surfaceClass + .5));
          int layer = uTagLayer[tag-1];
          if (tag == 1 && uFloorSlabs) {
            if (faceN.y > .74) layer = int(uMapFinish.y);
          }
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
            vec3 pig = arenaPigment(diffuseColor.rgb, uArenaBase[layer]);
            float ao = extractBakedAO(dot(diffuseColor.rgb, uArenaLuma), uSourcePlates[layer]);
            float macro = macroWeather(surfaceWorld);
            float macroAmp = (layer == 3 || layer == 4) ? 0.14 : (layer == 0 || layer == 5) ? 0.10 : 0.06;
            pig *= 1.0 + (macro - 0.5) * macroAmp;
            // Preserve crisp distinct material contrast (wood/brick/ground punchier, plaster softer)
            float layerContrast = (layer == 2 || layer == 5) ? 0.84 : (layer == 4 || layer == 0) ? 0.74 : (layer == 1) ? 0.66 : 0.52;
            float strength = visibility * uFinishContrast[layer] * uMapFinish.w * layerContrast;
            pig *= vec3(1.) + uGrainPigment * (2. * detail - 1.) * strength;
            vec3 viewDir = arenaNormal(cameraPosition - surfaceWorld);
            diffuseColor.rgb = applyDesertAtmosphere(desertLitFinish(pig, shadeN, viewDir, ao, mix(0.5, detail, visibility), layer), surfaceWorld);
          ` : `
            if (visibility > 0.) {
              float strength = visibility * uFinishContrast[layer] * uMapFinish.w;
              diffuseColor.rgb *= vec3(1.) + uGrainPigment * (2.*detail - 1.) * strength;
            }
          `}
        }
        ${local ? `
        if (surfaceClass > 254.5) {
          // Untagged props, crates, cars, trim & landmarks:
          // NEVER snap across hard per-pixel if-thresholds or overwrite authentic CS2 colors with uArenaBase!
          // Instead compute smooth continuous material weights -> zero mid-triangle color seams or bump flashes.
          vec3 src = diffuseColor.rgb;
          float hi = max(src.r, max(src.g, src.b)), lo = min(src.r, min(src.g, src.b));
          float chroma = (hi - lo) / max(hi + 0.08, 0.16);
          float y = dot(src, uArenaLuma);

          float wUp    = smoothstep(0.60, 0.82, faceN.y);
          float wWood  = (1.0 - wUp) * smoothstep(0.06, 0.18, src.r - src.b) * smoothstep(0.02, 0.14, src.g - src.b) * (1.0 - smoothstep(0.48, 0.72, hi));
          float wMetal = (1.0 - wUp) * (1.0 - wWood) * smoothstep(0.015, 0.075, src.b - src.r) * (1.0 - smoothstep(0.32, 0.56, hi));

          // Sample continuous mineral/stone detail + blend wood or ground smoothly without hard branches
          float stoneScale = uFinishScale[3] * 1.15;
          vec3 pStone = surfaceWorld * stoneScale;
          vec3 dxS = dx * stoneScale, dyS = dy * stoneScale;
          float minor = length(cross(dxS, dyS)) / max(max(length(dxS), length(dyS)), 1e-10);
          float visibility = 1. - smoothstep(.18, .58, minor);
          float detail = 0.5;
          if (visibility > 0.) {
            float dStone = directionalFinish(pStone, dxS, dyS, 3.0);
            detail = dStone;
            if (wWood > 0.05) {
              float ws = uFinishScale[2];
              float dWood = directionalFinish(surfaceWorld * ws, dx * ws, dy * ws, 2.0);
              detail = mix(detail, dWood, wWood);
            } else if (wUp > 0.05) {
              float gs = uFinishScale[4];
              float dGround = directionalFinish(surfaceWorld * gs, dx * gs, dy * gs, 4.0);
              detail = mix(detail, dGround, wUp);
            } else if (wMetal > 0.05) {
              float ms = uFinishScale[1];
              float dMetal = directionalFinish(surfaceWorld * ms, dx * ms, dy * ms, 1.0);
              detail = mix(detail, dMetal, wMetal);
            }
          }

          // Keep authentic CS2 prop albedo with gentle exposure lift (never shifts neutral grey into teal!)
          float lift = mix(1.38, 1.04, smoothstep(0.08, 0.62, y));
          vec3 pig = clamp(src * lift, 0.0, 0.96);
          float macro = macroWeather(surfaceWorld);
          pig *= 1.0 + (macro - 0.5) * 0.07;
          float grainScale = mix(0.42, 0.20, smoothstep(0.22, 0.55, chroma));
          pig *= vec3(1.) + (2. * detail - 1.) * visibility * grainScale;

          float ao = extractBakedAO(y, uSourcePlates[6]);
          vec3 viewDir = arenaNormal(cameraPosition - surfaceWorld);
          float metallic = wMetal * 0.72;
          float specPower = mix(mix(12.0, 26.0, wWood), 48.0, wMetal);
          float specAmt = mix(mix(0.045, 0.14, wWood), 0.36, wMetal) * mix(1.0, 1.25, uHighQuality);
          float bumpStr = mix(0.24, 0.38, max(wWood, wUp)) * (1.0 - 0.50 * smoothstep(0.25, 0.60, chroma));
          vec3 creviceTint = mix(pig * 0.74, pig * vec3(0.58, 0.52, 0.46), wWood);
          vec3 shaded = shadeMaterialPBR(
            pig, shadeN, viewDir, ao, mix(0.5, detail, visibility),
            metallic, specPower, specAmt, bumpStr, 0.18, 0.28, creviceTint
          );
          diffuseColor.rgb = applyDesertAtmosphere(mix(src * (0.86 + 0.22 * ao), shaded, 0.86), surfaceWorld);
        }
        ` : ''}
        ${shadeLadderGLSL}`);
  };
}
