import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import * as THREE from 'three';
import { decodeCompactMapMesh, decodePackedPhysics } from '../client/compact-map-codec.js';
import { decodePrivateMapCollision } from '../shared/private-map-collision.js';
import { initPhysics, raycastWorld, raycastGrenadeWorld, floorHeight } from '../shared/physics.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const MAPS_ROOT = path.join(ROOT, 'artifacts/performance-maps/maps-v1');
const DUST2 = path.join(MAPS_ROOT, 'de_dust2');

test('PVX1 compact physics decodes bit-for-bit identically to physics.f32 across optimized maps', () => {
  const maps = fs.readdirSync(MAPS_ROOT).filter((d) => fs.existsSync(path.join(MAPS_ROOT, d, 'compiled/physics.vidx'))).sort();
  assert.ok(maps.includes('de_dust2'), 'expected de_dust2 PVX1');
  for (const mapId of maps) {
    const dir = path.join(MAPS_ROOT, mapId);
    const decoded = decodePackedPhysics(fs.readFileSync(path.join(dir, 'compiled/physics.vidx')));
    const orig = fs.readFileSync(path.join(dir, 'compiled/physics.f32'));
    assert.equal(decoded.byteLength, orig.byteLength, mapId);
    const decHash = crypto.createHash('sha256').update(Buffer.from(decoded)).digest('hex');
    const origHash = crypto.createHash('sha256').update(orig).digest('hex');
    assert.equal(decHash, origHash, mapId + ' PVX1 SHA-256 mismatch');
  }
});

test('MGP1 compact mesh decodes Dust2 spatial chunks with Int16 unit normals and FrontSide Z-fighting pass', () => {
  const mgpPath = path.join(DUST2, 'render/map.mgp');
  if (!fs.existsSync(mgpPath)) return;
  const { scene, extras } = decodeCompactMapMesh(fs.readFileSync(mgpPath));
  assert.equal(extras.surfaceMaterialVersion, 1);
  // Spatial chunking drastically cuts draw calls from 63 tiles to <= 24 chunks while keeping frustum culling
  assert.ok(scene.children.length >= 4 && scene.children.length <= 28, `unexpected chunk count ${scene.children.length}`);
  let triangles = 0;
  let checkedNormals = 0;
  let frontSideMeshes = 0;
  let doubleSideMeshes = 0;
  for (const mesh of scene.children) {
    assert.ok(mesh.isMesh);
    if (mesh.material.side === THREE.FrontSide) frontSideMeshes++;
    else doubleSideMeshes++;
    const pos = mesh.geometry.getAttribute('position');
    const norm = mesh.geometry.getAttribute('normal');
    const col = mesh.geometry.getAttribute('color');
    const idx = mesh.geometry.getIndex();
    assert.ok(pos && norm && col && idx);
    assert.equal(norm.count, pos.count);
    assert.equal(norm.array.constructor, Int16Array, 'normals should use Int16 normalized buffer for 50% VRAM savings');
    assert.equal(norm.normalized, true);
    assert.equal(col.count, pos.count);
    triangles += idx.count / 3;
    for (let i = 0; i < Math.min(20, norm.count); i++) {
      const len = Math.hypot(norm.getX(i), norm.getY(i), norm.getZ(i));
      assert.ok(Number.isFinite(len) && Math.abs(len - 1) < 1e-3, `invalid normal length ${len}`);
      checkedNormals++;
    }
  }
  assert.ok(frontSideMeshes >= 1 && doubleSideMeshes >= 1, 'expected separated FrontSide and DoubleSide chunks');
  assert.ok(triangles > 160000 && triangles < 320000, `unexpected triangle count ${triangles}`);
  assert.ok(checkedNormals > 200);
});

test('MGP1 preserves exact breakable nodes for Mirage and Nuke', () => {
  for (const mapId of ['de_mirage', 'de_nuke']) {
    const dir = path.join(MAPS_ROOT, mapId);
    const mgpPath = path.join(dir, 'render/map.mgp');
    const fbPath = path.join(dir, 'flat-breakables.json');
    if (!fs.existsSync(mgpPath) || !fs.existsSync(fbPath)) continue;
    const fb = JSON.parse(fs.readFileSync(fbPath, 'utf8'));
    const decoded = decodeCompactMapMesh(fs.readFileSync(mgpPath));
    for (const [name, nodeIdx] of Object.entries(fb.nodesById)) {
      assert.equal(decoded.parser.json.nodes[nodeIdx]?.name, name, `${mapId} missing breakable node ${name}`);
      const obj = decoded.scene.getObjectByName(name);
      assert.ok(obj?.isMesh, `${mapId} missing breakable mesh ${name}`);
      assert.equal(decoded.parser.associations.get(obj)?.nodes, nodeIdx);
    }
  }
});

test('shared single-BVH collision matches per-channel filtering across player, bullet and grenade channels', async () => {
  const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
  const sig = 'b'.repeat(64);
  // Tri 0 (y=0): player only (mask=1), Tri 1 (y=1): bullet only (mask=2), Tri 2 (y=2): grenade only (mask=4), Tri 3 (y=-1): all (mask=7)
  const f32 = new Float32Array([
    -5, 0, -5, 5, 0, -5, 0, 0, 5,
    -5, 1, -5, 5, 1, -5, 0, 1, 5,
    -5, 2, -5, 5, 2, -5, 0, 2, 5,
    -5, -1, -5, 5, -1, -5, 0, -1, 5,
  ]);
  const bytes = Buffer.from(f32.buffer);
  const maskBytes = Buffer.from([1, 2, 4, 7]);
  const groupsText = JSON.stringify([]);
  const map = { id: 'de_mirage', sourceSha256: sig, physics: { triangles: 4 } };
  const policyText = JSON.stringify({
    map: map.id,
    sourceSha256: sig,
    physicsSha256: sha(bytes),
    maskSha256: sha(maskBytes),
    groupsSha256: sha(groupsText),
    excludedGroups: [],
  });
  const shared = await decodePrivateMapCollision(
    { bytes, maskBytes, groupsText, policyText, map },
    { channels: [1, 2, 4], shared: true },
  );
  assert.equal(shared.sharedPositions.length, 4 * 9);
  initPhysics(shared.sharedPositions, null, {
    mapPatches: false,
    copyPositions: false,
    sharedChannelMask: shared.sharedChannelMask,
  });
  // Player floor ray from y=10 hits y=0 (tri 0), ignoring y=2 (grenade) and y=1 (bullet)
  assert.ok(Math.abs(floorHeight(0, 0, 10, 50) - 0) < 1e-4);
  // Bullet ray from y=10 straight down hits y=1 (distance 9), ignoring y=2 (grenade)
  assert.ok(Math.abs(raycastWorld({ x: 0, y: 10, z: 0 }, { x: 0, y: -1, z: 0 }, 50) - 9) < 1e-4);
  // Grenade ray from y=10 straight down hits y=2 (distance 8)
  assert.ok(Math.abs(raycastGrenadeWorld({ x: 0, y: 10, z: 0 }, { x: 0, y: -1, z: 0 }, 50) - 8) < 1e-4);
});
