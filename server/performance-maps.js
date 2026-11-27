/** Loopback nine-map gateway. Start and retire game workers on demand. */
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {PERFORMANCE_MAPS, isPerformanceMap} from '../shared/performance-map-pool.js';
import {findQualityPacks} from './performance-quality.js';
import {SKINS} from '../shared/skins.js';
import {packagedAgentAssets} from '../shared/packaged-agent-assets.js';
import {packagedMusicAssets} from '../shared/packaged-music-assets.js';
import {packagedSkinAssets} from '../shared/packaged-skin-assets.js';
import {validateDownloadConfig} from '../shared/download-config.js';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root=path.resolve(process.env.PERF_MAP_ROOT || path.join(repo,'artifacts/performance-maps/maps-v1'));
const legacyDist=path.join(repo,'artifacts/performance-maps/client-dist');
const dist=path.resolve(process.env.PERF_GAME_DIST || (fs.existsSync(legacyDist)?legacyDist:path.join(repo,'dist')));
const publicDir=path.resolve(process.env.PERF_PUBLIC_DIR || path.join(repo,'public'));
const port=Number(process.env.PORT || (process.platform === 'win32' ? 33440 : 3240));
const host=process.env.PERF_HOST || '127.0.0.1';
const disableLocalAssets=process.env.PERF_DISABLE_LOCAL_ASSETS==='1';
const logicGatewayOnly=process.env.PERF_LOGIC_GATEWAY_ONLY==='1';
const controlPlaneUrl=(process.env.PERF_CONTROL_PLANE_URL||'').trim().replace(/\/+$/,'');
const controlPlaneWorkerAuth=(process.env.PERF_WORKER_AUTH_TOKEN||process.env.DUST2_WORKER_AUTH_TOKEN||'').trim();
const workerMaxRooms=String(Math.max(1,Math.min(24,Number(process.env.DUST2_PRIVATE_MAX_ROOMS)||6)));
const deliveryConfig=validateDownloadConfig({
  schemaVersion:1,
  assetBaseURL:process.env.PERF_ASSET_BASE_URL||process.env.DUST2_ASSET_DOWNLOAD_BASE||null,
  mapBaseURL:process.env.PERF_MAP_BASE_URL||process.env.DUSTII_MAP_DOWNLOAD_BASE||null,
  fallbackToGameServer:(process.env.PERF_DOWNLOAD_FALLBACK||process.env.DUST2_DOWNLOAD_FALLBACK)==='true',
},'http://127.0.0.1/');
const allowedOrigins=(()=>{
  const raw=process.env.PERF_ALLOWED_ORIGINS;
  if(!raw)return null;
  if(raw.trim()==='*')return '*';
  const set=new Set(raw.split(',').map(v=>v.trim()).filter(Boolean).map(v=>new URL(v).origin));
  return set.size?set:null;
})();
const catalogPath=path.join(root,'catalog.json');
const maps=new Set(JSON.parse(fs.readFileSync(catalogPath)).maps.filter(m=>isPerformanceMap(m.id)).map(m=>m.id));
const reviewAssets=path.join(repo,'scripts/maps');
const qualityPacks=disableLocalAssets?new Map():findQualityPacks(root,maps,
  path.resolve(process.env.PERF_QUALITY_MAP_LIBRARY || path.join(root,'..','quality-library')),
  path.resolve(process.env.PERF_QUALITY_TRANSPORT || path.join(root,'..','quality-transport')));
