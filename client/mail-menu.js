/**
 * System Mailbox modal (#mail-menu): announcements + extensible abstract reward claims
 * (skins, knives, agents, XP, bundles, and arbitrary future custom items).
 */
import { AGENT_ASSETS } from '../shared/agent-assets.js';
import { getSkin } from '../shared/skins.js';
import { getAgent } from '../shared/agents.js';
import {
  MAIL_CATEGORIES,
  normalizeMailRecord,
  flattenRewardGrants,
  describeRewardGrant,
  mailHasClaimableRewards,
  mailNeedsAttention,
  countMailboxBadges,
} from '../shared/rewards.js';
import { isSkinUnlocked, isAgentUnlocked } from '../shared/progression.js';
import { fetchGameApi } from '../shared/static-runtime.js';
import { preferences } from './persistence.js';
import { getSharedToyProgress } from './toy-cloud-progress.js';
import { skinPreviewURL } from './skin-preview.js';
import { imageAssetURL } from './image-asset-url.js';
import './mail.css';

const MAIL_CACHE_KEY = 'cs.mail.cache.v1';

function formatMailTime(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  try {
    const d = new Date(n);
    const pad = (v) => String(v).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return '';
  }
}

function formatClaimSummary(summary) {
  if (!summary) return '已领取附件奖励。';
  const parts = [];
  for (const id of summary.skins || []) {
    const s = getSkin(id);
    parts.push(s ? s.name.replace(' · 原厂涂装', '') : id);
  }
  for (const id of summary.agents || []) {
    const a = getAgent(id);
    parts.push(a ? a.name : id);
  }
  if (summary.xp > 0) parts.push(`${summary.xp} 生涯经验`);
  for (const item of summary.items || []) {
    parts.push(item.quantity > 1 ? `${item.title} ×${item.quantity}` : item.title);
  }
  if (!parts.length && summary.duplicates?.length) {
    return '附件中的皮肤/探员你此前已拥有，邮件已标记为已领取。';
  }
  if (!parts.length) return '邮件已标记为已领取。';
  const shown = parts.slice(0, 4).join('、');
  const tail = parts.length > 4 ? ` 等 ${parts.length} 项` : '';
  return `领取成功：${shown}${tail}（已自动写入存档）`;
}

function readCachedMails() {
  try {
    const raw = preferences.readJSON(MAIL_CACHE_KEY, null);
    const list = Array.isArray(raw?.mails) ? raw.mails : [];
    return list.map(normalizeMailRecord).filter(Boolean);
  } catch {
    return [];
  }
}

function writeCachedMails(mails) {
  try {
    preferences.setItem(MAIL_CACHE_KEY, JSON.stringify({ updatedAt: Date.now(), mails }));
  } catch {}
}

export class MailMenu {
  constructor({ progressStore = null, onOpenSkins = () => {}, onOpenAgents = () => {} } = {}) {
    this.store = progressStore || getSharedToyProgress();
    this.onOpenSkins = onOpenSkins;
    this.onOpenAgents = onOpenAgents;
    this.mails = readCachedMails();
    this.selectedId = this.mails[0]?.id || null;
    this.loading = false;
    this.offlineFallback = false;
    this.destroyed = false;

    const modal = document.createElement('div');
    modal.id = 'mail-menu';
    modal.className = 'overlay';
    modal.hidden = true;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'mail-menu-title');
    modal.innerHTML = `
      <section class="mail-card">
        <header class="mail-header">
          <div>
            <span class="eyebrow">SYSTEM MAILBOX // 系统公告与奖励信箱</span>
            <h2 id="mail-menu-title">邮件信箱</h2>
          </div>
          <div class="mail-header-actions">
            <button type="button" class="mail-btn-subtle" data-mail-refresh>刷新</button>
            <button type="button" class="mail-btn-gold" data-mail-claim-all hidden>一键全部领取</button>
            <button type="button" class="mail-close" aria-label="关闭邮箱">完成 ×</button>
          </div>
        </header>

        <div class="mail-body">
          <aside class="mail-list-pane" aria-label="邮件列表">
            <div class="mail-list-head">
              <span data-mail-list-count>共 0 封邮件</span>
              <span class="mail-list-badge" data-mail-unclaimed-summary hidden></span>
            </div>
            <div class="mail-list" data-mail-list role="listbox"></div>
          </aside>

          <article class="mail-reader-pane" data-mail-reader></article>
        </div>

        <footer class="mail-footer">
          <div class="mail-status" role="status" aria-live="polite" data-mail-status>系统公告、活动补偿与皮肤/物品奖励将自动送达此处。</div>
          <div class="mail-footer-links">
            <button type="button" class="mail-btn-subtle" data-mail-jump-skins>前往皮肤库</button>
            <button type="button" class="mail-btn-subtle" data-mail-jump-agents>前往探员仓库</button>
          </div>
        </footer>
      </section>
    `;
    document.body.append(modal);
    this.element = modal;

