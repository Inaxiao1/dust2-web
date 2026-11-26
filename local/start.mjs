import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mapRoot = path.join(root, 'artifacts/performance-maps/maps-v1');
const port = Number(process.env.PORT || 3240);
const lan = process.argv.includes('--lan');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('PORT must be between 1 and 65535');
for (const file of [path.join(mapRoot, 'catalog.json'), path.join(root, 'dist/private.html'), path.join(root, 'public/assets/characters-cs2/ct-sas.glb')]) {
  if (!existsSync(file)) {
    console.error('运行资源尚未安装，请先执行 npm run setup:local');
    process.exit(1);
  }
}

const url = 'http://127.0.0.1:' + port + '/perf/';
function openBrowser() {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  const browser = spawn(command, [url], { stdio: 'ignore' });
  browser.on('error', () => console.log('请手动打开上面的游戏地址。'));
}
if (!lan) {
  let running;
  try {
    const response = await fetch(url + 'health', { signal: AbortSignal.timeout(500) });
    if (response.ok) running = await response.json();
  } catch {}
  if (running?.ok === true && running.maps === 9) {
    console.log('游戏服务已在运行：' + url);
    if (process.argv.includes('--open')) openBrowser();
    process.exit(0);
  }
}
console.log('网页 CS：' + url);
if (lan) for (const addresses of Object.values(networkInterfaces())) for (const address of addresses || []) {
  if (address.family === 'IPv4' && !address.internal) console.log('同一局域网的朋友可打开：http://' + address.address + ':' + port + '/perf/');
}
const child = spawn(process.execPath, ['server/performance-maps.js'], {
  cwd: root, stdio: 'inherit',
  env: { ...process.env, PORT: String(port), PERF_HOST: lan ? '0.0.0.0' : '127.0.0.1', PERF_MAP_ROOT: mapRoot, PERF_GAME_DIST: path.join(root, 'dist') },
});
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { stopping = true; child.kill(signal); });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = stopping ? 0 : code ?? (signal ? 1 : 0); });
if (process.argv.includes('--open')) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) break;
    try {
      const response = await fetch(url + 'health', { signal: AbortSignal.timeout(500) });
      if (response.ok && (await response.json()).maps === 9) {
        openBrowser();
        break;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}
