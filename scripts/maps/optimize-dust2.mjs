/**
 * Optimizes performance maps for clean Z-fighting-free geometry, low draw calls,
 * and minimal download / GPU memory footprint:
 * 1. Builds render/map.mgp (+ .br & .gz):
 *    - Strips obsolete red floor paint ranges
 *    - Eliminates two-color Z-fighting across the entire map:
 *      * Deduplicates exact same-winding duplicate triangles
 *      * Moves opposing back-to-back & thin coplanar twin faces to hardware FrontSide
 *        backface culling (fixes opposing two-color cross-flashing with zero missing faces!)
 *      * Nudges same-facing coplanar detail/decal/trim faces outward by +4.5mm from base walls
 *    - Merges static world sectors into spatial XZ chunks (slashing draw calls by 60-85%)
 *      while preserving exact breakable nodes (e.g. Mirage/Nuke vents) unmerged
 *    - Runs tight boundary- & seam-locked MeshoptSimplifier decimation (no 'Permissive')
 *    - Encodes at 16-bit per-chunk position precision (~0.35mm!) + 7-bit RGB + RLE tags
 * 2. Builds compiled/physics.vidx (+ .br & .gz): 100% bit-exact lossless vertex-deduplicated,
 *    byte-transposed + varint-delta collision transport (exact SHA-256 match).
 * 3. Pre-compresses Brotli (.br) for compiled JSON/mask assets and updates compact-manifest.json
 *    & catalog.json.
 *
 * Usage:
 *   node scripts/maps/optimize-dust2.mjs de_dust2
 *   node scripts/maps/optimize-dust2.mjs --all
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { MeshoptSimplifier } from 'three/addons/libs/meshopt_simplifier.module.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MAPS_ROOT = path.join(ROOT, 'artifacts/performance-maps/maps-v1');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

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

function writeVarint(arr, v) {
  let z = ((v << 1) ^ (v >> 31)) >>> 0;
  while (z >= 0x80) {
    arr.push((z & 0x7f) | 0x80);
    z >>>= 7;
  }
  arr.push(z);
}

/** 1. Build bit-exact lossless PVX1 physics package */
function buildPackedPhysics(mapDir) {
  const physPath = path.join(mapDir, 'compiled/physics.f32');
  const phys = fs.readFileSync(physPath);
  const origHash = sha256(phys);
  const u32 = new Uint32Array(phys.buffer, phys.byteOffset, phys.byteLength / 4);
  const cornerCount = u32.length / 3;

  // Use two-level Map or BigInt key to avoid millions of temporary strings on 2.7M-tri Inferno
  const vmap = new Map();
  const uniqU32 = [];
  const indices = new Uint32Array(cornerCount);
  for (let i = 0; i < cornerCount; i++) {
    const a = u32[i * 3];
    const b = u32[i * 3 + 1];
    const c = u32[i * 3 + 2];
    const key = a + '_' + b + '_' + c;
    let id = vmap.get(key);
    if (id === undefined) {
      id = uniqU32.length / 3;
      vmap.set(key, id);
      uniqU32.push(a, b, c);
    }
    indices[i] = id;
  }

  const nVerts = uniqU32.length / 3;
  const vRaw = new Uint8Array(new Uint32Array(uniqU32).buffer);
  const vPlanes = new Uint8Array(vRaw.length);
  for (let b = 0; b < 12; b++) {
    const base = b * nVerts;
    for (let i = 0; i < nVerts; i++) vPlanes[base + i] = vRaw[i * 12 + b];
  }

  const varints = [];
  let prev = 0;
  for (let i = 0; i < cornerCount; i++) {
    writeVarint(varints, indices[i] - prev);
    prev = indices[i];
  }

  const hdr = Buffer.alloc(12);
  hdr.write('PVX1', 0);
  hdr.writeUInt32LE(nVerts, 4);
  hdr.writeUInt32LE(cornerCount, 8);
  const packed = Buffer.concat([hdr, Buffer.from(vPlanes), Buffer.from(varints)]);

  // Self-verify bit-exact roundtrip before saving!
  const decVerts = new Uint8Array(nVerts * 12);
  for (let b = 0; b < 12; b++) {
    const base = 12 + b * nVerts;
    for (let i = 0; i < nVerts; i++) decVerts[i * 12 + b] = packed[base + i];
  }
  const decV32 = new Uint32Array(decVerts.buffer);
  const outU32 = new Uint32Array(cornerCount * 3);
  let pos = 12 + nVerts * 12;
  let cur = 0;
  for (let i = 0; i < cornerCount; i++) {
    let z = 0;
    let shift = 0;
    let byte;
    do {
      byte = packed[pos++];
      z |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    cur += (z >>> 1) ^ -(z & 1);
    outU32[i * 3] = decV32[cur * 3];
    outU32[i * 3 + 1] = decV32[cur * 3 + 1];
    outU32[i * 3 + 2] = decV32[cur * 3 + 2];
  }
  const verifyHash = sha256(Buffer.from(outU32.buffer));
  if (verifyHash !== origHash) throw Error('PVX1 roundtrip hash mismatch!');

  const stats = writeWithCompressed(path.join(mapDir, 'compiled/physics.vidx'), packed);
  return {
    origRaw: phys.length,
    origGz: fs.existsSync(physPath + '.gz') ? fs.statSync(physPath + '.gz').size : phys.length,
    ...stats,
  };
}

function readPositionComponent(bin, offset, componentType, normalized) {
  if (componentType === 5126) return bin.readFloatLE(offset);
  if (componentType === 5123) {
    const v = bin.readUInt16LE(offset);
    return normalized ? v / 65535 : v;
  }
  if (componentType === 5122) {
    const v = bin.readInt16LE(offset);
    return normalized ? Math.max(v / 32767, -1) : v;
  }
  throw new Error('Unsupported POSITION componentType: ' + componentType);
}

function ptInTri3D(px, py, pz, T) {
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
  return u >= 0.008 && v >= 0.008 && u + v <= 0.992;
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
  ) {
    return true;
  }
  // Check edge midpoints of smaller triangle inside larger triangle
  const sm = A.area <= B.area ? A : B;
  const bg = A.area <= B.area ? B : A;
  return (
    ptInTri3D((sm.ax + sm.bx) * 0.5, (sm.ay + sm.by) * 0.5, (sm.az + sm.bz) * 0.5, bg) ||
    ptInTri3D((sm.bx + sm.cx) * 0.5, (sm.by + sm.cy) * 0.5, (sm.bz + sm.cz) * 0.5, bg) ||
    ptInTri3D((sm.cx + sm.ax) * 0.5, (sm.cy + sm.ay) * 0.5, (sm.cz + sm.az) * 0.5, bg)
  );
}

