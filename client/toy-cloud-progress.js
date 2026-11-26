/**
 * Toy Cloud Storage + local account-scoped progression & loadout manager.
 *
 * Strictly follows Bilibili Toy SDK Content Checklist §7:
 * - Cloud keys match /^[a-zA-Z0-9_-]{1,128}$/: cs_prog_v1, cs_loadout_v1
 * - Zero per-kill network spam and zero setInterval polling
 * - Batch writes ONLY at key lifecycle boundaries (round end, match end, social unlock,
 *   debounced loadout equip, pagehide, or manual sync)
 * - Exponential backoff on 307044 rate-limit errors with clear status feedback
 * - Monotone merge prevents progress loss across devices or offline sessions
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
} from '../shared/progression.js';
import { normalizeWeaponLoadout } from '../shared/weapon-loadout.js';

export const CLOUD_KEY_PROGRESS = 'cs_prog_v1';
export const CLOUD_KEY_LOADOUT = 'cs_loadout_v1';

const LOCAL_PROG_PREFIX = 'cs.progression.v1.';
const SKINS_STORAGE_KEY = 'dust2.skins.v1';
const AGENTS_STORAGE_KEY = 'dust2.agents.v1';
const WEAPONS_STORAGE_KEY = 'dust2.weapon-loadout.v1';

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
    this._loadoutUpdatedAt = 0;
    this._dirty = false;
    this._lastFlushAt = 0;
    this._cooldownUntil = 0;
    this._consecutiveRateLimits = 0;
    this._equipTimer = null;
    this._cloudState = {
      status: this.identity.isToy ? 'idle' : 'local',
      message: this.identity.isToy ? '等待连接 Toy 云存档' : '本地存档模式（B站 Toy 内自动开启云存档）',
      lastSyncedAt: 0,
    };
    this._initPromise = null;

    // Immediately enforce unlocked starter loadout in local preference keys so new accounts start vanilla!
    this._enforceStoredLoadouts();

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
  get cooldownRemainingMs() { return Math.max(0, this._cooldownUntil - this._now()); }

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
    this._progress = this._readLocalProgress(nextUid);
    this._enforceStoredLoadouts();
    this.dispatchEvent(new Event('change'));
  }

  _enforceStoredLoadouts() {
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
  }

  getEnforcedSkinLoadout() {
    return enforceUnlockedSkinLoadout(this.storage.readJSON(SKINS_STORAGE_KEY, {}), this._progress);
  }

  getEnforcedAgentLoadout() {
    return enforceUnlockedAgentLoadout(this.storage.readJSON(AGENTS_STORAGE_KEY, {}), this._progress);
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
      const data = await sdk.getCloudStorage([CLOUD_KEY_PROGRESS, CLOUD_KEY_LOADOUT]);
      const before = this._progress;

      if (data?.[CLOUD_KEY_PROGRESS]) {
        try {
          const parsedRemote = JSON.parse(data[CLOUD_KEY_PROGRESS]);
          this._progress = mergeProgress(this._progress, parsedRemote, this._uid);
          this._writeLocalProgress();
        } catch {}
      }

      if (data?.[CLOUD_KEY_LOADOUT]) {
        try {
          const remoteLoadout = JSON.parse(data[CLOUD_KEY_LOADOUT]);
          const remoteTs = Number(remoteLoadout?.updatedAt) || 0;
          if (remoteTs >= this._loadoutUpdatedAt) {
            if (remoteLoadout.skins) {
              const safeSkins = enforceUnlockedSkinLoadout(remoteLoadout.skins, this._progress);
              this.storage.setItem(SKINS_STORAGE_KEY, JSON.stringify(safeSkins));
            }
            if (remoteLoadout.agents) {
              const safeAgents = enforceUnlockedAgentLoadout(remoteLoadout.agents, this._progress);
              this.storage.setItem(AGENTS_STORAGE_KEY, JSON.stringify(safeAgents));
            }
            if (remoteLoadout.weapons) {
              const safeWeapons = normalizeWeaponLoadout(remoteLoadout.weapons);
              this.storage.setItem(WEAPONS_STORAGE_KEY, JSON.stringify(safeWeapons));
            }
            this._loadoutUpdatedAt = remoteTs;
          }
        } catch {}
      }

      this._enforceStoredLoadouts();
      const unlocked = diffNewUnlocks(before, this._progress);
      this._setCloudState('synced', 'Toy 云存档已同步', { lastSyncedAt: this._now() });
      if (unlocked.skins.length || unlocked.agents.length) {
        this.dispatchEvent(new CustomEvent('unlock', { detail: unlocked }));
      }
      if (typeof globalThis.window?.dispatchEvent === 'function') {
        globalThis.window.dispatchEvent(new CustomEvent('cs2-progression-synced', { detail: { progress: this._progress } }));
      }
      return { status: 'synced', progress: this._progress };
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

  /** Batch-write progress + equipped loadout to Toy Cloud Storage (respects cooldown & 307044 backoff). */
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
      const loadoutPayload = {
        v: 1,
        skins: this.getEnforcedSkinLoadout(),
        agents: this.getEnforcedAgentLoadout(),
        weapons: normalizeWeaponLoadout(this.storage.readJSON(WEAPONS_STORAGE_KEY, {})),
        updatedAt: Math.max(this._loadoutUpdatedAt, this._now()),
      };
      this._loadoutUpdatedAt = loadoutPayload.updatedAt;
      await sdk.setCloudStorage({
        [CLOUD_KEY_PROGRESS]: JSON.stringify(this._progress),
        [CLOUD_KEY_LOADOUT]: JSON.stringify(loadoutPayload),
      });
      this._dirty = false;
      this._lastFlushAt = this._now();
      this._consecutiveRateLimits = 0;
      this._cooldownUntil = 0;
      this._setCloudState('synced', 'Toy 云存档已保存', { lastSyncedAt: this._lastFlushAt });
      return { status: 'synced' };
    } catch (error) {
      if (isToyRateLimitError(error)) {
        const retryAfterMs = this._enterRateLimitBackoff();
        return { status: 'rate-limited', retryAfterMs };
      }
      this._setCloudState('error', '云存档同步失败，进度已安全保存在本地');
      return { status: 'error', message: error?.message || 'sync failed' };
    }
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
    if (flush) void this.flushCloud({ force: forceFlush });
    return unlocked;
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
    this._dirty = true;
    if (this._equipTimer) clearTimeout(this._equipTimer);
    this._equipTimer = setTimeout(() => {
      this._equipTimer = null;
      void this.flushCloud({ force: false });
    }, 2200);
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
