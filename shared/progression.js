/**
 * Unified growth progression & Bilibili Toy social unlock system for skins, knives, and agents.
 *
 * Design rules:
 * - New players start ONLY with stock/vanilla weapons (*-vanilla), basic CT/T knives
 *   (default-ct-vanilla, default-t-vanilla), and basic agents (ct-sas, t-phoenix).
 * - A curated tier of iconic skins, knives, and agents unlocks via Bilibili Toy SDK
 *   Follow (关注 UP 主) and Triple (一键三连: 点赞+投币+收藏).
 * - All remaining skins, exotic knives, and elite agents unlock progressively via
 *   combat kills, weapon mastery kills, headshots, and completed matches/rounds.
 * - Pure deterministic logic with zero DOM dependencies so it runs in browser, Node tests,
 *   and client-next alike.
 */
import { SKINS, getSkin } from './skins.js';
import { AGENT_CATALOG, DEFAULT_AGENT_IDS, getAgent } from './agents.js';
import { WEAPONS, getWeapon } from './weapons.js';

export const PROGRESSION_SCHEMA_VERSION = 1;

/** Starter free skins: stock vanilla models for every firearm + basic CT/T knives. */
export const STARTER_KNIFE_IDS = Object.freeze(['default-ct-vanilla', 'default-t-vanilla']);

export const STARTER_SKINS = Object.freeze(
  Object.fromEntries(
    Object.keys(WEAPONS).map((weapon) => {
      if (weapon === 'knife') return ['knife', 'default-ct-vanilla'];
      const vanilla = SKINS.find((s) => s.weapon === weapon && s.condition === 'Vanilla');
      return [weapon, vanilla ? vanilla.id : SKINS.find((s) => s.weapon === weapon)?.id];
    }),
  ),
);

export const STARTER_SKIN_SET = new Set([
  ...Object.values(STARTER_SKINS),
  ...STARTER_KNIFE_IDS,
]);

export const STARTER_AGENTS = Object.freeze({ ...DEFAULT_AGENT_IDS });
export const STARTER_AGENT_SET = new Set(Object.values(STARTER_AGENTS));

/** Curated Bilibili Toy Follow (关注 UP 主) exclusive rewards */
export const TOY_FOLLOW_SKIN_IDS = Object.freeze([
  'ak47-ice-coaled-1143',
  'm4a4-temukau-1228',
  'm4a1-decimator-644',
  'awp-atheris-838',
  'deagle-mecha-industries-805',
  'pistol-water-elemental-353',
  'usp-cortex-705',
  'mp9-starlight-protector-1134',
  'flip-vanilla',
  'bayonet-vanilla',
]);

export const TOY_FOLLOW_AGENT_IDS = Object.freeze([
  'ct-ava',
  't-enforcer',
]);

/** Curated Bilibili Toy Triple (一键三连：点赞+投币+收藏) exclusive rewards */
export const TOY_TRIPLE_SKIN_IDS = Object.freeze([
  'ak47-vulcan',
  'm4a1-printstream',
  'awp-asiimov',
  'deagle-printstream',
  'usp-printstream',
  'pistol-fade',
  'ssg08-dragonfire',
  'mp9-wild-lily',
  'butterfly-vanilla',
  'karambit-vanilla',
]);

export const TOY_TRIPLE_AGENT_IDS = Object.freeze([
  'ct-ricksaw',
  't-miami',
]);

const FOLLOW_SKIN_SET = new Set(TOY_FOLLOW_SKIN_IDS);
const TRIPLE_SKIN_SET = new Set(TOY_TRIPLE_SKIN_IDS);
const FOLLOW_AGENT_SET = new Set(TOY_FOLLOW_AGENT_IDS);
const TRIPLE_AGENT_SET = new Set(TOY_TRIPLE_AGENT_IDS);

/**
 * Explicit prestige milestones for iconic knives & signature firearm skins.
 * - Knives unlock along a long-term global career ladder (kills AND matches, staggered so
 *   players earn ~1 knife every few matches rather than bursting dozens at once).
 * - Firearm skins unlock via WEAPON-SPECIFIC mastery kills (and career matches on higher tiers),
 *   so using AK-47 unlocks AK-47 skins rather than unlocking 30 untouched weapons simultaneously.
 */
