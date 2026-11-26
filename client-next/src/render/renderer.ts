import {
  BoxGeometry,
  Color,
  DirectionalLight,
  Fog,
  GridHelper,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  WebGPURenderer,
  type Material,
  type Object3D,
} from 'three/webgpu';
import type { PlayerSnapshot, SnapshotMessage } from '../net/protocol.ts';
import { FirstPersonRig } from './viewmodel.ts';

export type GraphicsBackend = 'webgpu' | 'webgl2';

export interface CameraPose {
  x: number;
  y: number;
  z: number;
  crouch: boolean;
  yaw: number;
  pitch: number;
}

function disposeObjectTree(root: Object3D): void {
  const geometries = new Set<{ dispose: () => void }>();
  const materials = new Set<Material>();
  root.traverse(obj => {
    const mesh = obj as unknown as { geometry?: { dispose: () => void }; material?: Material | Material[] };
    if (mesh.geometry?.dispose) geometries.add(mesh.geometry);
    if (mesh.material) {
      for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        materials.add(mat);
      }
    }
  });
  for (const g of geometries) g.dispose();
  for (const m of materials) m.dispose();
}

export class MatchViewport {
  private readonly renderer: WebGPURenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(75, 16 / 9, 0.1, 450);
  private readonly entitiesGroup = new Group();
  private readonly grid = new GridHelper(80, 40, 0x3b4d63, 0x202b36);
  private mapRoot: Object3D | null = null;
  private readonly playerMeshes = new Map<string, Mesh>();
  private readonly bodyGeo = new BoxGeometry(0.56, 1.75, 0.56);
  private readonly ctMat = new MeshStandardMaterial({ color: 0x4b89dc, roughness: 0.55 });
  private readonly tMat = new MeshStandardMaterial({ color: 0xd9822b, roughness: 0.55 });
  private readonly bombGeo = new BoxGeometry(0.32, 0.16, 0.24);
  private readonly bombMat = new MeshStandardMaterial({ color: 0xff3b30, emissive: 0x551100 });
  private readonly bombMesh: Mesh;
  private readonly viewmodel = new FirstPersonRig();
  private readonly resizeObserver: ResizeObserver | null = null;
  private readonly onFrame?: (dt: number) => void;
  private rafId: number | null = null;
  private lastFrameMs = 0;
  private moveSpeed = 0;
  private disposed = false;
  readonly backend: GraphicsBackend;

  private constructor(
    renderer: WebGPURenderer,
    backend: GraphicsBackend,
    canvas: HTMLCanvasElement,
    onFrame?: (dt: number) => void,
  ) {
    this.renderer = renderer;
    this.backend = backend;
    this.onFrame = onFrame;

    this.scene.background = new Color(0xc9d8de);
    this.scene.fog = new Fog(0xc9d8de, 140, 300);
    const hemi = new HemisphereLight(0xd5e9ff, 0x99805f, 2.05);
    const sun = new DirectionalLight(0xfff0d7, 2.8);
    sun.position.set(42, 92, 12);
    this.scene.add(hemi, sun);

    this.scene.add(this.grid);
    this.scene.add(this.entitiesGroup);
    this.camera.add(this.viewmodel.group);
    this.scene.add(this.camera);

    this.bombMesh = new Mesh(this.bombGeo, this.bombMat);
    this.bombMesh.visible = false;
    this.scene.add(this.bombMesh);

    this.camera.position.set(0, 14, 18);
    this.camera.lookAt(0, 1, 0);

    const resize = () => {
      const w = canvas.clientWidth || window.innerWidth || 1280;
      const h = canvas.clientHeight || window.innerHeight || 720;
      this.camera.aspect = w / Math.max(1, h);
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h, false);
    };
    resize();

