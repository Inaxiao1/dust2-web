import { BufferGeometry, DoubleSide, Float32BufferAttribute, Ray, Vector3 } from 'three';
import { CENTER, MeshBVH } from 'three-mesh-bvh';
import type { PhysicsKernel, PlayerMoveInput, PlayerMoveState } from './kernel.ts';

const GRAVITY = 800 * 0.0254;
const JUMP_SPEED = 301.993378 * 0.0254;
const STAND_WALK_SPEED = 250 * 0.0254;
const SLOW_WALK_SPEED = 130 * 0.0254;
const CROUCH_SPEED = 85 * 0.0254;

/**
 * Transitional TypeScript/three-mesh-bvh implementation of PhysicsKernel.
 * Mirrors the shared physics constants so a Rust/WASM kernel can swap in cleanly.
 */
export class TSPhysicsKernel implements PhysicsKernel {
  readonly kind = 'ts-bvh' as const;
  private geometry: BufferGeometry | null = null;
  private bvh: MeshBVH | null = null;
  private readonly ray = new Ray();
  private readonly dir = new Vector3();

  loadMapCollision(positions: Float32Array): void {
    this.dispose();
    if (positions.length < 9 || positions.length % 9 !== 0) {
      throw new Error('Invalid collision triangle buffer length');
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    this.geometry = geometry;
    this.bvh = new MeshBVH(geometry, { strategy: CENTER, targetLeafSize: 16, maxDepth: 32 });
  }

  raycastWorld(
    origin: [number, number, number],
    dir: [number, number, number],
    maxDistance: number,
  ): number | null {
    if (!this.bvh) return null;
    this.dir.set(dir[0], dir[1], dir[2]);
    const len = this.dir.length();
    if (len < 1e-8) return null;
    this.dir.divideScalar(len);
    this.ray.origin.set(origin[0], origin[1], origin[2]);
    this.ray.direction.copy(this.dir);
    const hit = this.bvh.raycastFirst(this.ray, DoubleSide);
    if (!hit || hit.distance > maxDistance) return null;
    return hit.distance;
  }

  stepPlayer(state: PlayerMoveState, input: PlayerMoveInput, dt: number): PlayerMoveState {
    const safeDt = Math.max(0, Math.min(0.1, dt));
    const speed = input.crouch
      ? CROUCH_SPEED
      : input.walk
        ? SLOW_WALK_SPEED
        : STAND_WALK_SPEED;

    const fwdX = -Math.sin(input.yaw);
    const fwdZ = -Math.cos(input.yaw);
    const rightX = Math.cos(input.yaw);
    const rightZ = -Math.sin(input.yaw);

    const wishX = fwdX * input.forward + rightX * input.right;
    const wishZ = fwdZ * input.forward + rightZ * input.right;
    const wishLen = Math.hypot(wishX, wishZ);
    const nx = wishLen > 1e-5 ? wishX / Math.max(1, wishLen) : 0;
    const nz = wishLen > 1e-5 ? wishZ / Math.max(1, wishLen) : 0;

    let vx = nx * speed;
    let vz = nz * speed;
    let vy = state.vy;
    let grounded = state.grounded;

    if (grounded && input.jump) {
      vy = JUMP_SPEED;
      grounded = false;
    }

    if (!grounded) {
      vy -= GRAVITY * safeDt;
    }

    const nextX = state.x + vx * safeDt;
    let nextY = state.y + vy * safeDt;
    const nextZ = state.z + vz * safeDt;

    if (this.bvh && vy <= 0) {
      const probeY = state.y + (input.crouch ? 0.55 : 0.9);
      const dropHit = this.raycastWorld([nextX, probeY, nextZ], [0, -1, 0], probeY - nextY + 0.05);
      if (dropHit !== null) {
        const floorY = probeY - dropHit;
        if (nextY <= floorY) {
          nextY = floorY;
          vy = 0;
          grounded = true;
        }
      } else if (nextY < state.y) {
        grounded = false;
      }
    } else if (!this.bvh && nextY <= 0) {
      nextY = 0;
      vy = 0;
      grounded = true;
    }

    return {
      x: nextX,
      y: nextY,
      z: nextZ,
      vx,
      vy,
      vz,
      grounded,
      crouch: input.crouch,
    };
  }

  dispose(): void {
    this.bvh = null;
    this.geometry?.dispose();
    this.geometry = null;
  }
}
