/**
 * Offline raytraced lightmap baker for MGP1 performance maps.
 *
 * Uses three-mesh-bvh over each map's full 3D render geometry to bake two true
 * physical lightmap channels into every vertex (stored as delta-encoded 6-bit
 * pairs inside map.mgp, only 2 B/vertex in GPU VRAM and ZERO runtime shadow cost):
 *   - sunVis (0..1): 5-ray soft-penumbra directional sunlight visibility aligned
 *                    to each map's exact MAP_ATMOSPHERE sun direction
 *   - ao     (0..1): 16-ray cosine-weighted hemisphere ambient occlusion +
 *                    short-range wall/floor contact darkening + sky openness
 *
 * Usage:
 *   node scripts/maps/bake-map-lighting.mjs de_ancient
 *   node scripts/maps/bake-map-lighting.mjs --all
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { computeCreasedNormals } from '../../client/compact-map-codec.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MAPS_ROOT = path.join(ROOT, 'artifacts/performance-maps/maps-v1');

// Exact world-space sun directions matching MAP_ATMOSPHERE in client/flat-surface-detail.js
const MAP_SUN_DIRS = {
  de_dust2:   [-0.46, 0.80, 0.38],
  de_mirage:  [-0.56, 0.70, 0.44],
  de_anubis:  [0.56, 0.70, -0.44],
  de_inferno: [0.60, 0.66, 0.45],
  de_nuke:    [-0.38, 0.84, 0.38],
  de_vertigo: [0.52, 0.74, 0.42],
  de_train:   [-0.34, 0.85, 0.40],
  de_cache:   [-0.50, 0.76, 0.41],
  de_ancient: [0.42, 0.78, -0.46],
};

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

/**
 * Parse an existing MGP1 buffer preserving exact sector metadata and raw vertex/index payloads
 * (stripping any previous lightmap bytes so re-baking is 100% idempotent).
 */
function parseMgp1(bytes) {
  if (bytes.length < 16 || bytes[0] !== 0x4d || bytes[1] !== 0x47 || bytes[2] !== 0x50 || bytes[3] !== 0x31) {
    throw Error('Not a valid MGP1 file');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLen = view.getUint32(4, true);
  const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headerLen)));
  const state = { pos: 8 + headerLen };

  const posBits = meta.posBits || 14;
  const qMax = (1 << posBits) - 1;
  const oldLightBits = meta.lightBits || 0;

  const sectors = [];
  for (const sector of meta.sectors) {
    const startPos = state.pos;
    const n = sector.verts;
    const ic = sector.indices;
    const t = sector.translation;
    const s = sector.scale;

    const positions = new Float32Array(n * 3);
    const IndexCtor = n <= 65535 ? Uint16Array : Uint32Array;
    const indices = new IndexCtor(ic);

    let px = 0, py = 0, pz = 0;
    for (let i = 0; i < n; i++) { px += readVarint(bytes, state); positions[i * 3] = (px / qMax) * s[0] + t[0]; }
    for (let i = 0; i < n; i++) { py += readVarint(bytes, state); positions[i * 3 + 1] = (py / qMax) * s[1] + t[1]; }
    for (let i = 0; i < n; i++) { pz += readVarint(bytes, state); positions[i * 3 + 2] = (pz / qMax) * s[2] + t[2]; }

    // Skip R, G, B bytes
    state.pos += n * 3;

    // Skip RLE tags
    let ai = 0;
    while (ai < n) {
      state.pos++;
      const run = readVarint(bytes, state);
      ai += run;
    }

    let pi = 0;
    for (let i = 0; i < ic; i++) {
      pi += readVarint(bytes, state);
      indices[i] = pi;
    }

    const basePayloadEnd = state.pos;
    if (oldLightBits > 0) {
      state.pos += n * 2;
    }

    sectors.push({
      header: sector,
      basePayload: bytes.subarray(startPos, basePayloadEnd),
      positions,
      indices,
      verts: n,
      isFence: !!sector.fence,
      frontSide: !!sector.frontSide,
    });
  }

  return { meta, sectors };
}

