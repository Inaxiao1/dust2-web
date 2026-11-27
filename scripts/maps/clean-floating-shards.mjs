/**
 * Surgically removes detached, mid-air, and wall-protruding 2D alpha-cutout shards/cards
 * (hanging leaf cards, bougainvillea vine bursts, wall-top flowers, pillar ivy, bush/weed
 * cutout triangles, torn debris slivers) from MGP1 v3 maps while preserving 100% of:
 *   - All architectural tagged geometry (surfaceClass 1..6)
 *   - All solid/closed 3D props (railings, crates, lamps, barrels, vehicles, rocks, palm fronds)
 *   - All flush rectangular wall/floor panels (posters, signs, windows, shutters, doors)
 *   - All breakable nodes (e.g. Mirage/Nuke vents) and wire fences
 *   - All existing offline raytraced aBakedLight (sunVis, ao) lightmaps!
 *
 * Key precision upgrades over v1:
 *   1. 3 mm world-space vertex weld (instead of 2 cm) so near-wall flower/vine cutout cards
 *      do not accidentally weld onto walls.
 *   2. Uses BOTH minVertexDist AND maxVertexDist to the Structural+Physics BVH:
 *      - Real flush wall signs/posters/windows keep ALL vertices within <= 6.5 cm of solid structure.
 *      - Wall-clinging foliage/flower/vine cards touch near the wall at one edge (minD ~ 1-10 cm)
 *        while protruding obliquely into empty air (maxD > 7.5 cm).
 *   3. Strictly protects Mirage/Dust2 palm canopies and architectural overhangs/tarps.
 *
 * Usage:
 *   node scripts/maps/clean-floating-shards.mjs de_inferno
 *   node scripts/maps/clean-floating-shards.mjs --all
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

/** Decode all raw quantized streams of an MGP1 (v2 or v3) file losslessly. */
function decodeMgp1Full(bytes) {
  if (bytes.length < 16 || bytes[0] !== 0x4d || bytes[1] !== 0x47 || bytes[2] !== 0x50 || bytes[3] !== 0x31) {
    throw Error('Not a valid MGP1 file');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLen = view.getUint32(4, true);
  const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headerLen)));
  const state = { pos: 8 + headerLen };

  const posBits = meta.posBits || 14;
  const qMax = (1 << posBits) - 1;
  const colorBits = meta.colorBits || 6;
  const colMask = (1 << colorBits) - 1;
  const lightBits = meta.lightBits || 0;
  const lightMask = lightBits > 0 ? (1 << lightBits) - 1 : 0;

  const sectors = [];
  for (const sector of meta.sectors) {
    const n = sector.verts;
    const ic = sector.indices;
    const t = sector.translation;
    const s = sector.scale;

    const qx = new Int32Array(n);
    const qy = new Int32Array(n);
    const qz = new Int32Array(n);
    const positions = new Float32Array(n * 3);
    let px = 0, py = 0, pz = 0;
    for (let i = 0; i < n; i++) { px += readVarint(bytes, state); qx[i] = px; positions[i * 3] = (px / qMax) * s[0] + t[0]; }
    for (let i = 0; i < n; i++) { py += readVarint(bytes, state); qy[i] = py; positions[i * 3 + 1] = (py / qMax) * s[1] + t[1]; }
    for (let i = 0; i < n; i++) { pz += readVarint(bytes, state); qz[i] = pz; positions[i * 3 + 2] = (pz / qMax) * s[2] + t[2]; }

    const qr = new Uint8Array(n);
    const qg = new Uint8Array(n);
    const qb = new Uint8Array(n);
    const tags = new Uint8Array(n);
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
    for (let i = 0; i < ic; i++) {
      pi += readVarint(bytes, state);
      indices[i] = pi;
    }

    let qSun = null;
    let qAo = null;
    if (lightBits > 0) {
      qSun = new Uint8Array(n);
      qAo = new Uint8Array(n);
      let ps = 0, pa = 0;
      for (let i = 0; i < n; i++) { ps = (ps + bytes[state.pos++]) & lightMask; qSun[i] = ps; }
      for (let i = 0; i < n; i++) { pa = (pa + bytes[state.pos++]) & lightMask; qAo[i] = pa; }
    }

    sectors.push({
      header: sector,
      isSpecial: !!sector.fence || !!sector.frontSide || Number.isInteger(sector.origNodeIndex) || !String(sector.name || '').startsWith('tile_'),
      qx, qy, qz, positions, qr, qg, qb, tags, indices, qSun, qAo,
    });
  }

  return { meta, sectors };
}