const EXPLICIT_SKIN_TASKS = Object.freeze({
  // Knives career ladder (35 kills & 2 matches -> 2000 kills & 80 matches)
  'navaja-vanilla':       { kills: 35,   matches: 2,  mode: 'and', tier: 1, label: '新兵磨刃' },
  'gut-vanilla':          { kills: 75,   matches: 4,  mode: 'and', tier: 1, label: '近战初成' },
  'falchion-vanilla':     { kills: 115,  matches: 6,  mode: 'and', tier: 2, label: '弯刀利刃' },
  'push-vanilla':         { kills: 165,  matches: 8,  mode: 'and', tier: 2, label: '双匕突袭' },
  'bowie-vanilla':        { kills: 220,  matches: 11, mode: 'and', tier: 3, label: '猎手之锋' },
  'canis-vanilla':        { kills: 280,  matches: 14, mode: 'and', tier: 3, label: '荒野求生' },
  'cord-vanilla':         { kills: 350,  matches: 17, mode: 'and', tier: 3, label: '战术系绳' },
  'outdoor-vanilla':      { kills: 420,  matches: 20, mode: 'and', tier: 3, label: '孤狼巡猎' },
  'ursus-vanilla':        { kills: 500,  matches: 23, mode: 'and', tier: 4, label: '巨熊撕裂' },
  'stiletto-vanilla':     { kills: 590,  matches: 27, mode: 'and', tier: 4, label: '细剑刺客' },
  'tactical-vanilla':     { kills: 690,  matches: 31, mode: 'and', tier: 4, label: '战术猎杀' },
  'css-vanilla':          { kills: 790,  matches: 35, mode: 'and', tier: 4, label: '经典海豹' },
  'kukri-vanilla':        { kills: 900,  matches: 39, mode: 'and', tier: 5, label: '廓尔喀斩击' },
  'talon-vanilla':        { kills: 1020, matches: 43, mode: 'and', tier: 5, label: '锯齿爪锋' },
  'skeleton-vanilla':     { kills: 1150, matches: 48, mode: 'and', tier: 5, label: '镂空魅影' },
  'm9-vanilla':           { kills: 1300, matches: 54, mode: 'and', tier: 5, label: 'M9 战神刺刀' },
  'karambit-black-pearl': { kills: 1500, matches: 62, mode: 'and', tier: 6, label: '黑珍珠传世' },
  'karambit-ruby':        { kills: 1750, matches: 70, mode: 'and', tier: 6, label: '红宝石神话' },
  'karambit-sapphire':    { kills: 2000, matches: 80, mode: 'and', tier: 6, label: '蓝宝石巅峰' },

  // Iconic flagship firearm skins (weapon-specific mastery + matches on tier 2+)
  'ak47-slate-1035':         { weaponKills: 20,  matches: 0,  mode: 'and', tier: 1, label: '步枪入门' },
  'ak47-nightwish-1141':     { weaponKills: 55,  matches: 3,  mode: 'and', tier: 2, label: '夜愿觉醒' },
  'ak47-neon-rider':         { weaponKills: 120, matches: 7,  mode: 'and', tier: 3, label: '霓虹突击' },
  'ak47-fire-serpent':       { weaponKills: 240, matches: 14, mode: 'and', tier: 5, label: '火蛇传奇' },
  'ak47-wild-lotus':         { weaponKills: 420, matches: 24, mode: 'and', tier: 6, label: '野荷巅峰' },

  'm4a4-tooth-fairy-971':    { weaponKills: 20,  matches: 0,  mode: 'and', tier: 1, label: '防线新星' },
  'm4a4-desolate-space-588': { weaponKills: 60,  matches: 3,  mode: 'and', tier: 2, label: '深空守卫' },
  'm4a4-poseidon':           { weaponKills: 150, matches: 9,  mode: 'and', tier: 4, label: '海神之怒' },
  'm4a4-howl':               { weaponKills: 340, matches: 20, mode: 'and', tier: 6, label: '违禁咆哮' },

  'm4a1-night-terror-1130':  { weaponKills: 20,  matches: 0,  mode: 'and', tier: 1, label: '静默初试' },
  'm4a1-emphorosaur-s-1223': { weaponKills: 55,  matches: 3,  mode: 'and', tier: 2, label: '隐伏猎手' },
  'm4a1-nightmare':          { weaponKills: 115, matches: 7,  mode: 'and', tier: 3, label: '梦魇潜行' },
  'm4a1-golden-coil':        { weaponKills: 210, matches: 12, mode: 'and', tier: 4, label: '金蛇缠绕' },
  'm4a1-blue-phosphor':      { weaponKills: 360, matches: 20, mode: 'and', tier: 5, label: '澜磷微光' },

  'awp-duality-1222':        { weaponKills: 20,  matches: 0,  mode: 'and', tier: 1, label: '狙击首秀' },
  'awp-wildfire-917':        { weaponKills: 60,  matches: 4,  mode: 'and', tier: 3, label: '野火燎原' },
  'awp-oni-taiji':           { weaponKills: 140, matches: 9,  mode: 'and', tier: 4, label: '鬼退治狙神' },
  'awp-gungnir':             { weaponKills: 280, matches: 17, mode: 'and', tier: 6, label: '永恒之枪' },
  'awp-dragon-lore':         { weaponKills: 480, matches: 28, mode: 'and', tier: 6, label: '巨龙传说' },

  'usp-ticket-to-hell-1136': { weaponKills: 12,  matches: 0,  mode: 'and', tier: 1, label: '手枪热身' },
  'usp-cyrex-637':           { weaponKills: 35,  matches: 3,  mode: 'and', tier: 2, label: '精确点射' },
  'usp-orion':               { weaponKills: 75,  matches: 7,  mode: 'and', tier: 3, label: '猎户射手' },
  'usp-neo-noir':            { weaponKills: 135, matches: 12, mode: 'and', tier: 4, label: '黑色魅影' },
  'usp-kill-confirmed':      { weaponKills: 220, matches: 18, mode: 'and', tier: 5, label: '确认击杀' },

  'pistol-vogue-963':        { weaponKills: 12,  matches: 0,  mode: 'and', tier: 1, label: '冲锋起步' },
  'pistol-umbral-rabbit-1227': { weaponKills: 35, matches: 3, mode: 'and', tier: 2, label: '月影快枪' },
  'glock-neo-noir':          { weaponKills: 75,  matches: 7,  mode: 'and', tier: 3, label: '魅影连发' },
  'glock-bullet-queen':      { weaponKills: 135, matches: 12, mode: 'and', tier: 4, label: '子弹皇后' },
  'glock-emerald':           { weaponKills: 220, matches: 18, mode: 'and', tier: 5, label: '绿宝石传说' },

  'deagle-blue-ply-945':     { weaponKills: 15,  matches: 0,  mode: 'and', tier: 1, label: '重炮初鸣' },
  'deagle-light-rail-841':   { weaponKills: 50,  matches: 4,  mode: 'and', tier: 2, label: '电磁一击' },
  'deagle-conspiracy':       { weaponKills: 120, matches: 10, mode: 'and', tier: 4, label: '暗影阴谋' },
});

