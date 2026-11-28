/**
 * Hot-reloadable mail & announcement store (zero restart, 2.5s mtimeMs polling).
 * Supports broadcast announcements/rewards (`target: 'all'`) and targeted user grants (`targetUids: [...]`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { normalizeMailRecord } from '../shared/rewards.js';

export function createMailStore({ filePath = '', pollMs = 2500 } = {}) {
  const resolved = typeof filePath === 'string' && filePath.trim() ? path.resolve(filePath.trim()) : '';
  let mails = [];
  let version = 0;
  let mtimeMs = 0;
  let loadedAt = 0;
  let error = null;

  function load(force = false) {
    if (!resolved) return false;
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch {
      if (force) error = 'mail_file_not_found';
      return false;
    }
    if (!force && stat.mtimeMs === mtimeMs) return false;
    try {
      const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
      const rawList = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.mails) ? parsed.mails : null);
      if (!rawList) throw new Error('expected array or { mails: [] }');
      const seen = new Set();
      const next = [];
      for (const item of rawList) {
        const norm = normalizeMailRecord(item);
        if (!norm || seen.has(norm.id)) continue;
        seen.add(norm.id);
        next.push(norm);
      }
      mails = next;
      version = Number.isFinite(Number(parsed?.version)) ? Number(parsed.version) : (version + 1);
      mtimeMs = stat.mtimeMs;
      loadedAt = Date.now();
      error = null;
      return true;
    } catch (err) {
      error = String(err?.message || 'invalid_mail_json');
      console.warn(`[mail-store] ignored invalid mail file at ${resolved}: ${error}`);
      return false;
    }
  }

  function persist() {
    if (!resolved) throw new Error('PERF_MAIL_CONFIG is not configured');
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const payload = { version: version + 1, updatedAt: Date.now(), mails };
    const tmp = `${resolved}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, resolved);
    load(true);
  }

  function listForUser(uid = '', now = Date.now()) {
    const cleanUid = typeof uid === 'string' ? uid.trim().slice(0, 128) : '';
    const active = mails.filter((m) => {
      if (m.startsAt && now < m.startsAt) return false;
      if (m.expiresAt && now > m.expiresAt) return false;
      if (m.target === 'all') return true;
      if (!cleanUid) return false;
      return Array.isArray(m.targetUids) && m.targetUids.includes(cleanUid);
    });
    active.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    // Strip targetUids from public response so private recipient lists are never exposed
    return active.map(({ targetUids, ...pub }) => pub);
  }

  function upsert(rawMail) {
    const norm = normalizeMailRecord(rawMail);
    if (!norm) throw new Error('无效的邮件格式（需要 id 与 title）');
    const idx = mails.findIndex((m) => m.id === norm.id);
    if (idx >= 0) mails[idx] = norm;
    else mails.unshift(norm);
    if (resolved) persist();
    else { version++; loadedAt = Date.now(); }
    return norm;
  }

  function remove(mailId) {
    const cleanId = String(mailId || '').trim();
    const before = mails.length;
    mails = mails.filter((m) => m.id !== cleanId);
    const removed = mails.length !== before;
    if (removed) {
      if (resolved) persist();
      else { version++; loadedAt = Date.now(); }
    }
    return removed;
  }

  if (resolved) load(true);
  const timer = resolved && pollMs > 0 ? setInterval(() => { load(false); }, pollMs) : null;
  timer?.unref?.();

  return {
    load,
    listForUser,
    upsert,
    remove,
    meta: () => ({ path: resolved || null, count: mails.length, version, loadedAt, error }),
    close: () => { if (timer) clearInterval(timer); },
  };
}
