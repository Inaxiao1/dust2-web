/**
 * Extensible reward & mailbox abstraction for announcements, skins, knives, agents, XP,
 * bundles, and arbitrary future virtual items (badges, currency, collectibles, tokens, etc.).
 *
 * Pure ES module with zero DOM dependencies so it runs identically in Node server validation,
 * automated tests, lobby UI, and in-match progression stores.
 */
import { getSkin } from './skins.js';
import { getAgent } from './agents.js';
import { getWeapon } from './weapons.js';

export const MAIL_CATEGORIES = Object.freeze({
  announcement: { id: 'announcement', label: '公告', accent: 'blue' },
  reward:       { id: 'reward',       label: '奖励', accent: 'gold' },
  event:        { id: 'event',        label: '活动', accent: 'gold' },
  compensation: { id: 'compensation', label: '补偿', accent: 'emerald' },
});

const VALID_CATEGORIES = new Set(Object.keys(MAIL_CATEGORIES));
const VALID_ITEM_CATEGORIES = new Set(['badge', 'title', 'currency', 'consumable', 'collectible', 'misc']);

function cleanStr(raw, maxLen = 120) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, maxLen);
}

function cleanPositiveInt(raw, max = 1000000, fallback = 1) {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 ? Math.min(max, n) : fallback;
}

function cleanSafeUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  const s = raw.trim().slice(0, 300);
  if (/^(?:https?:\/\/|\/|assets\/|\.\/)/i.test(s) && !/[\s"'<>]/.test(s)) return s;
  return '';
}

/**
 * Normalize a single abstract reward grant.
 * Supported types:
 *  - skin:   { type: 'skin', skinId }
 *  - agent:  { type: 'agent', agentId }
 *  - xp:     { type: 'xp', amount }
 *  - item:   { type: 'item', itemId, title, description?, category?, quantity?, icon?, previewUrl?, meta? }
 *  - bundle: { type: 'bundle', title?, items: RewardGrant[] }
 */
export function normalizeRewardGrant(raw, depth = 0) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || depth > 3) return null;
  const type = cleanStr(raw.type, 24).toLowerCase();
  if (type === 'skin') {
    const skin = getSkin(raw.skinId || raw.id);
    if (!skin) return null;
    return Object.freeze({ type: 'skin', skinId: skin.id });
  }
  if (type === 'agent') {
    const agent = getAgent(raw.agentId || raw.id);
    if (!agent) return null;
    return Object.freeze({ type: 'agent', agentId: agent.id });
  }
  if (type === 'xp') {
    const amount = cleanPositiveInt(raw.amount ?? raw.quantity, 500000, 0);
    if (amount <= 0) return null;
    return Object.freeze({ type: 'xp', amount });
  }
  if (type === 'item') {
    const itemId = cleanStr(raw.itemId || raw.id, 64).replace(/[^a-zA-Z0-9_.:-]/g, '');
    const title = cleanStr(raw.title || raw.name, 48);
    if (!itemId || !title) return null;
    const rawCat = cleanStr(raw.category, 20).toLowerCase();
    const category = VALID_ITEM_CATEGORIES.has(rawCat) ? rawCat : 'misc';
    const quantity = cleanPositiveInt(raw.quantity ?? raw.amount, 999999, 1);
    const description = cleanStr(raw.description || '', 160);
    const icon = cleanStr(raw.icon || '', 16);
    const previewUrl = cleanSafeUrl(raw.previewUrl || raw.image || '');
    const meta = raw.meta && typeof raw.meta === 'object' && !Array.isArray(raw.meta)
      ? Object.freeze(Object.fromEntries(
          Object.entries(raw.meta)
            .slice(0, 8)
            .filter(([k, v]) => typeof k === 'string' && k.length <= 32 && ['string', 'number', 'boolean'].includes(typeof v))
            .map(([k, v]) => [k, typeof v === 'string' ? cleanStr(v, 80) : v]),
        ))
      : null;
    return Object.freeze({
      type: 'item',
      itemId,
      title,
      category,
      quantity,
      ...(description ? { description } : {}),
      ...(icon ? { icon } : {}),
      ...(previewUrl ? { previewUrl } : {}),
      ...(meta && Object.keys(meta).length ? { meta } : {}),
    });
  }
  if (type === 'bundle') {
    if (!Array.isArray(raw.items)) return null;
    const items = raw.items.slice(0, 24).map((child) => normalizeRewardGrant(child, depth + 1)).filter(Boolean);
    if (!items.length) return null;
    const title = cleanStr(raw.title || raw.name || '礼盒礼包', 48);
    return Object.freeze({ type: 'bundle', title, items: Object.freeze(items) });
  }
  return null;
}

