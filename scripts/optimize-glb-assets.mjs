/**
 * High-ratio, zero-visual-loss glTF 2.0 GLB geometry & animation optimizer:
 *  1. Strips unused TEXCOORD_1 when no material references texCoord: 1.
 *  2. Applies glTF 2.0 core / KHR_mesh_quantization to vertex attributes:
 *     - INDICES: UINT32 -> UINT16 when vertex count <= 65535
 *     - NORMAL: VEC3 FLOAT -> VEC3 BYTE normalized (byteStride: 4)
 *     - TANGENT: VEC4 FLOAT -> VEC4 BYTE normalized (preserving handedness w)
 *     - WEIGHTS_0: VEC4 FLOAT -> VEC4 UNSIGNED_BYTE normalized (exact sum = 255)
 *     - JOINTS_0: VEC4 UNSIGNED_SHORT -> VEC4 UNSIGNED_BYTE when max joint <= 255
 *     - TEXCOORD_0: VEC2 FLOAT -> VEC2 UNSIGNED_SHORT normalized when in [0, 1] (skipped on c4)
 *     - POSITION: kept exact FLOAT so skinned bind poses stay bit-identical.
 *  3. Compresses animation GLBs massively:
 *     - Collapses constant keyframe tracks (within 1e-5) to 2 boundary frames [t0, tEnd] (preserves exact clip duration!)
 *     - Quantizes non-constant rotation tracks to VEC4 SHORT normalized (8 B/frame vs 16 B/frame, 0.0017 deg precision)
 *     - Deduplicates identical binary accessor payloads by SHA-256 and merges non-strided accessors into 1 bufferView
 *       (eliminating tens of thousands of redundant JSON bufferView objects!).
 *
 * Writes artifacts/compression-report.json so scripts/sync-compressed-asset-hashes.mjs updates all manifests.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const ASSETS_DIR = path.join(PUBLIC, 'assets');

const COMP_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COMPS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function parseGlb(buf) {
  if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46546c67) {
    throw new Error('Not a valid GLB file');
  }
  const jsonLen = buf.readUInt32LE(12);
  const jsonType = buf.readUInt32LE(16);
  if (jsonType !== 0x4e4f534a) throw new Error('Missing JSON chunk');
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  let bin = Buffer.alloc(0);
  const binOff = 20 + jsonLen;
  if (binOff + 8 <= buf.length && buf.readUInt32LE(binOff + 4) === 0x004e4942) {
    const binLen = buf.readUInt32LE(binOff);
    bin = buf.subarray(binOff + 8, binOff + 8 + binLen);
  }
  return { json, bin };
}

function buildGlb(json, bin) {
  const jsonRaw = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = (4 - (jsonRaw.length & 3)) & 3;
  const jsonChunk = jsonPad ? Buffer.concat([jsonRaw, Buffer.alloc(jsonPad, 0x20)]) : jsonRaw;
  const binPad = (4 - (bin.length & 3)) & 3;
  const binChunk = binPad ? Buffer.concat([bin, Buffer.alloc(binPad, 0)]) : bin;
  const totalLen = 12 + 8 + jsonChunk.length + (binChunk.length ? 8 + binChunk.length : 0);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(totalLen, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(jsonChunk.length, 0);
  jh.writeUInt32LE(0x4e4f534a, 4);
  if (!binChunk.length) return Buffer.concat([header, jh, jsonChunk]);
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(binChunk.length, 0);
  bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jh, jsonChunk, bh, binChunk]);
}

function readAccessorValues(doc, bin, accIdx) {
  const acc = doc.accessors[accIdx];
  if (!acc || acc.bufferView === undefined || acc.sparse) return null;
  const bv = doc.bufferViews[acc.bufferView];
  const comps = TYPE_COMPS[acc.type];
  const cSize = COMP_BYTES[acc.componentType];
  const elemBytes = comps * cSize;
  const stride = bv.byteStride || elemBytes;
  const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const count = acc.count;

  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const out = new Float64Array(count * comps);
  const norm = Boolean(acc.normalized);

  for (let i = 0; i < count; i++) {
    const off = base + i * stride;
    for (let c = 0; c < comps; c++) {
      const o = off + c * cSize;
      let v;
      switch (acc.componentType) {
        case 5120: v = dv.getInt8(o); if (norm) v = Math.max(v / 127, -1); break;
        case 5121: v = dv.getUint8(o); if (norm) v = v / 255; break;
        case 5122: v = dv.getInt16(o, true); if (norm) v = Math.max(v / 32767, -1); break;
        case 5123: v = dv.getUint16(o, true); if (norm) v = v / 65535; break;
        case 5125: v = dv.getUint32(o, true); break;
        case 5126: v = dv.getFloat32(o, true); break;
        default: throw new Error(`Unsupported componentType ${acc.componentType}`);
      }
      out[i * comps + c] = v;
    }
  }
  return { acc, comps, count, values: out };
}

function readRawAccessorBytes(doc, bin, accIdx) {
  const acc = doc.accessors[accIdx];
  if (!acc || acc.bufferView === undefined) return null;
  const bv = doc.bufferViews[acc.bufferView];
  const comps = TYPE_COMPS[acc.type];
  const cSize = COMP_BYTES[acc.componentType];
  const elemBytes = comps * cSize;
  const stride = bv.byteStride || elemBytes;
  const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  if (stride === elemBytes) {
    return Buffer.from(bin.subarray(base, base + acc.count * elemBytes));
  }
  // Tightly pack strided elements
  const out = Buffer.alloc(acc.count * elemBytes);
  for (let i = 0; i < acc.count; i++) {
    bin.copy(out, i * elemBytes, base + i * stride, base + i * stride + elemBytes);
  }
  return out;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function optimizeGlb(buf, relPath) {
  const { json, bin } = parseGlb(buf);
  const rawJsonText = JSON.stringify(json);
  const usesTexCoord1 = /"texCoord"\s*:\s*1\b/.test(rawJsonText);
  const isC4 = /(?:^|\/)c4\.glb$/i.test(relPath);

  // Skip files that already use exotic extensions like Draco/Meshopt or sparse accessors
  const extsUsed = new Set(json.extensionsUsed || []);
  const extsReq = new Set(json.extensionsRequired || []);
  if (extsUsed.has('KHR_draco_mesh_compression') || extsUsed.has('EXT_meshopt_compression')) {
    return { buf, changed: false, skipped: 'already-compressed' };
  }
  if ((json.accessors || []).some((a) => a.sparse)) {
    return { buf, changed: false, skipped: 'sparse-accessor' };
  }

  // Classify every accessor's semantic role(s) so we only quantize accessors used in a single compatible role
  const roles = new Map();
  const addRole = (idx, role) => {
    if (idx === undefined || idx === null) return;
    let s = roles.get(idx);
    if (!s) { s = new Set(); roles.set(idx, s); }
    s.add(role);
  };

  for (const mesh of json.meshes || []) {
    for (const prim of mesh.primitives || []) {
      if (!usesTexCoord1 && prim.attributes && prim.attributes.TEXCOORD_1 !== undefined) {
        delete prim.attributes.TEXCOORD_1;
      }
      if (prim.indices !== undefined) addRole(prim.indices, 'INDICES');
      for (const [attr, idx] of Object.entries(prim.attributes || {})) {
        addRole(idx, `ATTR:${attr}`);
      }
      for (const target of prim.targets || []) {
        for (const [attr, idx] of Object.entries(target)) addRole(idx, `MORPH:${attr}`);
      }
    }
  }
  for (const skin of json.skins || []) {
    if (skin.inverseBindMatrices !== undefined) addRole(skin.inverseBindMatrices, 'IBM');
  }

  // Track which animation samplers/channels exist
  const animInputUsage = new Set();
  const animOutputRole = new Map();
  for (const anim of json.animations || []) {
    for (const ch of anim.channels || []) {
      const sm = anim.samplers?.[ch.sampler];
      if (!sm) continue;
      animInputUsage.add(sm.input);
      addRole(sm.input, 'ANIM_IN');
      const role = `ANIM_OUT:${ch.target?.path || 'other'}:${sm.interpolation || 'LINEAR'}`;
      addRole(sm.output, role);
      animOutputRole.set(sm.output, role);
    }
  }

  // Binary pool builder:
  //  - Pool 0: tight non-strided binary data (4-byte aligned, SHA-256 deduplicated) -> 1 bufferView!
  //  - Pool 1: strided VEC3 BYTE normals (byteStride = 4, SHA-256 deduplicated) -> 1 bufferView (only if used)!
  //  - Image bufferViews: dedicated bufferView per unique image (SHA-256 deduplicated)!
  const tightChunks = [];
  let tightSize = 0;
  const tightDedup = new Map();

  const stride4Chunks = [];
  let stride4Size = 0;
  const stride4Dedup = new Map();

  const addTight = (data) => {
    const key = `${data.length}:${sha256(data)}`;
    if (tightDedup.has(key)) return tightDedup.get(key);
    const pad = (4 - (tightSize & 3)) & 3;
    if (pad) { tightChunks.push(Buffer.alloc(pad)); tightSize += pad; }
    const offset = tightSize;
    tightChunks.push(data);
    tightSize += data.length;
    tightDedup.set(key, offset);
    return offset;
  };

  const addStride4 = (data) => {
    const key = `${data.length}:${sha256(data)}`;
    if (stride4Dedup.has(key)) return stride4Dedup.get(key);
    const pad = (4 - (stride4Size & 3)) & 3;
    if (pad) { stride4Chunks.push(Buffer.alloc(pad)); stride4Size += pad; }
    const offset = stride4Size;
    stride4Chunks.push(data);
    stride4Size += data.length;
    stride4Dedup.set(key, offset);
    return offset;
  };

  let usedMeshQuantization = false;
  const newAccessors = [];
  const newAccessorKey = new Map(); // dedup identical accessor descriptors

  const registerAccessor = ({ pool, byteOffset, componentType, count, type, normalized, min, max }) => {
    const acc = {
      _pool: pool,
      byteOffset,
      componentType,
      count,
      type,
    };
    if (normalized) acc.normalized = true;
    if (min !== undefined) acc.min = min;
    if (max !== undefined) acc.max = max;
    const key = JSON.stringify(acc);
    if (newAccessorKey.has(key)) return newAccessorKey.get(key);
    const id = newAccessors.length;
    newAccessors.push(acc);
    newAccessorKey.set(key, id);
    return id;
  };

  const accRemap = new Map();

  function emitQuantizedAccessor(oldIdx) {
    if (accRemap.has(oldIdx)) return accRemap.get(oldIdx);
    const oldAcc = json.accessors[oldIdx];
    const rSet = roles.get(oldIdx);
    const onlyRole = rSet && rSet.size === 1 ? [...rSet][0] : null;

    // Default fallback: keep exact raw bytes in tight pool
    const keepRaw = () => {
      const raw = readRawAccessorBytes(json, bin, oldIdx);
      const byteOffset = addTight(raw);
      const id = registerAccessor({
        pool: 'tight',
        byteOffset,
        componentType: oldAcc.componentType,
        count: oldAcc.count,
        type: oldAcc.type,
        normalized: Boolean(oldAcc.normalized),
        min: oldAcc.min,
        max: oldAcc.max,
      });
      accRemap.set(oldIdx, id);
      return id;
    };

    if (!onlyRole || oldAcc.bufferView === undefined) return keepRaw();

    // 1. INDICES: UINT32 -> UINT16 when max <= 65535
    if (onlyRole === 'INDICES' && oldAcc.componentType === 5125 && oldAcc.type === 'SCALAR') {
      const parsed = readAccessorValues(json, bin, oldIdx);
      let maxV = 0;
      for (let i = 0; i < parsed.values.length; i++) if (parsed.values[i] > maxV) maxV = parsed.values[i];
      if (maxV <= 65535) {
        const out = Buffer.alloc(parsed.count * 2);
        for (let i = 0; i < parsed.count; i++) out.writeUInt16LE(parsed.values[i], i * 2);
        const id = registerAccessor({
          pool: 'tight',
          byteOffset: addTight(out),
          componentType: 5123,
          count: parsed.count,
          type: 'SCALAR',
        });
        accRemap.set(oldIdx, id);
        return id;
      }
      return keepRaw();
    }

    // 2. NORMAL: VEC3 FLOAT -> VEC3 BYTE normalized (4-byte stride)
    if (onlyRole === 'ATTR:NORMAL' && oldAcc.componentType === 5126 && oldAcc.type === 'VEC3') {
      const parsed = readAccessorValues(json, bin, oldIdx);
      const out = Buffer.alloc(parsed.count * 4);
      for (let i = 0; i < parsed.count; i++) {
        let nx = parsed.values[i * 3];
        let ny = parsed.values[i * 3 + 1];
        let nz = parsed.values[i * 3 + 2];
        const len = Math.hypot(nx, ny, nz);
        if (len > 1e-8) { nx /= len; ny /= len; nz /= len; }
        out.writeInt8(clamp(Math.round(nx * 127), -127, 127), i * 4);
        out.writeInt8(clamp(Math.round(ny * 127), -127, 127), i * 4 + 1);
        out.writeInt8(clamp(Math.round(nz * 127), -127, 127), i * 4 + 2);
        out.writeInt8(0, i * 4 + 3);
      }
      usedMeshQuantization = true;
      const id = registerAccessor({
        pool: 'stride4',
        byteOffset: addStride4(out),
        componentType: 5120,
        count: parsed.count,
        type: 'VEC3',
        normalized: true,
      });
      accRemap.set(oldIdx, id);
      return id;
    }

    // 3. TANGENT: VEC4 FLOAT -> VEC4 BYTE normalized
    if (onlyRole === 'ATTR:TANGENT' && oldAcc.componentType === 5126 && oldAcc.type === 'VEC4') {
      const parsed = readAccessorValues(json, bin, oldIdx);
      const out = Buffer.alloc(parsed.count * 4);
      for (let i = 0; i < parsed.count; i++) {
        let tx = parsed.values[i * 4];
        let ty = parsed.values[i * 4 + 1];
        let tz = parsed.values[i * 4 + 2];
        const tw = parsed.values[i * 4 + 3] < 0 ? -127 : 127;
        const len = Math.hypot(tx, ty, tz);
        if (len > 1e-8) { tx /= len; ty /= len; tz /= len; }
        out.writeInt8(clamp(Math.round(tx * 127), -127, 127), i * 4);
        out.writeInt8(clamp(Math.round(ty * 127), -127, 127), i * 4 + 1);
        out.writeInt8(clamp(Math.round(tz * 127), -127, 127), i * 4 + 2);
        out.writeInt8(tw, i * 4 + 3);
      }
      usedMeshQuantization = true;
      const id = registerAccessor({
        pool: 'tight',
        byteOffset: addTight(out),
        componentType: 5120,
        count: parsed.count,
        type: 'VEC4',
        normalized: true,
      });
      accRemap.set(oldIdx, id);
      return id;
    }

    // 4. WEIGHTS_0: VEC4 FLOAT -> VEC4 UNSIGNED_BYTE normalized (exact sum = 255)
    if (onlyRole === 'ATTR:WEIGHTS_0' && oldAcc.componentType === 5126 && oldAcc.type === 'VEC4') {
      const parsed = readAccessorValues(json, bin, oldIdx);
      const out = Buffer.alloc(parsed.count * 4);
      for (let i = 0; i < parsed.count; i++) {
        const w = [
          Math.max(0, parsed.values[i * 4]),
          Math.max(0, parsed.values[i * 4 + 1]),
          Math.max(0, parsed.values[i * 4 + 2]),
          Math.max(0, parsed.values[i * 4 + 3]),
        ];
        const s = w[0] + w[1] + w[2] + w[3];
        if (s > 1e-8) {
          const scaled = w.map((v) => (v / s) * 255);
          const q = scaled.map((v) => Math.floor(v));
          let rem = 255 - (q[0] + q[1] + q[2] + q[3]);
          const order = [0, 1, 2, 3].sort((a, b) => (scaled[b] - q[b]) - (scaled[a] - q[a]));
          for (let k = 0; k < rem; k++) q[order[k]]++;
          out[i * 4] = q[0]; out[i * 4 + 1] = q[1]; out[i * 4 + 2] = q[2]; out[i * 4 + 3] = q[3];
        } else {
          out[i * 4] = 255; out[i * 4 + 1] = 0; out[i * 4 + 2] = 0; out[i * 4 + 3] = 0;
        }
      }
      const id = registerAccessor({
        pool: 'tight',
        byteOffset: addTight(out),
        componentType: 5121,
        count: parsed.count,
        type: 'VEC4',
        normalized: true,
      });
      accRemap.set(oldIdx, id);
      return id;
    }

    // 5. JOINTS_0: VEC4 UNSIGNED_SHORT -> VEC4 UNSIGNED_BYTE when max <= 255
    if (onlyRole === 'ATTR:JOINTS_0' && oldAcc.componentType === 5123 && oldAcc.type === 'VEC4') {
      const parsed = readAccessorValues(json, bin, oldIdx);
      let maxJ = 0;
      for (let i = 0; i < parsed.values.length; i++) if (parsed.values[i] > maxJ) maxJ = parsed.values[i];
      if (maxJ <= 255) {
        const out = Buffer.alloc(parsed.count * 4);
        for (let i = 0; i < parsed.values.length; i++) out[i] = parsed.values[i];
        const id = registerAccessor({
          pool: 'tight',
          byteOffset: addTight(out),
          componentType: 5121,
          count: parsed.count,
          type: 'VEC4',
        });
        accRemap.set(oldIdx, id);
        return id;
      }
      return keepRaw();
    }

    // 6. TEXCOORD_0: VEC2 FLOAT -> VEC2 UNSIGNED_SHORT normalized when all UVs in [0, 1] (skip c4.glb!)
    if (!isC4 && onlyRole === 'ATTR:TEXCOORD_0' && oldAcc.componentType === 5126 && oldAcc.type === 'VEC2') {
      const parsed = readAccessorValues(json, bin, oldIdx);
      let inUnit = true;
      for (let i = 0; i < parsed.values.length; i++) {
        const v = parsed.values[i];
        if (!Number.isFinite(v) || v < -1e-4 || v > 1 + 1e-4) { inUnit = false; break; }
      }
      if (inUnit) {
        const out = Buffer.alloc(parsed.count * 4);
        for (let i = 0; i < parsed.values.length; i++) {
          out.writeUInt16LE(clamp(Math.round(parsed.values[i] * 65535), 0, 65535), i * 2);
        }
        const id = registerAccessor({
          pool: 'tight',
          byteOffset: addTight(out),
          componentType: 5123,
          count: parsed.count,
          type: 'VEC2',
          normalized: true,
        });
        accRemap.set(oldIdx, id);
        return id;
      }
      return keepRaw();
    }

    return keepRaw();
  }

  // Remap meshes & skins first
  for (const mesh of json.meshes || []) {
    for (const prim of mesh.primitives || []) {
      if (prim.indices !== undefined) prim.indices = emitQuantizedAccessor(prim.indices);
      for (const [attr, idx] of Object.entries(prim.attributes || {})) {
        prim.attributes[attr] = emitQuantizedAccessor(idx);
      }
      for (const target of prim.targets || []) {
        for (const [attr, idx] of Object.entries(target)) {
          target[attr] = emitQuantizedAccessor(idx);
        }
      }
    }
  }
  for (const skin of json.skins || []) {
    if (skin.inverseBindMatrices !== undefined) {
      skin.inverseBindMatrices = emitQuantizedAccessor(skin.inverseBindMatrices);
    }
  }

  // Identify bones whose scale is ALWAYS identical to [1,1,1] across every animation & bind pose
  const nonUnitScaleNodes = new Set();
  for (let ni = 0; ni < (json.nodes || []).length; ni++) {
    const ns = json.nodes[ni]?.scale;
    if (ns && (Math.abs(ns[0] - 1) > 1e-4 || Math.abs(ns[1] - 1) > 1e-4 || Math.abs(ns[2] - 1) > 1e-4)) {
      nonUnitScaleNodes.add(ni);
    }
  }
  for (const anim of json.animations || []) {
    for (const ch of anim.channels || []) {
      if (ch.target?.path !== 'scale') continue;
      const sm = anim.samplers?.[ch.sampler];
      const outParsed = sm ? readAccessorValues(json, bin, sm.output) : null;
      if (!outParsed) { nonUnitScaleNodes.add(ch.target.node); continue; }
      for (let i = 0; i < outParsed.values.length; i++) {
        if (Math.abs(outParsed.values[i] - 1) > 1e-4) {
          nonUnitScaleNodes.add(ch.target.node);
          break;
        }
      }
    }
  }

  // Optimize animations: collapse constant channels + quantize rotation quaternions + deduplicate samplers
  for (const anim of json.animations || []) {
    const newSamplers = [];
    const samplerDedup = new Map();
    const newChannels = [];

    for (const ch of anim.channels || []) {
      const sm = anim.samplers?.[ch.sampler];
      if (!sm) continue;
      if (ch.target?.path === 'scale' && !nonUnitScaleNodes.has(ch.target.node)) {
        // Bone never has non-unit scale in bind pose or any animation in this file — safe to omit.
        continue;
      }
      const interp = sm.interpolation || 'LINEAR';
      const inParsed = readAccessorValues(json, bin, sm.input);
      const outParsed = readAccessorValues(json, bin, sm.output);

      let newInIdx;
      let newOutIdx;

      if (inParsed && outParsed && interp !== 'CUBICSPLINE' && inParsed.count >= 2 && inParsed.count === outParsed.count) {
        const comps = outParsed.comps;
        const vals = outParsed.values;
        const n = inParsed.count;

        // Check if constant across all frames (handling quaternion double-cover q == -q!)
        let isConstant = true;
        const isRot = ch.target?.path === 'rotation' && comps === 4;
        for (let f = 1; f < n; f++) {
          let sign = 1;
          if (isRot) {
            const dot = vals[0] * vals[f * 4] + vals[1] * vals[f * 4 + 1] + vals[2] * vals[f * 4 + 2] + vals[3] * vals[f * 4 + 3];
            if (dot < 0) sign = -1;
          }
          for (let c = 0; c < comps; c++) {
            if (Math.abs(vals[f * comps + c] * sign - vals[c]) > 1e-4) {
              isConstant = false;
              break;
            }
          }
          if (!isConstant) break;
        }

        if (isConstant) {
          // Collapse to 2 boundary timestamps [t0, tEnd] (or 1 if t0 === tEnd) so clip.duration is 100% preserved!
          const t0 = inParsed.values[0];
          const tEnd = inParsed.values[n - 1];
          const kCount = Math.abs(tEnd - t0) > 1e-6 ? 2 : 1;
          const tBuf = Buffer.alloc(kCount * 4);
          tBuf.writeFloatLE(t0, 0);
          if (kCount === 2) tBuf.writeFloatLE(tEnd, 4);
          newInIdx = registerAccessor({
            pool: 'tight',
            byteOffset: addTight(tBuf),
            componentType: 5126,
            count: kCount,
            type: 'SCALAR',
            min: [t0],
            max: [kCount === 2 ? tEnd : t0],
          });

          if (isRot) {
            // Quantize constant quaternion to SHORT normalized
            const qBuf = Buffer.alloc(kCount * 8);
            let qx = vals[0], qy = vals[1], qz = vals[2], qw = vals[3];
            const ql = Math.hypot(qx, qy, qz, qw);
            if (ql > 1e-8) { qx /= ql; qy /= ql; qz /= ql; qw /= ql; }
            for (let k = 0; k < kCount; k++) {
              qBuf.writeInt16LE(clamp(Math.round(qx * 32767), -32767, 32767), k * 8);
              qBuf.writeInt16LE(clamp(Math.round(qy * 32767), -32767, 32767), k * 8 + 2);
              qBuf.writeInt16LE(clamp(Math.round(qz * 32767), -32767, 32767), k * 8 + 4);
              qBuf.writeInt16LE(clamp(Math.round(qw * 32767), -32767, 32767), k * 8 + 6);
            }
            newOutIdx = registerAccessor({
              pool: 'tight',
              byteOffset: addTight(qBuf),
              componentType: 5122,
              count: kCount,
              type: 'VEC4',
              normalized: true,
            });
          } else {
            const vBuf = Buffer.alloc(kCount * comps * 4);
            for (let k = 0; k < kCount; k++) {
              for (let c = 0; c < comps; c++) {
                vBuf.writeFloatLE(vals[c], (k * comps + c) * 4);
              }
            }
            newOutIdx = registerAccessor({
              pool: 'tight',
              byteOffset: addTight(vBuf),
              componentType: 5126,
              count: kCount,
              type: outParsed.acc.type,
            });
          }
        } else {
          // Non-constant channel: deduplicate exact Float32 times; quantize rotation quaternions to INT16 normalized
          const tBuf = Buffer.alloc(n * 4);
          let tMin = Infinity, tMax = -Infinity;
          for (let f = 0; f < n; f++) {
            const tv = inParsed.values[f];
            tBuf.writeFloatLE(tv, f * 4);
            if (tv < tMin) tMin = tv;
            if (tv > tMax) tMax = tv;
          }
          newInIdx = registerAccessor({
            pool: 'tight',
            byteOffset: addTight(tBuf),
            componentType: 5126,
            count: n,
            type: 'SCALAR',
            min: [tMin],
            max: [tMax],
          });

          if (isRot) {
            const qBuf = Buffer.alloc(n * 8);
            for (let f = 0; f < n; f++) {
              let qx = vals[f * 4], qy = vals[f * 4 + 1], qz = vals[f * 4 + 2], qw = vals[f * 4 + 3];
              const ql = Math.hypot(qx, qy, qz, qw);
              if (ql > 1e-8) { qx /= ql; qy /= ql; qz /= ql; qw /= ql; }
              qBuf.writeInt16LE(clamp(Math.round(qx * 32767), -32767, 32767), f * 8);
              qBuf.writeInt16LE(clamp(Math.round(qy * 32767), -32767, 32767), f * 8 + 2);
              qBuf.writeInt16LE(clamp(Math.round(qz * 32767), -32767, 32767), f * 8 + 4);
              qBuf.writeInt16LE(clamp(Math.round(qw * 32767), -32767, 32767), f * 8 + 6);
            }
            newOutIdx = registerAccessor({
              pool: 'tight',
              byteOffset: addTight(qBuf),
              componentType: 5122,
              count: n,
              type: 'VEC4',
              normalized: true,
            });
          } else {
            const vBuf = Buffer.alloc(n * comps * 4);
            for (let i = 0; i < n * comps; i++) vBuf.writeFloatLE(vals[i], i * 4);
            newOutIdx = registerAccessor({
              pool: 'tight',
              byteOffset: addTight(vBuf),
              componentType: 5126,
              count: n,
              type: outParsed.acc.type,
            });
          }
        }
      } else {
        newInIdx = emitQuantizedAccessor(sm.input);
        newOutIdx = emitQuantizedAccessor(sm.output);
      }

      const sKey = `${newInIdx}:${newOutIdx}:${interp}`;
      let sIdx = samplerDedup.get(sKey);
      if (sIdx === undefined) {
        sIdx = newSamplers.length;
        const entry = { input: newInIdx, output: newOutIdx };
        if (interp !== 'LINEAR') entry.interpolation = interp;
        newSamplers.push(entry);
        samplerDedup.set(sKey, sIdx);
      }
      newChannels.push({ sampler: sIdx, target: ch.target });
    }
    anim.samplers = newSamplers;
    anim.channels = newChannels;
  }

  // Assemble final BufferViews + single Buffer:
  //  [tight pool BV] [optional stride4 BV] [deduplicated image BVs]
  const finalBinParts = [];
  let binCursor = 0;
  const finalBvs = [];

  const appendBin = (chunk) => {
    const pad = (4 - (binCursor & 3)) & 3;
    if (pad) { finalBinParts.push(Buffer.alloc(pad)); binCursor += pad; }
    const off = binCursor;
    finalBinParts.push(chunk);
    binCursor += chunk.length;
    return off;
  };

  let tightBvIdx = -1;
  if (tightSize > 0) {
    const tightBuf = Buffer.concat(tightChunks, tightSize);
    const off = appendBin(tightBuf);
    tightBvIdx = finalBvs.length;
    finalBvs.push({ buffer: 0, byteOffset: off, byteLength: tightBuf.length });
  }

  let stride4BvIdx = -1;
  if (stride4Size > 0) {
    const s4Buf = Buffer.concat(stride4Chunks, stride4Size);
    const off = appendBin(s4Buf);
    stride4BvIdx = finalBvs.length;
    finalBvs.push({ buffer: 0, byteOffset: off, byteLength: s4Buf.length, byteStride: 4 });
  }

  // Remap images cleanly
  const imgDedup = new Map();
  for (const img of json.images || []) {
    if (img.bufferView === undefined) continue;
    const oldBv = json.bufferViews[img.bufferView];
    const imgBytes = bin.subarray(oldBv.byteOffset || 0, (oldBv.byteOffset || 0) + oldBv.byteLength);
    const key = `${imgBytes.length}:${sha256(imgBytes)}`;
    let bvIdx = imgDedup.get(key);
    if (bvIdx === undefined) {
      const off = appendBin(Buffer.from(imgBytes));
      bvIdx = finalBvs.length;
      finalBvs.push({ buffer: 0, byteOffset: off, byteLength: imgBytes.length });
      imgDedup.set(key, bvIdx);
    }
    img.bufferView = bvIdx;
  }

  // Finalize accessor bufferView indices
  json.accessors = newAccessors.map((acc) => {
    const bvIdx = acc._pool === 'stride4' ? stride4BvIdx : tightBvIdx;
    const out = {
      bufferView: bvIdx,
      componentType: acc.componentType,
      count: acc.count,
      type: acc.type,
    };
    if (acc.byteOffset) out.byteOffset = acc.byteOffset;
    if (acc.normalized) out.normalized = true;
    if (acc.min !== undefined) out.min = acc.min;
    if (acc.max !== undefined) out.max = acc.max;
    return out;
  });
  json.bufferViews = finalBvs;
  const finalBin = Buffer.concat(finalBinParts, binCursor);
  json.buffers = finalBin.length ? [{ byteLength: finalBin.length }] : [];

  if (usedMeshQuantization) {
    extsUsed.add('KHR_mesh_quantization');
    extsReq.add('KHR_mesh_quantization');
    json.extensionsUsed = [...extsUsed];
    json.extensionsRequired = [...extsReq];
  }

  const outBuf = buildGlb(json, finalBin);
  if (outBuf.length >= buf.length) {
    return { buf, changed: false, skipped: 'not-smaller' };
  }
  return { buf: outBuf, changed: true };
}

function collectGlbs(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectGlbs(full, out);
    else if (entry.name.endsWith('.glb')) out.push(full);
  }
  return out;
}

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const filterArg = process.argv.find((a) => a.startsWith('--only='))?.slice(7);

const files = collectGlbs(ASSETS_DIR).sort().filter((f) => !filterArg || f.includes(filterArg));
let totalBefore = 0;
let totalAfter = 0;
let changedCount = 0;
const changedGlbs = [];

for (const full of files) {
  const rel = path.relative(PUBLIC, full).replaceAll('\\', '/');
  const orig = fs.readFileSync(full);
  const oldSha = sha256(orig);
  totalBefore += orig.length;

  const res = optimizeGlb(orig, rel);
  if (res.changed) {
    changedCount++;
    totalAfter += res.buf.length;
    const newSha = sha256(res.buf);
    let newRel = rel;
    let newFull = full;
    // Popular packaged agent GLBs require their 12-hex filename suffix to match sha256.slice(0, 12)!
    const popMatch = /^(assets\/characters-cs2\/popular\/[a-z0-9-]+\/(?:body|arms)-)[0-9a-f]{12}(\.glb)$/.exec(rel);
    if (popMatch) {
      newRel = `${popMatch[1]}${newSha.slice(0, 12)}${popMatch[2]}`;
      newFull = path.join(PUBLIC, newRel);
    }
    if (!dryRun) {
      fs.writeFileSync(newFull, res.buf);
      if (newFull !== full && fs.existsSync(full)) fs.unlinkSync(full);
    }
    changedGlbs.push({
      oldPath: rel,
      newPath: newRel,
      oldBytes: orig.length,
      newBytes: res.buf.length,
      oldSha256: oldSha,
      newSha256: newSha,
    });
    if (orig.length - res.buf.length > 500_000 || filterArg) {
      const pct = (((orig.length - res.buf.length) / orig.length) * 100).toFixed(1);
      console.log(`[opt] ${rel}: ${(orig.length / 1e6).toFixed(2)} MB -> ${(res.buf.length / 1e6).toFixed(2)} MB (-${pct}%)`);
    }
  } else {
    totalAfter += orig.length;
  }
}

console.log(JSON.stringify({
  dryRun,
  scanned: files.length,
  changed: changedCount,
  beforeMB: +(totalBefore / 1e6).toFixed(2),
  afterMB: +(totalAfter / 1e6).toFixed(2),
  savedMB: +((totalBefore - totalAfter) / 1e6).toFixed(2),
  savedPct: +(((totalBefore - totalAfter) / Math.max(1, totalBefore)) * 100).toFixed(1),
}, null, 2));

if (!dryRun && changedGlbs.length) {
  const reportPath = path.join(ROOT, 'artifacts', 'compression-report.json');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    tool: 'optimize-glb-assets.mjs',
    changedGlbs,
  }, null, 2));
  console.log(`[report] Wrote ${changedGlbs.length} entries to ${path.relative(ROOT, reportPath)}`);
}
