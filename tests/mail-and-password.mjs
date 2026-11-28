import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import {
  normalizeRewardGrant,
  flattenRewardGrants,
  normalizeMailRecord,
  describeRewardGrant,
  applyRewardsToProgress,
  mailHasClaimableRewards,
  mailNeedsAttention,
  countMailboxBadges,
} from '../shared/rewards.js';
import {
  createEmptyProgress,
  normalizeProgress,
  mergeProgress,
  isSkinUnlocked,
  isAgentUnlocked,
  getSkinUnlockRequirement,
  getAgentUnlockRequirement,
  evaluateRequirement,
  enforceUnlockedSkinLoadout,
  computeCareerLevel,
  hasUnclaimedSocialGifts,
} from '../shared/progression.js';
import { createMailStore } from '../server/mail-store.js';
import { startGameServer } from '../server/index.js';
import { CLIENT_BUILD, RULES_VERSION, ASSET_VERSION } from '../shared/online-build.js';

test('abstract rewards normalize, flatten bundles, reject invalid grants, and apply idempotently', () => {
  assert.equal(normalizeRewardGrant({ type: 'skin', skinId: 'nonexistent-skin' }), null);
  assert.equal(normalizeRewardGrant({ type: 'agent', agentId: 'no-such-agent' }), null);
  assert.equal(normalizeRewardGrant({ type: 'xp', amount: -50 }), null);
  assert.equal(normalizeRewardGrant({ type: 'item', itemId: 'bad', title: '' }), null);

  const safeItem = normalizeRewardGrant({
    type: 'item',
    itemId: 'badge_s1',
    title: '先锋测试徽章',
    category: 'badge',
    quantity: 2,
    previewUrl: 'javascript:alert(1)',
    meta: { season: 1, special: true },
  });
  assert.ok(safeItem);
  assert.equal(safeItem.previewUrl, undefined, 'unsafe javascript: URL must be stripped');
  assert.equal(safeItem.quantity, 2);
  assert.equal(safeItem.meta.season, 1);

  const bundle = normalizeRewardGrant({
    type: 'bundle',
    title: '开服大礼包',
    items: [
      { type: 'skin', skinId: 'ak47-vulcan' },
      { type: 'agent', agentId: 'ct-syfers' },
      { type: 'xp', amount: 1500 },
      safeItem,
    ],
  });
  const flat = flattenRewardGrants([bundle]);
  assert.equal(flat.length, 4);

  const skinDesc = describeRewardGrant({ type: 'skin', skinId: 'karambit-vanilla' });
  assert.equal(skinDesc.badge, '匕首');
  assert.equal(skinDesc.rarity, 'gold');
  assert.ok(skinDesc.previewImage.includes('.webp'));

  const p = createEmptyProgress('uid_test');
  assert.equal(isSkinUnlocked('ak47-vulcan', p), false);
  assert.equal(isAgentUnlocked('ct-syfers', p), false);
  const baseLevel = computeCareerLevel(p);

  const res = applyRewardsToProgress(p, [bundle], 1700000000000);
  assert.deepEqual(res.skins, ['ak47-vulcan']);
  assert.deepEqual(res.agents, ['ct-syfers']);
  assert.equal(res.xp, 1500);
  assert.equal(res.items.length, 1);

  assert.equal(isSkinUnlocked('ak47-vulcan', p), true);
  assert.equal(isAgentUnlocked('ct-syfers', p), true);
  assert.equal(evaluateRequirement(getSkinUnlockRequirement('ak47-vulcan'), p).unlocked, true);
  assert.equal(evaluateRequirement(getAgentUnlockRequirement('ct-syfers'), p).unlocked, true);
  assert.equal(enforceUnlockedSkinLoadout({ ak47: 'ak47-vulcan' }, p).ak47, 'ak47-vulcan');
  assert.ok(computeCareerLevel(p).xp >= baseLevel.xp + 1500);
  assert.equal(p.customItems.badge_s1.quantity, 2);

  // Applying again records skin/agent duplicates and stacks item quantity
  const res2 = applyRewardsToProgress(p, [bundle], 1700000005000);
  assert.equal(res2.skins.length, 0);
  assert.ok(res2.duplicates.includes('skin:ak47-vulcan'));
  assert.equal(p.customItems.badge_s1.quantity, 4);
});

