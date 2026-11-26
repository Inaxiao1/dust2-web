import {
  BoxGeometry,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshStandardMaterial,
  type Scene,
} from 'three/webgpu';

interface ActiveTracer {
  line: Line;
  geometry: BufferGeometry;
  expiresAt: number;
}

/**
 * Lightweight camera-mounted first-person weapon Viewmodel + bullet tracer pool.
 * Can be progressively upgraded with CDN GLB viewmodels without changing viewport callers.
 */
export class FirstPersonRig {
  readonly group = new Group();
  private readonly bodyGeo = new BoxGeometry(0.075, 0.095, 0.48);
  private readonly barrelGeo = new BoxGeometry(0.032, 0.032, 0.28);
  private readonly bodyMat = new MeshStandardMaterial({ color: 0x2b333c, metalness: 0.45, roughness: 0.4 });
  private readonly accentMat = new MeshStandardMaterial({ color: 0xb88b4a, metalness: 0.25, roughness: 0.6 });
  private readonly flashGeo = new BoxGeometry(0.07, 0.07, 0.07);
  private readonly flashMat = new MeshStandardMaterial({ color: 0xffd27d, emissive: 0xff9a2e });
  private readonly tracerMat = new LineBasicMaterial({ color: 0xffe49e, transparent: true, opacity: 0.85 });
  private readonly weaponBody: Mesh;
  private readonly flashMesh: Mesh;
  private readonly tracers: ActiveTracer[] = [];
  private recoil = 0;
  private flashTimer = 0;
  private bobPhase = 0;

  constructor() {
    this.weaponBody = new Mesh(this.bodyGeo, this.bodyMat);
    const barrel = new Mesh(this.barrelGeo, this.accentMat);
    barrel.position.set(0, 0.02, -0.32);

    this.flashMesh = new Mesh(this.flashGeo, this.flashMat);
    this.flashMesh.position.set(0, 0.02, -0.49);
    this.flashMesh.visible = false;

    this.group.add(this.weaponBody, barrel, this.flashMesh);
    this.group.position.set(0.24, -0.22, -0.44);
  }

  setWeaponVisual(weaponId: string): void {
    const isKnife = weaponId === 'knife';
    const isSniper = weaponId === 'awp' || weaponId === 'ssg08';
    const isPistol = ['pistol', 'usp', 'deagle', 'p250', 'elite', 'fiveseven', 'tec9'].includes(weaponId);
    this.weaponBody.scale.set(
      isKnife ? 0.5 : 1,
      isKnife ? 0.5 : 1,
      isKnife ? 0.45 : isPistol ? 0.65 : isSniper ? 1.35 : 1,
    );
  }

  triggerShot(): void {
    this.recoil = Math.min(0.11, this.recoil + 0.055);
    this.flashTimer = 0.045;
    this.flashMesh.visible = true;
  }

  spawnTracer(scene: Scene, origin: [number, number, number], end: [number, number, number], nowMs: number): void {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute([...origin, ...end], 3));
    const line = new Line(geometry, this.tracerMat);
    scene.add(line);
    this.tracers.push({ line, geometry, expiresAt: nowMs + 95 });
  }

  update(scene: Scene, dt: number, movingSpeed: number, nowMs: number): void {
    this.recoil = Math.max(0, this.recoil - dt * 0.45);
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) this.flashMesh.visible = false;
    }
    if (movingSpeed > 0.4) {
      this.bobPhase += dt * 9.5;
    }
    const bobX = Math.cos(this.bobPhase) * 0.008 * Math.min(1, movingSpeed / 5);
    const bobY = Math.abs(Math.sin(this.bobPhase)) * 0.009 * Math.min(1, movingSpeed / 5);
    this.group.position.set(0.24 + bobX, -0.22 - bobY, -0.44 + this.recoil);
    this.group.rotation.x = this.recoil * 1.4;

    for (let i = this.tracers.length - 1; i >= 0; i--) {
      if (nowMs >= this.tracers[i].expiresAt) {
        scene.remove(this.tracers[i].line);
        this.tracers[i].geometry.dispose();
        this.tracers.splice(i, 1);
      }
    }
  }

  dispose(scene: Scene): void {
    for (const t of this.tracers) {
      scene.remove(t.line);
      t.geometry.dispose();
    }
    this.tracers.length = 0;
    this.bodyGeo.dispose();
    this.barrelGeo.dispose();
    this.bodyMat.dispose();
    this.accentMat.dispose();
    this.flashGeo.dispose();
    this.flashMat.dispose();
    this.tracerMat.dispose();
  }
}
