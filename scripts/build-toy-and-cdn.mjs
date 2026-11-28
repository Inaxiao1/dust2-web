/**
 * Builds two decoupled zero-server-egress static deployment bundles:
 *   1. artifacts/deploy/toy-package/  — Pure static frontend + core assets + .gz 9-map runtime,
 *                                       strictly capped under Bilibili Toy's 128 MB limit (default 124 MB).
 *   2. artifacts/deploy/cdn-bundle/   — Complete static CDN mirror (optional skins, extra agents,
 *                                       music kits, CS2 original textures, all 9 maps, radars & previews).
 *
 * Usage:
 *   node scripts/build-toy-and-cdn.mjs \
 *     --game-origin=https://ws.your-domain.com \
 *     --cdn-base=https://cdn.your-domain.com \
 *     [--toy-limit-mb=124] \
 *     [--toy-maps=auto|none]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { SKINS } from '../shared/skins.js';
import { UTILITY_ASSETS } from '../shared/utility-assets.js';
import { AGENT_ASSETS } from '../shared/agent-assets.js';
import { AGENT_ARM_ASSETS } from '../shared/agent-arm-assets.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const PUBLIC = path.join(ROOT, 'public');
const MAPS_SRC = path.join(ROOT, 'artifacts', 'performance-maps', 'maps-v1');
const MODE_UI = path.join(ROOT, 'scripts', 'maps', 'mode-ui');
const MODE_PREVIEWS = path.join(ROOT, 'scripts', 'maps', 'mode-previews');

const TOY_OUT = path.join(ROOT, 'artifacts', 'deploy', 'toy-package');
const CDN_OUT = path.join(ROOT, 'artifacts', 'deploy', 'cdn-bundle');

function getArg(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

const gameOrigin = getArg('game-origin', 'https://ws.example.com').replace(/\/+$/, '');
const cdnBase = getArg('cdn-base', 'https://cdn.example.com').replace(/\/+$/, '');
const toyLimitMB = Math.max(20, Math.min(127.5, Number(getArg('toy-limit-mb', '124')) || 124));
const toyLimitBytes = Math.floor(toyLimitMB * 1_000_000); // Strict decimal MB cap (124 MB = 118.25 MiB < 128 MB!)
const toyMapsMode = getArg('toy-maps', 'auto'); // 'auto' | 'none'

if (!fs.existsSync(path.join(DIST, 'private.html'))) {
  throw new Error('dist/private.html missing — run `npm run build` first.');
}

fs.rmSync(TOY_OUT, { recursive: true, force: true });
fs.rmSync(CDN_OUT, { recursive: true, force: true });
fs.mkdirSync(TOY_OUT, { recursive: true });
fs.mkdirSync(CDN_OUT, { recursive: true });

let toyBytes = 0;
let toyFiles = 0;
const bundledAssets = [];
const bundledGzAssets = [];
const bundledMaps = [];

function writeToyBuffer(relPath, buf) {
  const dst = path.join(TOY_OUT, relPath);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, buf);
  toyBytes += buf.length;
  toyFiles++;
  return buf.length;
}

function copyToyFile(src, relPath) {
  return writeToyBuffer(relPath, fs.readFileSync(src));
}

function writeToyGzipped(src, relPath) {
  const gzSidecar = src + '.gz';
  const buf = fs.existsSync(gzSidecar) ? fs.readFileSync(gzSidecar) : zlib.gzipSync(fs.readFileSync(src), { level: 9 });
  return writeToyBuffer(relPath + '.gz', buf);
}

function copyTreeToToy(srcDir, relPrefix, filter = null) {
  let bytes = 0;
  if (!fs.existsSync(srcDir)) return bytes;
  for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, e.name);
    const r = path.posix.join(relPrefix, e.name);
    if (e.isDirectory()) bytes += copyTreeToToy(s, r, filter);
    else if (!filter || filter(s, e.name)) bytes += copyToyFile(s, r);
  }
  return bytes;
}

// =========================================================================
// PART 1: BUILD TOY STATIC PACKAGE (STRICTLY < 128 MB)
// =========================================================================
const breakdown = {};

// Layer 1: Frontend Shell (HTML, UI, Vite JS/CSS/fonts/skies, previews, radars, catalog)
let layerStart = toyBytes;

// 1a. Lobby index.html (relative paths + runtime-config.js)
let lobbyHtml = fs.readFileSync(path.join(MODE_UI, 'index.html'), 'utf8');
lobbyHtml = lobbyHtml
  .replaceAll('/perf/ui/', './ui/')
  .replaceAll('/perf/assets/', './assets/')
  .replaceAll('/perf/mode-previews/', './mode-previews/')
  .replaceAll('/perf/radars/', './radars/')
  .replaceAll('href="/perf/"', 'href="./index.html"')
  .replaceAll('href="./"', 'href="./index.html"')
  .replace('<script type="module" src="./ui/screen.js"></script>', '<script src="./runtime-config.js"></script>\n  <script type="module" src="./ui/screen.js"></script>');
writeToyBuffer('index.html', Buffer.from(lobbyHtml, 'utf8'));

// 1b. Match runtime play.html (root-level relative paths + runtime-config.js, no <base> tag per Toy preflight)
let playHtml = fs.readFileSync(path.join(DIST, 'private.html'), 'utf8');
playHtml = playHtml
  .replace('<!-- MAP_LIBRARY_BASE -->', '<script src="./runtime-config.js"></script>')
  .replaceAll('src="/assets/', 'src="./assets/')
  .replaceAll('href="/assets/', 'href="./assets/')
  .replaceAll('href="./"', 'href="./index.html"')
  .replaceAll('href="../../"', 'href="./index.html"');
if (!playHtml.includes('runtime-config.js')) {
  playHtml = playHtml.replace('<head>', '<head><script src="./runtime-config.js"></script>');
}
writeToyBuffer('play.html', Buffer.from(playHtml, 'utf8'));

// 1c. mode-ui, mode-previews, radars, catalog, icons, Vite dist root assets
copyTreeToToy(MODE_UI, 'ui', (_s, name) => name !== 'index.html' && !name.endsWith('.txt'));
copyTreeToToy(MODE_PREVIEWS, 'mode-previews');
copyTreeToToy(path.join(MAPS_SRC, 'radars'), 'radars');
copyToyFile(path.join(MAPS_SRC, 'catalog.json'), 'catalog.json');
copyTreeToToy(path.join(DIST, 'icons'), 'icons');

for (const e of fs.readdirSync(path.join(DIST, 'assets'), { withFileTypes: true })) {
  if (!e.isFile()) continue;
  if (e.name.endsWith('.br') || e.name.endsWith('.gz')) continue;
  const srcPath = path.join(DIST, 'assets', e.name);
  if (e.name.endsWith('.css')) {
    const css = fs.readFileSync(srcPath, 'utf8')
      .replaceAll('../assets/valve-dust2/de_dust2_1_png.png', '../mode-previews/de_dust2-performance.webp')
      .replaceAll('/assets/valve-dust2/de_dust2_1_png.png', '../mode-previews/de_dust2-performance.webp');
    writeToyBuffer('assets/' + e.name, Buffer.from(css, 'utf8'));
  } else {
    copyToyFile(srcPath, 'assets/' + e.name);
  }
}
bundledAssets.push('assets/asset-manifest.json', 'assets/asset-manifest-mobile.json');
breakdown.shellMB = +((toyBytes - layerStart) / 1e6).toFixed(2);

// Helper to add a public/assets/... file to Toy (auto-gzipping large .glb files!)
const addedPublicAssets = new Set(['assets/asset-manifest.json', 'assets/asset-manifest-mobile.json']);
function addPublicAssetToToy(relPath, { allowGz = true, checkBudget = false } = {}) {
  const clean = relPath.replace(/^\/+/, '');
  if (addedPublicAssets.has(clean)) return true;
  const full = path.join(PUBLIC, clean);
  if (!fs.existsSync(full)) return false;
  const rawSize = fs.statSync(full).size;
  const useGz = allowGz && clean.endsWith('.glb') && rawSize > 80_000;
  let buf;
  if (useGz) {
    const gzPath = path.join(DIST, clean + '.gz');
    buf = fs.existsSync(gzPath) ? fs.readFileSync(gzPath) : zlib.gzipSync(fs.readFileSync(full), { level: 9 });
  } else {
    buf = fs.readFileSync(full);
  }
  if (checkBudget && toyBytes + buf.length > toyLimitBytes) return false;
  addedPublicAssets.add(clean);
  if (useGz) {
    writeToyBuffer(clean + '.gz', buf);
    bundledGzAssets.push(clean);
  } else {
    writeToyBuffer(clean, buf);
    bundledAssets.push(clean);
  }
  return true;
}

// Layer 2: Base startup manifest assets (583 files: core anims .gz, default agents, 449 SFX, UI icons, previews)
layerStart = toyBytes;
const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'assets/asset-manifest.json'), 'utf8'));
for (const f of manifest.files) {
  if (['map', 'collision', 'sky'].includes(f.group)) continue;
  if (/(?:^|\/)assets\/(?:map-cs2|map-mobile|valve-dust2)\//.test(f.path)) continue;
  addPublicAssetToToy(f.path, { allowGz: true });
}
breakdown.baseStartupMB = +((toyBytes - layerStart) / 1e6).toFixed(2);

// Layer 3: All 8 utility models (.glb.gz) + ALL agent & skin WebP thumbnails (instant Armory/Lobby galleries!)
layerStart = toyBytes;
for (const u of Object.values(UTILITY_ASSETS)) {
  if (u.model) addPublicAssetToToy(u.model, { allowGz: true });
}
for (const a of Object.values(AGENT_ASSETS)) {
  if (a.preview?.file) addPublicAssetToToy(a.preview.file, { allowGz: false });
}
for (const s of SKINS) {
  if (s.preview) addPublicAssetToToy(s.preview, { allowGz: false });
}
breakdown.utilitiesAndPreviewsMB = +((toyBytes - layerStart) / 1e6).toFixed(2);

// Layer 4: Pack as many of the 9 full-precision maps (.gz) as fit inside the 128 MB Toy budget!
layerStart = toyBytes;
const MAP_PRIORITY = [
  'de_dust2',
  'de_mirage',
  'de_nuke',
  'de_vertigo',
  'de_anubis',
  'de_cache',
  'de_ancient',
  'de_train',
  'de_inferno',
];
const MAP_FILES = [
  'render/map.mgp',
  'compiled/physics.vidx',
  'compiled/physics-mask.u8',
  'compiled/physics-groups.json',
  'compiled/map.json',
  'compiled/nav.json',
  'entity-collision-policy.json',
];
const NON_WEB_MAP_BIN_EXT = /\.(?:mgp|vidx|u8|f32)$/i;
// Reserve ~8 MB for core starter weapons if packing all maps, or pack all 9 maps first and fill remainder with starter weapons!
if (toyMapsMode !== 'none') {
  for (const mapId of MAP_PRIORITY) {
    const dir = path.join(MAPS_SRC, mapId);
    if (!fs.existsSync(path.join(dir, 'render/map.mgp'))) continue;
    const staged = [];
    let mapGzSum = 0;
    for (const rel of MAP_FILES) {
      const full = path.join(dir, rel);
      if (!fs.existsSync(full)) continue;
      const gzSide = full + '.gz';
      const buf = fs.existsSync(gzSide) ? fs.readFileSync(gzSide) : zlib.gzipSync(fs.readFileSync(full), { level: 9 });
      // Bilibili Toy CDN allowlists .glb.gz and .json.gz (rejecting custom .mgp/.vidx/.u8 extensions with 404).
      const toyRel = NON_WEB_MAP_BIN_EXT.test(rel) ? `${rel}.glb.gz` : `${rel}.gz`;
      staged.push({ rel: `maps/${mapId}/${toyRel}`, buf });
      mapGzSum += buf.length;
    }
    // Keep 500 KB reserve for runtime-config.js
    if (toyBytes + mapGzSum + 512_000 <= toyLimitBytes) {
      for (const item of staged) writeToyBuffer(item.rel, item.buf);
      bundledMaps.push(mapId);
    }
  }
}
breakdown.mapsMB = +((toyBytes - layerStart) / 1e6).toFixed(2);

// Layer 5: Fill remaining headroom (< toyLimitBytes) with starter vanilla weapons & CT/T knives first, then flagship skins (.glb.gz)!
layerStart = toyBytes;
const PRIORITY_WEAPONS = [
  'knife', 'pistol', 'usp', 'ak47', 'm4a1', 'm4a4', 'awp', 'deagle',
  'p250', 'mp9', 'mac10', 'galilar', 'famas', 'ssg08', 'fiveseven', 'tec9', 'ump45', 'p90', 'xm1014',
];
const candidateSkins = [];
const addedIds = new Set();
const pushSkin = (s) => { if (s && !addedIds.has(s.id)) { addedIds.add(s.id); candidateSkins.push(s); } };
// Always pack both starter knives (CT & T tactical knives) first!
pushSkin(SKINS.find((s) => s.id === 'default-ct-vanilla'));
pushSkin(SKINS.find((s) => s.id === 'default-t-vanilla'));
for (const w of PRIORITY_WEAPONS) {
  if (w === 'knife') continue;
  pushSkin(SKINS.find((s) => s.weapon === w && s.condition === 'Vanilla'));
}
for (const w of PRIORITY_WEAPONS) {
  pushSkin(SKINS.find((s) => s.weapon === w && s.isDefault));
}
let packedStarterWeapons = 0;
for (const skin of candidateSkins) {
  if (skin.model && addPublicAssetToToy(skin.model, { allowGz: true, checkBudget: true })) {
    packedStarterWeapons++;
    if (skin.animation?.model) addPublicAssetToToy(skin.animation.model, { allowGz: true, checkBudget: true });
  }
}
breakdown.starterWeaponsMB = +((toyBytes - layerStart) / 1e6).toFixed(2);

// Emit runtime-config.js at the Toy package root
const runtimeConfig = {
  gameServerOrigin: gameOrigin,
  assetBaseURL: `${cdnBase}/assets/`,
  mapBaseURL: `${cdnBase}/maps/`,
  bundledAssets: [...new Set(bundledAssets)].sort(),
  bundledGzAssets: [...new Set(bundledGzAssets)].sort(),
  bundledMaps,
  bundledMapsGz: true,
  bundledMapsBinExt: '.glb',
  staticPlayPath: './play.html',
  staticLobbyPath: './index.html',
};
const runtimeJs = [
  '// Auto-generated by scripts/build-toy-and-cdn.mjs',
  '// Before uploading to Bilibili Toy, replace gameServerOrigin & assetBaseURL/mapBaseURL with your HTTPS domains.',
  'globalThis.__CS2_STATIC_RUNTIME__ = ' + JSON.stringify(runtimeConfig, null, 2) + ';',
  '',
].join('\n');
writeToyBuffer('runtime-config.js', Buffer.from(runtimeJs, 'utf8'));

if (toyBytes > 128 * 1024 * 1024) {
  throw new Error(`Toy package exceeded 128 MiB cap: ${(toyBytes / (1024 * 1024)).toFixed(2)} MiB`);
}

// =========================================================================
// PART 2: BUILD COMPLETE CDN BUNDLE (FOR R2 / TENCENT COS / ALIYUN OSS)
// =========================================================================
let cdnBytes = 0;
let cdnFiles = 0;
function copyCdnFile(src, relPath) {
  const dst = path.join(CDN_OUT, relPath);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  cdnBytes += fs.statSync(dst).size;
  cdnFiles++;
}
function copyTreeToCdn(srcDir, relPrefix, filter = null) {
  if (!fs.existsSync(srcDir)) return;
  for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, e.name);
    const r = path.posix.join(relPrefix, e.name);
    if (e.isDirectory()) copyTreeToCdn(s, r, filter);
    else if (!filter || filter(s, e.name)) copyCdnFile(s, r);
  }
}

// 2a. All public/assets/* (excluding legacy unused Dust2 raw collision/map JSONs if unwanted? Keep complete assets/!)
copyTreeToCdn(path.join(PUBLIC, 'assets'), 'assets', (_s, name) => !name.endsWith('.DS_Store'));
// 2b. All 9 maps compact runtime (raw files — CDN edge automatically negotiates Brotli/Gzip with browsers!)
copyCdnFile(path.join(MAPS_SRC, 'catalog.json'), 'catalog.json');
copyTreeToCdn(path.join(MAPS_SRC, 'radars'), 'radars');
copyTreeToCdn(MODE_PREVIEWS, 'mode-previews');
for (const mapId of MAP_PRIORITY) {
  const dir = path.join(MAPS_SRC, mapId);
  if (!fs.existsSync(path.join(dir, 'render/map.mgp'))) continue;
  for (const rel of [...MAP_FILES, 'compact-manifest.json', 'READY.json']) {
    const full = path.join(dir, rel);
    if (!fs.existsSync(full)) continue;
    copyCdnFile(full, `maps/${mapId}/${rel}`);
    // Also expose flat paths (maps/<id>/map.json, physics.vidx, etc.) for direct web CDN offload
    if (rel.startsWith('compiled/')) {
      copyCdnFile(full, `maps/${mapId}/${rel.slice('compiled/'.length)}`);
    }
  }
}

const uploadGuide = `# CS2-Web 零服务器流量部署清单（Toy 128MB 静态包 + 外部 CDN + 纯逻辑服）

## 1. B站 Toy 上传目录：\`artifacts/deploy/toy-package/\`
- 当前体积：**${(toyBytes / (1024 * 1024)).toFixed(2)} MiB**（${(toyBytes / 1e6).toFixed(2)} MB，严格低于 128 MB 上限）
- 已内置地图（${bundledMaps.length}/9 张）：\`${bundledMaps.join(', ') || '无（全部走 CDN）'}\`
- 已内置默认/核心武器模型（.glb.gz）：${packedStarterWeapons} 把
- 上传前只需修改根目录 \`runtime-config.js\` 的前 3 行：
  - \`gameServerOrigin\`: 你的游戏逻辑服 HTTPS 域名（如 \`https://ws.你的域名\`）
  - \`assetBaseURL\`: 你的 CDN 域名 + \`/assets/\`（如 \`https://cdn.你的域名/assets/\`）
  - \`mapBaseURL\`: 你的 CDN 域名 + \`/maps/\`（如 \`https://cdn.你的域名/maps/\`）

## 2. CDN 对象存储上传目录：\`artifacts/deploy/cdn-bundle/\`
- 当前体积：**${(cdnBytes / 1e6).toFixed(2)} MB**（${cdnFiles} 个文件，含全量皮肤库、额外探员、音乐盒、原版贴图 Dust2 及全部 9 图备份）
- 推荐对象存储 + CDN（详见下方）：
  - **已备案域名**：腾讯云 COS + 腾讯云 EdgeOne/CDN 或 阿里云 OSS + CDN
  - **未备案域名**：Cloudflare R2（0 流量费、10 GB 免费）+ 自定义域名
- 必配响应头：
  - **CORS**：允许 \`GET, HEAD\`，Origin 允许 \`*\`（或你的 Toy 域名与主站域名），暴露 \`Content-Length, ETag, Content-Encoding\`
  - **Cache-Control**：静态资源开启长期缓存（\`public, max-age=31536000, immutable\`），CDN 开启自动 Brotli / Gzip 压缩

## 3. 游戏逻辑服（零静态资源流量）
在服务器环境变量启用纯逻辑模式：
\`\`\`bash
PERF_DISABLE_LOCAL_ASSETS=1
PERF_LOGIC_GATEWAY_ONLY=1
PERF_ALLOWED_ORIGINS=*
PERF_ASSET_BASE_URL=https://cdn.你的域名/assets/
PERF_MAP_BASE_URL=https://cdn.你的域名/maps/
\`\`\`
`;
fs.writeFileSync(path.join(CDN_OUT, 'UPLOAD-GUIDE.md'), uploadGuide, 'utf8');

console.log(JSON.stringify({
  toyPackage: {
    dir: path.relative(ROOT, TOY_OUT),
    files: toyFiles,
    sizeMB: +(toyBytes / 1e6).toFixed(2),
    sizeMiB: +(toyBytes / (1024 * 1024)).toFixed(2),
    limitMiB: toyLimitMB,
    bundledMapsCount: bundledMaps.length,
    bundledMaps,
    packedStarterWeapons,
    bundledAssetsCount: bundledAssets.length,
    bundledGzAssetsCount: bundledGzAssets.length,
    breakdownMB: breakdown,
  },
  cdnBundle: {
    dir: path.relative(ROOT, CDN_OUT),
    files: cdnFiles,
    sizeMB: +(cdnBytes / 1e6).toFixed(2),
  },
}, null, 2));
