import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntimeConfig } from '../src/config/runtime.ts';
import { ControlPlaneClient, ControlPlaneError } from '../src/net/control-plane.ts';
import { GameSocketClient, type WebSocketLike } from '../src/net/game-socket.ts';
import { TSPhysicsKernel } from '../src/physics/ts-kernel.ts';

test('loadRuntimeConfig merges environment defaults with client-config.json override', async () => {
  const cfg = await loadRuntimeConfig({
    fallbackEnv: {
      VITE_CONTROL_PLANE_URL: 'https://fallback.example.com/',
      VITE_ASSET_BASE_URL: 'https://cdn.example.com/assets',
    },
    fetcher: async () =>
      Response.json({
        controlPlaneUrl: 'https://lobby.example.com/',
        mapBaseUrl: 'https://cdn.example.com/maps',
      }),
  });
  assert.deepEqual(cfg, {
    controlPlaneUrl: 'https://lobby.example.com',
    assetBaseUrl: 'https://cdn.example.com/assets/',
    mapBaseUrl: 'https://cdn.example.com/maps/',
  });

  const fallbackOnly = await loadRuntimeConfig({
    fallbackEnv: { VITE_CONTROL_PLANE_URL: 'http://127.0.0.1:8080' },
    fetcher: async () => new Response('', { status: 404 }),
  });
  assert.equal(fallbackOnly.controlPlaneUrl, 'http://127.0.0.1:8080');
});

test('ControlPlaneClient handles room listing, creation, and structured errors', async () => {
  const calls: Array<{ url: string; method?: string }> = [];
  const client = new ControlPlaneClient('https://cp.example.com/', async (url, init) => {
    calls.push({ url: String(url), method: init?.method });
    if (String(url).endsWith('/api/v1/rooms?mapId=de_mirage')) {
      return Response.json({
        rooms: [{ code: 'AB12CD', mapId: 'de_mirage', workerId: 'w1', mode: 'defuse', visibility: 'public', humans: 2, bots: 8, capacity: 10, phase: 'live', joinable: true, scores: { CT: 1, T: 0 } }],
      });
    }
    if (String(url).endsWith('/api/v1/rooms') && init?.method === 'POST') {
      return Response.json(
        { roomCode: 'NEW123', mapId: 'de_mirage', mode: 'defuse', workerId: 'w1', workerWsUrl: 'wss://w1.example.com/ws', joinToken: 'v2.abc.def', expiresAt: 9999999999 },
        { status: 201 },
      );
    }
    return Response.json({ ok: false, code: 'ROOM_GONE', message: 'room does not exist' }, { status: 404 });
  });

  const rooms = await client.listRooms('de_mirage');
  assert.equal(rooms.length, 1);
  assert.equal(rooms[0].code, 'AB12CD');

  const created = await client.createRoom({ mapId: 'de_mirage', mode: 'defuse', visibility: 'public', playerName: 'Tester' });
  assert.equal(created.roomCode, 'NEW123');
  assert.equal(created.joinToken, 'v2.abc.def');

  await assert.rejects(client.joinRoom('GONE99', 'Tester'), err => {
    assert.ok(err instanceof ControlPlaneError);
    assert.equal(err.code, 'ROOM_GONE');
    assert.equal(err.status, 404);
    return true;
  });
});

test('GameSocketClient attaches token on handshake, sends join payload, and forwards welcome/snapshot', () => {
  let createdUrl = '';
  const sent: Array<string | Uint8Array | ArrayBuffer> = [];
  let fakeWs!: WebSocketLike;
  let welcomedRoom = '';
  let lastSnapshotTime = 0;

  const client = new GameSocketClient(
    {
      onWelcome: w => { welcomedRoom = w.room; },
      onSnapshot: s => { lastSnapshotTime = s.time; },
    },
    url => {
      createdUrl = url;
      fakeWs = {
        readyState: 1,
        send: data => { sent.push(data); },
        close: () => { fakeWs.readyState = 3; },
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
      };
      return fakeWs;
    },
  );

  client.connectWithTicket(
    {
      roomCode: 'XYZ789',
      mapId: 'de_dust2',
      mode: 'defuse',
      workerId: 'w1',
      workerWsUrl: 'wss://node-1.example.com/ws',
      joinToken: 'v2.payload.sig',
      expiresAt: 9999999999,
    },
    { playerName: 'Alice', bots: 6 },
  );

  assert.equal(createdUrl, 'wss://node-1.example.com/ws?token=v2.payload.sig');
  fakeWs.onopen?.({});
  assert.equal(sent.length, 1);
  assert.equal(typeof sent[0], 'string');
  const joinFrame = JSON.parse(sent[0] as string);
  assert.equal(joinFrame.type, 'join');
  assert.equal(joinFrame.room, 'XYZ789');
  assert.equal(joinFrame.joinToken, 'v2.payload.sig');

  fakeWs.onmessage?.({ data: JSON.stringify({ type: 'welcome', id: 'p1', room: 'XYZ789', mode: 'defuse', team: 'CT', tickRate: 30, snapshotRate: 15, serverTime: 100, protocol: 1 }) });
  assert.equal(welcomedRoom, 'XYZ789');

  fakeWs.onmessage?.({ data: JSON.stringify({ type: 'snapshot', time: 12345, room: 'XYZ789', mode: 'defuse', players: [], round: { number: 1, phase: 'live', phaseEndsAt: 0, timeLeft: 100, buyEndsAt: 0, winner: null, reason: '' }, bomb: { state: 'none', carrierId: null, x: 0, y: 0, z: 0, site: null, progress: 0, remaining: 0 }, scores: { T: 0, CT: 0 }, events: [] }) });
  assert.equal(lastSnapshotTime, 12345);
});

test('TSPhysicsKernel builds BVH collision, raycasts ground, and steps jump physics', () => {
  const kernel = new TSPhysicsKernel();
  // Two triangles forming a 20x20 ground plane at y=0.
  const ground = new Float32Array([
    -10, 0, -10,  10, 0, -10,  10, 0, 10,
    -10, 0, -10,  10, 0, 10,  -10, 0, 10,
  ]);
  kernel.loadMapCollision(ground);

  const hit = kernel.raycastWorld([0, 2, 0], [0, -1, 0], 5);
  assert.ok(hit !== null && Math.abs(hit - 2) < 1e-4);
  assert.equal(kernel.raycastWorld([0, 2, 0], [0, 1, 0], 5), null);

  let state = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, grounded: true, crouch: false };
  state = kernel.stepPlayer(state, { forward: 1, right: 0, yaw: 0, pitch: 0, jump: true, crouch: false, walk: false }, 1 / 30);
  assert.equal(state.grounded, false);
  assert.ok(state.z < 0, 'yaw=0 forward moves toward -Z');
  assert.ok(state.y > 0 && state.vy > 0, 'jump adds upward velocity');
  kernel.dispose();
});
