import { For, createMemo } from 'solid-js';
import type { PlayerSnapshot } from '../net/protocol.ts';

export function Scoreboard(props: {
  players: PlayerSnapshot[];
  scores: { CT: number; T: number };
  roomCode: string;
  mapId: string;
  onTakeBot?: () => void;
  canTakeBot: boolean;
}) {
  const ctPlayers = createMemo(() =>
    props.players.filter(p => p.team === 'CT').sort((a, b) => b.kills - a.kills),
  );
  const tPlayers = createMemo(() =>
    props.players.filter(p => p.team === 'T').sort((a, b) => b.kills - a.kills),
  );

  return (
    <div class="scoreboard-overlay">
      <div class="scoreboard-card">
        <div class="row" style="justify-content: space-between; margin-bottom: 10px;">
          <strong style="color: #f3d995;">
            战况 · 房间 {props.roomCode} ({props.mapId})
          </strong>
          <span style="color: #9eb3c9;">
            CT {props.scores.CT} : {props.scores.T} T
          </span>
        </div>

        <div class="scoreboard-teams">
          <div>
            <div class="team-header ct">反恐精英 (CT)</div>
            <For each={ctPlayers()}>
              {p => (
                <div class={`score-row ${p.alive ? '' : 'dead'}`}>
                  <span>{p.bot ? '[BOT] ' : ''}{p.name}</span>
                  <span>{p.kills}/{p.assists}/{p.deaths}</span>
                  <span>${p.money}</span>
                </div>
              )}
            </For>
          </div>

          <div>
            <div class="team-header t">恐怖分子 (T)</div>
            <For each={tPlayers()}>
              {p => (
                <div class={`score-row ${p.alive ? '' : 'dead'}`}>
                  <span>{p.bot ? '[BOT] ' : ''}{p.name}</span>
                  <span>{p.kills}/{p.assists}/{p.deaths}</span>
                  <span>${p.money}</span>
                </div>
              )}
            </For>
          </div>
        </div>

        {props.canTakeBot && props.onTakeBot && (
          <div style="margin-top: 12px; text-align: center;">
            <button onClick={() => props.onTakeBot?.()}>接管存活己方人机 (E)</button>
          </div>
        )}
      </div>
    </div>
  );
}
