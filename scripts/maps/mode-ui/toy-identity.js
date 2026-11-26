/**
 * Bilibili Toy SDK identity, social interaction (follow & triple), and cloud bridge for 随时随地CS.
 * Zero UGC player input: automatically resolves player OpenID & callsign from
 * window.toy (https://s1.hdslb.com/bfs/seed/toy/app/sdk/toy-sdk.js) when
 * running on Toy, or assigns a deterministic local operator ID outside Toy.
 */
const SDK_URL = 'https://s1.hdslb.com/bfs/seed/toy/app/sdk/toy-sdk.js';
const IDENTITY_KEY = 'cs.toy.identity.v1';
const GUEST_ID_KEY = 'cs.toy.guest-id.v1';
const loaders = new WeakMap();

function safeStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

function isToyURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (
      url.hostname === 'www.bilibilitoy.com' ||
      url.hostname.endsWith('.bilibilitoy.com') ||
      ((url.hostname === 'bilibili.com' || url.hostname.endsWith('.bilibili.com')) && /^\/toy(?:\/|$)/.test(url.pathname))
    );
  } catch {
    return false;
  }
}

export function isToyEnvironment(win = globalThis.window, doc = globalThis.document) {
  if (win?.toy) return true;
  return [win?.location?.href, doc?.referrer, ...Array.from(win?.location?.ancestorOrigins ?? [])].some(isToyURL);
}

export function loadToySDK(win = globalThis.window, doc = globalThis.document) {
  if (win?.toy) return Promise.resolve(win.toy);
  if (!doc?.createElement) return Promise.reject(new Error('document unavailable'));
  if (loaders.has(doc)) return loaders.get(doc);
  const promise = new Promise((resolve, reject) => {
    const script = doc.createElement('script');
    const finish = (err) => {
      clearTimeout(timer);
      script.onload = script.onerror = null;
      if (err) { script.remove(); reject(err); }
      else resolve(win.toy);
    };
    const timer = setTimeout(() => finish(new Error('Toy SDK timeout')), 12000);
    script.src = SDK_URL;
    script.async = true;
    script.onload = () => finish(win.toy ? null : new Error('Toy SDK unavailable'));
    script.onerror = () => finish(new Error('Toy SDK load failed'));
    try { (doc.head ?? doc.documentElement).appendChild(script); } catch (err) { finish(err); }
  });
  loaders.set(doc, promise);
  promise.catch(() => loaders.delete(doc));
  return promise;
}

function cleanText(value, maxLen = 20) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, maxLen);
}

function shortOpenId(openId) {
  const clean = String(openId || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  if (!clean) return '0000';
  return clean.slice(-6);
}

function getOrCreateGuestIdentity(storage = safeStorage()) {
  let code = '';
  try {
    const saved = storage?.getItem(GUEST_ID_KEY);
    if (saved && /^[A-Z0-9]{4,8}$/.test(saved)) code = saved;
  } catch {}
  if (!code) {
    const bytes = new Uint8Array(3);
    if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    code = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('').toUpperCase().slice(0, 5);
    try { storage?.setItem(GUEST_ID_KEY, code); } catch {}
  }
  return {
    source: 'guest',
    authenticated: false,
    inToy: false,
    status: 'ready',
    uid: 'GUEST-' + code,
    shortId: code,
    displayName: '干员#' + code,
    avatar: '',
    loginRequired: false,
    message: '本地试玩干员 ID（接入 B站 Toy 后自动读取平台身份与云存档）',
  };
}

function readCachedIdentity(storage = safeStorage()) {
  try {
    const raw = storage?.getItem(IDENTITY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.displayName === 'string' && parsed.displayName.trim()) return parsed;
  } catch {}
  return null;
}

function saveIdentity(state, storage = safeStorage()) {
  try {
    storage?.setItem(IDENTITY_KEY, JSON.stringify({
      source: state.source,
      uid: state.uid,
      shortId: state.shortId,
      displayName: state.displayName,
      avatar: state.avatar || '',
    }));
  } catch {}
}

/** Robustly parse Bilibili Toy SDK getAuthorRelation() payload across platform/version shapes. */
export function parseAuthorFollowResult(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, followed: false, status: 'unavailable' };
  const status = typeof raw.status === 'string' ? raw.status : 'ok';
  const payload = raw.data && typeof raw.data === 'object' ? raw.data : raw;
  const rel = payload.relation && typeof payload.relation === 'object' ? payload.relation : payload;
  const followed = Boolean(
    rel.followed === true ||
    rel.isFollowed === true ||
    rel.isFollowing === true ||
    rel.following === true ||
    rel.isFollow === true ||
    rel.is_follow === true ||
    rel.is_following === true ||
    rel.follow === true ||
    Number(rel.attribute) === 2 ||
    Number(rel.attribute) === 6 ||
    Number(rel.relation) === 2 ||
    Number(rel.relation) === 6,
  );
  return {
    ok: status === 'ok' || followed || Boolean(payload.followed !== undefined || payload.isFollowing !== undefined || payload.isFollowed !== undefined),
    followed,
    status,
  };
}

