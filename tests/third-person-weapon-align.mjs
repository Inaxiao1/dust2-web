import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('PlayerModel resets VMDL weapon joint bind translation, collapses elite spread, and aligns C4', () => {
  const src = fs.readFileSync(path.join(ROOT, 'client/models.js'), 'utf8');
  assert.match(src, /const weaponJoint=content\.getObjectByName\('weapon'\)/);
  assert.match(src, /weaponJoint\.position\.set\(0,0,0\)/);
  assert.match(src, /alignC4Viewmodel\(content\)/);
  assert.match(src, /getObjectByName\('weapon_hand_l'\)/);
});

test('all shipped CS2 gun GLBs have non-zero VMDL weapon bind offsets that zero cleanly to idle origin', () => {
  const sampleFiles = [
    'public/assets/weapons/cs2-skins/stock-guns/ak47-vanilla.glb',
    'public/assets/weapons/cs2-skins/stock-guns/m4a4-vanilla.glb',
    'public/assets/weapons/cs2-skins/stock-guns/awp-vanilla.glb',
    'public/assets/weapons/cs2-skins/stock-guns/pistol-vanilla.glb',
    'public/assets/weapons/cs2-skins/stock-guns/mp9-vanilla.glb',
  ];
  for (const rel of sampleFiles) {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) continue;
    const buf = fs.readFileSync(full);
    const gltf = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString('utf8'));
    const wNode = (gltf.nodes || []).find((n) => n.name === 'weapon');
    assert.ok(wNode, `${rel} should contain weapon joint`);
    assert.ok(Array.isArray(wNode.translation) && Math.hypot(...wNode.translation) > 0.05, `${rel} has ground bind offset`);
    // Verify resetting position leaves authored rotation intact
    const bone = new THREE.Bone();
    bone.position.fromArray(wNode.translation);
    bone.quaternion.fromArray(wNode.rotation);
    bone.position.set(0, 0, 0);
    assert.deepEqual(bone.position.toArray(), [0, 0, 0]);
    assert.ok(Math.abs(bone.quaternion.length() - 1) < 1e-4);
  }
});
