import test from 'node:test';
import assert from 'node:assert/strict';
import { SKINS } from '../shared/skins.js';
import { AGENT_CATALOG } from '../shared/agents.js';
import { WEAPONS } from '../shared/weapons.js';
import {
  createEmptyProgress,
  normalizeProgress,
  STARTER_SKINS,
  STARTER_AGENTS,
  isSkinUnlocked,
  isAgentUnlocked,
} from '../shared/progression.js';
import { normalizeWeaponLoadout } from '../shared/weapon-loadout.js';
import { DEFAULT_CROSSHAIR } from '../shared/cs2-settings.js';
import { LAYOUT_IDS, buildTouchPresetLayout } from '../shared/touch-layout.js';
import { DEFAULT_BINDINGS } from '../client/controls.js';
import {
  TOY_CLOUD_MAX_KEYS,
  TOY_CLOUD_MAX_VALUE_BYTES,
  TOY_CLOUD_SAFE_VALUE_BYTES,
  TOY_CLOUD_KEY_REGEX,
  LEGACY_CLOUD_KEY_PROGRESS,
  LEGACY_CLOUD_KEY_LOADOUT,
  utf8ByteLength,
  encodeToyCloudSnapshot,
  decodeToyCloudSnapshot,
  validateToyCloudEntries,
  diffToyCloudEntries,
  measureToyCloudUsage,
} from '../shared/toy-cloud-codec.js';
import { ToyIdentity } from '../scripts/maps/mode-ui/toy-identity.js';
import { ToyProgressStore } from '../client/toy-cloud-progress.js';
import { createPreferenceStore } from '../client/persistence.js';

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

function createStrictToySdk(cloudMap) {
  const stats = { getCalls: 0, setCalls: 0, removeCalls: 0, lastWrittenKeys: [], lastDeletedKeys: [] };
  const sdk = {
    async isSupport() { return true; },
    async getUserProfile() {
      return { toyOpenId: 'toy_quota_user_01', nickname: '云档验收员', avatar: 'https://p0.hdslb.com/a.jpg' };
    },
    async getCloudStorage(keys = []) {
      stats.getCalls++;
      const out = {};
      if (!Array.isArray(keys) || keys.length === 0) {
        for (const [k, v] of cloudMap.entries()) out[k] = v;
        return out;
      }
      for (const k of keys) {
        assert.match(k, TOY_CLOUD_KEY_REGEX);
        if (cloudMap.has(k)) out[k] = cloudMap.get(k);
      }
      return out;
    },
    async setCloudStorage(entries) {
      stats.setCalls++;
      assert.equal(typeof entries, 'object');
      assert.ok(entries && !Array.isArray(entries));
      const sim = new Map(cloudMap);
      const written = [];
      for (const [k, v] of Object.entries(entries)) {
        assert.match(k, TOY_CLOUD_KEY_REGEX, `key "${k}" violates Toy regex / reserved "__" rule`);
        assert.equal(typeof v, 'string', `value for "${k}" must be string`);
        const len = utf8ByteLength(v);
        assert.ok(len <= TOY_CLOUD_MAX_VALUE_BYTES, `value for "${k}" is ${len} UTF-8 bytes (> 1024B Toy server limit!)`);
        sim.set(k, v);
        written.push(k);
      }
      assert.ok(sim.size <= TOY_CLOUD_MAX_KEYS, `total keys ${sim.size} exceeds Toy 128-key hard limit!`);
      for (const [k, v] of Object.entries(entries)) cloudMap.set(k, v);
      stats.lastWrittenKeys = written;
    },
    async removeCloudStorage(keys) {
      stats.removeCalls++;
      for (const k of keys) {
        assert.match(k, TOY_CLOUD_KEY_REGEX);
        cloudMap.delete(k);
      }
      stats.lastDeletedKeys = [...keys];
    },
  };
  return { sdk, stats };
}

