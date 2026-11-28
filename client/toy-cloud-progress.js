/**
 * Toy Cloud Storage v2 + local account-scoped progression, loadout, mailbox & settings manager.
 *
 * Strictly follows official Bilibili Toy SDK limits (https://www.bilibili.com/toy/publish/sdk):
 * - Per-user per-Toy hard limit: <= 128 keys, each key /^[a-zA-Z0-9_-]{1,128}$/ (no "__" prefix),
 *   each value <= 1024 UTF-8 bytes (total theoretical quota 128 KiB).
 * - Automatically shards progress, weapon mastery, mailbox read/claimed/granted/customItems,
 *   equipped loadout (non-starter skin diffs), and player settings/controls/touch-layout
 *   across `cs2_*` keys via `shared/toy-cloud-codec.js` so NO value ever exceeds 1024 bytes.
 * - Losslessly reads & migrates legacy v1 keys (`cs_prog_v1`, `cs_loadout_v1`).
 * - Strictly follows Content Checklist §7:
 *   - Zero per-kill network spam and zero setInterval polling
 *   - Batch delta writes ONLY at key lifecycle boundaries (round end, match end, social unlock,
 *     mail claim/read, debounced loadout/settings change, pagehide, or manual sync)
 *   - Exponential backoff on 307044 rate-limit errors with clear status feedback
 *   - Monotone merge prevents progress/mail/reward loss across devices or offline sessions
 */
import { preferences } from './persistence.js';
import { ToyIdentity, getStoredOperatorUid } from '../scripts/maps/mode-ui/toy-identity.js';
import {
  createEmptyProgress,
  normalizeProgress,
  mergeProgress,
  enforceUnlockedSkinLoadout,
  enforceUnlockedAgentLoadout,
  diffNewUnlocks,
  computeCareerLevel,
  countUnlockedSummary,
  hasUnclaimedSocialGifts,
} from '../shared/progression.js';
import { applyRewardsToProgress, mailHasClaimableRewards } from '../shared/rewards.js';
import { normalizeWeaponLoadout } from '../shared/weapon-loadout.js';
import {
  LEGACY_CLOUD_KEY_PROGRESS,
  LEGACY_CLOUD_KEY_LOADOUT,
  SYNCED_SETTING_KEYS,
  encodeToyCloudSnapshot,
  decodeToyCloudSnapshot,
  diffToyCloudEntries,
  measureToyCloudUsage,
  readLocalSettingsSnapshot,
  applySettingsSnapshotToStorage,
} from '../shared/toy-cloud-codec.js';

export const CLOUD_KEY_PROGRESS = LEGACY_CLOUD_KEY_PROGRESS;
export const CLOUD_KEY_LOADOUT = LEGACY_CLOUD_KEY_LOADOUT;
export const CLOUD_KEY_CORE = 'cs2_core';
export const CLOUD_KEY_LOADOUT_META = 'cs2_lo_meta';

const LOCAL_PROG_PREFIX = 'cs.progression.v1.';
const LOCAL_SETTINGS_TS_KEY = 'cs.settings.updatedAt.v1';
const LOCAL_LOADOUT_TS_KEY = 'cs.loadout.updatedAt.v1';
const SKINS_STORAGE_KEY = 'dust2.skins.v1';
const AGENTS_STORAGE_KEY = 'dust2.agents.v1';
const WEAPONS_STORAGE_KEY = 'dust2.weapon-loadout.v1';
const SYNCED_SETTING_SET = new Set(SYNCED_SETTING_KEYS);

export function isToyRateLimitError(error) {
  return Boolean(error && typeof error === 'object' && (error.code === 307044 || (error.type === 'http_error' && Number(error.code) === 307044)));
}

function localProgKey(uid) {
  const clean = String(uid || 'guest').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return LOCAL_PROG_PREFIX + clean;
}

