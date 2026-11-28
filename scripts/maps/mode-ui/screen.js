import {mountRoomDirectory} from './room-directory.js';
import {ToyIdentity} from './toy-identity.js';

const $ = (id) => document.getElementById(id);
const RT = globalThis.__CS2_STATIC_RUNTIME__ && typeof globalThis.__CS2_STATIC_RUNTIME__ === 'object'
  ? globalThis.__CS2_STATIC_RUNTIME__
  : null;
const RT_BUNDLED_ASSETS = new Set(Array.isArray(RT?.bundledAssets) ? RT.bundledAssets : []);
const apiUrl = (p) => (RT?.gameServerOrigin ? new URL(p, RT.gameServerOrigin).href : p);
const staticUrl = (rel) => {
  const clean = String(rel || '').replace(/^\/+/, '');
  return RT ? './' + clean : '/perf/' + clean;
};
const assetUrl = (assetRel) => {
  const clean = String(assetRel || '').replace(/^\/+/, '');
  if (!RT) return '/perf/' + clean;
  if (RT_BUNDLED_ASSETS.has(clean)) return './' + clean;
  if (RT.assetBaseURL && clean.startsWith('assets/')) return new URL(clean.slice('assets/'.length), RT.assetBaseURL).href;
  return './' + clean;
};
const toLocalMatchUrl = (rawUrl) => {
  if (!RT || typeof rawUrl !== 'string') return rawUrl;
  const u = new URL(rawUrl, location.href);
  const m = /^\/perf\/(quality\/)?play\/(de_[a-z0-9_]+)\/$/.exec(u.pathname);
  if (!m) return rawUrl;
  const q = new URLSearchParams(u.search);
  q.set('map', m[2]);
  if (m[1]) q.set('quality', '1');
  return (RT.staticPlayPath || './play.html') + '?' + q.toString();
};
const matchRouteUrl = (mapId, params) => {
  const qs = params instanceof URLSearchParams ? params.toString() : String(params || '');
  if (!RT) return '/perf/play/' + mapId + '/' + (qs ? '?' + qs : '');
  const q = new URLSearchParams(qs);
  q.set('map', mapId);
  return (RT.staticPlayPath || './play.html') + '?' + q.toString();
};

const storageKey = 'duskrain.map-graphics.v1';
const modeLabels = { defuse: '竞技爆破', deathmatch: '团队死斗' };
const teamLabels = { auto: '自动平衡', T: 'T · 恐怖分子', CT: 'CT · 反恐精英' };
const query = new URLSearchParams(location.search);

const AGENT_SHOWCASE = {
  'ct-sas': { team: 'CT', name: '默认反恐精英 · SAS', en: 'SAS', img: assetUrl('assets/characters-cs2/previews/ct-sas.webp') },
  't-phoenix': { team: 'T', name: '默认恐怖分子 · 凤凰战士', en: 'Phoenix', img: assetUrl('assets/characters-cs2/previews/t-phoenix.webp') },
  'ct-ava': { team: 'CT', name: '特别探员艾娃 · 联邦调查局', en: 'Special Agent Ava | FBI', img: assetUrl('assets/characters-cs2/previews/ct-ava.webp') },
  't-miami': { team: 'T', name: '迈阿密达里尔爵士 · 专业人士', en: 'Sir Bloody Miami Darryl', img: assetUrl('assets/characters-cs2/previews/t-miami.webp') },
  'ct-syfers': { team: 'CT', name: '迈克·赛弗斯 | FBI 狙击手', en: 'Michael Syfers | FBI Sniper', img: assetUrl('assets/characters-cs2/popular/ct-syfers/portrait-d31a4bb10887.webp') },
  'ct-ricksaw': { team: 'CT', name: '海军上尉里克索尔 | 海豹部队', en: 'Lt. Commander Ricksaw | SEAL', img: assetUrl('assets/characters-cs2/popular/ct-ricksaw/portrait-31b70d1a6dbf.webp') },
  'ct-operator': { team: 'CT', name: '特种兵 | FBI 特警', en: 'Operator | FBI SWAT', img: assetUrl('assets/characters-cs2/popular/ct-operator/portrait-c96d669698b2.webp') },
  't-number-k': { team: 'T', name: '老K | 专业人士', en: 'Number K | The Professionals', img: assetUrl('assets/characters-cs2/popular/t-number-k/portrait-2189df87326f.webp') },
  't-silent-darryl': { team: 'T', name: '残酷的达里尔爵士（沉默）', en: 'Sir Bloody Silent Darryl', img: assetUrl('assets/characters-cs2/popular/t-silent-darryl/portrait-a4685d65236d.webp') },
  't-enforcer': { team: 'T', name: '执行者 | 凤凰战士', en: 'Enforcer | Phoenix', img: assetUrl('assets/characters-cs2/popular/t-enforcer/portrait-909fe8d4460e.webp') },
};

