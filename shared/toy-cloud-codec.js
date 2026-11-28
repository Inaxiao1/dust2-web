/**
 * Bilibili Toy Cloud Storage v2 Sharded Codec & Quota Guard.
 *
 * Official Bilibili Toy SDK hard limits (https://www.bilibili.com/toy/publish/sdk):
 *  - Scope: isolated per (logged-in Bilibili user + Toy), synced cross-device
 *  - Max keys per player per Toy: 128
 *  - Key syntax: /^[a-zA-Z0-9_-]{1,128}$/, MUST NOT start with "__" (platform reserved)
 *  - Max value size per key: 1024 UTF-8 bytes (server rejects anything > 1024 bytes!)
 *  - Total theoretical quota per player: 128 * 1024 = 131,072 bytes (128 KiB)
 *
 * Slot budget (74 max allocated keys + 54 keys reserved for future expansion = 128):
 *  - cs2_core            (1)  : career counters, bonusXp, social follow/triple flags, uid, updatedAt
 *  - cs2_wk_0..1         (2)  : weaponKills mastery counters
 *  - cs2_gs_0..9         (10) : mailbox/event grantedSkins (supports 216+ skins)
 *  - cs2_ga_0..1         (2)  : mailbox/event grantedAgents
 *  - cs2_mr_0..7         (8)  : mailbox read-only mail IDs (deduped against claimedMailIds)
 *  - cs2_mc_0..7         (8)  : mailbox claimed mail IDs (up to 300+ mails)
 *  - cs2_ci_0..31        (32) : mailbox/event customItems (badges, titles, currency, collectibles, up to 200)
 *  - cs2_lo_meta         (1)  : equipped CT/T agents + CT/T weapon loadout + updatedAt
 *  - cs2_lo_s0..s2       (3)  : equipped non-starter weapon/knife skins (diff vs STARTER_SKINS)
 *  - cs2_cfg_main        (1)  : aim, crosshair diff, video, quality, brightness, visual/map style, bot, fps, dpi
 *  - cs2_cfg_aud         (1)  : master volume, music kit, music volume
 *  - cs2_cfg_k0..k1      (2)  : keyboard/mouse keybindings (dust2.controls.v1)
 *  - cs2_cfg_touch       (1)  : mobile touch settings, gyro/aim-assist motion settings, fullscreen pref
 *  - cs2_cfg_tlay_0..2   (3)  : mobile 2/3/4-finger custom button layout (dust2.touch-layout.v1)
 *  Total max allocated: 75 keys (53 keys reserved for future features).
 *
 * Backward compatibility:
 *  - Losslessly decodes & monotone-merges legacy v1 keys (`cs_prog_v1`, `cs_loadout_v1`) when present.
 *  - Never writes oversized v1 keys again (legacy `cs_loadout_v1` was 1,245 B > 1,024 B limit!).
 */
import {
  STARTER_SKINS,
  createEmptyProgress,
  normalizeProgress,
  mergeProgress,
  enforceUnlockedSkinLoadout,
  enforceUnlockedAgentLoadout,
} from './progression.js';
import { normalizeWeaponLoadout } from './weapon-loadout.js';
import { DEFAULT_CROSSHAIR, normalizeCrosshair } from './cs2-settings.js';
import { normalizeLayout, LAYOUT_IDS } from './touch-layout.js';
import { normalizeTouch } from './touch-input.js';
import { normalizeMotion } from './motion-input.js';

export const TOY_CLOUD_SCHEMA_VERSION = 2;
export const TOY_CLOUD_MAX_KEYS = 128;
export const TOY_CLOUD_MAX_KEY_BYTES = 128;
export const TOY_CLOUD_MAX_VALUE_BYTES = 1024;
export const TOY_CLOUD_SAFE_VALUE_BYTES = 960;
export const TOY_CLOUD_KEY_REGEX = /^(?!__)[a-zA-Z0-9_-]{1,128}$/;

export const LEGACY_CLOUD_KEY_PROGRESS = 'cs_prog_v1';
export const LEGACY_CLOUD_KEY_LOADOUT = 'cs_loadout_v1';

export const CLOUD_SLOT_BUDGET = Object.freeze({
  core: { prefix: 'cs2_core', maxKeys: 1 },
  weaponKills: { prefix: 'cs2_wk_', maxKeys: 2 },
  grantedSkins: { prefix: 'cs2_gs_', maxKeys: 10 },
  grantedAgents: { prefix: 'cs2_ga_', maxKeys: 2 },
  readMails: { prefix: 'cs2_mr_', maxKeys: 8 },
  claimedMails: { prefix: 'cs2_mc_', maxKeys: 8 },
  customItems: { prefix: 'cs2_ci_', maxKeys: 32 },
  loadoutMeta: { prefix: 'cs2_lo_meta', maxKeys: 1 },
  loadoutSkins: { prefix: 'cs2_lo_s', maxKeys: 3 },
  cfgMain: { prefix: 'cs2_cfg_main', maxKeys: 1 },
  cfgAudio: { prefix: 'cs2_cfg_aud', maxKeys: 1 },
  cfgKeys: { prefix: 'cs2_cfg_k', maxKeys: 2 },
  cfgTouch: { prefix: 'cs2_cfg_touch', maxKeys: 1 },
  cfgTouchLayout: { prefix: 'cs2_cfg_tlay_', maxKeys: 3 },
});