export class ToyProgressStore extends EventTarget {
  constructor({
    identity = null,
    storage = preferences,
    now = () => Date.now(),
    baseBackoffMs = 4000,
    maxBackoffMs = 60000,
    minSyncIntervalMs = 5000,
  } = {}) {
    super();
    this.identity = identity || new ToyIdentity();
    this.storage = storage;
    this._now = now;
    this._baseBackoffMs = baseBackoffMs;
    this._maxBackoffMs = maxBackoffMs;
    this._minSyncIntervalMs = minSyncIntervalMs;

    this._uid = this.identity.uid || getStoredOperatorUid();
    this._progress = this._readLocalProgress(this._uid);
    this._loadoutUpdatedAt = Math.max(0, Number(this.storage?.getItem?.(LOCAL_LOADOUT_TS_KEY)) || 0);
    this._settingsUpdatedAt = Math.max(0, Number(this.storage?.getItem?.(LOCAL_SETTINGS_TS_KEY)) || 0);
    this._lastCloudSnapshot = null;
    this._hydratingFromCloud = false;
    this._dirty = false;
    this._lastFlushAt = 0;
    this._cooldownUntil = 0;
    this._consecutiveRateLimits = 0;
    this._debounceTimer = null;
    this._cloudState = {
      status: this.identity.isToy ? 'idle' : 'local',
      message: this.identity.isToy ? '等待连接 Toy 云存档' : '本地存档模式（B站 Toy 内自动开启云存档）',
      lastSyncedAt: 0,
    };
    this._initPromise = null;

    // Immediately enforce unlocked starter loadout in local preference keys so new accounts start vanilla!
    this._enforceStoredLoadouts();

    // Automatically track setting/control/touch-layout edits written through preferences.setItem
    if (typeof this.storage?.subscribe === 'function') {
      this._unsubscribePrefs = this.storage.subscribe((key) => {
        if (this._hydratingFromCloud) return;
        if (SYNCED_SETTING_SET.has(key)) {
          this.noteSettingsChanged();
        }
      });
    }

    this.identity.addEventListener('change', () => {
      const nextUid = this.identity.uid;
      if (nextUid && nextUid !== this._uid) {
        this._switchAccount(nextUid);
      }
      if (this.identity.state.authenticated && this._cloudState.status === 'idle') {
        void this.loadFromCloud();
      }
      this.dispatchEvent(new Event('change'));
    });

    if (typeof globalThis.window?.addEventListener === 'function') {
      globalThis.window.addEventListener('pagehide', () => {
        if (this._dirty) void this.flushCloud({ force: true });
      });
    }
  }

  get uid() { return this._uid; }
  get progress() { return this._progress; }
  get cloudState() { return this._cloudState; }
  get isToy() { return this.identity.isToy; }
  get career() { return computeCareerLevel(this._progress); }
  get summary() { return countUnlockedSummary(this._progress); }
  get hasUnclaimedSocialGifts() { return hasUnclaimedSocialGifts(this._progress); }
  get cooldownRemainingMs() { return Math.max(0, this._cooldownUntil - this._now()); }

  _emitWindowSync() {
    if (typeof globalThis.window?.dispatchEvent === 'function') {
      globalThis.window.dispatchEvent(new CustomEvent('cs2-progression-synced', { detail: { progress: this._progress } }));
    }
  }

  _emitSettingsSync(settings) {
    if (typeof globalThis.window?.dispatchEvent === 'function') {
      globalThis.window.dispatchEvent(new CustomEvent('cs2-settings-synced', { detail: { settings } }));
    }
  }

  _readLocalProgress(uid) {
    try {
      const raw = this.storage.readJSON(localProgKey(uid), null);
      if (raw) return normalizeProgress(raw, uid);
    } catch {}
    return createEmptyProgress(uid);
  }

  _writeLocalProgress() {
    try {
      this.storage.setItem(localProgKey(this._uid), JSON.stringify(this._progress));
    } catch {}
  }

  _switchAccount(nextUid) {
    this._uid = nextUid;
    this._lastCloudSnapshot = null;
    this._progress = this._readLocalProgress(nextUid);
    this._enforceStoredLoadouts();
    this.dispatchEvent(new Event('change'));
    this._emitWindowSync();
  }

