import test from 'node:test';
import assert from 'node:assert/strict';
import { CdnAssetLoader, assertSafeRelativePath, sha256Hex } from '../src/assets/cdn-loader.ts';
import { PredictionReconciler } from '../src/physics/reconciliation.ts';
import { TSPhysicsKernel } from '../src/physics/ts-kernel.ts';
import {
  CLOUD_KEY_LOADOUT,
  CLOUD_KEY_PROGRESS,
  ToyCloudSyncController,
  checkToyFollowAndTriple,
  fetchToyProfile,
  isToyHost,
  isToyRateLimitError,
  parseAuthorFollowResp,
  parseVideoActionsResp,
} from '../src/platform/toy-sdk.ts';
import type { PlayerSnapshot } from '../src/net/protocol.ts';

function makePlayer(overrides: Partial<PlayerSnapshot> = {}): PlayerSnapshot {
  return {
    id: 'p1',
    name: 'Tester',
    team: 'CT',
    bot: false,
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    yaw: 0,
    pitch: 0,
    crouch: false,
    grounded: true,
    health: 100,
    armor: 100,
    alive: true,
    weapon: 'ak47',
    slot: 1,
    ammo: 30,
    reserve: 90,
    money: 800,
    kills: 0,
    deaths: 0,
    assists: 0,
    seq: 0,
    hasBomb: false,
    ...overrides,
  };
}

test('toy-sdk host detection, profile parsing, and 307044 exponential backoff', async () => {
  assert.equal(isToyHost({ hostname: 'www.bilibilitoy.com' }), true);
  assert.equal(isToyHost({ hostname: 'sub.bilibilitoy.com' }), true);
  assert.equal(isToyHost({ hostname: '127.0.0.1' }), false);
  assert.equal(isToyRateLimitError({ type: 'http_error', code: 307044 }), true);
  assert.equal(isToyRateLimitError({ type: 'http_error', code: 500 }), false);

  const profile = await fetchToyProfile({
    getUserProfile: async () => ({ nickname: 'B站干员', toyOpenId: 'oid_12345' }),
  });
  assert.deepEqual(profile, { nickname: 'B站干员', openId: 'oid_12345' });

  let now = 1000;
  let mode: 'fail' | 'ok' = 'fail';
  let writeCalls = 0;
  const controller = new ToyCloudSyncController(
    {
      setCloudStorage: async () => {
        writeCalls++;
        if (mode === 'fail') throw { type: 'http_error', code: 307044 };
      },
    },
    { now: () => now, baseBackoffMs: 2000, maxBackoffMs: 10000 },
  );

  const first = await controller.flushBatch({ k1: '1', k2: '2' });
  assert.equal(first.status, 'rate-limited');
  assert.equal(first.retryAfterMs, 2000);
  assert.equal(writeCalls, 1);

  // During cooldown, flushBatch refuses to spam SDK.
  const skipped = await controller.flushBatch({ k1: '1' });
  assert.equal(skipped.status, 'skipped-cooldown');
  assert.equal(writeCalls, 1);

  // After cooldown, second 307044 doubles backoff to 4000ms.
  now += 2500;
  const second = await controller.flushBatch({ k1: '1' });
  assert.equal(second.status, 'rate-limited');
  assert.equal(second.retryAfterMs, 4000);
  assert.equal(writeCalls, 2);

  // After backoff passes and SDK succeeds, cooldown resets.
  now += 4500;
  mode = 'ok';
  const ok = await controller.flushBatch({ k1: '1' });
  assert.equal(ok.status, 'synced');
  assert.equal(controller.cooldownRemainingMs, 0);
});

test('toy-sdk social follow/triple detection and cloud storage key compliance', async () => {
  assert.match(CLOUD_KEY_PROGRESS, /^[a-zA-Z0-9_-]{1,128}$/);
  assert.match(CLOUD_KEY_LOADOUT, /^[a-zA-Z0-9_-]{1,128}$/);
  assert.equal(CLOUD_KEY_PROGRESS.startsWith('__'), false);

  assert.equal(parseAuthorFollowResp({ followed: true }), true);
  assert.equal(parseAuthorFollowResp({ data: { attribute: 6 } }), true);
  assert.equal(parseAuthorFollowResp({ followed: false, attribute: 0 }), false);

  assert.deepEqual(
    parseVideoActionsResp({ items: [{ aid: 1001, like: 1, coin: 2, fav: 1 }] }),
    { liked: true, coined: true, favorited: true, tripled: true },
  );
  assert.deepEqual(
    parseVideoActionsResp({ items: [{ aid: 1001, liked: true, coined: false, favorited: false }] }),
    { liked: true, coined: false, favorited: false, tripled: false },
  );

  const social = await checkToyFollowAndTriple({
    getAuthorRelation: async () => ({ followed: true }),
    getAuthorVideoRange: async () => ({ items: [{ aid: 9988 }] }),
    getVideoUserActions: async ({ aids }) => {
      assert.deepEqual(aids, [9988]);
      return { items: [{ aid: 9988, liked: true, coined: true, favorited: true }] };
    },
  });
  assert.deepEqual(social, { followed: true, liked: true, coined: true, favorited: true, tripled: true });

  const cloud = new ToyCloudSyncController({
    getCloudStorage: async keys => Object.fromEntries(keys.map(k => [k, '{"kills":7}'])),
  });
  const loaded = await cloud.readBatch([CLOUD_KEY_PROGRESS]);
  assert.equal(loaded?.[CLOUD_KEY_PROGRESS], '{"kills":7}');
});

