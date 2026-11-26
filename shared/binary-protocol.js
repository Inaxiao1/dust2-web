export const BINARY_PROTOCOL_VERSION = 2;
export const PACKET_INPUT = 1;
export const PACKET_SNAPSHOT_FULL = 2;
export const PACKET_SNAPSHOT_DELTA = 3;

const PHASE_TO_CODE = { waiting: 0, freeze: 1, live: 2, ended: 3 };
const CODE_TO_PHASE = ['waiting', 'freeze', 'live', 'ended'];
const BOMB_TO_CODE = { none: 0, carried: 1, dropped: 2, planted: 3, exploded: 4, defused: 5 };
const CODE_TO_BOMB = ['none', 'carried', 'dropped', 'planted', 'exploded', 'defused'];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeInputBinary(input) {
  const buf = new ArrayBuffer(26);
  const view = new DataView(buf);
  view.setUint8(0, BINARY_PROTOCOL_VERSION);
  view.setUint8(1, PACKET_INPUT);
  view.setUint32(2, input.seq >>> 0, true);
  view.setInt16(6, Math.round(Math.max(-1, Math.min(1, input.forward || 0)) * 1000), true);
  view.setInt16(8, Math.round(Math.max(-1, Math.min(1, input.right || 0)) * 1000), true);
  view.setFloat32(10, Number.isFinite(input.yaw) ? input.yaw : 0, true);
  view.setFloat32(14, Number.isFinite(input.pitch) ? input.pitch : 0, true);
  let flags = 0;
  if (input.jump) flags |= 1;
  if (input.crouch) flags |= 2;
  if (input.walk) flags |= 4;
  if (input.fire) flags |= 8;
  if (input.reload) flags |= 16;
  if (input.interact) flags |= 32;
  if (input.fire2) flags |= 64;
  view.setUint16(18, flags, true);
  view.setUint8(20, Math.max(0, Math.min(5, input.slot || 0)));
  return new Uint8Array(buf);
}

export function decodeInputBinary(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.byteLength < 26) return null;
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (view.getUint8(0) !== BINARY_PROTOCOL_VERSION || view.getUint8(1) !== PACKET_INPUT) return null;
  const flags = view.getUint16(18, true);
  return {
    type: 'input',
    seq: view.getUint32(2, true),
    forward: view.getInt16(6, true) / 1000,
    right: view.getInt16(8, true) / 1000,
    yaw: view.getFloat32(10, true),
    pitch: view.getFloat32(14, true),
    jump: Boolean(flags & 1),
    crouch: Boolean(flags & 2),
    walk: Boolean(flags & 4),
    fire: Boolean(flags & 8),
    reload: Boolean(flags & 16),
    interact: Boolean(flags & 32),
    fire2: Boolean(flags & 64),
    slot: view.getUint8(20),
  };
}

function playerChanged(a, b) {
  if (!b) return true;
  return (
    Math.abs((a.x || 0) - (b.x || 0)) > 0.002 ||
    Math.abs((a.y || 0) - (b.y || 0)) > 0.002 ||
    Math.abs((a.z || 0) - (b.z || 0)) > 0.002 ||
    Math.abs((a.yaw || 0) - (b.yaw || 0)) > 0.002 ||
    Math.abs((a.pitch || 0) - (b.pitch || 0)) > 0.002 ||
    a.health !== b.health ||
    a.armor !== b.armor ||
    a.alive !== b.alive ||
    a.crouch !== b.crouch ||
    a.grounded !== b.grounded ||
    a.weapon !== b.weapon ||
    a.ammo !== b.ammo ||
    a.reserve !== b.reserve ||
    a.money !== b.money ||
    a.kills !== b.kills ||
    a.deaths !== b.deaths ||
    a.assists !== b.assists ||
    a.hasBomb !== b.hasBomb ||
    a.team !== b.team ||
    a.seq !== b.seq
  );
}