let saved = {};
try { saved = JSON.parse(localStorage.getItem(storageKey)) || {}; } catch {}
let quickMode = ['any', 'defuse', 'deathmatch'].includes(saved.quickMode) ? saved.quickMode : 'any';
let customMode = saved.customMode === 'deathmatch' ? 'deathmatch' : 'defuse';
let customTeam = ['auto', 'T', 'CT'].includes(saved.customTeam) ? saved.customTeam : 'auto';
let customBots = Number.isInteger(saved.customBots) && saved.customBots >= 0 && saved.customBots <= 9 ? saved.customBots : 9;
let previewFaction = saved.previewFaction === 'T' ? 'T' : 'CT';
let maps = [];
let selected;
let images = {};
let stageTiles = [];
let modalMapCards = [];
let latestRecommendation = null;
let controlPlaneEnabled = false;
let activeBackdropLayer = 'A';
let hasActiveBackdrop = false;
let backdropSwapSeq = 0;
let currentBackdropSrc = '';
let heroSwitchSeq = 0;
let heroSwitchTimer = 0;
let currentHeroSrc = '';
const failedFiles = new Set();

function stageJoinTicket(ticket) {
  if (!ticket?.workerWsUrl || !ticket?.joinToken) return;
  try {
    sessionStorage.setItem('cs.join.ticket.v1', JSON.stringify({
      action: ticket.action || 'join',
      roomCode: ticket.roomCode || '',
      mapId: ticket.mapId || '',
      mode: ticket.mode || 'defuse',
      workerId: ticket.workerId || '',
      workerWsUrl: ticket.workerWsUrl,
      joinToken: ticket.joinToken,
      expiresAt: ticket.expiresAt || 0,
    }));
  } catch {}
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.error || '请求失败');
  return data;
}

/* 1. Bilibili Toy SDK Identity & Cloud Progression (Zero-UGC) */
const TOY_ID_KEY = Symbol.for('cs2.toyIdentity');
const toyIdentity = globalThis[TOY_ID_KEY] || new ToyIdentity();
globalThis[TOY_ID_KEY] = toyIdentity;
let lobbyProgressSummary = '';

function readLocalCareerSummary(uid) {
  try {
    const clean = String(uid || 'guest').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    const raw = JSON.parse(localStorage.getItem('cs.progression.v1.' + clean) || 'null');
    if (!raw || typeof raw !== 'object') return 'Lv.1 · 0 杀';
    const kills = Math.max(0, Math.floor(Number(raw.kills) || 0));
    const headshots = Math.max(0, Math.floor(Number(raw.headshots) || 0));
    const rounds = Math.max(0, Math.floor(Number(raw.rounds) || 0));
    const matches = Math.max(0, Math.floor(Number(raw.matches) || 0));
    const wins = Math.max(0, Math.floor(Number(raw.wins) || 0));
    const xp = kills * 25 + headshots * 15 + rounds * 20 + matches * 120 + wins * 80;
    let level = 1, floorXp = 0, stepXp = 600;
    while (level < 30 && xp >= floorXp + stepXp) { floorXp += stepXp; level++; stepXp = Math.round(600 + (level - 1) * 260); }
    return `Lv.${level} · ${kills} 杀 · ${matches} 局`;
  } catch {
    return 'Lv.1 · 0 杀';
  }
}

