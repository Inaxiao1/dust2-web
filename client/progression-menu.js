/**
 * Growth & Bilibili Toy Social Rewards modal (#progression-menu).
 * Displays Toy user profile, cloud save status, career level/stats, Follow & Triple reward packs,
 * and milestone roadmap for skins, knives, and agents.
 */
import { getSkin } from '../shared/skins.js';
import { getAgent } from '../shared/agents.js';
import { getWeapon } from '../shared/weapons.js';
import {
  TOY_FOLLOW_SKIN_IDS,
  TOY_FOLLOW_AGENT_IDS,
  TOY_TRIPLE_SKIN_IDS,
  TOY_TRIPLE_AGENT_IDS,
  getSkinUnlockRequirement,
  getAgentUnlockRequirement,
  evaluateRequirement,
} from '../shared/progression.js';
import { getSharedToyProgress } from './toy-cloud-progress.js';
import { skinPreviewURL } from './skin-preview.js';
import './progression.css';

const ROADMAP_ITEMS = [
  { kind: 'skin', id: 'ak47-slate-1035' },
  { kind: 'skin', id: 'navaja-vanilla' },
  { kind: 'agent', id: 'ct-operator' },
  { kind: 'skin', id: 'ak47-nightwish-1141' },
  { kind: 'agent', id: 't-number-k' },
  { kind: 'skin', id: 'push-vanilla' },
  { kind: 'skin', id: 'awp-wildfire-917' },
  { kind: 'agent', id: 'ct-syfers' },
  { kind: 'skin', id: 'm4a4-poseidon' },
  { kind: 'agent', id: 't-silent-darryl' },
  { kind: 'skin', id: 'ak47-fire-serpent' },
  { kind: 'skin', id: 'm9-vanilla' },
  { kind: 'skin', id: 'm4a4-howl' },
  { kind: 'skin', id: 'awp-dragon-lore' },
  { kind: 'skin', id: 'karambit-sapphire' },
];

