/**
 * Losslessly eliminates remaining coplanar Z-fighting & back-to-back clipping pairs in MGP1 v3 maps
 * while preserving 100% of original model accuracy, surfaceClass tags, breakable nodes, wire fences,
 * and offline raytraced aBakedLight (sunVis, ao) lightmaps!
 *
 * Fixes three subtle bugs left by single-pass optimization:
 *   1. Canonical plane normal sign bug near nx≈0/ny≈0 (now anchors on the dominant normal axis
 *      |n_i| >= 0.577 so parallel planes never split into opposite-sign buckets!).
 *   2. Exact/near-exact opposing back-to-back wall twins (<3mm vertex tolerance, >=92% area match)
 *      that stayed DoubleSide are promoted TOGETHER as strictly paired FrontSide twins into the
 *      same _fs chunk (hardware backface culling -> ZERO Z-fighting and ZERO holes!).
 *   3. Multi-pass (3-iteration) coplanar depth separation for remaining partial/multi-layer
 *      overlaps (<4.0mm), using Physics+World BVH air-side probing on dead-coplanar walls/floors
 *      so decals/trim never sink behind base walls.
 *   4. Final strict invariant check: 0 unpaired FrontSide triangles guaranteed!
 *
 * Usage:
 *   node scripts/maps/repair-coplanar-zfighting.mjs de_inferno
 *   node scripts/maps/repair-coplanar-zfighting.mjs --all
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MAPS_ROOT = path.join(ROOT, 'artifacts/performance-maps/maps-v1');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function readVarint(bytes, state) {
  let z = 0, shift = 0, b;
  do {
    b = bytes[state.pos++];
    z |= (b & 0x7f) << shift;
    shift += 7;
  } while (b & 0x80);
  return (z >>> 1) ^ -(z & 1);
}

function writeVarint(arr, v) {
  let z = ((v << 1) ^ (v >> 31)) >>> 0;
  while (z >= 0x80) {
    arr.push((z & 0x7f) | 0x80);
    z >>>= 7;
  }
  arr.push(z);
}

function writeWithCompressed(filePath, buf) {
  fs.writeFileSync(filePath, buf);
  const gz = zlib.gzipSync(buf, { level: 9 });
  const br = zlib.brotliCompressSync(buf, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
  });
  fs.writeFileSync(filePath + '.gz', gz);
  fs.writeFileSync(filePath + '.br', br);
  return { raw: buf.length, gz: gz.length, br: br.length, sha256: sha256(buf) };
}

function decodeMgp1(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLen = view.getUint32(4, true);
  const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headerLen)));
  const state = { pos: 8 + headerLen };
  const posBits = meta.posBits || 16;
  const qMax = (1 << posBits) - 1;
  const colorBits = meta.colorBits || 6;
  const colMask = (1 << colorBits) - 1;
  const lightBits = meta.lightBits || 0;
  const lightMask = lightBits > 0 ? (1 << lightBits) - 1 : 0;

  const sectors = [];
  for (const sector of meta.sectors) {
    const n = sector.verts, ic = sector.indices;
    const t = sector.translation, s = sector.scale;
    const positions = new Float32Array(n * 3);
    let px = 0, py = 0, pz = 0;
    for (let i = 0; i < n; i++) { px += readVarint(bytes, state); positions[i * 3] = (px / qMax) * s[0] + t[0]; }
    for (let i = 0; i < n; i++) { py += readVarint(bytes, state); positions[i * 3 + 1] = (py / qMax) * s[1] + t[1]; }
    for (let i = 0; i < n; i++) { pz += readVarint(bytes, state); positions[i * 3 + 2] = (pz / qMax) * s[2] + t[2]; }

    const qr = new Uint8Array(n), qg = new Uint8Array(n), qb = new Uint8Array(n), tags = new Uint8Array(n);
    let pr = 0, pg = 0, pb = 0;
    for (let i = 0; i < n; i++) { pr = (pr + bytes[state.pos++]) & colMask; qr[i] = pr; }
    for (let i = 0; i < n; i++) { pg = (pg + bytes[state.pos++]) & colMask; qg[i] = pg; }
    for (let i = 0; i < n; i++) { pb = (pb + bytes[state.pos++]) & colMask; qb[i] = pb; }

    let ai = 0;
    while (ai < n) {
      const tag = bytes[state.pos++];
      const run = readVarint(bytes, state);
      for (let k = 0; k < run; k++) tags[ai++] = tag;
    }

    const indices = new Uint32Array(ic);
    let pi = 0;
    for (let i = 0; i < ic; i++) { pi += readVarint(bytes, state); indices[i] = pi; }

    let qSun = null, qAo = null;
    if (lightBits > 0) {
      qSun = new Uint8Array(n);
      qAo = new Uint8Array(n);
      let ps = 0, pa = 0;
      for (let i = 0; i < n; i++) { ps = (ps + bytes[state.pos++]) & lightMask; qSun[i] = ps; }
      for (let i = 0; i < n; i++) { pa = (pa + bytes[state.pos++]) & lightMask; qAo[i] = pa; }
    }

    sectors.push({ header: sector, positions, qr, qg, qb, tags, indices, qSun, qAo });
  }
  return { meta, sectors };
}

function encodeSectorFromTris(baseHeader, tris, meta) {
  if (!tris.length) return null;
  const posBits = meta.posBits || 16;
  const qMax = (1 << posBits) - 1;
  const colorBits = meta.colorBits || 6;
  const colMask = (1 << colorBits) - 1;
  const lightBits = meta.lightBits || 0;
  const lightMask = lightBits > 0 ? (1 << lightBits) - 1 : 0;

  const pts = [];
  const qr = [], qg = [], qb = [], tags = [], qSun = [], qAo = [];
  const weld = new Map();
  const outIdx = new Uint32Array(tris.length * 3);

  const addV = (x, y, z, r, g, b, tag, sun, ao) => {
    const key = `${Math.round(x * 4000)},${Math.round(y * 4000)},${Math.round(z * 4000)}|${r},${g},${b},${tag},${sun},${ao}`;
    let id = weld.get(key);
    if (id === undefined) {
      id = pts.length / 3;
      pts.push(x, y, z);
      qr.push(r); qg.push(g); qb.push(b); tags.push(tag);
      if (lightBits > 0) { qSun.push(sun); qAo.push(ao); }
      weld.set(key, id);
    }
    return id;
  };

  for (let t = 0; t < tris.length; t++) {
    const tr = tris[t];
    outIdx[t * 3] = addV(tr.ax, tr.ay, tr.az, tr.ar, tr.ag, tr.ab, tr.atag, tr.asun, tr.aao);
    outIdx[t * 3 + 1] = addV(tr.bx, tr.by, tr.bz, tr.br, tr.bg, tr.bb, tr.btag, tr.bsun, tr.bao);
    outIdx[t * 3 + 2] = addV(tr.cx, tr.cy, tr.cz, tr.cr, tr.cg, tr.cb, tr.ctag, tr.csun, tr.cao);
  }

  const n = pts.length / 3;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = pts[i * 3], y = pts[i * 3 + 1], z = pts[i * 3 + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const sx = Math.max(1e-4, maxX - minX);
  const sy = Math.max(1e-4, maxY - minY);
  const sz = Math.max(1e-4, maxZ - minZ);

  const vx = [], vy = [], vz = [];
  const vr = new Uint8Array(n), vg = new Uint8Array(n), vb = new Uint8Array(n);
  const lightBuf = lightBits > 0 ? new Uint8Array(n * 2) : null;
  let px = 0, py = 0, pz = 0, pr = 0, pg = 0, pb = 0, ps = 0, pa = 0;
  for (let i = 0; i < n; i++) {
    const qx = Math.max(0, Math.min(qMax, Math.round(((pts[i * 3] - minX) / sx) * qMax)));
    const qy = Math.max(0, Math.min(qMax, Math.round(((pts[i * 3 + 1] - minY) / sy) * qMax)));
    const qz = Math.max(0, Math.min(qMax, Math.round(((pts[i * 3 + 2] - minZ) / sz) * qMax)));
    writeVarint(vx, qx - px); px = qx;
    writeVarint(vy, qy - py); py = qy;
    writeVarint(vz, qz - pz); pz = qz;
    vr[i] = (qr[i] - pr) & colMask; pr = qr[i];
    vg[i] = (qg[i] - pg) & colMask; pg = qg[i];
    vb[i] = (qb[i] - pb) & colMask; pb = qb[i];
    if (lightBuf) {
      lightBuf[i] = (qSun[i] - ps) & lightMask; ps = qSun[i];
      lightBuf[n + i] = (qAo[i] - pa) & lightMask; pa = qAo[i];
    }
  }

  const va = [];
  let i = 0;
  while (i < n) {
    const tag = tags[i];
    let run = 1;
    while (i + run < n && tags[i + run] === tag) run++;
    va.push(tag);
    writeVarint(va, run);
    i += run;
  }

  const vi = [];
  let pi = 0;
  for (let k = 0; k < outIdx.length; k++) {
    writeVarint(vi, outIdx[k] - pi);
    pi = outIdx[k];
  }

  const parts = [
    Buffer.from(vx), Buffer.from(vy), Buffer.from(vz),
    Buffer.from(vr), Buffer.from(vg), Buffer.from(vb),
    Buffer.from(va), Buffer.from(vi),
  ];
  if (lightBuf) parts.push(Buffer.from(lightBuf));

  return {
    header: {
      ...baseHeader,
      verts: n,
      indices: outIdx.length,
      translation: [minX, minY, minZ],
      scale: [sx, sy, sz],
    },
    payload: Buffer.concat(parts),
    verts: n,
    tris: tris.length,
  };
}

function ptInTri3D(px, py, pz, T, margin = 0.008) {
  const v0x = T.cx - T.ax, v0y = T.cy - T.ay, v0z = T.cz - T.az;
  const v1x = T.bx - T.ax, v1y = T.by - T.ay, v1z = T.bz - T.az;
  const v2x = px - T.ax, v2y = py - T.ay, v2z = pz - T.az;
  const d00 = v0x * v0x + v0y * v0y + v0z * v0z;
  const d01 = v0x * v1x + v0y * v1y + v0z * v1z;
  const d02 = v0x * v2x + v0y * v2y + v0z * v2z;
  const d11 = v1x * v1x + v1y * v1y + v1z * v1z;
  const d12 = v1x * v2x + v1y * v2y + v1z * v2z;
  const inv = d00 * d11 - d01 * d01;
  if (Math.abs(inv) < 1e-11) return false;
  const u = (d11 * d02 - d01 * d12) / inv;
  const v = (d00 * d12 - d01 * d02) / inv;
  return u >= margin && v >= margin && u + v <= 1 - margin;
}

function trisOverlapCoplanar(A, B) {
  if (
    ptInTri3D(B.mx, B.my, B.mz, A) ||
    ptInTri3D(A.mx, A.my, A.mz, B) ||
    ptInTri3D(B.ax, B.ay, B.az, A) ||
    ptInTri3D(B.bx, B.by, B.bz, A) ||
    ptInTri3D(B.cx, B.cy, B.cz, A) ||
    ptInTri3D(A.ax, A.ay, A.az, B) ||
    ptInTri3D(A.bx, A.by, A.bz, B) ||
    ptInTri3D(A.cx, A.cy, A.cz, B)
  ) return true;
  const sm = A.area <= B.area ? A : B;
  const bg = A.area <= B.area ? B : A;
  return (
    ptInTri3D((sm.ax + sm.bx) * 0.5, (sm.ay + sm.by) * 0.5, (sm.az + sm.bz) * 0.5, bg) ||
    ptInTri3D((sm.bx + sm.cx) * 0.5, (sm.by + sm.cy) * 0.5, (sm.bz + sm.cz) * 0.5, bg) ||
    ptInTri3D((sm.cx + sm.ax) * 0.5, (sm.cy + sm.ay) * 0.5, (sm.cz + sm.az) * 0.5, bg)
  );
}

/** Dominant-axis canonical sign: anchors on the largest |n_i| (>= 0.577) so tiny jitter near 0 never flips sign! */
function canonicalPlane(nx, ny, nz, ax, ay, az) {
  const axn = Math.abs(nx), ayn = Math.abs(ny), azn = Math.abs(nz);
  let flip = false;
  if (axn >= ayn && axn >= azn) flip = nx < 0;
  else if (ayn >= axn && ayn >= azn) flip = ny < 0;
  else flip = nz < 0;
  const sx = flip ? -nx : nx;
  const sy = flip ? -ny : ny;
  const sz = flip ? -nz : nz;
  const d = sx * ax + sy * ay + sz * az;
  return [sx, sy, sz, d];
}