function renderToyCard() {
  const s = toyIdentity.state;
  const nameEl = $('toyPlayerName');
  const idEl = $('toyPlayerId');
  const avatarEl = $('toyPlayerAvatar');
  const authBtn = $('toyAuthBtn');
  if (nameEl) nameEl.textContent = s.displayName;
  const careerTag = lobbyProgressSummary || readLocalCareerSummary(s.uid);
  if (idEl) idEl.textContent = s.source === 'toy' && s.authenticated
    ? `B站干员 · ${careerTag}`
    : `本地干员 · ${careerTag}`;
  if (avatarEl) {
    const avatarKey = s.avatar ? `img:${s.avatar}` : `txt:${(s.displayName || '').replace(/^干员#?/, '').trim().slice(0, 1) || 'OP'}`;
    if (avatarEl.dataset.avatarKey !== avatarKey) {
      avatarEl.dataset.avatarKey = avatarKey;
      if (s.avatar) {
        const img = new Image();
        img.src = s.avatar;
        img.alt = '';
        avatarEl.replaceChildren(img);
      } else {
        const span = document.createElement('span');
        span.textContent = (s.displayName || '').replace(/^干员#?/, '').trim().slice(0, 1) || 'OP';
        avatarEl.replaceChildren(span);
      }
    }
  }
  if (authBtn) {
    authBtn.hidden = !(s.inToy && !s.authenticated);
    authBtn.disabled = s.status === 'authorizing';
    authBtn.textContent = s.status === 'authorizing' ? '授权中…' : '授权 Toy';
  }
}
toyIdentity.addEventListener('change', () => {
  renderToyCard();
  if (toyIdentity.state.inToy && toyIdentity.state.authenticated) {
    void syncLobbyCloudProgression();
  }
});
$('toyAuthBtn')?.addEventListener('click', (e) => { e.stopPropagation(); toyIdentity.authorize(); });
$('toyPlayerCard')?.addEventListener('click', (e) => {
  if (e.target.closest('#toyAuthBtn')) return;
  void openHub('progression');
});
const playerCardEl = $('toyPlayerCard');
if (playerCardEl) { playerCardEl.style.cursor = 'pointer'; playerCardEl.title = '点击查看成长任务与 Toy 云存档'; }
window.addEventListener('cs2-progression-synced', () => {
  lobbyProgressSummary = '';
  renderToyCard();
  renderHeroAgent(false);
});
renderToyCard();
toyIdentity.init().then((s) => {
  if (s?.inToy && s?.authenticated) void syncLobbyCloudProgression();
});

async function syncLobbyCloudProgression() {
  try {
    if (!hubLoader) hubLoader = import(new URL(staticUrl('assets/lobby-hub.js'), document.baseURI).href);
    const mod = await hubLoader;
    const initProg = mod?.initHubProgression || globalThis.__CS2_LOBBY_HUB__?.initHubProgression;
    if (typeof initProg === 'function') {
      const store = await initProg();
      const updateMeta = () => {
        const c = store.career;
        const p = store.progress;
        lobbyProgressSummary = `Lv.${c.level} · ${p.kills} 杀 · ${p.matches} 局`;
        renderToyCard();
        renderHeroAgent(false);
      };
      store.addEventListener('change', updateMeta);
      updateMeta();
    }
  } catch {}
}

/* 2. Equipped Hero Agent Showcase (Synced Live with Agent Warehouse) */
function readEquippedAgents() {
  try {
    const raw = JSON.parse(localStorage.getItem('dust2.agents.v1') || '{}');
    return {
      CT: AGENT_SHOWCASE[raw?.CT]?.team === 'CT' ? raw.CT : 'ct-sas',
      T: AGENT_SHOWCASE[raw?.T]?.team === 'T' ? raw.T : 't-phoenix',
    };
  } catch {
    return { CT: 'ct-sas', T: 't-phoenix' };
  }
}

function renderHeroAgent(animate = false) {
  const loadout = readEquippedAgents();
  const agent = AGENT_SHOWCASE[loadout[previewFaction]] || AGENT_SHOWCASE['ct-sas'];
  document.body.dataset.faction = previewFaction;
  document.querySelectorAll('[data-preview-faction]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.previewFaction === previewFaction);
  });
  const img = $('heroAgentImg');
  const nameEl = $('heroAgentName');
  const enEl = $('heroAgentEn');
  if (nameEl) nameEl.textContent = agent.name;
  if (enEl) enEl.textContent = agent.en;
  if (!img || currentHeroSrc === agent.img) return;

  currentHeroSrc = agent.img;
  const seq = ++heroSwitchSeq;
  clearTimeout(heroSwitchTimer);

  const applyAndReveal = () => {
    if (seq !== heroSwitchSeq) return;
    let settled = false;
    const finish = () => {
      if (settled || seq !== heroSwitchSeq) return;
      settled = true;
      img.onload = null;
      img.onerror = null;
      const reveal = () => {
        if (seq !== heroSwitchSeq) return;
        img.classList.remove('is-loading', 'switching');
      };
      if (typeof img.decode === 'function') {
        img.decode().then(reveal, reveal);
      } else {
        reveal();
      }
    };
    img.onload = finish;
    img.onerror = finish;
    if (img.dataset.agentSrc !== agent.img) {
      img.dataset.agentSrc = agent.img;
      img.src = agent.img;
    }
    if (img.complete && img.naturalWidth > 0) finish();
  };

  if (animate) {
    img.classList.add('switching');
    heroSwitchTimer = setTimeout(applyAndReveal, 95);
  } else {
    applyAndReveal();
  }
}

