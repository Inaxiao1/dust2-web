/**
 * Compact map geometry (MGP1) and bit-exact lossless collision (PVX1) decoders.
 *
 * - PVX1 reconstructs the EXACT bit-for-bit original physics.f32 ArrayBuffer so
 *   authoritative server/client SHA-256 verification and physics stay 100% identical.
 * - MGP1 decodes 16-bit/14-bit quantized, varint-delta-encoded spatial chunk meshes directly
 *   into Three.js BufferGeometries, separates hardware-culled FrontSide back-to-back geometry
 *   from DoubleSide geometry to eliminate Z-fighting, and synthesizes 38°-creased smooth
 *   Int16 normalized vertex normals on the fly (50% less normal VRAM/RAM, zero extra download!).
 */
import * as THREE from 'three';

function readVarint(bytes, state) {
  let z = 0;
  let shift = 0;
  let b;
  do {
    b = bytes[state.pos++];
    z |= (b & 0x7f) << shift;
    shift += 7;
  } while (b & 0x80);
  return (z >>> 1) ^ -(z & 1);
}

/** Reconstruct bit-exact Float32 collision buffer from PVX1 packed bytes. */
export function decodePackedPhysics(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 12 || bytes[0] !== 0x50 || bytes[1] !== 0x56 || bytes[2] !== 0x58 || bytes[3] !== 0x31) {
    throw Error('无效的压缩碰撞格式 (PVX1)');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nVerts = view.getUint32(4, true);
  const cornerCount = view.getUint32(8, true);
  const vRaw = new Uint8Array(nVerts * 12);
  for (let b = 0; b < 12; b++) {
    const base = 12 + b * nVerts;
    for (let i = 0; i < nVerts; i++) vRaw[i * 12 + b] = bytes[base + i];
  }
  const v32 = new Uint32Array(vRaw.buffer);
  const out = new Uint32Array(cornerCount * 3);
  const state = { pos: 12 + nVerts * 12 };
  let cur = 0;
  for (let i = 0; i < cornerCount; i++) {
    cur += readVarint(bytes, state);
    const src = cur * 3;
    const dst = i * 3;
    out[dst] = v32[src];
    out[dst + 1] = v32[src + 1];
    out[dst + 2] = v32[src + 2];
  }
  return out.buffer;
}

/**
 * Compute 38°-creased smooth vertex normals in a single memory-lean pass (no faceN array).
 * Returns Float32Array (unit length).
 */
export function computeCreasedNormals(positions, indices, creaseAngleDeg = 38) {
  const vertCount = positions.length / 3;
  const triCount = indices.length / 3;
  const cosLimit = Math.cos((creaseAngleDeg * Math.PI) / 180);
  const seedN = new Float32Array(vertCount * 3);
  const accumN = new Float32Array(vertCount * 3);
  const hasSeed = new Uint8Array(vertCount);

  for (let t = 0; t < triCount; t++) {
    const t3 = t * 3;
    const v0 = indices[t3];
    const v1 = indices[t3 + 1];
    const v2 = indices[t3 + 2];
    const i0 = v0 * 3;
    const i1 = v1 * 3;
    const i2 = v2 * 3;
    const ux = positions[i1] - positions[i0];
    const uy = positions[i1 + 1] - positions[i0 + 1];
    const uz = positions[i1 + 2] - positions[i0 + 2];
    const vx = positions[i2] - positions[i0];
    const vy = positions[i2 + 1] - positions[i0 + 1];
    const vz = positions[i2 + 2] - positions[i0 + 2];
    const fx = uy * vz - uz * vy;
    const fy = uz * vx - ux * vz;
    const fz = ux * vy - uy * vx;
    const len = Math.hypot(fx, fy, fz);
    if (len < 1e-10) continue;
    const nx = fx / len;
    const ny = fy / len;
    const nz = fz / len;

    for (let k = 0; k < 3; k++) {
      const vi = indices[t3 + k];
      const o = vi * 3;
      if (!hasSeed[vi]) {
        hasSeed[vi] = 1;
        seedN[o] = nx;
        seedN[o + 1] = ny;
        seedN[o + 2] = nz;
        accumN[o] = fx;
        accumN[o + 1] = fy;
        accumN[o + 2] = fz;
      } else {
        const dot = seedN[o] * nx + seedN[o + 1] * ny + seedN[o + 2] * nz;
        if (dot >= cosLimit) {
          accumN[o] += fx;
          accumN[o + 1] += fy;
          accumN[o + 2] += fz;
        }
      }
    }
  }

  for (let i = 0; i < vertCount; i++) {
    const o = i * 3;
    const len = Math.hypot(accumN[o], accumN[o + 1], accumN[o + 2]);
    if (len > 1e-10) {
      accumN[o] /= len;
      accumN[o + 1] /= len;
      accumN[o + 2] /= len;
    } else {
      accumN[o] = 0;
      accumN[o + 1] = 1;
      accumN[o + 2] = 0;
    }
  }
  return accumN;
}