const workers=new Map();
const idleMs=Math.max(1000,Number(process.env.PERF_IDLE_MS)||120000);
const maxWorkers=Math.max(1,Math.min(32,Number(process.env.PERF_MAX_WORKERS)||4));
const strictHeavyLock=process.env.PERF_STRICT_HEAVY_LOCK==='1'||maxWorkers<=2;
const heavy=new Set(['de_inferno','de_cache','de_ancient','de_train']);
const warmMaps=(process.env.PERF_WARM_MAPS||'').split(',').map(v=>v.trim()).filter(id=>maps.has(id)).slice(0,maxWorkers);
let draining=false;
const types={'.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.html':'text/html; charset=utf-8','.json':'application/json','.gltf':'model/gltf+json','.glb':'model/gltf-binary','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.avif':'image/avif','.webp':'image/webp','.svg':'image/svg+xml','.hdr':'application/octet-stream','.ogg':'audio/ogg','.mp3':'audio/mpeg','.woff2':'font/woff2','.ttf':'font/ttf'};
const json=(res,code,data)=>res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(data));
function file(req,res,location,immutable=false){
  const hasRaw=fs.existsSync(location)&&fs.statSync(location).isFile();
  const hasBr=fs.existsSync(location+'.br')&&fs.statSync(location+'.br').isFile();
  const hasGz=fs.existsSync(location+'.gz')&&fs.statSync(location+'.gz').isFile();
  if(!hasRaw&&!hasBr&&!hasGz){res.writeHead(404).end();return;}
  const acceptEncoding=req.headers['accept-encoding']||'';
  const accepts=name=>acceptEncoding.split(',').some(value=>{
    const [coding,weight]=value.trim().toLowerCase().split(/\s*;\s*/);
    return coding===name && (weight===undefined || /^q=(?:1(?:\.0{0,3})?|0\.\d{1,3})$/.test(weight) && Number(weight.slice(2))>0);
  });
  const useBr=accepts('br')&&hasBr;
  const useGzip=!useBr&&accepts('gzip')&&hasGz;
  const transcodeBrToGzip=!useBr&&!useGzip&&accepts('gzip')&&hasBr&&!hasRaw;
  const encoding=useBr?'br':(useGzip||transcodeBrToGzip)?'gzip':null;
  // Support slim deployments where only .br/.gz is stored on disk:
  // serve .br/.gz directly when accepted, transcode .br->gzip for plain-HTTP clients, or decompress for raw clients.
  const decompressOnFly=!useBr&&!useGzip&&!hasRaw;
  const physical=useBr?location+'.br':useGzip?location+'.gz':hasRaw?location:hasBr?location+'.br':location+'.gz';
  const stat=fs.statSync(physical);
  const tag='W/"'+[stat.ino,stat.size,stat.mtimeMs,encoding||'raw'].join('-')+'"';
  const headers={'Content-Type':types[path.extname(location)]||'application/octet-stream','ETag':tag,
    'Cache-Control':immutable?'public, max-age=31536000, immutable':'no-cache','Vary':'Accept-Encoding'};
  if(encoding)headers['Content-Encoding']=encoding;
  const validators=(req.headers['if-none-match']||'').split(',').map(value=>value.trim());
  if(validators.includes('*')||validators.some(value=>value.replace(/^W\//,'')===tag.slice(2))){
    res.writeHead(304,headers).end();return;
  }
  if(!decompressOnFly)headers['Content-Length']=stat.size;
  res.writeHead(200,headers);
  if(req.method==='HEAD'){res.end();return;}
  const stream=fs.createReadStream(physical);
  if(transcodeBrToGzip){
    const dec=zlib.createBrotliDecompress();
    const enc=zlib.createGzip({level:4});
    stream.on('error',()=>res.destroy());dec.on('error',()=>res.destroy());enc.on('error',()=>res.destroy());
    res.on('close',()=>{stream.destroy();dec.destroy();enc.destroy();});
    stream.pipe(dec).pipe(enc).pipe(res);
  }else if(decompressOnFly){
    const dec=physical.endsWith('.br')?zlib.createBrotliDecompress():zlib.createGunzip();
    stream.on('error',()=>res.destroy());dec.on('error',()=>res.destroy());res.on('close',()=>{stream.destroy();dec.destroy();});
    stream.pipe(dec).pipe(res);
  }else{
    stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
  }
}
function retire(worker){
  if(worker.connections || worker.retiring)return;
  worker.retiring=true;worker.child.kill();
}
async function ensureWorker(id){
  const existing=workers.get(id);
  if(existing&&!existing.retiring){existing.touched=Date.now();return existing.ready;}
  if(existing)throw Error('地图服务正在释放，请稍后重试');
  // High-memory maps get an exclusive slot on the small server. Active players always keep their worker.
  const occupied=[...workers.values()];
  const fits=()=>workers.size<maxWorkers && (!strictHeavyLock || !(workers.size&&(heavy.has(id)||[...workers.keys()].some(k=>heavy.has(k)))));
  if(!fits()){
    for(const w of occupied.sort((a,b)=>a.touched-b.touched)){
      if(w.connections||!w.port||Date.now()-w.touched<15000)continue;
      retire(w);await w.exited;
      if(fits())break;
    }
    if(!fits())throw Error('当前地图服务已满，请稍后再进入');
  }
  // A simultaneous request may have started the same worker while awaiting an eviction.
  if(workers.has(id))return workers.get(id).ready;
  const workerEnv={
    ...process.env,
    PORT:'0',
    HOST:'127.0.0.1',
    DUSTII_GRID_VISION:'1',
    DUSTII_PERFORMANCE_DIRECTORY:'1',
    DUST2_PRIVATE_MAX_ROOMS:workerMaxRooms,
    DUSTII_PRIVATE_MAP_ID:id,
    DUSTII_PRIVATE_MAP_DIRECTORY:path.join(root,id),
    DUSTII_PRIVATE_LIBRARY_URL:'/perf',
    ...(disableLocalAssets?{
      DUST2_LOGIC_ONLY:process.env.DUST2_LOGIC_ONLY??'1',
      DUST2_SERVE_MAP_FILES:process.env.DUST2_SERVE_MAP_FILES??'0',
    }:{}),
  };
  const child=spawn(process.execPath,['server/private-map-server.js'],{cwd:repo,windowsHide:true,
    env:workerEnv,
    stdio:['ignore','pipe','inherit']});
  const w={child,port:0,connections:0,touched:Date.now(),retiring:false};
  w.exited=new Promise(resolve=>child.once('close',()=>{if(workers.get(id)===w)workers.delete(id);resolve();}));
  w.ready=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{reject(Error('地图启动超时'));child.kill();},75000);
    let log='';
    const failed=()=>{clearTimeout(timer);reject(Error('地图服务启动失败'));};
    child.once('error',failed);child.once('exit',failed);
    child.stdout.on('data',part=>{log=(log+part).slice(-8192);
      for(const line of log.split('\n')){try{const r=JSON.parse(line);if(r.service==='dust2-private-game'&&r.mapId===id&&r.port>0&&r.port<65536){
        clearTimeout(timer);child.removeListener('exit',failed);w.port=r.port;resolve(w);return;
      }}catch{}}
    });
  });
  workers.set(id,w);return w.ready;
}
const reap=setInterval(()=>{for(const w of workers.values())if(w.port&&!w.connections&&Date.now()-w.touched>idleMs)retire(w);},15000);
reap.unref();