/** Build a single BVH over all opaque non-fence world triangles in local MGP1 coordinates. */
function buildWorldBVH(sectors) {
  let totalVerts = 0;
  let totalIndices = 0;
  for (const s of sectors) {
    if (s.isFence || Number.isInteger(s.header.origNodeIndex)) continue;
    totalVerts += s.verts;
    totalIndices += s.indices.length;
  }
  const mergedPos = new Float32Array(totalVerts * 3);
  const mergedIdx = new Uint32Array(totalIndices);
  let vOff = 0;
  let iOff = 0;
  for (const s of sectors) {
    if (s.isFence || Number.isInteger(s.header.origNodeIndex)) continue;
    mergedPos.set(s.positions, vOff * 3);
    const idx = s.indices;
    for (let i = 0; i < idx.length; i++) mergedIdx[iOff + i] = idx[i] + vOff;
    vOff += s.verts;
    iOff += idx.length;
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(mergedPos, 3));
  geom.setIndex(new THREE.BufferAttribute(mergedIdx, 1));
  const bvh = new MeshBVH(geom, { targetLeafSize: 12 });
  return { bvh, geom };
}

// Precomputed 16 cosine-weighted Fibonacci hemisphere directions in tangent space (z = normal)
const AO_SAMPLES = [];
{
  const N = 16;
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < N; i++) {
    const u = (i + 0.5) / N;
    // Cosine-weighted elevation bias avoids grazing self-intersection while probing corners tightly
    const z = Math.sqrt(0.14 + 0.86 * u);
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const phi = i * golden;
    AO_SAMPLES.push([Math.cos(phi) * r, Math.sin(phi) * r, z]);
  }
}

// 5-ray soft-penumbra solar disc offsets (center + 4 compass points at ~3.8 deg spread)
const SUN_CONE = [
  [0, 0],
  [0.066, 0],
  [-0.066, 0],
  [0, 0.066],
  [0, -0.066],
];

function buildOrthonormalBasis(nx, ny, nz, outT, outB) {
  if (Math.abs(ny) < 0.9) {
    // T = normalize(cross((0,1,0), N)) = (nz, 0, -nx)
    const inv = 1 / Math.hypot(nz, nx);
    outT[0] = nz * inv;
    outT[1] = 0;
    outT[2] = -nx * inv;
  } else {
    // T = normalize(cross((1,0,0), N)) = (0, -nz, ny)
    const inv = 1 / Math.hypot(nz, ny);
    outT[0] = 0;
    outT[1] = -nz * inv;
    outT[2] = ny * inv;
  }
  outB[0] = ny * outT[2] - nz * outT[1];
  outB[1] = nz * outT[0] - nx * outT[2];
  outB[2] = nx * outT[1] - ny * outT[0];
}