/** Robustly parse Bilibili Toy SDK getVideoUserActions() payload for like + coin + favorite (一键三连). */
export function parseVideoActionsResult(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, liked: false, coined: false, favorited: false, tripled: false, status: 'unavailable' };
  }
  const status = typeof raw.status === 'string' ? raw.status : 'ok';
  const payload = raw.data && typeof raw.data === 'object' ? raw.data : raw;
  const list = Array.isArray(payload.items)
    ? payload.items
    : Array.isArray(payload.videos)
      ? payload.videos
      : Array.isArray(payload.list)
        ? payload.list
        : Array.isArray(payload)
          ? payload
          : Object.values(payload).filter((v) => v && typeof v === 'object' && !Array.isArray(v));

  let best = { liked: false, coined: false, favorited: false, tripled: false, score: -1 };
  for (const item of list) {
    const act = item.actions && typeof item.actions === 'object' ? item.actions : item;
    const liked = Boolean(act.liked === true || act.like === true || act.isLiked === true || act.is_liked === true || Number(act.like) > 0);
    const coined = Boolean(act.coined === true || act.coin === true || act.isCoined === true || act.is_coined === true || Number(act.coin) > 0 || Number(act.coins) > 0 || Number(act.coinCount) > 0);
    const favorited = Boolean(act.favorited === true || act.fav === true || act.favorite === true || act.isFavorited === true || act.is_favorited === true || act.collected === true || Number(act.fav) > 0);
    const tripled = Boolean(act.tripled === true || act.isTriple === true || (liked && coined && favorited));
    const score = (tripled ? 10 : 0) + (liked ? 1 : 0) + (coined ? 1 : 0) + (favorited ? 1 : 0);
    if (score > best.score) best = { liked: liked || tripled, coined: coined || tripled, favorited: favorited || tripled, tripled, score };
  }
  return {
    ok: status === 'ok' || list.length > 0,
    liked: best.liked,
    coined: best.coined,
    favorited: best.favorited,
    tripled: best.tripled,
    status,
  };
}

function extractVideoRefs(raw) {
  const payload = raw?.data && typeof raw.data === 'object' ? raw.data : raw;
  const list = Array.isArray(payload?.items)
    ? payload.items
    : Array.isArray(payload?.videos)
      ? payload.videos
      : Array.isArray(payload?.list)
        ? payload.list
        : Array.isArray(payload)
          ? payload
          : [];
  const aids = [];
  const videos = [];
  for (const item of list) {
    const aid = Number(item?.aid ?? item?.avid);
    const bvid = typeof item?.bvid === 'string' && /^BV1[0-9A-Za-z]{9}$/.test(item.bvid) ? item.bvid : '';
    if (Number.isSafeInteger(aid) && aid > 0) aids.push(aid);
    else if (bvid) videos.push({ bvid });
  }
  return { aids: [...new Set(aids)].slice(0, 50), videos: videos.slice(0, 50) };
}