export class ProgressionMenu {
  constructor({ progressStore = null, onOpenSkins = () => {}, onOpenAgents = () => {} } = {}) {
    this.store = progressStore || getSharedToyProgress();
    this.onOpenSkins = onOpenSkins;
    this.onOpenAgents = onOpenAgents;
    this.busy = false;
    this.destroyed = false;

    const modal = document.createElement('div');
    modal.id = 'progression-menu';
    modal.className = 'overlay';
    modal.hidden = true;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'prog-menu-title');
    modal.innerHTML = `
      <section class="prog-card">
        <header class="prog-header">
          <div>
            <span class="eyebrow">TOY PROGRESSION // 云端成长与互动福利</span>
            <h2 id="prog-menu-title">成长任务 &amp; Toy 专属奖励</h2>
          </div>
          <div class="prog-header-actions">
            <button type="button" class="prog-btn-subtle" data-prog-sync>同步云存档</button>
            <button type="button" class="prog-close" aria-label="关闭成长任务">完成 ×</button>
          </div>
        </header>

        <div class="prog-body">
          <section class="prog-hero">
            <div class="prog-profile">
              <div class="prog-avatar" data-prog-avatar><span>OP</span></div>
              <div class="prog-profile-meta">
                <div class="prog-name-row">
                  <strong data-prog-name>干员读取中…</strong>
                  <span class="prog-rank-pill" data-prog-rank>Lv.1 列兵新秀</span>
                </div>
                <small data-prog-uid>ID · ----</small>
                <div class="prog-xp-bar"><i data-prog-xp-fill style="width:0%"></i></div>
                <div class="prog-xp-meta">
                  <span data-prog-xp-text>经验 0 / 150</span>
                  <span data-prog-cloud-badge>本地存档</span>
                </div>
              </div>
              <button type="button" class="prog-btn-gold" data-prog-auth hidden>授权 B站 Toy 身份</button>
            </div>

            <div class="prog-stats-grid" data-prog-stats></div>
          </section>

          <section class="prog-section">
            <div class="prog-section-head">
              <h3>B站 Toy 专属互动解锁（关注 &amp; 一键三连）</h3>
              <small>通过官方 Toy SDK 自动核验，验证后即时永久写入 Toy 云存档</small>
            </div>
            <div class="prog-social-grid">
              <article class="prog-social-card" data-social-card="follow">
                <div class="prog-social-top">
                  <div>
                    <span class="prog-tag prog-tag-follow">关注 UP 主礼包</span>
                    <h4>关注即领 2 名探员 + 10 款精选皮肤/匕首</h4>
                  </div>
                  <span class="prog-state-pill" data-follow-state>未解锁</span>
                </div>
                <p class="prog-social-items" data-follow-items></p>
                <div class="prog-social-actions">
                  <button type="button" class="prog-btn-subtle" data-go-follow>前往 UP 主主页</button>
                  <button type="button" class="prog-btn-gold" data-check-follow>验证关注并解锁</button>
                </div>
              </article>

              <article class="prog-social-card" data-social-card="triple">
                <div class="prog-social-top">
                  <div>
                    <span class="prog-tag prog-tag-triple">一键三连礼包</span>
                    <h4>点赞+投币+收藏解锁 2 名王牌探员 + 蝴蝶刀/爪子刀/火神等 10 款</h4>
                  </div>
                  <span class="prog-state-pill" data-triple-state>未解锁</span>
                </div>
                <div class="prog-triple-steps" data-triple-steps></div>
                <p class="prog-social-items" data-triple-items></p>
                <div class="prog-social-actions">
                  <button type="button" class="prog-btn-subtle" data-go-video>前往视频三连</button>
                  <button type="button" class="prog-btn-gold" data-check-triple>验证三连并解锁</button>
                </div>
              </article>
            </div>
          </section>

          <section class="prog-section">
            <div class="prog-section-head">
              <h3>实战成长解锁路线（击杀 &amp; 完成局数）</h3>
              <small data-prog-unlock-summary>已解锁 36 / 216 皮肤 · 2 / 10 探员</small>
            </div>
            <div class="prog-roadmap" data-prog-roadmap></div>
          </section>
        </div>

        <footer class="prog-footer">
          <div class="prog-status" role="status" aria-live="polite" data-prog-status>开局仅配备原厂基础枪械与默认匕首，实战击杀/完成对局或完成 Toy 互动即可逐步解锁全部藏品。</div>
          <div class="prog-footer-links">
            <button type="button" class="prog-btn-subtle" data-jump-agents>前往探员仓库</button>
            <button type="button" class="prog-btn-subtle" data-jump-skins>前往皮肤库</button>
          </div>
        </footer>
      </section>
    `;
    document.body.append(modal);
    this.element = modal;

    modal.querySelector('.prog-close').onclick = () => this.close();
    modal.querySelector('[data-jump-agents]').onclick = () => { this.close(); this.onOpenAgents(); };
    modal.querySelector('[data-jump-skins]').onclick = () => { this.close(); this.onOpenSkins(); };
    modal.querySelector('[data-prog-auth]').onclick = () => this.runAction(async () => {
      await this.store.identity.authorize();
      await this.store.loadFromCloud();
      return this.store.identity.state.message;
    });
    modal.querySelector('[data-prog-sync]').onclick = () => this.runAction(async () => {
      if (!this.store.isToy) return '当前为本地试玩模式，进度已保存在本机；发布到 B站 Toy 后自动云端同步。';
      const r = await this.store.flushCloud({ force: true });
      if (r.status === 'synced') return 'Toy 云存档同步成功！';
      if (r.status === 'rate-limited' || r.status === 'skipped-cooldown') return '云存档请求限流冷却中（307044），请稍后再试。';
      return r.message || this.store.cloudState.message;
    });
    modal.querySelector('[data-go-follow]').onclick = () => this.runAction(async () => {
      const ok = await this.store.identity.openAuthorSpace();
      return ok ? '已打开 UP 主主页，关注完成后点击「验证关注并解锁」即可！' : '请在 B站 Toy 页面上方或视频页点击关注 UP 主，完成后点「验证关注并解锁」。';
    });
    modal.querySelector('[data-go-video]').onclick = () => this.runAction(async () => {
      const ok = await this.store.identity.openAuthorVideo();
      return ok ? '已打开关联视频，完成点赞+投币+收藏后点击「验证三连并解锁」！' : '请前往 B站 UP 主关联视频完成点赞+投币+收藏，完成后点击「验证三连并解锁」。';
    });
    modal.querySelector('[data-check-follow]').onclick = () => this.runAction(async () => {
      const res = await this.store.verifyToyFollow();
      return res.message;
    });
    modal.querySelector('[data-check-triple]').onclick = () => this.runAction(async () => {
      const res = await this.store.verifyToyTriple();
      return res.message;
    });