test('Toy Cloud v2 codec stays strictly within 128 keys x 1024 UTF-8 bytes even at extreme ceiling', () => {
  const bases = new Map(LAYOUT_IDS.map((id, i) => [id, { x: 0.1 + (i % 5) * 0.18, y: 0.2 + Math.floor(i / 5) * 0.15 }]));
  const fourFinger = buildTouchPresetLayout('four-finger', bases, 844, 390);

  // Pick a non-starter skin for every weapon that has one
  const maxCustomSkins = { ...STARTER_SKINS };
  for (const weapon of Object.keys(STARTER_SKINS)) {
    const alt = SKINS.find((s) => s.weapon === weapon && s.id !== STARTER_SKINS[weapon]);
    if (alt) maxCustomSkins[weapon] = alt.id;
  }

  const extremeProgress = normalizeProgress({
    uid: 'toy_extreme_player_0001',
    kills: 98765,
    headshots: 43210,
    matches: 1200,
    rounds: 21000,
    wins: 720,
    weaponKills: Object.fromEntries(Object.keys(WEAPONS).map((w, i) => [w, 100 + i * 37])),
    grantedSkins: SKINS.map((s) => s.id),
    grantedAgents: AGENT_CATALOG.map((a) => a.id),
    bonusXp: 250000,
    claimedMailIds: Array.from({ length: 200 }, (_, i) => `mail-reward-2026-${String(i).padStart(3, '0')}`),
    readMailIds: Array.from({ length: 300 }, (_, i) => `mail-notice-2026-${String(i).padStart(3, '0')}`),
    customItems: Object.fromEntries(
      Array.from({ length: 120 }, (_, i) => [
        `item-s1-${i}`,
        {
          id: `item-s1-${i}`,
          title: `赛季先锋限定徽章#${i}`,
          category: 'badge',
          quantity: i + 1,
          description: '随时随地CS 赛季专属活动收藏纪念品',
          icon: `S${i % 9}`,
          acquiredAt: 1795878000000 + i,
        },
      ]),
    ),
    social: { followed: true, tripled: true, liked: true, coined: true, favorited: true, checkedAt: 1795878000000 },
    updatedAt: 1795879000000,
  });

  const extremeLoadout = {
    skins: maxCustomSkins,
    agents: { CT: 'ct-ava', T: 't-miami' },
    weapons: normalizeWeaponLoadout({}),
    updatedAt: 1795879000000,
  };

  const extremeSettings = {
    updatedAt: 1795879000000,
    csSettings: {
      sensitivity: 1.85,
      zoomSensitivity: 0.92,
      invertY: true,
      crosshair: { ...DEFAULT_CROSSHAIR, size: 3.5, gap: -2, thickness: 1.2, dot: true, color: 5, red: 255, green: 200, blue: 40 },
      aspect: '4:3',
      display: 'stretch',
      privateVideo: { aspect: '16:9', display: 'bars' },
      mobileClarity: 'sharp',
      flatRenderScale: 'native',
      radarRotate: false,
      botDifficulty: 'hard',
    },
    quality: 'high',
    brightness: 118,
    visualStyle: 'competitive',
    mapStyle: 'original',
    frameLimit: 90,
    mouseDpi: 1600,
    volume: 0.75,
    musicKit: 'valve_cs2_01',
    musicVolume: 0.35,
    controls: { version: 1, bindings: { ...DEFAULT_BINDINGS, jump: ['Space', 'WheelDown'], nextWeapon: ['KeyV'] } },
    touch: { mode: 'on', sensitivity: 1.4, zoomSensitivity: 0.85, size: 1.1 },
    motion: { mode: 'scope', horizontal: 1.8, vertical: 1.5, scope: 0.9, invertX: false, invertY: true, assist: 'low' },
    fullscreen: { automatic: false },
    touchLayout: fourFinger,
  };

  const encoded = encodeToyCloudSnapshot({
    progress: extremeProgress,
    loadout: extremeLoadout,
    settings: extremeSettings,
  });

  assert.equal(validateToyCloudEntries(encoded), true);
  const usage = measureToyCloudUsage(encoded);
  assert.equal(usage.withinLimits, true);
  assert.ok(usage.keysUsed <= TOY_CLOUD_MAX_KEYS, `expected <= 128 keys, got ${usage.keysUsed}`);
  assert.ok(usage.maxValueBytes <= TOY_CLOUD_SAFE_VALUE_BYTES, `expected max value <= ${TOY_CLOUD_SAFE_VALUE_BYTES}B, got ${usage.maxValueBytes}B`);
  for (const [k, v] of Object.entries(encoded)) {
    assert.match(k, TOY_CLOUD_KEY_REGEX);
    assert.ok(utf8ByteLength(v) <= TOY_CLOUD_MAX_VALUE_BYTES, `${k} exceeded 1024B`);
  }

  // Full lossless round-trip verification!
  const decoded = decodeToyCloudSnapshot(encoded, 'toy_extreme_player_0001');
  assert.equal(decoded.progress.kills, 98765);
  assert.equal(decoded.progress.headshots, 43210);
  assert.equal(decoded.progress.bonusXp, 250000);
  assert.equal(decoded.progress.grantedSkins.length, SKINS.length);
  assert.equal(decoded.progress.grantedAgents.length, AGENT_CATALOG.length);
  assert.equal(decoded.progress.claimedMailIds.length, 200);
  assert.equal(Object.keys(decoded.progress.customItems).length, 120);
  assert.equal(decoded.progress.customItems['item-s1-0'].title, '赛季先锋限定徽章#0');
  assert.equal(decoded.progress.social.followed, true);
  assert.equal(decoded.progress.social.tripled, true);
  assert.deepEqual(decoded.loadout.skins, maxCustomSkins);
  assert.deepEqual(decoded.loadout.agents, { CT: 'ct-ava', T: 't-miami' });
  assert.equal(decoded.settings.csSettings.sensitivity, 1.85);
  assert.equal(decoded.settings.csSettings.invertY, true);
  assert.equal(decoded.settings.csSettings.crosshair.size, 3.5);
  assert.equal(decoded.settings.csSettings.crosshair.dot, true);
  assert.equal(decoded.settings.quality, 'high');
  assert.equal(decoded.settings.brightness, 118);
  assert.equal(decoded.settings.visualStyle, 'competitive');
  assert.equal(decoded.settings.musicKit, 'valve_cs2_01');
  assert.equal(decoded.settings.mouseDpi, 1600);
  assert.deepEqual(decoded.settings.controls.bindings.jump, ['Space', 'WheelDown']);
  assert.equal(decoded.settings.touch.sensitivity, 1.4);
  assert.equal(decoded.settings.motion.mode, 'scope');
  assert.equal(decoded.settings.fullscreen.automatic, false);
  assert.equal(Object.keys(decoded.settings.touchLayout.buttons).length, Object.keys(fourFinger.buttons).length);
  assert.equal(decoded.settings.touchLayout.buttons.fireLeft.x, 0.16);
});

