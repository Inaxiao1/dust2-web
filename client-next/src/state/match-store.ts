import { createSignal } from 'solid-js';
import { CdnAssetLoader, type LoadedMapBundle } from '../assets/cdn-loader.ts';
import { loadRuntimeConfig, type ClientRuntimeConfig } from '../config/runtime.ts';
import { ControlPlaneClient, ControlPlaneError } from '../net/control-plane.ts';
import { GameSocketClient, type SocketStatus } from '../net/game-socket.ts';
import {
  PERFORMANCE_MAPS,
  type ControlPlaneHealth,
  type ControlPlaneRoom,
  type GameEvent,
  type GameMode,
  type RoomTicket,
  type RoomVisibility,
  type SnapshotMessage,
  type WelcomeMessage,
} from '../net/protocol.ts';
import { PredictionReconciler } from '../physics/reconciliation.ts';
import { TSPhysicsKernel } from '../physics/ts-kernel.ts';
import {
  CLOUD_KEY_PROGRESS,
  ToyCloudSyncController,
  checkToyFollowAndTriple,
  fetchToyProfile,
  isToyHost,
  loadToySdk,
  type ToySdkApi,
  type ToySocialStatus,
  type ToyUserProfile,
} from '../platform/toy-sdk.ts';
import type { GraphicsBackend } from '../render/renderer.ts';

export type ScreenView = 'lobby' | 'match';