/** Agent growth tasks (4 non-starter, non-social agents, staggered between knives) */
const EXPLICIT_AGENT_TASKS = Object.freeze({
  'ct-operator':     { kills: 55,  matches: 3,  mode: 'and', tier: 2, label: 'FBI 特警晋升' },
  't-number-k':      { kills: 140, matches: 7,  mode: 'and', tier: 3, label: '专业人士合约' },
  'ct-syfers':       { kills: 320, matches: 15, mode: 'and', tier: 4, label: '神枪手认证' },
  't-silent-darryl': { kills: 560, matches: 25, mode: 'and', tier: 5, label: '沉默爵士传说' },
});

/** Per-weapon mastery ladder for remaining firearm skins (strictly weapon-specific kills) */
const GENERIC_TIERS = [
  { kills: 0, matches: 0,  weaponKills: 15,  mode: 'and', tier: 1, label: '战场初捷' },
  { kills: 0, matches: 3,  weaponKills: 45,  mode: 'and', tier: 2, label: '熟练干员' },
  { kills: 0, matches: 6,  weaponKills: 95,  mode: 'and', tier: 3, label: '武器专精' },
  { kills: 0, matches: 11, weaponKills: 170, mode: 'and', tier: 4, label: '精英涂装' },
  { kills: 0, matches: 16, weaponKills: 270, mode: 'and', tier: 5, label: '王牌收藏' },
  { kills: 0, matches: 22, weaponKills: 400, mode: 'and', tier: 6, label: '传奇臻品' },
];