/**
 * Resolve exact duplicate, opposite-facing coplanar, and same-facing coplanar
 * triangles across all static world geometry to eliminate two-color Z-fighting.
 */
function resolveWorldZFighting(tris) {
  const n = tris.length;
  const deleted = new Uint8Array(n);
  const frontSide = new Uint8Array(n);
  const locked = new Uint8Array(n);
  const offsetDist = new Float32Array(n);
  const offsetDirX = new Float32Array(n);
  const offsetDirY = new Float32Array(n);
  const offsetDirZ = new Float32Array(n);

  const stats = {
    exactSameDeleted: 0,
    exactOppFrontSided: 0,
    coplanarOppFrontSided: 0,
    coplanarOppFlipped: 0,
    coplanarSameNudged: 0,
    coplanarSameDeleted: 0,
  };

  // Pass 1: Exact-vertex duplicate detection (1mm quantization)
  const exactMap = new Map();
  for (let i = 0; i < n; i++) {
    const t = tris[i];
    const qa = `${Math.round(t.ax * 1000)},${Math.round(t.ay * 1000)},${Math.round(t.az * 1000)}`;
    const qb = `${Math.round(t.bx * 1000)},${Math.round(t.by * 1000)},${Math.round(t.bz * 1000)}`;
    const qc = `${Math.round(t.cx * 1000)},${Math.round(t.cy * 1000)},${Math.round(t.cz * 1000)}`;
    const key = qa < qb
      ? (qb < qc ? qa + '|' + qb + '|' + qc : (qa < qc ? qa + '|' + qc + '|' + qb : qc + '|' + qa + '|' + qb))
      : (qa < qc ? qb + '|' + qa + '|' + qc : (qb < qc ? qb + '|' + qc + '|' + qa : qc + '|' + qb + '|' + qa));

    let bucket = exactMap.get(key);
    if (!bucket) {
      exactMap.set(key, [i]);
      continue;
    }

    let handled = false;
    for (let bi = 0; bi < bucket.length; bi++) {
      const prevIdx = bucket[bi];
      if (deleted[prevIdx]) continue;
      const P = tris[prevIdx];
      const dot = P.nx * t.nx + P.ny * t.ny + P.nz * t.nz;
      if (dot > 0.5) {
        // Exact same-winding duplicate: keep tagged (1..6) over untagged (255), else brighter
        const scoreP = (P.tag >= 1 && P.tag <= 6 ? 1000 : 0) + P.luma;
        const scoreT = (t.tag >= 1 && t.tag <= 6 ? 1000 : 0) + t.luma;
        if (scoreT > scoreP) {
          deleted[prevIdx] = 1;
          bucket[bi] = i;
        } else {
          deleted[i] = 1;
        }
        stats.exactSameDeleted++;
        handled = true;
        break;
      } else if (dot < -0.5) {
        // Exact opposing back-to-back twin! Move BOTH to FrontSide so GPU hardware
        // backface culling draws only the viewer-facing side (zero Z-fighting!).
        frontSide[prevIdx] = 1;
        frontSide[i] = 1;
        locked[prevIdx] = 1;
        locked[i] = 1;
        stats.exactOppFrontSided++;
        handled = true;
        break;
      }
    }
    if (!handled && !deleted[i]) bucket.push(i);
  }

  // Pass 2: Spatial coplanar plane buckets + 1D minX sweep-and-prune (handles huge walls/floors with ZERO misses!)
  const planes = new Map();
  for (let i = 0; i < n; i++) {
    if (deleted[i]) continue;
    const t = tris[i];
    if (t.area < 1e-4) continue;
    let snx = t.nx, sny = t.ny, snz = t.nz;
    if (snx < -1e-4 || (Math.abs(snx) <= 1e-4 && (sny < -1e-4 || (Math.abs(sny) <= 1e-4 && snz < 0)))) {
      snx = -snx; sny = -sny; snz = -snz;
    }
    const d = snx * t.ax + sny * t.ay + snz * t.az;
    const nxk = Math.round(snx * 8);
    const nyk = Math.round(sny * 8);
    const nzk = Math.round(snz * 8);
    const dk = Math.round(d * 66); // 15mm buckets
    // Insert into primary + adjacent d bucket; also mirror near normal bin boundaries so tilted faces never miss
    const nKeys = [`${nxk},${nyk},${nzk}`];
    if (Math.abs(snx * 8 - nxk) > 0.34) nKeys.push(`${nxk + (snx * 8 > nxk ? 1 : -1)},${nyk},${nzk}`);
    if (Math.abs(sny * 8 - nyk) > 0.34) nKeys.push(`${nxk},${nyk + (sny * 8 > nyk ? 1 : -1)},${nzk}`);
    if (Math.abs(snz * 8 - nzk) > 0.34) nKeys.push(`${nxk},${nyk},${nzk + (snz * 8 > nzk ? 1 : -1)}`);
    for (const nk of nKeys) {
      for (let dd = 0; dd <= 1; dd++) {
        const pkey = `${nk}:${dk + dd}`;
        let arr = planes.get(pkey);
        if (!arr) { arr = []; planes.set(pkey, arr); }
        arr.push(i);
      }
    }
  }

  const visitedPairs = new Set();
  for (const arr of planes.values()) {
    if (arr.length < 2) continue;
    arr.sort((a, b) => tris[a].minX - tris[b].minX);
    for (let ii = 0; ii < arr.length; ii++) {
      const iA = arr[ii];
      if (deleted[iA]) continue;
      const A = tris[iA];
      const aMaxX = A.maxX + 0.003;
      for (let jj = ii + 1; jj < arr.length; jj++) {
        const iB = arr[jj];
        const B = tris[iB];
        if (B.minX > aMaxX) break;
        if (iA === iB || deleted[iB]) continue;
        if (
          A.maxY < B.minY - 0.003 || B.maxY < A.minY - 0.003 ||
          A.maxZ < B.minZ - 0.003 || B.maxZ < A.minZ - 0.003
        ) continue;
        const dot = A.nx * B.nx + A.ny * B.ny + A.nz * B.nz;
        if (Math.abs(dot) < 0.90) continue;

        const signedDistBA = (B.mx - A.ax) * A.nx + (B.my - A.ay) * A.ny + (B.mz - A.az) * A.nz;
        const dist = Math.abs(signedDistBA);
        if (dist > 0.012) continue;

        const pairKey = iA < iB ? iA * 2097152 + iB : iB * 2097152 + iA;
        if (visitedPairs.has(pairKey)) continue;
        if (!trisOverlapCoplanar(A, B)) continue;
        visitedPairs.add(pairKey);

        const cd = Math.abs(A.r - B.r) + Math.abs(A.g - B.g) + Math.abs(A.b - B.b);
        const colorOrTagDiff = cd > 10 || A.tag !== B.tag;

        if (dot < -0.90) {
          if (!frontSide[iA] || !frontSide[iB]) {
            if (dist >= 0.0005 && dist <= 0.010) {
              const dirDot = (A.mx - B.mx) * A.nx + (A.my - B.my) * A.ny + (A.mz - B.mz) * A.nz;
              if (dirDot < -0.0002) {
                for (const T of [A, B]) {
                  const tx = T.bx, ty = T.by, tz = T.bz;
                  const tr = T.br, tg = T.bg, tb = T.bb;
                  T.bx = T.cx; T.by = T.cy; T.bz = T.cz;
                  T.br = T.cr; T.bg = T.cg; T.bb = T.cb;
                  T.cx = tx; T.cy = ty; T.cz = tz;
                  T.cr = tr; T.cg = tg; T.cb = tb;
                  T.nx = -T.nx; T.ny = -T.ny; T.nz = -T.nz;
                }
                stats.coplanarOppFlipped++;
              }
            }
            frontSide[iA] = 1;
            frontSide[iB] = 1;
            locked[iA] = 1;
            locked[iB] = 1;
            stats.coplanarOppFrontSided++;
          }
        } else if (dot > 0.90 && colorOrTagDiff) {
          let smIdx, bgIdx;
          if (A.area < B.area * 0.78) {
            smIdx = iA; bgIdx = iB;
          } else if (B.area < A.area * 0.78) {
            smIdx = iB; bgIdx = iA;
          } else {
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
          const sm = tris[smIdx];
          const bg = tris[bgIdx];
          const signedClear = (sm.mx - bg.ax) * bg.nx + (sm.my - bg.ay) * bg.ny + (sm.mz - bg.az) * bg.nz;
          const targetClear = 0.0055; // 5.5mm clean Z-buffer clearance
          const needed = Math.min(0.010, Math.max(0.0045, targetClear - signedClear));
          if (needed > offsetDist[smIdx]) {
            offsetDist[smIdx] = needed;
            offsetDirX[smIdx] = bg.nx;
            offsetDirY[smIdx] = bg.ny;
            offsetDirZ[smIdx] = bg.nz;
            stats.coplanarSameNudged++;
          }
          locked[smIdx] = 1;
        } else if (dot > 0.96 && !colorOrTagDiff && dist < 0.001) {
          const dropIdx = A.area <= B.area ? iA : iB;
          if (Math.min(A.area, B.area) / Math.max(A.area, B.area) > 0.85) {
            deleted[dropIdx] = 1;
            stats.coplanarSameDeleted++;
          }
        }
      }
    }
  }

  // Apply offsets in-place to nudged detail/overlay triangles
  for (let i = 0; i < n; i++) {
    const t = tris[i];
    const d = offsetDist[i];
    if (d > 0 && !deleted[i]) {
      const ox = offsetDirX[i] * d;
      const oy = offsetDirY[i] * d;
      const oz = offsetDirZ[i] * d;
      t.ax += ox; t.ay += oy; t.az += oz;
      t.bx += ox; t.by += oy; t.bz += oz;
      t.cx += ox; t.cy += oy; t.cz += oz;
      t.nudged = true;
    }
    t.frontSide = t.frontSide || frontSide[i] === 1;
    t.locked = t.locked || locked[i] === 1;
    t.deleted = t.deleted || deleted[i] === 1;
  }

  return stats;
}

/** Encode a single sector/chunk (list of triangles) into MGP1 header + binary streams */
function encodeChunk(name, tris, { isFence = false, frontSide = false, origNodeIndex = null, simplify = true, boundaryKeys = null, posBits = 16, colorBits = 6 }) {
  const qMax = (1 << posBits) - 1;
  const colShift = 8 - colorBits;
  const colMask = (1 << colorBits) - 1;

  // Partition by surfaceClass tag so material classes never bleed across triangles
  const groups = new Map();
  for (let i = 0; i < tris.length; i++) {
    const t = tris[i];
    let list = groups.get(t.tag);
    if (!list) { list = []; groups.set(t.tag, list); }
    list.push(t);
  }

  const sPts = [];
  const sCols = [];
  const sIdx = [];

  for (const [tag, list] of groups) {
    const pts = [];
    const cols = [];
    const locks = [];
    const weld = new Map();
    const gIdx = new Uint32Array(list.length * 3);

    const addVert = (x, y, z, r, g, b, triLocked, nudged) => {
      // Final encoding (simplify=false) welds at 1mm so every Stage-B Z-fighting offset stays 100% intact!
      const posScale = simplify ? 250 : 1000;
      const pk = Math.round(x * posScale) + ',' + Math.round(y * posScale) + ',' + Math.round(z * posScale);
      const shift = simplify ? 4 : 2;
      const ck = ((r >> shift) << 12) | ((g >> shift) << 6) | (b >> shift);
      const key = pk + '#' + ck + (nudged ? 'N' : '');
      let id = weld.get(key);
      if (id === undefined) {
        id = pts.length / 3;
        pts.push(x, y, z);
        cols.push(r, g, b, tag);
        const pk100 = Math.round(x * 100) + ',' + Math.round(y * 100) + ',' + Math.round(z * 100);
        const isLocked =
          !simplify ||
          isFence ||
          triLocked ||
          nudged ||
          (boundaryKeys && boundaryKeys.get(pk100) === -1)
            ? 1
            : 0;
        locks.push(isLocked);
        weld.set(key, id);
      } else if (triLocked || nudged) {
        locks[id] = 1;
      }
      return id;
    };

    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      gIdx[i * 3] = addVert(t.ax, t.ay, t.az, t.ar, t.ag, t.ab, t.locked, t.nudged);
      gIdx[i * 3 + 1] = addVert(t.bx, t.by, t.bz, t.br, t.bg, t.bb, t.locked, t.nudged);
      gIdx[i * 3 + 2] = addVert(t.cx, t.cy, t.cz, t.cr, t.cg, t.cb, t.locked, t.nudged);
    }

    const fPts = Float32Array.from(pts);
    let res = gIdx;
    if (simplify && !isFence && gIdx.length >= 60) {
      const attrs = new Float32Array(fPts.length);
      for (let i = 0; i < attrs.length; i++) {
        attrs[i] = Math.sqrt(cols[Math.floor(i / 3) * 4 + (i % 3)] / 255);
      }
      const isTagged = tag >= 1 && tag <= 6;
      const target = Math.max(3, 3 * Math.floor((gIdx.length / 3) * (isTagged ? 0.28 : 0.36)));
      // Safe non-permissive error with all Z-fighting/decal/chunk seams locked:
      // slashes GPU triangles by ~35-50% without re-introducing coplanar intersections!
      const err = isTagged ? 0.032 : 0.022;
      res = MeshoptSimplifier.simplifyWithAttributes(
        gIdx,
        fPts,
        3,
        attrs,
        3,
        [0.10, 0.14, 0.10],
        Uint8Array.from(locks),
        target,
        err,
        ['ErrorAbsolute', 'Permissive'],
      )[0];
    }

    const [used, count] = MeshoptSimplifier.compactMesh(res);
    if (count === 0 || res.length === 0) continue;

    const base = sPts.length / 3;
    const partPts = new Float32Array(count * 3);
    const partCols = new Uint8Array(count * 4);
    for (let i = 0; i < used.length; i++) {
      const dst = used[i];
      if (dst === 0xffffffff) continue;
      partPts[dst * 3] = fPts[i * 3];
      partPts[dst * 3 + 1] = fPts[i * 3 + 1];
      partPts[dst * 3 + 2] = fPts[i * 3 + 2];
      partCols[dst * 4] = cols[i * 4];
      partCols[dst * 4 + 1] = cols[i * 4 + 1];
      partCols[dst * 4 + 2] = cols[i * 4 + 2];
      partCols[dst * 4 + 3] = tag;
    }
    for (let i = 0; i < partPts.length; i++) sPts.push(partPts[i]);
    for (let i = 0; i < partCols.length; i++) sCols.push(partCols[i]);
    for (let i = 0; i < res.length; i++) sIdx.push(base + res[i]);
  }

  const count = sPts.length / 3;
  const ic = sIdx.length;
  if (!count || !ic) return null;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = sPts[i * 3], y = sPts[i * 3 + 1], z = sPts[i * 3 + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const sx = Math.max(1e-4, maxX - minX);
  const sy = Math.max(1e-4, maxY - minY);
  const sz = Math.max(1e-4, maxZ - minZ);

  const header = {
    name,
    verts: count,
    indices: ic,
    fence: isFence ? 1 : 0,
    ...(frontSide ? { frontSide: 1 } : {}),
    ...(Number.isInteger(origNodeIndex) ? { origNodeIndex } : {}),
    translation: [minX, minY, minZ],
    scale: [sx, sy, sz],
  };

  const vx = [], vy = [], vz = [], vr = [], vg = [], vb = [], va = [], vi = [];
  let px = 0, py = 0, pz = 0, pr = 0, pg = 0, pb = 0, pi = 0;
  for (let i = 0; i < count; i++) {
    const qx = Math.max(0, Math.min(qMax, Math.round(((sPts[i * 3] - minX) / sx) * qMax)));
    const qy = Math.max(0, Math.min(qMax, Math.round(((sPts[i * 3 + 1] - minY) / sy) * qMax)));
    const qz = Math.max(0, Math.min(qMax, Math.round(((sPts[i * 3 + 2] - minZ) / sz) * qMax)));
    writeVarint(vx, qx - px); px = qx;
    writeVarint(vy, qy - py); py = qy;
    writeVarint(vz, qz - pz); pz = qz;
    const r = sCols[i * 4] >> colShift;
    const gr = sCols[i * 4 + 1] >> colShift;
    const b = sCols[i * 4 + 2] >> colShift;
    vr.push((r - pr) & colMask); pr = r;
    vg.push((gr - pg) & colMask); pg = gr;
    vb.push((b - pb) & colMask); pb = b;
  }

  let i = 0;
  while (i < count) {
    const tag = sCols[i * 4 + 3];
    let run = 1;
    while (i + run < count && sCols[(i + run) * 4 + 3] === tag) run++;
    va.push(tag);
    writeVarint(va, run);
    i += run;
  }

  for (let k = 0; k < ic; k++) {
    writeVarint(vi, sIdx[k] - pi);
    pi = sIdx[k];
  }

  const payload = Buffer.concat([
    Buffer.from(vx),
    Buffer.from(vy),
    Buffer.from(vz),
    Buffer.from(vr),
    Buffer.from(vg),
    Buffer.from(vb),
    Buffer.from(va),
    Buffer.from(vi),
  ]);

  return { header, payload, verts: count, tris: ic / 3 };
}

/** 2. Build optimized, Z-fighting-free, spatially-chunked MGP1 compact mesh package */
async function buildCompactMesh(mapId, mapDir) {
  await MeshoptSimplifier.ready;
  const gltfPath = path.join(mapDir, 'render/map.gltf');
  const binPath = path.join(mapDir, 'render/map.bin');
  const manifest = JSON.parse(fs.readFileSync(path.join(mapDir, 'render-manifest.json'), 'utf8'));
  const g = JSON.parse(fs.readFileSync(gltfPath, 'utf8'));
  const bin = fs.readFileSync(binPath);

  const siteData = JSON.parse(fs.readFileSync(path.join(ROOT, 'client/flat-site-markings-data.json'), 'utf8'))[mapId];
  const publicPaint = JSON.parse(fs.readFileSync(path.join(ROOT, 'client/flat-site-release-paint.json'), 'utf8'))[mapId];
  const gltfHash = manifest.files.find((f) => f.path === 'map.gltf')?.sha256;
  const binHash = manifest.files.find((f) => f.path === 'map.bin')?.sha256;
  const paintPatch = [siteData?.replace, publicPaint].find(
    (p) => p && p.render === gltfHash && p.geometry === binHash,
  );

  // Preserve breakable nodes (e.g. de_mirage shutters/vents, de_nuke vent slats) unmerged & intact!
  const breakablesPath = path.join(mapDir, 'flat-breakables.json');
  const breakableNodeIndices = new Set();
  if (fs.existsSync(breakablesPath)) {
    const fb = JSON.parse(fs.readFileSync(breakablesPath, 'utf8'));
    for (const idx of Object.values(fb.nodesById || {})) {
      if (Number.isInteger(idx)) breakableNodeIndices.add(idx);
    }
  }

  let origTris = 0;
  let origVerts = 0;
  const worldTris = [];
  const fenceTris = [];
  const preservedNodes = [];

  for (let ni = 0; ni < g.nodes.length; ni++) {
    const node = g.nodes[ni];
    if (node.mesh === undefined) continue;
    const mesh = g.meshes[node.mesh];
    const t = node.translation || [0, 0, 0];
    const s = node.scale || [1, 1, 1];
    const p = mesh.primitives[0];
    const mat = g.materials[p.material] || {};
    const isFence = mat.extras?.performanceFence === true;
    const isPreserved = breakableNodeIndices.has(ni);

    const posAcc = g.accessors[p.attributes.POSITION];
    const colAcc = g.accessors[p.attributes.COLOR_0];
    const idxAcc = g.accessors[p.indices];
    const posBv = g.bufferViews[posAcc.bufferView];
    const colBv = g.bufferViews[colAcc.bufferView];
    const idxBv = g.bufferViews[idxAcc.bufferView];
    const posCompBytes = posAcc.componentType === 5126 ? 4 : 2;
    const posStride = posBv.byteStride || posCompBytes * 3;
    const colStride = colBv.byteStride || 4;
    const posOff = (posBv.byteOffset || 0) + (posAcc.byteOffset || 0);
    const colOff = (colBv.byteOffset || 0) + (colAcc.byteOffset || 0);
    const idxOff = (idxBv.byteOffset || 0) + (idxAcc.byteOffset || 0);
    const posNorm = !!posAcc.normalized;

    origVerts += posAcc.count;
    const xyz = new Float32Array(posAcc.count * 3);
    const rgba = new Uint8Array(posAcc.count * 4);
    for (let i = 0; i < posAcc.count; i++) {
      const o = posOff + i * posStride;
      const co = colOff + i * colStride;
      xyz[i * 3] = readPositionComponent(bin, o, posAcc.componentType, posNorm) * s[0] + t[0];
      xyz[i * 3 + 1] = readPositionComponent(bin, o + posCompBytes, posAcc.componentType, posNorm) * s[1] + t[1];
      xyz[i * 3 + 2] = readPositionComponent(bin, o + posCompBytes * 2, posAcc.componentType, posNorm) * s[2] + t[2];
      rgba[i * 4] = bin[co];
      rgba[i * 4 + 1] = bin[co + 1];
      rgba[i * 4 + 2] = bin[co + 2];
      rgba[i * 4 + 3] = bin[co + 3];
    }

    const isU32 = idxAcc.componentType === 5125;
    let rawIdx = new Uint32Array(idxAcc.count);
    for (let i = 0; i < idxAcc.count; i++) {
      rawIdx[i] = isU32 ? bin.readUInt32LE(idxOff + i * 4) : bin.readUInt16LE(idxOff + i * 2);
    }
    origTris += rawIdx.length / 3;

    // Strip obsolete red floor paint ranges if present on this sector
    const stripRanges = paintPatch?.ranges?.[node.name];
    if (stripRanges && stripRanges.length) {
      const kept = [];
      let off = 0;
      for (let r = 0; r < stripRanges.length; r += 2) {
        const start = stripRanges[r] * 3;
        const end = start + stripRanges[r + 1] * 3;
        while (off < start) kept.push(rawIdx[off++]);
        off = end;
      }
      while (off < rawIdx.length) kept.push(rawIdx[off++]);
      rawIdx = Uint32Array.from(kept);
    }

    const targetList = isPreserved ? [] : isFence ? fenceTris : worldTris;
    for (let i = 0; i < rawIdx.length; i += 3) {
      const a = rawIdx[i], b = rawIdx[i + 1], c = rawIdx[i + 2];
      const ax = xyz[a * 3], ay = xyz[a * 3 + 1], az = xyz[a * 3 + 2];
      const bx = xyz[b * 3], by = xyz[b * 3 + 1], bz = xyz[b * 3 + 2];
      const cx = xyz[c * 3], cy = xyz[c * 3 + 1], cz = xyz[c * 3 + 2];
      let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
      let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      const len = Math.hypot(nx, ny, nz);
      if (len < 1e-6) continue;
      nx /= len; ny /= len; nz /= len;
      const ar = rgba[a * 4], ag = rgba[a * 4 + 1], ab = rgba[a * 4 + 2];
      const br = rgba[b * 4], bg = rgba[b * 4 + 1], bb = rgba[b * 4 + 2];
      const cr = rgba[c * 4], cg = rgba[c * 4 + 1], cb = rgba[c * 4 + 2];
      const ta = rgba[a * 4 + 3], tb = rgba[b * 4 + 3], tc = rgba[c * 4 + 3];
      // Majority tag if mixed (prevents cross-triangle surfaceClass interpolation!)
      const tag = ta === tb || ta === tc ? ta : tb === tc ? tb : ta;
      const r = (ar + br + cr) / 3;
      const gr = (ag + bg + cg) / 3;
      const bl = (ab + bb + cb) / 3;
      targetList.push({
        ax, ay, az, bx, by, bz, cx, cy, cz,
        ar, ag, ab, br, bg, bb, cr, cg, cb,
        r, g: gr, b: bl,
        luma: 0.2126 * r + 0.7152 * gr + 0.0722 * bl,
        nx, ny, nz, area: len * 0.5, tag,
        mx: (ax + bx + cx) / 3, my: (ay + by + cy) / 3, mz: (az + bz + cz) / 3,
        minX: Math.min(ax, bx, cx), maxX: Math.max(ax, bx, cx),
        minY: Math.min(ay, by, cy), maxY: Math.max(ay, by, cy),
        minZ: Math.min(az, bz, cz), maxZ: Math.max(az, bz, cz),
        frontSide: false, locked: false, nudged: false, deleted: false,
      });
    }

    if (isPreserved) {
      preservedNodes.push({ ni, name: node.name, isFence, tris: targetList });
    }
  }

  // Run pre-simplification coplanar Z-fighting resolution on all static world triangles!
  const zStats = resolveWorldZFighting(worldTris);
  const preActive = worldTris.filter((t) => !t.deleted);

  // Stage A: Simplify static world triangles per tag & frontSide (keeping seams locked!)
  const simplifyGroup = (list) => {
    const out = [];
    const byTag = new Map();
    for (const t of list) {
      let arr = byTag.get(t.tag);
      if (!arr) { arr = []; byTag.set(t.tag, arr); }
      arr.push(t);
    }
    // Lock vertices shared across different tags or frontSide/nudged boundaries
    const tagOwner = new Map();
    for (const t of list) {
      const owner = (t.frontSide ? 1024 : 0) + (t.nudged ? 512 : 0) + t.tag;
      for (const [x, y, z] of [[t.ax, t.ay, t.az], [t.bx, t.by, t.bz], [t.cx, t.cy, t.cz]]) {
        const pk = Math.round(x * 100) + ',' + Math.round(y * 100) + ',' + Math.round(z * 100);
        const prev = tagOwner.get(pk);
        if (prev === undefined) tagOwner.set(pk, owner);
        else if (prev !== owner && prev >= 0) tagOwner.set(pk, -1);
      }
    }

    for (const [tag, tlist] of byTag) {
      // Split frontSide=true vs frontSide=false so opposing faces never weld together during simplification
      for (const isFS of [false, true]) {
        const sub = tlist.filter((t) => t.frontSide === isFS);
        if (!sub.length) continue;
        const pts = [];
        const cols = [];
        const locks = [];
        const weld = new Map();
        const gIdx = new Uint32Array(sub.length * 3);
        const addV = (x, y, z, r, g, b, triLocked, nudged) => {
          const pk = Math.round(x * 250) + ',' + Math.round(y * 250) + ',' + Math.round(z * 250);
          const ck = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
          const key = pk + '#' + ck + (nudged ? 'N' : '');
          let id = weld.get(key);
          if (id === undefined) {
            id = pts.length / 3;
            pts.push(x, y, z);
            cols.push(r, g, b, tag);
            const pk100 = Math.round(x * 100) + ',' + Math.round(y * 100) + ',' + Math.round(z * 100);
            locks.push(triLocked || nudged || tagOwner.get(pk100) === -1 ? 1 : 0);
            weld.set(key, id);
          } else if (triLocked || nudged) {
            locks[id] = 1;
          }
          return id;
        };
        for (let i = 0; i < sub.length; i++) {
          const t = sub[i];
          gIdx[i * 3] = addV(t.ax, t.ay, t.az, t.ar, t.ag, t.ab, t.locked, t.nudged);
          gIdx[i * 3 + 1] = addV(t.bx, t.by, t.bz, t.br, t.bg, t.bb, t.locked, t.nudged);
          gIdx[i * 3 + 2] = addV(t.cx, t.cy, t.cz, t.cr, t.cg, t.cb, t.locked, t.nudged);
        }
        const fPts = Float32Array.from(pts);
        let res = gIdx;
        if (!isFS && gIdx.length >= 60) {
          const attrs = new Float32Array(fPts.length);
          for (let i = 0; i < attrs.length; i++) attrs[i] = Math.sqrt(cols[Math.floor(i / 3) * 4 + (i % 3)] / 255);
          const isTagged = tag >= 1 && tag <= 6;
          const target = Math.max(3, 3 * Math.floor((gIdx.length / 3) * (isTagged ? 0.28 : 0.36)));
          const err = isTagged ? 0.032 : 0.022;
          res = MeshoptSimplifier.simplifyWithAttributes(
            gIdx, fPts, 3, attrs, 3, [0.10, 0.14, 0.10], Uint8Array.from(locks), target, err, ['ErrorAbsolute', 'Permissive'],
          )[0];
        }
        for (let i = 0; i < res.length; i += 3) {
          const a = res[i], b = res[i + 1], c = res[i + 2];
          const ax = fPts[a * 3], ay = fPts[a * 3 + 1], az = fPts[a * 3 + 2];
          const bx = fPts[b * 3], by = fPts[b * 3 + 1], bz = fPts[b * 3 + 2];
          const cx = fPts[c * 3], cy = fPts[c * 3 + 1], cz = fPts[c * 3 + 2];
          let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
          let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
          let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
          const len = Math.hypot(nx, ny, nz);
          if (len < 1e-6) continue;
          nx /= len; ny /= len; nz /= len;
          const ar = cols[a * 4], ag = cols[a * 4 + 1], ab = cols[a * 4 + 2];
          const br = cols[b * 4], bg = cols[b * 4 + 1], bb = cols[b * 4 + 2];
          const cr = cols[c * 4], cg = cols[c * 4 + 1], cb = cols[c * 4 + 2];
          const r = (ar + br + cr) / 3, gr = (ag + bg + cg) / 3, bl = (ab + bb + cb) / 3;
          out.push({
            ax, ay, az, bx, by, bz, cx, cy, cz,
            ar, ag, ab, br, bg, bb, cr, cg, cb,
            r, g: gr, b: bl, luma: 0.2126 * r + 0.7152 * gr + 0.0722 * bl,
            nx, ny, nz, area: len * 0.5, tag,
            mx: (ax + bx + cx) / 3, my: (ay + by + cy) / 3, mz: (az + bz + cz) / 3,
            minX: Math.min(ax, bx, cx), maxX: Math.max(ax, bx, cx),
            minY: Math.min(ay, by, cy), maxY: Math.max(ay, by, cy),
            minZ: Math.min(az, bz, cz), maxZ: Math.max(az, bz, cz),
            frontSide: isFS, locked: false, nudged: false, deleted: false,
          });
        }
      }
    }
    return out;
  };

  const simplifiedWorld = simplifyGroup(preActive);
  // Stage B: Final post-simplification Z-fighting cleanup catches 100% of any foldovers or overlaps introduced by MeshoptSimplifier!
  const zStatsPost = resolveWorldZFighting(simplifiedWorld);
  for (const k of Object.keys(zStats)) zStats[k] += zStatsPost[k];
  // Preserve frontSide flags from stage A as well as stage B
  const activeWorld = simplifiedWorld.filter((t) => !t.deleted);

  // Compute world XZ bounds for 3x3 spatial chunk grid (preserves frustum culling while slashing draw calls!)
  let wMinX = Infinity, wMaxX = -Infinity, wMinZ = Infinity, wMaxZ = -Infinity;
  for (const t of activeWorld) {
    if (t.mx < wMinX) wMinX = t.mx;
    if (t.mx > wMaxX) wMaxX = t.mx;
    if (t.mz < wMinZ) wMinZ = t.mz;
    if (t.mz > wMaxZ) wMaxZ = t.mz;
  }
  const gridN = 3;
  const spanX = Math.max(1, wMaxX - wMinX);
  const spanZ = Math.max(1, wMaxZ - wMinZ);

  const chunkBuckets = new Map();
  for (const t of activeWorld) {
    const gx = Math.min(gridN - 1, Math.max(0, Math.floor(((t.mx - wMinX) / spanX) * gridN)));
    const gz = Math.min(gridN - 1, Math.max(0, Math.floor(((t.mz - wMinZ) / spanZ) * gridN)));
    const cellId = (gx * gridN + gz) * 2 + (t.frontSide ? 1 : 0);
    let arr = chunkBuckets.get(cellId);
    if (!arr) { arr = []; chunkBuckets.set(cellId, arr); }
    arr.push(t);
  }

  const posBits = 16;
  const colorBits = 6;
  const sectorHeaders = [];
  const payloadChunks = [];
  let outTris = 0;
  let outVerts = 0;

  // Encode spatial world chunks (already simplified & Z-fighting cleaned -> simplify: false preserves 100% of post-cleanup offsets!)
  for (const [cellId, tris] of [...chunkBuckets.entries()].sort((a, b) => a[0] - b[0])) {
    const isFS = (cellId & 1) === 1;
    const gridIdx = cellId >> 1;
    const gx = Math.floor(gridIdx / gridN);
    const gz = gridIdx % gridN;
    const name = `tile_c${gx}_${gz}${isFS ? '_fs' : ''}`;
    const enc = encodeChunk(name, tris, {
      isFence: false,
      frontSide: isFS,
      simplify: false,
      posBits,
      colorBits,
    });
    if (!enc) continue;
    sectorHeaders.push(enc.header);
    payloadChunks.push(enc.payload);
    outVerts += enc.verts;
    outTris += enc.tris;
  }

  // Encode wire fences as a single compact chunk (or per 2x2 if huge)
  if (fenceTris.length) {
    const enc = encodeChunk('fence_world', fenceTris, {
      isFence: true,
      frontSide: false,
      simplify: false,
      posBits,
      colorBits,
    });
    if (enc) {
      sectorHeaders.push(enc.header);
      payloadChunks.push(enc.payload);
      outVerts += enc.verts;
      outTris += enc.tris;
    }
  }

  // Encode preserved breakable nodes with their exact original node indices & names
  for (const pNode of preservedNodes) {
    if (!pNode.tris.length) continue;
    const enc = encodeChunk(pNode.name, pNode.tris, {
      isFence: pNode.isFence,
      frontSide: false,
      origNodeIndex: pNode.ni,
      simplify: false,
      posBits,
      colorBits,
    });
    if (!enc) continue;
    sectorHeaders.push(enc.header);
    payloadChunks.push(enc.payload);
    outVerts += enc.verts;
    outTris += enc.tris;
  }

  const headerJson = Buffer.from(JSON.stringify({ posBits, colorBits, sectors: sectorHeaders }));
  const prefix = Buffer.alloc(8);
  prefix.write('MGP1', 0);
  prefix.writeUInt32LE(headerJson.length, 4);
  const mgpBuf = Buffer.concat([prefix, headerJson, ...payloadChunks]);
  const stats = writeWithCompressed(path.join(mapDir, 'render/map.mgp'), mgpBuf);

  return {
    origNodes: g.nodes.filter((n) => n.mesh !== undefined).length,
    outChunks: sectorHeaders.length,
    origTris,
    origVerts,
    origRaw: bin.length,
    origGz: fs.existsSync(binPath + '.gz') ? fs.statSync(binPath + '.gz').size : bin.length,
    outTris,
    outVerts,
    zStats,
    ...stats,
  };
}

/** 3. Pre-compress Brotli (.br) for remaining compiled assets */
function precompressBrotliExtras(mapDir) {
  const files = [
    'compiled/map.json',
    'compiled/nav.json',
    'compiled/physics-groups.json',
    'compiled/physics-mask.u8',
    'entity-collision-policy.json',
  ];
  let totalBr = 0;
  let totalGz = 0;
  for (const rel of files) {
    const full = path.join(mapDir, rel);
    if (!fs.existsSync(full)) continue;
    const raw = fs.readFileSync(full);
    const br = zlib.brotliCompressSync(raw, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
    });
    fs.writeFileSync(full + '.br', br);
    totalBr += br.length;
    totalGz += fs.existsSync(full + '.gz') ? fs.statSync(full + '.gz').size : br.length;
  }
  return { totalBr, totalGz };
}