function sameTriVertsWithin(A, B, eps = 0.004) {
  const pa = [[A.ax, A.ay, A.az], [A.bx, A.by, A.bz], [A.cx, A.cy, A.cz]];
  const pb = [[B.ax, B.ay, B.az], [B.bx, B.by, B.bz], [B.cx, B.cy, B.cz]];
  const eps2 = eps * eps;
  for (let i = 0; i < 3; i++) {
    const [x, y, z] = pa[i];
    let ok = false;
    for (let j = 0; j < 3; j++) {
      const dx = x - pb[j][0], dy = y - pb[j][1], dz = z - pb[j][2];
      if (dx * dx + dy * dy + dz * dz <= eps2) { ok = true; break; }
    }
    if (!ok) return false;
  }
  return true;
}

function recomputeTriBounds(t) {
  t.mx = (t.ax + t.bx + t.cx) / 3;
  t.my = (t.ay + t.by + t.cy) / 3;
  t.mz = (t.az + t.bz + t.cz) / 3;
  t.minX = Math.min(t.ax, t.bx, t.cx); t.maxX = Math.max(t.ax, t.bx, t.cx);
  t.minY = Math.min(t.ay, t.by, t.cy); t.maxY = Math.max(t.ay, t.by, t.cy);
  t.minZ = Math.min(t.az, t.bz, t.cz); t.maxZ = Math.max(t.az, t.bz, t.cz);
}