// Lobby visitors never acquire a map slot or renew the idle timeout. A burst of
// readers shares one query until the map's connections change or the cache expires.
function readWorkerRooms(worker) {
  if (!worker.directoryRead || worker.directoryRead.expires <= Date.now()) {
    const read = {expires: Infinity};
    read.result = fetch('http://127.0.0.1:' + worker.port + '/room-directory.json', {signal:AbortSignal.timeout(1500)})
      .then(response => {
        if (!response.ok) throw Error('地图房间目录暂时不可用');
        return response.json();
      })
      .finally(() => { read.expires = Date.now() + 250; });
    worker.directoryRead = read;
  }
  return worker.directoryRead.result;
}

const mapInfoById = new Map(PERFORMANCE_MAPS.map(m => [m.id, m]));

function decorateClusterRoom(row) {
  const info = mapInfoById.get(row.mapId);
  const humans = Number(row.humans) || 0;
  const capacity = Number(row.capacity) || 10;
  const players = Array.isArray(row.players) ? row.players : [];
  return {
    id: row.mapId + ':' + row.code,
    code: row.code,
    mapId: row.mapId,
    mapName: info?.name || row.mapId,
    mapNameZh: info?.nameZh || row.mapId,
    mode: row.mode === 'deathmatch' ? 'deathmatch' : 'defuse',
    botDifficulty: row.botDifficulty || 'normal',
    humans,
    bots: Number(row.bots) || 0,
    capacity,
    full: humans >= capacity,
    joinable: row.joinable === true && humans < capacity,
    scores: row.scores || { CT: 0, T: 0 },
    phase: row.phase || 'live',
    players,
    qualityAvailable: qualityPacks.has(row.mapId),
    ...(row.workerId ? { workerId: row.workerId } : {}),
  };
}

async function readJsonBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 65536) throw Error('Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function fetchControlPlane(apiPath, options = {}) {
  const response = await fetch(controlPlaneUrl + apiPath, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    signal: AbortSignal.timeout(3000),
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, ok: response.ok, data };
}

async function performanceRooms() {
  if (controlPlaneUrl) {
    const { ok, data } = await fetchControlPlane('/api/v1/rooms');
    if (!ok || !Array.isArray(data.rooms)) throw Error('控制面房间目录暂时不可用');
    const rooms = data.rooms.filter(r => maps.has(r.mapId)).map(decorateClusterRoom);
    rooms.sort((a,b) => Number(b.joinable)-Number(a.joinable) || b.humans-a.humans || a.id.localeCompare(b.id));
    const totalHumans = rooms.reduce((sum, r) => sum + r.humans, 0);
    const joinableRooms = rooms.filter(r => r.joinable && r.humans < r.capacity).length;
    return {rooms, totalRooms: rooms.length, totalHumans, joinableRooms, controlPlane: true};
  }
  const active = worker => worker?.port && worker.connections && !worker.retiring && !worker.child.killed && worker.child.exitCode === null && worker.child.signalCode === null;
  const occupied = PERFORMANCE_MAPS.map(map => ({map, worker:workers.get(map.id)})).filter(({worker}) => active(worker));
  const results = await Promise.allSettled(occupied.map(({worker}) => readWorkerRooms(worker)));
  const rooms = [];
  let unavailable = 0, responding = 0;
  for (const [index, {map, worker}] of occupied.entries()) {
    if (!active(worker) || workers.get(map.id) !== worker) continue;
    if (results[index].status === 'rejected') { unavailable++; continue; }
    responding++;
    for (const row of results[index].value) {
      rooms.push({...row, id:map.id+':'+row.code, mapId:map.id, mapName:map.name, mapNameZh:map.nameZh, qualityAvailable:qualityPacks.has(map.id)});
    }
  }
  if (unavailable && !responding) throw Error('地图房间目录暂时不可用');
  rooms.sort((a,b) => Number(b.joinable)-Number(a.joinable) || b.humans-a.humans || a.id.localeCompare(b.id));
  const totalHumans = rooms.reduce((sum, r) => sum + r.humans, 0);
  const joinableRooms = rooms.filter(r => r.joinable && r.humans < r.capacity).length;
  return {rooms, totalRooms: rooms.length, totalHumans, joinableRooms, ...(unavailable ? {partial:true} : {})};
}