export function encodeSnapshotBinary(snapshot, prevPlayersMap = null) {
  const isDelta = prevPlayersMap instanceof Map;
  const currentIds = new Set();
  const changed = [];
  const removed = [];

  for (const p of snapshot.players || []) {
    currentIds.add(p.id);
    if (!isDelta || playerChanged(p, prevPlayersMap.get(p.id))) {
      changed.push(p);
    }
  }
  if (isDelta) {
    for (const oldId of prevPlayersMap.keys()) {
      if (!currentIds.has(oldId)) removed.push(oldId);
    }
  }

  const roomBytes = encoder.encode(String(snapshot.room || ''));
  const eventsBytes = snapshot.events?.length ? encoder.encode(JSON.stringify(snapshot.events)) : new Uint8Array(0);
  const encodedPlayers = changed.map(p => ({
    p,
    id: encoder.encode(String(p.id || '')),
    name: encoder.encode(String(p.name || '')),
    weapon: encoder.encode(String(p.weapon || '')),
  }));
  const encodedRemoved = removed.map(id => encoder.encode(String(id)));

  let totalBytes = 44 + 1 + roomBytes.length + 4 + eventsBytes.length;
  for (const ep of encodedPlayers) {
    totalBytes += 1 + ep.id.length + 1 + ep.name.length + 1 + ep.weapon.length + 1 + 50;
  }
  for (const er of encodedRemoved) {
    totalBytes += 1 + er.length;
  }

  const out = new Uint8Array(totalBytes);
  const view = new DataView(out.buffer);
  view.setUint8(0, BINARY_PROTOCOL_VERSION);
  view.setUint8(1, isDelta ? PACKET_SNAPSHOT_DELTA : PACKET_SNAPSHOT_FULL);
  view.setUint16(2, 0, true);
  view.setFloat64(4, Number(snapshot.time) || 0, true);
  view.setUint8(12, Math.min(255, snapshot.scores?.CT || 0));
  view.setUint8(13, Math.min(255, snapshot.scores?.T || 0));
  view.setUint8(14, Math.min(255, snapshot.round?.number || 0));
  view.setUint8(15, PHASE_TO_CODE[snapshot.round?.phase] ?? 0);
  view.setFloat32(16, Number(snapshot.round?.timeLeft) || 0, true);
  view.setUint8(20, BOMB_TO_CODE[snapshot.bomb?.state] ?? 0);
  view.setUint8(21, encodedPlayers.length);
  view.setUint8(22, encodedRemoved.length);
  view.setUint8(23, snapshot.mode === 'deathmatch' ? 1 : 0);
  view.setFloat32(24, Number(snapshot.bomb?.x) || 0, true);
  view.setFloat32(28, Number(snapshot.bomb?.y) || 0, true);
  view.setFloat32(32, Number(snapshot.bomb?.z) || 0, true);
  view.setFloat32(36, Number(snapshot.bomb?.progress) || 0, true);
  view.setFloat32(40, Number(snapshot.bomb?.remaining) || 0, true);

  let offset = 44;
  out[offset++] = roomBytes.length;
  out.set(roomBytes, offset);
  offset += roomBytes.length;

  for (const { p, id, name, weapon } of encodedPlayers) {
    out[offset++] = id.length;
    out.set(id, offset);
    offset += id.length;
    out[offset++] = name.length;
    out.set(name, offset);
    offset += name.length;
    out[offset++] = weapon.length;
    out.set(weapon, offset);
    offset += weapon.length;

    let bits = 0;
    if (p.team === 'T') bits |= 1;
    if (p.bot) bits |= 2;
    if (p.alive) bits |= 4;
    if (p.crouch) bits |= 8;
    if (p.grounded) bits |= 16;
    if (p.hasBomb) bits |= 32;
    out[offset++] = bits;

    view.setFloat32(offset, p.x || 0, true); offset += 4;
    view.setFloat32(offset, p.y || 0, true); offset += 4;
    view.setFloat32(offset, p.z || 0, true); offset += 4;
    view.setFloat32(offset, p.vx || 0, true); offset += 4;
    view.setFloat32(offset, p.vy || 0, true); offset += 4;
    view.setFloat32(offset, p.vz || 0, true); offset += 4;
    view.setFloat32(offset, p.yaw || 0, true); offset += 4;
    view.setFloat32(offset, p.pitch || 0, true); offset += 4;
    view.setUint8(offset++, Math.max(0, Math.min(255, Math.round(p.health || 0))));
    view.setUint8(offset++, Math.max(0, Math.min(255, Math.round(p.armor || 0))));
    view.setUint8(offset++, Math.max(0, Math.min(255, p.slot || 0)));
    view.setUint8(offset++, Math.max(0, Math.min(255, p.ammo || 0)));
    view.setUint16(offset, Math.max(0, Math.min(65535, p.reserve || 0)), true); offset += 2;
    view.setUint16(offset, Math.max(0, Math.min(65535, Math.round(p.money || 0))), true); offset += 2;
    view.setUint16(offset, Math.max(0, Math.min(65535, p.kills || 0)), true); offset += 2;
    view.setUint16(offset, Math.max(0, Math.min(65535, p.deaths || 0)), true); offset += 2;
    view.setUint16(offset, Math.max(0, Math.min(65535, p.assists || 0)), true); offset += 2;
    view.setUint32(offset, (p.seq || 0) >>> 0, true); offset += 4;
  }

  for (const er of encodedRemoved) {
    out[offset++] = er.length;
    out.set(er, offset);
    offset += er.length;
  }

  view.setUint32(offset, eventsBytes.length, true);
  offset += 4;
  if (eventsBytes.length > 0) {
    out.set(eventsBytes, offset);
  }
  return out;
}

export function decodeSnapshotBinary(bytes, baselinePlayers = new Map()) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
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

  const playersMap = isDelta ? new Map(baselinePlayers) : new Map();
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

    playersMap.set(id, {
      id, name, weapon,
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
    playersMap.delete(removedId);
  }

  const eventsLen = view.getUint32(offset, true);
  offset += 4;
  let events = [];
  if (eventsLen > 0) {
    events = JSON.parse(decoder.decode(u8.subarray(offset, offset + eventsLen)));
  }

  return {
    type: 'snapshot',
    binaryKind: isDelta ? 'delta' : 'full',
    time,
    room,
    mode,
    players: [...playersMap.values()],
    playersMap,
    round: { number: roundNumber, phase: roundPhase, phaseEndsAt: 0, timeLeft, buyEndsAt: 0, winner: null, reason: '' },
    bomb: { state: bombState, carrierId: null, x: bombX, y: bombY, z: bombZ, site: null, progress: bombProgress, remaining: bombRemaining },
    scores: { CT: ctScore, T: tScore },
    events,
  };
}