document.querySelectorAll('[data-preview-faction]').forEach((btn) => {
  btn.addEventListener('click', () => {
    previewFaction = btn.dataset.previewFaction === 'T' ? 'T' : 'CT';
    renderHeroAgent(true);
    remember();
  });
});
window.addEventListener('cs2-agent-updated', (event) => {
  const team = event?.detail?.agent?.team;
  if (team === 'CT' || team === 'T') previewFaction = team;
  renderHeroAgent(true);
});
renderHeroAgent(false);

/* 3. Live Online Rooms Directory (Docked Full-Height Right Sidebar) */
const directory = mountRoomDirectory($('onlineRooms'), {
  graphics: () => 'performance',
  onJoin: async (event, room) => {
    if (!controlPlaneEnabled) return;
    event.preventDefault();
    try {
      const ticket = await postJson(apiUrl('/perf/api/rooms/' + encodeURIComponent(room.code) + '/join'), {
        playerName: toyIdentity.playerName,
        playerUid: toyIdentity.uid || '',
      });
      stageJoinTicket({ ...ticket, action: 'join' });
      location.assign(toLocalMatchUrl(ticket.joinUrl) || matchRouteUrl(room.mapId, new URLSearchParams({ room: room.code, join: '1', matchMode: room.mode })));
    } catch {
      location.assign(matchRouteUrl(room.mapId, new URLSearchParams({ room: room.code, join: '1', matchMode: room.mode })));
    }
  },
  onCount: (rooms, humans, cluster) => {
    const statusText = $('serverStatusText');
    if (statusText) {
      if (cluster?.full && cluster?.totalCapacity) {
        statusText.textContent = `全服满载 · ${humans}/${cluster.totalCapacity} 人在线`;
      } else if (rooms > 0) {
        const cap = cluster?.totalCapacity ? `/${cluster.totalCapacity}` : '';
        statusText.textContent = `${humans}${cap} 人在线 · ${rooms} 个活跃房间`;
      } else {
        statusText.textContent = '服务在线 · 5v5 实时联网';
      }
    }
    refreshQuickJoin();
    refreshMapActivity();
  },
});

/* 4. Folded Custom Room Modal Controls */
const customModal = $('customModal');
let lastFocusedBeforeModal = null;

function openCustomModal() {
  if (!customModal) return;
  lastFocusedBeforeModal = document.activeElement;
  customModal.hidden = false;
  $('closeCustomModal')?.focus();
}
function closeCustomModal() {
  if (!customModal || customModal.hidden) return;
  customModal.hidden = true;
  if (lastFocusedBeforeModal?.isConnected) lastFocusedBeforeModal.focus?.({ preventScroll: true });
}

