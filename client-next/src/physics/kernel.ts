export interface PlayerMoveInput {
  forward: number;
  right: number;
  yaw: number;
  pitch: number;
  jump: boolean;
  crouch: boolean;
  walk: boolean;
}

export interface PlayerMoveState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  grounded: boolean;
  crouch: boolean;
}

export interface PhysicsKernel {
  readonly kind: 'ts-bvh' | 'rust-wasm';
  loadMapCollision(positions: Float32Array): void;
  stepPlayer(state: PlayerMoveState, input: PlayerMoveInput, dt: number): PlayerMoveState;
  raycastWorld(
    origin: [number, number, number],
    dir: [number, number, number],
    maxDistance: number,
  ): number | null;
  dispose(): void;
}
