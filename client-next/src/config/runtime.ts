export interface ClientRuntimeConfig {
  controlPlaneUrl: string;
  assetBaseUrl: string | null;
  mapBaseUrl: string | null;
}

const DEFAULT_CONTROL_PLANE = 'http://127.0.0.1:8080';

function normalizeOptionalUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = new URL(trimmed);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  }
  return parsed.href.replace(/\/+$/, '') + '/';
}

function normalizeControlPlaneUrl(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const parsed = new URL(value.trim());
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Unsupported controlPlaneUrl protocol: ${parsed.protocol}`);
  }
  return parsed.href.replace(/\/+$/, '');
}

export function buildEnvRuntimeConfig(env: Record<string, string | undefined> = {}): ClientRuntimeConfig {
  return {
    controlPlaneUrl: normalizeControlPlaneUrl(env.VITE_CONTROL_PLANE_URL, DEFAULT_CONTROL_PLANE),
    assetBaseUrl: normalizeOptionalUrl(env.VITE_ASSET_BASE_URL),
    mapBaseUrl: normalizeOptionalUrl(env.VITE_MAP_BASE_URL),
  };
}

export async function loadRuntimeConfig({
  configUrl = 'client-config.json',
  fetcher = (input, init) => globalThis.fetch(input, init),
  fallbackEnv = typeof import.meta !== 'undefined' && import.meta.env
    ? (import.meta.env as Record<string, string | undefined>)
    : {},
}: {
  configUrl?: string;
  fetcher?: typeof fetch;
  fallbackEnv?: Record<string, string | undefined>;
} = {}): Promise<ClientRuntimeConfig> {
  const base = buildEnvRuntimeConfig(fallbackEnv);
  const safeFetch = fetcher === globalThis.fetch ? globalThis.fetch.bind(globalThis) : fetcher;
  try {
    const res = await safeFetch(configUrl, { cache: 'no-store' });
    if (res.status === 404 || !res.ok) {
      return base;
    }
    const raw = (await res.json()) as Record<string, unknown>;
    return {
      controlPlaneUrl: normalizeControlPlaneUrl(raw.controlPlaneUrl, base.controlPlaneUrl),
      assetBaseUrl: normalizeOptionalUrl(raw.assetBaseUrl) ?? base.assetBaseUrl,
      mapBaseUrl: normalizeOptionalUrl(raw.mapBaseUrl) ?? base.mapBaseUrl,
    };
  } catch {
    return base;
  }
}
