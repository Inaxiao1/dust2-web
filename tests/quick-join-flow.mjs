import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

test('gateway exposes quick-join, cross-map room lookup, summary counts and raised default maxWorkers', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'cs-quick-join-'));
  await writeFile(path.join(root, 'catalog.json'), JSON.stringify({
    maps: [
      { id: 'de_dust2', name: 'Dust II', nameZh: '炙热沙城 II' },
      { id: 'de_mirage', name: 'Mirage', nameZh: '荒漠迷城' },
    ],
  }));
  const child = spawn(process.execPath, ['server/performance-maps.js'], {
    env: { ...process.env, PORT: '0', PERF_MAP_ROOT: root, PERF_GAME_DIST: root },
    stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
  });
  const closed = once(child, 'exit');
  t.after(async () => {
    if (child.connected) child.disconnect();
    else child.kill();
    await closed;
    await rm(root, { recursive: true, force: true });
  });
  const [output] = await once(child.stdout, 'data', { signal: AbortSignal.timeout(15000) });
  const base = output.toString().match(/http:\/\/127\.0\.0\.1:\d+\/perf\//)[0];

  const health = await fetch(base + 'health').then(r => r.json());
  assert.equal(health.ok, true);
  assert.equal(health.maxWorkers, 4);

  const rooms = await fetch(base + 'rooms.json').then(r => r.json());
  assert.deepEqual(rooms, { rooms: [], totalRooms: 0, totalHumans: 0, joinableRooms: 0 });

  const quick = await fetch(base + 'quick-join.json?mode=deathmatch&preferredMap=de_mirage').then(r => r.json());
  assert.equal(quick.action, 'create');
  assert.equal(quick.mapId, 'de_mirage');
  assert.equal(quick.mode, 'deathmatch');
  assert.equal(quick.joinUrl, '/perf/play/de_mirage/?autostart=1&matchMode=deathmatch');

  const quickDefault = await fetch(base + 'quick-join.json?mode=any&preferredMap=invalid_map').then(r => r.json());
  assert.equal(quickDefault.action, 'create');
  assert.equal(quickDefault.mapId, 'de_dust2');
  assert.equal(quickDefault.mode, 'defuse');
  assert.equal(quickDefault.joinUrl, '/perf/play/de_dust2/?autostart=1&matchMode=defuse');

  const badCode = await fetch(base + 'find-room.json?code=!!').then(r => r.json());
  assert.equal(badCode.found, false);
  assert.match(badCode.error, /房间码/);

  const missingCode = await fetch(base + 'find-room.json?code=ABCD12').then(r => r.json());
  assert.equal(missingCode.found, false);
  assert.match(missingCode.error, /未找到/);
});
