import type { ClientInputFrame, PlayerSnapshot, SnapshotMessage } from './protocol.ts';

export const BINARY_PROTOCOL_VERSION = 2;
export const PACKET_INPUT = 1;
export const PACKET_SNAPSHOT_FULL = 2;
export const PACKET_SNAPSHOT_DELTA = 3;

const CODE_TO_PHASE = ['waiting', 'freeze', 'live', 'ended'] as const;
const CODE_TO_BOMB = ['none', 'carried', 'dropped', 'planted', 'exploded', 'defused'] as const;
const decoder = new TextDecoder();

export function encodeInputBinary(input: ClientInputFrame): Uint8Array {
  const buf = new ArrayBuffer(26);
  const view = new DataView(buf);
  view.setUint8(0, BINARY_PROTOCOL_VERSION);
  view.setUint8(1, PACKET_INPUT);
  view.setUint32(2, input.seq >>> 0, true);
  view.setInt16(6, Math.round(Math.max(-1, Math.min(1, input.forward)) * 1000), true);
  view.setInt16(8, Math.round(Math.max(-1, Math.min(1, input.right)) * 1000), true);
  view.setFloat32(10, Number.isFinite(input.yaw) ? input.yaw : 0, true);
  view.setFloat32(14, Number.isFinite(input.pitch) ? input.pitch : 0, true);
  let flags = 0;
  if (input.jump) flags |= 1;
  if (input.crouch) flags |= 2;
  if (input.walk) flags |= 4;
  if (input.fire) flags |= 8;
  if (input.reload) flags |= 16;
  if (input.interact) flags |= 32;
  view.setUint16(18, flags, true);
  view.setUint8(20, Math.max(0, Math.min(5, input.slot || 0)));
  return new Uint8Array(buf);
}

export class BinarySnapshotDecoder {
  private baseline = new Map<string, PlayerSnapshot>();

  reset(): void {
    this.baseline.clear();
  }

  decode(buffer: ArrayBuffer | Uint8Array): SnapshotMessage | null {
    const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (u8.byteLength < 49) return null;
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (view.getUint8(0) !== BINARY_PROTOCOL_VERSION) return null;
    const kind = view.getUint8(1);
    if (kind !== PACKET_SNAPSHOT_FULL && kind !== PACKET_SNAPSHOT_DELTA) return null;

    const isDelta = kind === PACKET_SNAPSHOT_DELTA;
    const time = view.getFloat64(4, true);
    const ctScore = view.getUint8(12);
    const tScore = view.getUint8(13);
    const roundNumber = view.getUint8(14);
    const roundPhase = CODE_TO_PHASE[view.getUint8(15)] ?? 'waiting';
    const timeLeft = view.getFloat32(16, true);
    const bombState = CODE_TO_BOMB[view.getUint8(20)] ?? 'none';
    const playerCount = view.getUint8(21);
    const removedCount = view.getUint8(22);
    const mode = view.getUint8(23) === 1 ? 'deathmatch' : 'defuse';
    const bombX = view.getFloat32(24, true);
    const bombY = view.getFloat32(28, true);
    const bombZ = view.getFloat32(32, true);
    const bombProgress = view.getFloat32(36, true);
    const bombRemaining = view.getFloat32(40, true);

    let offset = 44;
    const roomLen = u8[offset++];
    const room = decoder.decode(u8.subarray(offset, offset + roomLen));
    offset += roomLen;

    if (!isDelta) this.baseline.clear();

    for (let i = 0; i < playerCount; i++) {
      const idLen = u8[offset++];
      const id = decoder.decode(u8.subarray(offset, offset + idLen));
      offset += idLen;
      const nameLen = u8[offset++];
      const name = decoder.decode(u8.subarray(offset, offset + nameLen));
      offset += nameLen;
      const weaponLen = u8[offset++];
      const weapon = decoder.decode(u8.subarray(offset, offset + weaponLen));
      offset += weaponLen;
      const bits = u8[offset++];

      const x = view.getFloat32(offset, true); offset += 4;
      const y = view.getFloat32(offset, true); offset += 4;
      const z = view.getFloat32(offset, true); offset += 4;
      const vx = view.getFloat32(offset, true); offset += 4;
      const vy = view.getFloat32(offset, true); offset += 4;
      const vz = view.getFloat32(offset, true); offset += 4;
      const yaw = view.getFloat32(offset, true); offset += 4;
      const pitch = view.getFloat32(offset, true); offset += 4;
      const health = view.getUint8(offset++);
      const armor = view.getUint8(offset++);
      const slot = view.getUint8(offset++);
      const ammo = view.getUint8(offset++);
      const reserve = view.getUint16(offset, true); offset += 2;
      const money = view.getUint16(offset, true); offset += 2;
      const kills = view.getUint16(offset, true); offset += 2;
      const deaths = view.getUint16(offset, true); offset += 2;
      const assists = view.getUint16(offset, true); offset += 2;
      const seq = view.getUint32(offset, true); offset += 4;

      this.baseline.set(id, {
        id,
        name,
        weapon,
        team: bits & 1 ? 'T' : 'CT',
        bot: Boolean(bits & 2),
        alive: Boolean(bits & 4),
        crouch: Boolean(bits & 8),
        grounded: Boolean(bits & 16),
        hasBomb: Boolean(bits & 32),
        x, y, z, vx, vy, vz, yaw, pitch,
        health, armor, slot, ammo, reserve, money, kills, deaths, assists, seq,
      });
    }

    for (let i = 0; i < removedCount; i++) {
      const idLen = u8[offset++];
      const removedId = decoder.decode(u8.subarray(offset, offset + idLen));
      offset += idLen;
      this.baseline.delete(removedId);
    }

    const eventsLen = view.getUint32(offset, true);
    offset += 4;
    const events = eventsLen > 0
      ? (JSON.parse(decoder.decode(u8.subarray(offset, offset + eventsLen))) as SnapshotMessage['events'])
      : [];

    return {
      type: 'snapshot',
      time,
      room,
      mode,
      players: [...this.baseline.values()],
      round: {
        number: roundNumber,
        phase: roundPhase,
        phaseEndsAt: 0,
        timeLeft,
        buyEndsAt: 0,
        winner: null,
        reason: '',
      },
      bomb: {
        state: bombState,
        carrierId: null,
        x: bombX,
        y: bombY,
        z: bombZ,
        site: null,
        progress: bombProgress,
        remaining: bombRemaining,
      },
      scores: { CT: ctScore, T: tScore },
      events,
    };
  }
}
