export const OFFICIAL_TOY_SDK_URL = 'https://s1.hdslb.com/bfs/seed/toy/app/sdk/toy-sdk.js';

export const CLOUD_KEY_PROGRESS = 'cs_prog_v1';
export const CLOUD_KEY_LOADOUT = 'cs_loadout_v1';

export interface ToyUserProfile {
  nickname: string;
  openId: string | null;
  avatar?: string;
}

export interface ToySocialStatus {
  followed: boolean;
  liked: boolean;
  coined: boolean;
  favorited: boolean;
  tripled: boolean;
}

export interface ToySdkApi {
  isSupport?: (ability: string) => Promise<boolean>;
  getUserProfile?: () => Promise<{ nickname?: string; name?: string; toyOpenId?: string; openId?: string; uid?: string; avatar?: string }>;
  getAuthorProfile?: () => Promise<{ mid?: number; uid?: number; name?: string; uname?: string }>;
  getAuthorRelation?: () => Promise<Record<string, unknown>>;
  getAuthorVideoRange?: (params?: { start?: number; end?: number }) => Promise<Record<string, unknown>>;
  getVideoUserActions?: (params: { aids?: number[]; videos?: Array<{ aid?: number; bvid?: string }> }) => Promise<Record<string, unknown>>;
  navigate?: (params: { type: 'video' | 'space' | 'toy' | 'search' | 'opus' | 'tribee' | 'topic'; mid?: number; aid?: number; bvid?: string }) => Promise<void>;
  getCloudStorage?: (keys: string[]) => Promise<Record<string, string>>;
  setCloudStorage?: (entries: Record<string, string>) => Promise<void>;
  submitScore?: (params: { board: number; score: number }) => Promise<void>;
}

export interface ToyRateLimitError {
  type?: string;
  code?: number;
  message?: string;
}

export function isToyHost(loc: { hostname?: string } | undefined = globalThis.location): boolean {
  const host = (loc?.hostname ?? '').toLowerCase();
  if (host === 'www.bilibilitoy.com' || host.endsWith('.bilibilitoy.com')) return true;
  return typeof (globalThis as { toy?: unknown }).toy === 'object' && (globalThis as { toy?: unknown }).toy !== null;
}

export function isToyRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as ToyRateLimitError;
  return err.type === 'http_error' && err.code === 307044;
}

let sdkLoadPromise: Promise<ToySdkApi | null> | null = null;

/**
 * Loads the official Toy SDK only when executing inside the Bilibili Toy host.
 * Local development and standalone web builds bypass SDK script injection cleanly.
 */
export async function loadToySdk(doc: Document | undefined = globalThis.document): Promise<ToySdkApi | null> {
  if (!isToyHost()) return null;
  const existing = (globalThis as { toy?: ToySdkApi }).toy;
  if (existing) return existing;
  if (!doc) return null;
  if (!sdkLoadPromise) {
    sdkLoadPromise = new Promise<ToySdkApi | null>(resolve => {
      const script = doc.createElement('script');
      script.src = OFFICIAL_TOY_SDK_URL;
      script.async = true;
      script.onload = () => resolve((globalThis as { toy?: ToySdkApi }).toy ?? null);
      script.onerror = () => resolve(null);
      doc.head.appendChild(script);
    });
  }
  return sdkLoadPromise;
}

export async function fetchToyProfile(sdk: ToySdkApi | null): Promise<ToyUserProfile | null> {
  if (!sdk?.getUserProfile) return null;
  const raw = await sdk.getUserProfile();
  if (!raw || typeof raw !== 'object') return null;
  const nickname = String(raw.nickname ?? raw.name ?? '').trim();
  const openIdRaw = raw.toyOpenId ?? raw.openId ?? raw.uid ?? null;
  const openId = typeof openIdRaw === 'string' && openIdRaw.trim() ? openIdRaw.trim() : null;
  if (!nickname && !openId) return null;
  const avatar = typeof raw.avatar === 'string' && /^https?:\/\//i.test(raw.avatar) ? raw.avatar : undefined;
  return avatar ? { nickname: nickname || 'Player', openId, avatar } : { nickname: nickname || 'Player', openId };
}

export function parseAuthorFollowResp(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const obj = raw as Record<string, unknown>;
  const payload = (obj.data && typeof obj.data === 'object' ? obj.data : obj) as Record<string, unknown>;
  const rel = (payload.relation && typeof payload.relation === 'object' ? payload.relation : payload) as Record<string, unknown>;
  return Boolean(
    rel.followed === true ||
    rel.isFollowed === true ||
    rel.isFollowing === true ||
    rel.following === true ||
    rel.isFollow === true ||
    rel.is_follow === true ||
    Number(rel.attribute) === 2 ||
    Number(rel.attribute) === 6,
  );
}