// Build deterministic requirement table once for every skin and agent
const skinRequirements = new Map();
const weaponSkinBuckets = new Map();
for (const skin of SKINS) {
  let list = weaponSkinBuckets.get(skin.weapon);
  if (!list) { list = []; weaponSkinBuckets.set(skin.weapon, list); }
  list.push(skin);
}

for (const [weapon, list] of weaponSkinBuckets) {
  // Sort non-starter/non-social/non-explicit skins: popular skins unlock earlier, legacy/flagship default later!
  const remaining = list.filter(
    (s) =>
      !STARTER_SKIN_SET.has(s.id) &&
      !FOLLOW_SKIN_SET.has(s.id) &&
      !TRIPLE_SKIN_SET.has(s.id) &&
      !EXPLICIT_SKIN_TASKS[s.id],
  );
  remaining.sort((a, b) => {
    const score = (s) => (s.isDefault ? 3 : s.collection === 'popular' ? 1 : 2);
    return score(a) - score(b);
  });

  for (const skin of list) {
    if (STARTER_SKIN_SET.has(skin.id)) {
      skinRequirements.set(skin.id, Object.freeze({
        type: 'starter',
        tier: 0,
        title: '开局原厂装备',
        summary: '开局自带',
      }));
    } else if (FOLLOW_SKIN_SET.has(skin.id)) {
      skinRequirements.set(skin.id, Object.freeze({
        type: 'toy_follow',
        tier: 3,
        title: '关注 UP 主专属',
        summary: 'Toy 关注解锁',
      }));
    } else if (TRIPLE_SKIN_SET.has(skin.id)) {
      skinRequirements.set(skin.id, Object.freeze({
        type: 'toy_triple',
        tier: 5,
        title: '一键三连专属',
        summary: 'Toy 三连解锁',
      }));
    } else if (EXPLICIT_SKIN_TASKS[skin.id]) {
      const cfg = EXPLICIT_SKIN_TASKS[skin.id];
      skinRequirements.set(skin.id, Object.freeze({
        type: 'growth',
        weapon,
        ...cfg,
        title: cfg.label,
        summary: formatGrowthSummary(cfg, weapon),
      }));
    } else {
      const idx = remaining.findIndex((s) => s.id === skin.id);
      const tierCfg = GENERIC_TIERS[Math.min(GENERIC_TIERS.length - 1, Math.max(0, idx))];
      const cfg = {
        kills: tierCfg.kills,
        matches: tierCfg.matches,
        weaponKills: weapon === 'knife' ? 0 : tierCfg.weaponKills,
        mode: tierCfg.mode,
        tier: tierCfg.tier,
        label: tierCfg.label,
      };
      skinRequirements.set(skin.id, Object.freeze({
        type: 'growth',
        weapon,
        ...cfg,
        title: cfg.label,
        summary: formatGrowthSummary(cfg, weapon),
      }));
    }
  }
}

