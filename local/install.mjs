import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, stat, rm, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(root, '.downloads');
const mapRoot = path.join(root, 'artifacts/performance-maps/maps-v1');
const releases = [
  { name: 'maps-v1.tgz', id: 776015120, bytes: 239650428, sha256: '88ebc7f9cc72436171eb34ff8e4bdcf40a365c9476478ca9f39395f9bed60ba8', destination: mapRoot },
  { name: 'media.tgz', id: 775706519, bytes: 943525119, sha256: 'b64df5d70e072d95a44f188b09473b0482d375ded2cef8c8ee0bac5ceaaff9ba', destination: path.join(root, 'public') },
];

function run(command, args, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
    let output = '';
    child.stdout?.on('data', data => { output += data; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output) : reject(Error(command + ' failed (' + code + ')')));
  });
}

async function hash(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

async function download(release) {
  const target = path.join(cache, release.name);
  const offset = existsSync(target) ? (await stat(target)).size : 0;
  if (offset > release.bytes) throw Error(release.name + ' has an unexpected size. Remove it and retry.');
  if (offset < release.bytes) {
    // Resolve the API redirect once; reuse the signed URL for byte-range transfers.
    const headersFile = target + '.headers';
    const probe = target + '.probe';
    await run('curl', ['-fsS', '--retry', '3', '--connect-timeout', '15', '--max-time', '60', '-H', 'Accept: application/octet-stream', '-D', headersFile, '-o', probe, 'https://api.github.com/repos/ETO-ze/dust2-web/releases/assets/' + release.id]);
    const headers = await readFile(headersFile, 'utf8');
    const url = /^location:\s*(.+)$/im.exec(headers)?.[1].trim();
    if (!url || new URL(url).protocol !== 'https:') throw Error('GitHub did not return an HTTPS asset download URL.');
    await rm(probe, { force: true });
    await rm(headersFile, { force: true });
    const chunksDir = target + '.chunks';
    await mkdir(chunksDir, { recursive: true });
    const chunks = [];
    const chunkSize = 8 * 1024 * 1024;
    for (let start = offset; start < release.bytes; start += chunkSize) {
      const end = Math.min(start + chunkSize, release.bytes) - 1;
      chunks.push({ start, end, file: path.join(chunksDir, start + '-' + end) });
    }
    let next = 0, completedBytes = offset;
    await Promise.all(Array.from({ length: Math.min(6, chunks.length) }, async () => {
      while (next < chunks.length) {
        const chunk = chunks[next++];
        if (!existsSync(chunk.file) || (await stat(chunk.file)).size !== chunk.end - chunk.start + 1) {
          const status = await run('curl', ['-fLsS', '--retry', '4', '--retry-delay', '1', '--connect-timeout', '15', '--max-time', '240', '--range', chunk.start + '-' + chunk.end, '-o', chunk.file, '-w', '%{http_code}', url], true);
          if (status !== '206' || (await stat(chunk.file)).size !== chunk.end - chunk.start + 1) throw Error('Invalid byte range for ' + release.name);
        }
        completedBytes += chunk.end - chunk.start + 1;
        console.log(release.name + ': ' + (100 * completedBytes / release.bytes).toFixed(0) + '%');
      }
    }));
    for (const chunk of chunks) {
      await pipeline(createReadStream(chunk.file), createWriteStream(target, { flags: 'a' }));
      await rm(chunk.file);
    }
    await rm(chunksDir, { recursive: true, force: true });
  }
  if (await hash(target) !== release.sha256) throw Error('SHA-256 mismatch: ' + release.name);
  console.log(release.name + ': SHA-256 verified');
  return target;
}

async function main() {
  await mkdir(cache, { recursive: true });
  const downloadsOnly = process.argv.includes('--download-only');
  const selected = process.argv.includes('--maps-only') ? releases.slice(0, 1) : releases;
  await Promise.all(selected.map(async release => {
    const marker = path.join(cache, release.name + '.installed.json');
    if (!downloadsOnly && existsSync(marker) && existsSync(path.join(release.destination, release.name === 'maps-v1.tgz' ? 'catalog.json' : 'assets'))) {
      if (JSON.parse(await readFile(marker, 'utf8')).sha256 === release.sha256) return;
    }
    const archive = await download(release);
    if (downloadsOnly) return;
    await mkdir(release.destination, { recursive: true });
    await run('tar', ['-xzf', archive, '-C', release.destination]);
    await writeFile(marker, JSON.stringify({ sha256: release.sha256, installedAt: new Date().toISOString() }, null, 2));
    console.log(release.name + ': installed');
  }));
  if (!downloadsOnly) {
    if (!existsSync(path.join(root, 'node_modules/vite'))) await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci']);
    // The local gateway serves public/ directly; avoid a second copy of the media.
    process.env.DUSTII_REVIEW_BUILD = '1';
    await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build']);
    if (!process.argv.includes('--keep-downloads')) {
      await Promise.all(selected.map(release => rm(path.join(cache, release.name), { force: true })));
    }
    console.log('Ready. Run npm run play');
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