test('social gift red dot helper & monotone progress merge preserve mail claims and social state', () => {
  const fresh = createEmptyProgress('u1');
  assert.equal(hasUnclaimedSocialGifts(fresh), true);

  const onlyFollow = normalizeProgress({ ...fresh, social: { followed: true } }, 'u1');
  assert.equal(hasUnclaimedSocialGifts(onlyFollow), true);

  const both = normalizeProgress({ ...onlyFollow, social: { followed: true, tripled: true } }, 'u1');
  assert.equal(hasUnclaimedSocialGifts(both), false);

  const local = normalizeProgress({
    uid: 'u1',
    grantedSkins: ['ak47-vulcan'],
    bonusXp: 800,
    claimedMailIds: ['mail-1'],
    readMailIds: ['mail-1', 'mail-2'],
    customItems: { token_a: { id: 'token_a', title: '补给券', category: 'consumable', quantity: 2, acquiredAt: 100 } },
  }, 'u1');
  const remote = normalizeProgress({
    uid: 'u1',
    grantedSkins: ['awp-asiimov'],
    grantedAgents: ['ct-ava'],
    bonusXp: 1200,
    claimedMailIds: ['mail-3'],
    customItems: {
      token_a: { id: 'token_a', title: '补给券', category: 'consumable', quantity: 5, acquiredAt: 200 },
      badge_b: { id: 'badge_b', title: '老兵勋章', category: 'badge', quantity: 1, acquiredAt: 150 },
    },
  }, 'u1');
  const merged = mergeProgress(local, remote, 'u1');
  assert.deepEqual(new Set(merged.grantedSkins), new Set(['ak47-vulcan', 'awp-asiimov']));
  assert.deepEqual(merged.grantedAgents, ['ct-ava']);
  assert.equal(merged.bonusXp, 1200);
  assert.deepEqual(new Set(merged.claimedMailIds), new Set(['mail-1', 'mail-3']));
  assert.deepEqual(new Set(merged.readMailIds), new Set(['mail-1', 'mail-2', 'mail-3']));
  assert.equal(merged.customItems.token_a.quantity, 5);
  assert.equal(merged.customItems.token_a.acquiredAt, 100);
  assert.equal(merged.customItems.badge_b.title, '老兵勋章');
});

test('mailbox badge counting distinguishes announcement read vs reward claim', () => {
  const notice = normalizeMailRecord({ id: 'm_notice', title: '维护公告', body: '已升级', category: 'announcement' });
  const gift = normalizeMailRecord({
    id: 'm_gift',
    title: '补偿奖励',
    body: '请查收',
    category: 'compensation',
    rewards: [{ type: 'xp', amount: 500 }],
  });
  const mails = [notice, gift];
  const p = createEmptyProgress('u1');

  assert.deepEqual(countMailboxBadges(mails, p), { unread: 2, unclaimed: 1, attention: 2 });
  assert.equal(mailNeedsAttention(notice, p), true);
  assert.equal(mailHasClaimableRewards(gift, p), true);

  // Reading both clears announcement attention, but gift still demands attention until claimed
  p.readMailIds.push('m_notice', 'm_gift');
  assert.equal(mailNeedsAttention(notice, p), false);
  assert.equal(mailNeedsAttention(gift, p), true);
  assert.deepEqual(countMailboxBadges(mails, p), { unread: 0, unclaimed: 1, attention: 1 });

  // Claiming gift clears all mailbox attention
  p.claimedMailIds.push('m_gift');
  assert.equal(mailNeedsAttention(gift, p), false);
  assert.deepEqual(countMailboxBadges(mails, p), { unread: 0, unclaimed: 0, attention: 0 });
});

test('mail store hot-reloads from disk, filters target UIDs & time windows, and strips targetUids', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs2-mail-test-'));
  const mailFile = path.join(tmpDir, 'mails.json');
  const now = Date.now();
  fs.writeFileSync(mailFile, JSON.stringify({
    version: 1,
    mails: [
      { id: 'pub-1', title: '全服公告', body: 'hello', target: 'all', pinned: true, createdAt: now - 1000 },
      { id: 'vip-1', title: '专属补偿', body: 'vip', target: 'uids', targetUids: ['uid_vip'], rewards: [{ type: 'xp', amount: 300 }], createdAt: now },
      { id: 'future-1', title: '未开始活动', body: 'soon', startsAt: now + 60_000 },
      { id: 'expired-1', title: '已过期', body: 'old', expiresAt: now - 60_000 },
    ],
  }));

  const store = createMailStore({ filePath: mailFile, pollMs: 0 });
  try {
    const vipMails = store.listForUser('uid_vip', now);
    assert.deepEqual(vipMails.map((m) => m.id), ['pub-1', 'vip-1']);
    assert.equal(vipMails[1].targetUids, undefined, 'targetUids must never leak to clients');

    const guestMails = store.listForUser('uid_other', now);
    assert.deepEqual(guestMails.map((m) => m.id), ['pub-1']);

    // Corrupt JSON does not wipe live mails
    fs.writeFileSync(mailFile, '{bad-json');
    assert.equal(store.load(true), false);
    assert.equal(store.listForUser('uid_other', now).length, 1);

    // Upsert & remove persist atomically
    store.upsert({ id: 'live-2', title: '热更奖励', body: '即时生效', rewards: [{ type: 'skin', skinId: 'awp-asiimov' }] });
    assert.ok(store.listForUser('uid_other', Date.now()).some((m) => m.id === 'live-2'));
    assert.equal(store.remove('live-2'), true);
    assert.equal(store.listForUser('uid_other', Date.now()).some((m) => m.id === 'live-2'), false);
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function wsConnectAndSend(url, payload) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('ws timeout')); }, 5000);
    ws.once('error', (err) => { clearTimeout(timer); reject(err); });
    ws.once('open', () => ws.send(JSON.stringify(payload)));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'welcome' || msg.type === 'error') {
        clearTimeout(timer);
        resolve({ ws, msg });
      }
    });
  });
}

