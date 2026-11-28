import test from 'node:test';
import assert from 'node:assert/strict';
import { SKINS } from '../shared/skins.js';
import { AGENT_CATALOG } from '../shared/agents.js';
import {
  STARTER_SKINS,
  STARTER_KNIFE_IDS,
  STARTER_AGENTS,
  TOY_FOLLOW_SKIN_IDS,
  TOY_FOLLOW_AGENT_IDS,
  TOY_TRIPLE_SKIN_IDS,
  TOY_TRIPLE_AGENT_IDS,
  createEmptyProgress,
  isSkinUnlocked,
  isAgentUnlocked,
  enforceUnlockedSkinLoadout,
  enforceUnlockedAgentLoadout,
  mergeProgress,
  computeCareerLevel,
  diffNewUnlocks,
  getSkinUnlockRequirement,
  getAgentUnlockRequirement,
} from '../shared/progression.js';
import { ToyIdentity } from '../scripts/maps/mode-ui/toy-identity.js';
import { ToyProgressStore, CLOUD_KEY_PROGRESS, CLOUD_KEY_LOADOUT, CLOUD_KEY_CORE, CLOUD_KEY_LOADOUT_META } from '../client/toy-cloud-progress.js';
import { TOY_CLOUD_MAX_KEYS, TOY_CLOUD_MAX_VALUE_BYTES, TOY_CLOUD_KEY_REGEX, utf8ByteLength } from '../shared/toy-cloud-codec.js';
import { createPreferenceStore } from '../client/persistence.js';

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

test('fresh player starts ONLY with stock vanilla guns, basic CT/T knives, and default agents', () => {
  const fresh = createEmptyProgress('toy_fresh_01');
  for (const skin of SKINS) {
    const unlocked = isSkinUnlocked(skin.id, fresh);
    const expectedStarter =
      (skin.weapon !== 'knife' && skin.condition === 'Vanilla') ||
      STARTER_KNIFE_IDS.includes(skin.id);
    assert.equal(unlocked, expectedStarter, `skin ${skin.id} starter state mismatch`);
  }
  for (const agent of AGENT_CATALOG) {
    assert.equal(isAgentUnlocked(agent.id, fresh), agent.isDefault, `agent ${agent.id} starter state mismatch`);
  }
  // Attempting to equip locked prestige skins or exotic knives falls back strictly to vanilla starters!
  const enforcedSkins = enforceUnlockedSkinLoadout(
    { ak47: 'ak47-vulcan', awp: 'awp-dragon-lore', knife: 'karambit-sapphire', m4a4: 'm4a4-howl' },
    fresh,
  );
  assert.equal(enforcedSkins.ak47, 'ak47-vanilla');
  assert.equal(enforcedSkins.awp, 'awp-vanilla');
  assert.equal(enforcedSkins.knife, 'default-ct-vanilla');
  assert.equal(enforcedSkins.m4a4, 'm4a4-vanilla');
  assert.deepEqual(enforcedSkins, STARTER_SKINS);

  const enforcedAgents = enforceUnlockedAgentLoadout({ CT: 'ct-ava', T: 't-miami' }, fresh);
  assert.deepEqual(enforcedAgents, STARTER_AGENTS);
});

test('every skin and agent has a valid unlock rule covering starter, growth, toy_follow, and toy_triple', () => {
  const skinTypes = new Set();
  for (const skin of SKINS) {
    const req = getSkinUnlockRequirement(skin.id);
    assert.ok(req, `missing requirement for ${skin.id}`);
    skinTypes.add(req.type);
  }
  assert.deepEqual([...skinTypes].sort(), ['growth', 'starter', 'toy_follow', 'toy_triple']);

  const agentTypes = new Set();
  for (const agent of AGENT_CATALOG) {
    const req = getAgentUnlockRequirement(agent.id);
    assert.ok(req, `missing requirement for ${agent.id}`);
    agentTypes.add(req.type);
  }
  assert.deepEqual([...agentTypes].sort(), ['growth', 'starter', 'toy_follow', 'toy_triple']);
});