/** Local preference keys synced to Toy Cloud via `cs2_cfg_*`. */
export const SYNCED_SETTING_KEYS = Object.freeze([
  'dust2.cs-settings.v1',
  'dust2.quality.v2',
  'dust2.brightness',
  'dust2.visual-style.v1',
  'dust2.map-style.v1',
  'dust2.frame-limit.v1',
  'dust2.mouse-dpi',
  'dust2.volume',
  'dust2.music-kit',
  'dust2.music-volume',
  'dust2.controls.v1',
  'dust2.touch.v1',
  'dust2.motion.v1',
  'dust2.fullscreen.v1',
  'dust2.touch-layout.v1',
]);

const textEncoder = new TextEncoder();

export function utf8ByteLength(str) {
  return textEncoder.encode(String(str ?? '')).length;
}

export function isValidToyCloudKey(key) {
  return typeof key === 'string' && TOY_CLOUD_KEY_REGEX.test(key) && utf8ByteLength(key) <= TOY_CLOUD_MAX_KEY_BYTES;
}

export function isManagedToyCloudKey(key) {
  return typeof key === 'string' && (
    key.startsWith('cs2_') ||
    key === LEGACY_CLOUD_KEY_PROGRESS ||
    key === LEGACY_CLOUD_KEY_LOADOUT
  );
}

function round3(n) {
  return Math.round(Number(n) * 1000) / 1000;
}