test('password-protected 1v1 room enforces password, hides secret from directory, and allows resumeToken bypass', async () => {
  const srv = await startGameServer({ port: 0, host: '127.0.0.1', logicOnly: true, performanceDirectory: true });
  const port = srv.server.address().port;
  const wsUrl = `ws://127.0.0.1:${port}/ws`;
  const baseJoin = {
    type: 'join',
    clientBuild: CLIENT_BUILD,
    rulesVersion: RULES_VERSION,
    assetVersion: ASSET_VERSION,
    mode: 'defuse',
    bots: 0,
    movementProtocol: 1,
    shotProtocol: 1,
  };

  let hostWs, guestWs, hostResumedWs;
  try {
    // 1. Host creates a passworded 0-bot 1v1 room
    const hostJoin = await wsConnectAndSend(wsUrl, {
      ...baseJoin,
      name: 'DuelHost',
      playerUid: 'uid_host',
      password: 'duel-secret-2026',
    });
    hostWs = hostJoin.ws;
    assert.equal(hostJoin.msg.type, 'welcome');
    assert.equal(hostJoin.msg.locked, true);
    const roomCode = hostJoin.msg.room;
    const hostResume = hostJoin.msg.resumeToken;
    assert.ok(roomCode && hostResume);

    // 2. Room directory exposes locked: true and NEVER leaks the password
    const dirRes = await fetch(`http://127.0.0.1:${port}/room-directory.json`);
    const dirText = await dirRes.text();
    assert.equal(dirText.includes('duel-secret-2026'), false, 'directory must NEVER leak room password');
    const dir = JSON.parse(dirText);
    const list = Array.isArray(dir) ? dir : (Array.isArray(dir?.rooms) ? dir.rooms : []);
    const row = list.find((r) => r.code === roomCode);
    assert.ok(row);
    assert.equal(row.locked, true);
    assert.equal(row.bots, 0);

    // 3. Guest without password -> PASSWORD_REQUIRED
    const noPw = await wsConnectAndSend(wsUrl, { ...baseJoin, name: 'Guest', room: roomCode, existing: true });
    assert.equal(noPw.msg.type, 'error');
    assert.equal(noPw.msg.code, 'PASSWORD_REQUIRED');
    noPw.ws.close();

    // 4. Guest with wrong password -> WRONG_PASSWORD
    const wrongPw = await wsConnectAndSend(wsUrl, { ...baseJoin, name: 'Guest', room: roomCode, existing: true, password: 'wrong' });
    assert.equal(wrongPw.msg.type, 'error');
    assert.equal(wrongPw.msg.code, 'WRONG_PASSWORD');
    wrongPw.ws.close();

    // 5. Guest with correct password -> joins successfully!
    const okPw = await wsConnectAndSend(wsUrl, { ...baseJoin, name: 'DuelGuest', room: roomCode, existing: true, password: 'duel-secret-2026' });
    guestWs = okPw.ws;
    assert.equal(okPw.msg.type, 'welcome');
    assert.equal(okPw.msg.room, roomCode);
    assert.equal(okPw.msg.locked, true);

    // 6. Host disconnects and resumes with resumeToken (WITHOUT re-sending password) -> succeeds!
    hostWs.terminate();
    await new Promise((r) => setTimeout(r, 120));
    const resumed = await wsConnectAndSend(wsUrl, {
      ...baseJoin,
      name: 'DuelHost',
      playerUid: 'uid_host',
      room: roomCode,
      existing: true,
      resumeToken: hostResume,
    });
    hostResumedWs = resumed.ws;
    assert.equal(resumed.msg.type, 'welcome');
    assert.equal(resumed.msg.resumed, true);
    assert.equal(resumed.msg.room, roomCode);
  } finally {
    hostWs?.terminate();
    guestWs?.terminate();
    hostResumedWs?.terminate();
    await srv.close();
  }
});

