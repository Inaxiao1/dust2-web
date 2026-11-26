export const RULES_VERSION = 1;
export const ASSET_VERSION = '5a82c6eead18b7e0';
export const CLIENT_BUILD = '1.4.0-perf.6.2';

export interface MapSummary {
  id: string;
  name: string;
  nameZh: string;
}

export const PERFORMANCE_MAPS: readonly MapSummary[] = [
  { id: 'de_dust2', name: 'Dust II', nameZh: '炙热沙城 II' },
  { id: 'de_mirage', name: 'Mirage', nameZh: '荒漠迷城' },
  { id: 'de_inferno', name: 'Inferno', nameZh: '炼狱小镇' },
  { id: 'de_nuke', name: 'Nuke', nameZh: '核子危机' },
  { id: 'de_ancient', name: 'Ancient', nameZh: '远古遗迹' },
  { id: 'de_anubis', name: 'Anubis', nameZh: '阿努比斯' },
  { id: 'de_cache', name: 'Cache', nameZh: '死城之谜' },
  { id: 'de_train', name: 'Train', nameZh: '列车停放站' },
  { id: 'de_vertigo', name: 'Vertigo', nameZh: '殒命大厦' },
];

export type GameMode = 'defuse' | 'deathmatch';
export type RoomVisibility = 'public' | 'private';
export type TeamSide = 'T' | 'CT';

export interface ControlPlaneRoom {
  code: string;
  mapId: string;
  workerId: string;
  mode: GameMode;
  visibility: RoomVisibility;
  humans: number;
  bots: number;
  capacity: number;
  phase: string;
  joinable: boolean;
  scores: Record<string, number>;
}

export interface RoomTicket {
  roomCode: string;
  mapId: string;
  mode: GameMode;
  visibility?: RoomVisibility;
  workerId: string;
  workerWsUrl: string;
  joinToken: string;
  expiresAt: number;
}

export interface ControlPlaneHealth {
  ok: boolean;
  ready: boolean;
  draining: boolean;
  service: string;
  stats: {
    activeWorkers: number;
    drainingWorkers: number;
    publicRooms: number;
    totalRooms: number;
  };
}

export interface PlayerSnapshot {
  id: string;
  name: string;
  team: TeamSide;
  bot: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  pitch: number;
  crouch: boolean;
  grounded: boolean;
  health: number;
  armor: number;
  alive: boolean;
  weapon: string;
  slot: number;
  ammo: number;
  reserve: number;
  money: number;
  kills: number;
  deaths: number;
  assists: number;
  seq: number;
  hasBomb: boolean;
}

export interface RoundSnapshot {
  number: number;
  phase: 'waiting' | 'freeze' | 'live' | 'ended';
  phaseEndsAt: number;
  timeLeft: number;
  buyEndsAt: number;
  winner: TeamSide | null;
  reason: string;
}

export interface BombSnapshot {
  state: 'carried' | 'dropped' | 'planted' | 'exploded' | 'defused' | 'none';
  carrierId: string | null;
  x: number;
  y: number;
  z: number;
  site: string | null;
  progress: number;
  remaining: number;
}

export interface GameEvent {
  id: string | number;
  type: string;
  time: number;
  [key: string]: unknown;
}

export interface WelcomeMessage {
  type: 'welcome';
  id: string;
  room: string;
  mode: GameMode;
  team: TeamSide;
  tickRate: number;
  snapshotRate: number;
  serverTime: number;
  protocol: number;
  binaryProtocol?: number;
}

export interface SnapshotMessage {
  type: 'snapshot';
  time: number;
  room: string;
  mode: GameMode;
  players: PlayerSnapshot[];
  round: RoundSnapshot;
  bomb: BombSnapshot;
  scores: { T: number; CT: number };
  events: GameEvent[];
}

export interface ErrorMessage {
  type: 'error';
  code: string;
  message: string;
}

export interface PongMessage {
  type: 'pong';
  time: number | null;
  serverTime: number;
}

export type ServerSocketMessage = WelcomeMessage | SnapshotMessage | ErrorMessage | PongMessage | { type: string; [key: string]: unknown };

export interface ClientInputFrame {
  seq: number;
  forward: number;
  right: number;
  yaw: number;
  pitch: number;
  jump: boolean;
  crouch: boolean;
  walk: boolean;
  fire: boolean;
  reload: boolean;
  slot: number;
  interact: boolean;
}