    modal.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') { e.preventDefault(); this.close(); }
    });

    this._onStoreChange = () => { if (!this.element.hidden) this.render(); };
    this.store.addEventListener('change', this._onStoreChange);
  }

  status(text) {
    const el = this.element.querySelector('[data-prog-status]');
    if (el) el.textContent = text;
  }

  async runAction(fn) {
    if (this.busy) return;
    this.busy = true;
    this.render();
    try {
      const msg = await fn();
      if (msg) this.status(msg);
    } catch (err) {
      this.status(err?.message || '操作失败，请稍后重试');
    } finally {
      this.busy = false;
      this.render();
    }
  }

  open() {
    if (this.destroyed) return;
    this.element.hidden = false;
    this.render();
    this.element.querySelector('.prog-close')?.focus();
  }

  close() {
    this.element.hidden = true;
  }

  render() {
    if (this.destroyed) return;
    const p = this.store.progress;
    const idState = this.store.identity.state;
    const career = this.store.career;
    const summary = this.store.summary;
    const cloud = this.store.cloudState;

    const av = this.element.querySelector('[data-prog-avatar]');
    if (av) {
      if (idState.avatar) {
        const img = new Image();
        img.src = idState.avatar;
        img.alt = '';
        av.replaceChildren(img);
      } else {
        av.innerHTML = `<span>${idState.shortId.slice(0, 2) || 'OP'}</span>`;
      }
    }
    this.element.querySelector('[data-prog-name]').textContent = idState.displayName;
    this.element.querySelector('[data-prog-rank]').textContent = `Lv.${career.level} ${career.rankTitle}`;
    this.element.querySelector('[data-prog-uid]').textContent = idState.source === 'toy' && idState.authenticated
      ? `TOY OPENID · ${idState.uid}`
      : `本地干员 ID · ${idState.uid}`;
    this.element.querySelector('[data-prog-xp-fill]').style.width = `${career.pct}%`;
    this.element.querySelector('[data-prog-xp-text]').textContent = career.level >= 30
      ? `总经验 ${career.xp} · 已达满级`
      : `经验 ${career.intoLevel} / ${career.stepXp}（累计 ${career.xp}）`;
    const cloudBadge = this.element.querySelector('[data-prog-cloud-badge]');
    cloudBadge.textContent = cloud.message;
    cloudBadge.dataset.status = cloud.status;

    const authBtn = this.element.querySelector('[data-prog-auth]');
    authBtn.hidden = !(idState.inToy && !idState.authenticated);
    authBtn.disabled = this.busy;

    this.element.querySelector('[data-prog-stats]').innerHTML = [
      ['累计击杀', p.kills],
      ['爆头击杀', p.headshots],
      ['完成局数', p.matches],
      ['完成回合', p.rounds],
      ['总胜场', p.wins],
    ].map(([label, val]) => `<div class="prog-stat-box"><strong>${val}</strong><span>${label}</span></div>`).join('');

    this.element.querySelector('[data-prog-unlock-summary]').textContent =
      `已解锁 ${summary.skinsUnlocked} / ${summary.skinsTotal} 皮肤与匕首 · ${summary.agentsUnlocked} / ${summary.agentsTotal} 探员`;

    // Follow card
    const followNames = [
      ...TOY_FOLLOW_AGENT_IDS.map((id) => getAgent(id)?.name?.split(' ')[0] || id),
      ...TOY_FOLLOW_SKIN_IDS.slice(0, 6).map((id) => {
        const s = getSkin(id);
        if (!s) return id;
        const cleanName = s.name.replace(' · 原厂涂装', '');
        return s.weapon === 'knife' ? cleanName : `${getWeapon(s.weapon)?.name || s.weapon}·${cleanName}`;
      }),
    ];
    this.element.querySelector('[data-follow-items]').textContent = `包含：${followNames.join('、')} 等共 ${TOY_FOLLOW_AGENT_IDS.length + TOY_FOLLOW_SKIN_IDS.length} 件`;
    const followState = this.element.querySelector('[data-follow-state]');
    followState.textContent = p.social.followed ? '✓ 已解锁' : '待验证';
    followState.classList.toggle('done', p.social.followed);
    this.element.querySelector('[data-social-card="follow"]').classList.toggle('unlocked', p.social.followed);

    // Triple card
    const tripleNames = [
      ...TOY_TRIPLE_AGENT_IDS.map((id) => getAgent(id)?.name?.split(' ')[0] || id),
      ...TOY_TRIPLE_SKIN_IDS.slice(0, 6).map((id) => {
        const s = getSkin(id);
        if (!s) return id;
        const cleanName = s.name.replace(' · 原厂涂装', '');
        return s.weapon === 'knife' ? cleanName : `${getWeapon(s.weapon)?.name || s.weapon}·${cleanName}`;
      }),
    ];
    this.element.querySelector('[data-triple-items]').textContent = `包含：${tripleNames.join('、')} 等共 ${TOY_TRIPLE_AGENT_IDS.length + TOY_TRIPLE_SKIN_IDS.length} 件`;
    this.element.querySelector('[data-triple-steps]').innerHTML = [
      ['👍 点赞', p.social.liked || p.social.tripled],
      ['🪙 投币', p.social.coined || p.social.tripled],
      ['⭐ 收藏', p.social.favorited || p.social.tripled],
    ].map(([label, done]) => `<span class="prog-step ${done ? 'done' : ''}">${label} ${done ? '✓' : ''}</span>`).join('');
    const tripleState = this.element.querySelector('[data-triple-state]');
    tripleState.textContent = p.social.tripled ? '✓ 已解锁' : '待三连';
    tripleState.classList.toggle('done', p.social.tripled);
    this.element.querySelector('[data-social-card="triple"]').classList.toggle('unlocked', p.social.tripled);

    // Disable action buttons while busy
    for (const btn of this.element.querySelectorAll('[data-prog-sync],[data-check-follow],[data-check-triple],[data-go-follow],[data-go-video]')) {
      btn.disabled = this.busy;
    }

    // Milestone roadmap
    const roadmap = this.element.querySelector('[data-prog-roadmap]');
    roadmap.replaceChildren();
    for (const item of ROADMAP_ITEMS) {
      const isAgent = item.kind === 'agent';
      const obj = isAgent ? getAgent(item.id) : getSkin(item.id);
      if (!obj) continue;
      const req = isAgent ? getAgentUnlockRequirement(item.id) : getSkinUnlockRequirement(item.id);
      const ev = evaluateRequirement(req, p);
      const card = document.createElement('button');
      card.type = 'button';
      card.className = `prog-milestone ${ev.unlocked ? 'unlocked' : 'locked'}`;
      const thumb = isAgent
        ? `<div class="prog-ms-badge">${obj.team}</div>`
        : `<img src="${skinPreviewURL(obj)}" alt="" loading="lazy" decoding="async">`;
      const subtitle = isAgent ? `${obj.team} 探员` : (obj.weapon === 'knife' ? '近战匕首' : (getWeapon(obj.weapon)?.name || obj.weapon));
      card.innerHTML = `
        <div class="prog-ms-art">${thumb}</div>
        <div class="prog-ms-info">
          <span class="prog-ms-sub">${subtitle}</span>
          <strong>${obj.name}</strong>
          <small>${ev.progressText}</small>
          <div class="prog-ms-bar"><i style="width:${ev.pct}%"></i></div>
        </div>
        <span class="prog-ms-status">${ev.unlocked ? '去装备 →' : `${ev.pct}%`}</span>
      `;
      card.onclick = () => {
        this.close();
        if (isAgent) this.onOpenAgents();
        else this.onOpenSkins();
      };
      roadmap.append(card);
    }
  }

  destroy() {
    this.destroyed = true;
    this.store.removeEventListener('change', this._onStoreChange);
    this.element.remove();
  }
}