export function flattenRewardGrants(grants) {
  if (!Array.isArray(grants)) return [];
  const out = [];
  for (const raw of grants) {
    const g = normalizeRewardGrant(raw);
    if (!g) continue;
    if (g.type === 'bundle') out.push(...flattenRewardGrants(g.items));
    else out.push(g);
  }
  return out;
}

export function normalizeMailRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = cleanStr(raw.id, 64).replace(/[^a-zA-Z0-9_.:-]/g, '');
  const title = cleanStr(raw.title, 80);
  const body = cleanStr(raw.body || raw.content || '', 2400);
  if (!id || !title) return null;
  const rawCat = cleanStr(raw.category, 24).toLowerCase();
  const category = VALID_CATEGORIES.has(rawCat) ? rawCat : (Array.isArray(raw.rewards) && raw.rewards.length ? 'reward' : 'announcement');
  const sender = cleanStr(raw.sender || '随时随地CS 运营组', 40) || '随时随地CS 运营组';
  const createdAt = Number.isFinite(Number(raw.createdAt)) && Number(raw.createdAt) > 0
    ? Math.floor(Number(raw.createdAt))
    : Date.now();
  const startsAt = Number.isFinite(Number(raw.startsAt)) && Number(raw.startsAt) > 0 ? Math.floor(Number(raw.startsAt)) : 0;
  const expiresAt = Number.isFinite(Number(raw.expiresAt)) && Number(raw.expiresAt) > 0 ? Math.floor(Number(raw.expiresAt)) : 0;
  const targetUids = Array.isArray(raw.targetUids)
    ? [...new Set(raw.targetUids.map((u) => cleanStr(String(u || ''), 128)).filter(Boolean))].slice(0, 500)
    : [];
  const target = raw.target === 'uids' || targetUids.length > 0 ? 'uids' : 'all';
  const rewards = Array.isArray(raw.rewards)
    ? raw.rewards.slice(0, 24).map((g) => normalizeRewardGrant(g)).filter(Boolean)
    : [];
  return Object.freeze({
    id,
    title,
    body,
    category,
    sender,
    createdAt,
    ...(startsAt ? { startsAt } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    pinned: raw.pinned === true,
    target,
    ...(targetUids.length ? { targetUids: Object.freeze(targetUids) } : {}),
    rewards: Object.freeze(rewards),
  });
}

/**
 * Resolve display metadata (including real preview image URLs) for any RewardGrant.
 * Works for skins, knives, agents, XP, and future generic items.
 */
export function describeRewardGrant(grant, { skinPreview = null, agentPreview = null, assetUrl = (p) => p, owned = null } = {}) {
  const g = normalizeRewardGrant(grant);
  if (!g) return null;
  if (g.type === 'skin') {
    const skin = getSkin(g.skinId);
    const weapon = getWeapon(skin?.weapon);
    const isKnife = skin?.weapon === 'knife';
    const previewImage = skin ? (typeof skinPreview === 'function' ? skinPreview(skin) : (skin.preview ? assetUrl(skin.preview) : '')) : '';
    return {
      type: 'skin',
      key: `skin:${g.skinId}`,
      title: skin?.name?.replace(' · 原厂涂装', '') || g.skinId,
      subtitle: isKnife ? '近战匕首' : (weapon?.name || skin?.weapon || '武器皮肤'),
      badge: isKnife ? '匕首' : '皮肤',
      rarity: isKnife ? 'gold' : 'blue',
      previewImage,
      quantity: 1,
      alreadyOwned: owned?.skins ? owned.skins.has(g.skinId) : false,
    };
  }
  if (g.type === 'agent') {
    const agent = getAgent(g.agentId);
    const previewImage = agent ? (typeof agentPreview === 'function' ? agentPreview(agent) : (agent.preview?.file ? assetUrl(agent.preview.file) : '')) : '';
    return {
      type: 'agent',
      key: `agent:${g.agentId}`,
      title: agent?.name || g.agentId,
      subtitle: agent?.team === 'T' ? 'T 阵营探员' : 'CT 阵营探员',
      badge: '探员',
      rarity: agent?.team === 'T' ? 'gold' : 'blue',
      previewImage,
      quantity: 1,
      alreadyOwned: owned?.agents ? owned.agents.has(g.agentId) : false,
    };
  }
  if (g.type === 'xp') {
    return {
      type: 'xp',
      key: `xp:${g.amount}`,
      title: `${g.amount} 生涯经验`,
      subtitle: '成长等级经验加成',
      badge: '经验',
      rarity: 'emerald',
      previewImage: '',
      glyph: 'XP',
      quantity: g.amount,
      alreadyOwned: false,
    };
  }
  if (g.type === 'item') {
    const catLabels = { badge: '徽章', title: '称号', currency: '货币', consumable: '道具', collectible: '收藏', misc: '物品' };
    return {
      type: 'item',
      key: `item:${g.itemId}`,
      title: g.title,
      subtitle: g.description || (catLabels[g.category] || '专属物品'),
      badge: catLabels[g.category] || '物品',
      rarity: 'gold',
      previewImage: g.previewUrl ? assetUrl(g.previewUrl) : '',
      glyph: g.icon || 'ITEM',
      quantity: g.quantity,
      alreadyOwned: false,
    };
  }
  return null;
}