/** Re-encode a sector after filtering its triangle list (compacting unused vertices & preserving exact quantized positions/lightmaps). */
function encodeFilteredSector(sector, keptTriFlags, meta) {
  const { qx, qy, qz, qr, qg, qb, tags, indices, qSun, qAo } = sector;
  const oldN = qx.length;
  const triCount = indices.length / 3;
  const colorBits = meta.colorBits || 6;
  const colMask = (1 << colorBits) - 1;
  const lightBits = meta.lightBits || 0;
  const lightMask = lightBits > 0 ? (1 << lightBits) - 1 : 0;

  const used = new Uint8Array(oldN);
  let keptTris = 0;
  for (let t = 0; t < triCount; t++) {
    if (!keptTriFlags[t]) continue;
    keptTris++;
    used[indices[t * 3]] = 1;
    used[indices[t * 3 + 1]] = 1;
    used[indices[t * 3 + 2]] = 1;
  }
  if (keptTris === 0) return null;

  const remap = new Int32Array(oldN).fill(-1);
  let newN = 0;
  for (let i = 0; i < oldN; i++) {
    if (used[i]) remap[i] = newN++;
  }

  const vx = [], vy = [], vz = [];
  const vr = new Uint8Array(newN);
  const vg = new Uint8Array(newN);
  const vb = new Uint8Array(newN);
  const newTags = new Uint8Array(newN);
  const lightBuf = lightBits > 0 ? new Uint8Array(newN * 2) : null;

  let px = 0, py = 0, pz = 0, pr = 0, pg = 0, pb = 0, ps = 0, pa = 0;
  let dst = 0;
  for (let i = 0; i < oldN; i++) {
    if (!used[i]) continue;
    writeVarint(vx, qx[i] - px); px = qx[i];
    writeVarint(vy, qy[i] - py); py = qy[i];
    writeVarint(vz, qz[i] - pz); pz = qz[i];
    vr[dst] = (qr[i] - pr) & colMask; pr = qr[i];
    vg[dst] = (qg[i] - pg) & colMask; pg = qg[i];
    vb[dst] = (qb[i] - pb) & colMask; pb = qb[i];
    newTags[dst] = tags[i];
    if (lightBuf) {
      lightBuf[dst] = (qSun[i] - ps) & lightMask; ps = qSun[i];
      lightBuf[newN + dst] = (qAo[i] - pa) & lightMask; pa = qAo[i];
    }
    dst++;
  }

  const va = [];
  let i = 0;
  while (i < newN) {
    const tag = newTags[i];
    let run = 1;
    while (i + run < newN && newTags[i + run] === tag) run++;
    va.push(tag);
    writeVarint(va, run);
    i += run;
  }

  const vi = [];
  let pi = 0;
  for (let t = 0; t < triCount; t++) {
    if (!keptTriFlags[t]) continue;
    for (let k = 0; k < 3; k++) {
      const ni = remap[indices[t * 3 + k]];
      writeVarint(vi, ni - pi);
      pi = ni;
    }
  }

  const parts = [
    Buffer.from(vx),
    Buffer.from(vy),
    Buffer.from(vz),
    Buffer.from(vr),
    Buffer.from(vg),
    Buffer.from(vb),
    Buffer.from(va),
    Buffer.from(vi),
  ];
  if (lightBuf) parts.push(Buffer.from(lightBuf));

  return {
    header: {
      ...sector.header,
      verts: newN,
      indices: keptTris * 3,
    },
    payload: Buffer.concat(parts),
    verts: newN,
    tris: keptTris,
  };
}

function isFoliageColor(r, g, b) {
  // Green/olive/yellow-green vines & leaves OR dark-red/crimson bougainvillea flowers
  const isGreenLeaf = g >= r * 0.88 && g > b + 6 && g < 150 && r < 145;
  const isDarkOlive = g >= 12 && r >= 12 && b <= Math.min(r, g) * 0.58 && r < 115 && g < 115;
  const isRedFlower = r > 18 && g < r * 0.42 && b < r * 0.38 && r < 155;
  return isGreenLeaf || isDarkOlive || isRedFlower;
}