  _enforceStoredLoadouts() {
    this._hydratingFromCloud = true;
    try {
      const rawSkins = this.storage.readJSON(SKINS_STORAGE_KEY, {});
      const safeSkins = enforceUnlockedSkinLoadout(rawSkins, this._progress);
      const skinsChanged = Object.keys(safeSkins).some((w) => rawSkins[w] !== safeSkins[w]) || Object.keys(rawSkins).length === 0;
      if (skinsChanged) {
        try { this.storage.setItem(SKINS_STORAGE_KEY, JSON.stringify(safeSkins)); } catch {}
      }

      const rawAgents = this.storage.readJSON(AGENTS_STORAGE_KEY, {});
      const safeAgents = enforceUnlockedAgentLoadout(rawAgents, this._progress);
      const agentsChanged = Object.keys(safeAgents).some((t) => rawAgents[t] !== safeAgents[t]) || Object.keys(rawAgents).length === 0;
      if (agentsChanged) {
        try { this.storage.setItem(AGENTS_STORAGE_KEY, JSON.stringify(safeAgents)); } catch {}
      }

      return { skins: safeSkins, agents: safeAgents };
    } finally {
      this._hydratingFromCloud = false;
    }
  }

  getEnforcedSkinLoadout() {
    return enforceUnlockedSkinLoadout(this.storage.readJSON(SKINS_STORAGE_KEY, {}), this._progress);
  }

  getEnforcedAgentLoadout() {
    return enforceUnlockedAgentLoadout(this.storage.readJSON(AGENTS_STORAGE_KEY, {}), this._progress);
  }

  /** Build the current Toy-compliant sharded cloud map (guaranteed <= 128 keys, <= 1024 B/key). */
  _buildCloudPayload() {
    const loadout = {
      skins: this.getEnforcedSkinLoadout(),
      agents: this.getEnforcedAgentLoadout(),
      weapons: normalizeWeaponLoadout(this.storage.readJSON(WEAPONS_STORAGE_KEY, {})),
      updatedAt: this._loadoutUpdatedAt || this._now(),
    };
    const settings = readLocalSettingsSnapshot(this.storage, this._settingsUpdatedAt || this._now());
    return encodeToyCloudSnapshot({
      progress: this._progress,
      loadout,
      settings,
    });
  }

  /** Inspect exact Toy Cloud Storage quota usage (keys / 128, bytes / 128 KiB, max value bytes / 1024 B). */
  getCloudUsage() {
    return measureToyCloudUsage(this._buildCloudPayload());
  }

  _setCloudState(status, message, extra = {}) {
    this._cloudState = Object.freeze({ ...this._cloudState, status, message, ...extra });
    this.dispatchEvent(new Event('change'));
  }

