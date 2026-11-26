import type { PhysicsKernel, PlayerMoveInput, PlayerMoveState } from './kernel.ts';
import { TSPhysicsKernel } from './ts-kernel.ts';

export interface PhysicsWasmExports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  init_collision(ptr: number, floatLen: number): number;
  free_collision(): void;
  raycast_world(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): number;
  step_player(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    grounded: number,
    forward: number, right: number, yaw: number,
    jump: number, crouch: number, walk: number,
    dt: number,
    outPtr: number,
  ): void;
}

/**
 * Adapter implementing PhysicsKernel over the Rust/WASM physics-core ABI.
 * Allows drop-in replacement of TSPhysicsKernel once physics-core.wasm is built and hosted on CDN.
 */
export class WasmPhysicsKernel implements PhysicsKernel {
  readonly kind = 'rust-wasm' as const;
  private readonly exports: PhysicsWasmExports;
  private readonly outPtr: number;

  constructor(exports: PhysicsWasmExports) {
    this.exports = exports;
    this.outPtr = exports.alloc(7 * 4);
  }

  loadMapCollision(positions: Float32Array): void {
    const byteLen = positions.byteLength;
    const ptr = this.exports.alloc(byteLen);
    try {
      new Float32Array(this.exports.memory.buffer, ptr, positions.length).set(positions);
      const ok = this.exports.init_collision(ptr, positions.length);
      if (ok !== 1) throw new Error('WASM physics rejected collision geometry');
    } finally {
      this.exports.dealloc(ptr, byteLen);
    }
  }

  raycastWorld(
    origin: [number, number, number],
    dir: [number, number, number],
    maxDistance: number,
  ): number | null {
    const hit = this.exports.raycast_world(origin[0], origin[1], origin[2], dir[0], dir[1], dir[2], maxDistance);
    return hit >= 0 ? hit : null;
  }

  stepPlayer(state: PlayerMoveState, input: PlayerMoveInput, dt: number): PlayerMoveState {
    this.exports.step_player(
      state.x, state.y, state.z,
      state.vx, state.vy, state.vz,
      state.grounded ? 1 : 0,
      input.forward, input.right, input.yaw,
      input.jump ? 1 : 0,
      input.crouch ? 1 : 0,
      input.walk ? 1 : 0,
      dt,
      this.outPtr,
    );
    const out = new Float32Array(this.exports.memory.buffer, this.outPtr, 7);
    return {
      x: out[0],
      y: out[1],
      z: out[2],
      vx: out[3],
      vy: out[4],
      vz: out[5],
      grounded: out[6] > 0.5,
      crouch: input.crouch,
    };
  }

  dispose(): void {
    this.exports.free_collision();
    this.exports.dealloc(this.outPtr, 7 * 4);
  }
}

export async function createBestPhysicsKernel({
  wasmUrl,
  fetcher = globalThis.fetch,
}: {
  wasmUrl?: string | null;
  fetcher?: typeof fetch;
} = {}): Promise<PhysicsKernel> {
  if (wasmUrl && typeof WebAssembly === 'object') {
    try {
      const response = await fetcher(wasmUrl, { mode: 'cors', credentials: 'omit' });
      if (response.ok) {
        const bytes = await response.arrayBuffer();
        const { instance } = await WebAssembly.instantiate(bytes, {});
        const exports = instance.exports as unknown as PhysicsWasmExports;
        if (typeof exports.step_player === 'function' && typeof exports.raycast_world === 'function') {
          return new WasmPhysicsKernel(exports);
        }
      }
    } catch {
      // Fallback transparently to TSPhysicsKernel when WASM is unavailable.
    }
  }
  return new TSPhysicsKernel();
}