    modal.querySelector('.mail-close').onclick = () => this.close();
    modal.querySelector('[data-mail-refresh]').onclick = () => { void this.refresh({ manual: true }); };
    modal.querySelector('[data-mail-claim-all]').onclick = () => this.handleClaimAll();
    modal.querySelector('[data-mail-jump-skins]').onclick = () => { this.close(); this.onOpenSkins(); };
    modal.querySelector('[data-mail-jump-agents]').onclick = () => { this.close(); this.onOpenAgents(); };
    modal.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') { e.preventDefault(); this.close(); }
    });

    this._onStoreChange = () => {
      this._emitMailBadges();
      if (!this.element.hidden) this.render();
    };
    this.store.addEventListener('change', this._onStoreChange);
    this._emitMailBadges();
  }

  status(text) {
    const el = this.element.querySelector('[data-mail-status]');
    if (el) el.textContent = text;
  }

  getBadges() {
    return countMailboxBadges(this.mails, this.store.progress);
  }

  _emitMailBadges() {
    if (typeof window?.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('cs2-mail-updated', {
        detail: { mails: this.mails, badges: this.getBadges() },
      }));
    }
  }

  async refresh({ manual = false } = {}) {
    if (this.loading || this.destroyed) return this.mails;
    this.loading = true;
    if (!this.element.hidden) this.render();
    try {
      const uid = this.store.uid || '';
      const q = uid ? `?uid=${encodeURIComponent(uid)}` : '';
      const { response } = await fetchGameApi(`/perf/mail.json${q}`, { cache: 'no-store', timeoutMs: 4000 });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const next = Array.isArray(data?.mails) ? data.mails.map(normalizeMailRecord).filter(Boolean) : [];
      this.mails = next;
      this.offlineFallback = false;
      writeCachedMails(next);
      if (!this.mails.some((m) => m.id === this.selectedId)) {
        this.selectedId = this.mails[0]?.id || null;
      }
      if (manual) this.status(`已刷新信箱，当前共 ${this.mails.length} 封邮件。`);
    } catch {
      this.offlineFallback = true;
      if (!this.mails.length) this.mails = readCachedMails();
      if (manual) this.status('网络暂时不可用，当前显示本地缓存邮件。');
    } finally {
      this.loading = false;
      this._emitMailBadges();
      if (!this.element.hidden) {
        this._autoMarkCurrentIfAnnouncement();
        this.render();
      }
    }
    return this.mails;
  }

  _autoMarkCurrentIfAnnouncement() {
    const active = this.mails.find((m) => m.id === this.selectedId);
    if (active && (!active.rewards || active.rewards.length === 0)) {
      this.store.markMailRead(active.id);
    }
  }

  selectMail(mailId) {
    const mail = this.mails.find((m) => m.id === mailId);
    if (!mail) return;
    this.selectedId = mail.id;
    // Mark mail as read on open; mails with unclaimed rewards still retain their red dot until claimed!
    this.store.markMailRead(mail.id);
    this._emitMailBadges();
    this.render();
  }

  handleClaim(mail) {
    if (!mail) return;
    const res = this.store.claimMail(mail);
    if (res.ok) {
      this.status(formatClaimSummary(res.summary));
    } else if (res.alreadyClaimed) {
      this.status('该邮件的附件奖励已领取过，无需重复领取。');
    }
    this._emitMailBadges();
    this.render();
  }

  handleClaimAll() {
    const res = this.store.claimAllMails(this.mails);
    if (res.ok) {
      this.status(`已一键领取 ${res.count} 封邮件奖励 · ${formatClaimSummary(res.summary)}`);
    } else {
      this.status('当前没有待领取的附件奖励。');
    }
    this._emitMailBadges();
    this.render();
  }

  open() {
    if (this.destroyed) return;
    this.element.hidden = false;
    if (!this.selectedId && this.mails.length) this.selectedId = this.mails[0].id;
    this._autoMarkCurrentIfAnnouncement();
    this.render();
    void this.refresh();
    this.element.querySelector('.mail-close')?.focus();
  }

  close() {
    this.element.hidden = true;
  }

  render() {
    if (this.destroyed) return;
    const progress = this.store.progress;
    const badges = this.getBadges();

    const refreshBtn = this.element.querySelector('[data-mail-refresh]');
    if (refreshBtn) {
      refreshBtn.disabled = this.loading;
      refreshBtn.textContent = this.loading ? '刷新中…' : '刷新';
    }

    const claimAllBtn = this.element.querySelector('[data-mail-claim-all]');
    if (claimAllBtn) {
      claimAllBtn.hidden = badges.unclaimed === 0;
      claimAllBtn.textContent = badges.unclaimed > 0 ? `一键全部领取 (${badges.unclaimed})` : '一键全部领取';
    }

    const countEl = this.element.querySelector('[data-mail-list-count]');
    if (countEl) {
      countEl.textContent = this.offlineFallback
        ? `缓存 ${this.mails.length} 封邮件`
        : `共 ${this.mails.length} 封邮件`;
    }
    const unclaimedEl = this.element.querySelector('[data-mail-unclaimed-summary]');
    if (unclaimedEl) {
      unclaimedEl.hidden = badges.unclaimed === 0;
      unclaimedEl.textContent = `${badges.unclaimed} 份待领`;
    }

    const listEl = this.element.querySelector('[data-mail-list]');
    listEl.replaceChildren();
    if (!this.mails.length) {
      const empty = document.createElement('div');
      empty.className = 'mail-empty-list';
      empty.textContent = this.loading ? '正在拉取最新公告与邮件…' : '暂无系统邮件';
      listEl.append(empty);
    } else {
      for (const mail of this.mails) {
        const cat = MAIL_CATEGORIES[mail.category] || MAIL_CATEGORIES.announcement;
        const hasRewards = Array.isArray(mail.rewards) && mail.rewards.length > 0;
        const claimable = mailHasClaimableRewards(mail, progress);
        const attention = mailNeedsAttention(mail, progress);
        const selected = mail.id === this.selectedId;

        const row = document.createElement('button');
        row.type = 'button';
        row.className = `mail-row${selected ? ' selected' : ''}${attention ? ' unread' : ''}`;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(selected));
        row.dataset.mailId = mail.id;

        const top = document.createElement('div');
        top.className = 'mail-row-top';

        const tags = document.createElement('div');
        tags.className = 'mail-row-tags';
        const catEl = document.createElement('span');
        catEl.className = `mail-cat mail-cat-${cat.accent}`;
        catEl.textContent = cat.label;
        tags.append(catEl);
        if (mail.pinned) {
          const pinEl = document.createElement('span');
          pinEl.className = 'mail-pin-tag';
          pinEl.textContent = '置顶';
          tags.append(pinEl);
        }
        top.append(tags);

        if (attention) {
          const dot = document.createElement('span');
          dot.className = 'mail-row-dot';
          dot.setAttribute('aria-label', claimable ? '待领取奖励' : '未读');
          top.append(dot);
        }

        const title = document.createElement('strong');
        title.className = 'mail-row-title';
        title.textContent = mail.title;

        const meta = document.createElement('div');
        meta.className = 'mail-row-meta';
        const timeEl = document.createElement('span');
        timeEl.textContent = formatMailTime(mail.createdAt) || mail.sender;
        meta.append(timeEl);
        if (hasRewards) {
          const giftEl = document.createElement('span');
          giftEl.className = `mail-row-gift ${claimable ? 'pending' : 'claimed'}`;
          giftEl.textContent = claimable ? '含待领奖励' : '已领取';
          meta.append(giftEl);
        }

        row.append(top, title, meta);
        row.onclick = () => this.selectMail(mail.id);
        listEl.append(row);
      }
    }

    this._renderReader(progress);
  }

  _renderReader(progress) {
    const reader = this.element.querySelector('[data-mail-reader]');
    reader.replaceChildren();
    const mail = this.mails.find((m) => m.id === this.selectedId) || null;

    if (!mail) {
      const empty = document.createElement('div');
      empty.className = 'mail-reader-empty';
      empty.innerHTML = '<strong>选择左侧邮件查看详情</strong><p>官方公告、活动补偿以及皮肤、匕首、探员、经验与专属道具奖励都会发放到这里。</p>';
      reader.append(empty);
      this._appendOwnedItemsStrip(reader, progress);
      return;
    }

    const cat = MAIL_CATEGORIES[mail.category] || MAIL_CATEGORIES.announcement;
    const head = document.createElement('div');
    head.className = 'mail-reader-head';

    const titleRow = document.createElement('div');
    titleRow.className = 'mail-reader-title-row';
    const catPill = document.createElement('span');
    catPill.className = `mail-cat mail-cat-${cat.accent}`;
    catPill.textContent = cat.label;
    const h3 = document.createElement('h3');
    h3.textContent = mail.title;
    titleRow.append(catPill, h3);

    const metaRow = document.createElement('div');
    metaRow.className = 'mail-reader-meta';
    const senderSpan = document.createElement('span');
    senderSpan.textContent = `发件人：${mail.sender}`;
    const timeSpan = document.createElement('span');
    timeSpan.textContent = formatMailTime(mail.createdAt);
    metaRow.append(senderSpan, timeSpan);
    if (mail.expiresAt) {
      const expSpan = document.createElement('span');
      expSpan.textContent = `有效期至 ${formatMailTime(mail.expiresAt)}`;
      metaRow.append(expSpan);
    }

    head.append(titleRow, metaRow);
    reader.append(head);

    const content = document.createElement('div');
    content.className = 'mail-reader-content';
    const paragraphs = (mail.body || '').split(/\n{2,}/).filter((s) => s.trim());
    if (paragraphs.length) {
      for (const block of paragraphs) {
        const p = document.createElement('p');
        p.textContent = block.trim();
        content.append(p);
      }
    } else {
      const p = document.createElement('p');
      p.textContent = '（本邮件无正文内容）';
      content.append(p);
    }
    reader.append(content);

    const flatGrants = flattenRewardGrants(mail.rewards);
    if (flatGrants.length > 0) {
      const claimable = mailHasClaimableRewards(mail, progress);
      const rewardSection = document.createElement('section');
      rewardSection.className = 'mail-rewards-box';

      const rHead = document.createElement('div');
      rHead.className = 'mail-rewards-head';
      const rTitle = document.createElement('h4');
      rTitle.textContent = `附件奖励（共 ${flatGrants.length} 项）`;
      const rState = document.createElement('span');
      rState.className = `mail-claim-pill ${claimable ? 'pending' : 'claimed'}`;
      rState.textContent = claimable ? '待领取' : '已领取';
      rHead.append(rTitle, rState);
      rewardSection.append(rHead);

      const grid = document.createElement('div');
      grid.className = 'mail-rewards-grid';
      const owned = {
        skins: new Set(flatGrants.filter((g) => g.type === 'skin' && isSkinUnlocked(g.skinId, progress)).map((g) => g.skinId)),
        agents: new Set(flatGrants.filter((g) => g.type === 'agent' && isAgentUnlocked(g.agentId, progress)).map((g) => g.agentId)),
      };
      for (const grant of flatGrants) {
        const desc = describeRewardGrant(grant, {
          skinPreview: skinPreviewURL,
          agentPreview: (agent) => {
            const p = AGENT_ASSETS[agent.id]?.preview?.file;
            return p ? imageAssetURL(p) : '';
          },
          assetUrl: imageAssetURL,
          owned,
        });
        if (!desc) continue;
        const card = document.createElement('div');
        card.className = `mail-reward-tile rarity-${desc.rarity || 'blue'}`;
        card.dataset.rewardKey = desc.key;

        const art = document.createElement('div');
        art.className = 'mail-reward-art';
        if (desc.previewImage) {
          const img = document.createElement('img');
          img.src = desc.previewImage;
          img.alt = desc.title;
          img.loading = 'lazy';
          img.decoding = 'async';
          art.append(img);
        } else {
          const glyph = document.createElement('span');
          glyph.className = 'mail-reward-glyph';
          glyph.textContent = desc.glyph || desc.badge;
          art.append(glyph);
        }
        const badge = document.createElement('span');
        badge.className = 'mail-reward-badge';
        badge.textContent = desc.badge;
        art.append(badge);
        if (desc.quantity > 1) {
          const qty = document.createElement('span');
          qty.className = 'mail-reward-qty';
          qty.textContent = `×${desc.quantity}`;
          art.append(qty);
        }

        const info = document.createElement('div');
        info.className = 'mail-reward-info';
        const sub = document.createElement('span');
        sub.textContent = desc.subtitle;
        const name = document.createElement('strong');
        name.textContent = desc.title;
        info.append(sub, name);
        if (desc.alreadyOwned && claimable) {
          const dup = document.createElement('small');
          dup.textContent = '已拥有（领取后保留）';
          info.append(dup);
        }

        card.append(art, info);
        grid.append(card);
      }
      rewardSection.append(grid);

      const actionBar = document.createElement('div');
      actionBar.className = 'mail-claim-actions';
      const claimBtn = document.createElement('button');
      claimBtn.type = 'button';
      claimBtn.className = claimable ? 'mail-btn-gold mail-claim-btn' : 'mail-btn-subtle mail-claim-btn';
      claimBtn.dataset.mailClaim = mail.id;
      claimBtn.disabled = !claimable;
      if (claimable) {
        claimBtn.innerHTML = '<span>领取附件奖励</span><i class="mail-inline-dot" aria-hidden="true"></i>';
        claimBtn.onclick = () => this.handleClaim(mail);
      } else {
        claimBtn.textContent = '已领取全部附件';
      }
      actionBar.append(claimBtn);
      rewardSection.append(actionBar);
      reader.append(rewardSection);
    }

    this._appendOwnedItemsStrip(reader, progress);
  }

  _appendOwnedItemsStrip(container, progress) {
    const items = Object.values(progress.customItems || {});
    if (!items.length) return;
    const strip = document.createElement('section');
    strip.className = 'mail-inventory-strip';
    const label = document.createElement('span');
    label.className = 'mail-inventory-label';
    label.textContent = `已收录专属物品 (${items.length})`;
    const list = document.createElement('div');
    list.className = 'mail-inventory-chips';
    for (const item of items) {
      const chip = document.createElement('span');
      chip.className = 'mail-inventory-chip';
      chip.title = item.description || item.title;
      chip.textContent = item.quantity > 1 ? `${item.title} ×${item.quantity}` : item.title;
      list.append(chip);
    }
    strip.append(label, list);
    container.append(strip);
  }

  destroy() {
    this.destroyed = true;
    this.store.removeEventListener('change', this._onStoreChange);
    this.element.remove();
  }
}