  async init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
      await this.identity.init();
      if (this.identity.uid && this.identity.uid !== this._uid) {
        this._switchAccount(this.identity.uid);
      }
      if (this.identity.isToy && this.identity.state.authenticated) {
        await this.loadFromCloud();
      }
      return this._progress;
    })();
    return this._initPromise;
  }

  async loadFromCloud() {
    if (!this.identity.isToy) return { status: 'local', progress: this._progress };
    try {
      const sdk = await this.identity.ensureSdk();
      if (!sdk?.getCloudStorage) {
        this._setCloudState('unsupported', '当前容器不支持 Toy 云存档，已启用本地存档');
        return { status: 'unsupported', progress: this._progress };
      }
      this._setCloudState('syncing', '正在同步 Toy 云存档…');
      // Per official Toy SDK docs, calling getCloudStorage() with no args fetches ALL user keys in 1 request.
      const data = (await sdk.getCloudStorage()) || {};
      this._lastCloudSnapshot = { ...data };
      const before = this._progress;
      const decoded = decodeToyCloudSnapshot(data, this._uid);

      if (decoded.progress) {
        this._progress = mergeProgress(this._progress, decoded.progress, this._uid);
        this._writeLocalProgress();
      }

      if (decoded.loadout) {
        const remoteTs = Number(decoded.loadout.updatedAt) || 0;
        if (remoteTs >= this._loadoutUpdatedAt) {
          this._hydratingFromCloud = true;
          try {
            if (decoded.loadout.skins) {
              const safeSkins = enforceUnlockedSkinLoadout(decoded.loadout.skins, this._progress);
              this.storage.setItem(SKINS_STORAGE_KEY, JSON.stringify(safeSkins));
            }
            if (decoded.loadout.agents) {
              const safeAgents = enforceUnlockedAgentLoadout(decoded.loadout.agents, this._progress);
              this.storage.setItem(AGENTS_STORAGE_KEY, JSON.stringify(safeAgents));
            }
            if (decoded.loadout.weapons) {
              const safeWeapons = normalizeWeaponLoadout(decoded.loadout.weapons);
              this.storage.setItem(WEAPONS_STORAGE_KEY, JSON.stringify(safeWeapons));
            }
            this._loadoutUpdatedAt = remoteTs;
            this.storage.setItem(LOCAL_LOADOUT_TS_KEY, String(remoteTs));
          } catch {} finally {
            this._hydratingFromCloud = false;
          }
        }
      }

      if (decoded.settings) {
        const remoteSettingsTs = Number(decoded.settings.updatedAt) || 0;
        if (remoteSettingsTs > this._settingsUpdatedAt || this._settingsUpdatedAt === 0) {
          this._hydratingFromCloud = true;
          try {
            applySettingsSnapshotToStorage(this.storage, decoded.settings);
            this._settingsUpdatedAt = remoteSettingsTs || this._now();
            this.storage.setItem(LOCAL_SETTINGS_TS_KEY, String(this._settingsUpdatedAt));
          } finally {
            this._hydratingFromCloud = false;
          }
          this._emitSettingsSync(decoded.settings);
        }
      }

      if (decoded.hasLegacyKeys) {
        this._dirty = true;
      }

      this._enforceStoredLoadouts();
      const unlocked = diffNewUnlocks(before, this._progress);
      this._setCloudState('synced', 'Toy 云存档已同步', { lastSyncedAt: this._now() });
      if (unlocked.skins.length || unlocked.agents.length) {
        this.dispatchEvent(new CustomEvent('unlock', { detail: unlocked }));
      }
      this._emitWindowSync();
      return { status: 'synced', progress: this._progress, settings: decoded.settings || null };
    } catch (error) {
      if (isToyRateLimitError(error)) {
        this._enterRateLimitBackoff();
        return { status: 'rate-limited', progress: this._progress };
      }
      this._setCloudState('error', '云存档读取失败，已使用本地存档');
      return { status: 'error', progress: this._progress };
    }
  }

  _enterRateLimitBackoff() {
    const delay = Math.min(this._maxBackoffMs, this._baseBackoffMs * 2 ** this._consecutiveRateLimits);
    this._consecutiveRateLimits++;
    this._cooldownUntil = this._now() + delay;
    this._setCloudState('rate-limited', '云存档同步冷却中（307044），稍后自动重试');
    return delay;
  }

  /** Batch delta-write sharded progress + loadout + mailbox + settings to Toy Cloud Storage. */
  async flushCloud({ force = false } = {}) {
    if (!this.identity.isToy) {
      this._dirty = false;
      return { status: 'local' };
    }
    if (!force && !this._dirty) return { status: 'skipped-clean' };
    const remaining = this.cooldownRemainingMs;
    if (remaining > 0) {
      return { status: 'skipped-cooldown', retryAfterMs: remaining };
    }
    const elapsed = this._now() - this._lastFlushAt;
    if (!force && this._lastFlushAt > 0 && elapsed < this._minSyncIntervalMs) {
      return { status: 'skipped-throttle', retryAfterMs: this._minSyncIntervalMs - elapsed };
    }

    try {
      const sdk = await this.identity.ensureSdk();
      if (!sdk?.setCloudStorage) return { status: 'unsupported' };
      const ts = this._now();
      if (!this._loadoutUpdatedAt) this._loadoutUpdatedAt = ts;
      const nextEntries = this._buildCloudPayload();
      const { toWrite, toDelete } = diffToyCloudEntries(this._lastCloudSnapshot, nextEntries);

      if (Object.keys(toWrite).length > 0) {
        await sdk.setCloudStorage(toWrite);
      }
      // Clean up shrunk chunks & migrated legacy v1 keys ONLY after v2 writes succeed!
      if (toDelete.length > 0 && typeof sdk.removeCloudStorage === 'function') {
        try {
          await sdk.removeCloudStorage(toDelete);
        } catch {
          // Non-fatal: new v2 keys are already safely persisted; stale keys can be cleaned next sync.
        }
      }

      this._lastCloudSnapshot = { ...nextEntries };
      this._dirty = false;
      this._lastFlushAt = ts;
      this._consecutiveRateLimits = 0;
      this._cooldownUntil = 0;
      const usage = measureToyCloudUsage(nextEntries);
      this._setCloudState('synced', 'Toy 云存档已保存', { lastSyncedAt: ts, usage });
      return { status: 'synced', writtenKeys: Object.keys(toWrite).length, deletedKeys: toDelete.length, usage };
    } catch (error) {
      if (isToyRateLimitError(error)) {
        const retryAfterMs = this._enterRateLimitBackoff();
        return { status: 'rate-limited', retryAfterMs };
      }
      this._setCloudState('error', '云存档同步失败，进度已安全保存在本地');
      return { status: 'error', message: error?.message || 'sync failed' };
    }
  }

  _scheduleDebouncedFlush() {
    this._dirty = true;
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      void this.flushCloud({ force: false });
    }, 2200);
  }

  _applyProgressMutation(mutator, { flush = false, forceFlush = false } = {}) {
    const before = this._progress;
    const draft = normalizeProgress(before, this._uid);
    mutator(draft);
    draft.updatedAt = this._now();
    this._progress = draft;
    this._writeLocalProgress();
    this._dirty = true;
    const unlocked = diffNewUnlocks(before, this._progress);
    this.dispatchEvent(new Event('change'));
    if (unlocked.skins.length || unlocked.agents.length) {
      this.dispatchEvent(new CustomEvent('unlock', { detail: unlocked }));
    }
    this._emitWindowSync();
    if (flush) void this.flushCloud({ force: forceFlush });
    return unlocked;
  }

  /** Mark a mailbox announcement/reward mail as read. */
  markMailRead(mailId) {
    const clean = typeof mailId === 'string' ? mailId.trim() : '';
    if (!clean || !/^[a-zA-Z0-9_.:-]{1,64}$/.test(clean)) return false;
    if (this._progress.readMailIds.includes(clean)) return false;
    this._applyProgressMutation((p) => {
      if (!p.readMailIds.includes(clean)) p.readMailIds.push(clean);
    }, { flush: true, forceFlush: false });
    return true;
  }

  /** Claim abstract rewards attached to a single mail (idempotent & cloud-synced). */
  claimMail(mail) {
    if (!mail?.id || !/^[a-zA-Z0-9_.:-]{1,64}$/.test(String(mail.id))) {
      return { ok: false, alreadyClaimed: false, summary: null, unlocked: { skins: [], agents: [] } };
    }
    if (!mailHasClaimableRewards(mail, this._progress)) {
      this.markMailRead(mail.id);
      return { ok: false, alreadyClaimed: true, summary: null, unlocked: { skins: [], agents: [] } };
    }
    let summary = null;
    const unlocked = this._applyProgressMutation((p) => {
      summary = applyRewardsToProgress(p, mail.rewards, this._now());
      if (!p.claimedMailIds.includes(mail.id)) p.claimedMailIds.push(mail.id);
      if (!p.readMailIds.includes(mail.id)) p.readMailIds.push(mail.id);
    }, { flush: true, forceFlush: true });
    return { ok: true, alreadyClaimed: false, summary, unlocked };
  }

  /** Claim all unclaimed reward mails in one atomic save + cloud sync. */
  claimAllMails(mails) {
    const claimable = (Array.isArray(mails) ? mails : []).filter((m) => mailHasClaimableRewards(m, this._progress));
    if (!claimable.length) {
      return { ok: false, count: 0, summary: null, unlocked: { skins: [], agents: [] } };
    }
    const aggregated = { skins: [], agents: [], xp: 0, items: [], duplicates: [] };
    const unlocked = this._applyProgressMutation((p) => {
      const ts = this._now();
      for (const mail of claimable) {
        const res = applyRewardsToProgress(p, mail.rewards, ts);
        aggregated.skins.push(...res.skins);
        aggregated.agents.push(...res.agents);
        aggregated.xp += res.xp;
        aggregated.items.push(...res.items);
        aggregated.duplicates.push(...res.duplicates);
        if (!p.claimedMailIds.includes(mail.id)) p.claimedMailIds.push(mail.id);
        if (!p.readMailIds.includes(mail.id)) p.readMailIds.push(mail.id);
      }
    }, { flush: true, forceFlush: true });
    return { ok: true, count: claimable.length, summary: aggregated, unlocked };
  }

  /** Record a credited combat kill in memory + local cache (NEVER calls cloud API directly!). */
  recordKill({ weapon = null, headshot = false } = {}) {
    return this._applyProgressMutation((p) => {
      p.kills++;
      if (headshot) p.headshots++;
      if (weapon && Object.hasOwn(p.weaponKills, weapon)) {
        p.weaponKills[weapon]++;
      } else if (weapon) {
        p.weaponKills[weapon] = 1;
      }
    }, { flush: false });
  }

  /** Record completed round and opportunistically batch-sync to Toy Cloud Storage. */
  recordRoundComplete() {
    return this._applyProgressMutation((p) => {
      p.rounds++;
    }, { flush: true, forceFlush: false });
  }

  /** Record completed match and immediately batch-sync to Toy Cloud Storage. */
  recordMatchComplete({ won = false } = {}) {
    return this._applyProgressMutation((p) => {
      p.matches++;
      if (won) p.wins++;
    }, { flush: true, forceFlush: true });
  }

  /** Record a skin/agent/weapon loadout save and schedule a debounced batch cloud sync. */
  noteLoadoutChanged() {
    this._loadoutUpdatedAt = this._now();
    try { this.storage.setItem(LOCAL_LOADOUT_TS_KEY, String(this._loadoutUpdatedAt)); } catch {}
    this._scheduleDebouncedFlush();
    this.dispatchEvent(new Event('change'));
  }

  /** Record a settings / keybind / mobile touch layout save and schedule a debounced batch cloud sync. */
  noteSettingsChanged() {
    this._settingsUpdatedAt = this._now();
    this._hydratingFromCloud = true;
    try { this.storage.setItem(LOCAL_SETTINGS_TS_KEY, String(this._settingsUpdatedAt)); } catch {} finally {
      this._hydratingFromCloud = false;
    }
    this._scheduleDebouncedFlush();
    this.dispatchEvent(new Event('change'));
  }

  /** Verify Bilibili Toy Follow (关注 UP 主), unlock follow rewards, and flush to cloud. */
  async verifyToyFollow() {
    const result = await this.identity.checkAuthorFollow();
    if (result.followed) {
      const unlocked = this._applyProgressMutation((p) => {
        p.social.followed = true;
        p.social.checkedAt = this._now();
      }, { flush: true, forceFlush: true });
      return { ...result, unlocked };
    }
    return { ...result, unlocked: { skins: [], agents: [] } };
  }

  /** Verify Bilibili Toy Triple (一键三连), unlock triple rewards, and flush to cloud. */
  async verifyToyTriple(options = {}) {
    const result = await this.identity.checkAuthorTriple(options);
    if (result.ok || result.liked || result.coined || result.favorited || result.tripled) {
      const unlocked = this._applyProgressMutation((p) => {
        p.social.liked = p.social.liked || Boolean(result.liked || result.tripled);
        p.social.coined = p.social.coined || Boolean(result.coined || result.tripled);
        p.social.favorited = p.social.favorited || Boolean(result.favorited || result.tripled);
        p.social.tripled = p.social.tripled || Boolean(result.tripled || (p.social.liked && p.social.coined && p.social.favorited));
        p.social.checkedAt = this._now();
      }, { flush: Boolean(result.tripled), forceFlush: Boolean(result.tripled) });
      return { ...result, unlocked };
    }
    return { ...result, unlocked: { skins: [], agents: [] } };
  }
}

let sharedStore = null;
export function getSharedToyProgress(identity = null) {
  if (!sharedStore) {
    sharedStore = new ToyProgressStore({ identity: identity || undefined });
  }
  return sharedStore;
}