const agentRequirements = new Map();
for (const agent of AGENT_CATALOG) {
  if (STARTER_AGENT_SET.has(agent.id)) {
    agentRequirements.set(agent.id, Object.freeze({
      type: 'starter',
      tier: 0,
      title: '开局基础探员',
      summary: '开局自带',
    }));
  } else if (FOLLOW_AGENT_SET.has(agent.id)) {
    agentRequirements.set(agent.id, Object.freeze({
      type: 'toy_follow',
      tier: 3,
      title: '关注 UP 主专属',
      summary: 'Toy 关注解锁',
    }));
  } else if (TRIPLE_AGENT_SET.has(agent.id)) {
    agentRequirements.set(agent.id, Object.freeze({
      type: 'toy_triple',
      tier: 5,
      title: '一键三连专属',
      summary: 'Toy 三连解锁',
    }));
  } else {
    const cfg = EXPLICIT_AGENT_TASKS[agent.id] || { kills: 30, matches: 3, mode: 'or', tier: 3, label: '战功解锁' };
    agentRequirements.set(agent.id, Object.freeze({
      type: 'growth',
      ...cfg,
      title: cfg.label,
      summary: formatGrowthSummary(cfg),
    }));
  }
}

function formatGrowthSummary(cfg, weaponId = null) {
  const parts = [];
  if (cfg.weaponKills > 0 && weaponId) {
    const wName = getWeapon(weaponId)?.name || weaponId;
    parts.push(`${wName} ${cfg.weaponKills} 杀`);
  }
  if (cfg.kills > 0) parts.push(`累计 ${cfg.kills} 击杀`);
  if (cfg.matches > 0) parts.push(`完成 ${cfg.matches} 局对战`);
  const joiner = cfg.mode === 'and' ? ' 且 ' : ' 或 ';
  return parts.join(joiner);
}

export function createEmptyProgress(uid = '') {
  return {
    v: PROGRESSION_SCHEMA_VERSION,
    uid: String(uid || ''),
    kills: 0,
    headshots: 0,
    matches: 0,
    rounds: 0,
    wins: 0,
    weaponKills: {},
    social: {
      followed: false,
      tripled: false,
      liked: false,
      coined: false,
      favorited: false,
      checkedAt: 0,
    },
    updatedAt: 0,
  };
}

function clampInt(value, max = 10000000) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(max, n) : 0;
}

export function normalizeProgress(raw, fallbackUid = '') {
  const base = createEmptyProgress(fallbackUid);
  if (!raw || typeof raw !== 'object') return base;
  base.uid = typeof raw.uid === 'string' && raw.uid.trim() ? raw.uid.trim().slice(0, 128) : base.uid;
  base.kills = clampInt(raw.kills);
  base.headshots = Math.min(base.kills, clampInt(raw.headshots));
  base.matches = clampInt(raw.matches);
  base.rounds = clampInt(raw.rounds);
  base.wins = Math.min(base.matches, clampInt(raw.wins));
  if (raw.weaponKills && typeof raw.weaponKills === 'object' && !Array.isArray(raw.weaponKills)) {
    for (const [weapon, count] of Object.entries(raw.weaponKills)) {
      if (Object.hasOwn(WEAPONS, weapon)) {
        const clean = clampInt(count);
        if (clean > 0) base.weaponKills[weapon] = clean;
      }
    }
  }
  const s = raw.social && typeof raw.social === 'object' ? raw.social : {};
  base.social.followed = Boolean(s.followed);
  base.social.liked = Boolean(s.liked || s.tripled);
  base.social.coined = Boolean(s.coined || s.tripled);
  base.social.favorited = Boolean(s.favorited || s.tripled);
  base.social.tripled = Boolean(s.tripled || (base.social.liked && base.social.coined && base.social.favorited));
  base.social.checkedAt = clampInt(s.checkedAt, Number.MAX_SAFE_INTEGER);
  base.updatedAt = clampInt(raw.updatedAt, Number.MAX_SAFE_INTEGER);
  return base;
}

/**
 * Monotone union merge of local & Toy cloud saves so player kills, matches, and social unlocks
 * NEVER roll back across devices or reconnects.
 */