export class ToyIdentity extends EventTarget {
  constructor({ sdk = null, window = globalThis.window ?? globalThis, document = globalThis.document, storage = safeStorage() } = {}) {
    super();
    this._sdk = sdk;
    this._window = window;
    this._document = document;
    this._storage = storage;
    this._inToy = !!sdk || isToyEnvironment(window, document);
    this._authorProfile = null;
    this._authorVideos = null;
    const cached = readCachedIdentity(storage);
    const fallback = getOrCreateGuestIdentity(storage);
    this._state = Object.freeze(
      this._inToy
        ? {
            source: 'toy',
            authenticated: false,
            inToy: true,
            status: 'loading',
            uid: cached?.source === 'toy' ? cached.uid : null,
            shortId: cached?.source === 'toy' ? cached.shortId : '----',
            displayName: cached?.source === 'toy' ? cached.displayName : '连接 Toy 身份…',
            avatar: cached?.source === 'toy' ? (cached.avatar || '') : '',
            loginRequired: false,
            message: '正在通过 Toy SDK 获取玩家身份…',
          }
        : fallback
    );
    this._pending = null;
  }

  get state() { return this._state; }
  get isToy() { return this._inToy; }
  get sdk() { return this._sdk; }
  get playerName() { return this._state.displayName; }
  get uid() { return this._state.uid; }

  _update(patch) {
    this._state = Object.freeze({ ...this._state, ...patch });
    if (this._state.uid && this._state.displayName) saveIdentity(this._state, this._storage);
    this.dispatchEvent(new Event('change'));
    return this._state;
  }

  async ensureSdk() {
    if (!this._inToy) return null;
    if (this._sdk) return this._sdk;
    this._sdk = await loadToySDK(this._window, this._document);
    return this._sdk;
  }

  async init({ explicit = false } = {}) {
    if (!this._inToy) {
      saveIdentity(this._state, this._storage);
      return this._state;
    }
    if (this._pending) return this._pending;
    this._pending = (async () => {
      this._update({ status: 'authorizing', loginRequired: false, message: '正在获取 Toy 玩家 ID…' });
      try {
        const sdk = await this.ensureSdk();
        const user = await sdk.getUserProfile();
        const openId = cleanText(user?.toyOpenId ?? user?.openId ?? user?.uid, 128);
        const shortId = shortOpenId(openId);
        const nickname = cleanText(user?.nickname ?? user?.name, 18) || ('干员#' + shortId);
        const avatar = typeof user?.avatar === 'string' && /^https?:\/\//i.test(user.avatar) ? user.avatar : '';
        if (!openId) throw Object.assign(new Error('toy id not available'), { type: 'not_logged_in' });
        return this._update({
          source: 'toy',
          authenticated: true,
          inToy: true,
          status: 'ready',
          uid: openId,
          shortId,
          displayName: nickname,
          avatar,
          loginRequired: false,
          message: 'Toy SDK 身份已同步',
        });
      } catch (error) {
        const needsLogin = error?.type === 'not_logged_in' ||
          String(error?.code ?? '') === '-101' ||
          error?.type === 'user_denied' ||
          String(error?.message || '').includes('unauthorized') ||
          String(error?.message || '').includes('toy id not available');
        const guest = getOrCreateGuestIdentity(this._storage);
        return this._update({
          source: 'toy',
          authenticated: false,
          inToy: true,
          status: 'error',
          uid: this._state.uid || guest.uid,
          shortId: this._state.shortId !== '----' ? this._state.shortId : guest.shortId,
          displayName: this._state.uid ? this._state.displayName : guest.displayName,
          loginRequired: needsLogin,
          message: explicit
            ? (needsLogin ? '请在 B站 Toy 弹窗中完成登录与身份授权' : 'Toy 身份获取失败，点击重试')
            : '点击授权 B站 Toy 身份',
        });
      }
    })().finally(() => { this._pending = null; });
    return this._pending;
  }

