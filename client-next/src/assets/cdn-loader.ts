import { Group, type Material, type Object3D } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export interface ManifestFileEntry {
  path: string;
  bytes: number;
  sha256: string;
}

export interface MapRenderManifest {
  schemaVersion: number;
  id: string;
  sourceSha256?: string;
  files: ManifestFileEntry[];
}

export interface LoadedMapBundle {
  mapId: string;
  scene: Group | null;
  physicsPositions: Float32Array | null;
  verifiedFiles: number;
  cacheHits: number;
}

export function assertSafeRelativePath(relativePath: string): string {
  if (
    !relativePath ||
    relativePath.startsWith('/') ||
    relativePath.includes('\\') ||
    /%(?:2e|2f|5c)/i.test(relativePath) ||
    /[\u0000-\u001f?#]/.test(relativePath)
  ) {
    throw new Error(`Unsafe CDN asset path: ${relativePath}`);
  }
  const parts = relativePath.split('/');
  if (parts.some(p => !p || p === '.' || p === '..')) {
    throw new Error(`Path traversal rejected: ${relativePath}`);
  }
  return relativePath;
}

export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

export interface CdnLoaderOptions {
  mapBaseUrl: string | null;
  assetBaseUrl?: string | null;
  fetcher?: typeof fetch;
  cacheStorage?: CacheStorage | null;
  cacheName?: string;
}

/**
 * Fetches map collision geometry and GLTF render bundles directly from CDN with
 * strict CORS isolation, SHA-256 integrity verification, and content-addressed CacheStorage reuse.
 */
export class CdnAssetLoader {
  private readonly mapBaseUrl: string | null;
  private readonly assetBaseUrl: string | null;
  private readonly fetcher: typeof fetch;
  private readonly cacheStorage: CacheStorage | null;
  private readonly cacheName: string;
  private cacheHitsCount = 0;

  constructor({
    mapBaseUrl,
    assetBaseUrl = null,
    fetcher = (input, init) => globalThis.fetch(input, init),
    cacheStorage = typeof globalThis.caches !== 'undefined' ? globalThis.caches : null,
    cacheName = 'duskrain-cdn-assets-v1',
  }: CdnLoaderOptions) {
    this.mapBaseUrl = mapBaseUrl ? mapBaseUrl.replace(/\/+$/, '') + '/' : null;
    this.assetBaseUrl = assetBaseUrl ? assetBaseUrl.replace(/\/+$/, '') + '/' : null;
    this.fetcher = fetcher === globalThis.fetch ? globalThis.fetch.bind(globalThis) : fetcher;
    this.cacheStorage = cacheStorage;
    this.cacheName = cacheName;
  }

  get cacheHits(): number {
    return this.cacheHitsCount;
  }

  resolveMapUrl(mapId: string, relativePath: string, versionHash?: string): string {
    if (!this.mapBaseUrl) {
      throw new Error('CDN mapBaseUrl is not configured');
    }
    if (!/^de_[a-z0-9]+$/.test(mapId)) {
      throw new Error(`Invalid mapId: ${mapId}`);
    }
    const cleanRel = assertSafeRelativePath(relativePath);
    const url = new URL(`${mapId}/${cleanRel}`, this.mapBaseUrl);
    if (versionHash) {
      url.searchParams.set('v', versionHash);
    }
    return url.href;
  }

  resolveAssetUrl(relativePath: string, versionHash?: string): string {
    if (!this.assetBaseUrl) {
      throw new Error('CDN assetBaseUrl is not configured');
    }
    const cleanRel = assertSafeRelativePath(relativePath);
    const url = new URL(cleanRel, this.assetBaseUrl);
    if (versionHash) {
      url.searchParams.set('v', versionHash);
    }
    return url.href;
  }

  async fetchVerifiedBytes(
    url: string,
    {
      expectedSha256,
      expectedBytes,
      maxBytes = 256 * 1024 * 1024,
      signal,
    }: {
      expectedSha256?: string;
      expectedBytes?: number;
      maxBytes?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<ArrayBuffer> {
    signal?.throwIfAborted();
    const cacheKey = expectedSha256 ? `https://cache.duskrain.local/sha256/${expectedSha256}` : null;
    let cache: Cache | null = null;
    if (cacheKey && this.cacheStorage) {
      try {
        cache = await this.cacheStorage.open(this.cacheName);
        const hit = await cache.match(cacheKey);
        if (hit) {
          const cachedBytes = await hit.arrayBuffer();
          const okLen = !expectedBytes || cachedBytes.byteLength === expectedBytes;
          if (okLen && (await sha256Hex(cachedBytes)) === expectedSha256) {
            this.cacheHitsCount++;
            return cachedBytes;
          }
          await cache.delete(cacheKey).catch(() => {});
        }
      } catch {
        cache = null;
      }
    }

    const res = await this.fetcher(url, {
      mode: 'cors',
      credentials: 'omit',
      cache: expectedSha256 ? 'default' : 'no-store',
      signal,
    });
    if (!res.ok) {
      throw new Error(`CDN download failed (${res.status}): ${url}`);
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxBytes) {
      throw new Error(`CDN object exceeds maxBytes limit: ${buf.byteLength}`);
    }
    if (expectedBytes && buf.byteLength !== expectedBytes) {
      throw new Error(`CDN byte length mismatch: expected ${expectedBytes}, got ${buf.byteLength}`);
    }
    if (expectedSha256) {
      const actualHash = await sha256Hex(buf);
      if (actualHash !== expectedSha256) {
        throw new Error(`CDN SHA-256 mismatch for ${url}`);
      }
      if (cache && cacheKey) {
        try {
          await cache.put(
            cacheKey,
            new Response(buf.slice(0), {
              headers: {
                'Content-Type': 'application/octet-stream',
                'Content-Length': String(buf.byteLength),
              },
            }),
          );
        } catch {
          // Quota or private-browsing failures never break asset loading.
        }
      }
    }
    return buf;
  }

  async loadMapBundle(
    mapId: string,
    {
      onProgress = () => {},
      signal,
    }: { onProgress?: (stage: string) => void; signal?: AbortSignal } = {},
  ): Promise<LoadedMapBundle> {
    if (!this.mapBaseUrl) {
      return { mapId, scene: null, physicsPositions: null, verifiedFiles: 0, cacheHits: this.cacheHitsCount };
    }

    let verifiedFiles = 0;
    onProgress(`读取 ${mapId} 渲染清单…`);
    const manifestUrl = this.resolveMapUrl(mapId, 'render-manifest.json');
    const manifestBytes = await this.fetchVerifiedBytes(manifestUrl, { maxBytes: 4 * 1024 * 1024, signal });
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as MapRenderManifest;
    if (manifest.schemaVersion !== 1 || manifest.id !== mapId || !Array.isArray(manifest.files)) {
      throw new Error(`Invalid render manifest for ${mapId}`);
    }

    const fileIndex = new Map(manifest.files.map(f => [f.path, f]));
    const gltfEntry = fileIndex.get('map.gltf');
    if (!gltfEntry) {
      throw new Error(`Render manifest missing map.gltf for ${mapId}`);
    }

    onProgress(`下载并校验 ${mapId} 场景模型…`);
    const gltfUrl = this.resolveMapUrl(mapId, 'render/map.gltf', gltfEntry.sha256);
    const gltfBytes = await this.fetchVerifiedBytes(gltfUrl, {
      expectedSha256: gltfEntry.sha256,
      expectedBytes: gltfEntry.bytes,
      signal,
    });
    verifiedFiles++;

    let physicsPositions: Float32Array | null = null;
    try {
      onProgress(`加载 ${mapId} 碰撞网格…`);
      const physUrl = this.resolveMapUrl(mapId, 'physics.f32');
      const physBuf = await this.fetchVerifiedBytes(physUrl, { maxBytes: 128 * 1024 * 1024, signal });
      if (physBuf.byteLength >= 36 && physBuf.byteLength % 36 === 0) {
        physicsPositions = new Float32Array(physBuf);
      }
    } catch {
      // Optional during incremental CDN rollout; server remains authoritative.
      physicsPositions = null;
    }

    onProgress(`解析 ${mapId} GLTF 场景…`);
    const loader = new GLTFLoader();
    try {
      const { MeshoptDecoder } = await import('three/addons/libs/meshopt_decoder.module.js');
      if (MeshoptDecoder?.ready) await MeshoptDecoder.ready;
      loader.setMeshoptDecoder(MeshoptDecoder);
    } catch {
      // Non-meshopt maps still parse normally if decoder is unavailable in test env.
    }
    const renderBase = new URL(`${mapId}/render/`, this.mapBaseUrl).href;
    const gltfText = new TextDecoder().decode(gltfBytes);
    const parsed = await loader.parseAsync(gltfText, renderBase);

    const root = new Group();
    root.name = `${mapId}-render`;
    if (mapId === 'de_dust2') {
      // Source 2 Viewer exports (y,z,x); gameplay collision uses (x,z,-y).
      root.rotation.y = Math.PI / 2;
    }
    root.add(parsed.scene);
    root.updateMatrixWorld(true);

    const rawLights: Object3D[] = [];
    const seenMaterials = new Set<Material>();
    root.traverse(obj => {
      const anyObj = obj as unknown as {
        isLight?: boolean;
        isMesh?: boolean;
        frustumCulled?: boolean;
        material?: Material | Material[];
      };
      if (anyObj.isLight) {
        rawLights.push(obj);
        return;
      }
      if (!anyObj.isMesh) return;
      anyObj.frustumCulled = true;
      const mats = Array.isArray(anyObj.material) ? anyObj.material : anyObj.material ? [anyObj.material] : [];
      for (const mat of mats) {
        if (seenMaterials.has(mat)) continue;
        seenMaterials.add(mat);
        const vmat = (mat.userData as { vmat?: { IntParams?: Record<string, number>; ShaderName?: string; Name?: string } } | undefined)?.vmat;
        const flags = vmat?.IntParams ?? {};
        if (flags.F_DEPTH_FEATHER) {
          mat.visible = false;
        }
        if (
          flags.F_VERTEX_ANIMATION ||
          vmat?.ShaderName === 'csgo_effects.vfx' ||
          vmat?.ShaderName === 'csgo_foliage.vfx'
        ) {
          (mat as unknown as { vertexColors?: boolean }).vertexColors = false;
        }
        const sourceName = vmat?.Name || mat.name || '';
        if (/overlay|decal|graffiti|poster/i.test(sourceName)) {
          mat.polygonOffset = true;
          mat.polygonOffsetFactor = -1;
          mat.polygonOffsetUnits = -1;
        }
      }
    });
    for (const light of rawLights) {
      light.removeFromParent();
    }
    root.traverse(obj => {
      obj.matrixAutoUpdate = false;
      obj.matrixWorldAutoUpdate = false;
    });

    return {
      mapId,
      scene: root,
      physicsPositions,
      verifiedFiles,
      cacheHits: this.cacheHitsCount,
    };
  }
}
