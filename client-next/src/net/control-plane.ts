import type {
  ControlPlaneHealth,
  ControlPlaneRoom,
  GameMode,
  RoomTicket,
  RoomVisibility,
} from './protocol.ts';

export class ControlPlaneError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ControlPlaneError';
    this.code = code;
    this.status = status;
  }
}

export interface CreateRoomParams {
  mapId: string;
  mode: GameMode;
  visibility: RoomVisibility;
  playerName: string;
}

export class ControlPlaneClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(
    baseUrl: string,
    fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init),
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetcher = fetcher === globalThis.fetch ? globalThis.fetch.bind(globalThis) : fetcher;
  }

  async health(signal?: AbortSignal): Promise<ControlPlaneHealth> {
    return this.request<ControlPlaneHealth>('GET', '/api/v1/health', undefined, signal);
  }

  async listRooms(mapId?: string, signal?: AbortSignal): Promise<ControlPlaneRoom[]> {
    const query = mapId ? `?mapId=${encodeURIComponent(mapId)}` : '';
    const data = await this.request<{ rooms: ControlPlaneRoom[] }>(
      'GET',
      `/api/v1/rooms${query}`,
      undefined,
      signal,
    );
    return data.rooms ?? [];
  }

  async createRoom(params: CreateRoomParams, signal?: AbortSignal): Promise<RoomTicket> {
    return this.request<RoomTicket>('POST', '/api/v1/rooms', params, signal);
  }

  async joinRoom(roomCode: string, playerName: string, signal?: AbortSignal): Promise<RoomTicket> {
    const normalized = roomCode.trim().toUpperCase();
    return this.request<RoomTicket>(
      'POST',
      `/api/v1/rooms/${encodeURIComponent(normalized)}/join`,
      { playerName },
      signal,
    );
  }

  private async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await this.fetcher(`${this.baseUrl}${path}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    if (text) {
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = {};
      }
    }
    if (!res.ok) {
      const code = typeof parsed.code === 'string' ? parsed.code : `HTTP_${res.status}`;
      const message = typeof parsed.message === 'string' ? parsed.message : `控制面请求失败 (${res.status})`;
      throw new ControlPlaneError(code, message, res.status);
    }
    return parsed as T;
  }
}