test('combat kills and completed matches gradually unlock growth skins, knives, and agents without single-match floods', () => {
  const p0 = createEmptyProgress('toy_grow_1');
  assert.equal(isSkinUnlocked('ak47-slate-1035', p0), false);
  assert.equal(isAgentUnlocked('ct-operator', p0), false);

  // One strong match (20 AK-47 kills + 1 match) must NOT flood dozens of untouched weapons!
  const pOneMatch = { ...p0, kills: 20, matches: 1, rounds: 16, weaponKills: { ak47: 20 } };
  const oneMatchDiff = diffNewUnlocks(p0, pOneMatch);
  assert.equal(isSkinUnlocked('ak47-slate-1035', pOneMatch), true);
  assert.equal(isSkinUnlocked('m4a4-tooth-fairy-971', pOneMatch), false, 'AK kills must not unlock M4A4 skins');
  assert.equal(isSkinUnlocked('mp9-food-chain-1037', pOneMatch), false, 'AK kills must not unlock untouched SMG skins');
  assert.equal(oneMatchDiff.skins.length, 1, 'a single 20-kill AK match should unlock only 1 AK skin, not dozens');
  assert.equal(oneMatchDiff.agents.length, 0);

  // Early career (~60 kills, 3 matches) unlocks first knife & first growth agent cleanly
  const pEarly = { ...p0, kills: 60, matches: 3, rounds: 48, weaponKills: { ak47: 55, usp: 5 } };
  assert.equal(isSkinUnlocked('ak47-nightwish-1141', pEarly), true);
  assert.equal(isSkinUnlocked('navaja-vanilla', pEarly), true);
  assert.equal(isAgentUnlocked('ct-operator', pEarly), true);
  assert.equal(isSkinUnlocked('awp-dragon-lore', pEarly), false);
  assert.equal(isAgentUnlocked('t-silent-darryl', pEarly), false);

  // Veteran career unlocks chase skins, sapphire karambit, and all growth agents
  const pVet = {
    ...p0,
    kills: 2000,
    headshots: 650,
    matches: 80,
    rounds: 1200,
    wins: 45,
    weaponKills: { ak47: 450, awp: 500, m4a4: 360 },
  };
  assert.equal(isSkinUnlocked('awp-dragon-lore', pVet), true);
  assert.equal(isSkinUnlocked('karambit-sapphire', pVet), true);
  assert.equal(isAgentUnlocked('ct-syfers', pVet), true);
  assert.equal(isAgentUnlocked('t-silent-darryl', pVet), true);
  // Social-exclusive items still require follow/triple even at high kills
  assert.equal(isAgentUnlocked('ct-ava', pVet), false);
  assert.equal(isAgentUnlocked('t-miami', pVet), false);
  assert.equal(isSkinUnlocked('butterfly-vanilla', pVet), false);

  const diff = diffNewUnlocks(p0, pEarly);
  assert.ok(diff.skins.some((s) => s.id === 'ak47-slate-1035'));
  assert.ok(diff.agents.some((a) => a.id === 'ct-operator'));
  assert.ok(computeCareerLevel(pVet).level > computeCareerLevel(pEarly).level);
});

