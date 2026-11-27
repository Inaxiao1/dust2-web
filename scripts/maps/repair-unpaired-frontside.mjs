/**
 * Losslessly demotes any unpaired FrontSide triangles in MGP1 v3 maps into their
 * matching DoubleSide spatial chunk while preserving 100% of vertex colors,
 * surfaceClass tags, and offline raytraced aBakedLight (sunVis, ao) lightmaps.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

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
  const posBits = meta.posBits || 14;
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

  // Deduplicate exact vertices (same quantized 0.25mm pos + color + tag + light)
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

function extractTris(sec) {
  const { positions: p, qr, qg, qb, tags, indices: idx, qSun, qAo } = sec;
  const out = [];
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i], b = idx[i + 1], c = idx[i + 2];
    const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
    const bx = p[b * 3], by = p[b * 3 + 1], bz = p[b * 3 + 2];
    const cx = p[c * 3], cy = p[c * 3 + 1], cz = p[c * 3 + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    out.push({
      ax, ay, az, bx, by, bz, cx, cy, cz,
      ar: qr[a], ag: qg[a], ab: qb[a], atag: tags[a], asun: qSun ? qSun[a] : 0, aao: qAo ? qAo[a] : 0,
      br: qr[b], bg: qg[b], bb: qb[b], btag: tags[b], bsun: qSun ? qSun[b] : 0, bao: qAo ? qAo[b] : 0,
      cr: qr[c], cg: qg[c], cb: qb[c], ctag: tags[c], csun: qSun ? qSun[c] : 0, cao: qAo ? qAo[c] : 0,
      nx: len > 1e-8 ? nx / len : 0,
      ny: len > 1e-8 ? ny / len : 0,
      nz: len > 1e-8 ? nz / len : 0,
    });
  }
  return out;
}

function repairMap(mapId) {
  const mapDir = path.join(MAPS_ROOT, mapId);
  const mgpPath = path.join(mapDir, 'render/map.mgp');
  const { meta, sectors } = decodeMgp1(fs.readFileSync(mgpPath));

  // Pair FrontSide triangles within each sector (identical bounding box -> identical 16-bit quantization!)
  const dsExtraByName = new Map();
  const keptFsBySector = new Map();
  let movedCount = 0;
  let keptFsCount = 0;
  for (let si = 0; si < sectors.length; si++) {
    const sec = sectors[si];
    if (!sec.header.frontSide) continue;
    const tris = extractTris(sec);
    const keyBuckets = new Map();
    for (const t of tris) {
      const vs = [
        `${Math.round(t.ax * 1000)},${Math.round(t.ay * 1000)},${Math.round(t.az * 1000)}`,
        `${Math.round(t.bx * 1000)},${Math.round(t.by * 1000)},${Math.round(t.bz * 1000)}`,
        `${Math.round(t.cx * 1000)},${Math.round(t.cy * 1000)},${Math.round(t.cz * 1000)}`,
      ].sort();
      t._key = vs.join('|');
      let list = keyBuckets.get(t._key);
      if (!list) { list = []; keyBuckets.set(t._key, list); }
      list.push(t);
    }
    const targetDsName = sec.header.name.replace(/_fs$/, '');
    const kept = [];
    for (const t of tris) {
      const list = keyBuckets.get(t._key) || [];
      const hasExactTwin = list.some(
        (b) => b !== t && (t.nx * b.nx + t.ny * b.ny + t.nz * b.nz) <= -0.95,
      );
      if (hasExactTwin) {
        kept.push(t);
        keptFsCount++;
      } else {
        let extra = dsExtraByName.get(targetDsName);
        if (!extra) { extra = []; dsExtraByName.set(targetDsName, extra); }
        extra.push(t);
        movedCount++;
      }
    }
    keptFsBySector.set(si, kept);
  }

  const nextHeaders = [];
  const payloadChunks = [];
  let outVerts = 0, outTris = 0;

  for (let si = 0; si < sectors.length; si++) {
    const sec = sectors[si];
    let tris;
    if (sec.header.frontSide) {
      tris = keptFsBySector.get(si) || [];
    } else {
      tris = extractTris(sec);
      const extra = dsExtraByName.get(sec.header.name);
      if (extra && extra.length) {
        for (const t of extra) tris.push(t);
        dsExtraByName.delete(sec.header.name);
      }
    }
    const enc = encodeSectorFromTris(sec.header, tris, meta);
    if (!enc) continue;
    nextHeaders.push(enc.header);
    payloadChunks.push(enc.payload);
    outVerts += enc.verts;
    outTris += enc.tris;
  }

  // In case a _fs sector had no matching DoubleSide sector of the same name
  for (const [name, extra] of dsExtraByName) {
    if (!extra.length) continue;
    const enc = encodeSectorFromTris({ name, fence: 0 }, extra, meta);
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

  console.log(`[repair-fs] ${mapId.padEnd(12)}: moved ${movedCount} unpaired FrontSide -> DoubleSide, kept ${keptFsCount} exact paired FrontSide, chunks=${nextHeaders.length}, br=${(stats.br / 1e6).toFixed(2)} MB`);
}

const maps = fs.readdirSync(MAPS_ROOT).filter((d) => fs.existsSync(path.join(MAPS_ROOT, d, 'render/map.mgp'))).sort();
for (const m of maps) repairMap(m);
