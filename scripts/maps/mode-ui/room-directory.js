import {fetchGameApi} from './origin-failover.js';

const roomCode = /^[A-Z0-9]{4,12}$/;
const mapId = /^de_[a-z0-9_]+$/;
const modeLabels = {defuse:'竞技爆破', deathmatch:'团队死斗'};

function staticRuntime() {
  const rt = globalThis.__CS2_STATIC_RUNTIME__;
  return rt && typeof rt === 'object' ? rt : null;
}

function availableRooms(rooms) {
  return rooms.filter(room => room && mapId.test(room.mapId) && roomCode.test(room.code)
    && Object.hasOwn(modeLabels, room.mode) && room.phase !== 'matchEnded'
    && Number.isInteger(room.capacity) && room.capacity > 0
    && Number.isInteger(room.humans) && room.humans > 0 && room.humans <= room.capacity
    && Number.isInteger(room.bots) && room.bots >= 0 && Array.isArray(room.players));
}

export function directoryJoinPath(room, graphics) {
  if (!mapId.test(room.mapId) || !roomCode.test(room.code) || !Object.hasOwn(modeLabels, room.mode)) return null;
  const quality = graphics === 'quality' && room.qualityAvailable;
  const rt = staticRuntime();
  const nodeParam = typeof room.nodeId === 'string' && /^[a-zA-Z0-9_-]{1,32}$/.test(room.nodeId) ? room.nodeId : '';
  if (rt) {
    const params = new URLSearchParams({map:room.mapId, room:room.code, join:'1', matchMode:room.mode});
    if (quality) params.set('quality', '1');
    if (nodeParam) params.set('node', nodeParam);
    return (rt.staticPlayPath || './play.html') + '?' + params;
  }
  const params = new URLSearchParams({room:room.code, join:'1', matchMode:room.mode});
  if (nodeParam) params.set('node', nodeParam);
  return '/perf/' + (quality ? 'quality/' : '') + 'play/' + room.mapId + '/?' + params;
}

