import { createEffect, createSignal } from 'solid-js';
import type { BombSnapshot, PlayerSnapshot } from '../net/protocol.ts';
import { worldToRadar } from './radar-math.ts';

export function Radar(props: {
  players: PlayerSnapshot[];
  bomb: BombSnapshot | null;
  selfId: string | null;
  selfYaw: number;
}) {
  const [rotating, setRotating] = createSignal(true);
  let canvasRef!: HTMLCanvasElement;
  const size = 156;

  createEffect(() => {
    const ctx = canvasRef?.getContext('2d');
    if (!ctx) return;

    const self = props.players.find(p => p.id === props.selfId) ?? null;
    const cx = self?.x ?? 0;
    const cz = self?.z ?? 0;
    const yaw = self ? props.selfYaw : 0;
    const rotate = rotating();

    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = 'rgba(11, 17, 24, 0.86)';
    ctx.fillRect(0, 0, size, size);

    // Subtle tactical grid
    ctx.strokeStyle = 'rgba(72, 98, 128, 0.22)';
    ctx.lineWidth = 1;
    for (let step = 26; step < size; step += 26) {
      ctx.beginPath();
      ctx.moveTo(step, 0);
      ctx.lineTo(step, size);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, step);
      ctx.lineTo(size, step);
      ctx.stroke();
    }

    // FOV cone for self
    if (self?.alive) {
      ctx.save();
      ctx.translate(size / 2, size / 2);
      if (!rotate) ctx.rotate(-yaw);
      ctx.fillStyle = 'rgba(130, 227, 179, 0.18)';
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, 34, -Math.PI / 2 - 0.55, -Math.PI / 2 + 0.55);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // Bomb marker
    const bomb = props.bomb;
    if (bomb && (bomb.state === 'dropped' || bomb.state === 'planted')) {
      const bp = worldToRadar(bomb.x, bomb.z, cx, cz, yaw, rotate, size);
      ctx.fillStyle = bomb.state === 'planted' ? '#ff3b30' : '#f4c675';
      ctx.fillRect(bp.x - 4, bp.y - 4, 8, 8);
    }

    // Players
    for (const p of props.players) {
      if (!p.alive) continue;
      const pt = worldToRadar(p.x, p.z, cx, cz, yaw, rotate, size);
      const isSelf = p.id === props.selfId;
      const isTeammate = self ? p.team === self.team : p.team === 'CT';
      ctx.fillStyle = isSelf ? '#82e3b3' : isTeammate ? '#5fa8ff' : '#ff5f56';
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, isSelf ? 4.5 : 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  });

  return (
    <div class="radar-box">
      <canvas ref={canvasRef} width={size} height={size} class="radar-canvas" />
      <button
        class="secondary radar-toggle"
        onClick={() => setRotating(v => !v)}
      >
        {rotating() ? '随视角旋转' : '固定北方'}
      </button>
    </div>
  );
}