/**
 * Apply flattened rewards into a mutable normalized progress object.
 * Designed to be extensible via REWARD_APPLIERS so future reward types plug in cleanly.
 */
const REWARD_APPLIERS = Object.freeze({
  skin(progress, grant, summary) {
    if (!progress.grantedSkins.includes(grant.skinId)) {
      progress.grantedSkins.push(grant.skinId);
      summary.skins.push(grant.skinId);
    } else {
      summary.duplicates.push(`skin:${grant.skinId}`);
    }
  },
  agent(progress, grant, summary) {
    if (!progress.grantedAgents.includes(grant.agentId)) {
      progress.grantedAgents.push(grant.agentId);
      summary.agents.push(grant.agentId);
    } else {
      summary.duplicates.push(`agent:${grant.agentId}`);
    }
  },
  xp(progress, grant, summary) {
    progress.bonusXp = Math.min(10000000, (progress.bonusXp || 0) + grant.amount);
    summary.xp += grant.amount;
  },
  item(progress, grant, summary, now) {
    const prev = progress.customItems[grant.itemId];
    progress.customItems[grant.itemId] = {
      id: grant.itemId,
      title: grant.title,
      category: grant.category,
      quantity: Math.min(999999, (prev?.quantity || 0) + grant.quantity),
      ...(grant.description ? { description: grant.description } : prev?.description ? { description: prev.description } : {}),
      ...(grant.icon ? { icon: grant.icon } : prev?.icon ? { icon: prev.icon } : {}),
      ...(grant.previewUrl ? { previewUrl: grant.previewUrl } : prev?.previewUrl ? { previewUrl: prev.previewUrl } : {}),
      acquiredAt: prev?.acquiredAt || now,
    };
    summary.items.push({ id: grant.itemId, title: grant.title, quantity: grant.quantity });
  },
});

export function applyRewardsToProgress(progress, grants, now = Date.now()) {
  const flat = flattenRewardGrants(grants);
  const summary = { skins: [], agents: [], xp: 0, items: [], duplicates: [] };
  for (const grant of flat) {
    const handler = REWARD_APPLIERS[grant.type];
    if (handler) handler(progress, grant, summary, now);
  }
  return summary;
}

export function mailHasClaimableRewards(mail, progress) {
  if (!mail || !Array.isArray(mail.rewards) || mail.rewards.length === 0) return false;
  const claimed = Array.isArray(progress?.claimedMailIds) ? progress.claimedMailIds : [];
  return !claimed.includes(mail.id);
}

export function mailNeedsAttention(mail, progress) {
  if (!mail) return false;
  if (mailHasClaimableRewards(mail, progress)) return true;
  const read = Array.isArray(progress?.readMailIds) ? progress.readMailIds : [];
  return !read.includes(mail.id);
}

export function countMailboxBadges(mails, progress) {
  let unread = 0;
  let unclaimed = 0;
  let attention = 0;
  const readSet = new Set(Array.isArray(progress?.readMailIds) ? progress.readMailIds : []);
  const claimedSet = new Set(Array.isArray(progress?.claimedMailIds) ? progress.claimedMailIds : []);
  for (const mail of Array.isArray(mails) ? mails : []) {
    if (!mail?.id) continue;
    const isUnclaimed = Array.isArray(mail.rewards) && mail.rewards.length > 0 && !claimedSet.has(mail.id);
    const isUnread = !readSet.has(mail.id);
    if (isUnclaimed) unclaimed++;
    if (isUnread) unread++;
    if (isUnclaimed || isUnread) attention++;
  }
  return { unread, unclaimed, attention };
}
