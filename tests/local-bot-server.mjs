import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOfflineMapManifests } from '../server/offline-map-manifests.js';
import { createLocalBotSocket } from '../client/local-bot-server.js';
import { configurePrivateMap } from '../shared/private-map-context.js';
import { initPhysics } from '../shared/physics.js';
import { loadPrivatePhysicsShared, readFileOrCompressed } from '../scripts/maps/load-private-physics.mjs';
import { privateConfig } from '../client/private-game-config.js';
import { CLIENT_BUILD, RULES_VERSION, ASSET_VERSION } from '../shared/online-build.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAP_ROOT = path.join(ROOT, 'artifacts/performance-maps/maps-v1');
const HAS_MAPS = fs.existsSync(path.join(MAP_ROOT, 'de_dust2/compiled/map.json'));

test('buildOfflineMapManifests generates valid privateConfig entries for all 9 maps', { skip: !HAS_MAPS }, () => {
  const result = buildOfflineMapManifests(MAP_ROOT);
  assert.equal(result.schemaVersion, 1);
  const ids = Object.keys(result.maps);
  assert.ok(ids.length >= 7, `expected at least 7 maps, got ${ids.length}`);
  for (const id of ids) {
    const validated = privateConfig(result.maps[id], `https://example.local/play.html?map=${id}&offline=1`, {
      apiOrigin: 'https://example.local',
    });
    assert.equal(validated.id, id);
    assert.equal(validated.offlineCapable, true);
    assert.equal(validated.rtcEnabled, false);
    assert.ok(validated.compactRender?.url, `${id} should include compactRender`);
    assert.ok(validated.compactPhysics?.url, `${id} should include compactPhysics`);
  }
});

test('createLocalBotSocket runs authoritative 0ms local GameRoom with PrivateMapBots and zero network', { skip: !HAS_MAPS }, async () => {
  const manifests = buildOfflineMapManifests(MAP_ROOT);
  const dust2Cfg = manifests.maps.de_dust2;
  const dir = path.join(MAP_ROOT, 'de_dust2');
  const meta = JSON.parse(readFileOrCompressed(path.join(dir, 'compiled/map.json')));
  const nav = JSON.parse(readFileOrCompressed(path.join(dir, 'compiled/nav.json')));
  const shared = loadPrivatePhysicsShared(dir);

  configurePrivateMap(meta, nav, dust2Cfg);
  initPhysics(shared.positions, null, {
    map: meta,
    mapPatches: false,
    sharedChannelMask: shared.channelMask,
    copyPositions: false,
    airMovement: 'source',
  });

  const sock = createLocalBotSocket({ mapConfig: dust2Cfg, meta, nav });
  assert.equal(sock.transportMode, 'LOCAL');
  const received = [];
  sock.addEventListener('message', (ev) => {
    received.push(JSON.parse(ev.data));
  });

  try {
    await new Promise((resolve) => sock.addEventListener('open', resolve, { once: true }));
    assert.equal(sock.readyState, 1);

    sock.send(JSON.stringify({
      type: 'join',
      clientBuild: CLIENT_BUILD,
      rulesVersion: RULES_VERSION,
      assetVersion: ASSET_VERSION,
      mapId: dust2Cfg.mapId,
      mapSignature: dust2Cfg.mapSignature,
      physicsSha256: dust2Cfg.physicsSha256,
      name: 'OfflinePlayer',
      mode: 'deathmatch',
      team: 'CT',
      bots: 5,
      botDifficulty: 'hard',
      movementProtocol: 1,
      shotProtocol: 1,
    }));

    const welcome = received.find((m) => m.type === 'welcome');
    assert.ok(welcome, 'expected immediate local welcome');
    assert.equal(welcome.room, 'LOCAL');
    assert.equal(welcome.botDifficulty, 'hard');
    assert.equal(welcome.desiredBots, 5);

    // Ping/pong should round-trip immediately at 0ms.
    sock.send(JSON.stringify({ type: 'ping', time: 1234.5 }));
    const pong = received.find((m) => m.type === 'pong');
    assert.equal(pong?.time, 1234.5);

    // Let local 30Hz simulation + PrivateMapBots run for ~450ms and confirm snapshots + bot changes work.
    await new Promise((r) => setTimeout(r, 450));
    const snaps = received.filter((m) => m.type === 'snapshot');
    assert.ok(snaps.length >= 4, `expected live local snapshots, got ${snaps.length}`);
    const latest = snaps[snaps.length - 1];
    assert.equal(latest.players.length, 6, '1 human + 5 bots');

    sock.send(JSON.stringify({ type: 'setBotDifficulty', botDifficulty: 'easy' }));
    const diffAck = received.find((m) => m.type === 'botDifficultyUpdated');
    assert.equal(diffAck?.ok, true);
    assert.equal(diffAck?.botDifficulty, 'easy');
  } finally {
    sock.close(1000, 'done');
  }
});