$('openCustomModal')?.addEventListener('click', openCustomModal);
$('openCustomFromBar')?.addEventListener('click', openCustomModal);
$('closeCustomModal')?.addEventListener('click', closeCustomModal);
customModal?.addEventListener('click', (event) => {
  if (event.target === customModal) closeCustomModal();
});
document.addEventListener('keydown', (event) => {
  if (event.code === 'Escape' && customModal && !customModal.hidden) {
    event.preventDefault();
    closeCustomModal();
  }
});
if (location.hash === '#custom' || location.hash === '#maps') openCustomModal();

/* 5. Lazy-Loaded Armory, Agents, Skins & Settings Modals right on Homepage */
let hubLoader = null;
async function openHub(panel, triggerBtn) {
  if (triggerBtn) triggerBtn.disabled = true;
  try {
    closeCustomModal();
    if (!hubLoader) {
      hubLoader = import(new URL(staticUrl('assets/lobby-hub.js'), document.baseURI).href);
    }
    const mod = await hubLoader;
    const opener = mod?.openHubPanel || globalThis.__CS2_LOBBY_HUB__?.openHubPanel;
    if (typeof opener !== 'function') throw new Error('lobby-hub entrypoint unavailable');
    await opener(panel);
  } catch (err) {
    console.error('Failed to open hub panel:', err);
    hubLoader = null;
  } finally {
    if (triggerBtn) triggerBtn.disabled = false;
  }
}
document.querySelectorAll('[data-hub]').forEach((btn) => {
  btn.addEventListener('click', () => openHub(btn.dataset.hub, btn));
});
document.querySelector('[data-tab-home]')?.addEventListener('click', () => closeCustomModal());

async function json(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(String(response.status));
  return response.json();
}

function remember() {
  try {
    localStorage.setItem(storageKey, JSON.stringify({
      map: selected?.id || 'de_dust2',
      mode: 'performance',
      quickMode,
      customMode,
      customTeam,
      customBots,
      previewFaction,
    }));
  } catch {}
}

function imageURL(file) {
  if (typeof file !== 'string' || !/^[a-z0-9][a-z0-9_.-]*\.(webp|avif|jpe?g|png)$/i.test(file) || failedFiles.has(file)) return null;
  const base = staticUrl('mode-previews/' + file);
  return RT ? base : base + '?v=pbr3';
}

/* 6. Dual-Layer Crossfade Living Map Stage */
function setStageMapVisual(map) {
  if (!map) return;
  if ($('stageMapZh')) $('stageMapZh').textContent = map.nameZh;
  if ($('stageMapEn')) $('stageMapEn').textContent = map.name;
  if ($('stageMapSize')) {
    $('stageMapSize').textContent = Number.isFinite(map.gzipBytes)
      ? `极速加载 · ${(map.gzipBytes / 1e6).toFixed(1)} MB`
      : '5v5 经典地图';
  }
  const file = images[map.id]?.performance;
  const url = imageURL(file) || staticUrl('radars/' + map.id + '.png');
  if (url === currentBackdropSrc) return;
  currentBackdropSrc = url;

  const nextLayer = !hasActiveBackdrop ? 'A' : (activeBackdropLayer === 'A' ? 'B' : 'A');
  const incoming = nextLayer === 'A' ? $('backdropA') : $('backdropB');
  const outgoing = nextLayer === 'A' ? $('backdropB') : $('backdropA');
  if (!incoming || !outgoing) return;

  const seq = ++backdropSwapSeq;
  let settled = false;
  const commit = () => {
    if (settled || seq !== backdropSwapSeq) return;
    settled = true;
    incoming.onload = null;
    incoming.onerror = null;
    const reveal = () => {
      if (seq !== backdropSwapSeq) return;
      incoming.classList.add('active');
      outgoing.classList.remove('active');
      activeBackdropLayer = nextLayer;
      hasActiveBackdrop = true;
    };
    if (typeof incoming.decode === 'function') {
      incoming.decode().then(reveal, reveal);
    } else {
      reveal();
    }
  };

  incoming.onload = commit;
  incoming.onerror = () => {
    if (settled || seq !== backdropSwapSeq) return;
    settled = true;
    incoming.onload = null;
    incoming.onerror = null;
    if (file) failedFiles.add(file);
    const fallbackUrl = staticUrl('radars/' + map.id + '.png');
    if (url !== fallbackUrl) {
      currentBackdropSrc = '';
      setStageMapVisual(map);
    }
  };

  if (incoming.dataset.backdropSrc === url && incoming.complete && incoming.naturalWidth > 0) {
    commit();
    return;
  }
  incoming.dataset.backdropSrc = url;
  incoming.src = url;
  if (incoming.complete && incoming.naturalWidth > 0) commit();
}