async function optimizeMap(mapId) {
  const mapDir = path.join(MAPS_ROOT, mapId);
  const t0 = Date.now();
  const physStats = buildPackedPhysics(mapDir);
  const meshStats = await buildCompactMesh(mapId, mapDir);
  const extras = precompressBrotliExtras(mapDir);

  const compactManifest = {
    schemaVersion: 2,
    id: mapId,
    mesh: {
      path: 'render/map.mgp',
      bytes: meshStats.raw,
      gzBytes: meshStats.gz,
      brBytes: meshStats.br,
      sha256: meshStats.sha256,
      triangles: meshStats.outTris,
      vertices: meshStats.outVerts,
      chunks: meshStats.outChunks,
    },
    physics: {
      path: 'compiled/physics.vidx',
      bytes: physStats.raw,
      gzBytes: physStats.gz,
      brBytes: physStats.br,
      sha256: physStats.sha256,
    },
    totalBrBytes: meshStats.br + physStats.br + extras.totalBr,
    totalGzBytes: meshStats.gz + physStats.gz + extras.totalGz,
  };
  fs.writeFileSync(path.join(mapDir, 'compact-manifest.json'), JSON.stringify(compactManifest, null, 2));

  const catalogPath = path.join(MAPS_ROOT, 'catalog.json');
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const entry = catalog.maps.find((m) => m.id === mapId);
  if (entry) {
    entry.compactBrBytes = compactManifest.totalBrBytes;
    entry.gzipBytes = compactManifest.totalBrBytes;
    fs.writeFileSync(catalogPath, JSON.stringify(catalog));
  }

  const origTotalGz = meshStats.origGz + physStats.origGz + extras.totalGz;
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n=== OPTIMIZE SUMMARY (${mapId}) [${elapsed}s] ===`);
  console.log('Draw calls:', `${meshStats.origNodes} -> ${meshStats.outChunks} (-${((1 - meshStats.outChunks / meshStats.origNodes) * 100).toFixed(0)}%)`);
  console.log('Z-fighting fixes:', meshStats.zStats);
  console.log('Render Mesh:', {
    tris: `${meshStats.origTris} -> ${meshStats.outTris} (-${((1 - meshStats.outTris / meshStats.origTris) * 100).toFixed(1)}%)`,
    raw: `${(meshStats.origRaw / 1e6).toFixed(2)} MB -> ${(meshStats.raw / 1e6).toFixed(2)} MB`,
    transfer: `${(meshStats.origGz / 1e6).toFixed(2)} MB gz -> ${(meshStats.br / 1e6).toFixed(2)} MB br / ${(meshStats.gz / 1e6).toFixed(2)} MB gz`,
  });
  console.log('Physics (100% bit-exact lossless):', {
    raw: `${(physStats.origRaw / 1e6).toFixed(2)} MB -> ${(physStats.raw / 1e6).toFixed(2)} MB`,
    transfer: `${(physStats.origGz / 1e6).toFixed(2)} MB gz -> ${(physStats.br / 1e6).toFixed(2)} MB br`,
  });
  console.log('TOTAL DOWNLOAD:', `${(origTotalGz / 1e6).toFixed(2)} MB gz -> ${(compactManifest.totalBrBytes / 1e6).toFixed(2)} MB br (-${((1 - compactManifest.totalBrBytes / origTotalGz) * 100).toFixed(1)}%)`);
}

const arg = process.argv[2] || 'de_dust2';
const targets =
  arg === '--all'
    ? fs
        .readdirSync(MAPS_ROOT)
        .filter((d) => fs.existsSync(path.join(MAPS_ROOT, d, 'render/map.gltf')))
        .sort()
    : process.argv.slice(2);

for (const mapId of targets) {
  await optimizeMap(mapId);
}