async function quickJoinRecommendation(modeParam, preferredMap) {
  const wantedMode = modeParam === 'defuse' || modeParam === 'deathmatch' ? modeParam : 'any';
  if (controlPlaneUrl) {
    const q = new URLSearchParams({ mode: wantedMode, ...(preferredMap ? { preferredMap } : {}) });
    const { ok, data } = await fetchControlPlane('/api/v1/quick-join?' + q);
    if (ok && data.action) {
      if (data.action === 'join' && data.room) {
        const room = decorateClusterRoom(data.room);
        const params = new URLSearchParams({ room: room.code, join: '1', matchMode: room.mode });
        return {
          action: 'join',
          room,
          joinUrl: '/perf/play/' + room.mapId + '/?' + params,
          totalRooms: data.totalRooms || 0,
          totalHumans: data.totalHumans || 0,
          joinableRooms: data.joinableRooms || 0,
          controlPlane: true,
        };
      }
      const fallbackMap = maps.has(data.mapId) ? data.mapId : (maps.has('de_dust2') ? 'de_dust2' : [...maps][0]);
      const fallbackMode = data.mode === 'deathmatch' ? 'deathmatch' : 'defuse';
      const params = new URLSearchParams({ autostart: '1', matchMode: fallbackMode });
      return {
        action: 'create',
        mapId: fallbackMap,
        mode: fallbackMode,
        joinUrl: '/perf/play/' + fallbackMap + '/?' + params,
        totalRooms: data.totalRooms || 0,
        totalHumans: data.totalHumans || 0,
        joinableRooms: 0,
        controlPlane: true,
      };
    }
  }
  const directory = await performanceRooms().catch(() => ({ rooms: [], totalRooms: 0, totalHumans: 0, joinableRooms: 0 }));
  const candidates = directory.rooms.filter(r => r.joinable && r.humans < r.capacity);
  candidates.sort((a, b) => {
    const modeDiff = Number(wantedMode !== 'any' && b.mode === wantedMode) - Number(wantedMode !== 'any' && a.mode === wantedMode);
    if (modeDiff) return modeDiff;
    const humanDiff = b.humans - a.humans;
    if (humanDiff) return humanDiff;
    const prefDiff = Number(b.mapId === preferredMap) - Number(a.mapId === preferredMap);
    if (prefDiff) return prefDiff;
    return a.id.localeCompare(b.id);
  });
  if (candidates.length) {
    const room = candidates[0];
    const params = new URLSearchParams({ room: room.code, join: '1', matchMode: room.mode });
    return {
      action: 'join',
      room,
      joinUrl: '/perf/play/' + room.mapId + '/?' + params,
      totalRooms: directory.totalRooms,
      totalHumans: directory.totalHumans,
      joinableRooms: directory.joinableRooms,
    };
  }
  const fallbackMap = maps.has(preferredMap) ? preferredMap : (maps.has('de_dust2') ? 'de_dust2' : [...maps][0]);
  const fallbackMode = wantedMode === 'deathmatch' ? 'deathmatch' : 'defuse';
  const params = new URLSearchParams({ autostart: '1', matchMode: fallbackMode });
  return {
    action: 'create',
    mapId: fallbackMap,
    mode: fallbackMode,
    joinUrl: '/perf/play/' + fallbackMap + '/?' + params,
    totalRooms: directory.totalRooms,
    totalHumans: directory.totalHumans,
    joinableRooms: 0,
  };
}

async function findRoomByCode(rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(code)) return { found: false, error: '房间码应为 4–12 位字母或数字。' };
  if (controlPlaneUrl) {
    const { ok, data } = await fetchControlPlane('/api/v1/rooms/' + encodeURIComponent(code));
    if (!ok || !data.found || !data.room) {
      return { found: false, error: data.error || '未找到该房间码对应的活跃公开房间。' };
    }
    const room = decorateClusterRoom(data.room);
    const params = new URLSearchParams({ room: room.code, join: '1', matchMode: room.mode });
    return {
      found: true,
      room,
      workerId: data.workerId,
      workerWsUrl: data.workerWsUrl,
      joinUrl: '/perf/play/' + room.mapId + '/?' + params,
    };
  }
  const directory = await performanceRooms();
  const room = directory.rooms.find(r => r.code === code);
  if (!room) return { found: false, error: '未找到该房间码对应的活跃公开房间。' };
  const params = new URLSearchParams({ room: room.code, join: '1', matchMode: room.mode });
  return {
    found: true,
    room,
    joinUrl: '/perf/play/' + room.mapId + '/?' + params,
  };
}

// Locally packaged skin revisions can precede publication to the shared CDN.
function packagedPaths(assets){return assets.filter(asset=>{
  const file=[dist,publicDir].map(base=>path.join(base,asset.path)).find(name=>fs.existsSync(name));
  if(!file)return false;
  const stat=fs.statSync(file);
  return stat.isFile() && stat.size===asset.bytes;
}).map(asset=>asset.path);}
const localSkinPaths=disableLocalAssets?[]:packagedPaths(packagedSkinAssets(SKINS));
const localAgentPaths=disableLocalAssets?[]:packagedPaths(packagedAgentAssets());
const musicAssets=disableLocalAssets?[]:packagedMusicAssets();
const availableMusic=new Set(disableLocalAssets?[]:packagedPaths(musicAssets));
const localMusicKits=disableLocalAssets?[]:[...new Set(musicAssets.map(asset=>asset.id))]
  .filter(id=>musicAssets.every(asset=>asset.id!==id||availableMusic.has(asset.path)));