/* 7. Quick Join Recommendation */
function renderQuickJoinUI(rec) {
  latestRecommendation = rec;
  const title = $('quickJoinTitle');
  const hint = $('quickJoinHint');
  if (!rec || !title || !hint) return;
  if (rec.action === 'full' || rec.clusterFull) {
    title.textContent = '全服人数已满 · 暂缓进局';
    hint.textContent = rec.message || '所有战区节点已达上限，请稍后再试';
    return;
  }
  if (rec.action === 'join' && rec.room) {
    const r = rec.room;
    const mapLabel = r.mapNameZh || r.mapName || r.mapId;
    const modeLabel = modeLabels[r.mode] || '对战';
    const nodeTag = r.nodeLabel ? `${r.nodeLabel} · ` : '';
    title.textContent = `快速加入 · ${mapLabel}`;
    hint.textContent = `${nodeTag}${modeLabel} · ${r.humans}/${r.capacity} 真人在线 · 点击直连`;
  } else {
    const mapObj = maps.find(m => m.id === rec.mapId) || selected;
    const mapLabel = mapObj?.nameZh || '炙热沙城 II';
    const modeLabel = modeLabels[rec.mode] || '竞技爆破';
    const nodeTag = rec.nodeLabel ? `${rec.nodeLabel} · ` : '';
    title.textContent = `快速开战 · ${mapLabel}`;
    hint.textContent = `${nodeTag}秒开「${modeLabel}」新战局 · 自动补齐人机`;
  }
}

async function refreshQuickJoin() {
  const preferredMap = selected?.id || 'de_dust2';
  const params = new URLSearchParams({ mode: quickMode, preferredMap });
  try {
    const rec = await json(apiUrl('/perf/quick-join.json?' + params));
    if (rec?.joinUrl) rec.joinUrl = toLocalMatchUrl(rec.joinUrl);
    renderQuickJoinUI(rec);
  } catch {
    const fallbackMode = quickMode === 'deathmatch' ? 'deathmatch' : 'defuse';
    renderQuickJoinUI({
      action: 'create',
      mapId: preferredMap,
      mode: fallbackMode,
      joinUrl: matchRouteUrl(preferredMap, new URLSearchParams({ autostart: '1', matchMode: fallbackMode })),
    });
  }
}

async function refreshMapActivity() {
  try {
    const data = await json(apiUrl('/perf/rooms.json'));
    const counts = new Map();
    for (const room of data.rooms || []) {
      const prev = counts.get(room.mapId) || { rooms: 0, humans: 0 };
      prev.rooms += 1;
      prev.humans += room.humans || 0;
      counts.set(room.mapId, prev);
    }
    for (const tile of stageTiles) {
      const badge = tile.querySelector('.tile-live');
      if (!badge) continue;
      const info = counts.get(tile.dataset.map);
      badge.hidden = !info;
      if (info) badge.textContent = `${info.humans}人`;
    }
    for (const card of modalMapCards) {
      const badge = card.querySelector('.cs-map-live');
      if (!badge) continue;
      const info = counts.get(card.dataset.map);
      badge.hidden = !info;
      if (info) badge.textContent = `${info.humans} 人`;
    }
  } catch {}
}

/* 8. Custom Room Modal Controls (Zero Dropdowns) */
function renderCustomBotPips() {
  const container = $('customBotPips');
  if (!container) return;
  container.innerHTML = '';
  for (let i = 1; i <= 9; i++) {
    const pip = document.createElement('button');
    pip.type = 'button';
    pip.className = i <= customBots ? 'filled' : '';
    pip.setAttribute('aria-label', `${i} 名人机`);
    pip.onclick = () => {
      customBots = customBots === i ? i - 1 : i;
      syncCustomUI();
      remember();
    };
    container.append(pip);
  }
}