function bakeMapLighting(mapId) {
  const mapDir = path.join(MAPS_ROOT, mapId);
  const mgpPath = path.join(mapDir, 'render/map.mgp');
  if (!fs.existsSync(mgpPath)) {
    console.warn(`[skip] ${mapId}: render/map.mgp not found`);
    return;
  }
  const t0 = Date.now();
  const raw = fs.readFileSync(mgpPath);
  const { meta, sectors } = parseMgp1(raw);
  const { bvh, geom } = buildWorldBVH(sectors);

  // Convert world-space sun direction (after group.rotation.y = +PI/2) into local MGP1 coordinates:
  // world = (lz, ly, -lx) => local = (-wz, wy, wx)
  const wSun = MAP_SUN_DIRS[mapId] || [-0.46, 0.80, 0.38];
  const wLen = Math.hypot(wSun[0], wSun[1], wSun[2]);
  const lSun = [-wSun[2] / wLen, wSun[1] / wLen, wSun[0] / wLen];
  const sunT = [0, 0, 0];
  const sunB = [0, 0, 0];
  buildOrthonormalBasis(lSun[0], lSun[1], lSun[2], sunT, sunB);

  const sunRays = SUN_CONE.map(([du, dv]) => {
    const dx = lSun[0] + sunT[0] * du + sunB[0] * dv;
    const dy = lSun[1] + sunT[1] * du + sunB[1] * dv;
    const dz = lSun[2] + sunT[2] * du + sunB[2] * dv;
    const inv = 1 / Math.hypot(dx, dy, dz);
    return [dx * inv, dy * inv, dz * inv];
  });

  const ray = new THREE.Ray();
  const tanT = [0, 0, 0];
  const tanB = [0, 0, 0];
  const cache = new Map();
  let uniqueTraced = 0;
  let totalVerts = 0;
  let sunLitCount = 0;
  let aoSum = 0;

  const lightBits = 6;
  const lightMax = (1 << lightBits) - 1;
  const payloadChunks = [];

  for (const sector of sectors) {
    const n = sector.verts;
    totalVerts += n;
    const pos = sector.positions;
    const idx = sector.indices;
    const normals = computeCreasedNormals(pos, idx, 18);

    const sunArr = new Float32Array(n);
    const aoArr = new Float32Array(n);

    for (let i = 0; i < n; i++) {
      const o = i * 3;
      const vx = pos[o];
      const vy = pos[o + 1];
      const vz = pos[o + 2];
      const nx = normals[o];
      const ny = normals[o + 1];
      const nz = normals[o + 2];

      // Spatial + normal dedup key (~2.5cm position, ~18deg normal)
      const qx = Math.round(vx * 40);
      const qy = Math.round(vy * 40);
      const qz = Math.round(vz * 40);
      const qnx = Math.round(nx * 5);
      const qny = Math.round(ny * 5);
      const qnz = Math.round(nz * 5);
      const key = `${qx},${qy},${qz},${qnx},${qny},${qnz}`;

      let cached = cache.get(key);
      if (cached === undefined) {
        uniqueTraced++;
        // Push ray origin slightly off surface along normal to avoid self-hit
        const ox = vx + nx * 0.085;
        const oy = vy + ny * 0.085;
        const oz = vz + nz * 0.085;

        // 1) Soft-penumbra 5-ray directional sun shadow test
        const ndl = nx * lSun[0] + ny * lSun[1] + nz * lSun[2];
        let sunVis = 0;
        if (ndl > -0.05) {
          let open = 0;
          for (let r = 0; r < sunRays.length; r++) {
            const sr = sunRays[r];
            ray.origin.set(ox + sr[0] * 0.04, oy + sr[1] * 0.04, oz + sr[2] * 0.04);
            ray.direction.set(sr[0], sr[1], sr[2]);
            const hit = bvh.raycastFirst(ray, THREE.DoubleSide, 0.02, 130);
            if (!hit) open++;
          }
          sunVis = open / sunRays.length;
        }

        // 2) 16-ray cosine-weighted hemisphere AO + architectural sky openness
        buildOrthonormalBasis(nx, ny, nz, tanT, tanB);
        // Deterministic per-position azimuthal jitter prevents banding
        const jitterAngle = (((qx * 73856093) ^ (qy * 19349663) ^ (qz * 83492791)) & 1023) * (Math.PI * 2 / 1024);
        const cj = Math.cos(jitterAngle);
        const sj = Math.sin(jitterAngle);

        let localOpenSum = 0;
        let skyOpenSum = 0;
        let skyWeightSum = 0;

        for (let k = 0; k < AO_SAMPLES.length; k++) {
          const s = AO_SAMPLES[k];
          const ru = s[0] * cj - s[1] * sj;
          const rv = s[0] * sj + s[1] * cj;
          const rw = s[2];
          const dx = tanT[0] * ru + tanB[0] * rv + nx * rw;
          const dy = tanT[1] * ru + tanB[1] * rv + ny * rw;
          const dz = tanT[2] * ru + tanB[2] * rv + nz * rw;
          const inv = 1 / Math.hypot(dx, dy, dz);
          const ndx = dx * inv;
          const ndy = dy * inv;
          const ndz = dz * inv;

          ray.origin.set(ox, oy, oz);
          ray.direction.set(ndx, ndy, ndz);
          // Cast up to 38m so indoor rooms & covered tunnels accurately detect roof enclosure
          const hit = bvh.raycastFirst(ray, THREE.DoubleSide, 0.02, 38);
          if (!hit) {
            localOpenSum += 1.0;
          } else {
            const d = hit.distance;
            if (d >= 5.5) {
              localOpenSum += 1.0;
            } else {
              // Strong contact AO within 0..1.6m, smooth room corner falloff to 5.5m
              const t = Math.max(0, Math.min(1, (d - 0.06) / 5.44));
              localOpenSum += Math.pow(t, 0.72);
            }
          }
          if (ndy > 0.12) {
            skyWeightSum += ndy;
            if (!hit || hit.distance > 26) skyOpenSum += ndy;
          }
        }

        const localAO = localOpenSum / AO_SAMPLES.length;
        const skyVis = skyWeightSum > 0.05 ? skyOpenSum / skyWeightSum : localAO;
        // Blend tight corner AO (68%) + architectural sky openness (32%) for true outdoor/indoor lightmap feel
        const ao = Math.max(0, Math.min(1, localAO * 0.68 + skyVis * 0.32));

        // Pack into single integer for compact cache storage
        cached = (Math.round(sunVis * 1000) << 11) | Math.round(ao * 1000);
        cache.set(key, cached);
      }

      const sunVis = (cached >> 11) / 1000;
      const ao = (cached & 2047) / 1000;
      sunArr[i] = sunVis;
      aoArr[i] = ao;
      if (sunVis > 0.5) sunLitCount++;
      aoSum += ao;
    }

    // Normal-preserving 1-pass Laplacian smooth over mesh edges for silky soft shadow & AO gradients
    const sAccum = new Float32Array(n);
    const aAccum = new Float32Array(n);
    const wAccum = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      sAccum[i] = sunArr[i] * 2.2;
      aAccum[i] = aoArr[i] * 2.2;
      wAccum[i] = 2.2;
    }
    const triCount = idx.length / 3;
    for (let t = 0; t < triCount; t++) {
      const a = idx[t * 3];
      const b = idx[t * 3 + 1];
      const c = idx[t * 3 + 2];
      const pairs = [[a, b], [b, c], [c, a]];
      for (let p = 0; p < 3; p++) {
        const u = pairs[p][0];
        const v = pairs[p][1];
        const dot =
          normals[u * 3] * normals[v * 3] +
          normals[u * 3 + 1] * normals[v * 3 + 1] +
          normals[u * 3 + 2] * normals[v * 3 + 2];
        if (dot > 0.85) {
          sAccum[u] += sunArr[v];
          aAccum[u] += aoArr[v];
          wAccum[u] += 1;
          sAccum[v] += sunArr[u];
          aAccum[v] += aoArr[u];
          wAccum[v] += 1;
        }
      }
    }

    // Delta-encode 6-bit sunVis plane + 6-bit ao plane
    const lightBuf = new Uint8Array(n * 2);
    let prevSun = 0;
    let prevAo = 0;
    for (let i = 0; i < n; i++) {
      const qSun = Math.max(0, Math.min(lightMax, Math.round((sAccum[i] / wAccum[i]) * lightMax)));
      lightBuf[i] = (qSun - prevSun) & lightMax;
      prevSun = qSun;
    }
    for (let i = 0; i < n; i++) {
      const qAo = Math.max(0, Math.min(lightMax, Math.round((aAccum[i] / wAccum[i]) * lightMax)));
      lightBuf[n + i] = (qAo - prevAo) & lightMax;
      prevAo = qAo;
    }

    payloadChunks.push(Buffer.from(sector.basePayload), Buffer.from(lightBuf));
  }

  geom.dispose();

  const nextMeta = { ...meta, lightBits };
  const headerJson = Buffer.from(JSON.stringify(nextMeta));
  const prefix = Buffer.alloc(8);
  prefix.write('MGP1', 0);
  prefix.writeUInt32LE(headerJson.length, 4);
  const mgpBuf = Buffer.concat([prefix, headerJson, ...payloadChunks]);
  const stats = writeWithCompressed(mgpPath, mgpBuf);

  // Update compact-manifest.json and catalog.json sizes & sha256
  const manifestPath = path.join(mapDir, 'compact-manifest.json');
  if (fs.existsSync(manifestPath)) {
    const cm = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const oldBr = cm.mesh.brBytes || 0;
    const oldGz = cm.mesh.gzBytes || 0;
    cm.schemaVersion = 3;
    cm.mesh.bytes = stats.raw;
    cm.mesh.gzBytes = stats.gz;
    cm.mesh.brBytes = stats.br;
    cm.mesh.sha256 = stats.sha256;
    cm.mesh.lightBaked = true;
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
    `[baked] ${mapId} [${elapsed}s]: verts=${totalVerts} (unique=${uniqueTraced}), sunlit=${((sunLitCount / totalVerts) * 100).toFixed(1)}%, avgAO=${(aoSum / totalVerts).toFixed(3)}, br=${(stats.br / 1e6).toFixed(2)} MB`,
  );
}

const arg = process.argv[2] || 'de_ancient';
const targets =
  arg === '--all'
    ? fs
        .readdirSync(MAPS_ROOT)
        .filter((d) => fs.existsSync(path.join(MAPS_ROOT, d, 'render/map.mgp')))
        .sort()
    : process.argv.slice(2);

for (const mapId of targets) {
  bakeMapLighting(mapId);
}
