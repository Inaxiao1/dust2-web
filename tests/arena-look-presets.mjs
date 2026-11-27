import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  VISUAL_STYLE_KEY,
  VISUAL_STYLE_PRESETS,
  normalizeVisualStyle,
  getVisualStylePreset,
  getStoredVisualStyle,
  setStoredVisualStyle,
  applyVisualStyleToScene,
  getArenaPbrAtlas,
} from '../client/arena-look-presets.js';
import { loadFlatSurfaceDetail, applySurfaceDetail } from '../client/flat-surface-detail.js';

const ALL_MAPS = [
  'de_ancient', 'de_anubis', 'de_cache', 'de_dust2', 'de_inferno',
  'de_mirage', 'de_nuke', 'de_train', 'de_vertigo',
];

test('visual style presets default to cinematic and switch cleanly between cinematic and competitive', () => {
  assert.deepEqual(
    VISUAL_STYLE_PRESETS.map((p) => p.id),
    ['cinematic', 'competitive'],
  );
  assert.equal(normalizeVisualStyle(undefined), 'cinematic');
  assert.equal(normalizeVisualStyle(''), 'cinematic');
  assert.equal(normalizeVisualStyle('unknown'), 'cinematic');
  assert.equal(normalizeVisualStyle('competitive'), 'competitive');
  assert.equal(normalizeVisualStyle('B'), 'competitive');

  assert.equal(setStoredVisualStyle('competitive'), 'competitive');
  assert.equal(getStoredVisualStyle(), 'competitive');
  assert.equal(setStoredVisualStyle('cinematic'), 'cinematic');
  assert.equal(getStoredVisualStyle(), 'cinematic');
  assert.equal(VISUAL_STYLE_KEY, 'dust2.visual-style.v1');
});

test('all 9 baked maps share one RGBA8 PBR atlas and switch styles via 3 vec4 uniforms with zero recompilation', async () => {
  const atlasA = getArenaPbrAtlas();
  const atlasB = getArenaPbrAtlas();
  assert.equal(atlasA, atlasB, 'PBR atlas must be shared as a single texture instance across all maps and styles');
  assert.equal(atlasA.image.depth, 6);
  assert.equal(atlasA.format, THREE.RGBAFormat);

  const compPreset = getVisualStylePreset('competitive');
  const cinPreset = getVisualStylePreset('cinematic');

  for (const mapId of ALL_MAPS) {
    const detailTex = await loadFlatSurfaceDetail(mapId);
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    mat.userData.hasBakedLight = true;
    applySurfaceDetail(mat, detailTex, mapId);
    assert.equal(mat.userData.arenaPbrEnabled, true, `${mapId} should enable arena PBR`);

    const fakeShader = {
      uniforms: {},
      vertexShader: '#include <common>\n#include <begin_vertex>\n#include <project_vertex>',
      fragmentShader: '#include <common>\n#include <color_fragment>\n#include <lights_fragment_end>\n#include <opaque_fragment>',
    };
    mat.onBeforeCompile(fakeShader);
    assert.equal(fakeShader.uniforms.uPbrDetail.value, atlasA, `${mapId} should reuse shared PBR atlas`);

    const cacheKeyBefore = mat.customProgramCacheKey();
    const versionBefore = mat.version;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
    const root = new THREE.Group();
    root.add(mesh);

    applyVisualStyleToScene(root, 'competitive');
    assert.equal(mat.userData.visualStyle, 'competitive');
    assert.deepEqual(mat.userData.surfaceUniforms.uLookA.value.toArray().map((n) => Math.round(n * 100) / 100), compPreset.lookA);
    assert.deepEqual(mat.userData.surfaceUniforms.uLookB.value.toArray().map((n) => Math.round(n * 100) / 100), compPreset.lookB);
    assert.deepEqual(mat.userData.surfaceUniforms.uLookC.value.toArray().map((n) => Math.round(n * 100) / 100), compPreset.lookC);

    applyVisualStyleToScene(root, 'cinematic');
    assert.equal(mat.userData.visualStyle, 'cinematic');
    assert.deepEqual(mat.userData.surfaceUniforms.uLookA.value.toArray().map((n) => Math.round(n * 100) / 100), cinPreset.lookA);
    assert.equal(mat.customProgramCacheKey(), cacheKeyBefore, `${mapId}: switching styles must reuse GLSL program`);
    assert.equal(mat.version, versionBefore, `${mapId}: switching styles must not mark material dirty`);
  }
});