function syncCustomUI() {
  document.querySelectorAll('[data-custom-mode]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.customMode === customMode);
  });
  document.querySelectorAll('[data-custom-team]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.customTeam === customTeam);
  });
  document.querySelectorAll('[data-custom-bots]').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.customBots) === customBots);
  });
  const minus = $('customBotMinus'), plus = $('customBotPlus');
  if (minus) minus.disabled = customBots <= 0;
  if (plus) plus.disabled = customBots >= 9;
  renderCustomBotPips();
  const readout = $('customBotsReadout');
  if (readout) {
    readout.textContent = customBots === 0
      ? '0 名 · 纯真人'
      : customBots === 9
        ? '9 名 · 5v5 满员'
        : `${customBots} 名人机`;
  }
  if (selected) {
    $('customLaunchSummary').textContent = `${selected.nameZh} · ${modeLabels[customMode]} · ${teamLabels[customTeam]} · ${customBots} 名人机`;
  }
}

function updateSelectedMap() {
  if (!selected) return;
  setStageMapVisual(selected);
  if ($('commandSelectedMap')) $('commandSelectedMap').textContent = `首选地图：${selected.nameZh}`;
  for (const tile of stageTiles) {
    const active = tile.dataset.map === selected.id;
    tile.classList.toggle('active', active);
    tile.setAttribute('aria-pressed', String(active));
  }
  for (const card of modalMapCards) {
    const active = card.dataset.map === selected.id;
    card.classList.toggle('active', active);
    card.setAttribute('aria-pressed', String(active));
  }
  syncCustomUI();
  refreshQuickJoin();
  $('announce').textContent = '已选择 ' + selected.nameZh;
}

function buildMapUI() {
  stageTiles = maps.map(map => {
    const btn = document.createElement('button');
    btn.className = 'stage-map-tile';
    btn.type = 'button';
    btn.dataset.map = map.id;
    const img = new Image();
    img.alt = '';
    img.decoding = 'async';
    img.loading = 'lazy';
    const thumb = imageURL(images[map.id]?.thumbnail);
    const useRadar = () => { img.onerror = null; img.src = staticUrl('radars/' + map.id + '.png'); };
    if (thumb) { img.onerror = useRadar; img.src = thumb; } else useRadar();
    const live = document.createElement('span');
    live.className = 'tile-live';
    live.hidden = true;
    const name = document.createElement('strong');
    name.textContent = map.nameZh;
    btn.append(img, live, name);
    btn.addEventListener('click', () => {
      selected = map;
      updateSelectedMap();
      remember();
    });
    return btn;
  });
  $('stageMapStrip')?.replaceChildren(...stageTiles);

  modalMapCards = maps.map(map => {
    const btn = document.createElement('button');
    btn.className = 'cs-map-card';
    btn.type = 'button';
    btn.dataset.map = map.id;
    const img = new Image();
    img.alt = '';
    img.decoding = 'async';
    img.loading = 'lazy';
    const thumb = imageURL(images[map.id]?.thumbnail);
    const useRadar = () => { img.onerror = null; img.className = 'is-radar'; img.src = staticUrl('radars/' + map.id + '.png'); };
    if (thumb) { img.onerror = useRadar; img.src = thumb; } else useRadar();
    const live = document.createElement('span');
    live.className = 'cs-map-live';
    live.hidden = true;
    const name = document.createElement('strong');
    name.textContent = map.nameZh;
    btn.append(img, live, name);
    btn.addEventListener('mouseenter', () => setStageMapVisual(map));
    btn.addEventListener('click', () => {
      selected = map;
      updateSelectedMap();
      remember();
    });
    return btn;
  });
  $('customMapGrid')?.replaceChildren(...modalMapCards);
}

/* 9. Event Bindings */
function syncQuickModePills() {
  document.querySelectorAll('[data-quick-mode]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.quickMode === quickMode);
  });
}
document.querySelectorAll('[data-quick-mode]').forEach(btn => {
  btn.addEventListener('click', () => {
    quickMode = btn.dataset.quickMode;
    syncQuickModePills();
    remember();
    refreshQuickJoin();
  });
});
syncQuickModePills();