export function parseVideoActionsResp(raw: unknown): Omit<ToySocialStatus, 'followed'> {
  if (!raw || typeof raw !== 'object') {
    return { liked: false, coined: false, favorited: false, tripled: false };
  }
  const obj = raw as Record<string, unknown>;
  const payload = (obj.data && typeof obj.data === 'object' ? obj.data : obj) as Record<string, unknown>;
  const list = Array.isArray(payload.items)
    ? payload.items
    : Array.isArray(payload.videos)
      ? payload.videos
      : Array.isArray(payload)
        ? payload
        : Object.values(payload).filter(v => v && typeof v === 'object' && !Array.isArray(v));
  let best = { liked: false, coined: false, favorited: false, tripled: false, score: -1 };
  for (const entry of list) {
    const rec = entry as Record<string, unknown>;
    const act = (rec.actions && typeof rec.actions === 'object' ? rec.actions : rec) as Record<string, unknown>;
    const liked = Boolean(act.liked === true || act.like === true || act.isLiked === true || Number(act.like) > 0);
    const coined = Boolean(act.coined === true || act.coin === true || act.isCoined === true || Number(act.coin) > 0 || Number(act.coins) > 0);
    const favorited = Boolean(act.favorited === true || act.fav === true || act.favorite === true || act.isFavorited === true || Number(act.fav) > 0);
    const tripled = Boolean(act.tripled === true || act.isTriple === true || (liked && coined && favorited));
    const score = (tripled ? 10 : 0) + (liked ? 1 : 0) + (coined ? 1 : 0) + (favorited ? 1 : 0);
    if (score > best.score) best = { liked: liked || tripled, coined: coined || tripled, favorited: favorited || tripled, tripled, score };
  }
  return { liked: best.liked, coined: best.coined, favorited: best.favorited, tripled: best.tripled };
}

export async function checkToyFollowAndTriple(sdk: ToySdkApi | null): Promise<ToySocialStatus> {
  const status: ToySocialStatus = { followed: false, liked: false, coined: false, favorited: false, tripled: false };
  if (!sdk) return status;
  if (sdk.getAuthorRelation) {
    try {
      status.followed = parseAuthorFollowResp(await sdk.getAuthorRelation());
    } catch {}
  }
  if (sdk.getVideoUserActions && sdk.getAuthorVideoRange) {
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const range = await sdk.getAuthorVideoRange({ start: nowSec - 360 * 24 * 60 * 60, end: nowSec });
      const payload = (range?.data && typeof range.data === 'object' ? range.data : range) as Record<string, unknown>;
      const list = Array.isArray(payload?.items) ? payload.items : Array.isArray(payload?.videos) ? payload.videos : [];
      const aids = list.map(v => Number((v as Record<string, unknown>)?.aid)).filter(a => Number.isSafeInteger(a) && a > 0).slice(0, 50);
      if (aids.length > 0) {
        const actions = parseVideoActionsResp(await sdk.getVideoUserActions({ aids }));
        Object.assign(status, actions);
      }
    } catch {}
  }
  return status;
}

export interface CloudSyncResult {
  status: 'synced' | 'skipped-cooldown' | 'skipped-empty' | 'rate-limited' | 'error';
  retryAfterMs?: number;
  message?: string;
}

/**
 * Enforces Toy Content Checklist §7:
 * - Batch writes only at key lifecycle boundaries (round end, leave match, pagehide, manual sync).
 * - Never polls on timers or writes inside loops.
 * - Handles 307044 rate-limit errors with exponential backoff and explicit user messaging.
 */
export class ToyCloudSyncController {
  private readonly sdk: ToySdkApi | null;
  private readonly now: () => number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private consecutiveRateLimits = 0;
  private cooldownUntil = 0;

  constructor(
    sdk: ToySdkApi | null,
    {
      now = () => Date.now(),
      baseBackoffMs = 4000,
      maxBackoffMs = 60000,
    }: { now?: () => number; baseBackoffMs?: number; maxBackoffMs?: number } = {},
  ) {
    this.sdk = sdk;
    this.now = now;
    this.baseBackoffMs = baseBackoffMs;
    this.maxBackoffMs = maxBackoffMs;
  }

  get cooldownRemainingMs(): number {
    return Math.max(0, this.cooldownUntil - this.now());
  }

  async readBatch(keys: string[]): Promise<Record<string, string> | null> {
    if (!this.sdk?.getCloudStorage || keys.length === 0) return null;
    try {
      return await this.sdk.getCloudStorage(keys);
    } catch {
      return null;
    }
  }

  async flushBatch(entries: Record<string, string>): Promise<CloudSyncResult> {
    const keys = Object.keys(entries);
    if (!this.sdk?.setCloudStorage || keys.length === 0) {
      return { status: 'skipped-empty' };
    }
    const remaining = this.cooldownRemainingMs;
    if (remaining > 0) {
      return {
        status: 'skipped-cooldown',
        retryAfterMs: remaining,
        message: '云存档同步冷却中，稍后会在回合结算或手动同步时重试。',
      };
    }

    try {
      await this.sdk.setCloudStorage(entries);
      this.consecutiveRateLimits = 0;
      this.cooldownUntil = 0;
      return { status: 'synced' };
    } catch (error) {
      if (isToyRateLimitError(error)) {
        const delay = Math.min(
          this.maxBackoffMs,
          this.baseBackoffMs * 2 ** this.consecutiveRateLimits,
        );
        this.consecutiveRateLimits++;
        this.cooldownUntil = this.now() + delay;
        return {
          status: 'rate-limited',
          retryAfterMs: delay,
          message: '云存档请求过于频繁（307044），已自动退避，稍后将重试同步。',
        };
      }
      return {
        status: 'error',
        message: error instanceof Error ? error.message : '云存档同步失败。',
      };
    }
  }
}