function safeParseJSON(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** Pack an array of JSON-serializable items into <= maxBytes UTF-8 JSON array strings. */
function packArrayChunks(items, prefix, maxKeys, maxBytes = TOY_CLOUD_SAFE_VALUE_BYTES) {
  const out = {};
  if (!Array.isArray(items) || items.length === 0) return out;
  let chunkIndex = 0;
  let bucket = [];

  for (const item of items) {
    const candidate = [...bucket, item];
    const encoded = JSON.stringify(candidate);
    if (utf8ByteLength(encoded) <= maxBytes) {
      bucket = candidate;
      continue;
    }
    if (bucket.length > 0) {
      if (chunkIndex >= maxKeys) break;
      out[`${prefix}${chunkIndex++}`] = JSON.stringify(bucket);
      bucket = [];
    }
    const singleEncoded = JSON.stringify([item]);
    if (utf8ByteLength(singleEncoded) <= maxBytes) {
      bucket = [item];
    }
    // If a single item somehow exceeds maxBytes on its own, skip rather than poison the batch
  }
  if (bucket.length > 0 && chunkIndex < maxKeys) {
    out[`${prefix}${chunkIndex}`] = JSON.stringify(bucket);
  }
  return out;
}

/** Pack key-value entries of a plain object into <= maxBytes UTF-8 JSON object strings. */
function packObjectChunks(obj, prefix, maxKeys, maxBytes = TOY_CLOUD_SAFE_VALUE_BYTES) {
  const out = {};
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  const entries = Object.entries(obj);
  if (!entries.length) return out;

  let chunkIndex = 0;
  let bucket = {};

  for (const [k, v] of entries) {
    const candidate = { ...bucket, [k]: v };
    const encoded = JSON.stringify(candidate);
    if (utf8ByteLength(encoded) <= maxBytes) {
      bucket = candidate;
      continue;
    }
    if (Object.keys(bucket).length > 0) {
      if (chunkIndex >= maxKeys) break;
      out[`${prefix}${chunkIndex++}`] = JSON.stringify(bucket);
      bucket = {};
    }
    const singleEncoded = JSON.stringify({ [k]: v });
    if (utf8ByteLength(singleEncoded) <= maxBytes) {
      bucket = { [k]: v };
    }
  }
  if (Object.keys(bucket).length > 0 && chunkIndex < maxKeys) {
    out[`${prefix}${chunkIndex}`] = JSON.stringify(bucket);
  }
  return out;
}

function collectOrderedChunkKeys(rawMap, prefix) {
  const re = new RegExp(`^${prefix}(\\d+)$`);
  return Object.keys(rawMap || {})
    .map((k) => {
      const m = re.exec(k);
      return m ? { key: k, idx: Number(m[1]) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.idx - b.idx)
    .map((x) => x.key);
}

function unpackArrayChunks(rawMap, prefix) {
  const out = [];
  for (const key of collectOrderedChunkKeys(rawMap, prefix)) {
    const parsed = safeParseJSON(rawMap[key]);
    if (Array.isArray(parsed)) out.push(...parsed);
  }
  return out;
}

function unpackObjectChunks(rawMap, prefix) {
  const out = {};
  for (const key of collectOrderedChunkKeys(rawMap, prefix)) {
    const parsed = safeParseJSON(rawMap[key]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      Object.assign(out, parsed);
    }
  }
  return out;
}

function compactCrosshair(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const norm = normalizeCrosshair(raw);
  const diff = {};
  for (const [k, v] of Object.entries(norm)) {
    if (DEFAULT_CROSSHAIR[k] !== v) diff[k] = v;
  }
  return Object.keys(diff).length ? diff : undefined;
}

function expandCrosshair(diff) {
  if (!diff || typeof diff !== 'object') return { ...DEFAULT_CROSSHAIR };
  return normalizeCrosshair({ ...DEFAULT_CROSSHAIR, ...diff });
}

function compactCustomItem(item) {
  const out = {
    i: item.id,
    t: item.title,
    c: item.category || 'misc',
    q: item.quantity || 1,
  };
  if (item.description) out.d = item.description;
  if (item.icon) out.ic = item.icon;
  if (item.previewUrl) out.p = item.previewUrl;
  if (item.acquiredAt) out.a = item.acquiredAt;
  // Guarantee every single compact item fits safely under 900 UTF-8 bytes
  if (utf8ByteLength(JSON.stringify(out)) > 900 && out.d) {
    out.d = out.d.slice(0, 60);
  }
  if (utf8ByteLength(JSON.stringify(out)) > 900 && out.p) {
    delete out.p;
  }
  return out;
}

function expandCustomItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.i || raw.id;
  const title = raw.t || raw.title;
  if (!id || !title) return null;
  return {
    id,
    title,
    category: raw.c || raw.category || 'misc',
    quantity: raw.q ?? raw.quantity ?? 1,
    ...(raw.d || raw.description ? { description: raw.d || raw.description } : {}),
    ...(raw.ic || raw.icon ? { icon: raw.ic || raw.icon } : {}),
    ...(raw.p || raw.previewUrl ? { previewUrl: raw.p || raw.previewUrl } : {}),
    acquiredAt: raw.a ?? raw.acquiredAt ?? 0,
  };
}

function compactTouchLayoutButtons(layoutObj) {
  const norm = normalizeLayout(layoutObj);
  const compact = {};
  for (const id of LAYOUT_IDS) {
    const b = norm.buttons[id];
    if (!b) continue;
    compact[id] = b.hidden
      ? [round3(b.x), round3(b.y), round3(b.size), round3(b.opacity), 1]
      : [round3(b.x), round3(b.y), round3(b.size), round3(b.opacity)];
  }
  return compact;
}

function expandTouchLayoutButtons(compactObj) {
  const buttons = {};
  if (!compactObj || typeof compactObj !== 'object') return { version: 1, buttons };
  for (const id of LAYOUT_IDS) {
    const tuple = compactObj[id];
    if (Array.isArray(tuple) && tuple.length >= 4) {
      buttons[id] = {
        x: tuple[0],
        y: tuple[1],
        size: tuple[2],
        opacity: tuple[3],
        ...(tuple[4] ? { hidden: true } : {}),
      };
    } else if (tuple && typeof tuple === 'object') {
      buttons[id] = tuple;
    }
  }
  return normalizeLayout({ version: 1, buttons });
}

/**
 * Read local player settings from a preference store into a clean plain snapshot for cloud sync.
 */
export function readLocalSettingsSnapshot(storage, updatedAt = 0) {
  if (!storage) return null;
  const csRaw = storage.readJSON ? storage.readJSON('dust2.cs-settings.v1', null) : safeParseJSON(storage.getItem?.('dust2.cs-settings.v1'));
  const quality = storage.getItem?.('dust2.quality.v2') ?? null;
  const brightnessRaw = storage.getItem?.('dust2.brightness');
  const visualStyle = storage.getItem?.('dust2.visual-style.v1') ?? null;
  const mapStyle = storage.getItem?.('dust2.map-style.v1') ?? null;
  const frameLimitRaw = storage.getItem?.('dust2.frame-limit.v1');
  const mouseDpiRaw = storage.getItem?.('dust2.mouse-dpi');
  const volumeRaw = storage.getItem?.('dust2.volume');
  const musicKit = storage.getItem?.('dust2.music-kit') ?? null;
  const musicVolumeRaw = storage.getItem?.('dust2.music-volume');
  const controlsRaw = storage.readJSON ? storage.readJSON('dust2.controls.v1', null) : safeParseJSON(storage.getItem?.('dust2.controls.v1'));
  const touchRaw = storage.readJSON ? storage.readJSON('dust2.touch.v1', null) : safeParseJSON(storage.getItem?.('dust2.touch.v1'));
  const motionRaw = storage.readJSON ? storage.readJSON('dust2.motion.v1', null) : safeParseJSON(storage.getItem?.('dust2.motion.v1'));
  const fullscreenRaw = storage.readJSON ? storage.readJSON('dust2.fullscreen.v1', null) : safeParseJSON(storage.getItem?.('dust2.fullscreen.v1'));
  const touchLayoutRaw = storage.readJSON ? storage.readJSON('dust2.touch-layout.v1', null) : safeParseJSON(storage.getItem?.('dust2.touch-layout.v1'));

  const hasAny = Boolean(
    csRaw || quality !== null || brightnessRaw !== null || visualStyle !== null || mapStyle !== null ||
    frameLimitRaw !== null || mouseDpiRaw !== null || volumeRaw !== null || musicKit !== null ||
    musicVolumeRaw !== null || controlsRaw || touchRaw || motionRaw || fullscreenRaw || touchLayoutRaw,
  );
  if (!hasAny) return null;

  return {
    updatedAt: Math.max(0, Math.floor(Number(updatedAt) || 0)),
    csSettings: csRaw && typeof csRaw === 'object' ? csRaw : null,
    quality: quality === 'high' || quality === 'low' ? quality : null,
    brightness: brightnessRaw !== null && Number.isFinite(Number(brightnessRaw)) ? Math.max(60, Math.min(160, Number(brightnessRaw))) : null,
    visualStyle: typeof visualStyle === 'string' && visualStyle.length <= 24 ? visualStyle : null,
    mapStyle: mapStyle === 'flat' || mapStyle === 'original' ? mapStyle : null,
    frameLimit: frameLimitRaw !== null && Number.isFinite(Number(frameLimitRaw)) ? Number(frameLimitRaw) : null,
    mouseDpi: mouseDpiRaw !== null && Number.isFinite(Number(mouseDpiRaw)) ? Number(mouseDpiRaw) : null,
    volume: volumeRaw !== null && Number.isFinite(Number(volumeRaw)) ? Math.max(0, Math.min(1, Number(volumeRaw))) : null,
    musicKit: typeof musicKit === 'string' && musicKit.length <= 40 ? musicKit : null,
    musicVolume: musicVolumeRaw !== null && Number.isFinite(Number(musicVolumeRaw)) ? Math.max(0, Math.min(1, Number(musicVolumeRaw))) : null,
    controls: controlsRaw?.version === 1 && controlsRaw.bindings && typeof controlsRaw.bindings === 'object' ? controlsRaw : null,
    touch: touchRaw && typeof touchRaw === 'object' ? normalizeTouch(touchRaw) : null,
    motion: motionRaw && typeof motionRaw === 'object' ? normalizeMotion(motionRaw) : null,
    fullscreen: fullscreenRaw && typeof fullscreenRaw === 'object' ? { automatic: fullscreenRaw.automatic !== false } : null,
    touchLayout: touchLayoutRaw?.version === 1 && touchLayoutRaw.buttons ? normalizeLayout(touchLayoutRaw) : null,
  };
}

/**
 * Write a decoded cloud settings snapshot back into local preferences store.
 */
export function applySettingsSnapshotToStorage(storage, settings) {
  if (!storage || !settings || typeof settings !== 'object') return false;
  let wrote = false;
  const set = (k, v) => {
    try { storage.setItem(k, String(v)); wrote = true; } catch {}
  };
  if (settings.csSettings && typeof settings.csSettings === 'object') {
    set('dust2.cs-settings.v1', JSON.stringify(settings.csSettings));
  }
  if (settings.quality !== null && settings.quality !== undefined) set('dust2.quality.v2', settings.quality);
  if (settings.brightness !== null && settings.brightness !== undefined) set('dust2.brightness', String(settings.brightness));
  if (settings.visualStyle) set('dust2.visual-style.v1', settings.visualStyle);
  if (settings.mapStyle) set('dust2.map-style.v1', settings.mapStyle);
  if (settings.frameLimit !== null && settings.frameLimit !== undefined) set('dust2.frame-limit.v1', String(settings.frameLimit));
  if (settings.mouseDpi !== null && settings.mouseDpi !== undefined) set('dust2.mouse-dpi', String(settings.mouseDpi));
  if (settings.volume !== null && settings.volume !== undefined) set('dust2.volume', String(settings.volume));
  if (settings.musicKit) set('dust2.music-kit', settings.musicKit);
  if (settings.musicVolume !== null && settings.musicVolume !== undefined) set('dust2.music-volume', String(settings.musicVolume));
  if (settings.controls?.version === 1 && settings.controls.bindings) {
    set('dust2.controls.v1', JSON.stringify(settings.controls));
  }
  if (settings.touch) set('dust2.touch.v1', JSON.stringify(normalizeTouch(settings.touch)));
  if (settings.motion) set('dust2.motion.v1', JSON.stringify(normalizeMotion(settings.motion)));
  if (settings.fullscreen) set('dust2.fullscreen.v1', JSON.stringify({ automatic: settings.fullscreen.automatic !== false }));
  if (settings.touchLayout?.version === 1 && settings.touchLayout.buttons) {
    set('dust2.touch-layout.v1', JSON.stringify(normalizeLayout(settings.touchLayout)));
  }
  return wrote;
}

/**
 * Encode progress, loadout, and player settings into a Toy-compliant sharded key-value map.
 * Every single value is guaranteed <= TOY_CLOUD_SAFE_VALUE_BYTES (960 B <= 1024 B hard limit)
 * and total key count is guaranteed <= TOY_CLOUD_MAX_KEYS (128).
 */
export function encodeToyCloudSnapshot({ progress, loadout = null, settings = null } = {}) {
  const entries = {};
  const p = normalizeProgress(progress);

  // 1. Core career stats + social unlock flags (always 1 key, ~200-290 bytes)
  const core = {
    v: TOY_CLOUD_SCHEMA_VERSION,
    ...(p.uid ? { u: p.uid.slice(0, 128) } : {}),
    k: p.kills,
    hs: p.headshots,
    m: p.matches,
    r: p.rounds,
    w: p.wins,
    xp: p.bonusXp,
    s: {
      ...(p.social.followed ? { f: 1 } : {}),
      ...(p.social.tripled ? { t: 1 } : {}),
      ...(p.social.liked ? { l: 1 } : {}),
      ...(p.social.coined ? { c: 1 } : {}),
      ...(p.social.favorited ? { v: 1 } : {}),
      ...(p.social.checkedAt ? { at: p.social.checkedAt } : {}),
    },
    at: p.updatedAt,
  };
  entries.cs2_core = JSON.stringify(core);

  // 2. Per-weapon mastery kills (0..2 keys)
  Object.assign(entries, packObjectChunks(p.weaponKills, CLOUD_SLOT_BUDGET.weaponKills.prefix, CLOUD_SLOT_BUDGET.weaponKills.maxKeys));

  // 3. Mailbox / event granted skins & agents (0..12 keys)
  Object.assign(entries, packArrayChunks(p.grantedSkins, CLOUD_SLOT_BUDGET.grantedSkins.prefix, CLOUD_SLOT_BUDGET.grantedSkins.maxKeys));
  Object.assign(entries, packArrayChunks(p.grantedAgents, CLOUD_SLOT_BUDGET.grantedAgents.prefix, CLOUD_SLOT_BUDGET.grantedAgents.maxKeys));

  // 4. Mailbox claimed & read-only IDs (deduped: claimed IDs are implicitly read!)
  const claimedSet = new Set(p.claimedMailIds);
  const readOnlyIds = p.readMailIds.filter((id) => !claimedSet.has(id));
  Object.assign(entries, packArrayChunks(p.claimedMailIds, CLOUD_SLOT_BUDGET.claimedMails.prefix, CLOUD_SLOT_BUDGET.claimedMails.maxKeys));
  Object.assign(entries, packArrayChunks(readOnlyIds, CLOUD_SLOT_BUDGET.readMails.prefix, CLOUD_SLOT_BUDGET.readMails.maxKeys));

  // 5. Mailbox / event custom items (badges, titles, currency, collectibles — 0..32 keys)
  const compactItems = Object.values(p.customItems || {}).map(compactCustomItem);
  Object.assign(entries, packArrayChunks(compactItems, CLOUD_SLOT_BUDGET.customItems.prefix, CLOUD_SLOT_BUDGET.customItems.maxKeys));

  // 6. Equipped loadout: agents + weapons in cs2_lo_meta (~390 B), non-starter skins diff in cs2_lo_s0..s2
  if (loadout && typeof loadout === 'object') {
    const safeSkins = enforceUnlockedSkinLoadout(loadout.skins || {}, p);
    const safeAgents = enforceUnlockedAgentLoadout(loadout.agents || {}, p);
    const safeWeapons = normalizeWeaponLoadout(loadout.weapons || {});
    entries.cs2_lo_meta = JSON.stringify({
      v: TOY_CLOUD_SCHEMA_VERSION,
      a: safeAgents,
      w: safeWeapons,
      at: Math.max(0, Math.floor(Number(loadout.updatedAt) || 0)),
    });
    const skinDiff = {};
    for (const [weapon, skinId] of Object.entries(safeSkins)) {
      if (skinId && skinId !== STARTER_SKINS[weapon]) skinDiff[weapon] = skinId;
    }
    Object.assign(entries, packObjectChunks(skinDiff, CLOUD_SLOT_BUDGET.loadoutSkins.prefix, CLOUD_SLOT_BUDGET.loadoutSkins.maxKeys));
  }

  // 7. Full player settings & mobile 2/3/4-finger touch layout
  if (settings && typeof settings === 'object') {
    const at = Math.max(0, Math.floor(Number(settings.updatedAt) || 0));

    // 7a. Main gameplay / crosshair / video / quality / style settings (1 key, <= 960 B)
    const mainCfg = { v: TOY_CLOUD_SCHEMA_VERSION, at };
    if (settings.csSettings && typeof settings.csSettings === 'object') {
      const s = settings.csSettings;
      const csCompact = {};
      if (Number.isFinite(Number(s.sensitivity))) csCompact.sens = round3(s.sensitivity);
      if (Number.isFinite(Number(s.zoomSensitivity))) csCompact.zsens = round3(s.zoomSensitivity);
      if (s.invertY === true) csCompact.invY = 1;
      const chDiff = compactCrosshair(s.crosshair);
      if (chDiff) csCompact.ch = chDiff;
      if (typeof s.aspect === 'string') csCompact.asp = s.aspect;
      if (typeof s.display === 'string') csCompact.dsp = s.display;
      if (s.privateVideo && typeof s.privateVideo === 'object') {
        csCompact.pv = {
          ...(typeof s.privateVideo.aspect === 'string' ? { a: s.privateVideo.aspect } : {}),
          ...(typeof s.privateVideo.display === 'string' ? { d: s.privateVideo.display } : {}),
        };
      }
      if (typeof s.mobileClarity === 'string') csCompact.mc = s.mobileClarity;
      if (s.flatRenderScale !== undefined) csCompact.frs = s.flatRenderScale;
      if (s.radarRotate === false) csCompact.rr = 0;
      if (typeof s.botDifficulty === 'string') csCompact.bot = s.botDifficulty;
      if (Object.keys(csCompact).length) mainCfg.cs = csCompact;
    }
    if (settings.quality) mainCfg.q = settings.quality;
    if (settings.brightness !== null && settings.brightness !== undefined) mainCfg.br = settings.brightness;
    if (settings.visualStyle) mainCfg.vs = settings.visualStyle;
    if (settings.mapStyle) mainCfg.ms = settings.mapStyle;
    if (settings.frameLimit !== null && settings.frameLimit !== undefined) mainCfg.fps = settings.frameLimit;
    if (settings.mouseDpi !== null && settings.mouseDpi !== undefined) mainCfg.dpi = settings.mouseDpi;
    if (Object.keys(mainCfg).length > 2) {
      const mainEncoded = JSON.stringify(mainCfg);
      if (utf8ByteLength(mainEncoded) <= TOY_CLOUD_SAFE_VALUE_BYTES) {
        entries.cs2_cfg_main = mainEncoded;
      }
    }

    // 7b. Audio & music kit (1 key, ~95 B)
    const audCfg = { v: TOY_CLOUD_SCHEMA_VERSION, at };
    if (settings.volume !== null && settings.volume !== undefined) audCfg.vol = round3(settings.volume);
    if (settings.musicKit) audCfg.kit = settings.musicKit;
    if (settings.musicVolume !== null && settings.musicVolume !== undefined) audCfg.mvol = round3(settings.musicVolume);
    if (Object.keys(audCfg).length > 2) {
      entries.cs2_cfg_aud = JSON.stringify(audCfg);
    }

    // 7c. Keyboard / mouse custom keybindings (0..2 keys, auto-sharded if ever > 960 B)
    if (settings.controls?.version === 1 && settings.controls.bindings && typeof settings.controls.bindings === 'object') {
      Object.assign(
        entries,
        packObjectChunks(settings.controls.bindings, CLOUD_SLOT_BUDGET.cfgKeys.prefix, CLOUD_SLOT_BUDGET.cfgKeys.maxKeys),
      );
    }

    // 7d. Mobile touch, gyro/aim-assist, fullscreen settings (1 key, ~220 B)
    const touchCfg = { v: TOY_CLOUD_SCHEMA_VERSION, at };
    if (settings.touch) touchCfg.t = normalizeTouch(settings.touch);
    if (settings.motion) touchCfg.m = normalizeMotion(settings.motion);
    if (settings.fullscreen) touchCfg.fs = settings.fullscreen.automatic !== false ? 1 : 0;
    if (Object.keys(touchCfg).length > 2) {
      const touchEncoded = JSON.stringify(touchCfg);
      if (utf8ByteLength(touchEncoded) <= TOY_CLOUD_SAFE_VALUE_BYTES) {
        entries.cs2_cfg_touch = touchEncoded;
      }
    }

    // 7e. Mobile 2/3/4-finger custom button layout (0..3 keys; full 21-button 4-finger fits in 1 key!)
    if (settings.touchLayout?.version === 1 && settings.touchLayout.buttons) {
      const compactButtons = compactTouchLayoutButtons(settings.touchLayout);
      Object.assign(
        entries,
        packObjectChunks(compactButtons, CLOUD_SLOT_BUDGET.cfgTouchLayout.prefix, CLOUD_SLOT_BUDGET.cfgTouchLayout.maxKeys),
      );
    }
  }

  validateToyCloudEntries(entries);
  return entries;
}

/**
 * Decode a Toy Cloud Storage response (supports BOTH v2 sharded keys and legacy v1 keys).
 */
export function decodeToyCloudSnapshot(rawCloudMap, fallbackUid = '') {
  const map = rawCloudMap && typeof rawCloudMap === 'object' ? rawCloudMap : {};
  const hasLegacyProgress = typeof map[LEGACY_CLOUD_KEY_PROGRESS] === 'string';
  const hasLegacyLoadout = typeof map[LEGACY_CLOUD_KEY_LOADOUT] === 'string';
  const hasV2Progress = typeof map.cs2_core === 'string' ||
    Object.keys(map).some((k) => /^(?:cs2_wk_|cs2_gs_|cs2_ga_|cs2_mr_|cs2_mc_|cs2_ci_)\d+$/.test(k));

  let legacyProgress = null;
  if (hasLegacyProgress) {
    const parsed = safeParseJSON(map[LEGACY_CLOUD_KEY_PROGRESS]);
    if (parsed) legacyProgress = normalizeProgress(parsed, fallbackUid);
  }

  let v2Progress = null;
  if (hasV2Progress) {
    const core = safeParseJSON(map.cs2_core) || {};
    const weaponKills = unpackObjectChunks(map, CLOUD_SLOT_BUDGET.weaponKills.prefix);
    const grantedSkins = unpackArrayChunks(map, CLOUD_SLOT_BUDGET.grantedSkins.prefix);
    const grantedAgents = unpackArrayChunks(map, CLOUD_SLOT_BUDGET.grantedAgents.prefix);
    const claimedMailIds = unpackArrayChunks(map, CLOUD_SLOT_BUDGET.claimedMails.prefix);
    const readOnlyIds = unpackArrayChunks(map, CLOUD_SLOT_BUDGET.readMails.prefix);
    const rawItems = unpackArrayChunks(map, CLOUD_SLOT_BUDGET.customItems.prefix);
    const customItems = {};
    for (const rawItem of rawItems) {
      const expanded = expandCustomItem(rawItem);
      if (expanded) customItems[expanded.id] = expanded;
    }
    const s = core.s && typeof core.s === 'object' ? core.s : {};
    v2Progress = normalizeProgress({
      v: 1,
      uid: core.u || fallbackUid,
      kills: core.k ?? 0,
      headshots: core.hs ?? 0,
      matches: core.m ?? 0,
      rounds: core.r ?? 0,
      wins: core.w ?? 0,
      weaponKills,
      grantedSkins,
      grantedAgents,
      bonusXp: core.xp ?? 0,
      customItems,
      claimedMailIds,
      readMailIds: [...readOnlyIds, ...claimedMailIds],
      social: {
        followed: Boolean(s.f),
        tripled: Boolean(s.t),
        liked: Boolean(s.l),
        coined: Boolean(s.c),
        favorited: Boolean(s.v),
        checkedAt: s.at ?? 0,
      },
      updatedAt: core.at ?? 0,
    }, fallbackUid);
  }

  let progress = null;
  if (legacyProgress && v2Progress) progress = mergeProgress(legacyProgress, v2Progress, fallbackUid);
  else if (v2Progress) progress = v2Progress;
  else if (legacyProgress) progress = legacyProgress;

  // Decode loadout (v2 + legacy v1 fallback; newer updatedAt wins, v2 wins ties)
  let legacyLoadout = null;
  if (hasLegacyLoadout) {
    const parsed = safeParseJSON(map[LEGACY_CLOUD_KEY_LOADOUT]);
    if (parsed && typeof parsed === 'object') {
      legacyLoadout = {
        skins: parsed.skins && typeof parsed.skins === 'object' ? parsed.skins : null,
        agents: parsed.agents && typeof parsed.agents === 'object' ? parsed.agents : null,
        weapons: parsed.weapons && typeof parsed.weapons === 'object' ? parsed.weapons : null,
        updatedAt: Number(parsed.updatedAt) || 0,
      };
    }
  }

  let v2Loadout = null;
  const loMeta = safeParseJSON(map.cs2_lo_meta);
  const loSkinsDiff = unpackObjectChunks(map, CLOUD_SLOT_BUDGET.loadoutSkins.prefix);
  if (loMeta && typeof loMeta === 'object') {
    v2Loadout = {
      skins: { ...STARTER_SKINS, ...loSkinsDiff },
      agents: loMeta.a && typeof loMeta.a === 'object' ? loMeta.a : null,
      weapons: loMeta.w && typeof loMeta.w === 'object' ? loMeta.w : null,
      updatedAt: Number(loMeta.at) || 0,
    };
  }
  const loadout = v2Loadout && (!legacyLoadout || v2Loadout.updatedAt >= legacyLoadout.updatedAt)
    ? v2Loadout
    : legacyLoadout;

  // Decode settings (v2)
  const mainCfg = safeParseJSON(map.cs2_cfg_main);
  const audCfg = safeParseJSON(map.cs2_cfg_aud);
  const keyBindings = unpackObjectChunks(map, CLOUD_SLOT_BUDGET.cfgKeys.prefix);
  const touchCfg = safeParseJSON(map.cs2_cfg_touch);
  const touchLayoutCompact = unpackObjectChunks(map, CLOUD_SLOT_BUDGET.cfgTouchLayout.prefix);

  const hasSettings = Boolean(
    mainCfg || audCfg || Object.keys(keyBindings).length || touchCfg || Object.keys(touchLayoutCompact).length,
  );
  let settings = null;
  if (hasSettings) {
    const updatedAt = Math.max(
      Number(mainCfg?.at) || 0,
      Number(audCfg?.at) || 0,
      Number(touchCfg?.at) || 0,
    );
    let csSettings = null;
    if (mainCfg?.cs && typeof mainCfg.cs === 'object') {
      const c = mainCfg.cs;
      csSettings = {
        ...(c.sens !== undefined ? { sensitivity: c.sens } : {}),
        ...(c.zsens !== undefined ? { zoomSensitivity: c.zsens } : {}),
        invertY: Boolean(c.invY),
        crosshair: expandCrosshair(c.ch),
        ...(mainCfg.q ? { quality: mainCfg.q } : {}),
        ...(mainCfg.br !== undefined ? { brightness: mainCfg.br } : {}),
        ...(c.asp ? { aspect: c.asp } : {}),
        ...(c.dsp ? { display: c.dsp } : {}),
        ...(c.pv ? { privateVideo: { ...(c.pv.a ? { aspect: c.pv.a } : {}), ...(c.pv.d ? { display: c.pv.d } : {}) } } : {}),
        ...(c.mc ? { mobileClarity: c.mc } : {}),
        ...(c.frs !== undefined ? { flatRenderScale: c.frs } : {}),
        radarRotate: c.rr !== 0,
        ...(c.bot ? { botDifficulty: c.bot } : {}),
      };
    }
    settings = {
      updatedAt,
      csSettings,
      quality: mainCfg?.q ?? null,
      brightness: mainCfg?.br ?? null,
      visualStyle: mainCfg?.vs ?? null,
      mapStyle: mainCfg?.ms ?? null,
      frameLimit: mainCfg?.fps ?? null,
      mouseDpi: mainCfg?.dpi ?? null,
      volume: audCfg?.vol ?? null,
      musicKit: audCfg?.kit ?? null,
      musicVolume: audCfg?.mvol ?? null,
      controls: Object.keys(keyBindings).length ? { version: 1, bindings: keyBindings } : null,
      touch: touchCfg?.t ? normalizeTouch(touchCfg.t) : null,
      motion: touchCfg?.m ? normalizeMotion(touchCfg.m) : null,
      fullscreen: touchCfg?.fs !== undefined ? { automatic: Boolean(touchCfg.fs) } : null,
      touchLayout: Object.keys(touchLayoutCompact).length ? expandTouchLayoutButtons(touchLayoutCompact) : null,
    };
  }

  return {
    progress,
    loadout,
    settings,
    hasLegacyKeys: hasLegacyProgress || hasLegacyLoadout,
    legacyKeys: [
      ...(hasLegacyProgress ? [LEGACY_CLOUD_KEY_PROGRESS] : []),
      ...(hasLegacyLoadout ? [LEGACY_CLOUD_KEY_LOADOUT] : []),
    ],
  };
}

/**
 * Strictly validate an encoded Toy Cloud Storage map against Bilibili Toy's official hard limits.
 * Throws descriptive errors before any bad payload ever reaches Toy's server.
 */
export function validateToyCloudEntries(entries) {
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    throw new Error('Toy cloud entries must be a plain object');
  }
  const keys = Object.keys(entries);
  if (keys.length > TOY_CLOUD_MAX_KEYS) {
    throw new Error(`Toy cloud key count ${keys.length} exceeds platform limit ${TOY_CLOUD_MAX_KEYS}`);
  }
  for (const key of keys) {
    if (!isValidToyCloudKey(key)) {
      throw new Error(`Invalid Toy cloud key: ${key}`);
    }
    const val = entries[key];
    if (typeof val !== 'string') {
      throw new Error(`Toy cloud value for "${key}" must be a string`);
    }
    const bytes = utf8ByteLength(val);
    if (bytes > TOY_CLOUD_MAX_VALUE_BYTES) {
      throw new Error(`Toy cloud value for "${key}" is ${bytes} bytes (> ${TOY_CLOUD_MAX_VALUE_BYTES} byte limit)`);
    }
  }
  return true;
}

/**
 * Compute delta writes and obsolete keys between the last confirmed cloud snapshot and the next snapshot.
 */
export function diffToyCloudEntries(previousMap, nextMap) {
  const prev = previousMap && typeof previousMap === 'object' ? previousMap : {};
  const next = nextMap && typeof nextMap === 'object' ? nextMap : {};
  const toWrite = {};
  const toDelete = [];

  for (const [k, v] of Object.entries(next)) {
    if (prev[k] !== v) toWrite[k] = v;
  }
  for (const k of Object.keys(prev)) {
    if (isManagedToyCloudKey(k) && !Object.hasOwn(next, k)) {
      toDelete.push(k);
    }
  }
  return { toWrite, toDelete };
}

/**
 * Measure exact quota consumption of an encoded Toy Cloud Storage map.
 */
export function measureToyCloudUsage(entries) {
  const map = entries && typeof entries === 'object' ? entries : {};
  const breakdown = {};
  let totalBytes = 0;
  let maxValueBytes = 0;
  let keysUsed = 0;

  for (const [k, v] of Object.entries(map)) {
    if (typeof v !== 'string') continue;
    const bytes = utf8ByteLength(v);
    keysUsed++;
    totalBytes += bytes;
    if (bytes > maxValueBytes) maxValueBytes = bytes;
    const group =
      k === 'cs2_core' ? 'core' :
      k.startsWith('cs2_wk_') ? 'weaponKills' :
      k.startsWith('cs2_gs_') ? 'grantedSkins' :
      k.startsWith('cs2_ga_') ? 'grantedAgents' :
      k.startsWith('cs2_mr_') ? 'readMails' :
      k.startsWith('cs2_mc_') ? 'claimedMails' :
      k.startsWith('cs2_ci_') ? 'customItems' :
      k.startsWith('cs2_lo_') ? 'loadout' :
      k.startsWith('cs2_cfg_') ? 'settings' : 'legacy';
    if (!breakdown[group]) breakdown[group] = { keys: 0, bytes: 0 };
    breakdown[group].keys++;
    breakdown[group].bytes += bytes;
  }

  return {
    keysUsed,
    maxKeys: TOY_CLOUD_MAX_KEYS,
    remainingKeys: Math.max(0, TOY_CLOUD_MAX_KEYS - keysUsed),
    totalBytes,
    maxBytes: TOY_CLOUD_MAX_KEYS * TOY_CLOUD_MAX_VALUE_BYTES,
    maxValueBytes,
    maxAllowedValueBytes: TOY_CLOUD_MAX_VALUE_BYTES,
    withinLimits: keysUsed <= TOY_CLOUD_MAX_KEYS && maxValueBytes <= TOY_CLOUD_MAX_VALUE_BYTES,
    breakdown,
  };
}