/**
 * Pack unit normals into normalized Int16Array (6 B/v vs 12 B/v Float32 = 50% less GPU VRAM
 * and JS heap, while retaining ~0.00003 precision — 30x tighter than 1e-3!).
 */
function packNormalsInt16(normalsF32) {
  const out = new Int16Array(normalsF32.length);
  for (let i = 0; i < normalsF32.length; i++) {
    const v = Math.round(normalsF32[i] * 32767);
    out[i] = v > 32767 ? 32767 : v < -32767 ? -32767 : v;
  }
  return out;
}

/**
 * Decode compact MGP1 binary render package directly into a Three.js scene Group.
 * Returns { scene, extras, parser } compatible with applyFlatMaterials() and PrivateMapBreakables.
 */
export function decodeCompactMapMesh(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 16 || bytes[0] !== 0x4d || bytes[1] !== 0x47 || bytes[2] !== 0x50 || bytes[3] !== 0x31) {
    throw Error('无效的紧凑地图格式 (MGP1)');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLen = view.getUint32(4, true);
  const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headerLen)));
  const state = { pos: 8 + headerLen };

  const worldMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    side: THREE.DoubleSide,
    vertexColors: true,
  });
  worldMat.userData = { bakedSurface: true, surfaceMaterialVersion: 1 };

  const worldFrontMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    side: THREE.FrontSide,
    vertexColors: true,
  });
  worldFrontMat.userData = { bakedSurface: true, surfaceMaterialVersion: 1 };

  const fenceMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    side: THREE.DoubleSide,
    vertexColors: true,
  });
  fenceMat.userData = { bakedSurface: true, performanceFence: true };

  const scene = new THREE.Group();
  scene.name = 'compact-mgp1-world';

  const associations = new Map();
  const parserNodes = [];

  const posBits = meta.posBits || 14;
  const qMax = (1 << posBits) - 1;
  const colorBits = meta.colorBits || 6;
  const colShift = 8 - colorBits;
  const colMask = (1 << colorBits) - 1;
  const colReplicateShift = Math.max(0, colorBits - colShift);

  for (const sector of meta.sectors) {
    const n = sector.verts;
    const ic = sector.indices;
    const t = sector.translation;
    const s = sector.scale;

    const positions = new Float32Array(n * 3);
    const colors = new Uint8Array(n * 4);
    const IndexCtor = n <= 65535 ? Uint16Array : Uint32Array;
    const indices = new IndexCtor(ic);

    let px = 0;
    let py = 0;
    let pz = 0;
    for (let i = 0; i < n; i++) {
      px += readVarint(bytes, state);
      positions[i * 3] = (px / qMax) * s[0] + t[0];
    }
    for (let i = 0; i < n; i++) {
      py += readVarint(bytes, state);
      positions[i * 3 + 1] = (py / qMax) * s[1] + t[1];
    }
    for (let i = 0; i < n; i++) {
      pz += readVarint(bytes, state);
      positions[i * 3 + 2] = (pz / qMax) * s[2] + t[2];
    }

    let pr = 0;
    let pg = 0;
    let pb = 0;
    for (let i = 0; i < n; i++) {
      pr = (pr + bytes[state.pos++]) & colMask;
      colors[i * 4] = (pr << colShift) | (pr >> colReplicateShift);
    }
    for (let i = 0; i < n; i++) {
      pg = (pg + bytes[state.pos++]) & colMask;
      colors[i * 4 + 1] = (pg << colShift) | (pg >> colReplicateShift);
    }
    for (let i = 0; i < n; i++) {
      pb = (pb + bytes[state.pos++]) & colMask;
      colors[i * 4 + 2] = (pb << colShift) | (pb >> colReplicateShift);
    }

    // Run-length encoded surfaceClass tags (color.a)
    let ai = 0;
    while (ai < n) {
      const tag = bytes[state.pos++];
      const run = readVarint(bytes, state);
      for (let k = 0; k < run; k++) colors[(ai++) * 4 + 3] = tag;
    }

    let pi = 0;
    for (let i = 0; i < ic; i++) {
      pi += readVarint(bytes, state);
      indices[i] = pi;
    }

    const normalsI16 = packNormalsInt16(computeCreasedNormals(positions, indices, 38));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normalsI16, 3, true));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4, true));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();

    const mat = sector.fence ? fenceMat : sector.frontSide ? worldFrontMat : worldMat;
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.name = sector.name;
    scene.add(mesh);

    if (Number.isInteger(sector.origNodeIndex)) {
      associations.set(mesh, { nodes: sector.origNodeIndex });
      parserNodes[sector.origNodeIndex] = { name: sector.name };
    }
  }

  return {
    scene,
    extras: { surfaceMaterialVersion: 1, compactVersion: 2 },
    parser: { associations, json: { nodes: parserNodes } },
  };
}
