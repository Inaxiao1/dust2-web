import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { TacticalAudio } from '../audio/sfx.ts';
import { FpsInputController } from '../input/fps-controller.ts';
import { MatchViewport } from '../render/renderer.ts';
import type { MatchStore } from '../state/match-store.ts';
import { BuyMenu } from './BuyMenu.tsx';
import { Radar } from './Radar.tsx';
import { Scoreboard } from './Scoreboard.tsx';
import { TouchControls } from './TouchControls.tsx';

const TICK_DT = 1 / 30;

export function Hud(props: { store: MatchStore }) {
  const { store } = props;
  const [pointerLocked, setPointerLocked] = createSignal(false);
  const [buyOpen, setBuyOpen] = createSignal(false);
  const [scoreboardOpen, setScoreboardOpen] = createSignal(false);
  const [muted, setMuted] = createSignal(false);
  const [touchMode, setTouchMode] = createSignal(
    typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches,
  );
  const [currentYaw, setCurrentYaw] = createSignal(0);

  let canvasRef!: HTMLCanvasElement;
  let viewport: MatchViewport | null = null;
  let inputController: FpsInputController | null = null;
  const audio = new TacticalAudio();
  const seenEventIds = new Set<string>();

  const selfPlayer = createMemo(() => {
    const snap = store.snapshot();
    const id = store.welcome()?.id;
    if (!snap || !id) return null;
    return snap.players.find(p => p.id === id) ?? null;
  });

  const canTakeBot = createMemo(() => {
    const me = selfPlayer();
    const snap = store.snapshot();
    if (!me || me.alive || !snap) return false;
    return snap.players.some(p => p.bot && p.alive && p.team === me.team);
  });

  createEffect(() => {
    const snap = store.snapshot();
    const selfId = store.welcome()?.id ?? null;
    if (!snap) return;
    for (const ev of snap.events) {
      const key = `${ev.type}:${String(ev.id)}`;
      if (seenEventIds.has(key)) continue;
      seenEventIds.add(key);
      if (seenEventIds.size > 400) seenEventIds.clear();

      if (ev.type === 'shot') {
        const isSelf = ev.shooterId === selfId;
        const origin = Array.isArray(ev.origin) && ev.origin.length === 3 ? (ev.origin as [number, number, number]) : undefined;
        const end = Array.isArray(ev.end) && ev.end.length === 3 ? (ev.end as [number, number, number]) : undefined;
        viewport?.triggerShotEffect(origin, end, isSelf);
        audio.playShot(ev.weapon === 'awp' || ev.weapon === 'ak47');
      } else if (ev.type === 'hit' && ev.shooterId === selfId) {
        audio.playHit(Boolean(ev.headshot));
      } else if (ev.type === 'bomb_planted') {
        audio.playBombBeep();
      }
    }
  });

  onMount(() => {
    let active = true;
    let seq = 0;
    const mapAbort = new AbortController();

    inputController = new FpsInputController(canvasRef, {
      onLockChange: setPointerLocked,
      onToggleBuy: () => setBuyOpen(v => !v),
      onScoreboardChange: setScoreboardOpen,
      onDropWeapon: () => store.socket.sendDropWeapon(),
      onUserGesture: () => audio.unlock(),
    });

    void MatchViewport.create(canvasRef, {
      onFrame: dt => {
        const pose = store.reconciler.decayVisualError(dt);
        const angles = inputController?.angles ?? { yaw: 0, pitch: 0 };
        setCurrentYaw(angles.yaw);
        const me = selfPlayer();
        if (me?.alive) {
          viewport?.setActiveWeapon(me.weapon, Math.hypot(me.vx, me.vz));
          viewport?.setPredictedCamera({
            x: pose.x,
            y: pose.y,
            z: pose.z,
            crouch: pose.crouch,
            yaw: angles.yaw,
            pitch: angles.pitch,
          });
        }
      },
    }).then(instance => {
      if (!active) {
        instance.dispose();
        return;
      }
      viewport = instance;
      store.setGraphicsBackend(instance.backend);

      const mapId = store.activeTicket()?.mapId;
      if (mapId) {
        void store.loadMapForActiveMatch(mapId, mapAbort.signal).then(bundle => {
          if (!active || !bundle?.scene) return;
          viewport?.setMapScene(bundle.scene);
        });
      }
    });

    const inputTimer = setInterval(() => {
      const snap = store.snapshot();
      const welcome = store.welcome();
      if (snap && viewport) {
        viewport.applySnapshot(snap, welcome?.id ?? null, false);
      }
      if (!inputController || buyOpen()) return;
      const frame = inputController.sampleFrame(++seq);
      store.reconciler.applyLocalInput(
        frame.seq,
        {
          forward: frame.forward,
          right: frame.right,
          yaw: frame.yaw,
          pitch: frame.pitch,
          jump: frame.jump,
          crouch: frame.crouch,
          walk: frame.walk,
        },
        TICK_DT,
      );
      store.socket.sendInput(frame);
    }, 1000 / 30);

    const pingTimer = setInterval(() => {
      store.socket.sendPing();
    }, 3000);

    onCleanup(() => {
      active = false;
      mapAbort.abort();
      clearInterval(inputTimer);
      clearInterval(pingTimer);
      inputController?.dispose();
      inputController = null;
      viewport?.dispose();
      viewport = null;
      audio.dispose();
    });
  });

  return (
    <div class="match-stage">
      <canvas ref={canvasRef} class="match-canvas" />
      <div class="crosshair" />

      <div class="hud-overlay">
        <div class="hud-top">
          <div class="row" style="align-items: flex-start;">
            <Radar
              players={store.snapshot()?.players ?? []}
              bomb={store.snapshot()?.bomb ?? null}
              selfId={store.welcome()?.id ?? null}
              selfYaw={currentYaw()}
            />
            <div class="hud-card">
              <strong>
                房间 {store.welcome()?.room} · {store.activeTicket()?.mapId}
              </strong>
              <div style="margin-top: 4px; color: #9eb3c9;">
                CT {store.snapshot()?.scores.CT ?? 0} : {store.snapshot()?.scores.T ?? 0} T ·{' '}
                阶段 {store.snapshot()?.round.phase ?? 'waiting'} ·{' '}
                剩余 {Math.ceil(store.snapshot()?.round.timeLeft ?? 0)}s
              </div>
              <Show when={store.mapLoadStage()}>
                <div style="margin-top: 4px; color: #f4c675;">{store.mapLoadStage()}</div>
              </Show>
            </div>
          </div>

          <div class="hud-card row" style="flex-wrap: wrap;">
            <span>{store.graphicsBackend().toUpperCase()}</span>
            <span>{store.socket.isBinaryProtocolActive ? 'BIN v2' : 'JSON v1'}</span>
            <span>{store.pingMs() !== null ? `${store.pingMs()} ms` : '--'}</span>
            <span>误差 {store.reconcileErrorMeters().toFixed(2)}m</span>
            <button class="secondary" onClick={() => setBuyOpen(v => !v)}>商店 (B)</button>
            <button class="secondary" onClick={() => setScoreboardOpen(v => !v)}>战况 (Tab)</button>
            <button
              class="secondary"
              onClick={() => {
                const next = !muted();
                setMuted(next);
                audio.setMuted(next);
              }}
            >
              {muted() ? '已静音' : '音效开'}
            </button>
            <button class="secondary" onClick={() => setTouchMode(v => !v)}>
              {touchMode() ? '隐藏触控' : '触控模式'}
            </button>
            <button class="secondary" onClick={() => store.leaveMatch()}>退出</button>
          </div>
        </div>

        <Show when={!pointerLocked() && !buyOpen() && !touchMode()}>
          <div class="hud-card" style="align-self: center; opacity: 0.85;">
            点击画面锁定鼠标视角 · WASD 移动 · B 买枪 · Tab 战况 · G 丢枪 · ESC 释放鼠标
          </div>
        </Show>

        <Show when={store.errorMessage()}>
          <div class="alert" style="pointer-events: auto; align-self: center;">
            {store.errorMessage()}
          </div>
        </Show>

        <div class="hud-bottom">
          <div class="hud-card">
            <Show when={selfPlayer()} fallback={<span>等待服务端同步玩家状态…</span>}>
              {player => (
                <div class="row" style="gap: 16px; flex-wrap: wrap;">
                  <span>阵营: <strong>{player().team}</strong></span>
                  <span>HP: <strong>{player().health}</strong></span>
                  <span>护甲: <strong>{player().armor}</strong></span>
                  <span>武器: <strong>{player().weapon} ({player().ammo}/{player().reserve})</strong></span>
                  <span>金钱: <strong>${player().money}</strong></span>
                  <Show when={canTakeBot()}>
                    <button onClick={() => store.socket.sendTakeBot()}>接管人机 (E)</button>
                  </Show>
                </div>
              )}
            </Show>
          </div>

          <div class="hud-card" style="min-width: 220px;">
            <div class="events-feed">
              <For each={store.events().slice(0, 5)}>
                {ev => <div>[{ev.type}] #{String(ev.id)}</div>}
              </For>
            </div>
          </div>
        </div>
      </div>

      <Show when={buyOpen() && selfPlayer()}>
        {player => (
          <BuyMenu
            team={player().team}
            money={player().money}
            currentWeapon={player().weapon}
            onBuy={id => store.socket.sendBuy(id)}
            onRefund={id => store.socket.sendRefund(id)}
            onDrop={() => store.socket.sendDropWeapon()}
            onClose={() => setBuyOpen(false)}
          />
        )}
      </Show>

      <Show when={scoreboardOpen() && store.snapshot()}>
        {snap => (
          <Scoreboard
            players={snap().players}
            scores={snap().scores}
            roomCode={snap().room}
            mapId={store.activeTicket()?.mapId ?? ''}
            canTakeBot={canTakeBot()}
            onTakeBot={() => store.socket.sendTakeBot()}
          />
        )}
      </Show>

      <Show when={touchMode() && !buyOpen()}>
        <TouchControls
          onMove={(f, r) => inputController?.setTouchMove(f, r)}
          onLookDelta={(dx, dy) => inputController?.applyLookDelta(dx, dy)}
          onAction={(act, pressed) => inputController?.setTouchAction(act, pressed)}
          onOpenBuy={() => setBuyOpen(true)}
        />
      </Show>
    </div>
  );
}