test('ToyProgressStore syncs mailbox rewards, skins, settings & 4-finger touch layout across devices and migrates legacy v1', async () => {
  const cloudMap = new Map();
  // Seed legacy v1 progress on Toy Cloud to verify lossless migration + cleanup
  const legacyProg = normalizeProgress({
    uid: 'toy_quota_user_01',
    kills: 50,
    matches: 3,
    grantedSkins: ['deagle-conspiracy'],
    claimedMailIds: ['legacy-mail-01'],
    social: { followed: true },
    updatedAt: 5000,
  });
  cloudMap.set(LEGACY_CLOUD_KEY_PROGRESS, JSON.stringify(legacyProg));

  const { sdk, stats } = createStrictToySdk(cloudMap);
  let now = 20000;

  // Device A initializes, merges legacy v1, claims new mail, edits settings & 4-finger layout
  const rawA = memoryStorage();
  const prefsA = createPreferenceStore(rawA);
  const idA = new ToyIdentity({
    sdk,
    storage: rawA,
    window: { location: { href: 'https://www.bilibilitoy.com/toy/cs2/1.0/index.html' } },
    document: {},
  });
  const storeA = new ToyProgressStore({ identity: idA, storage: prefsA, now: () => now, minSyncIntervalMs: 1000 });
  await storeA.init();

  assert.equal(storeA.progress.kills, 50);
  assert.equal(isSkinUnlocked('deagle-conspiracy', storeA.progress), true);
  assert.equal(storeA.progress.claimedMailIds.includes('legacy-mail-01'), true);

  // Claim a new mailbox gift containing skin + agent + xp + custom item
  const mail = {
    id: 'welcome-2026-launch',
    rewards: [
      { type: 'skin', skinId: 'karambit-sapphire' },
      { type: 'agent', agentId: 'ct-ava' },
      { type: 'xp', amount: 800 },
      { type: 'item', itemId: 'badge-pioneer-s1', title: 'S1 先锋干员纪念章', category: 'badge', quantity: 1, icon: 'S1' },
    ],
  };
  now += 2000;
  const claimRes = storeA.claimMail(mail);
  assert.equal(claimRes.ok, true);
  await new Promise((r) => setTimeout(r, 15));

  // Legacy v1 key must be cleaned up after v2 write succeeds!
  assert.equal(cloudMap.has(LEGACY_CLOUD_KEY_PROGRESS), false, 'legacy v1 key should be cleaned up after migration');
  assert.equal(cloudMap.has(LEGACY_CLOUD_KEY_LOADOUT), false, 'legacy v1 loadout key must never be written');

  // Equip granted knife & agent, and edit settings + 4-finger touch layout via preferences
  now += 3000;
  prefsA.setItem('dust2.skins.v1', JSON.stringify({ ...STARTER_SKINS, knife: 'karambit-sapphire', deagle: 'deagle-conspiracy' }));
  prefsA.setItem('dust2.agents.v1', JSON.stringify({ CT: 'ct-ava', T: 't-phoenix' }));
  storeA.noteLoadoutChanged();

  prefsA.setItem('dust2.cs-settings.v1', JSON.stringify({ sensitivity: 2.25, zoomSensitivity: 0.9, invertY: false, radarRotate: false, botDifficulty: 'hard' }));
  prefsA.setItem('dust2.music-kit', 'valve_cs2_01');
  prefsA.setItem('dust2.volume', '0.45');
  prefsA.setItem('dust2.mouse-dpi', '1600');
  prefsA.setItem('dust2.touch.v1', JSON.stringify({ mode: 'on', sensitivity: 1.35, zoomSensitivity: 0.8, size: 1.15 }));
  const bases = new Map(LAYOUT_IDS.map((id, i) => [id, { x: 0.12 + (i % 4) * 0.2, y: 0.2 + Math.floor(i / 4) * 0.14 }]));
  prefsA.setItem('dust2.touch-layout.v1', JSON.stringify(buildTouchPresetLayout('four-finger', bases, 844, 390)));

  now += 3000;
  const flushRes = await storeA.flushCloud({ force: true });
  assert.equal(flushRes.status, 'synced');
  assert.ok(flushRes.usage.withinLimits);
  assert.ok(flushRes.usage.keysUsed <= 15, `typical active player should use <= 15 keys, got ${flushRes.usage.keysUsed}`);

  // Subsequent flush with no edits is a delta no-op!
  const prevSetCalls = stats.setCalls;
  now += 3000;
  await storeA.flushCloud({ force: true });
  assert.equal(stats.setCalls, prevSetCalls, 'delta flush must skip setCloudStorage when nothing changed');

  // Device B (completely fresh empty browser) logs into the same Bilibili account and restores EVERYTHING!
  const rawB = memoryStorage();
  const prefsB = createPreferenceStore(rawB);
  const idB = new ToyIdentity({
    sdk,
    storage: rawB,
    window: { location: { href: 'https://www.bilibilitoy.com/toy/cs2/1.0/index.html' } },
    document: {},
  });
  const storeB = new ToyProgressStore({ identity: idB, storage: prefsB, now: () => now });
  await storeB.init();

  assert.equal(storeB.progress.kills, 50);
  assert.equal(storeB.progress.bonusXp, 800);
  assert.equal(isSkinUnlocked('karambit-sapphire', storeB.progress), true);
  assert.equal(isAgentUnlocked('ct-ava', storeB.progress), true);
  assert.equal(storeB.progress.claimedMailIds.includes('welcome-2026-launch'), true);
  assert.equal(storeB.progress.claimedMailIds.includes('legacy-mail-01'), true);
  assert.equal(storeB.progress.customItems['badge-pioneer-s1'].title, 'S1 先锋干员纪念章');
  assert.equal(prefsB.readJSON('dust2.skins.v1').knife, 'karambit-sapphire');
  assert.equal(prefsB.readJSON('dust2.skins.v1').deagle, 'deagle-conspiracy');
  assert.equal(prefsB.readJSON('dust2.agents.v1').CT, 'ct-ava');
  assert.equal(prefsB.readJSON('dust2.cs-settings.v1').sensitivity, 2.25);
  assert.equal(prefsB.getItem('dust2.music-kit'), 'valve_cs2_01');
  assert.equal(prefsB.getItem('dust2.mouse-dpi'), '1600');
  assert.equal(prefsB.readJSON('dust2.touch.v1').sensitivity, 1.35);
  assert.equal(prefsB.readJSON('dust2.touch-layout.v1').buttons.fireLeft.x, 0.16);

  // Clearing touch layout on Device B deletes obsolete cs2_cfg_tlay_* chunk keys cleanly
  now += 3000;
  prefsB.setItem('dust2.touch-layout.v1', JSON.stringify({ version: 1, buttons: {} }));
  now += 3000;
  const resetFlush = await storeB.flushCloud({ force: true });
  assert.equal(resetFlush.status, 'synced');
  assert.ok(stats.lastDeletedKeys.some((k) => k.startsWith('cs2_cfg_tlay_')));
  assert.equal(cloudMap.has('cs2_cfg_tlay_0'), false);

  // Verify diffToyCloudEntries ignores non-CS2 third-party keys untouched
  const diff = diffToyCloudEntries({ cs2_core: '{}', cs2_ci_0: '[]', other_key: 'keep' }, { cs2_core: '{}' });
  assert.deepEqual(diff.toDelete, ['cs2_ci_0']);
});