document.querySelectorAll('[data-custom-mode]').forEach(btn => {
  btn.addEventListener('click', () => { customMode = btn.dataset.customMode; syncCustomUI(); remember(); });
});
document.querySelectorAll('[data-custom-team]').forEach(btn => {
  btn.addEventListener('click', () => { customTeam = btn.dataset.customTeam; syncCustomUI(); remember(); });
});
document.querySelectorAll('[data-custom-bots]').forEach(btn => {
  btn.addEventListener('click', () => { customBots = Number(btn.dataset.customBots); syncCustomUI(); remember(); });
});
$('customBotMinus')?.addEventListener('click', () => { if (customBots > 0) { customBots--; syncCustomUI(); remember(); } });
$('customBotPlus')?.addEventListener('click', () => { if (customBots < 9) { customBots++; syncCustomUI(); remember(); } });

$('customLaunchBtn')?.addEventListener('click', async () => {
  if (!selected) return;
  const btn = $('customLaunchBtn');
  const params = new URLSearchParams({
    autostart: '1',
    matchMode: customMode,
    bots: String(customBots),
    team: customTeam,
  });
  if (controlPlaneEnabled) {
    if (btn) btn.disabled = true;
    try {
      const ticket = await postJson(apiUrl('/perf/api/rooms'), {
        mapId: selected.id,
        mode: customMode,
        visibility: 'public',
        playerName: toyIdentity.playerName,
        playerUid: toyIdentity.uid || '',
      });
      stageJoinTicket({ ...ticket, action: 'create' });
      params.set('room', ticket.roomCode);
      location.assign(matchRouteUrl(selected.id, params));
      return;
    } catch {
      // Fall through to local/gateway route if control plane rejected.
    } finally {
      if (btn) btn.disabled = false;
    }
  }
  location.assign(matchRouteUrl(selected.id, params));
});

$('quickJoinBtn')?.addEventListener('click', async () => {
  const btn = $('quickJoinBtn');
  btn.disabled = true;
  try {
    const preferredMap = selected?.id || 'de_dust2';
    if (controlPlaneEnabled) {
      const ticket = await postJson(apiUrl('/perf/api/quick-join'), {
        mode: quickMode,
        preferredMap,
        playerName: toyIdentity.playerName,
        playerUid: toyIdentity.uid || '',
      }).catch(() => null);
      if (ticket?.joinUrl) {
        stageJoinTicket(ticket);
        location.assign(toLocalMatchUrl(ticket.joinUrl));
        return;
      }
    }
    const params = new URLSearchParams({ mode: quickMode, preferredMap });
    const fresh = await json(apiUrl('/perf/quick-join.json?' + params)).catch(() => latestRecommendation);
    if (fresh?.action === 'full' || fresh?.clusterFull) {
      renderQuickJoinUI(fresh);
      return;
    }
    if (fresh?.joinUrl) {
      location.assign(toLocalMatchUrl(fresh.joinUrl));
      return;
    }
  } finally {
    btn.disabled = false;
  }
});

async function load() {
  $('loading').hidden = false;
  $('problem').hidden = true;
  try {
    const [catalog, entries, previews, health] = await Promise.all([
      json(staticUrl('catalog.json')),
      json(apiUrl('/perf/graphics.json')).catch(() => null),
      json(staticUrl('mode-previews/previews.json')).catch(() => ({ maps: {} })),
      json(apiUrl('/perf/health')).catch(() => ({})),
    ]);
    controlPlaneEnabled = health?.controlPlane === true;
    const routes = new Map((entries?.maps || []).map(route => [route.id, route]));
    images = previews.maps || {};
    maps = catalog.maps
      .filter(map => /^de_[a-z0-9_]+$/.test(map.id) && (RT || routes.get(map.id)?.performanceURL))
      .map(map => ({
        ...map,
        performanceURL: matchRouteUrl(map.id, ''),
        ...(routes.get(map.id) || {}),
      }));
    if (!maps.length) throw new Error('empty');
    selected = [query.get('map'), saved.map, 'de_dust2'].map(id => maps.find(map => map.id === id)).find(Boolean) || maps[0];
    buildMapUI();
    updateSelectedMap();
    refreshMapActivity();
  } catch {
    $('problem').hidden = false;
  } finally {
    $('loading').hidden = true;
  }
}

$('retry')?.addEventListener('click', load);
load();
