import './chat.css';

const QUICK_COMMS = [
  '集合进攻 A 点',
  '集合进攻 B 点',
  '中路发现敌人',
  '需要队友支援',
  '正在回防包点',
  '好枪！继续稳住',
];

/**
 * Zero-UGC tactical radio quick-comms chat: players send preset tactical callouts
 * instead of arbitrary free-text input.
 */
export class GameChat {
  constructor({ send, onOpen, onClose }) {
    Object.assign(this, { send, onOpen, onClose });
    this.opened = false;
    this.channel = 'team';
    this.rows = [];
    this.element = document.createElement('section');
    this.element.id = 'game-chat';
    this.element.hidden = true;
    this.element.setAttribute('aria-label', '战术快捷语音');
    this.element.innerHTML = `<div class="chat-log" role="log" aria-live="polite"></div>
      <div class="chat-form chat-quick-panel" hidden>
        <div class="chat-quick-head">
          <button type="button" class="chat-channel">队伍</button>
          <span class="chat-quick-title">战术快捷指令（按 Esc 关闭）</span>
          <button type="button" class="chat-close" aria-label="关闭指令">×</button>
        </div>
        <div class="chat-quick-grid">
          ${QUICK_COMMS.map((text, idx) => `<button type="button" class="chat-quick-btn" data-quick-idx="${idx}"><kbd>${idx + 1}</kbd><span>${text}</span></button>`).join('')}
        </div>
      </div>
      <span class="chat-status" role="status"></span>`;
    document.body.append(this.element);
    this.form = this.element.querySelector('.chat-form');
    this.log = this.element.querySelector('.chat-log');
    this.keyHandler = e => {
      if (!this.opened) return;
      if (e.code === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); return; }
      if (e.code === 'Tab') { e.preventDefault(); this.setChannel(this.channel === 'all' ? 'team' : 'all'); return; }
      const digit = /^Digit([1-6])$/.exec(e.code);
      if (digit) {
        e.preventDefault();
        e.stopPropagation();
        const text = QUICK_COMMS[Number(digit[1]) - 1];
        if (text) { this.send({ type: 'chat', channel: this.channel, text }); this.close(); }
      }
    };
    window.addEventListener('keydown', this.keyHandler, true);
    this.form.querySelector('.chat-channel').onclick = () => this.setChannel(this.channel === 'all' ? 'team' : 'all');
    this.form.querySelector('.chat-close').onclick = () => this.close();
    this.form.querySelectorAll('[data-quick-idx]').forEach(btn => {
      btn.onclick = () => {
        const text = QUICK_COMMS[Number(btn.dataset.quickIdx)];
        if (text) this.send({ type: 'chat', channel: this.channel, text });
        this.close();
      };
    });
    this.viewportChanged = () => {
      const mobile = document.body.classList.contains('touch-device'), vv = window.visualViewport;
      this.element.style.bottom = this.opened && mobile ? `${Math.max(12, innerHeight - (vv?.height || innerHeight) - (vv?.offsetTop || 0) + 12)}px` : '';
      this.log.style.maxHeight = this.opened && mobile ? `${Math.max(40, Math.min(160, (vv?.height || innerHeight) * 0.3))}px` : '';
    };
    window.visualViewport?.addEventListener('resize', this.viewportChanged);
    window.visualViewport?.addEventListener('scroll', this.viewportChanged);
    this.timer = setInterval(() => {
      for (const r of this.rows) r.node.classList.toggle('old', performance.now() - r.at > 10000);
    }, 1000);
  }
  setChannel(channel) {
    this.channel = channel === 'all' ? 'all' : 'team';
    this.form.querySelector('.chat-channel').textContent = this.channel === 'team' ? '队伍' : '全体';
  }
  open(channel = 'team') {
    this.opened = true;
    this.setChannel(channel);
    this.element.classList.add('open');
    this.form.hidden = false;
    this.element.querySelector('.chat-status').textContent = '';
    this.onOpen();
    this.viewportChanged();
  }
  close(resume = true) {
    if (!this.opened) return;
    this.opened = false;
    this.form.hidden = true;
    this.element.classList.remove('open');
    this.viewportChanged();
    if (resume) this.onClose();
  }
  receive(e) {
    if (e.type !== 'chat') return;
    const row = document.createElement('div');
    row.className = 'chat-line';
    const who = document.createElement('b');
    who.style.color = e.team === 'CT' ? '#22d3ee' : '#f6b93b';
    who.textContent = `${e.dead ? '*阵亡* ' : ''}${e.channel === 'team' ? '(队伍) ' : ''}${e.bot ? 'BOT ' : ''}${e.name}：`;
    const text = document.createElement('span');
    text.textContent = e.text;
    row.append(who, text);
    this.log.append(row);
    this.rows.push({ node: row, at: performance.now() });
    while (this.rows.length > 50) this.rows.shift().node.remove();
    this.log.scrollTop = this.log.scrollHeight;
  }
  error(message) {
    this.element.querySelector('.chat-status').textContent = message;
    setTimeout(() => { this.element.querySelector('.chat-status').textContent = ''; }, 4000);
  }
  reset() {
    this.close(false);
    this.rows = [];
    this.log.replaceChildren();
  }
}