test('Toy SDK follow, triple, and cloud storage sync (with 307044 backoff & real 128x1024B limits) work end-to-end', async () => {
  assert.match(CLOUD_KEY_PROGRESS, TOY_CLOUD_KEY_REGEX);
  assert.match(CLOUD_KEY_LOADOUT, TOY_CLOUD_KEY_REGEX);
  assert.match(CLOUD_KEY_CORE, TOY_CLOUD_KEY_REGEX);
  assert.match(CLOUD_KEY_LOADOUT_META, TOY_CLOUD_KEY_REGEX);

  const cloud = new Map();
  let setCalls = 0;
  let rateLimitOnce = false;
  let followed = false;
  let videoAction = { aid: 10086, liked: true, coined: false, favorited: false };

  // Strict Bilibili Toy Cloud Storage mock enforcing real server-side limits (<=128 keys, <=1024 UTF-8 B/value)
  const sdk = {
    async isSupport() { return true; },
    async getUserProfile() {
      return { toyOpenId: 'toy_open_hero_01', nickname: '沙城狙神', avatar: 'https://i0.hdslb.com/hero.jpg' };
    },
    async getAuthorRelation() {
      return { status: 'ok', isFollowing: followed };
    },
    async getAuthorVideoRange() {
      return { status: 'ok', items: [{ aid: 10086, bvid: 'BV17x411w7KC' }] };
    },
    async getVideoUserActions({ aids }) {
      assert.deepEqual(aids, [10086]);
      return { status: 'ok', items: [videoAction] };
    },
    async getCloudStorage(keys = []) {
      const out = {};
      if (!Array.isArray(keys) || keys.length === 0) {
        for (const [k, v] of cloud.entries()) out[k] = v;
        return out;
      }
      for (const k of keys) if (cloud.has(k)) out[k] = cloud.get(k);
      return out;
    },
    async setCloudStorage(entries) {
      setCalls++;
      if (rateLimitOnce) {
        rateLimitOnce = false;
        throw { type: 'http_error', code: 307044 };
      }
      const simulated = new Map(cloud);
      for (const [k, v] of Object.entries(entries)) {
        assert.match(k, TOY_CLOUD_KEY_REGEX, `invalid cloud key ${k}`);
        assert.equal(typeof v, 'string', `cloud value for ${k} must be string`);
        assert.ok(utf8ByteLength(v) <= TOY_CLOUD_MAX_VALUE_BYTES, `cloud value for ${k} (${utf8ByteLength(v)}B) exceeds 1024B limit`);
        simulated.set(k, v);
      }
      assert.ok(simulated.size <= TOY_CLOUD_MAX_KEYS, `cloud key count ${simulated.size} exceeds 128 limit`);
      for (const [k, v] of Object.entries(entries)) cloud.set(k, v);
    },
    async removeCloudStorage(keys) {
      for (const k of keys) cloud.delete(k);
    },
  };

  let now = 10000;
  const rawStorage = memoryStorage();
  const prefs = createPreferenceStore(rawStorage);
  const identity = new ToyIdentity({
    sdk,
    storage: rawStorage,
    window: { location: { href: 'https://www.bilibilitoy.com/toy/cs2/1.0/index.html' } },
    document: {},
  });
  const store = new ToyProgressStore({
    identity,
    storage: prefs,
    now: () => now,
    baseBackoffMs: 4000,
    minSyncIntervalMs: 3000,
  });

  await store.init();
  assert.equal(store.uid, 'toy_open_hero_01');
  assert.equal(store.identity.playerName, '沙城狙神');

  // Recording kills in combat MUST NOT spam Toy Cloud Storage!
  for (let i = 0; i < 20; i++) store.recordKill({ weapon: 'ak47', headshot: i < 4 });
  assert.equal(setCalls, 0);
  assert.equal(store.progress.kills, 20);
  assert.equal(store.progress.headshots, 4);
  assert.equal(store.progress.weaponKills.ak47, 20);
  assert.equal(isSkinUnlocked('ak47-slate-1035', store.progress), true);

  // Completing a match batches sharded v2 progress + loadout to Toy Cloud Storage (every value <= 1024 B)!
  store.recordMatchComplete({ won: true });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(setCalls, 1);
  assert.ok(cloud.has(CLOUD_KEY_CORE));
  assert.ok(cloud.has(CLOUD_KEY_LOADOUT_META));
  for (const [k, v] of cloud.entries()) {
    assert.ok(utf8ByteLength(v) <= TOY_CLOUD_MAX_VALUE_BYTES, `${k} exceeds 1024B`);
  }

  // Follow verification unlocks all TOY_FOLLOW_SKIN_IDS & TOY_FOLLOW_AGENT_IDS
  followed = true;
  now += 6000;
  const followRes = await store.verifyToyFollow();
  assert.equal(followRes.followed, true);
  for (const sid of TOY_FOLLOW_SKIN_IDS) assert.equal(isSkinUnlocked(sid, store.progress), true);
  for (const aid of TOY_FOLLOW_AGENT_IDS) assert.equal(isAgentUnlocked(aid, store.progress), true);

  // Partial triple check records liked=true without unlocking triple rewards yet
  now += 6000;
  const partialRes = await store.verifyToyTriple();
  assert.equal(partialRes.liked, true);
  assert.equal(partialRes.tripled, false);
  assert.equal(isAgentUnlocked('t-miami', store.progress), false);

  // Full triple unlocks all TOY_TRIPLE_SKIN_IDS & TOY_TRIPLE_AGENT_IDS
  videoAction = { aid: 10086, liked: true, coined: true, favorited: true };
  now += 6000;
  const tripleRes = await store.verifyToyTriple();
  assert.equal(tripleRes.tripled, true);
  for (const sid of TOY_TRIPLE_SKIN_IDS) assert.equal(isSkinUnlocked(sid, store.progress), true);
  for (const aid of TOY_TRIPLE_AGENT_IDS) assert.equal(isAgentUnlocked(aid, store.progress), true);

  // 307044 rate limit triggers exponential backoff and blocks spam during cooldown
  rateLimitOnce = true;
  now += 6000;
  store.recordKill({ weapon: 'awp' });
  const limited = await store.flushCloud({ force: true });
  assert.equal(limited.status, 'rate-limited');
  assert.equal(limited.retryAfterMs, 4000);
  const duringCooldown = await store.flushCloud({ force: true });
  assert.equal(duringCooldown.status, 'skipped-cooldown');

  // Monotone cloud merge on a fresh second device restores all kills, matches, follow & triple unlocks!
  now += 5000;
  await store.flushCloud({ force: true });
  const freshDeviceStorage = memoryStorage();
  const secondIdentity = new ToyIdentity({
    sdk,
    storage: freshDeviceStorage,
    window: { location: { href: 'https://www.bilibilitoy.com/toy/cs2/1.0/index.html' } },
    document: {},
  });
  const secondDevice = new ToyProgressStore({
    identity: secondIdentity,
    storage: createPreferenceStore(freshDeviceStorage),
    now: () => now,
  });
  await secondDevice.init();
  assert.equal(secondDevice.progress.kills, 21);
  assert.equal(secondDevice.progress.matches, 1);
  assert.equal(secondDevice.progress.social.followed, true);
  assert.equal(secondDevice.progress.social.tripled, true);
  assert.equal(isSkinUnlocked('butterfly-vanilla', secondDevice.progress), true);
  assert.equal(isAgentUnlocked('ct-ava', secondDevice.progress), true);

  // Verify mergeProgress never drops higher local counters
  const merged = mergeProgress({ kills: 20, matches: 3 }, { kills: 7, matches: 5, social: { followed: true } }, 'u1');
  assert.equal(merged.kills, 20);
  assert.equal(merged.matches, 5);
  assert.equal(merged.social.followed, true);
});