  authorize() {
    return this.init({ explicit: true });
  }

  async getAuthorProfile() {
    if (this._authorProfile) return this._authorProfile;
    const sdk = await this.ensureSdk();
    if (!sdk?.getAuthorProfile) return null;
    try {
      this._authorProfile = await sdk.getAuthorProfile();
      return this._authorProfile;
    } catch {
      return null;
    }
  }

  /** Check whether the current Bilibili Toy user follows the Toy creator (关注 UP 主). */
  async checkAuthorFollow() {
    if (!this._inToy) {
      return { ok: false, followed: false, status: 'outside_toy', message: '需在 B站 Toy 平台内验证关注状态' };
    }
    try {
      const sdk = await this.ensureSdk();
      if (!sdk?.getAuthorRelation) {
        return { ok: false, followed: false, status: 'unsupported', message: '当前 Toy 容器不支持关注查询' };
      }
      if (typeof sdk.isSupport === 'function') {
        const supported = await sdk.isSupport('getAuthorRelation').catch(() => true);
        if (!supported) {
          return { ok: false, followed: false, status: 'unsupported', message: '请升级 B站 App 或在正式 Toy 页面验证关注' };
        }
      }
      const raw = await sdk.getAuthorRelation();
      const parsed = parseAuthorFollowResult(raw);
      return {
        ...parsed,
        message: parsed.followed
          ? '已确认关注 UP 主，关注专属皮肤与探员已解锁！'
          : parsed.status === 'unauthorized'
            ? '请先在 B站 登录账号后再验证关注'
            : '尚未检测到关注 UP 主，关注后点击刷新即可秒解锁',
      };
    } catch (error) {
      return {
        ok: false,
        followed: false,
        status: error?.type || 'error',
        message: '关注状态检测失败，请确认已在 B站 Toy 内登录',
      };
    }
  }

