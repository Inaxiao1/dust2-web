import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { startGameServer } from '../server/index.js';
import { RULES_VERSION, ASSET_VERSION } from '../shared/online-build.js';
import {
  PACKET_SNAPSHOT_DELTA,
  PACKET_SNAPSHOT_FULL,
  decodeInputBinary,
  decodeSnapshotBinary,
  encodeInputBinary,
  encodeSnapshotBinary,
} from '../shared/binary-protocol.js';

test('binary protocol v2 codec round-trips 26-byte input and compresses delta snapshots dramatically', () => {
  const encodedInput = encodeInputBinary({
    seq: 42,
    forward: 0.75,
    right: -0.5,
    yaw: 1.25,
    pitch: -0.35,
    jump: true,
    crouch: false,
    walk: true,
    fire: true,
    reload: false,
    interact: true,
    slot: 2,
  });
  assert.equal(encodedInput.byteLength, 26);
  const decodedInput = decodeInputBinary(encodedInput);
  assert.equal(decodedInput.seq, 42);
  assert.ok(Math.abs(decodedInput.forward - 0.75) < 0.002);
  assert.ok(Math.abs(decodedInput.right + 0.5) < 0.002);
  assert.equal(decodedInput.jump, true);
  assert.equal(decodedInput.walk, true);
  assert.equal(decodedInput.fire, true);
  assert.equal(decodedInput.interact, true);
  assert.equal(decodedInput.slot, 2);

  const players = Array.from({ length: 10 }, (_, i) => ({
    id: `p_${i}`,
    name: `Player_${i}`,
    team: i < 5 ? 'CT' : 'T',
    bot: i > 0,
    x: i * 2.5,
    y: 0,
    z: -i * 1.5,
    vx: 0,
    vy: 0,
    vz: 0,
    yaw: 0.5,
    pitch: 0,
    crouch: false,
    grounded: true,
    health: 100,
    armor: 100,
    alive: true,
    weapon: i < 5 ? 'm4a1' : 'ak47',
    slot: 1,
    ammo: 30,
    reserve: 90,
    money: 800,
    kills: i,
    deaths: 0,
    assists: 1,
    seq: i,
    hasBomb: i === 5,
  }));

  const fullSnap = {
    type: 'snapshot',
    time: 1700000000000,
    room: 'BIN001',
    mode: 'defuse',
    players,
    round: { number: 3, phase: 'live', timeLeft: 95.5 },
    bomb: { state: 'carried', x: 1, y: 0, z: 2, progress: 0, remaining: 40 },
    scores: { CT: 2, T: 1 },
    events: [],
  };

  const jsonBytes = Buffer.byteLength(JSON.stringify(fullSnap));
  const fullBin = encodeSnapshotBinary(fullSnap, null);
  assert.equal(fullBin[1], PACKET_SNAPSHOT_FULL);
  assert.ok(fullBin.byteLength < jsonBytes * 0.45, `Full binary (${fullBin.byteLength}B) should be much smaller than JSON (${jsonBytes}B)`);

  const decodedFull = decodeSnapshotBinary(fullBin);
  assert.equal(decodedFull.binaryKind, 'full');
  assert.equal(decodedFull.players.length, 10);
  assert.equal(decodedFull.scores.CT, 2);

  // Move only 1 player out of 10 and encode delta.
  const nextPlayers = players.map((p, idx) => (idx === 0 ? { ...p, x: 3.25, seq: 99 } : p));
  const deltaBin = encodeSnapshotBinary({ ...fullSnap, players: nextPlayers }, decodedFull.playersMap);
  assert.equal(deltaBin[1], PACKET_SNAPSHOT_DELTA);
  assert.ok(deltaBin.byteLength < fullBin.byteLength * 0.35, `Delta (${deltaBin.byteLength}B) should be much smaller than Full (${fullBin.byteLength}B)`);

  const decodedDelta = decodeSnapshotBinary(deltaBin, decodedFull.playersMap);
  assert.equal(decodedDelta.binaryKind, 'delta');
  assert.equal(decodedDelta.players.length, 10);
  const p0 = decodedDelta.players.find(p => p.id === 'p_0');
  assert.ok(Math.abs(p0.x - 3.25) < 1e-4);
  assert.equal(p0.seq, 99);
});

test('Battle Worker serves binary v2 client and JSON v1 client simultaneously in the same room', { timeout: 15000 }, async () => {
  const app = await startGameServer({ port: 0, host: '127.0.0.1', logicOnly: true });
  const sockets = [];
  try {
    const v2Ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`);
    sockets.push(v2Ws);
    await once(v2Ws, 'open');

    const receivedBinaryFrames = [];
    let welcomeV2 = null;
    v2Ws.on('message', (data, isBinary) => {
      if (isBinary) {
        receivedBinaryFrames.push(new Uint8Array(data));
      } else {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'welcome') welcomeV2 = msg;
      }
    });

    v2Ws.send(JSON.stringify({
      type: 'join',
      name: 'BinClient',
      bots: 2,
      binaryProtocol: 2,
      rulesVersion: RULES_VERSION,
      assetVersion: ASSET_VERSION,
    }));

    await new Promise((resolve, reject) => {
      const start = Date.now();
      const poll = setInterval(() => {
        if (welcomeV2 && receivedBinaryFrames.length >= 2) {
          clearInterval(poll);
          resolve();
        } else if (Date.now() - start > 5000) {
          clearInterval(poll);
          reject(new Error('Timed out waiting for binary v2 welcome + full + delta snapshots'));
        }
      }, 30);
    });

    assert.equal(welcomeV2.binaryProtocol, 2);
    assert.equal(receivedBinaryFrames[0][1], PACKET_SNAPSHOT_FULL);
    assert.equal(receivedBinaryFrames[1][1], PACKET_SNAPSHOT_DELTA);

    const baseline = decodeSnapshotBinary(receivedBinaryFrames[0]);
    assert.equal(baseline.room, welcomeV2.room);

    // Send 26-byte binary input frame and ensure server processes seq.
    v2Ws.send(encodeInputBinary({ seq: 77, forward: 1, right: 0, yaw: 0, pitch: 0, jump: false, crouch: false, walk: false, fire: false, reload: false, interact: false, slot: 1 }));
    await new Promise(r => setTimeout(r, 140));
    const room = app.rooms.get(welcomeV2.room);
    assert.equal(room.players.get(welcomeV2.id).seq, 77);

    // Legacy JSON v1 client joins the exact same room seamlessly.
    const v1Ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`);
    sockets.push(v1Ws);
    await once(v1Ws, 'open');
    let v1JsonSnap = null;
    v1Ws.on('message', (data, isBinary) => {
      assert.equal(isBinary, false, 'v1 client must only receive JSON frames');
      const m = JSON.parse(data.toString());
      if (m.type === 'snapshot') v1JsonSnap = m;
    });
    v1Ws.send(JSON.stringify({
      type: 'join',
      room: welcomeV2.room,
      existing: true,
      name: 'LegacyJson',
      rulesVersion: RULES_VERSION,
      assetVersion: ASSET_VERSION,
    }));
    await new Promise((resolve, reject) => {
      const start = Date.now();
      const poll = setInterval(() => {
        if (v1JsonSnap) { clearInterval(poll); resolve(); }
        else if (Date.now() - start > 5000) { clearInterval(poll); reject(new Error('v1 snapshot timeout')); }
      }, 30);
    });
    assert.equal(v1JsonSnap.room, welcomeV2.room);
  } finally {
    for (const s of sockets) if (s.readyState === WebSocket.OPEN) s.terminate();
    await app.close();
  }
});
