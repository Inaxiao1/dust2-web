import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { PERFORMANCE_MAPS } from '../shared/performance-map-pool.js';
import { PRIVATE_MOVEMENT_MODEL, laddersForMap } from '../shared/ladder-movement.js';
import { privateEntities } from '../shared/private-map-entities.js';
import { MIRAGE_JUMP_IDENTITY, MIRAGE_JUMP_LINKS } from '../shared/private-map-jump-links.js';

const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');

function readJsonFlexible(filePath) {
  if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (fs.existsSync(filePath + '.gz')) return JSON.parse(zlib.gunzipSync(fs.readFileSync(filePath + '.gz')).toString('utf8'));
  if (fs.existsSync(filePath + '.br')) return JSON.parse(zlib.brotliDecompressSync(fs.readFileSync(filePath + '.br')).toString('utf8'));
  return null;
}

/**
 * Build a compact, hash-verified offline manifest table for all compiled maps so
 * clients can launch 100% local bot matches without contacting any game server.
 */
export function buildOfflineMapManifests(mapRoot) {
  const maps = {};
  for (const entry of PERFORMANCE_MAPS) {
    const id = entry.id;
    const dir = path.join(mapRoot, id);
    const readyPath = path.join(dir, 'READY.json');
    const meta = readJsonFlexible(path.join(dir, 'compiled', 'map.json'));
    if (!fs.existsSync(readyPath) || !meta) continue;

    const ready = JSON.parse(fs.readFileSync(readyPath, 'utf8'));
    const hashes = ready.gameplayHashes || {};
    const metadataSha256 = hashes['map.json'];
    const navigationSha256 = hashes['nav.json'];
    const physicsSha256 = hashes['physics.f32'];
    const maskSha256 = hashes['physics-mask.u8'];
    const policySha256 = hashes['entity-collision-policy.json'];
    const sourceSha256 = meta.sourceSha256;
    if (![metadataSha256, navigationSha256, physicsSha256, maskSha256, policySha256, sourceSha256].every((h) => typeof h === 'string' && /^[a-f0-9]{64}$/.test(h))) {
      continue;
    }

    const breakablePolicy = privateEntities(id);
    const breakables = breakablePolicy?.objects || [];
    const jumpLinks = id === MIRAGE_JUMP_IDENTITY.mapId
      && sourceSha256 === MIRAGE_JUMP_IDENTITY.sourceSha256
      && physicsSha256 === MIRAGE_JUMP_IDENTITY.physicsSha256
      ? MIRAGE_JUMP_LINKS
      : [];
    const laddersSha256 = sha(JSON.stringify(laddersForMap(meta)));
    const jumpLinksSha256 = sha(JSON.stringify(jumpLinks));
    const identity = {
      mapId: id,
      metadataSha256,
      sourceSha256,
      physicsSha256,
      maskSha256,
      policySha256,
      navigationSha256,
      movementModel: PRIVATE_MOVEMENT_MODEL,
      laddersSha256,
      jumpLinksSha256,
      ...(breakablePolicy ? { breakablesSha256: sha(JSON.stringify(breakablePolicy)) } : {}),
    };
    const mapSignature = sha(JSON.stringify(identity));

    const compactPath = path.join(dir, 'compact-manifest.json');
    const compact = fs.existsSync(compactPath) ? JSON.parse(fs.readFileSync(compactPath, 'utf8')) : null;
    const remapPath = path.join(dir, 'flat-breakables.json');
    const flatBreakableVisuals = fs.existsSync(remapPath) ? JSON.parse(fs.readFileSync(remapPath, 'utf8')) : null;

    const urls = {};
    for (const [key, file] of [
      ['metadataUrl', 'map.json'],
      ['navUrl', 'nav.json'],
      ['physicsUrl', 'physics.f32'],
      ['maskUrl', 'physics-mask.u8'],
      ['groupsUrl', 'physics-groups.json'],
      ['policyUrl', 'entity-collision-policy.json'],
    ]) {
      const digest = hashes[file];
      urls[key] = '/perf/maps/' + id + '/' + file + (digest ? '?v=' + digest : '');
    }

    maps[id] = {
      private: true,
      offlineCapable: true,
      id,
      name: entry.name || meta.name || id,
      nameZh: entry.nameZh || meta.nameZh || entry.name || id,
      ...identity,
      mapSignature,
      breakables,
      initialHiddenNodeIndices: breakablePolicy?.initialHiddenNodeIndices || [],
      ...urls,
      renderUrl: '/perf/maps/' + id + '/render/map.gltf',
      socketPath: 'ws',
      flatOnly: true,
      rtcEnabled: false,
      ...(compact ? {
        compactRender: compact.mesh ? {
          url: '/perf/maps/' + id + '/' + compact.mesh.path + '?v=' + compact.mesh.sha256,
          bytes: compact.mesh.bytes,
          sha256: compact.mesh.sha256,
        } : null,
        compactPhysics: compact.physics ? {
          url: '/perf/maps/' + id + '/physics.vidx?v=' + compact.physics.sha256,
          bytes: compact.physics.bytes,
          sha256: compact.physics.sha256,
        } : null,
      } : {}),
      ...(flatBreakableVisuals ? { flatBreakableVisuals } : {}),
    };
  }
  return { schemaVersion: 1, maps };
}
