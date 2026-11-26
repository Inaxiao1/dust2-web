import { For, Show } from 'solid-js';
import { PERFORMANCE_MAPS, type GameMode, type RoomVisibility } from '../net/protocol.ts';
import type { MatchStore } from '../state/match-store.ts';

export function Lobby(props: { store: MatchStore }) {
  const { store } = props;

  return (
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <h1>DUSKRAIN · WEB CLIENT NEXT</h1>
          <small>
            TypeScript + SolidJS + Three.js (WebGPU/WebGL2) · Toy 轻壳 + CDN 资产 + 控制面直连
          </small>
        </div>
        <div class="badges">
          <span class={`badge ${store.cpHealth()?.ok ? 'ok' : 'warn'}`}>
            控制面: {store.cpHealth()?.ok ? `在线 (${store.cpHealth()?.stats.activeWorkers} 节点)` : '未连接'}
          </span>
          <span class="badge">
            宿主: {(() => {
              if (!store.toyHost()) return '独立网页';
              const profile = store.toyProfile();
              if (!profile) return 'Toy 预览';
              return `Toy (${profile.nickname}${profile.openId ? ' · ' + profile.openId.slice(-6) : ''})`;
            })()}
          </span>
          <span class="badge">
            战绩: {store.toyStats().kills} 杀 · {store.toyStats().matches} 局 · {store.toyCloudNote()}
          </span>
          <span class="badge">
            渲染后端: {store.graphicsBackend().toUpperCase()}
          </span>
          <span class="badge">
            物理核: {store.physics.kind}
          </span>
        </div>
      </header>

      <Show when={store.errorMessage()}>
        <div class="alert">{store.errorMessage()}</div>
      </Show>

      <div class="grid-two">
        <section class="panel">
          <h2>创建 / 加入对局</h2>

          <label class="field">
            <span>玩家昵称</span>
            <input
              type="text"
              maxLength={20}
              disabled={Boolean(store.toyProfile())}
              value={store.playerName()}
              onInput={e => store.setPlayerName(e.currentTarget.value)}
            />
          </label>

          <label class="field">
            <span>地图选择</span>
            <select
              value={store.selectedMap()}
              onChange={e => store.setSelectedMap(e.currentTarget.value)}
            >
              <For each={PERFORMANCE_MAPS}>
                {m => <option value={m.id}>{m.nameZh} ({m.name})</option>}
              </For>
            </select>
          </label>

          <div class="row">
            <label class="field" style="flex: 1">
              <span>对局模式</span>
              <select
                value={store.selectedMode()}
                onChange={e => store.setSelectedMode(e.currentTarget.value as GameMode)}
              >
                <option value="defuse">竞技爆破 (13胜制)</option>
                <option value="deathmatch">团队死斗 (100杀)</option>
              </select>
            </label>

            <label class="field" style="flex: 1">
              <span>房间可见性</span>
              <select
                value={store.visibility()}
                onChange={e => store.setVisibility(e.currentTarget.value as RoomVisibility)}
              >
                <option value="public">公开大厅</option>
                <option value="private">仅房间码</option>
              </select>
            </label>
          </div>

          <label class="field">
            <span>人机数量 ({store.botCount()})</span>
            <input
              type="range"
              min="0"
              max="9"
              value={store.botCount()}
              onInput={e => store.setBotCount(Number(e.currentTarget.value))}
            />
          </label>

          <button
            disabled={store.busyAction() || !store.cpHealth()?.ok}
            onClick={() => void store.createAndJoinRoom()}
          >
            {store.busyAction() ? '正在分配节点…' : '创建房间并直连对局'}
          </button>

          <hr style="border: 0; border-top: 1px solid #222d3b; width: 100%" />

          <div class="row">
            <input
              style="flex: 1; padding: 9px 10px; border-radius: 4px; border: 1px solid #2c3a4b; background: #0c1015; color: #eef3f9;"
              placeholder="输入房间码（如 A9F3C1）"
              value={store.roomCodeInput()}
              onInput={e => store.setRoomCodeInput(e.currentTarget.value.toUpperCase())}
            />
            <button
              class="secondary"
              disabled={store.busyAction() || !store.cpHealth()?.ok}
              onClick={() => void store.joinRoomByCode(store.roomCodeInput())}
            >
              房间码加入
            </button>
          </div>
        </section>

        <section class="panel">
          <div class="row" style="justify-content: space-between;">
            <h2>全局公开房间大厅</h2>
            <button
              class="secondary"
              disabled={store.loadingRooms()}
              onClick={() => void store.refreshLobby()}
            >
              {store.loadingRooms() ? '刷新中…' : '刷新列表'}
            </button>
          </div>

          <Show
            when={store.rooms().length > 0}
            fallback={<div style="color: #8fa3b8; font-size: 13px;">当前暂无公开房间，可直接在左侧创建新房间。</div>}
          >
            <div class="room-list">
              <For each={store.rooms()}>
                {room => (
                  <div class="room-row">
                    <div class="room-meta">
                      <strong>
                        [{room.code}] {room.mapId} · {room.mode === 'deathmatch' ? '死斗' : '爆破'}
                      </strong>
                      <span>
                        真人 {room.humans}/{room.capacity} · 人机 {room.bots} · 比分 CT {room.scores?.CT ?? 0} : {room.scores?.T ?? 0} T · 节点 {room.workerId}
                      </span>
                    </div>
                    <button
                      disabled={!room.joinable || store.busyAction()}
                      onClick={() => void store.joinRoomByCode(room.code)}
                    >
                      {room.joinable ? '加入' : '不可加入'}
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>

          <div style="border-top: 1px solid #222d3b; padding-top: 10px; margin-top: 8px; display: flex; flex-direction: column; gap: 8px;">
            <div class="row" style="justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap;">
              <span style="font-size: 12px; color: #b8cae0;">
                Toy 成长与福利: 关注 {store.toySocial().followed ? '已解锁' : '未解锁'} · 一键三连 {store.toySocial().tripled ? '已解锁' : `(${store.toySocial().liked ? '赞✓' : '赞'} ${store.toySocial().coined ? '币✓' : '币'} ${store.toySocial().favorited ? '藏✓' : '藏'})`}
              </span>
              <div class="row" style="gap: 6px;">
                <button class="secondary" onClick={() => void store.verifyToySocialRewards()}>
                  核验关注 / 三连
                </button>
                <button class="secondary" onClick={() => void store.syncToyCloudProgress()}>
                  同步云存档
                </button>
              </div>
            </div>
            <div style="font-size: 12px; color: #7e92a8; display: flex; flex-direction: column; gap: 4px;">
              <span>控制面地址: {store.config()?.controlPlaneUrl ?? '加载中…'}</span>
              <span>地图 CDN: {store.config()?.mapBaseUrl ?? '未配置（使用战术网格占位）'}</span>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