function applyCors(req,res){
  if(!allowedOrigins)return;
  if(allowedOrigins==='*')res.setHeader('Access-Control-Allow-Origin','*');
  else{
    const origin=req.headers.origin;
    if(typeof origin==='string'&&allowedOrigins.has(origin)){
      res.setHeader('Access-Control-Allow-Origin',origin);
      res.setHeader('Vary','Origin');
    }
  }
  res.setHeader('Access-Control-Allow-Methods','GET, HEAD, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
}
async function remoteWorkerOriginForMap(mapId) {
  if (!controlPlaneUrl || !controlPlaneWorkerAuth) return null;
  const { ok, data } = await fetchControlPlane('/api/v1/workers', {
    headers: { Authorization: 'Bearer ' + controlPlaneWorkerAuth },
  }).catch(() => ({ ok: false, data: null }));
  if (!ok || !Array.isArray(data?.workers)) return null;
  const match = data.workers.find(w => !w.draining && Array.isArray(w.maps) && (w.maps.includes(mapId) || w.maps.includes('*')));
  if (!match?.wsUrl) return null;
  try {
    const parsed = new URL(match.wsUrl);
    return (parsed.protocol === 'wss:' ? 'https://' : 'http://') + parsed.host;
  } catch {
    return null;
  }
}

function mapConfig(id,originOrWorker,quality){
  const baseOrigin=typeof originOrWorker==='string'?originOrWorker:('http://127.0.0.1:'+originOrWorker.port);
  return fetch(baseOrigin+'/private-map.json').then(r=>r.json()).then(config=>{
    const remap=path.join(root,id,'flat-breakables.json');
    const hashes=JSON.parse(fs.readFileSync(path.join(root,id,'READY.json'))).gameplayHashes || {};
    const urls={};
    for(const key of ['metadataUrl','navUrl','physicsUrl','maskUrl','groupsUrl','policyUrl']){
      const name=path.posix.basename(config[key]), digest=hashes[name];
      if(digest)urls[key]=(quality?'/perf/quality/maps/':'/perf/maps/')+id+'/'+name+'?v='+digest;
    }
    const cosmetics={localSkinPaths,localAgentPaths,localMusicKits};
    const compactPath=path.join(root,id,'compact-manifest.json');
    const compact=fs.existsSync(compactPath)?JSON.parse(fs.readFileSync(compactPath,'utf8')):null;
    const compactMeta=compact?{
      compactRender:compact.mesh?{url:'/perf/maps/'+id+'/'+compact.mesh.path+'?v='+compact.mesh.sha256,bytes:compact.mesh.bytes,sha256:compact.mesh.sha256}:null,
      compactPhysics:compact.physics?{url:'/perf/maps/'+id+'/physics.vidx?v='+compact.physics.sha256,bytes:compact.physics.bytes,sha256:compact.physics.sha256}:null,
    }:{};
    const hasLocalDust2=!disableLocalAssets&&fs.existsSync(path.join(publicDir,'assets/map-cs2/dust2-web.gltf'))&&fs.existsSync(path.join(publicDir,'assets/map-cs2/dust2-6016e2c1497d.bin'));
    const hasDesktopDust2=id==='de_dust2'&&(hasLocalDust2||Boolean(deliveryConfig.assetBaseURL));
    const hasMobileDust2=hasDesktopDust2&&(Boolean(deliveryConfig.assetBaseURL)||fs.existsSync(path.join(publicDir,'assets/map-mobile/dust2-clear.gltf')));
    const texturedMeta=hasDesktopDust2?{
      texturedRender:{
        desktopUrl:'/perf/assets/map-cs2/dust2-web.gltf?v=e4f2b2d3903c',
        mobileUrl:hasMobileDust2?'/perf/assets/map-mobile/dust2-clear.gltf':'/perf/assets/map-cs2/dust2-web.gltf?v=e4f2b2d3903c',
      },
    }:{};
    if(quality)return {...config,...urls,...cosmetics,flatOnly:false,graphicsMode:'quality',renderUrl:'/perf/quality/maps/'+id+'/render/map.gltf'};
    return {...config,...urls,...cosmetics,...compactMeta,...texturedMeta,flatOnly:true,...(fs.existsSync(remap)?{flatBreakableVisuals:JSON.parse(fs.readFileSync(remap))}:{})};
  });
}
function safePath(base,tail){
  if(tail.split('/').some(s=>!s||s==='.'||s==='..')||/[\\%:\x00-\x1f]/.test(tail))return null;
  const result=path.resolve(base,tail);
  return result.startsWith(base+path.sep)?result:null;
}
const server=http.createServer(async(req,res)=>{
 try{
  applyCors(req,res);
  if(allowedOrigins&&req.method==='OPTIONS'){res.writeHead(204).end();return;}
  const url=new URL(req.url,'http://localhost');
  let p=url.pathname;
  if(req.method==='POST'){
    if(!controlPlaneUrl){json(res,404,{ok:false,code:'CONTROL_PLANE_DISABLED',message:'control plane mode is not enabled'});return;}
    const clientForwardHeaders={...(req.headers['x-forwarded-for']?{'X-Forwarded-For':req.headers['x-forwarded-for']}:{'X-Forwarded-For':req.socket?.remoteAddress||''})};
    if(p==='/perf/api/quick-join'){
      const body=await readJsonBody(req);
      const {status,ok,data}=await fetchControlPlane('/api/v1/quick-join',{method:'POST',headers:clientForwardHeaders,body:JSON.stringify(body)});
      if(!ok){json(res,status,data);return;}
      const mode=data.mode==='deathmatch'?'deathmatch':'defuse';
      const params=data.action==='join'
        ? new URLSearchParams({room:data.roomCode,join:'1',matchMode:mode})
        : new URLSearchParams({autostart:'1',matchMode:mode,room:data.roomCode});
      json(res,status,{...data,joinUrl:'/perf/play/'+data.mapId+'/?'+params});return;
    }
    if(p==='/perf/api/rooms'){
      const body=await readJsonBody(req);
      const {status,ok,data}=await fetchControlPlane('/api/v1/rooms',{method:'POST',headers:clientForwardHeaders,body:JSON.stringify(body)});
      if(!ok){json(res,status,data);return;}
      const params=new URLSearchParams({autostart:'1',matchMode:data.mode==='deathmatch'?'deathmatch':'defuse',room:data.roomCode});
      json(res,status,{...data,joinUrl:'/perf/play/'+data.mapId+'/?'+params});return;
    }
    const joinMatch=/^\/perf\/api\/rooms\/([A-Z0-9]{4,12})\/join$/i.exec(p);
    if(joinMatch){
      const body=await readJsonBody(req);
      const code=joinMatch[1].toUpperCase();
      const {status,ok,data}=await fetchControlPlane('/api/v1/rooms/'+code+'/join',{method:'POST',headers:clientForwardHeaders,body:JSON.stringify(body)});
      if(!ok){json(res,status,data);return;}
      const params=new URLSearchParams({room:data.roomCode,join:'1',matchMode:data.mode==='deathmatch'?'deathmatch':'defuse'});
      json(res,status,{...data,joinUrl:'/perf/play/'+data.mapId+'/?'+params});return;
    }
    res.writeHead(404).end();return;
  }
  if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405).end();return;}
  const requestPath=req.url.split('?')[0];
  if(/^\/perf\/(?:ui|mode-previews)\//.test(requestPath) && /(?:^|\/)\.{1,2}(?:\/|$)|[%\\]/.test(requestPath)){
    res.writeHead(404).end();return;
  }
  if(p==='/perf'||p==='/'){
    if(logicGatewayOnly){json(res,404,{ok:false,error:'UI_DISABLED_LOGIC_GATEWAY'});return;}
    res.writeHead(302,{Location:'/perf/'}).end();return;
  }
  if(p==='/perf/'){
    if(logicGatewayOnly){json(res,404,{ok:false,error:'UI_DISABLED_LOGIC_GATEWAY'});return;}
    file(req,res,path.join(reviewAssets,'mode-ui/index.html'));return;
  }
  if(p==='/perf/rooms.json'){json(res,200,await performanceRooms());return;}
  if(p==='/perf/quick-join.json'){json(res,200,await quickJoinRecommendation(url.searchParams.get('mode'),url.searchParams.get('preferredMap')));return;}
  if(p==='/perf/find-room.json'){json(res,200,await findRoomByCode(url.searchParams.get('code')));return;}
  if(p==='/perf/graphics.json'){
    json(res,200,{maps:PERFORMANCE_MAPS.filter(({id})=>maps.has(id)).map(({id})=>({
      id,performanceURL:'/perf/play/'+id+'/',qualityURL:qualityPacks.has(id)?'/perf/quality/play/'+id+'/':null,
      qualitySource:qualityPacks.has(id)?'local':null
    }))});return;
  }
  const review=/^\/perf\/(ui|mode-previews)\/(.+)$/.exec(p);
  if(review){
    if(logicGatewayOnly || (disableLocalAssets && review[1]==='mode-previews')){json(res,404,{ok:false,error:logicGatewayOnly?'UI_DISABLED_LOGIC_GATEWAY':'LOCAL_ASSETS_DISABLED'});return;}
    const [,kind,name]=review;
    const allowed=kind==='ui'?/\.(?:css|js|mjs|woff2|ttf|svg|png|webp|jpe?g|avif)$/i:/\.(?:webp|png|jpe?g|avif)$/i;
    const directory=path.join(reviewAssets,kind==='ui'?'mode-ui':'mode-previews');
    const isPreviewManifest=kind==='mode-previews'&&name==='previews.json';
    const location=allowed.test(name)||isPreviewManifest?safePath(directory,name):null;
    if(!location||!fs.existsSync(location)||!fs.realpathSync(location).startsWith(fs.realpathSync(directory)+path.sep)){res.writeHead(404).end();return;}
    res.setHeader('X-Content-Type-Options','nosniff');
    file(req,res,location);return;
  }
  const quality=p.startsWith('/perf/quality/');
  if(quality){
    p='/perf/'+p.slice('/perf/quality/'.length);
    const asset=/^\/perf\/maps\/(de_[a-z0-9]+)\/(.+)$/.exec(p);
    if(asset){
      if(disableLocalAssets){json(res,404,{ok:false,error:'LOCAL_ASSETS_DISABLED'});return;}
      const [,id,tail]=asset,pack=qualityPacks.get(id);
      if(!pack){res.writeHead(404).end();return;}
      if(tail==='render-manifest.json'){json(res,200,pack.manifest);return;}
      if(tail==='transport-manifest.json' && pack.transport){json(res,200,pack.transport.manifest);return;}
      if(tail.startsWith('render/')){
        let name;try{name=decodeURIComponent(tail.slice(7));}catch{res.writeHead(404).end();return;}
        const entry=pack.files.get(name),version=url.searchParams.get('v');
        if(!entry || (version!==null && version!==entry.sha256)){res.writeHead(404).end();return;}
        file(req,res,path.join(pack.raw,name),version!==null);return;
      }
      if(tail.startsWith('transport/')){
        const location=pack.transport?.objects.get(tail.slice(10));
        if(!location || url.search){res.writeHead(404).end();return;}
        file(req,res,location,true);return;
      }
    } else if(!/^\/perf\/(?:play\/de_[a-z0-9]+\/|(?:radars|previews)\/|download-config\.json$)/.test(p)){
      res.writeHead(404).end();return;
    }
  }
  if(p==='/perf/catalog.json'){
    if(disableLocalAssets){json(res,404,{ok:false,error:'LOCAL_ASSETS_DISABLED'});return;}
    file(req,res,catalogPath);return;
  }
  if(p==='/perf/ready'){json(res,draining?503:200,{ok:true,ready:!draining,draining,maps:maps.size,maxWorkers,workerMaxRooms:Number(workerMaxRooms),controlPlane:!!controlPlaneUrl,disableLocalAssets,logicGatewayOnly});return;}
  if(p==='/perf/health'){json(res,200,{ok:true,ready:!draining,draining,disableLocalAssets,logicGatewayOnly,maxWorkers,workerMaxRooms:Number(workerMaxRooms),controlPlane:!!controlPlaneUrl,maps:maps.size,workers:[...workers].map(([id,w])=>({id,active:w.connections>0,connections:w.connections}))});return;}
  if(p==='/perf/api/maps'){
    if(controlPlaneUrl){
      const {status,data}=await fetchControlPlane('/api/v1/maps');
      json(res,status,data);return;
    }
    const localPools=PERFORMANCE_MAPS.filter(({id})=>maps.has(id)).map(({id})=>{
      const w=workers.get(id);
      return {mapId:id,status:w?'ready':'warm',activeWorkers:w?1:0,drainingWorkers:0,rooms:w?1:0,maxRooms:Number(workerMaxRooms),availableSlots:Number(workerMaxRooms),humans:w?.connections||0,bestTickP99Ms:0};
    });
    json(res,200,{ok:true,maps:localPools,totalMaps:localPools.length,federated:false});return;
  }
  if(p==='/perf/metrics'){
    res.writeHead(200,{'Content-Type':'text/plain; version=0.0.4; charset=utf-8','Cache-Control':'no-store'});
    if(req.method==='HEAD'){res.end();return;}
    let localConns=0;for(const w of workers.values())localConns+=w.connections||0;
    res.end([
      '# HELP cs2_gateway_up Lobby gateway availability.',
      '# TYPE cs2_gateway_up gauge',
      'cs2_gateway_up 1',
      '# HELP cs2_gateway_ready Whether lobby gateway is ready.',
      '# TYPE cs2_gateway_ready gauge',
      `cs2_gateway_ready ${draining?0:1}`,
      '# HELP cs2_gateway_maps Loaded map entries in lobby gateway.',
      '# TYPE cs2_gateway_maps gauge',
      `cs2_gateway_maps ${maps.size}`,
      '# HELP cs2_gateway_local_workers Running local map worker child processes.',
      '# TYPE cs2_gateway_local_workers gauge',
      `cs2_gateway_local_workers ${workers.size}`,
      '# HELP cs2_gateway_local_ws_connections Active proxied WebSocket connections in local mode.',
      '# TYPE cs2_gateway_local_ws_connections gauge',
      `cs2_gateway_local_ws_connections ${localConns}`,
      '',
    ].join('\n'));return;
  }
  if(/^\/perf\/download-config(?:-1\.3\.0)?\.json$/.test(p)){
    json(res,200,deliveryConfig);return;
  }
  const asset=/^\/perf\/(assets|icons)\/(.+)$/.exec(p);
  if(asset){
    if(disableLocalAssets){json(res,404,{ok:false,error:'LOCAL_ASSETS_DISABLED'});return;}
    const tail=asset[1]+'/'+decodeURIComponent(asset[2]);
    for(const base of [dist,publicDir]){const location=safePath(base,tail);if(location&&(fs.existsSync(location)||fs.existsSync(location+'.br')||fs.existsSync(location+'.gz'))){file(req,res,location);return;}}
  }
  const radar=/^\/perf\/(radars|previews)\/(transforms\.json|de_[a-z0-9]+\.png)$/.exec(p);
  if(radar&&(radar[2]==='transforms.json'||maps.has(radar[2].slice(0,-4)))){
    if(disableLocalAssets){json(res,404,{ok:false,error:'LOCAL_ASSETS_DISABLED'});return;}
    file(req,res,path.join(root,'radars',radar[2]));return;
  }
  const play=/^\/perf\/play\/(de_[a-z0-9]+)\/(|private-map\.json|health)$/.exec(p);
  if(play&&maps.has(play[1])&&(!quality||qualityPacks.has(play[1]))){
    if(!play[2]){
      if(logicGatewayOnly){json(res,404,{ok:false,error:'UI_DISABLED_LOGIC_GATEWAY'});return;}
      let html=fs.readFileSync(path.join(dist,'private.html'),'utf8').replace('<!-- MAP_LIBRARY_BASE -->','<base href="/perf/">');
      if(!html.includes('<base href="/perf/">'))html=html.replace('<head>','<head><base href="/perf/">');
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache'}).end(req.method==='HEAD'?undefined:html);return;
    }
    const remoteOrigin=controlPlaneUrl?await remoteWorkerOriginForMap(play[1]):null;
    if(remoteOrigin){
      json(res,200,play[2]==='private-map.json'?await mapConfig(play[1],remoteOrigin,quality):await fetch(remoteOrigin+'/health').then(r=>r.json()));return;
    }
    const w=await ensureWorker(play[1]);
    json(res,200,play[2]==='private-map.json'?await mapConfig(play[1],w,quality):await fetch('http://127.0.0.1:'+w.port+'/health').then(r=>r.json()));return;
  }
  const resource=/^\/perf\/(?:play\/(de_[a-z0-9]+)\/)?maps\/(de_[a-z0-9]+)\/(map\.json|nav\.json|physics\.f32|physics\.vidx|physics-mask\.u8|physics-groups\.json|entity-collision-policy\.json|render-manifest\.json|render\/map\.(?:bin|gltf|mgp))$/.exec(p);
  if(resource&&maps.has(resource[2])&&(!resource[1]||resource[1]===resource[2])){
    if(disableLocalAssets){json(res,404,{ok:false,error:'LOCAL_ASSETS_DISABLED'});return;}
    const [,,id,name]=resource,dir=path.join(root,id);
    const inCompiled=['map.json','nav.json','physics.f32','physics.vidx','physics-mask.u8','physics-groups.json'].includes(name);
    let immutable=false;
    if(url.searchParams.has('v')){
      let digest;
      if(name==='render/map.mgp'||name==='physics.vidx'){
        const cp=path.join(dir,'compact-manifest.json');
        const cm=fs.existsSync(cp)?JSON.parse(fs.readFileSync(cp,'utf8')):null;
        digest=name==='render/map.mgp'?cm?.mesh?.sha256:cm?.physics?.sha256;
      }else if(name.startsWith('render/')){
        digest=JSON.parse(fs.readFileSync(path.join(dir,'render-manifest.json'))).files.find(x=>x.path===name.slice(7))?.sha256;
      }else{
        digest=JSON.parse(fs.readFileSync(path.join(dir,'READY.json'))).gameplayHashes?.[name];
      }
      if(!digest || digest!==url.searchParams.get('v')){res.writeHead(404).end();return;}
      immutable=true;
    }
    file(req,res,path.join(dir,inCompiled?'compiled':'',name),immutable);return;
  }
  res.writeHead(404).end();
 }catch(error){if(!res.headersSent)json(res,503,{error:error.message});else res.destroy();}
});
server.on('upgrade',async(req,socket,head)=>{
  if(draining){socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');return;}
  if(allowedOrigins instanceof Set && req.headers.origin && !allowedOrigins.has(req.headers.origin)){
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;
  }
  const match=/^\/perf\/(?:quality\/)?play\/(de_[a-z0-9]+)\/ws$/.exec(req.url);
  if(!match||!maps.has(match[1])||(req.url.startsWith('/perf/quality/')&&!qualityPacks.has(match[1]))){socket.destroy();return;}
  try{
    const w=await ensureWorker(match[1]);if(socket.destroyed)return;
    w.connections++;w.touched=Date.now();w.directoryRead=null;const upstream=net.connect(w.port,'127.0.0.1');
    socket.once('close',()=>{w.connections--;w.touched=Date.now();w.directoryRead=null;upstream.destroy();});
    upstream.on('error',()=>socket.destroy());upstream.on('close',()=>socket.destroy());socket.on('error',()=>upstream.destroy());
    upstream.once('connect',()=>{
      const headers=['GET /ws HTTP/1.1'];
      for(let i=0;i<req.rawHeaders.length;i+=2)headers.push(req.rawHeaders[i]+': '+req.rawHeaders[i+1]);
      upstream.write(headers.join('\r\n')+'\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream).pipe(socket);
    });
  }catch{socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');}
});
server.listen(port,host,()=>{
  console.log('Performance map pool: http://127.0.0.1:'+server.address().port+'/perf/');
  for(const id of warmMaps)ensureWorker(id).catch(()=>{});
});
process.on('SIGUSR2',()=>{draining=true;for(const w of workers.values())if(!w.retiring)w.child.kill('SIGUSR2');});
function shutdown(){clearInterval(reap);for(const w of workers.values())w.child.kill();server.close();}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,shutdown);
if(process.send)process.once('disconnect',shutdown);
