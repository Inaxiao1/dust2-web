import { BinarySnapshotDecoder, encodeInputBinary } from './binary-protocol.ts';
import {
  ASSET_VERSION,
  RULES_VERSION,
  type ClientInputFrame,
  type ErrorMessage,
  type RoomTicket,
  type ServerSocketMessage,
  type SnapshotMessage,
  type WelcomeMessage,
} from './protocol.ts';

export type SocketStatus = 'idle' | 'connecting' | 'joining' | 'connected' | 'closed' | 'error';

export interface GameSocketHandlers {
  onStatus?: (status: SocketStatus) => void;
  onWelcome?: (msg: WelcomeMessage) => void;
  onSnapshot?: (msg: SnapshotMessage) => void;
  onError?: (err: ErrorMessage) => void;
  onPong?: (rttMs: number, serverTime: number) => void;
  onClose?: (code: number, reason: string) => void;
}

export interface WebSocketLike {
  readyState: number;
  binaryType?: string;
  send(data: string | Uint8Array | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
}

export class GameSocketClient {
  private readonly createSocket: (url: string) => WebSocketLike;
  private readonly binaryDecoder = new BinarySnapshotDecoder();
  private socket: WebSocketLike | null = null;
  private handlers: GameSocketHandlers;
  private status: SocketStatus = 'idle';
  private useBinaryV2 = false;

  constructor(
    handlers: GameSocketHandlers = {},
    createSocket: (url: string) => WebSocketLike = url => new WebSocket(url) as unknown as WebSocketLike,
  ) {
    this.handlers = handlers;
    this.createSocket = createSocket;
  }

  get currentStatus(): SocketStatus {
    return this.status;
  }

  get isBinaryProtocolActive(): boolean {
    return this.useBinaryV2;
  }

  connectWithTicket(
    ticket: RoomTicket,
    options: {
      playerName: string;
      bots?: number;
      botDifficulty?: 'easy' | 'normal' | 'hard' | 'expert';
      team?: 'auto' | 'T' | 'CT';
      preferBinaryV2?: boolean;
    },
  ): void {
    this.disconnect();
    this.binaryDecoder.reset();
    this.useBinaryV2 = false;
    this.setStatus('connecting');

    const wsUrl = new URL(ticket.workerWsUrl);
    wsUrl.searchParams.set('token', ticket.joinToken);
    const ws = this.createSocket(wsUrl.href);
    ws.binaryType = 'arraybuffer';
    this.socket = ws;

    ws.onopen = () => {
      if (this.socket !== ws) return;
      this.setStatus('joining');
      ws.send(
        JSON.stringify({
          type: 'join',
          name: options.playerName,
          room: ticket.roomCode,
          mode: ticket.mode,
          visibility: ticket.visibility ?? 'public',
          bots: options.bots ?? 4,
          botDifficulty: options.botDifficulty ?? 'normal',
          team: options.team ?? 'auto',
          joinToken: ticket.joinToken,
          binaryProtocol: options.preferBinaryV2 === false ? 0 : 2,
          rulesVersion: RULES_VERSION,
          assetVersion: ASSET_VERSION,
        }),
      );
    };

    ws.onmessage = event => {
      if (this.socket !== ws) return;
      if (event.data instanceof ArrayBuffer || ArrayBuffer.isView(event.data)) {
        const bytes = event.data instanceof ArrayBuffer
          ? new Uint8Array(event.data)
          : new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
        const snap = this.binaryDecoder.decode(bytes);
        if (snap) this.handlers.onSnapshot?.(snap);
        return;
      }
      if (typeof event.data !== 'string') return;
      let msg: ServerSocketMessage;
      try {
        msg = JSON.parse(event.data) as ServerSocketMessage;
      } catch {
        return;
      }
      if (msg.type === 'welcome') {
        const welcome = msg as WelcomeMessage;
        this.useBinaryV2 = welcome.binaryProtocol === 2;
        this.setStatus('connected');
        this.handlers.onWelcome?.(welcome);
      } else if (msg.type === 'snapshot') {
        this.handlers.onSnapshot?.(msg as SnapshotMessage);
      } else if (msg.type === 'error') {
        this.handlers.onError?.(msg as ErrorMessage);
      } else if (msg.type === 'pong') {
        const pong = msg as { time?: number | null; serverTime?: number };
        if (typeof pong.time === 'number' && typeof pong.serverTime === 'number') {
          this.handlers.onPong?.(Math.max(0, Date.now() - pong.time), pong.serverTime);
        }
      }
    };

    ws.onerror = () => {
      if (this.socket !== ws) return;
      this.setStatus('error');
      this.handlers.onError?.({
        type: 'error',
        code: 'SOCKET_ERROR',
        message: '对局连接发生网络错误，请检查对局节点是否可达。',
      });
    };

    ws.onclose = event => {
      if (this.socket !== ws) return;
      this.socket = null;
      this.useBinaryV2 = false;
      this.setStatus('closed');
      this.handlers.onClose?.(event.code ?? 1000, event.reason ?? '');
    };
  }

  sendInput(frame: ClientInputFrame): boolean {
    if (!this.socket || this.socket.readyState !== 1) return false;
    if (this.useBinaryV2) {
      this.socket.send(encodeInputBinary(frame));
    } else {
      this.socket.send(JSON.stringify({ type: 'input', ...frame }));
    }
    return true;
  }

  sendPing(): boolean {
    if (!this.socket || this.socket.readyState !== 1) return false;
    this.socket.send(JSON.stringify({ type: 'ping', time: Date.now() }));
    return true;
  }

  sendBuy(weapon: string): boolean {
    if (!this.socket || this.socket.readyState !== 1) return false;
    this.socket.send(JSON.stringify({ type: 'buy', weapon }));
    return true;
  }

  sendRefund(weapon: string): boolean {
    if (!this.socket || this.socket.readyState !== 1) return false;
    this.socket.send(JSON.stringify({ type: 'refund', weapon }));
    return true;
  }

  sendDropWeapon(): boolean {
    if (!this.socket || this.socket.readyState !== 1) return false;
    this.socket.send(JSON.stringify({ type: 'dropWeapon' }));
    return true;
  }

  sendTakeBot(): boolean {
    if (!this.socket || this.socket.readyState !== 1) return false;
    this.socket.send(JSON.stringify({ type: 'takeBot' }));
    return true;
  }

  disconnect(): void {
    const active = this.socket;
    this.socket = null;
    this.useBinaryV2 = false;
    this.binaryDecoder.reset();
    if (active) {
      active.onopen = null;
      active.onmessage = null;
      active.onerror = null;
      active.onclose = null;
      try {
        active.close(1000, 'Client disconnect');
      } catch {
        // Ignore close errors on already-closed sockets.
      }
    }
    this.setStatus('idle');
  }

  private setStatus(status: SocketStatus): void {
    this.status = status;
    this.handlers.onStatus?.(status);
  }
}