function cleanMap(mapId) {
  const mapDir = path.join(MAPS_ROOT, mapId);
  const mgpPath = path.join(mapDir, 'render/map.mgp');
  const physPath = path.join(mapDir, 'compiled/physics.f32');
  if (!fs.existsSync(mgpPath) || !fs.existsSync(physPath)) {
    console.warn(`[skip] ${mapId}: missing map.mgp or physics.f32`);
    return;
  }
  const t0 = Date.now();
  const { meta, sectors } = decodeMgp1Full(fs.readFileSync(mgpPath));
  const physBuf = fs.readFileSync(physPath);
  const physF32 = new Float32Array(physBuf.buffer, physBuf.byteOffset, physBuf.byteLength / 4);
  const colShift = 8 - (meta.colorBits || 6);

  // Build global 3mm position-welded vertex graph in world coordinates (wx=lz, wy=ly, wz=-lx)
  const allPos = [];
  const allTris = [];
  const allTags = [];
  const allSpecial = [];
  const allN = [];
  const allArea = [];
  const allRgb = [];
  const triRef = []; // [sectorIndex, localTriIndex]
  const pWeld = new Map();

  for (let si = 0; si < sectors.length; si++) {
    const sec = sectors[si];
    const pos = sec.positions;
    const idx = sec.indices;
    const tags = sec.tags;
    const { qr, qg, qb } = sec;
    const n = pos.length / 3;
    const mapIdx = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const wx = pos[i * 3 + 2];
      const wy = pos[i * 3 + 1];
      const wz = -pos[i * 3];
      const key = `${Math.round(wx * 333)},${Math.round(wy * 333)},${Math.round(wz * 333)}`;
      let id = pWeld.get(key);
      if (id === undefined) {
        id = allPos.length / 3;
        allPos.push(wx, wy, wz);
        pWeld.set(key, id);
      }
      mapIdx[i] = id;
    }
    const tc = idx.length / 3;
    for (let t = 0; t < tc; t++) {
      const a = idx[t * 3];
      const b = idx[t * 3 + 1];
      const c = idx[t * 3 + 2];
      const va = mapIdx[a], vb = mapIdx[b], vc = mapIdx[c];
      const ax = allPos[va * 3], ay = allPos[va * 3 + 1], az = allPos[va * 3 + 2];
      const bx = allPos[vb * 3], by = allPos[vb * 3 + 1], bz = allPos[vb * 3 + 2];
      const cx = allPos[vc * 3], cy = allPos[vc * 3 + 1], cz = allPos[vc * 3 + 2];
      const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
      const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      const len = Math.hypot(nx, ny, nz) || 1;
      allTris.push(va, vb, vc);
      allTags.push(tags[a]);
      allSpecial.push(sec.isSpecial ? 1 : 0);
      allN.push(nx / len, ny / len, nz / len);
      allArea.push(len * 0.5);
      allRgb.push(
        (((qr[a] + qr[b] + qr[c]) / 3) * (1 << colShift)) | 0,
        (((qg[a] + qg[b] + qg[c]) / 3) * (1 << colShift)) | 0,
        (((qb[a] + qb[b] + qb[c]) / 3) * (1 << colShift)) | 0,
      );
      triRef.push(si, t);
    }
  }

  const nv = allPos.length / 3;
  const totalTris = allTris.length / 3;
  const parent = new Int32Array(nv).fill(-1);
  const find = (x) => {
    while (parent[x] >= 0) {
      if (parent[parent[x]] >= 0) parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const unite = (a, b) => {
    a = find(a);
    b = find(b);
    if (a === b) return;
    if (parent[a] > parent[b]) { const tmp = a; a = b; b = tmp; }
    parent[a] += parent[b];
    parent[b] = a;
  };
  for (let t = 0; t < allTris.length; t += 3) {
    unite(allTris[t], allTris[t + 1]);
    unite(allTris[t + 1], allTris[t + 2]);
  }

  const comps = new Map();
  for (let ti = 0; ti < totalTris; ti++) {
    const r = find(allTris[ti * 3]);
    let c = comps.get(r);
    if (!c) {
      c = {
        tris: 0,
        tag255: 0,
        special: 0,
        area: 0,
        rSum: 0, gSum: 0, bSum: 0,
        minX: Infinity, maxX: -Infinity,
        minY: Infinity, maxY: -Infinity,
        minZ: Infinity, maxZ: -Infinity,
        vSet: new Set(),
        triIndices: [],
      };
      comps.set(r, c);
    }
    c.tris++;
    if (allTags[ti] === 255) c.tag255++;
    if (allSpecial[ti]) c.special++;
    c.area += allArea[ti];
    c.rSum += allRgb[ti * 3];
    c.gSum += allRgb[ti * 3 + 1];
    c.bSum += allRgb[ti * 3 + 2];
    c.triIndices.push(ti);
    for (let k = 0; k < 3; k++) {
      const vi = allTris[ti * 3 + k];
      c.vSet.add(vi);
      const x = allPos[vi * 3], y = allPos[vi * 3 + 1], z = allPos[vi * 3 + 2];
      if (x < c.minX) c.minX = x; if (x > c.maxX) c.maxX = x;
      if (y < c.minY) c.minY = y; if (y > c.maxY) c.maxY = y;
      if (z < c.minZ) c.minZ = z; if (z > c.maxZ) c.maxZ = z;
    }
  }

  // Open-edge ratio identifies non-closed 2D alpha-cutout sheets vs solid 3D props
  const openEdgeRatio = (c) => {
    if (c.tris <= 2) return 1.0;
    const edgeCounts = new Map();
    for (const ti of c.triIndices) {
      const a = allTris[ti * 3], b = allTris[ti * 3 + 1], d = allTris[ti * 3 + 2];
      for (const [u, v] of [[a, b], [b, d], [d, a]]) {
        const key = u < v ? u * 10000000 + v : v * 10000000 + u;
        edgeCounts.set(key, (edgeCounts.get(key) || 0) + 1);
      }
    }
    let open = 0, total = 0;
    for (const cnt of edgeCounts.values()) {
      total++;
      if (cnt === 1) open++;
    }
    return total > 0 ? open / total : 1.0;
  };

  // Partition candidate 2D open sheets vs solid structural support geometry
  const candidates = [];
  const structPos = [];
  for (let i = 0; i < physF32.length; i++) structPos.push(physF32[i]);

  for (const c of comps.values()) {
    const diag = Math.hypot(c.maxX - c.minX, c.maxY - c.minY, c.maxZ - c.minZ);
    const n = c.tris;
    const avgR = c.rSum / n, avgG = c.gSum / n, avgB = c.bSum / n;
    const foliageCol = isFoliageColor(avgR, avgG, avgB);
    const minOr = foliageCol && n <= 40 && c.area / n < 0.30 ? 0.55 : 0.65;
    const or =
      c.special === 0 &&
      n <= 80 &&
      c.tag255 === n &&
      diag <= 7.0
        ? openEdgeRatio(c)
        : 0;
    if (or >= minOr) {
      c.or = or;
      c.diag = diag;
      candidates.push(c);
    } else {
      for (const ti of c.triIndices) {
        for (let k = 0; k < 3; k++) {
          const vi = allTris[ti * 3 + k] * 3;
          structPos.push(allPos[vi], allPos[vi + 1], allPos[vi + 2]);
        }
      }
    }
  }

  const sGeom = new THREE.BufferGeometry();
  sGeom.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(structPos), 3));
  const sBvh = new MeshBVH(sGeom, { targetLeafSize: 16 });
  const pt = new THREE.Vector3();
  const target = { point: new THREE.Vector3(), distance: 0 };

  const keptFlagsPerSector = sectors.map((s) => new Uint8Array(s.indices.length / 3).fill(1));
  let removedComps = 0;
  let removedTris = 0;
  const counts = { float: 0, vine: 0, folded: 0, protrude: 0, single: 0 };

  for (const c of candidates) {
    const n = c.tris;
    const t0Idx = c.triIndices[0];
    const nx0 = allN[t0Idx * 3], ny0 = allN[t0Idx * 3 + 1], nz0 = allN[t0Idx * 3 + 2];
    let minDot = 1;
    for (let i = 1; i < n; i++) {
      const ti = c.triIndices[i];
      const d = Math.abs(nx0 * allN[ti * 3] + ny0 * allN[ti * 3 + 1] + nz0 * allN[ti * 3 + 2]);
      if (d < minDot) minDot = d;
    }
    const axisAligned = Math.max(Math.abs(nx0), Math.abs(ny0), Math.abs(nz0)) > 0.965;
    const avgR = c.rSum / n;
    const avgG = c.gSum / n;
    const avgB = c.bSum / n;
    const foliageCol = isFoliageColor(avgR, avgG, avgB);

    let minD = 999;
    let maxD = 0;
    let checked = 0;
    for (const vi of c.vSet) {
      pt.set(allPos[vi * 3], allPos[vi * 3 + 1], allPos[vi * 3 + 2]);
      const h = sBvh.closestPointToPoint(pt, target, 0, 5);
      const d = h ? h.distance : 5;
      if (d < minD) minD = d;
      if (d > maxD) maxD = d;
      if (++checked >= 28) break;
    }

    // 1. Protect flush planar signs, posters, windows, shutters, doors, panels (all verts <= 6.5cm of wall/floor)
    const isFlushPlanarRect =
      minDot > 0.985 &&
      maxD <= 0.065 &&
      c.area >= 0.05 &&
      (axisAligned || c.area >= 0.30) &&
      !(foliageCol && n <= 2 && c.area < 0.14);
    if (isFlushPlanarRect) continue;

    // 2. Protect lush palm canopies & bushes on desert maps (Mirage/Dust2 have clean palm fronds, NOT ugly alpha vine clutter)
    const isPalmCanopy =
      (mapId === 'de_mirage' && avgG >= avgR * 0.92 && avgG > avgB + 4) ||
      (mapId === 'de_dust2' && n >= 6 && c.area >= 0.8 && c.diag >= 1.5 && avgG >= avgR && avgG > avgB + 4);
    if (isPalmCanopy) continue;

    const avgArea = c.area / n;
    let reason = null;

    // Rule A: Mid-air floating 2D open-sheet shards (capped at area <= 1.6m², or <= 4.0m² for 1-6 tri foliage scraps)
    if (minD > 0.12 && (c.area <= 1.6 || (n <= 6 && foliageCol && c.area <= 4.0))) {
      reason = 'float';
    }
    // Rule B: Wall/pillar-clinging vine & ivy cutout sheets (Ancient walls, Anubis columns, Inferno vines)
    else if (
      foliageCol &&
      n >= 2 &&
      c.or >= 0.55 &&
      (minDot < 0.96 || (n <= 12 && c.area < 0.45)) &&
      avgArea < 0.42 &&
      c.area <= 11.5 &&
      maxD > 0.020 &&
      maxD < 1.35
    ) {
      reason = 'vine';
    }
    // Rule C: Small non-planar crumpled 2D cutout sheets (weed tufts, debris splinters; capped at area <= 0.85m² so stone roofs/arches stay 100% intact!)
    else if (n >= 3 && minDot < 0.94 && c.area <= 0.85 && avgArea < 0.25 && maxD > 0.065) {
      reason = 'folded';
    }
    // Rule D: Protruding 1-2 triangle cutout cards sticking obliquely off walls/planters/ledges (Inferno T-Spawn red burst, B-Site wall flowers, CT planters!)
    else if (
      n <= 2 &&
      maxD > 0.072 &&
      c.area < 0.45 &&
      !(axisAligned && c.area > 0.24 && !foliageCol)
    ) {
      reason = 'protrude';
    }
    // Rule E: Detached single-triangle orphan slivers (non-rectangular 1-tri scraps, or small foliage petals even close to wall)
    else if (
      n === 1 &&
      c.area < 0.15 &&
      (!axisAligned || maxD > 0.032 || foliageCol)
    ) {
      reason = 'single';
    }

    if (reason) {
      counts[reason]++;
      removedComps++;
      removedTris += n;
      for (const ti of c.triIndices) {
        const si = triRef[ti * 2];
        const lti = triRef[ti * 2 + 1];
        keptFlagsPerSector[si][lti] = 0;
      }
    }
  }

  sGeom.dispose();

  if (removedTris === 0) {
    console.log(`[clean] ${mapId}: 0 shards found (already spotless!)`);
    return;
  }

  const nextHeaders = [];
  const payloadChunks = [];
  let outVerts = 0;
  let outTris = 0;
  for (let si = 0; si < sectors.length; si++) {
    const enc = encodeFilteredSector(sectors[si], keptFlagsPerSector[si], meta);
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
  const stats = writeWithCompressed(mgpPath, mgpBuf);

  // Sync compact-manifest.json and catalog.json
  const manifestPath = path.join(mapDir, 'compact-manifest.json');
  if (fs.existsSync(manifestPath)) {
    const cm = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const oldBr = cm.mesh.brBytes || 0;
    const oldGz = cm.mesh.gzBytes || 0;
    cm.mesh.bytes = stats.raw;
    cm.mesh.gzBytes = stats.gz;
    cm.mesh.brBytes = stats.br;
    cm.mesh.sha256 = stats.sha256;
    cm.mesh.triangles = outTris;
    cm.mesh.vertices = outVerts;
    cm.mesh.chunks = nextHeaders.length;
    cm.mesh.floatingShardsCleaned = true;
    cm.totalBrBytes = (cm.totalBrBytes || 0) - oldBr + stats.br;
    cm.totalGzBytes = (cm.totalGzBytes || 0) - oldGz + stats.gz;
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
    `[clean] ${mapId} [${elapsed}s]: removed ${removedComps} shards (${removedTris} tris, -${((removedTris / totalTris) * 100).toFixed(1)}%) [flt=${counts.float} vine=${counts.vine} fld=${counts.folded} prt=${counts.protrude} sng=${counts.single}], out=${outTris} tris, br=${(stats.br / 1e6).toFixed(2)} MB`,
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
  cleanMap(mapId);
}