// A plain ?room= invitation keeps its usual confirmation. Only directory links start a join.
export function consumeDirectoryJoin(url, replace) {
  const isPerfPath = /^\/perf\/(?:quality\/)?play\/de_[a-z0-9_]+\/$/.test(url.pathname);
  const isStaticPlay = /(?:^|\/)play\.html$/i.test(url.pathname) && mapId.test(url.searchParams.get('map') || '');
  if ((!isPerfPath && !isStaticPlay) || url.searchParams.get('join') !== '1') return null;
  const code = url.searchParams.get('room'), mode = url.searchParams.get('matchMode');
  url.searchParams.delete('join');
  url.searchParams.delete('matchMode');
  replace(url);
  return roomCode.test(code || '') && Object.hasOwn(modeLabels, mode) ? {code, mode} : null;
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

export function mountRoomDirectory(section, {
  graphics, onJoin, onCount, lastSession, visible = () => true,
}) {
  const heading = node('div', 'directory-heading', '');
  const title = node('h2', '', '联机大厅');
  const refreshButton = node('button', 'directory-refresh', '刷新房间');
  refreshButton.type = 'button';
  heading.append(title, refreshButton);
  const status = node('p', 'directory-status', '正在获取在线房间…');
  status.setAttribute('role', 'status');
  const list = node('div', 'directory-list', '');
  section.append(heading, status, list);
  let rooms = null, clusterMeta = null, signature = null, request = null, nextPoll, deadline;
  let away = false, disposed = false, partial = false;

  function setStatus(value) {
    if (status.textContent !== value) status.textContent = value;
  }

  function row(room, graphicsMode, last) {
    const card = node('article', 'directory-room', '');
    const details = node('div', 'directory-details', '');
    const name = room.mapNameZh || room.mapName || room.mapId;
    details.append(node('h3', '', name + ' · ' + modeLabels[room.mode]));
    const seats = room.capacity - room.humans;
    const nodePrefix = room.nodeLabel ? room.nodeLabel + ' · ' : '';
    details.append(node('div', 'directory-meta', nodePrefix + '房间 ' + room.code + ' · ' + room.humans + ' 名玩家 · '
      + room.bots + ' 名人机 · 可加入 ' + (room.joinable ? seats : 0) + ' 人'));
    details.append(node('div', 'directory-players', '在线玩家　' + room.players.join('、')));
    const joinable = room.joinable && seats > 0;
    const fallback = graphicsMode === 'quality' && !room.qualityAvailable;
    const rejoin = last?.room === room.code && (last.mapId ?? 'de_dust2') === room.mapId;
    const action = node(joinable ? 'a' : 'span', 'directory-join', joinable
      ? (rejoin ? '重新加入' : '加入房间') + (fallback ? ' · 高帧率' : '') : (seats ? '节点已满' : '已满员'));
    if (joinable) {
      action.href = directoryJoinPath(room, graphicsMode);
      action.dataset.room = room.mapId + ':' + room.code;
      action.setAttribute('aria-label', action.textContent + '，' + name + '，' + room.code);
      action.onclick = event => {
        if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && !disposed) onJoin?.(event, room);
      };
    }
    card.append(details, action);
    return card;
  }

  function render() {
    if (rooms === null || disposed) return;
    const graphicsMode = graphics(), last = lastSession?.();
    const state = JSON.stringify([rooms, graphicsMode, last?.room, last?.mapId, partial]);
    if (signature === state) return;
    signature = state;
    const focusedRoom = document.activeElement?.dataset?.room;
    list.replaceChildren(...rooms.map(room => row(room, graphicsMode, last)));
    if (focusedRoom) {
      const next = Array.from(list.querySelectorAll('a')).find(link => link.dataset.room === focusedRoom);
      (next || refreshButton).focus({preventScroll:true});
    }
    const humans = rooms.reduce((count, room) => count + room.humans, 0);
    const capText = clusterMeta?.totalCapacity ? `（上限 ${clusterMeta.totalCapacity}）` : '';
    const summary = rooms.length ? rooms.length + ' 个房间 · ' + humans + ' 名玩家在线' + capText : (partial ? '已响应的地图暂无玩家在线' : '当前所有地图均无玩家在线。');
    setStatus(summary + (partial ? ' · 部分地图暂未响应' : ''));
    onCount?.(rooms.length, humans, clusterMeta);
  }

  function active() { return !disposed && !away && !document.hidden && visible(); }
  function pause() {
    clearTimeout(nextPoll);
    clearTimeout(deadline);
    const pending = request;
    request = null;
    pending?.abort();
  }
  async function refresh() {
    if (!active() || request) return;
    clearTimeout(nextPoll);
    const current = new AbortController();
    request = current;
    deadline = setTimeout(() => current.abort(), 9000);
    try {
      const { response } = await fetchGameApi('/perf/rooms.json', {cache:'no-store', signal:current.signal, timeoutMs:3500});
      if (!response.ok) throw Error('Room directory unavailable');
      const data = await response.json();
      if (!Array.isArray(data.rooms)) throw Error('Invalid room directory');
      if (request !== current || !active()) return;
      rooms = availableRooms(data.rooms);
      clusterMeta = data.cluster && typeof data.cluster === 'object' ? data.cluster : null;
      partial = data.partial === true;
      render();
    } catch {
      if (request !== current || !active()) return;
      rooms = null;
      signature = null;
      list.replaceChildren();
      onCount?.(0, 0);
      setStatus('暂时无法获取在线房间，请刷新重试。');
    } finally {
      if (request === current) {
        clearTimeout(deadline);
        request = null;
        if (active()) nextPoll = setTimeout(refresh, 5000);
      }
    }
  }
  const syncVisibility = () => { if (active()) refresh(); else pause(); };
  const pageHide = () => { away = true; pause(); };
  const pageShow = () => { away = false; syncVisibility(); };
  refreshButton.onclick = refresh;
  document.addEventListener('visibilitychange', syncVisibility);
  window.addEventListener('pagehide', pageHide);
  window.addEventListener('pageshow', pageShow);
  refresh();
  return {refresh, render, syncVisibility, dispose() {
    disposed = true;
    pause();
    document.removeEventListener('visibilitychange', syncVisibility);
    window.removeEventListener('pagehide', pageHide);
    window.removeEventListener('pageshow', pageShow);
    refreshButton.onclick = null;
    section.replaceChildren();
  }};
}
