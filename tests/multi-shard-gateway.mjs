import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket} from 'ws';

const repo = fileURLToPath(new URL('../', import.meta.url));
const packs = process.env.PERF_MAP_ROOT || path.join(repo, 'artifacts/performance-maps/maps-v1');
const installed = existsSync(path.join(packs, 'de_dust2', 'compiled/map.json'));

test('multi-shard hot-map gateway transparently scales rooms across workers and routes public, private, cosmetics, and reconnect joins', {skip: !installed, timeout: 120000}, async t => {
  const gateway = spawn(process.execPath, ['server/performance-maps.js'], {
    cwd: repo,
    env: {
      ...process.env,
      PORT: '0',
      PERF_MAP_ROOT: packs,
      PERF_MAX_WORKERS: '6',
      PERF_SHARD_MAPS: 'de_dust2:3',
      PERF_SHARD_TARGET_ROOMS: '2',
      PERF_STRICT_HEAVY_LOCK: '0',
      PERF_RTC_UDP_PORT: '39999',
      PERF_RTC_PUBLIC_IP: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
    windowsHide: true,
  });
  const exited = once(gateway, 'exit');
  const sockets = new Set();
  t.after(async () => {
    for (const s of sockets) s.terminate();
    if (gateway.connected) gateway.disconnect();
    await exited;
  });

  let log = '', origin;
  while (!origin) {
    const [chunk] = await once(gateway.stdout, 'data', {signal: AbortSignal.timeout(20000)});
    log += chunk;
    origin = log.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  }
  const get = async url => {
    const res = await fetch(origin + url, {signal: AbortSignal.timeout(75000)});
    assert.equal(res.status, 200, url);
    return res.json();
  };
  const config = await get('/perf/play/de_dust2/private-map.json');
  assert.equal(config.rtcEnabled, false);
  const wsUrl = origin.replace('http:', 'ws:') + '/perf/play/de_dust2/ws';
  for (const prefix of ['/perf/play/', '/perf/quality/play/']) {
    const offer = await fetch(origin + prefix + 'de_dust2/rtc-offer', {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(offer.status, 404);
    assert.equal((await offer.json()).error, 'RTC_DISABLED');
  }

  async function openWs() {
    const ws = new WebSocket(wsUrl);
    sockets.add(ws);
    await once(ws, 'open', {signal: AbortSignal.timeout(10000)});
    return ws;
  }
  async function rpc(ws, payload) {
    const next = once(ws, 'message', {signal: AbortSignal.timeout(15000)});
    ws.send(JSON.stringify(payload));
    const [raw] = await next;
    return JSON.parse(raw.toString());
  }
  async function joinRoom(options, expected = 'welcome') {
    const ws = await openWs();
    const reply = await rpc(ws, {
      type: 'join',
      mapId: config.id,
      mapSignature: config.mapSignature,
      bots: 0,
      mode: 'deathmatch',
      reconnect: true,
      ...options,
    });
    assert.equal(reply.type, expected, JSON.stringify(reply));
    return {ws, reply};
  }
  async function leave(ws) {
    const closed = once(ws, 'close', {signal: AbortSignal.timeout(5000)});
    ws.close(1000, 'bye');
    await closed;
    sockets.delete(ws);
  }

  // Create 5 public rooms sequentially -> target 2/shard -> must fan out across all 3 shards!
  const hosts = [];
  for (let i = 0; i < 5; i++) {
    hosts.push(await joinRoom({name: `Host${i}`, room: `SHRD0${i}`}));
  }

  const health = await get('/perf/health');
  assert.deepEqual(health.rtc, {enabled: false});
  const dustShards = health.workers.filter(w => w.id === 'de_dust2');
  assert.equal(dustShards.length, 3, `Expected 3 de_dust2 shards, got ${JSON.stringify(dustShards)}`);
  assert.ok(dustShards.every(w => w.connections >= 1), `Every shard should hold >= 1 room: ${JSON.stringify(dustShards)}`);
  assert.equal(dustShards.reduce((n, w) => n + w.connections, 0), 5);

  // /perf/rooms.json must merge all 5 rooms cleanly across all 3 shards.
  let dir;
  for (let i = 0; i < 40; i++) {
    dir = await get('/perf/rooms.json');
    if (dir.totalRooms === 5) break;
    await delay(50);
  }
  assert.equal(dir.totalRooms, 5);
  assert.equal(dir.totalHumans, 5);
  const {network} = await get('/perf/internal/telemetry.json');
  assert.equal(network.ws, 5);
  assert.equal(network.udp, 0);

  // Pre-join ping and listRooms work over WS on sharded maps.
  const probeWs = await openWs();
  const pong = await rpc(probeWs, {type: 'ping', time: 12345});
  assert.equal(pong.type, 'pong');
  assert.equal(pong.time, 12345);
  const listed = await rpc(probeWs, {type: 'listRooms'});
  assert.equal(listed.type, 'rooms');
  assert.equal(listed.rooms.length, 5);
  await leave(probeWs);

  // roomCosmetics + existing join to the 5th room (on shard 2) routes to the exact shard!
  const targetCode = hosts[4].reply.room;
  const cosmWs = await openWs();
  const cosm = await rpc(cosmWs, {type: 'roomCosmetics', room: targetCode});
  assert.equal(cosm.type, 'roomCosmetics');
  assert.equal(cosm.room, targetCode);
  await leave(cosmWs);

  const guest = await joinRoom({name: 'Guest4', room: targetCode, existing: true, snapshotDelta: 1, ackDelta: 1});
  assert.equal(guest.reply.room, targetCode);
  const snapshotSignal = AbortSignal.timeout(5000);
  let baseSid = null;
  while (true) {
    const [raw] = await once(guest.ws, 'message', {signal: snapshotSignal});
    const frame = JSON.parse(raw.toString());
    if (baseSid === null && frame.type === 'snapshot' && Number.isInteger(frame.sid)) {
      baseSid = frame.sid;
      guest.ws.send(JSON.stringify({type: 'snapAck', ackSid: baseSid}));
    }
    if (frame.type === 'snapshotDelta') {
      assert.equal(frame.baseSid, baseSid);
      assert.ok(frame.sid > baseSid);
      break;
    }
  }

  // Private room on a sharded map: hidden from /perf/rooms.json, but friend joins by code!
  const privHost = await joinRoom({name: 'PrivHost', room: 'PRIV99', visibility: 'private'});
  const privGuest = await joinRoom({name: 'PrivGuest', room: 'PRIV99', existing: true});
  assert.equal(privGuest.reply.room, 'PRIV99');
  const dirAfterPriv = await get('/perf/rooms.json');
  assert.equal(dirAfterPriv.rooms.some(r => r.code === 'PRIV99'), false);

  // Non-existent room with existing: true still returns ROOM_GONE.
  const gone = await joinRoom({name: 'Late', room: 'NOPE99', existing: true}, 'error');
  assert.equal(gone.reply.code, 'ROOM_GONE');
  await leave(gone.ws);

  // Abnormal disconnect + reconnect with resumeToken routes back to the exact same shard & session!
  const savedToken = privGuest.reply.resumeToken;
  privGuest.ws.terminate();
  sockets.delete(privGuest.ws);
  await delay(100);
  const resumed = await joinRoom({name: 'PrivGuest', room: 'PRIV99', existing: true, resumeToken: savedToken});
  assert.equal(resumed.reply.resumed, true);
  assert.equal(resumed.reply.room, 'PRIV99');

  await Promise.all([...hosts.map(h => leave(h.ws)), leave(guest.ws), leave(privHost.ws), leave(resumed.ws)]);
});
