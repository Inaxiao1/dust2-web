export interface TouchInputState {
  forward: number;
  right: number;
  fire: boolean;
  jump: boolean;
  crouch: boolean;
  reload: boolean;
  interact: boolean;
}

export function TouchControls(props: {
  onMove: (forward: number, right: number) => void;
  onLookDelta: (dx: number, dy: number) => void;
  onAction: (action: 'fire' | 'jump' | 'crouch' | 'reload' | 'interact', pressed: boolean) => void;
  onOpenBuy: () => void;
}) {
  let padOriginX = 0;
  let padOriginY = 0;
  let lookX = 0;
  let lookY = 0;

  return (
    <div class="touch-layer">
      <div
        class="touch-pad"
        onTouchStart={e => {
          const t = e.touches[0];
          if (!t) return;
          padOriginX = t.clientX;
          padOriginY = t.clientY;
        }}
        onTouchMove={e => {
          const t = e.touches[0];
          if (!t) return;
          const dx = Math.max(-1, Math.min(1, (t.clientX - padOriginX) / 48));
          const dy = Math.max(-1, Math.min(1, (padOriginY - t.clientY) / 48));
          props.onMove(dy, dx);
        }}
        onTouchEnd={() => props.onMove(0, 0)}
      >
        <span>移动</span>
      </div>

      <div
        class="touch-look-zone"
        onTouchStart={e => {
          const t = e.touches[0];
          if (!t) return;
          lookX = t.clientX;
          lookY = t.clientY;
        }}
        onTouchMove={e => {
          const t = e.touches[0];
          if (!t) return;
          props.onLookDelta(t.clientX - lookX, t.clientY - lookY);
          lookX = t.clientX;
          lookY = t.clientY;
        }}
      />

      <div class="touch-actions">
        <button
          class="touch-btn fire"
          onTouchStart={() => props.onAction('fire', true)}
          onTouchEnd={() => props.onAction('fire', false)}
        >
          开火
        </button>
        <div class="row">
          <button
            class="touch-btn"
            onTouchStart={() => props.onAction('jump', true)}
            onTouchEnd={() => props.onAction('jump', false)}
          >
            跳
          </button>
          <button
            class="touch-btn"
            onTouchStart={() => props.onAction('crouch', true)}
            onTouchEnd={() => props.onAction('crouch', false)}
          >
            蹲
          </button>
          <button
            class="touch-btn"
            onTouchStart={() => props.onAction('reload', true)}
            onTouchEnd={() => props.onAction('reload', false)}
          >
            换弹
          </button>
          <button class="touch-btn" onClick={() => props.onOpenBuy()}>
            买枪
          </button>
        </div>
      </div>
    </div>
  );
}