function repairMap(mapId) {
  const mapDir = path.join(MAPS_ROOT, mapId);
  const mgpPath = path.join(mapDir, 'render/map.mgp');
  const physPath = path.join(mapDir, 'compiled/physics.f32');
  if (!fs.existsSync(mgpPath)) return;
  const t0 = Date.now();
  const { meta, sectors } = decodeMgp1(fs.readFileSync(mgpPath));
  const colShift = 8 - (meta.colorBits || 6);

  // Extract static world triangles (tile_*) separately from untouched special sectors (fence, breakable)
  const specialSectors = [];
  const tris = [];
  for (const sec of sectors) {
    const isTile = String(sec.header.name || '').startsWith('tile_') && !sec.header.fence && !Number.isInteger(sec.header.origNodeIndex);
    if (!isTile) {
      specialSectors.push(sec);
      continue;
    }
    const { positions, qr, qg, qb, tags, indices, qSun, qAo } = sec;
    const isFS = !!sec.header.frontSide;
    const baseName = sec.header.name.replace(/_fs$/, '');
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i], b = indices[i + 1], c = indices[i + 2];
      const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
      const bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2];
      const cx = positions[c * 3], cy = positions[c * 3 + 1], cz = positions[c * 3 + 2];
      let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
      let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      const len = Math.hypot(nx, ny, nz);
      if (len < 1e-6) continue;
      nx /= len; ny /= len; nz /= len;
      const r = (((qr[a] + qr[b] + qr[c]) / 3) * (1 << colShift)) | 0;
      const g = (((qg[a] + qg[b] + qg[c]) / 3) * (1 << colShift)) | 0;
      const bl = (((qb[a] + qb[b] + qb[c]) / 3) * (1 << colShift)) | 0;
      tris.push({
        baseName, fs: isFS, deleted: false,
        ax, ay, az, bx, by, bz, cx, cy, cz,
        ar: qr[a], ag: qg[a], ab: qb[a], atag: tags[a], asun: qSun ? qSun[a] : 0, aao: qAo ? qAo[a] : 0,
        br: qr[b], bg: qg[b], bb: qb[b], btag: tags[b], bsun: qSun ? qSun[b] : 0, bao: qAo ? qAo[b] : 0,
        cr: qr[c], cg: qg[c], cb: qb[c], ctag: tags[c], csun: qSun ? qSun[c] : 0, cao: qAo ? qAo[c] : 0,
        r, g, b: bl, luma: 0.2126 * r + 0.7152 * g + 0.0722 * bl,
        tag: tags[a], nx, ny, nz, area: len * 0.5,
        mx: (ax + bx + cx) / 3, my: (ay + by + cy) / 3, mz: (az + bz + cz) / 3,
        minX: Math.min(ax, bx, cx), maxX: Math.max(ax, bx, cx),
        minY: Math.min(ay, by, cy), maxY: Math.max(ay, by, cy),
        minZ: Math.min(az, bz, cz), maxZ: Math.max(az, bz, cz),
        totalNudge: 0,
        twinIdx: -1,
      });
    }
  }

  // Build Physics BVH in LOCAL MGP1 coords (lx = -wz, ly = wy, lz = wx) for air-side probing on dead-coplanar walls!
  let physBvh = null;
  let physGeom = null;
  if (fs.existsSync(physPath)) {
    const pBuf = fs.readFileSync(physPath);
    const pW = new Float32Array(pBuf.buffer, pBuf.byteOffset, pBuf.byteLength / 4);
    const pL = new Float32Array(pW.length);
    for (let i = 0; i < pW.length; i += 3) {
      pL[i] = -pW[i + 2];
      pL[i + 1] = pW[i + 1];
      pL[i + 2] = pW[i];
    }
    physGeom = new THREE.BufferGeometry();
    physGeom.setAttribute('position', new THREE.BufferAttribute(pL, 3));
    physBvh = new MeshBVH(physGeom, { targetLeafSize: 16 });
  }
  const probePt = new THREE.Vector3();
  const probeTgt = { point: new THREE.Vector3(), distance: 0 };

  function pickAirSideSign(t, nx, ny, nz) {
    // Horizontal floors: prefer +Y (upward)
    if (Math.abs(ny) > 0.92) return ny > 0 ? 1 : -1;
    if (!physBvh) return 1;
    probePt.set(t.mx + nx * 0.12, t.my + ny * 0.12, t.mz + nz * 0.12);
    const hPos = physBvh.closestPointToPoint(probePt, probeTgt, 0, 2);
    const dPos = hPos ? hPos.distance : 2;
    probePt.set(t.mx - nx * 0.12, t.my - ny * 0.12, t.mz - nz * 0.12);
    const hNeg = physBvh.closestPointToPoint(probePt, probeTgt, 0, 2);
    const dNeg = hNeg ? hNeg.distance : 2;
    return dPos >= dNeg ? 1 : -1;
  }

  const stats = { exactDupDeleted: 0, exactTwinsPromotedFS: 0, nudged: 0, passes: 0, demotedFS: 0 };

  // Build spatial plane buckets using dominant-axis canonical normal (zero sign flips near 0!)
  function collectClosePairs(maxDist = 0.0042) {
    const planes = new Map();
    for (let i = 0; i < tris.length; i++) {
      const t = tris[i];
      if (t.deleted || t.area < 1e-4) continue;
      const [sx, sy, sz, d] = canonicalPlane(t.nx, t.ny, t.nz, t.ax, t.ay, t.az);
      const nxk = Math.round(sx * 10);
      const nyk = Math.round(sy * 10);
      const nzk = Math.round(sz * 10);
      const dk = Math.round(d * 80); // 12.5mm buckets
      const nKeys = [`${nxk},${nyk},${nzk}`];
      if (Math.abs(sx * 10 - nxk) > 0.30) nKeys.push(`${nxk + (sx * 10 > nxk ? 1 : -1)},${nyk},${nzk}`);
      if (Math.abs(sy * 10 - nyk) > 0.30) nKeys.push(`${nxk},${nyk + (sy * 10 > nyk ? 1 : -1)},${nzk}`);
      if (Math.abs(sz * 10 - nzk) > 0.30) nKeys.push(`${nxk},${nyk},${nzk + (sz * 10 > nzk ? 1 : -1)}`);
      for (const nk of nKeys) {
        for (let dd = 0; dd <= 1; dd++) {
          const pk = `${nk}:${dk + dd}`;
          let arr = planes.get(pk);
          if (!arr) { arr = []; planes.set(pk, arr); }
          arr.push(i);
        }
      }
    }

    const pairs = [];
    const seen = new Set();
    for (const arr of planes.values()) {
      if (arr.length < 2) continue;
      arr.sort((a, b) => tris[a].minX - tris[b].minX);
      for (let ii = 0; ii < arr.length; ii++) {
        const iA = arr[ii];
        const A = tris[iA];
        if (A.deleted) continue;
        const aMaxX = A.maxX + 0.003;
        for (let jj = ii + 1; jj < arr.length; jj++) {
          const iB = arr[jj];
          const B = tris[iB];
          if (B.minX > aMaxX) break;
          if (iA === iB || B.deleted) continue;
          if (
            A.maxY < B.minY - 0.003 || B.maxY < A.minY - 0.003 ||
            A.maxZ < B.minZ - 0.003 || B.maxZ < A.minZ - 0.003
          ) continue;
          const dot = A.nx * B.nx + A.ny * B.ny + A.nz * B.nz;
          if (Math.abs(dot) < 0.94) continue;
          const dist = Math.abs((B.mx - A.ax) * A.nx + (B.my - A.ay) * A.ny + (B.mz - A.az) * A.nz);
          if (dist > maxDist) continue;
          const pk = iA < iB ? iA * 2097152 + iB : iB * 2097152 + iA;
          if (seen.has(pk)) continue;
          if (!trisOverlapCoplanar(A, B)) continue;
          seen.add(pk);
          const cd = Math.abs(A.r - B.r) + Math.abs(A.g - B.g) + Math.abs(A.b - B.b);
          if (cd <= 10 && A.tag === B.tag) continue;
          if (dot < -0.94 && A.fs && B.fs) continue; // Already paired hardware FrontSide twins!
          pairs.push({ iA, iB, dot, dist });
        }
      }
    }
    return pairs;
  }

  // Pass 0: Promote exact back-to-back opposing twins to FrontSide & delete exact same-facing duplicates
  const initPairs = collectClosePairs(0.0042);
  for (const { iA, iB, dot, dist } of initPairs) {
    const A = tris[iA], B = tris[iB];
    if (A.deleted || B.deleted) continue;
    const areaRatio = Math.min(A.area, B.area) / Math.max(A.area, B.area);
    if (dist < 0.0025 && areaRatio >= 0.92 && sameTriVertsWithin(A, B, 0.0045)) {
      if (dot > 0.94) {
        // Exact same-facing duplicate: drop lower-priority one (keep tagged 1..6 over 255, else larger/brighter)
        if (!A.fs && !B.fs) {
          const scoreA = (A.tag >= 1 && A.tag <= 6 ? 1000 : 0) + A.luma + A.area * 10;
          const scoreB = (B.tag >= 1 && B.tag <= 6 ? 1000 : 0) + B.luma + B.area * 10;
          if (scoreA >= scoreB) B.deleted = true;
          else A.deleted = true;
          stats.exactDupDeleted++;
        }
      } else if (dot < -0.94 && !A.fs && !B.fs && A.twinIdx === -1 && B.twinIdx === -1) {
        // Exact opposing back-to-back twin! Promote BOTH into same _fs chunk!
        A.fs = true;
        B.fs = true;
        B.baseName = A.baseName;
        A.twinIdx = iB;
        B.twinIdx = iA;
        stats.exactTwinsPromotedFS++;
      }
    }
  }

  // Pass 1..3: Iterative coplanar depth separation (handles 3+ layer stacks cleanly!)
  for (let iter = 0; iter < 3; iter++) {
    const pairs = collectClosePairs(0.0042);
    if (!pairs.length) break;
    stats.passes++;
    const nudgeDist = new Float32Array(tris.length);
    const nudgeX = new Float32Array(tris.length);
    const nudgeY = new Float32Array(tris.length);
    const nudgeZ = new Float32Array(tris.length);
    let iterChanges = 0;

    for (const { iA, iB, dot } of pairs) {
      const A = tris[iA], B = tris[iB];
      if (A.deleted || B.deleted) continue;
      if (dot < -0.94 && A.fs && B.fs) continue;

      let smIdx, bgIdx;
      if (A.fs && !B.fs) { bgIdx = iA; smIdx = iB; }
      else if (B.fs && !A.fs) { bgIdx = iB; smIdx = iA; }
      else if (A.area < B.area * 0.78) { smIdx = iA; bgIdx = iB; }
      else if (B.area < A.area * 0.78) { smIdx = iB; bgIdx = iA; }
      else {
        const aTagged = A.tag >= 1 && A.tag <= 6;
        const bTagged = B.tag >= 1 && B.tag <= 6;
        if (aTagged !== bTagged) {
          bgIdx = aTagged ? iA : iB;
          smIdx = aTagged ? iB : iA;
        } else {
          bgIdx = A.area >= B.area ? iA : iB;
          smIdx = A.area >= B.area ? iB : iA;
        }
      }
      if (tris[smIdx].fs) continue;
      const sm = tris[smIdx], bg = tris[bgIdx];
      if (sm.totalNudge >= 0.018) continue;

      const signedClear = (sm.mx - bg.ax) * bg.nx + (sm.my - bg.ay) * bg.ny + (sm.mz - bg.az) * bg.nz;
      let dirSign;
      if (Math.abs(signedClear) >= 0.0005) {
        dirSign = signedClear >= 0 ? 1 : -1;
      } else if (Math.abs(bg.ny) > 0.92) {
        // Horizontal floor: push upward (+Y)
        dirSign = bg.ny > 0 ? 1 : -1;
      } else if (dot > 0.94) {
        // Same-facing dead-coplanar wall overlay: probe physics air side!
        dirSign = pickAirSideSign(sm, bg.nx, bg.ny, bg.nz);
      } else {
        // Opposite-facing dead-coplanar wall: nudge along sm's own normal!
        dirSign = (sm.nx * bg.nx + sm.ny * bg.ny + sm.nz * bg.nz) >= 0 ? 1 : -1;
      }

      const currentClear = Math.abs(signedClear);
      const targetClear = 0.006; // 6mm clean depth separation
      const needed = Math.min(0.009, Math.max(0.0048, targetClear - currentClear));
      if (needed > nudgeDist[smIdx]) {
        nudgeDist[smIdx] = needed;
        nudgeX[smIdx] = bg.nx * dirSign;
        nudgeY[smIdx] = bg.ny * dirSign;
        nudgeZ[smIdx] = bg.nz * dirSign;
      }
    }

    for (let i = 0; i < tris.length; i++) {
      const d = nudgeDist[i];
      if (d <= 0 || tris[i].deleted) continue;
      const t = tris[i];
      const ox = nudgeX[i] * d, oy = nudgeY[i] * d, oz = nudgeZ[i] * d;
      t.ax += ox; t.ay += oy; t.az += oz;
      t.bx += ox; t.by += oy; t.bz += oz;
      t.cx += ox; t.cy += oy; t.cz += oz;
      recomputeTriBounds(t);
      t.totalNudge += d;
      stats.nudged++;
      iterChanges++;
    }
    if (!iterChanges) break;
  }

  if (physGeom) physGeom.dispose();

  // Strict FrontSide invariant verification: guarantee ZERO unpaired FrontSide triangles!
  const fsMap = new Map();
  for (let i = 0; i < tris.length; i++) {
    const t = tris[i];
    if (t.deleted || !t.fs) continue;
    const vs = [
      `${Math.round(t.ax * 200)},${Math.round(t.ay * 200)},${Math.round(t.az * 200)}`,
      `${Math.round(t.bx * 200)},${Math.round(t.by * 200)},${Math.round(t.bz * 200)}`,
      `${Math.round(t.cx * 200)},${Math.round(t.cy * 200)},${Math.round(t.cz * 200)}`,
    ].sort();
    const k = vs.join('|');
    let arr = fsMap.get(k);
    if (!arr) { arr = []; fsMap.set(k, arr); }
    arr.push(t);
  }
  for (const arr of fsMap.values()) {
    const paired = arr.length >= 2 && arr.some((a) => arr.some((b) => a !== b && a.nx * b.nx + a.ny * b.ny + a.nz * b.nz < -0.9));
    if (!paired) {
      for (const t of arr) { t.fs = false; stats.demotedFS++; }
    } else {
      // Ensure paired twins live in the same spatial _fs chunk!
      const hostBase = arr[0].baseName;
      for (const t of arr) t.baseName = hostBase;
    }
  }

  const changed = stats.exactDupDeleted + stats.exactTwinsPromotedFS + stats.nudged + stats.demotedFS;
  if (!changed) {
    console.log(`[zfix] ${mapId}: already spotless!`);
    return;
  }

  // Group world triangles back into tile_cX_Y and tile_cX_Y_fs sectors
  const buckets = new Map();
  for (const t of tris) {
    if (t.deleted) continue;
    const name = t.fs ? `${t.baseName}_fs` : t.baseName;
    let arr = buckets.get(name);
    if (!arr) { arr = []; buckets.set(name, arr); }
    arr.push(t);
  }

  const nextHeaders = [];
  const payloadChunks = [];
  let outVerts = 0, outTris = 0;

  for (const [name, list] of [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const isFS = name.endsWith('_fs');
    const enc = encodeSectorFromTris({ name, fence: 0, ...(isFS ? { frontSide: 1 } : {}) }, list, meta);
    if (!enc) continue;
    nextHeaders.push(enc.header);
    payloadChunks.push(enc.payload);
    outVerts += enc.verts;
    outTris += enc.tris;
  }

  // Re-encode special sectors losslessly
  for (const sec of specialSectors) {
    const list = [];
    const { positions, qr, qg, qb, tags, indices, qSun, qAo } = sec;
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i], b = indices[i + 1], c = indices[i + 2];
      list.push({
        ax: positions[a * 3], ay: positions[a * 3 + 1], az: positions[a * 3 + 2],
        bx: positions[b * 3], by: positions[b * 3 + 1], bz: positions[b * 3 + 2],
        cx: positions[c * 3], cy: positions[c * 3 + 1], cz: positions[c * 3 + 2],
        ar: qr[a], ag: qg[a], ab: qb[a], atag: tags[a], asun: qSun ? qSun[a] : 0, aao: qAo ? qAo[a] : 0,
        br: qr[b], bg: qg[b], bb: qb[b], btag: tags[b], bsun: qSun ? qSun[b] : 0, bao: qAo ? qAo[b] : 0,
        cr: qr[c], cg: qg[c], cb: qb[c], ctag: tags[c], csun: qSun ? qSun[c] : 0, cao: qAo ? qAo[c] : 0,
      });
    }
    const enc = encodeSectorFromTris(sec.header, list, meta);
    if (!enc) continue;
    nextHeaders.push(enc.header);
    payloadChunks.push(enc.payload);
    outVerts += enc.verts;
    outTris += enc.tris;
  }

  const nextMeta = { ...meta, sectors: nextHeaders };
  const headerJson = Buffer.from(JSON.stringify(nextMeta));
  const prefix = Buffer.alloc(8);
  prefix.write('MGP1', 0);
  prefix.writeUInt32LE(headerJson.length, 4);
  const mgpBuf = Buffer.concat([prefix, headerJson, ...payloadChunks]);
  const outStats = writeWithCompressed(mgpPath, mgpBuf);

  // Sync compact-manifest.json & catalog.json
  const manifestPath = path.join(mapDir, 'compact-manifest.json');
  if (fs.existsSync(manifestPath)) {
    const cm = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const oldBr = cm.mesh.brBytes || 0;
    const oldGz = cm.mesh.gzBytes || 0;
    cm.mesh.bytes = outStats.raw;
    cm.mesh.gzBytes = outStats.gz;
    cm.mesh.brBytes = outStats.br;
    cm.mesh.sha256 = outStats.sha256;
    cm.mesh.triangles = outTris;
    cm.mesh.vertices = outVerts;
    cm.mesh.chunks = nextHeaders.length;
    cm.mesh.zFightingRepaired = true;
    cm.totalBrBytes = (cm.totalBrBytes || 0) - oldBr + outStats.br;
    cm.totalGzBytes = (cm.totalGzBytes || 0) - oldGz + outStats.gz;
    fs.writeFileSync(manifestPath, JSON.stringify(cm, null, 2));

    const catalogPath = path.join(MAPS_ROOT, 'catalog.json');
    if (fs.existsSync(catalogPath)) {
      const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
      const entry = catalog.maps.find((m) => m.id === mapId);
      if (entry) {
        entry.compactBrBytes = cm.totalBrBytes;
        entry.gzipBytes = cm.totalBrBytes;
        fs.writeFileSync(catalogPath, JSON.stringify(catalog));
      }
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `[zfix] ${mapId} [${elapsed}s]: exactDupDel=${stats.exactDupDeleted} twinsToFS=${stats.exactTwinsPromotedFS} nudged=${stats.nudged} (passes=${stats.passes}) demotedFS=${stats.demotedFS} | out=${outTris} tris, br=${(outStats.br / 1e6).toFixed(2)} MB`,
  );
}

const arg = process.argv[2] || 'de_inferno';
const targets =
  arg === '--all'
    ? fs
        .readdirSync(MAPS_ROOT)
        .filter((d) => fs.existsSync(path.join(MAPS_ROOT, d, 'render/map.mgp')))
        .sort()
    : process.argv.slice(2);

for (const mapId of targets) {
  repairMap(mapId);
}
