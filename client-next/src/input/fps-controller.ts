import type { ClientInputFrame } from '../net/protocol.ts';

const PITCH_LIMIT = 1.48;
const DEFAULT_SENSITIVITY = 0.0022;

export interface FpsControllerCallbacks {
  onLockChange?: (locked: boolean) => void;
  onToggleBuy?: () => void;
  onScoreboardChange?: (visible: boolean) => void;
  onDropWeapon?: () => void;
  onUserGesture?: () => void;
}

export class FpsInputController {
  private readonly canvas: HTMLCanvasElement;
  private readonly keys = new Set<string>();
  private yaw = 0;
  private pitch = 0;
  private firing = false;
  private requestedSlot = 0;
  private pointerLocked = false;
  private dragging = false;
  private lastDragX = 0;
  private lastDragY = 0;
  private touchForward = 0;
  private touchRight = 0;
  private readonly touchActions = new Set<string>();
  private readonly callbacks: FpsControllerCallbacks;

  constructor(canvas: HTMLCanvasElement, callbacks: FpsControllerCallbacks = {}) {
    this.canvas = canvas;
    this.callbacks = callbacks;

    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('mousemove', this.handleMouseMove);
    window.addEventListener('mouseup', this.handleMouseUp);
    canvas.addEventListener('mousedown', this.handleMouseDown);
    document.addEventListener('pointerlockchange', this.handlePointerLockChange);
  }

  get angles(): { yaw: number; pitch: number } {
    return { yaw: this.yaw, pitch: this.pitch };
  }

  get isPointerLocked(): boolean {
    return this.pointerLocked;
  }

  setTouchMove(forward: number, right: number): void {
    this.touchForward = Math.max(-1, Math.min(1, forward));
    this.touchRight = Math.max(-1, Math.min(1, right));
  }

  setTouchAction(action: string, pressed: boolean): void {
    this.callbacks.onUserGesture?.();
    if (pressed) this.touchActions.add(action);
    else this.touchActions.delete(action);
  }

  applyLookDelta(dx: number, dy: number): void {
    this.yaw -= dx * DEFAULT_SENSITIVITY * 1.4;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch - dy * DEFAULT_SENSITIVITY * 1.4));
  }

  requestLock(): void {
    this.callbacks.onUserGesture?.();
    if (typeof this.canvas.requestPointerLock === 'function') {
      try {
        void Promise.resolve(this.canvas.requestPointerLock()).catch(() => {});
      } catch {
        // Fallback to drag-aim if Pointer Lock is blocked by sandbox/iframe policy.
      }
    }
  }

  sampleFrame(seq: number): ClientInputFrame {
    const keyFwd = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0);
    const keyRight = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0);
    const forward = keyFwd !== 0 ? keyFwd : this.touchForward;
    const right = keyRight !== 0 ? keyRight : this.touchRight;
    const slot = this.requestedSlot;
    this.requestedSlot = 0;
    return {
      seq,
      forward,
      right,
      yaw: this.yaw,
      pitch: this.pitch,
      jump: this.keys.has('Space') || this.touchActions.has('jump'),
      crouch: this.keys.has('ControlLeft') || this.keys.has('KeyC') || this.touchActions.has('crouch'),
      walk: this.keys.has('ShiftLeft'),
      fire: this.firing || this.touchActions.has('fire'),
      reload: this.keys.has('KeyR') || this.touchActions.has('reload'),
      slot,
      interact: this.keys.has('KeyE') || this.touchActions.has('interact'),
    };
  }

  dispose(): void {
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('mousemove', this.handleMouseMove);
    window.removeEventListener('mouseup', this.handleMouseUp);
    this.canvas.removeEventListener('mousedown', this.handleMouseDown);
    document.removeEventListener('pointerlockchange', this.handlePointerLockChange);
    this.keys.clear();
    this.touchActions.clear();
    this.firing = false;
  }

  private readonly handleKeyDown = (e: KeyboardEvent) => {
    this.callbacks.onUserGesture?.();
    if (e.code === 'Tab') {
      e.preventDefault();
      this.callbacks.onScoreboardChange?.(true);
      return;
    }
    if (!e.repeat && e.code === 'KeyB') {
      this.callbacks.onToggleBuy?.();
      return;
    }
    if (!e.repeat && e.code === 'KeyG') {
      this.callbacks.onDropWeapon?.();
      return;
    }
    this.keys.add(e.code);
    if (e.code === 'Digit1') this.requestedSlot = 1;
    else if (e.code === 'Digit2') this.requestedSlot = 2;
    else if (e.code === 'Digit3') this.requestedSlot = 3;
    else if (e.code === 'Digit4') this.requestedSlot = 4;
    else if (e.code === 'Digit5') this.requestedSlot = 5;
  };

  private readonly handleKeyUp = (e: KeyboardEvent) => {
    if (e.code === 'Tab') {
      e.preventDefault();
      this.callbacks.onScoreboardChange?.(false);
      return;
    }
    this.keys.delete(e.code);
  };

  private readonly handleMouseDown = (e: MouseEvent) => {
    this.callbacks.onUserGesture?.();
    if (e.button === 0) {
      if (this.pointerLocked) {
        this.firing = true;
      } else {
        this.dragging = true;
        this.lastDragX = e.clientX;
        this.lastDragY = e.clientY;
        this.requestLock();
      }
    }
  };

  private readonly handleMouseUp = (e: MouseEvent) => {
    if (e.button === 0) {
      this.firing = false;
      this.dragging = false;
    }
  };

  private readonly handleMouseMove = (e: MouseEvent) => {
    let dx = 0;
    let dy = 0;
    if (this.pointerLocked) {
      dx = e.movementX || 0;
      dy = e.movementY || 0;
    } else if (this.dragging) {
      dx = e.clientX - this.lastDragX;
      dy = e.clientY - this.lastDragY;
      this.lastDragX = e.clientX;
      this.lastDragY = e.clientY;
    } else {
      return;
    }
    this.yaw -= dx * DEFAULT_SENSITIVITY;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch - dy * DEFAULT_SENSITIVITY));
  };

  private readonly handlePointerLockChange = () => {
    this.pointerLocked = document.pointerLockElement === this.canvas;
    if (!this.pointerLocked) this.firing = false;
    this.callbacks.onLockChange?.(this.pointerLocked);
  };
}
