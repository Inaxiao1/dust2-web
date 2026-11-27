/**
 * Stages a slim, production-ready deployment tree at artifacts/deploy/slim-release/
 * suitable for fast rsync to a remote test server (e.g. kunming:/opt/cs2-web/).
 *
 * Slimming rules (zero loss of gameplay, maps, weapons, skins, agents, or audio):
 *  - Excludes offline source map artifacts: physics.f32 (311M), map.bin (85M), map.gltf, raw nav.json/navigation-audit.json
 *  - Keeps compact 9-map runtime: map.mgp.br/.gz + physics.vidx.br/.gz + compiled/*.br + radars + manifests (~140 MB w/ .gz or ~70 MB .br-only)
 *  - For dist/assets/:
 *      * Keeps .br + .gz for hot web JS/CSS/JSON/SVG bundles (zero runtime CPU for both HTTP & HTTPS!)
 *      * Keeps .br-only for large binary .glb/.bin/.f32 assets that have a smaller .br sidecar
 *        (server/performance-maps.js serves .br directly over HTTPS and streams .br->gzip over plain HTTP!)
 *      * Keeps non-compressible .webp/.mp3/.ogg/.png/.hdr/.html raw
 *  - Excludes redundant raw public/ copy (symlinks public -> dist on target, or keeps only minimal server refs)
 *  - Includes only production node_modules (three, three-mesh-bvh, ws)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'artifacts', 'deploy', 'slim-release');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let totalBytes = 0;
let totalFiles = 0;

function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  totalBytes += fs.statSync(dst).size;
  totalFiles++;
}

function copyTree(srcDir, dstDir, filter = null) {
  if (!fs.existsSync(srcDir)) return;
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, entry.name);
    const d = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      copyTree(s, d, filter);
    } else if (!filter || filter(s, entry.name)) {
      copyFile(s, d);
    }
  }
}

// 1. Server, shared, minimal client/scripts runtime modules, package.json, prod node_modules
copyFile(path.join(ROOT, 'package.json'), path.join(OUT, 'package.json'));
copyTree(path.join(ROOT, 'server'), path.join(OUT, 'server'));
copyTree(path.join(ROOT, 'shared'), path.join(OUT, 'shared'));
copyFile(path.join(ROOT, 'client', 'compact-map-codec.js'), path.join(OUT, 'client', 'compact-map-codec.js'));
copyFile(path.join(ROOT, 'scripts', 'maps', 'load-private-physics.mjs'), path.join(OUT, 'scripts', 'maps', 'load-private-physics.mjs'));
copyFile(path.join(ROOT, 'scripts', 'maps', 'navigation-movement.mjs'), path.join(OUT, 'scripts', 'maps', 'navigation-movement.mjs'));
copyFile(path.join(ROOT, 'scripts', 'maps', 'transport-schema.mjs'), path.join(OUT, 'scripts', 'maps', 'transport-schema.mjs'));
copyTree(path.join(ROOT, 'scripts', 'maps', 'mode-ui'), path.join(OUT, 'scripts', 'maps', 'mode-ui'));
copyTree(path.join(ROOT, 'scripts', 'maps', 'mode-previews'), path.join(OUT, 'scripts', 'maps', 'mode-previews'));
for (const pkg of ['three', 'three-mesh-bvh', 'ws']) {
  copyTree(path.join(ROOT, 'node_modules', pkg), path.join(OUT, 'node_modules', pkg));
}

// 2. Slim dist/ (keep .html raw; keep .br + .gz for small/hot web assets; keep .br-only for huge binary .glb/.bin/.f32!)
const HUGE_BR_ONLY_EXTS = new Set(['.glb', '.bin', '.f32']);
function copySlimDist(srcDir, dstDir) {
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, entry.name);
    const d = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      // Skip legacy unused Dust2 desktop/mobile 139M+23M packs? No, keep map-cs2/map-mobile slimmed via .br-only!
      copySlimDist(s, d);
      continue;
    }
    const name = entry.name;
    // Skip .gz for huge binary files that already have .br (saves ~240 MB disk!)
    if (name.endsWith('.gz')) {
      const orig = s.slice(0, -3);
      const origExt = path.extname(orig).toLowerCase();
      if (HUGE_BR_ONLY_EXTS.has(origExt) && fs.existsSync(orig + '.br')) continue;
      copyFile(s, d);
      continue;
    }
    if (name.endsWith('.br')) {
      copyFile(s, d);
      continue;
    }
    const ext = path.extname(name).toLowerCase();
    // If a huge binary asset (.glb/.bin/.f32) has a smaller .br sidecar, ship ONLY .br (zero duplicate raw copy!)
    if (HUGE_BR_ONLY_EXTS.has(ext) && fs.existsSync(s + '.br')) {
      continue;
    }
    // For JS/CSS/SVG/JSON > 16KB that have BOTH .br and .gz, skip raw duplicate (HTML & small manifests stay raw)
    if (['.js', '.css', '.svg'].includes(ext) && fs.existsSync(s + '.br') && fs.existsSync(s + '.gz')) {
      continue;
    }
    copyFile(s, d);
  }
}
copySlimDist(path.join(ROOT, 'dist'), path.join(OUT, 'dist'));

// 3. Slim 9-map performance runtime (map.mgp.br/.gz + physics.vidx.br/.gz + .br compiled metadata — NO 311M physics.f32 or 85M map.bin!)
const MAPS_SRC = path.join(ROOT, 'artifacts', 'performance-maps', 'maps-v1');
const MAPS_DST = path.join(OUT, 'artifacts', 'performance-maps', 'maps-v1');
copyFile(path.join(MAPS_SRC, 'catalog.json'), path.join(MAPS_DST, 'catalog.json'));
copyTree(path.join(MAPS_SRC, 'radars'), path.join(MAPS_DST, 'radars'));

for (const mapId of fs.readdirSync(MAPS_SRC).sort()) {
  const mSrc = path.join(MAPS_SRC, mapId);
  if (!fs.statSync(mSrc).isDirectory() || !mapId.startsWith('de_')) continue;
  const mDst = path.join(MAPS_DST, mapId);
  const files = [
    'READY.json',
    'compact-manifest.json',
    'render-manifest.json',
    'flat-breakables.json',
    'entity-collision-policy.json.br',
    'entity-collision-policy.json.gz',
    'navigation-audit.json.br',
    'compiled/map.json.br',
    'compiled/map.json.gz',
    'compiled/nav.json.br',
    'compiled/nav.json.gz',
    'compiled/physics.vidx.br',
    'compiled/physics.vidx.gz',
    'compiled/physics-mask.u8.br',
    'compiled/physics-mask.u8.gz',
    'compiled/physics-groups.json.br',
    'compiled/physics-groups.json.gz',
    'render/map.mgp.br',
    'render/map.mgp.gz',
  ];
  for (const rel of files) {
    const full = path.join(mSrc, rel);
    if (fs.existsSync(full)) copyFile(full, path.join(mDst, rel));
  }
}

console.log(`[stage-slim] Staged ${totalFiles} files into ${OUT}: ${(totalBytes / 1e6).toFixed(1)} MB total!`);