export function mergeProgress(localRaw, remoteRaw, uid = '') {
  const a = normalizeProgress(localRaw, uid);
  const b = normalizeProgress(remoteRaw, uid);
  const weaponKills = { ...a.weaponKills };
  for (const [w, count] of Object.entries(b.weaponKills)) {
    weaponKills[w] = Math.max(weaponKills[w] || 0, count);
  }
  const liked = a.social.liked || b.social.liked;
  const coined = a.social.coined || b.social.coined;
  const favorited = a.social.favorited || b.social.favorited;
  return {
    v: PROGRESSION_SCHEMA_VERSION,
    uid: uid || b.uid || a.uid || '',
    kills: Math.max(a.kills, b.kills),
    headshots: Math.max(a.headshots, b.headshots),
    matches: Math.max(a.matches, b.matches),
    rounds: Math.max(a.rounds, b.rounds),
    wins: Math.max(a.wins, b.wins),
    weaponKills,
    social: {
      followed: a.social.followed || b.social.followed,
      liked,
      coined,
      favorited,
      tripled: a.social.tripled || b.social.tripled || (liked && coined && favorited),
      checkedAt: Math.max(a.social.checkedAt, b.social.checkedAt),
    },
    updatedAt: Math.max(a.updatedAt, b.updatedAt),
  };
}

export function getSkinUnlockRequirement(skinId) {
  const skin = getSkin(skinId);
  if (!skin) return null;
  return skinRequirements.get(skin.id) || null;
}

export function getAgentUnlockRequirement(agentId) {
  const agent = getAgent(agentId);
  if (!agent) return null;
  return agentRequirements.get(agent.id) || null;
}

export function evaluateRequirement(req, progressRaw) {
  if (!req) return { unlocked: false, pct: 0, progressText: '未知物品', actionLabel: '未解锁' };
  const p = normalizeProgress(progressRaw);
  if (req.type === 'starter') {
    return { unlocked: true, pct: 100, progressText: '开局原厂基础装备', actionLabel: '已拥有' };
  }
  if (req.type === 'toy_follow') {
    const unlocked = p.social.followed;
    return {
      unlocked,
      pct: unlocked ? 100 : 0,
      progressText: unlocked ? '已关注 UP 主 · 已解锁' : '关注 UP 主即可免费解锁',
      actionLabel: unlocked ? '已解锁' : '关注 UP 主解锁',
    };
  }
  if (req.type === 'toy_triple') {
    const unlocked = p.social.tripled;
    const count = (p.social.liked ? 1 : 0) + (p.social.coined ? 1 : 0) + (p.social.favorited ? 1 : 0);
    const detail = `${p.social.liked ? '赞✓' : '赞○'} ${p.social.coined ? '币✓' : '币○'} ${p.social.favorited ? '藏✓' : '藏○'}`;
    return {
      unlocked,
      pct: unlocked ? 100 : Math.round((count / 3) * 100),
      progressText: unlocked ? '已完成一键三连 · 已解锁' : `一键三连解锁（${detail}）`,
      actionLabel: unlocked ? '已解锁' : '一键三连解锁',
    };
  }

  // Growth task evaluation
  const checks = [];
  if (req.weaponKills > 0 && req.weapon) {
    const wk = p.weaponKills[req.weapon] || 0;
    const wName = getWeapon(req.weapon)?.name || req.weapon;
    checks.push({
      done: wk >= req.weaponKills,
      ratio: Math.min(1, wk / req.weaponKills),
      text: `${wName} ${Math.min(wk, req.weaponKills)}/${req.weaponKills}`,
    });
  }
  if (req.kills > 0) {
    checks.push({
      done: p.kills >= req.kills,
      ratio: Math.min(1, p.kills / req.kills),
      text: `击杀 ${Math.min(p.kills, req.kills)}/${req.kills}`,
    });
  }
  if (req.matches > 0) {
    checks.push({
      done: p.matches >= req.matches,
      ratio: Math.min(1, p.matches / req.matches),
      text: `局数 ${Math.min(p.matches, req.matches)}/${req.matches}`,
    });
  }

  const unlocked = req.mode === 'and'
    ? checks.every((c) => c.done)
    : checks.some((c) => c.done);
  const pct = unlocked
    ? 100
    : req.mode === 'and'
      ? Math.round((checks.reduce((sum, c) => sum + c.ratio, 0) / Math.max(1, checks.length)) * 100)
      : Math.round(Math.max(0, ...checks.map((c) => c.ratio)) * 100);

  return {
    unlocked,
    pct,
    progressText: unlocked ? `已达成 · ${req.summary}` : checks.map((c) => c.text).join(req.mode === 'and' ? ' · ' : ' / '),
    actionLabel: unlocked ? '已解锁' : req.summary,
  };
}

