import type { PlayerSnapshot } from '../net/protocol.ts';
import type { PhysicsKernel, PlayerMoveInput, PlayerMoveState } from './kernel.ts';

interface PendingInput {
  seq: number;
  input: PlayerMoveInput;
  dt: number;
}

export interface ReconciledPose {
  x: number;
  y: number;
  z: number;
  crouch: boolean;
  lastErrorMeters: number;
  pendingCount: number;
}

const MAX_PENDING_INPUTS = 64;
const SNAP_THRESHOLD_METERS = 2.5;
const ERROR_DECAY_RATE = 14;

/**
 * Maintains client-side predicted movement and reconciles against authoritative
 * 15Hz server snapshots using acknowledged input sequence numbers (`player.seq`).
 */
export class PredictionReconciler {
  private readonly kernel: PhysicsKernel;
  private state: PlayerMoveState = {
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    grounded: true,
    crouch: false,
  };
  private initialized = false;
  private pending: PendingInput[] = [];
  private offsetX = 0;
  private offsetY = 0;
  private offsetZ = 0;
  private lastErrorMeters = 0;

  constructor(kernel: PhysicsKernel) {
    this.kernel = kernel;
  }

  get currentState(): PlayerMoveState {
    return this.state;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  reset(): void {
    this.initialized = false;
    this.pending = [];
    this.offsetX = 0;
    this.offsetY = 0;
    this.offsetZ = 0;
    this.lastErrorMeters = 0;
  }

  applyLocalInput(seq: number, input: PlayerMoveInput, dt: number): ReconciledPose {
    if (!this.initialized) {
      return this.visualPose();
    }
    this.pending.push({ seq, input, dt });
    if (this.pending.length > MAX_PENDING_INPUTS) {
      this.pending.splice(0, this.pending.length - MAX_PENDING_INPUTS);
    }
    this.state = this.kernel.stepPlayer(this.state, input, dt);
    return this.visualPose();
  }

  reconcile(serverPlayer: PlayerSnapshot): ReconciledPose {
    const prevX = this.state.x + this.offsetX;
    const prevY = this.state.y + this.offsetY;
    const prevZ = this.state.z + this.offsetZ;

    // Discard inputs already processed by the authoritative server.
    this.pending = this.pending.filter(item => item.seq > serverPlayer.seq);

    let sim: PlayerMoveState = {
      x: serverPlayer.x,
      y: serverPlayer.y,
      z: serverPlayer.z,
      vx: serverPlayer.vx,
      vy: serverPlayer.vy,
      vz: serverPlayer.vz,
      grounded: serverPlayer.grounded,
      crouch: serverPlayer.crouch,
    };

    for (const item of this.pending) {
      sim = this.kernel.stepPlayer(sim, item.input, item.dt);
    }

    if (!this.initialized || !serverPlayer.alive) {
      this.state = sim;
      this.initialized = true;
      this.offsetX = 0;
      this.offsetY = 0;
      this.offsetZ = 0;
      this.lastErrorMeters = 0;
      return this.visualPose();
    }

    const dx = prevX - sim.x;
    const dy = prevY - sim.y;
    const dz = prevZ - sim.z;
    const errorDist = Math.hypot(dx, dy, dz);
    this.lastErrorMeters = Math.round(errorDist * 1000) / 1000;
    this.state = sim;

    if (errorDist > SNAP_THRESHOLD_METERS) {
      // Teleport / respawn / round reset: snap immediately without smoothing artifacts.
      this.offsetX = 0;
      this.offsetY = 0;
      this.offsetZ = 0;
    } else if (errorDist > 0.005) {
      this.offsetX = dx;
      this.offsetY = dy;
      this.offsetZ = dz;
    } else {
      this.offsetX = 0;
      this.offsetY = 0;
      this.offsetZ = 0;
    }

    return this.visualPose();
  }

  decayVisualError(dt: number): ReconciledPose {
    const factor = Math.exp(-ERROR_DECAY_RATE * Math.max(0, dt));
    this.offsetX *= factor;
    this.offsetY *= factor;
    this.offsetZ *= factor;
    if (Math.hypot(this.offsetX, this.offsetY, this.offsetZ) < 0.001) {
      this.offsetX = 0;
      this.offsetY = 0;
      this.offsetZ = 0;
    }
    return this.visualPose();
  }

  visualPose(): ReconciledPose {
    return {
      x: this.state.x + this.offsetX,
      y: this.state.y + this.offsetY,
      z: this.state.z + this.offsetZ,
      crouch: this.state.crouch,
      lastErrorMeters: this.lastErrorMeters,
      pendingCount: this.pending.length,
    };
  }
}
