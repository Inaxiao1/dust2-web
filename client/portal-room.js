import {PERFORMANCE_MAPS} from '../shared/performance-map-pool.js';
import {ToyIdentity} from '../scripts/maps/mode-ui/toy-identity.js';
import {upgradeSelect} from './tactical-select.js';
import '../scripts/maps/mode-ui/portal-theme.css';
import './portal-room.css';

export function mountPortalRoom(id, graphicsMode) {
  const map = PERFORMANCE_MAPS.find(item => item.id === id);
  if (!map) return;
  const library = '/perf/';
  const menu = document.querySelector('#menu');
  document.body.classList.add('portal-room');
  document.documentElement.style.background = '#10191e';

  const header = menu.querySelector('.menu-header');
  const brand = header.querySelector('.wordmark');
  brand.className = 'portal-brand';
  brand.href = library;
  brand.setAttribute('aria-label', '随时随地CS，返回对战大厅');
  brand.innerHTML = '<span class="portal-mark" aria-hidden="true"><i></i><i></i><i></i></span><strong>随时随地CS</strong>';
  const loadingBrand = document.querySelector('#loading-screen .loading-header .wordmark');
  loadingBrand.replaceWith(brand.cloneNode(true));
  document.querySelector('#loading-screen .loading-map-title .eyebrow').textContent = 'DEPLOYMENT // 加载战局';
  header.querySelector('#menu-play-tab').textContent = '房间设置';

  const main = menu.querySelector('.menu-content');
  const title = document.createElement('div');
  title.className = 'portal-page-heading';
  title.innerHTML = '<div><span class="portal-eyebrow">CUSTOM MATCH // ROOM SETUP</span><h1>房间设置</h1></div><a><span aria-hidden="true">‹</span> 返回大厅</a>';
  title.querySelector('a').href = library;
  main.before(title);

  const online = document.createElement('a');
  online.href = library;
  online.className = 'portal-online-link';
  online.textContent = '对战大厅';
  header.querySelector('.main-nav').append(online);

  const hero = main.querySelector('.map-showcase');
  const rules = hero.querySelector('.map-rules');
  hero.replaceChildren();
  hero.removeAttribute('aria-labelledby');
  hero.setAttribute('aria-label', map.nameZh + ' · 5v5 在线对战');
  hero.innerHTML = '<div class="portal-map-art"><img alt=""><span class="portal-mode"></span><div class="portal-map-caption"><div class="portal-map-zh"></div><h2 lang="en"></h2></div></div>';
  hero.querySelector('.portal-mode').textContent = '5V5 联网战术对战';
  hero.querySelector('.portal-map-zh').textContent = map.nameZh;
  hero.querySelector('h2').textContent = map.name;
  hero.append(rules);

  const cover = '/perf/mode-previews/' + map.id + '-performance.webp';
  const picture = hero.querySelector('img');
  picture.addEventListener('error', () => {
    picture.classList.add('portal-radar');
    picture.src = '/perf/radars/' + map.id + '.png';
  }, {once: true});
  picture.src = cover;
  document.documentElement.style.setProperty('--loading-map-cover', 'url("' + cover + '")');

  const card = main.querySelector('.match-card');
  card.querySelector('.match-heading').hidden = true;
  card.querySelector('label[for="map-style"]').hidden = true;
  card.querySelector('#home-match-title').textContent = '自建对局配置';

  // Hide UGC nickname & room code text inputs; replace nickname field with non-editable Toy Operator Card.
  const nicknameInput = card.querySelector('#nickname');
  const nicknameWrap = nicknameInput?.parentElement;
  if (nicknameInput && nicknameWrap) {
    nicknameInput.hidden = true;
    nicknameInput.readOnly = true;
    const label = nicknameWrap.querySelector('label');
    if (label) label.textContent = '当前干员身份（Toy SDK 自动同步）';
    const opBadge = document.createElement('div');
    opBadge.className = 'portal-operator-badge';
    opBadge.innerHTML = '<div class="portal-op-avatar" id="portalOpAvatar"><span>OP</span></div><div class="portal-op-info"><strong id="portalOpName">干员读取中…</strong><small id="portalOpId">TOY ID · ----</small></div><button type="button" id="portalToyAuth" class="portal-op-auth" hidden>授权 Toy</button>';
    nicknameWrap.append(opBadge);

    const toy = window.__CS2_TOY_IDENTITY__ || new ToyIdentity();
    window.__CS2_TOY_IDENTITY__ = toy;
    const syncToy = () => {
      const s = toy.state;
      nicknameInput.value = s.displayName;
      const nameEl = opBadge.querySelector('#portalOpName');
      const idEl = opBadge.querySelector('#portalOpId');
      const avEl = opBadge.querySelector('#portalOpAvatar');
      const btnEl = opBadge.querySelector('#portalToyAuth');
      if (nameEl) nameEl.textContent = s.displayName;
      if (idEl) idEl.textContent = s.source === 'toy' && s.authenticated ? `TOY OPENID · ${s.shortId}` : `OPERATOR · #${s.shortId}`;
      if (avEl) {
        if (s.avatar) {
          const img = new Image();
          img.src = s.avatar;
          img.alt = '';
          avEl.replaceChildren(img);
        } else {
          avEl.innerHTML = `<span>${s.shortId.slice(0, 2) || 'OP'}</span>`;
        }
      }
      if (btnEl) {
        btnEl.hidden = !(s.inToy && !s.authenticated);
        btnEl.disabled = s.status === 'authorizing';
      }
    };
    toy.addEventListener('change', syncToy);
    opBadge.querySelector('#portalToyAuth')?.addEventListener('click', () => toy.authorize());
    syncToy();
    toy.init();
  }

  // Hide UGC free-text room-code input row (players join via Online Lobby or invite link).
  const joinRow = card.querySelector('.join-row');
  if (joinRow) joinRow.hidden = true;

  // Replace native <select> dropdowns (#mode, #bots, #home-bot-difficulty) with Valorant tactical controls.
  const modeSelect = card.querySelector('#mode');
  if (modeSelect) upgradeSelect(modeSelect, { variant: 'cards' });
  const botsSelect = card.querySelector('#bots');
  if (botsSelect) upgradeSelect(botsSelect, { variant: 'stepper' });
  const diffSelect = card.querySelector('#home-bot-difficulty');
  if (diffSelect) upgradeSelect(diffSelect, { variant: 'pills' });

  for (const link of document.querySelectorAll('[data-map-library]')) {
    link.href = library;
    link.textContent = '对战大厅';
  }
  document.title = map.nameZh + ' · 随时随地CS';
}