test('gateway serves /perf/mail.json, supports loopback live mail push, and excludes locked rooms from quick-join', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs2-gw-mail-'));
  const mailFile = path.join(tmpDir, 'mail.json');
  fs.writeFileSync(mailFile, JSON.stringify({
    version: 1,
    mails: [
      { id: 'gw-pub', title: '网关公告', body: '测试正文', target: 'all', rewards: [{ type: 'xp', amount: 250 }] },
      { id: 'gw-vip', title: '定向礼包', body: '定向', target: 'uids', targetUids: ['u_vip'], rewards: [{ type: 'skin', skinId: 'awp-asiimov' }] },
    ],
  }));

  const child = spawn(process.execPath, ['server/performance-maps.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      PORT: '0',
      PERF_HOST: '127.0.0.1',
      PERF_ALLOWED_ORIGINS: '*',
      PERF_MAIL_CONFIG: mailFile,
      PERF_MAX_WORKERS: '2',
      PERF_WARM_MAPS: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let hostWs = null;
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('gateway startup timeout')), 12000);
      let out = '';
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`gateway exited early (${code})`)); });
      child.stdout.on('data', (chunk) => {
        out += chunk.toString();
        const m = /http:\/\/127\.0\.0\.1:(\d+)\/perf\//.exec(out);
        if (m) { clearTimeout(timer); resolve(Number(m[1])); }
      });
    });

    const base = `http://127.0.0.1:${port}`;
    const mVip = await fetch(`${base}/perf/mail.json?uid=u_vip`).then((r) => r.json());
    assert.equal(mVip.ok, true);
    assert.deepEqual(mVip.mails.map((m) => m.id).sort(), ['gw-pub', 'gw-vip']);
    assert.equal(JSON.stringify(mVip).includes('targetUids'), false);

    const mGuest = await fetch(`${base}/perf/mail.json?uid=u_other`).then((r) => r.json());
    assert.deepEqual(mGuest.mails.map((m) => m.id), ['gw-pub']);

    // Live push via loopback admin API (zero restart!)
    const pushRes = await fetch(`${base}/perf/internal/mail`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'gw-hot',
        title: '热推送测试',
        body: '无需重启',
        rewards: [{ type: 'item', itemId: 'coin_1', title: '战区纪念币', category: 'currency', quantity: 10 }],
      }),
    }).then((r) => r.json());
    assert.equal(pushRes.ok, true);
    const mAfter = await fetch(`${base}/perf/mail.json`).then((r) => r.json());
    assert.ok(mAfter.mails.some((m) => m.id === 'gw-hot'));

    // Delete via loopback admin API
    const delRes = await fetch(`${base}/perf/internal/mail/gw-hot`, { method: 'DELETE' }).then((r) => r.json());
    assert.equal(delRes.ok, true);
    const mDel = await fetch(`${base}/perf/mail.json`).then((r) => r.json());
    assert.equal(mDel.mails.some((m) => m.id === 'gw-hot'), false);

    // Create a password-locked room on de_dust2 via gateway & verify quick-join SKIPS it!
    const cfg = await fetch(`${base}/perf/play/de_dust2/private-map.json`).then((r) => r.json());
    const joined = await wsConnectAndSend(`ws://127.0.0.1:${port}/perf/play/de_dust2/ws`, {
      type: 'join',
      clientBuild: CLIENT_BUILD,
      rulesVersion: RULES_VERSION,
      assetVersion: ASSET_VERSION,
      mapId: cfg.mapId,
      mapSignature: cfg.mapSignature,
      physicsSha256: cfg.physicsSha256,
      name: 'Private1v1',
      mode: 'defuse',
      bots: 0,
      password: 'secret-1v1',
      movementProtocol: 1,
      shotProtocol: 1,
    });
    hostWs = joined.ws;
    assert.equal(joined.msg.type, 'welcome');
    assert.equal(joined.msg.locked, true);

    const roomsRes = await fetch(`${base}/perf/rooms.json`).then((r) => r.json());
    const lockedRow = roomsRes.rooms.find((r) => r.code === joined.msg.room);
    assert.ok(lockedRow);
    assert.equal(lockedRow.locked, true);
    assert.equal(JSON.stringify(roomsRes).includes('secret-1v1'), false);

    const qj = await fetch(`${base}/perf/quick-join.json?mode=defuse&preferredMap=de_dust2`).then((r) => r.json());
    assert.equal(qj.action, 'create', 'quick-join MUST skip password-protected rooms');
  } finally {
    hostWs?.terminate();
    child.kill('SIGTERM');
    await new Promise((r) => child.once('close', r));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
