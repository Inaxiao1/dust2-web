import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {
  getStaticRuntime,
  gameApiURL,
  lobbyHref,
  matchHref,
  parseMatchRoute,
  resolveStaticAsset,
  resolveStaticMapFile,
  maybeGunzipResponse,
} from '../shared/static-runtime.js';

test('static-runtime stays transparent (null) when not in Toy/CDN static mode', () => {
  delete globalThis.__CS2_STATIC_RUNTIME__;
  assert.equal(getStaticRuntime(), null);
  assert.equal(gameApiURL('/perf/rooms.json'), '/perf/rooms.json');
  assert.equal(lobbyHref(), '/perf/');
  assert.equal(matchHref('de_dust2', 'autostart=1'), '/perf/play/de_dust2/?autostart=1');
  assert.deepEqual(parseMatchRoute('https://game.example.com/perf/play/de_mirage/?autostart=1'), {
    mapId: 'de_mirage',
    quality: false,
    isStaticPlay: false,
  });
});

test('static-runtime routes Toy-bundled assets/maps locally (.gz) and spills optional packs to external CDN with zero server hits', async () => {
  globalThis.__CS2_STATIC_RUNTIME__ = {
    gameServerOrigin: 'https://ws.example.com',
    assetBaseURL: 'https://cdn.example.com/assets/',
    mapBaseURL: 'https://cdn.example.com/maps/',
    bundledAssets: ['assets/audio/cs2/ak47.mp3'],
    bundledGzAssets: ['assets/viewmodel/animations.glb'],
    bundledMaps: ['de_dust2', 'de_mirage'],
    bundledMapsGz: true,
  };
  try {
    const rt = getStaticRuntime();
    assert.equal(rt.gameServerOrigin, 'https://ws.example.com');
    assert.equal(gameApiURL('/perf/rooms.json'), 'https://ws.example.com/perf/rooms.json');
    assert.equal(lobbyHref('?map=de_mirage'), './?map=de_mirage');
    assert.equal(matchHref('de_dust2', 'autostart=1'), './play.html?autostart=1&map=de_dust2');
    assert.deepEqual(parseMatchRoute('https://toy.bilibilitoy.com/app/play.html?map=de_dust2&autostart=1'), {
      mapId: 'de_dust2',
      quality: false,
      isStaticPlay: true,
    });

    const pageBase = 'https://toy.bilibilitoy.com/app/play.html';
    // Bundled raw asset stays on Toy
    const sfx = resolveStaticAsset('assets/audio/cs2/ak47.mp3', pageBase);
    assert.equal(sfx.source, 'toy');
    assert.equal(sfx.gz, false);
    assert.equal(sfx.url.href, 'https://toy.bilibilitoy.com/app/assets/audio/cs2/ak47.mp3');

    // Bundled gzipped GLB stays on Toy with .gz suffix
    const anim = resolveStaticAsset('assets/viewmodel/animations.glb', pageBase);
    assert.equal(anim.source, 'toy');
    assert.equal(anim.gz, true);
    assert.equal(anim.url.href, 'https://toy.bilibilitoy.com/app/assets/viewmodel/animations.glb.gz');

    // Optional skin NOT in Toy spills directly to external CDN
    const skin = resolveStaticAsset('assets/weapons/cs2-skins/popular/ak47-slate.glb', pageBase);
    assert.equal(skin.source, 'cdn');
    assert.equal(skin.gz, false);
    assert.equal(skin.url.href, 'https://cdn.example.com/assets/weapons/cs2-skins/popular/ak47-slate.glb');

    // Bundled map routes to Toy local .gz
    const d2Mesh = resolveStaticMapFile('de_dust2', 'render/map.mgp', pageBase);
    assert.equal(d2Mesh.source, 'toy');
    assert.equal(d2Mesh.gz, true);
    assert.equal(d2Mesh.url.href, 'https://toy.bilibilitoy.com/app/maps/de_dust2/render/map.mgp.gz');

    const d2Phys = resolveStaticMapFile('de_dust2', 'physics.vidx', pageBase);
    assert.equal(d2Phys.url.href, 'https://toy.bilibilitoy.com/app/maps/de_dust2/compiled/physics.vidx.gz');

    // Non-bundled map spills to external CDN
    const infMesh = resolveStaticMapFile('de_inferno', 'render/map.mgp', pageBase);
    assert.equal(infMesh.source, 'cdn');
    assert.equal(infMesh.gz, false);
    assert.equal(infMesh.url.href, 'https://cdn.example.com/maps/de_inferno/render/map.mgp');

    // Transparent 0x1f 0x8b auto-gunzip works bit-for-bit AND passes already-raw responses untouched
    const sample = Buffer.from('MGP1-exact-test-payload-0123456789');
    const gzBytes = zlib.gzipSync(sample);
    const gunzipped = await maybeGunzipResponse(new Response(gzBytes, { status: 200 }));
    assert.deepEqual(Buffer.from(await gunzipped.arrayBuffer()), sample);

    const passthrough = await maybeGunzipResponse(new Response(sample, {
      status: 200,
      headers: { 'content-encoding': 'gzip', 'content-length': '12' },
    }));
    assert.equal(passthrough.headers.get('content-encoding'), null);
    assert.equal(passthrough.headers.get('content-length'), String(sample.byteLength));
    assert.deepEqual(Buffer.from(await passthrough.arrayBuffer()), sample);

    // Bilibili Toy CDN allowlist mode: custom map binary extensions (.mgp/.vidx/.u8) append .glb before .gz
    globalThis.__CS2_STATIC_RUNTIME__ = {
      ...globalThis.__CS2_STATIC_RUNTIME__,
      bundledMapsBinExt: '.glb',
    };
    assert.equal(
      resolveStaticMapFile('de_dust2', 'render/map.mgp', pageBase).url.href,
      'https://toy.bilibilitoy.com/app/maps/de_dust2/render/map.mgp.glb.gz',
    );
    assert.equal(
      resolveStaticMapFile('de_dust2', 'physics.vidx', pageBase).url.href,
      'https://toy.bilibilitoy.com/app/maps/de_dust2/compiled/physics.vidx.glb.gz',
    );
    assert.equal(
      resolveStaticMapFile('de_dust2', 'physics-mask.u8', pageBase).url.href,
      'https://toy.bilibilitoy.com/app/maps/de_dust2/compiled/physics-mask.u8.glb.gz',
    );
    assert.equal(
      resolveStaticMapFile('de_dust2', 'map.json', pageBase).url.href,
      'https://toy.bilibilitoy.com/app/maps/de_dust2/compiled/map.json.gz',
    );
  } finally {
    delete globalThis.__CS2_STATIC_RUNTIME__;
  }
});