    if (typeof ResizeObserver === 'function') {
      this.resizeObserver = new ResizeObserver(resize);
      this.resizeObserver.observe(canvas);
    }
    this.lastFrameMs = performance.now();
    this.startLoop();
  }

  static async create(
    canvas: HTMLCanvasElement,
    { onFrame }: { onFrame?: (dt: number) => void } = {},
  ): Promise<MatchViewport> {
    const renderer = new WebGPURenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    await renderer.init();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const isWebGPU = Boolean((renderer.backend as { isWebGPUBackend?: boolean } | null)?.isWebGPUBackend);
    return new MatchViewport(renderer, isWebGPU ? 'webgpu' : 'webgl2', canvas, onFrame);
  }

  setMapScene(root: Object3D | null): void {
    if (this.mapRoot) {
      this.scene.remove(this.mapRoot);
      disposeObjectTree(this.mapRoot);
      this.mapRoot = null;
    }
    if (root) {
      this.mapRoot = root;
      this.scene.add(root);
      this.grid.visible = false;
    } else {
      this.grid.visible = true;
    }
  }

  setPredictedCamera(pose: CameraPose): void {
    const eyeY = pose.y + (pose.crouch ? 0.95 : 1.62);
    this.camera.position.set(pose.x, eyeY, pose.z);
    const lookX = pose.x - Math.sin(pose.yaw) * Math.cos(pose.pitch) * 6;
    const lookY = eyeY + Math.sin(pose.pitch) * 6;
    const lookZ = pose.z - Math.cos(pose.yaw) * Math.cos(pose.pitch) * 6;
    this.camera.lookAt(lookX, lookY, lookZ);
  }

  applySnapshot(snapshot: SnapshotMessage, selfId: string | null, useServerCamera = false): void {
    const seen = new Set<string>();
    let selfPlayer: PlayerSnapshot | null = null;

    for (const player of snapshot.players) {
      if (player.id === selfId) selfPlayer = player;
      if (!player.alive) continue;
      seen.add(player.id);
      let mesh = this.playerMeshes.get(player.id);
      if (!mesh) {
        mesh = new Mesh(this.bodyGeo, player.team === 'CT' ? this.ctMat : this.tMat);
        this.playerMeshes.set(player.id, mesh);
        this.entitiesGroup.add(mesh);
      } else {
        mesh.material = player.team === 'CT' ? this.ctMat : this.tMat;
      }
      const heightScale = player.crouch ? 0.62 : 1;
      mesh.scale.set(1, heightScale, 1);
      mesh.position.set(player.x, player.y + 0.875 * heightScale, player.z);
      mesh.rotation.y = player.yaw;
      mesh.visible = player.id !== selfId;
    }

    for (const [id, mesh] of this.playerMeshes) {
      if (!seen.has(id)) {
        this.entitiesGroup.remove(mesh);
        this.playerMeshes.delete(id);
      }
    }

    if (snapshot.bomb.state === 'planted' || snapshot.bomb.state === 'dropped') {
      this.bombMesh.visible = true;
      this.bombMesh.position.set(snapshot.bomb.x, snapshot.bomb.y + 0.08, snapshot.bomb.z);
    } else {
      this.bombMesh.visible = false;
    }

    if (useServerCamera && selfPlayer && selfPlayer.alive) {
      this.setPredictedCamera({
        x: selfPlayer.x,
        y: selfPlayer.y,
        z: selfPlayer.z,
        crouch: selfPlayer.crouch,
        yaw: selfPlayer.yaw,
        pitch: selfPlayer.pitch,
      });
    }
  }

  triggerShotEffect(origin?: [number, number, number], end?: [number, number, number], isSelf = false): void {
    if (isSelf) this.viewmodel.triggerShot();
    if (origin && end) {
      this.viewmodel.spawnTracer(this.scene, origin, end, performance.now());
    }
  }

  setActiveWeapon(weaponId: string, speed: number): void {
    this.viewmodel.setWeaponVisual(weaponId);
    this.moveSpeed = speed;
  }

  private startLoop(): void {
    const frame = (now: number) => {
      if (this.disposed) return;
      const dt = Math.min(0.1, Math.max(0, (now - this.lastFrameMs) / 1000));
      this.lastFrameMs = now;
      this.onFrame?.(dt);
      this.viewmodel.update(this.scene, dt, this.moveSpeed, now);
      this.renderer.render(this.scene, this.camera);
      this.rafId = requestAnimationFrame(frame);
    };
    this.rafId = requestAnimationFrame(frame);
  }

  dispose(): void {
    this.disposed = true;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.resizeObserver?.disconnect();
    this.setMapScene(null);
    this.viewmodel.dispose(this.scene);
    this.bodyGeo.dispose();
    this.ctMat.dispose();
    this.tMat.dispose();
    this.bombGeo.dispose();
    this.bombMat.dispose();
    this.renderer.dispose();
  }
}