export function isSkinUnlocked(skinId, progress) {
  const req = getSkinUnlockRequirement(skinId);
  return evaluateRequirement(req, progress).unlocked;
}

export function isAgentUnlocked(agentId, progress) {
  const req = getAgentUnlockRequirement(agentId);
  return evaluateRequirement(req, progress).unlocked;
}

/**
 * Normalize & gate a skin loadout against unlocked progression.
 * Any missing, invalid, or locked skin falls back to that weapon's vanilla starter model!
 */
export function enforceUnlockedSkinLoadout(input, progress) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const result = {};
  for (const [weapon, starterId] of Object.entries(STARTER_SKINS)) {
    const candidate = getSkin(value[weapon]);
    if (candidate && candidate.weapon === weapon && isSkinUnlocked(candidate.id, progress)) {
      result[weapon] = candidate.id;
    } else {
      result[weapon] = starterId;
    }
  }
  return result;
}

/**
 * Normalize & gate an agent loadout against unlocked progression.
 * Any missing, wrong-team, or locked agent falls back to ct-sas / t-phoenix!
 */
export function enforceUnlockedAgentLoadout(input, progress) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const result = {};
  for (const [team, starterId] of Object.entries(STARTER_AGENTS)) {
    const candidate = getAgent(value[team]);
    if (candidate && candidate.team === team && isAgentUnlocked(candidate.id, progress)) {
      result[team] = candidate.id;
    } else {
      result[team] = starterId;
    }
  }
  return result;
}

/** Compute career XP, level (1..30), and tactical rank title. */
const RANK_TITLES = [
  [1, '列兵新秀'],
  [3, '见习干员'],
  [6, '突击队员'],
  [10, '战术专家'],
  [14, '精英射手'],
  [18, '王牌特勤'],
  [23, '战区指挥官'],
  [28, '传奇战神'],
];

export function computeCareerLevel(progressRaw) {
  const p = normalizeProgress(progressRaw);
  const xp = p.kills * 25 + p.headshots * 15 + p.rounds * 20 + p.matches * 120 + p.wins * 80;
  let level = 1;
  let floorXp = 0;
  let stepXp = 600;
  while (level < 30 && xp >= floorXp + stepXp) {
    floorXp += stepXp;
    level++;
    stepXp = Math.round(600 + (level - 1) * 260);
  }
  const intoLevel = xp - floorXp;
  const pct = level >= 30 ? 100 : Math.min(100, Math.round((intoLevel / stepXp) * 100));
  let rankTitle = RANK_TITLES[0][1];
  for (const [minLv, title] of RANK_TITLES) {
    if (level >= minLv) rankTitle = title;
  }
  return { xp, level, rankTitle, intoLevel, stepXp, pct };
}

export function countUnlockedSummary(progress) {
  let skinsUnlocked = 0;
  let agentsUnlocked = 0;
  for (const skin of SKINS) if (isSkinUnlocked(skin.id, progress)) skinsUnlocked++;
  for (const agent of AGENT_CATALOG) if (isAgentUnlocked(agent.id, progress)) agentsUnlocked++;
  return {
    skinsUnlocked,
    skinsTotal: SKINS.length,
    agentsUnlocked,
    agentsTotal: AGENT_CATALOG.length,
  };
}

/** Find newly unlocked skins and agents between two progress snapshots. */
export function diffNewUnlocks(beforeProgress, afterProgress) {
  const skins = [];
  const agents = [];
  for (const skin of SKINS) {
    if (!isSkinUnlocked(skin.id, beforeProgress) && isSkinUnlocked(skin.id, afterProgress)) {
      skins.push(skin);
    }
  }
  for (const agent of AGENT_CATALOG) {
    if (!isAgentUnlocked(agent.id, beforeProgress) && isAgentUnlocked(agent.id, afterProgress)) {
      agents.push(agent);
    }
  }
  return { skins, agents };
}
