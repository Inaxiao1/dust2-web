import test from 'node:test';
import assert from 'node:assert/strict';
import { itemsForTeam } from '../src/catalog/weapons.ts';
import { BinarySnapshotDecoder, encodeInputBinary } from '../src/net/binary-protocol.ts';
import { WasmPhysicsKernel, createBestPhysicsKernel, type PhysicsWasmExports } from '../src/physics/wasm-kernel.ts';
import { worldToRadar } from '../src/ui/radar-math.ts';

test('shop catalog filters team-exclusive weapons accurately', () => {
  const ctIds = new Set(itemsForTeam('CT').map(i => i.id));
  const tIds = new Set(itemsForTeam('T').map(i => i.id));
  assert.ok(ctIds.has('m4a1') && ctIds.has('defusekit') && !ctIds.has('ak47'));
  assert.ok(tIds.has('ak47') && tIds.has('molotov') && !tIds.has('defusekit'));
  assert.ok(ctIds.has('awp') && tIds.has('awp'));
});

test('worldToRadar maps relative player positions with optional camera rotation', () => {
  const north = worldToRadar(10, 0, 0, 0, 0, false, 160, 2);
  assert.equal(north.x, 100);
  assert.equal(north.y, 80);

  // Rotating by 90 degrees (+PI/2) rotates +X into +Z (downward on screen).
  const rotated = worldToRadar(10, 0, 0, 0, Math.PI / 2, true, 160, 2);
  assert.ok(Math.abs(rotated.x - 80) < 1e-4);
  assert.ok(Math.abs(rotated.y - 100) < 1e-4);
});

test('BinarySnapshotDecoder decodes input and server binary full+delta frames identically', async () => {
  const inputBytes = encodeInputBinary({
    seq: 11,
    forward: 1,
    right: 0,
    yaw: 0.5,
    pitch: -0.2,
    jump: true,
    crouch: false,
    walk: false,
    fire: true,
    reload: false,
    slot: 1,
    interact: false,
  });
  assert.equal(inputBytes.byteLength, 26);

  // Import server shared encoder to verify cross-boundary wire compatibility.
  const sharedCodecUrl = new URL('../../shared/binary-protocol.js', import.meta.url).href;
  const { encodeSnapshotBinary } = (await import(sharedCodecUrl)) as {
    encodeSnapshotBinary: (snap: unknown, prev: unknown) => Uint8Array;
  };
  const decoder = new BinarySnapshotDecoder();

  const fullFrame = encodeSnapshotBinary({
    time: 5000,
    room: 'WIRE01',
    mode: 'defuse',
    players: [
      { id: 'p1', name: 'One', team: 'CT', bot: false, x: 1, y: 0, z: 2, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, crouch: false, grounded: true, health: 100, armor: 100, alive: true, weapon: 'm4a1', slot: 1, ammo: 20, reserve: 60, money: 1600, kills: 1, deaths: 0, assists: 0, seq: 5, hasBomb: false },
      { id: 'p2', name: 'Two', team: 'T', bot: true, x: 5, y: 0, z: -3, vx: 0, vy: 0, vz: 0, yaw: 1, pitch: 0, crouch: false, grounded: true, health: 80, armor: 50, alive: true, weapon: 'ak47', slot: 1, ammo: 28, reserve: 90, money: 900, kills: 0, deaths: 1, assists: 0, seq: 0, hasBomb: true },
    ],
    round: { number: 2, phase: 'live', timeLeft: 88.5 },
    bomb: { state: 'carried', x: 5, y: 0, z: -3, progress: 0, remaining: 40 },
    scores: { CT: 1, T: 0 },
    events: [{ id: 1, type: 'shot', time: 5000, shooterId: 'p1' }],
  }, null);

  const decoded1 = decoder.decode(fullFrame);
  assert.ok(decoded1);
  assert.equal(decoded1.players.length, 2);
  assert.equal(decoded1.events.length, 1);

  const baselineMap = new Map(decoded1.players.map(p => [p.id, p]));
  const deltaFrame = encodeSnapshotBinary({
    time: 5066,
    room: 'WIRE01',
    mode: 'defuse',
    players: [
      { ...decoded1.players[0], x: 2.5, ammo: 19, seq: 6 },
      decoded1.players[1],
    ],
    round: { number: 2, phase: 'live', timeLeft: 88.4 },
    bomb: { state: 'carried', x: 5, y: 0, z: -3, progress: 0, remaining: 40 },
    scores: { CT: 1, T: 0 },
    events: [],
  }, baselineMap);

  const decoded2 = decoder.decode(deltaFrame);
  assert.ok(decoded2);
  assert.equal(decoded2.players.length, 2);
  assert.equal(decoded2.players.find(p => p.id === 'p1')?.ammo, 19);
  assert.equal(decoded2.players.find(p => p.id === 'p2')?.hasBomb, true);
});

test('WasmPhysicsKernel delegates over WASM ABI and createBestPhysicsKernel falls back to ts-bvh', async () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  let nextPtr = 64;
  let loadedFloats = 0;
  const fakeExports: PhysicsWasmExports = {
    memory,
    alloc(len) {
      const ptr = nextPtr;
      nextPtr += Math.ceil(len / 8) * 8;
      return ptr;
    },
    dealloc() {},
    init_collision(_ptr, floatLen) {
      loadedFloats = floatLen;
      return 1;
    },
    free_collision() {
      loadedFloats = 0;
    },
    raycast_world(_ox, oy) {
      return oy >= 0 ? oy : -1;
    },
    step_player(x, y, z, _vx, _vy, _vz, _g, forward, _r, _yaw, _jump, _crouch, _walk, dt, outPtr) {
      const out = new Float32Array(memory.buffer, outPtr, 7);
      out.set([x, y, z - forward * 5 * dt, 0, 0, -forward * 5, 1]);
    },
  };

  const wasmKernel = new WasmPhysicsKernel(fakeExports);
  wasmKernel.loadMapCollision(new Float32Array(9));
  assert.equal(loadedFloats, 9);
  assert.equal(wasmKernel.raycastWorld([0, 3, 0], [0, -1, 0], 10), 3);
  const stepped = wasmKernel.stepPlayer(
    { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, grounded: true, crouch: false },
    { forward: 1, right: 0, yaw: 0, pitch: 0, jump: false, crouch: false, walk: false },
    0.1,
  );
  assert.ok(Math.abs(stepped.z + 0.5) < 1e-4);
  wasmKernel.dispose();
  assert.equal(loadedFloats, 0);

  const fallback = await createBestPhysicsKernel({ wasmUrl: null });
  assert.equal(fallback.kind, 'ts-bvh');
  fallback.dispose();
});
