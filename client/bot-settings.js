import {botDifficultyName,normalizeBotDifficulty} from '../shared/bot-difficulty.js';

export function mountBotSettings(settingsUI, { getState, onChange }) {
  const panel = document.createElement('section');
  panel.innerHTML = `
    <div class="settings-panel-head">
      <div><h3>人机难度与战术风格</h3><p>配置对局内人机的枪法精度、道具协作与回防策略。</p></div>
    </div>
    <div class="settings-group">
      <h4>难度档位选择</h4>
      <label class="config-row">
        <span><strong>AI 难度</strong><small id="bot-difficulty-status" role="status"></small></span>
        <select id="bot-difficulty">
          <option value="easy">轻松 · 手机入门</option>
          <option value="normal">普通 · 均衡默认</option>
          <option value="hard">困难 · 强化枪法与配合</option>
          <option value="vitality">挑战 Vitality 全队 · 职业风格</option>
        </select>
      </label>
    </div>
    <div class="settings-group">
      <h4>AI 战术机制说明</h4>
      <ul class="settings-info-list">
        <li><b>轻松</b>：反应较慢、瞄准更宽容，连败不会自动增强。</li>
        <li><b>普通 / 困难</b>：困难档反应与瞄准精度提升约 30%；连输 2 回合自动强化一次，连赢 2 回合恢复；根据枪声与队友情报动态回防。</li>
        <li><b>进攻与道具</b>：包含 A 小集结、A 大夹击、B 区爆弹等路线，所有档位均仅凭视觉与声音行动，不会穿墙锁头。</li>
      </ul>
    </div>
    <div class="settings-group">
      <h4>Vitality 职业挑战说明</h4>
      <p class="bot-challenge-description">对方固定配置 flameZ、mezii、apEX、ropz、ZywOo 五名人机（好友将加入玩家队伍）：ZywOo 优先狙击，apEX 组织道具，flameZ 先行突破，mezii 补枪守点，ropz 侧翼控图。</p>
      <small class="settings-footnote">创建房间前的选择自动保存在本机；房间内仅房主可统一调整双方人机，新战术从下一回合生效。</small>
    </div>`;

  const select = panel.querySelector('#bot-difficulty');
  const status = panel.querySelector('#bot-difficulty-status');
  let pending = false, timer;

  function refresh() {
    const state = getState();
    if (!pending) select.value = normalizeBotDifficulty(state.value);
    select.disabled = pending || (state.connected && !state.host);
    status.textContent = pending
      ? '正在等待服务器确认…'
      : state.connected
        ? (state.host ? '你是房主，修改将同步到整个房间。' : `当前房间：${botDifficultyName(state.value)}（仅房主可修改）`)
        : '创建新房间时默认使用此难度。';
  }

  function settle() { pending = false; clearTimeout(timer); refresh(); }
  select.onchange = () => {
    const state = getState();
    if (state.connected && !state.host) { refresh(); return; }
    if (state.connected) { pending = true; timer = setTimeout(settle, 5000); }
    onChange(normalizeBotDifficulty(select.value));
    refresh();
  };

  settingsUI.registerTab({ group: 'match', id: 'bots', label: '人机难度', panel, onSelect: refresh });
  const origOpen = settingsUI.open;
  settingsUI.open = (tab) => { refresh(); origOpen(tab); };
  refresh();
  return { refresh, settle };
}