test('CdnAssetLoader rejects traversal, verifies SHA-256, and reuses CacheStorage hits', async () => {
  for (const bad of ['../secret.json', '/etc/passwd', 'a/%2e%2e/b', 'a\\b']) {
    assert.throws(() => assertSafeRelativePath(bad));
  }

  const payload = new TextEncoder().encode('verified-map-bytes');
  const expectedHash = await sha256Hex(payload.buffer);
  let networkCalls = 0;
  const memCache = new Map<string, Response>();

  const fakeCaches = {
    open: async () => ({
      match: async (key: string) => memCache.get(key)?.clone(),
      put: async (key: string, response: Response) => {
        memCache.set(key, response);
      },
      delete: async (key: string) => memCache.delete(key),
    }),
  } as unknown as CacheStorage;

  const loader = new CdnAssetLoader({
    mapBaseUrl: 'https://downloads.example.com/maps',
    cacheStorage: fakeCaches,
    fetcher: async () => {
      networkCalls++;
      return new Response(payload);
    },
  });

  const url = loader.resolveMapUrl('de_mirage', 'render/map.gltf', expectedHash);
  assert.equal(url, `https://downloads.example.com/maps/de_mirage/render/map.gltf?v=${expectedHash}`);

  // First read hits network and populates cache.
  const first = await loader.fetchVerifiedBytes(url, { expectedSha256: expectedHash, expectedBytes: payload.byteLength });
  assert.equal(first.byteLength, payload.byteLength);
  assert.equal(networkCalls, 1);

  // Second read hits CacheStorage with SHA-256 check and zero network traffic.
  const second = await loader.fetchVerifiedBytes(url, { expectedSha256: expectedHash, expectedBytes: payload.byteLength });
  assert.equal(second.byteLength, payload.byteLength);
  assert.equal(networkCalls, 1);
  assert.equal(loader.cacheHits, 1);

  // Corrupted hash fails closed.
  await assert.rejects(
    loader.fetchVerifiedBytes(url, { expectedSha256: '0'.repeat(64) }),
    /SHA-256 mismatch/,
  );
});

test('PredictionReconciler replays unacknowledged inputs and snaps on respawn teleport', () => {
  const kernel = new TSPhysicsKernel();
  const reconciler = new PredictionReconciler(kernel);

  // Initial authoritative spawn at origin.
  reconciler.reconcile(makePlayer({ seq: 0, x: 0, y: 0, z: 0 }));

  const moveFwd = { forward: 1, right: 0, yaw: 0, pitch: 0, jump: false, crouch: false, walk: false };
  reconciler.applyLocalInput(1, moveFwd, 1 / 30);
  reconciler.applyLocalInput(2, moveFwd, 1 / 30);
  const predictedAfter2 = reconciler.applyLocalInput(3, moveFwd, 1 / 30);
  assert.equal(reconciler.pendingCount, 3);
  assert.ok(predictedAfter2.z < -0.5);

  // Server acknowledges seq=2 at exact expected position; seq=3 remains replayed with ~0 error.
  const step1 = kernel.stepPlayer({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, grounded: true, crouch: false }, moveFwd, 1 / 30);
  const step2 = kernel.stepPlayer(step1, moveFwd, 1 / 30);
  const reconciled = reconciler.reconcile(makePlayer({ seq: 2, x: step2.x, y: step2.y, z: step2.z, vx: step2.vx, vy: step2.vy, vz: step2.vz }));
  assert.equal(reconciler.pendingCount, 1);
  assert.ok(reconciled.lastErrorMeters < 0.001);

  // Large teleport (respawn at x=30) snaps immediately without lingering visual offset.
  const snapped = reconciler.reconcile(makePlayer({ seq: 3, x: 30, y: 0, z: -15 }));
  assert.equal(snapped.x, 30);
  assert.equal(snapped.z, -15);
  assert.equal(reconciler.pendingCount, 0);
  kernel.dispose();
});