  /**
   * Check whether the current Bilibili Toy user completed Triple (一键三连：点赞+投币+收藏)
   * on configured videos or any recent video published by the Toy author.
   */
  async checkAuthorTriple({ videos = null, aids = null } = {}) {
    if (!this._inToy) {
      return {
        ok: false,
        liked: false,
        coined: false,
        favorited: false,
        tripled: false,
        status: 'outside_toy',
        message: '需在 B站 Toy 平台内验证一键三连',
      };
    }
    try {
      const sdk = await this.ensureSdk();
      if (!sdk?.getVideoUserActions) {
        return {
          ok: false,
          liked: false,
          coined: false,
          favorited: false,
          tripled: false,
          status: 'unsupported',
          message: '当前 Toy 容器不支持视频互动检测',
        };
      }
      if (typeof sdk.isSupport === 'function') {
        const supported = await sdk.isSupport('getVideoUserActions').catch(() => true);
        if (!supported) {
          return {
            ok: false,
            liked: false,
            coined: false,
            favorited: false,
            tripled: false,
            status: 'unsupported',
            message: '请在 B站 App 或正式 Toy 页面验证三连',
          };
        }
      }

      // 1. Resolve target videos: explicit param -> runtime config -> URL query ?bvid= -> author recent videos via SDK
      let targetAids = Array.isArray(aids) && aids.length ? aids : [];
      let targetVideos = Array.isArray(videos) && videos.length ? videos : [];

      if (!targetAids.length && !targetVideos.length) {
        const cfg = this._window?.__TOY_SOCIAL_CONFIG__;
        if (Array.isArray(cfg?.aids) && cfg.aids.length) targetAids = cfg.aids;
        else if (Array.isArray(cfg?.videos) && cfg.videos.length) targetVideos = cfg.videos;
      }
      if (!targetAids.length && !targetVideos.length) {
        try {
          const bvid = new URLSearchParams(this._window?.location?.search || '').get('bvid');
          if (bvid && /^BV1[0-9A-Za-z]{9}$/.test(bvid)) targetVideos = [{ bvid }];
        } catch {}
      }
      if (!targetAids.length && !targetVideos.length && sdk.getAuthorVideoRange) {
        if (!this._authorVideos) {
          const nowSec = Math.floor(Date.now() / 1000);
          const rangeResp = await sdk.getAuthorVideoRange({
            start: nowSec - 360 * 24 * 60 * 60,
            end: nowSec,
          }).catch(() => null);
          this._authorVideos = extractVideoRefs(rangeResp);
        }
        targetAids = this._authorVideos?.aids || [];
        targetVideos = this._authorVideos?.videos || [];
      }

      if (!targetAids.length && !targetVideos.length) {
        return {
          ok: false,
          liked: false,
          coined: false,
          favorited: false,
          tripled: false,
          status: 'no_videos',
          message: '未找到关联 UP 主稿件，请前往 UP 主主页或视频完成三连后重试',
        };
      }

      const raw = targetAids.length
        ? await sdk.getVideoUserActions({ aids: targetAids.slice(0, 50) })
        : await sdk.getVideoUserActions({ videos: targetVideos.slice(0, 50) });
      const parsed = parseVideoActionsResult(raw);
      const stepLabel = `${parsed.liked ? '点赞✓' : '点赞○'} · ${parsed.coined ? '投币✓' : '投币○'} · ${parsed.favorited ? '收藏✓' : '收藏○'}`;
      return {
        ...parsed,
        message: parsed.tripled
          ? '已确认一键三连，三连专属顶级皮肤、蝴蝶刀与探员已解锁！'
          : `当前互动进度：${stepLabel}（完成点赞+投币+收藏后点击刷新）`,
      };
    } catch (error) {
      return {
        ok: false,
        liked: false,
        coined: false,
        favorited: false,
        tripled: false,
        status: error?.type || 'error',
        message: '三连检测失败，请确认已在 B站 Toy 内登录',
      };
    }
  }

  /** Jump to Toy author's Bilibili space or featured video using official toy.navigate() (requires user gesture). */
  async openAuthorSpace() {
    const sdk = await this.ensureSdk();
    if (!sdk?.navigate) return false;
    try {
      const profile = await this.getAuthorProfile();
      const mid = Number(profile?.mid ?? profile?.uid ?? 0);
      if (mid > 0) {
        await sdk.navigate({ type: 'space', mid });
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  async openAuthorVideo() {
    const sdk = await this.ensureSdk();
    if (!sdk?.navigate) return false;
    try {
      if (!this._authorVideos && sdk.getAuthorVideoRange) {
        const nowSec = Math.floor(Date.now() / 1000);
        const resp = await sdk.getAuthorVideoRange({ start: nowSec - 360 * 24 * 60 * 60, end: nowSec }).catch(() => null);
        this._authorVideos = extractVideoRefs(resp);
      }
      const bvid = this._authorVideos?.videos?.[0]?.bvid;
      const aid = this._authorVideos?.aids?.[0];
      if (bvid) { await sdk.navigate({ type: 'video', bvid }); return true; }
      if (aid) { await sdk.navigate({ type: 'video', aid }); return true; }
      return false;
    } catch {
      return false;
    }
  }
}

export function getStoredOperatorName() {
  const cached = readCachedIdentity();
  if (cached?.displayName) return cached.displayName;
  return getOrCreateGuestIdentity().displayName;
}

export function getStoredOperatorUid() {
  const cached = readCachedIdentity();
  if (cached?.uid) return cached.uid;
  return getOrCreateGuestIdentity().uid;
}
