import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORBIDDEN_LOGIC_EXTENSIONS = new Set([
  '.glb', '.gltf', '.bin', '.png', '.jpg', '.jpeg', '.webp', '.avif',
  '.svg', '.mp3', '.ogg', '.wav', '.css', '.html', '.woff2', '.ttf', '.otf',
]);

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkFiles(full));
    else if (entry.isFile()) results.push(full);
  }
  return results;
}

function summarize(files) {
  let bytes = 0;
  for (const file of files) bytes += fs.statSync(file).size;
  return { count: files.length, bytes, mib: Math.round((bytes / (1024 * 1024)) * 100) / 100 };
}

export function auditLogicSplit(root = ROOT) {
  const serverFiles = [
    ...walkFiles(path.join(root, 'server')),
    ...walkFiles(path.join(root, 'shared')),
  ];

  const mapsRoot = path.join(root, 'artifacts/performance-maps/maps-v1');
  const mapLogicFiles = [];
  const mapClientFiles = [];

  if (fs.existsSync(path.join(mapsRoot, 'catalog.json'))) {
    mapLogicFiles.push(path.join(mapsRoot, 'catalog.json'));
  }
  if (fs.existsSync(mapsRoot)) {
    for (const entry of fs.readdirSync(mapsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(mapsRoot, entry.name);
      if (entry.name === 'radars') {
        mapClientFiles.push(...walkFiles(full));
        continue;
      }
      if (!entry.name.startsWith('de_')) continue;
      for (const file of walkFiles(full)) {
        const rel = path.relative(full, file).replace(/\\/g, '/');
        if (
          rel === 'READY.json' ||
          rel === 'navigation-audit.json' ||
          rel === 'entity-collision-policy.json' ||
          /^compiled\/(?:map\.json|nav\.json|physics\.f32|physics-mask\.u8|physics-groups\.json)$/.test(rel)
        ) {
          mapLogicFiles.push(file);
        } else {
          mapClientFiles.push(file);
        }
      }
    }
  }

  const clientDirectories = [
    path.join(root, 'dist'),
    path.join(root, 'client-next/dist'),
    path.join(root, 'public/assets'),
    path.join(root, 'artifacts/performance-maps/quality-library'),
    path.join(root, 'artifacts/performance-maps/quality-transport'),
    path.join(root, 'scripts/maps/mode-ui'),
    path.join(root, 'scripts/maps/mode-previews'),
  ];
  const clientFiles = [
    ...mapClientFiles,
    ...clientDirectories.flatMap(dir => walkFiles(dir)),
  ];

  const allLogicFiles = [...serverFiles, ...mapLogicFiles];
  const forbiddenInLogic = allLogicFiles
    .filter(file => FORBIDDEN_LOGIC_EXTENSIONS.has(path.extname(file).toLowerCase()))
    .map(file => path.relative(root, file).replace(/\\/g, '/'));

  return {
    ok: forbiddenInLogic.length === 0,
    forbiddenInLogic,
    serverLogic: {
      code: summarize(serverFiles),
      mapRuntime: summarize(mapLogicFiles),
      total: summarize(allLogicFiles),
    },
    clientAssets: summarize(clientFiles),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = auditLogicSplit();
  const outIndex = process.argv.indexOf('--output');
  if (outIndex !== -1 && process.argv[outIndex + 1]) {
    const outPath = path.resolve(process.argv[outIndex + 1]);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}