export function createMatchStore() {
  const [config, setConfig] = createSignal<ClientRuntimeConfig | null>(null);
  const [cpHealth, setCpHealth] = createSignal<ControlPlaneHealth | null>(null);
  const [rooms, setRooms] = createSignal<ControlPlaneRoom[]>([]);
  const [loadingRooms, setLoadingRooms] = createSignal(false);
  const [busyAction, setBusyAction] = createSignal(false);
  const [errorMessage, setErrorMessage] = createSignal<string | null>(null);

  const [toyHost] = createSignal(isToyHost());
  const [toyProfile, setToyProfile] = createSignal<ToyUserProfile | null>(null);
  const [toyStats, setToyStats] = createSignal({ kills: 0, headshots: 0, rounds: 0, matches: 0, wins: 0 });
  const [toySocial, setToySocial] = createSignal<ToySocialStatus>({ followed: false, liked: false, coined: false, favorited: false, tripled: false });
  const [toyCloudNote, setToyCloudNote] = createSignal<string>('本地存档');

  const [playerName, setPlayerName] = createSignal('Player');
  const [selectedMap, setSelectedMap] = createSignal(PERFORMANCE_MAPS[0].id);
  const [selectedMode, setSelectedMode] = createSignal<GameMode>('defuse');
  const [visibility, setVisibility] = createSignal<RoomVisibility>('public');
  const [botCount, setBotCount] = createSignal(4);
  const [roomCodeInput, setRoomCodeInput] = createSignal('');

  const [view, setView] = createSignal<ScreenView>('lobby');
  const [socketStatus, setSocketStatus] = createSignal<SocketStatus>('idle');
  const [activeTicket, setActiveTicket] = createSignal<RoomTicket | null>(null);
  const [welcome, setWelcome] = createSignal<WelcomeMessage | null>(null);
  const [snapshot, setSnapshot] = createSignal<SnapshotMessage | null>(null);
  const [events, setEvents] = createSignal<GameEvent[]>([]);
  const [pingMs, setPingMs] = createSignal<number | null>(null);
  const [graphicsBackend, setGraphicsBackend] = createSignal<GraphicsBackend | 'initializing'>('initializing');
  const [mapLoadStage, setMapLoadStage] = createSignal<string | null>(null);
  const [reconcileErrorMeters, setReconcileErrorMeters] = createSignal(0);

  const physics = new TSPhysicsKernel();
  const reconciler = new PredictionReconciler(physics);
  let cpClient: ControlPlaneClient | null = null;
  let cdnLoader: CdnAssetLoader | null = null;
  let toySdkRef: ToySdkApi | null = null;
  let toyCloudSync: ToyCloudSyncController | null = null;
  let pollController: AbortController | null = null;
  const seenEventIds = new Set<string>();

  async function syncToyCloudProgress(): Promise<void> {
    if (!toyCloudSync) return;
    const payload = JSON.stringify({
      v: 1,
      uid: toyProfile()?.openId || '',
      ...toyStats(),
      social: { ...toySocial(), checkedAt: Date.now() },
      updatedAt: Date.now(),
    });
    const res = await toyCloudSync.flushBatch({ [CLOUD_KEY_PROGRESS]: payload });
    if (res.status === 'synced') setToyCloudNote('Toy 云存档已同步');
    else if (res.message) setToyCloudNote(res.message);
  }

  async function verifyToySocialRewards(): Promise<void> {
    if (!toySdkRef) {
      setToyCloudNote('请在 B站 Toy 内核验关注与一键三连');
      return;
    }
    const next = await checkToyFollowAndTriple(toySdkRef);
    const prev = toySocial();
    const merged: ToySocialStatus = {
      followed: prev.followed || next.followed,
      liked: prev.liked || next.liked,
      coined: prev.coined || next.coined,
      favorited: prev.favorited || next.favorited,
      tripled: prev.tripled || next.tripled || ((prev.liked || next.liked) && (prev.coined || next.coined) && (prev.favorited || next.favorited)),
    };
    setToySocial(merged);
    await syncToyCloudProgress();
  }

  const socket = new GameSocketClient({
    onStatus: setSocketStatus,
    onWelcome: msg => {
      reconciler.reset();
      seenEventIds.clear();
      setWelcome(msg);
      setView('match');
      setErrorMessage(null);
    },
    onSnapshot: msg => {
      setSnapshot(msg);
      const selfId = welcome()?.id;
      let selfPlayerTeam: string | undefined;
      if (selfId) {
        const selfPlayer = msg.players.find(p => p.id === selfId);
        if (selfPlayer) {
          selfPlayerTeam = selfPlayer.team;
          const pose = reconciler.reconcile(selfPlayer);
          setReconcileErrorMeters(pose.lastErrorMeters);
        }
      }
      if (msg.events.length > 0) {
        setEvents(prev => [...msg.events, ...prev].slice(0, 12));
        let shouldFlush = false;
        for (const ev of msg.events) {
          const evId = typeof ev.id === 'string' || typeof ev.id === 'number' ? String(ev.id) : '';
          if (evId) {
            if (seenEventIds.has(evId)) continue;
            seenEventIds.add(evId);
            if (seenEventIds.size > 512) seenEventIds.clear();
          }
          if (ev.type === 'kill' && selfId && ev.killerId === selfId && ev.credited !== false) {
            setToyStats(s => ({ ...s, kills: s.kills + 1, headshots: s.headshots + (ev.headshot ? 1 : 0) }));
          } else if (ev.type === 'round_end') {
            setToyStats(s => ({ ...s, rounds: s.rounds + 1 }));
            shouldFlush = true;
          } else if (ev.type === 'match_end') {
            const won = Boolean(selfPlayerTeam && ev.winner === selfPlayerTeam);
            setToyStats(s => ({ ...s, matches: s.matches + 1, wins: s.wins + (won ? 1 : 0) }));
            shouldFlush = true;
          }
        }
        if (shouldFlush) void syncToyCloudProgress();
      }
    },
    onError: err => {
      setErrorMessage(`[${err.code}] ${err.message}`);
    },
    onPong: rtt => setPingMs(rtt),
    onClose: () => {
      if (view() === 'match') {
        setErrorMessage('与对局服务器连接已断开，请返回大厅重新加入。');
      }
    },
  });

  async function init(): Promise<void> {
    const loaded = await loadRuntimeConfig();
    setConfig(loaded);
    cpClient = new ControlPlaneClient(loaded.controlPlaneUrl);
    cdnLoader = new CdnAssetLoader({
      mapBaseUrl: loaded.mapBaseUrl,
      assetBaseUrl: loaded.assetBaseUrl,
    });

    if (toyHost()) {
      const sdk = await loadToySdk();
      toySdkRef = sdk;
      toyCloudSync = new ToyCloudSyncController(sdk);
      if (typeof window !== 'undefined') {
        window.addEventListener('pagehide', () => {
          void syncToyCloudProgress();
        });
      }
      try {
        const profile = await fetchToyProfile(sdk);
        if (profile) {
          setToyProfile(profile);
          setPlayerName(profile.nickname);
        }
        const saved = await toyCloudSync.readBatch([CLOUD_KEY_PROGRESS]);
        if (saved?.[CLOUD_KEY_PROGRESS]) {
          const parsed = JSON.parse(saved[CLOUD_KEY_PROGRESS]) as Record<string, unknown>;
          setToyStats(s => ({
            kills: Math.max(s.kills, Number(parsed.kills) || 0),
            headshots: Math.max(s.headshots, Number(parsed.headshots) || 0),
            rounds: Math.max(s.rounds, Number(parsed.rounds) || 0),
            matches: Math.max(s.matches, Number(parsed.matches) || 0),
            wins: Math.max(s.wins, Number(parsed.wins) || 0),
          }));
          if (parsed.social && typeof parsed.social === 'object') {
            const soc = parsed.social as Record<string, unknown>;
            setToySocial(prev => ({
              followed: prev.followed || Boolean(soc.followed),
              liked: prev.liked || Boolean(soc.liked || soc.tripled),
              coined: prev.coined || Boolean(soc.coined || soc.tripled),
              favorited: prev.favorited || Boolean(soc.favorited || soc.tripled),
              tripled: prev.tripled || Boolean(soc.tripled),
            }));
          }
          setToyCloudNote('Toy 云存档已加载');
        }
      } catch {
        // Preview environments without Toy context remain playable anonymously.
      }
    }

    await refreshLobby();
  }

  async function loadMapForActiveMatch(mapId: string, signal?: AbortSignal): Promise<LoadedMapBundle | null> {
    if (!cdnLoader || !config()?.mapBaseUrl) {
      setMapLoadStage(null);
      return null;
    }
    try {
      const bundle = await cdnLoader.loadMapBundle(mapId, {
        onProgress: setMapLoadStage,
        signal,
      });
      if (bundle.physicsPositions) {
        physics.loadMapCollision(bundle.physicsPositions);
      }
      setMapLoadStage(null);
      return bundle;
    } catch (error) {
      if ((error as { name?: string })?.name === 'AbortError') return null;
      setMapLoadStage(null);
      setErrorMessage(error instanceof Error ? `地图资源加载失败：${error.message}` : '地图资源加载失败');
      return null;
    }
  }

  async function refreshLobby(filterMap?: string): Promise<void> {
    if (!cpClient) return;
    pollController?.abort();
    pollController = new AbortController();
    setLoadingRooms(true);
    try {
      const [health, list] = await Promise.all([
        cpClient.health(pollController.signal),
        cpClient.listRooms(filterMap, pollController.signal),
      ]);
      setCpHealth(health);
      setRooms(list);
      setErrorMessage(null);
    } catch (error) {
      if ((error as { name?: string })?.name === 'AbortError') return;
      setCpHealth(null);
      const msg = error instanceof ControlPlaneError ? error.message : '无法连接控制面服务';
      setErrorMessage(msg);
    } finally {
      setLoadingRooms(false);
    }
  }

  async function createAndJoinRoom(): Promise<void> {
    if (!cpClient || busyAction()) return;
    setBusyAction(true);
    setErrorMessage(null);
    try {
      const ticket = await cpClient.createRoom({
        mapId: selectedMap(),
        mode: selectedMode(),
        visibility: visibility(),
        playerName: playerName().trim() || 'Player',
      });
      setActiveTicket(ticket);
      setEvents([]);
      socket.connectWithTicket(ticket, {
        playerName: playerName().trim() || 'Player',
        bots: botCount(),
      });
    } catch (error) {
      const msg = error instanceof ControlPlaneError ? `[${error.code}] ${error.message}` : '建房请求失败';
      setErrorMessage(msg);
    } finally {
      setBusyAction(false);
    }
  }

  async function joinRoomByCode(code: string): Promise<void> {
    if (!cpClient || busyAction()) return;
    const normalized = code.trim().toUpperCase();
    if (!normalized) {
      setErrorMessage('请输入有效房间码');
      return;
    }
    setBusyAction(true);
    setErrorMessage(null);
    try {
      const ticket = await cpClient.joinRoom(normalized, playerName().trim() || 'Player');
      setActiveTicket(ticket);
      setEvents([]);
      socket.connectWithTicket(ticket, {
        playerName: playerName().trim() || 'Player',
      });
    } catch (error) {
      const msg = error instanceof ControlPlaneError ? `[${error.code}] ${error.message}` : '加入房间失败';
      setErrorMessage(msg);
    } finally {
      setBusyAction(false);
    }
  }

  function leaveMatch(): void {
    void syncToyCloudProgress();
    socket.disconnect();
    reconciler.reset();
    physics.dispose();
    setView('lobby');
    setWelcome(null);
    setSnapshot(null);
    setActiveTicket(null);
    setMapLoadStage(null);
    void refreshLobby();
  }

  return {
    config,
    cpHealth,
    rooms,
    loadingRooms,
    busyAction,
    errorMessage,
    toyHost,
    toyProfile,
    toyStats,
    toySocial,
    toyCloudNote,
    syncToyCloudProgress,
    verifyToySocialRewards,
    playerName,
    setPlayerName,
    selectedMap,
    setSelectedMap,
    selectedMode,
    setSelectedMode,
    visibility,
    setVisibility,
    botCount,
    setBotCount,
    roomCodeInput,
    setRoomCodeInput,
    view,
    socketStatus,
    activeTicket,
    welcome,
    snapshot,
    events,
    pingMs,
    graphicsBackend,
    setGraphicsBackend,
    mapLoadStage,
    reconcileErrorMeters,
    physics,
    reconciler,
    toyCloudSync: () => toyCloudSync,
    socket,
    init,
    loadMapForActiveMatch,
    refreshLobby,
    createAndJoinRoom,
    joinRoomByCode,
    leaveMatch,
  };
}

export type MatchStore = ReturnType<typeof createMatchStore>;
