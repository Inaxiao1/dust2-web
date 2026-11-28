/** Loopback nine-map gateway. Start and retire game workers on demand. */
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {WebSocketServer, WebSocket} from 'ws';
import {createRtcGateway} from './rtc-gateway.js';
import {createTelemetryStore, percentiles} from './telemetry-store.js';
import {PERFORMANCE_MAPS, isPerformanceMap} from '../shared/performance-map-pool.js';
import {findQualityPacks} from './performance-quality.js';
import {SKINS} from '../shared/skins.js';
import {packagedAgentAssets} from '../shared/packaged-agent-assets.js';
import {packagedMusicAssets} from '../shared/packaged-music-assets.js';
import {packagedSkinAssets} from '../shared/packaged-skin-assets.js';
import {validateDownloadConfig} from '../shared/download-config.js';
import {buildOfflineMapManifests} from './offline-map-manifests.js';

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
const telemetryStore=createTelemetryStore({dir:process.env.PERF_TELEMETRY_DIR||''});
const telemetryToken=crypto.randomBytes(24).toString('hex');
function isLoopbackReq(req){
  if(req.headers['x-forwarded-for']||req.headers['x-real-ip'])return false;
  const addr=req.socket?.remoteAddress||'';
  return addr==='127.0.0.1'||addr==='::1'||addr==='::ffff:127.0.0.1';
}
const envDeliveryConfig=validateDownloadConfig({
  schemaVersion:1,
  assetBaseURL:process.env.PERF_ASSET_BASE_URL||process.env.DUST2_ASSET_DOWNLOAD_BASE||null,
  mapBaseURL:process.env.PERF_MAP_BASE_URL||process.env.DUSTII_MAP_DOWNLOAD_BASE||null,
  fallbackToGameServer:(process.env.PERF_DOWNLOAD_FALLBACK||process.env.DUST2_DOWNLOAD_FALLBACK)==='true',
},'http://127.0.0.1/');
let deliveryConfig=envDeliveryConfig;
const preferredWsOrigins=(()=>{
  const raw=(process.env.PERF_WS_ORIGINS||'').trim();
  if(!raw)return [];
  const out=[];
  for(const item of raw.split(',').map(v=>v.trim()).filter(Boolean)){
    try{
      const u=new URL(item);
      if(u.protocol!=='https:'&&u.protocol!=='http:')continue;
      if(u.username||u.password)continue;
      if(!out.includes(u.origin))out.push(u.origin);
    }catch{}
  }
  return out.slice(0,4);
})();
const nodeId=(process.env.PERF_NODE_ID||'local').trim().replace(/[^a-zA-Z0-9_-]/g,'').slice(0,32)||'local';
const envNodeLabel=(process.env.PERF_NODE_LABEL||'').trim().slice(0,24);
function cleanHttpOrigin(raw){
  if(typeof raw!=='string'||!raw.trim())return '';
  try{
    const u=new URL(raw.trim());
    if((u.protocol==='https:'||u.protocol==='http:')&&!u.username&&!u.password)return u.origin;
  }catch{}
  return '';
}
const envPublicWsOrigin=cleanHttpOrigin(process.env.PERF_PUBLIC_WS_ORIGIN||'')||preferredWsOrigins[0]||'';
const envMaxHumans=Math.max(0,Math.floor(Number(process.env.PERF_MAX_HUMANS)||0));
const envHardMaxHumans=envMaxHumans>0?Math.max(envMaxHumans,Math.floor(Number(process.env.PERF_HARD_MAX_HUMANS)||0)||envMaxHumans):0;
const envMaxLoadPerCpu=Math.max(0,Number(process.env.PERF_MAX_LOAD_PER_CPU)||0);
const envNodeWeight=Math.max(0.1,Math.min(10,Number(process.env.PERF_NODE_WEIGHT)||1));
function makePeerState({id,label,origin,publicWsOrigin='',enabled=true,acceptNewRooms=true,maxHumans=0,hardMaxHumans=0,weight=1},prev=null){
  const keepLive=prev&&prev.origin===origin;
  return {
    id,
    label:(label||id).slice(0,24),
    origin,
    publicWsOrigin:publicWsOrigin||(keepLive?prev.publicWsOrigin:origin)||origin,
    cfgEnabled:enabled!==false,
    cfgAcceptNewRooms:acceptNewRooms!==false,
    cfgMaxHumans:Math.max(0,Math.floor(Number(maxHumans)||0)),
    cfgHardMaxHumans:Math.max(0,Math.floor(Number(hardMaxHumans)||0)),
    weight:Math.max(0.1,Math.min(10,Number(weight)||1)),
    healthy:keepLive?prev.healthy:false,
    ready:keepLive?prev.ready:false,
    remoteEnabled:keepLive?prev.remoteEnabled:true,
    remoteAcceptNewRooms:keepLive?prev.remoteAcceptNewRooms:true,
    draining:keepLive?prev.draining:false,
    humans:keepLive?prev.humans:0,
    maxHumans:keepLive?prev.maxHumans:0,
    hardMaxHumans:keepLive?prev.hardMaxHumans:0,
    overloaded:keepLive?prev.overloaded:false,
    full:keepLive?prev.full:false,
    hardFull:keepLive?prev.hardFull:false,
    load1m:keepLive?prev.load1m:0,
    cpus:keepLive?prev.cpus:1,
    rooms:keepLive?prev.rooms:[],
    failCount:keepLive?prev.failCount:0,
    updatedAt:keepLive?prev.updatedAt:0,
  };
}
const envClusterPeers=(()=>{
  const raw=(process.env.PERF_CLUSTER_PEERS||'').trim();
  if(!raw)return [];
  const out=[];
  const seen=new Set([nodeId]);
  for(const entry of raw.split(',').map(v=>v.trim()).filter(Boolean)){
    const parts=entry.split('|').map(v=>v.trim());
    let id='',label='',originRaw='';
    if(parts.length>=3){[id,label,originRaw]=parts;}
    else if(parts.length===2){[id,originRaw]=parts;}
    else{originRaw=parts[0];}
    const origin=cleanHttpOrigin(originRaw);
    if(!origin)continue;
    const hostId=new URL(origin).hostname.replace(/[^a-zA-Z0-9_-]/g,'');
    const cleanId=(id||hostId).slice(0,32);
    if(!cleanId||seen.has(cleanId))continue;
    seen.add(cleanId);
    out.push(makePeerState({id:cleanId,label:label||cleanId,origin}));
  }
  return out;
})();
const runtimeLocal={
  label:envNodeLabel,
  publicWsOrigin:envPublicWsOrigin,
  enabled:true,
  acceptNewRooms:true,
  maxHumans:envMaxHumans,
  hardMaxHumans:envHardMaxHumans,
  maxLoadPerCpu:envMaxLoadPerCpu,
  weight:envNodeWeight,
};
let runtimeRtcEnabled=true;
let clusterPeers=[...envClusterPeers];
const clusterConfigPath=(process.env.PERF_CLUSTER_CONFIG||'').trim()?path.resolve(process.env.PERF_CLUSTER_CONFIG.trim()):'';
const clusterConfigMeta={path:clusterConfigPath||null,version:0,mtimeMs:0,loadedAt:0,error:null};
function loadClusterConfig(force=false){
  if(!clusterConfigPath)return false;
  let stat;
  try{stat=fs.statSync(clusterConfigPath);}catch(err){
    if(force)clusterConfigMeta.error='config_not_found';
    return false;
  }
  if(!force&&stat.mtimeMs===clusterConfigMeta.mtimeMs)return false;
  let parsed;
  try{
    parsed=JSON.parse(fs.readFileSync(clusterConfigPath,'utf8'));
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('root must be object');
  }catch(err){
    clusterConfigMeta.error=String(err?.message||'invalid_json');
    console.warn(`[cluster-config] ignored invalid config at ${clusterConfigPath}: ${clusterConfigMeta.error}`);
    return false;
  }
  // 1. Optional CDN override
  if(parsed.cdn&&typeof parsed.cdn==='object'){
    try{
      deliveryConfig=validateDownloadConfig({
        schemaVersion:1,
        assetBaseURL:parsed.cdn.assetBaseURL??envDeliveryConfig.assetBaseURL,
        mapBaseURL:parsed.cdn.mapBaseURL??envDeliveryConfig.mapBaseURL,
        fallbackToGameServer:typeof parsed.cdn.fallbackToGameServer==='boolean'?parsed.cdn.fallbackToGameServer:envDeliveryConfig.fallbackToGameServer,
      },'http://127.0.0.1/');
    }catch(err){
      console.warn(`[cluster-config] invalid cdn block ignored: ${err?.message||err}`);
    }
  }else{
    deliveryConfig=envDeliveryConfig;
  }
  // 2. Optional transport override
  if(parsed.transport&&typeof parsed.transport.rtcEnabled==='boolean'){
    runtimeRtcEnabled=parsed.transport.rtcEnabled;
  }else{
    runtimeRtcEnabled=true;
  }
  // 3. Nodes list (applies matching nodeId to local runtime + builds dynamic peer list)
  if(Array.isArray(parsed.nodes)){
    const prevById=new Map(clusterPeers.map(p=>[p.id,p]));
    const nextPeers=[];
    const seen=new Set();
    let matchedLocal=false;
    for(const item of parsed.nodes){
      if(!item||typeof item!=='object')continue;
      const cleanId=String(item.id||'').trim().replace(/[^a-zA-Z0-9_-]/g,'').slice(0,32);
      if(!cleanId||seen.has(cleanId))continue;
      seen.add(cleanId);
      if(cleanId===nodeId){
        matchedLocal=true;
        const maxH=item.maxHumans!==undefined?Math.max(0,Math.floor(Number(item.maxHumans)||0)):envMaxHumans;
        const hardH=item.hardMaxHumans!==undefined
          ?(maxH>0?Math.max(maxH,Math.floor(Number(item.hardMaxHumans)||0)||maxH):Math.max(0,Math.floor(Number(item.hardMaxHumans)||0)))
          :(maxH>0?Math.max(maxH,envHardMaxHumans||maxH):0);
        runtimeLocal.label=typeof item.label==='string'&&item.label.trim()?item.label.trim().slice(0,24):envNodeLabel;
        runtimeLocal.publicWsOrigin=cleanHttpOrigin(item.publicWsOrigin||item.origin||'')||envPublicWsOrigin;
        runtimeLocal.enabled=item.enabled!==false;
        runtimeLocal.acceptNewRooms=item.acceptNewRooms!==false;
        runtimeLocal.maxHumans=maxH;
        runtimeLocal.hardMaxHumans=hardH;
        runtimeLocal.maxLoadPerCpu=item.maxLoadPerCpu!==undefined?Math.max(0,Number(item.maxLoadPerCpu)||0):envMaxLoadPerCpu;
        runtimeLocal.weight=item.weight!==undefined?Math.max(0.1,Math.min(10,Number(item.weight)||1)):envNodeWeight;
        continue;
      }
      const origin=cleanHttpOrigin(item.origin||item.publicWsOrigin||'');
      if(!origin)continue;
      const pubWs=cleanHttpOrigin(item.publicWsOrigin||'')||origin;
      nextPeers.push(makePeerState({
        id:cleanId,
        label:typeof item.label==='string'&&item.label.trim()?item.label.trim():cleanId,
        origin,
        publicWsOrigin:pubWs,
        enabled:item.enabled!==false,
        acceptNewRooms:item.acceptNewRooms!==false,
        maxHumans:item.maxHumans,
        hardMaxHumans:item.hardMaxHumans,
        weight:item.weight,
      },prevById.get(cleanId)||null));
    }
    if(!matchedLocal){
      runtimeLocal.label=envNodeLabel;
      runtimeLocal.publicWsOrigin=envPublicWsOrigin;
      runtimeLocal.enabled=true;
      runtimeLocal.acceptNewRooms=true;
      runtimeLocal.maxHumans=envMaxHumans;
      runtimeLocal.hardMaxHumans=envHardMaxHumans;
      runtimeLocal.maxLoadPerCpu=envMaxLoadPerCpu;
      runtimeLocal.weight=envNodeWeight;
    }
    const hadNewPeer=nextPeers.some(p=>p.cfgEnabled&&p.updatedAt===0);
    clusterPeers=nextPeers;
    for(const [k,peer] of clusterRoomToPeer.entries()){
      if(!nextPeers.some(p=>p.id===peer.id&&p.cfgEnabled))clusterRoomToPeer.delete(k);
    }
    if(hadNewPeer&&typeof pollClusterPeers==='function')void pollClusterPeers();
  }
  clusterConfigMeta.version=Number.isFinite(Number(parsed.version))?Number(parsed.version):(clusterConfigMeta.version+1);
  clusterConfigMeta.mtimeMs=stat.mtimeMs;
  clusterConfigMeta.loadedAt=Date.now();
  clusterConfigMeta.error=null;
  return true;
}
const clusterRoomToPeer=new Map();
const allowedOrigins=(()=>{
  const raw=process.env.PERF_ALLOWED_ORIGINS;
  if(!raw)return null;
  if(raw.trim()==='*')return '*';
  const set=new Set(raw.split(',').map(v=>v.trim()).filter(Boolean).map(v=>new URL(v).origin));
  return set.size?set:null;
})();
const catalogPath=path.join(root,'catalog.json');
let cachedOfflineManifests=null;
const maps=new Set(JSON.parse(fs.readFileSync(catalogPath)).maps.filter(m=>isPerformanceMap(m.id)).map(m=>m.id));
const reviewAssets=path.join(repo,'scripts/maps');
const qualityPacks=disableLocalAssets?new Map():findQualityPacks(root,maps,
  path.resolve(process.env.PERF_QUALITY_MAP_LIBRARY || path.join(root,'..','quality-library')),
  path.resolve(process.env.PERF_QUALITY_TRANSPORT || path.join(root,'..','quality-transport')));
const workers=new Map();
const roomToWorker=new Map();
const idleMs=Math.max(1000,Number(process.env.PERF_IDLE_MS)||120000);
const maxWorkers=Math.max(1,Math.min(32,Number(process.env.PERF_MAX_WORKERS)||4));
const defaultMaxShardsPerMap=Math.max(1,Math.min(maxWorkers,Number(process.env.PERF_MAX_SHARDS_PER_MAP)||1));
const shardTargetRooms=Math.max(1,Math.min(Number(workerMaxRooms),Number(process.env.PERF_SHARD_TARGET_ROOMS)||3));
const shardMapLimits=(()=>{
  const result=new Map();
  for(const part of (process.env.PERF_SHARD_MAPS||'').split(',').map(v=>v.trim()).filter(Boolean)){
    const [rawId,rawCount]=part.split(':').map(v=>v.trim());
    const count=Math.max(1,Math.min(maxWorkers,Number(rawCount)||2));
    if(maps.has(rawId))result.set(rawId,count);
  }
  return result;
})();
const maxShardsForMap=id=>shardMapLimits.get(id)??defaultMaxShardsPerMap;
const strictHeavyLock=process.env.PERF_STRICT_HEAVY_LOCK!==undefined?process.env.PERF_STRICT_HEAVY_LOCK==='1':maxWorkers<=2;
const heavy=new Set(['de_inferno','de_cache','de_ancient','de_train']);
const warmShardTargets=(()=>{
  const targets=new Map();
  let remaining=maxWorkers;
  for(const part of (process.env.PERF_WARM_MAPS||'').split(',').map(v=>v.trim()).filter(Boolean)){
    const [rawId,rawCount]=part.split(':').map(v=>v.trim());
    if(!maps.has(rawId)||remaining<=0)continue;
    const count=Math.max(1,Math.min(maxShardsForMap(rawId),remaining,Number(rawCount)||1));
    targets.set(rawId,count);
    remaining-=count;
  }
  return targets;
})();
let draining=false;
const allWorkers=()=>{const list=[];for(const arr of workers.values())for(const w of arr)list.push(w);return list;};
const mapWorkers=id=>workers.get(id)||[];
const isLiveWorker=w=>!!(w&&!w.retiring&&!w.child.killed&&w.child.exitCode===null&&w.child.signalCode===null);
const isReadyWorker=w=>!!(w?.port&&isLiveWorker(w));
const totalWorkerCount=()=>allWorkers().length;
const localActiveConnections=()=>{let total=0;for(const w of allWorkers())total+=w.connections||0;return total;};
function localNodeSnapshot(){
  const humans=localActiveConnections();
  const cpus=Math.max(1,os.cpus().length||1);
  const load1m=+os.loadavg()[0].toFixed(2);
  const overloaded=runtimeLocal.maxLoadPerCpu>0&&(load1m/cpus)>=runtimeLocal.maxLoadPerCpu;
  const full=runtimeLocal.maxHumans>0&&humans>=runtimeLocal.maxHumans;
  const hardFull=runtimeLocal.hardMaxHumans>0&&humans>=runtimeLocal.hardMaxHumans;
  return {
    id:nodeId,
    label:runtimeLocal.label||nodeId,
    local:true,
    enabled:runtimeLocal.enabled,
    acceptNewRooms:runtimeLocal.acceptNewRooms,
    weight:runtimeLocal.weight,
    healthy:true,
    ready:!draining&&runtimeLocal.enabled,
    draining,
    publicWsOrigin:runtimeLocal.publicWsOrigin,
    humans,
    maxHumans:runtimeLocal.maxHumans,
    hardMaxHumans:runtimeLocal.hardMaxHumans,
    availableSlots:runtimeLocal.maxHumans>0?Math.max(0,runtimeLocal.maxHumans-humans):null,
    full,
    hardFull,
    overloaded,
    load1m,
    cpus,
  };
}
function peerNodeSnapshot(peer){
  const stale=peer.updatedAt===0||(Date.now()-peer.updatedAt>15000);
  const enabled=peer.cfgEnabled!==false&&peer.remoteEnabled!==false;
  const healthy=enabled&&peer.healthy&&!stale;
  const effMaxHumans=peer.cfgMaxHumans>0
    ?(peer.maxHumans>0?Math.min(peer.cfgMaxHumans,peer.maxHumans):peer.cfgMaxHumans)
    :peer.maxHumans;
  const effHardMaxHumans=peer.cfgHardMaxHumans>0
    ?(peer.hardMaxHumans>0?Math.min(peer.cfgHardMaxHumans,peer.hardMaxHumans):peer.cfgHardMaxHumans)
    :(effMaxHumans>0?Math.max(effMaxHumans,peer.hardMaxHumans||effMaxHumans):peer.hardMaxHumans);
  const full=Boolean(peer.full||(effMaxHumans>0&&peer.humans>=effMaxHumans));
  const hardFull=Boolean(peer.hardFull||(effHardMaxHumans>0&&peer.humans>=effHardMaxHumans));
  return {
    id:peer.id,
    label:peer.label,
    local:false,
    enabled,
    acceptNewRooms:peer.cfgAcceptNewRooms!==false&&peer.remoteAcceptNewRooms!==false,
    weight:peer.weight,
    healthy,
    ready:healthy&&peer.ready,
    draining:peer.draining,
    origin:peer.origin,
    publicWsOrigin:peer.publicWsOrigin||peer.origin,
    humans:peer.humans,
    maxHumans:effMaxHumans,
    hardMaxHumans:effHardMaxHumans,
    availableSlots:effMaxHumans>0?Math.max(0,effMaxHumans-peer.humans):null,
    full,
    hardFull,
    overloaded:peer.overloaded,
    load1m:peer.load1m,
    cpus:peer.cpus,
  };
}
function buildClusterSummary(){
  const nodes=[localNodeSnapshot(),...clusterPeers.map(peerNodeSnapshot)];
  const healthyNodes=nodes.filter(n=>n.enabled!==false&&n.healthy&&n.ready&&!n.draining);
  const totalHumans=nodes.reduce((s,n)=>s+(n.humans||0),0);
  const allBounded=healthyNodes.length>0&&healthyNodes.every(n=>n.maxHumans>0);
  const totalCapacity=allBounded?healthyNodes.reduce((s,n)=>s+n.maxHumans,0):null;
  const hasEligible=rankClusterNodesForNewRoom().length>0;
  return {totalHumans,totalCapacity,full:!hasEligible,nodes};
}
function rankClusterNodesForNewRoom(){
  const nodes=[localNodeSnapshot(),...clusterPeers.map(peerNodeSnapshot)];
  const eligible=nodes.filter(n=>n.enabled!==false&&n.acceptNewRooms!==false&&n.healthy&&n.ready&&!n.draining&&!n.overloaded&&!n.full&&!n.hardFull);
  eligible.sort((a,b)=>{
    const utilA=a.maxHumans>0?(a.humans/a.maxHumans):(a.humans/100);
    const utilB=b.maxHumans>0?(b.humans/b.maxHumans):(b.humans/100);
    const wA=Math.max(0.1,Number(a.weight)||1);
    const wB=Math.max(0.1,Number(b.weight)||1);
    const cpuA=a.cpus>0?Math.max(0,(a.load1m/a.cpus)-0.65)*0.5:0;
    const cpuB=b.cpus>0?Math.max(0,(b.load1m/b.cpus)-0.65)*0.5:0;
    return ((utilA/wA)+cpuA)-((utilB/wB)+cpuB)||a.humans-b.humans;
  });
  return eligible;
}
function resolveClusterNodeById(id){
  if(!id)return null;
  if(id===nodeId)return localNodeSnapshot();
  const peer=clusterPeers.find(p=>p.id===id);
  return peer?peerNodeSnapshot(peer):null;
}
function resolveWsOriginsForRequest(mapId,requestedNodeId='',requestedRoomCode=''){
  const cleanRoom=normalizeRoomCode(requestedRoomCode);
  if(cleanRoom){
    const localWorker=roomToWorker.get(mapId+':'+cleanRoom);
    if(localWorker&&isLiveWorker(localWorker)){
      return {wsOrigins:runtimeLocal.publicWsOrigin?[runtimeLocal.publicWsOrigin]:preferredWsOrigins,node:localNodeSnapshot(),clusterFull:false};
    }
    const peer=clusterRoomToPeer.get(mapId+':'+cleanRoom);
    if(peer){
      const snap=peerNodeSnapshot(peer);
      if(snap.healthy)return {wsOrigins:[snap.publicWsOrigin],node:snap,clusterFull:false};
    }
  }
  if(requestedNodeId){
    const target=resolveClusterNodeById(requestedNodeId);
    if(target&&target.enabled!==false&&target.healthy&&target.ready&&!target.draining){
      const origins=[];
      if(target.publicWsOrigin)origins.push(target.publicWsOrigin);
      return {wsOrigins:origins.length?origins:preferredWsOrigins,node:target,clusterFull:false};
    }
  }
  if(!clusterPeers.length){
    const local=localNodeSnapshot();
    const full=!local.enabled||!local.acceptNewRooms||local.draining||local.full||local.hardFull||local.overloaded;
    return {wsOrigins:runtimeLocal.publicWsOrigin?[runtimeLocal.publicWsOrigin,...preferredWsOrigins.filter(o=>o!==runtimeLocal.publicWsOrigin)]:preferredWsOrigins,node:local,clusterFull:full};
  }
  const ranked=rankClusterNodesForNewRoom();
  if(ranked.length){
    const origins=[];
    for(const n of ranked){
      if(n.publicWsOrigin&&!origins.includes(n.publicWsOrigin))origins.push(n.publicWsOrigin);
    }
    if(ranked[0].local){
      for(const o of preferredWsOrigins){if(!origins.includes(o))origins.push(o);}
    }
    return {wsOrigins:origins.slice(0,4),node:ranked[0],clusterFull:false};
  }
  return {wsOrigins:preferredWsOrigins,node:localNodeSnapshot(),clusterFull:true};
}
let clusterPollRunning=false;
async function pollClusterPeers(){
  const activePeers=clusterPeers.filter(p=>p.cfgEnabled!==false);
  if(!activePeers.length||clusterPollRunning)return;
  clusterPollRunning=true;
  try{
    await Promise.allSettled(activePeers.map(async(peer)=>{
      try{
        const [hRes,rRes]=await Promise.all([
          fetch(peer.origin+'/perf/health?local=1',{cache:'no-store',signal:AbortSignal.timeout(2500)}),
          fetch(peer.origin+'/perf/rooms.json?local=1',{cache:'no-store',signal:AbortSignal.timeout(2500)}),
        ]);
        if(!hRes.ok||!rRes.ok)throw Error('peer-status');
        const [health,dir]=await Promise.all([hRes.json(),rRes.json()]);
        const node=health.node||{};
        peer.healthy=true;
        peer.failCount=0;
        peer.remoteEnabled=node.enabled!==false;
        peer.remoteAcceptNewRooms=node.acceptNewRooms!==false;
        peer.ready=health.ready===true&&health.draining!==true&&peer.remoteEnabled;
        peer.draining=health.draining===true;
        peer.humans=Number.isFinite(node.humans)?node.humans:(Number(health.network?.humans)||0);
        peer.maxHumans=Number.isFinite(node.maxHumans)?node.maxHumans:0;
        peer.hardMaxHumans=Number.isFinite(node.hardMaxHumans)?node.hardMaxHumans:peer.maxHumans;
        peer.full=Boolean(node.full||(peer.maxHumans>0&&peer.humans>=peer.maxHumans));
        peer.hardFull=Boolean(node.hardFull||(peer.hardMaxHumans>0&&peer.humans>=peer.hardMaxHumans));
        peer.overloaded=Boolean(node.overloaded);
        peer.load1m=Number.isFinite(node.load1m)?node.load1m:0;
        peer.cpus=Number.isFinite(node.cpus)&&node.cpus>0?node.cpus:1;
        if(typeof node.publicWsOrigin==='string'&&node.publicWsOrigin)peer.publicWsOrigin=node.publicWsOrigin;
        peer.rooms=Array.isArray(dir.rooms)?dir.rooms:[];
        peer.updatedAt=Date.now();
      }catch{
        peer.failCount++;
        if(peer.failCount>=2){peer.healthy=false;peer.rooms=[];}
      }
    }));
    clusterRoomToPeer.clear();
    for(const peer of clusterPeers){
      if(!peer.cfgEnabled||!peer.healthy)continue;
      for(const row of peer.rooms){
        if(row?.mapId&&row?.code)clusterRoomToPeer.set(row.mapId+':'+row.code,peer);
      }
    }
  }finally{
    clusterPollRunning=false;
  }
}
if(clusterConfigPath)loadClusterConfig(true);
const clusterPollTimer=(clusterPeers.length||clusterConfigPath)?setInterval(()=>{if(clusterPeers.length)void pollClusterPeers();},2500):null;
clusterPollTimer?.unref();
const clusterConfigTimer=clusterConfigPath?setInterval(()=>{loadClusterConfig(false);},2500):null;
clusterConfigTimer?.unref();
if(clusterPeers.length)void pollClusterPeers();
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
function evictOneIdleFor(id){
  const list=allWorkers();
  const fits=()=>totalWorkerCount()<maxWorkers && (!strictHeavyLock || !(list.length&&(heavy.has(id)||list.some(w=>heavy.has(w.id)))));
  if(fits())return Promise.resolve(true);
  return (async()=>{
    for(const w of allWorkers().sort((a,b)=>a.touched-b.touched)){
      if(w.connections||!w.port||Date.now()-w.touched<2000)continue;
      if(w.shard<(warmShardTargets.get(w.id)||0))continue;
      retire(w);await w.exited;
      const cur=allWorkers();
      if(cur.length<maxWorkers && (!strictHeavyLock || !(cur.length&&(heavy.has(id)||cur.some(x=>heavy.has(x.id))))))return true;
    }
    const cur=allWorkers();
    return cur.length<maxWorkers && (!strictHeavyLock || !(cur.length&&(heavy.has(id)||cur.some(x=>heavy.has(x.id)))));
  })();
}
async function spawnWorker(id){
  const existingList=mapWorkers(id);
  if(existingList.filter(w=>!w.retiring).length>=maxShardsForMap(id)){
    const live=existingList.find(w=>!w.retiring);
    if(live)return live.ready;
  }
  const ok=await evictOneIdleFor(id);
  if(!ok)throw Error('当前地图服务已满，请稍后再进入');
  const afterEvict=mapWorkers(id).filter(w=>!w.retiring);
  if(afterEvict.length>=maxShardsForMap(id))return afterEvict[0].ready;
  const list=workers.get(id)||[];
  if(!workers.has(id))workers.set(id,list);
  const usedShards=new Set(list.map(w=>w.shard));
  let shard=0;
  while(usedShards.has(shard))shard++;
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
    ...(server.address()?.port?{
      PERF_TELEMETRY_URL:'http://127.0.0.1:'+server.address().port+'/internal/telemetry',
      PERF_TELEMETRY_TOKEN:telemetryToken,
    }:{}),
    ...(disableLocalAssets?{
      DUST2_LOGIC_ONLY:process.env.DUST2_LOGIC_ONLY??'1',
      DUST2_SERVE_MAP_FILES:process.env.DUST2_SERVE_MAP_FILES??'0',
    }:{}),
  };
  const child=spawn(process.execPath,['server/private-map-server.js'],{cwd:repo,windowsHide:true,
    env:workerEnv,
    stdio:['ignore','pipe','inherit']});
  const w={id,shard,child,port:0,connections:0,touched:Date.now(),retiring:false,knownRooms:new Set(),lastLoad:null};
  w.exited=new Promise(resolve=>child.once('close',()=>{
    const arr=workers.get(id);
    if(arr){
      const idx=arr.indexOf(w);
      if(idx>=0)arr.splice(idx,1);
      if(!arr.length)workers.delete(id);
    }
    for(const code of w.knownRooms){
      if(roomToWorker.get(id+':'+code)===w)roomToWorker.delete(id+':'+code);
    }
    w.knownRooms.clear();
    resolve();
  }));
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
  list.push(w);return w.ready;
}
async function ensureWorker(id){
  const list=mapWorkers(id);
  const ready=list.find(w=>isReadyWorker(w));
  if(ready){ready.touched=Date.now();return ready;}
  const starting=list.find(w=>isLiveWorker(w));
  if(starting){starting.touched=Date.now();return starting.ready;}
  if(list.some(w=>w.retiring))throw Error('地图服务正在释放，请稍后重试');
  return spawnWorker(id);
}
const reap=setInterval(()=>{
  const now=Date.now();
  for(const w of allWorkers()){
    if(w.shard<(warmShardTargets.get(w.id)||0))continue;
    if(w.port&&!w.connections&&now-w.touched>idleMs)retire(w);
  }
},15000);
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
function readWorkerInternal(worker) {
  if (!worker.internalRead || worker.internalRead.expires <= Date.now()) {
    const read = {expires: Infinity};
    read.result = fetch('http://127.0.0.1:' + worker.port + '/internal-rooms.json', {signal:AbortSignal.timeout(1500)})
      .then(response => {
        if (!response.ok) throw Error('内部房间状态暂时不可用');
        return response.json();
      })
      .then(info => {
        const nextCodes = new Set(Array.isArray(info.rooms) ? info.rooms : []);
        for (const oldCode of worker.knownRooms) {
          if (!nextCodes.has(oldCode) && roomToWorker.get(worker.id + ':' + oldCode) === worker) {
            roomToWorker.delete(worker.id + ':' + oldCode);
          }
        }
        worker.knownRooms = nextCodes;
        for (const code of nextCodes) roomToWorker.set(worker.id + ':' + code, worker);
        worker.lastLoad = info;
        return info;
      })
      .finally(() => { read.expires = Date.now() + 250; });
    worker.internalRead = read;
  }
  return worker.internalRead.result;
}
function normalizeRoomCode(raw) {
  if (typeof raw !== 'string') return '';
  const code = raw.trim().toUpperCase();
  return /^[A-Z0-9]{4,12}$/.test(code) ? code : '';
}
async function findWorkerForRoom(mapId, code) {
  if (!code) return null;
  const cached = roomToWorker.get(mapId + ':' + code);
  if (cached && isReadyWorker(cached)) {
    const info = await readWorkerInternal(cached).catch(() => null);
    if (info?.rooms?.includes(code)) return cached;
  }
  const ready = mapWorkers(mapId).filter(isReadyWorker);
  if (!ready.length) return null;
  const results = await Promise.allSettled(ready.map(w => readWorkerInternal(w)));
  for (let i = 0; i < ready.length; i++) {
    if (results[i].status === 'fulfilled' && results[i].value.rooms?.includes(code)) {
      return ready[i];
    }
  }
  return null;
}
async function selectWorkerForNewRoom(mapId) {
  const live = mapWorkers(mapId).filter(isLiveWorker);
  if (!live.length) return spawnWorker(mapId);
  const ready = [];
  for (const w of live) {
    if (w.port) ready.push(w);
    else {
      try { ready.push(await w.ready); } catch {}
    }
  }
  if (!ready.length) return spawnWorker(mapId);
  const states = await Promise.allSettled(ready.map(w => readWorkerInternal(w)));
  let best = null, bestScore = Infinity, bestRooms = Infinity, bestTick = Infinity;
  for (let i = 0; i < ready.length; i++) {
    const w = ready[i];
    const info = states[i].status === 'fulfilled' ? states[i].value : (w.lastLoad || { totalRooms: 0, maxRooms: Number(workerMaxRooms), humans: w.connections, bots: 0, tickP95Ms: 0 });
    const full = info.totalRooms >= (info.maxRooms || Number(workerMaxRooms));
    const score = (full ? 100000 : 0) + info.totalRooms * 10 + (info.bots || 0) + (info.humans || 0) * 0.5 + ((info.tickP95Ms || 0) > 22 ? 25 : 0);
    if (score < bestScore) {
      best = w; bestScore = score; bestRooms = info.totalRooms || 0; bestTick = info.tickP95Ms || 0;
    }
  }
  const limit = maxShardsForMap(mapId);
  const currentLive = mapWorkers(mapId).filter(isLiveWorker).length;
  const needsScale = bestRooms >= shardTargetRooms || bestTick >= 25 || bestScore >= 100000;
  if (needsScale && currentLive < limit) {
    try {
      return await spawnWorker(mapId);
    } catch {
      // Fall back to least-loaded existing shard if global worker cap is reached.
    }
  } else if (bestRooms + 1 >= shardTargetRooms && currentLive < limit && totalWorkerCount() < maxWorkers) {
    // Proactively warm the next shard in background so subsequent room creates have zero cold start.
    spawnWorker(mapId).catch(() => {});
  }
  best.touched = Date.now();
  return best;
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

async function performanceRooms({localOnly=false}={}){
  if (controlPlaneUrl) {
    const { ok, data } = await fetchControlPlane('/api/v1/rooms');
    if (!ok || !Array.isArray(data.rooms)) throw Error('控制面房间目录暂时不可用');
    const rooms = data.rooms.filter(r => maps.has(r.mapId) && r.phase !== 'matchEnded').map(decorateClusterRoom);
    rooms.sort((a,b) => Number(b.joinable)-Number(a.joinable) || b.humans-a.humans || a.id.localeCompare(b.id));
    const totalHumans = rooms.reduce((sum, r) => sum + r.humans, 0);
    const joinableRooms = rooms.filter(r => r.joinable && r.humans < r.capacity).length;
    return {rooms, totalRooms: rooms.length, totalHumans, joinableRooms, controlPlane: true};
  }
  const active = worker => isReadyWorker(worker) && worker.connections > 0;
  const occupied = [];
  for (const map of PERFORMANCE_MAPS) {
    for (const worker of mapWorkers(map.id)) {
      if (active(worker)) occupied.push({map, worker});
    }
  }
  const results = await Promise.allSettled(occupied.map(({worker}) => readWorkerRooms(worker)));
  const localSnap = localNodeSnapshot();
  const localBlocked = localSnap.draining || localSnap.hardFull;
  const rooms = [];
  let unavailable = 0, responding = 0;
  for (const [index, {map, worker}] of occupied.entries()) {
    if (!active(worker) || !mapWorkers(map.id).includes(worker)) continue;
    if (results[index].status === 'rejected') { unavailable++; continue; }
    responding++;
    for (const row of results[index].value) {
      if (row?.phase === 'matchEnded') continue;
      roomToWorker.set(map.id + ':' + row.code, worker);
      worker.knownRooms.add(row.code);
      const joinable = !localBlocked && row.joinable === true && (Number(row.humans) || 0) < (Number(row.capacity) || 10);
      rooms.push({
        ...row,
        joinable,
        id: map.id + ':' + row.code,
        mapId: map.id,
        mapName: map.name,
        mapNameZh: map.nameZh,
        qualityAvailable: qualityPacks.has(map.id),
        ...(clusterPeers.length || runtimeLocal.label ? {nodeId: localSnap.id, nodeLabel: localSnap.label, wsOrigin: localSnap.publicWsOrigin || undefined} : {}),
      });
    }
  }
  if (!localOnly && clusterPeers.length) {
    if (clusterPeers.some(p => p.cfgEnabled && p.updatedAt === 0)) await pollClusterPeers();
    const seenIds = new Set(rooms.map(r => r.id));
    for (const peer of clusterPeers) {
      const pSnap = peerNodeSnapshot(peer);
      if (!pSnap.healthy) continue;
      const peerBlocked = pSnap.draining || pSnap.hardFull;
      for (const row of peer.rooms) {
        if (!row || !maps.has(row.mapId) || row.phase === 'matchEnded') continue;
        const rid = row.mapId + ':' + row.code;
        if (seenIds.has(rid)) continue;
        seenIds.add(rid);
        const joinable = !peerBlocked && row.joinable === true && (Number(row.humans) || 0) < (Number(row.capacity) || 10);
        rooms.push({
          ...row,
          joinable,
          id: rid,
          nodeId: pSnap.id,
          nodeLabel: pSnap.label,
          wsOrigin: pSnap.publicWsOrigin,
        });
      }
    }
  }
  if (unavailable && !responding && !rooms.length) throw Error('地图房间目录暂时不可用');
  rooms.sort((a,b) => Number(b.joinable)-Number(a.joinable) || b.humans-a.humans || a.id.localeCompare(b.id));
  const totalHumans = rooms.reduce((sum, r) => sum + r.humans, 0);
  const joinableRooms = rooms.filter(r => r.joinable && r.humans < r.capacity).length;
  const cluster = !localOnly && (clusterPeers.length > 0 || runtimeLocal.maxHumans > 0 || clusterConfigPath) ? buildClusterSummary() : undefined;
  return {rooms, totalRooms: rooms.length, totalHumans, joinableRooms, ...(cluster ? {cluster} : {}), ...(unavailable ? {partial:true} : {})};
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
    const params = new URLSearchParams({ room: room.code, join: '1', matchMode: room.mode, ...(room.nodeId ? { node: room.nodeId } : {}) });
    return {
      action: 'join',
      room,
      ...(room.nodeId ? { nodeId: room.nodeId, nodeLabel: room.nodeLabel } : {}),
      joinUrl: '/perf/play/' + room.mapId + '/?' + params,
      totalRooms: directory.totalRooms,
      totalHumans: directory.totalHumans,
      joinableRooms: directory.joinableRooms,
      ...(directory.cluster ? { cluster: directory.cluster } : {}),
    };
  }
  const rankedNodes = rankClusterNodesForNewRoom();
  if (!rankedNodes.length) {
    const cluster = directory.cluster || buildClusterSummary();
    return {
      action: 'full',
      clusterFull: true,
      message: cluster.totalCapacity
        ? `当前全服在线已达上限（${cluster.totalHumans}/${cluster.totalCapacity} 人），请稍后重试。`
        : '当前服务器人数已满，请稍后重试。',
      totalRooms: directory.totalRooms,
      totalHumans: directory.totalHumans,
      joinableRooms: 0,
      cluster,
    };
  }
  const bestNode = rankedNodes[0];
  const fallbackMap = maps.has(preferredMap) ? preferredMap : (maps.has('de_dust2') ? 'de_dust2' : [...maps][0]);
  const fallbackMode = wantedMode === 'deathmatch' ? 'deathmatch' : 'defuse';
  const params = new URLSearchParams({ autostart: '1', matchMode: fallbackMode, ...(clusterPeers.length ? { node: bestNode.id } : {}) });
  return {
    action: 'create',
    mapId: fallbackMap,
    mode: fallbackMode,
    ...(clusterPeers.length ? { nodeId: bestNode.id, nodeLabel: bestNode.label } : {}),
    joinUrl: '/perf/play/' + fallbackMap + '/?' + params,
    totalRooms: directory.totalRooms,
    totalHumans: directory.totalHumans,
    joinableRooms: 0,
    ...(directory.cluster ? { cluster: directory.cluster } : {}),
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
  const params = new URLSearchParams({ room: room.code, join: '1', matchMode: room.mode, ...(room.nodeId ? { node: room.nodeId } : {}) });
  return {
    found: true,
    room,
    ...(room.nodeId ? { nodeId: room.nodeId, nodeLabel: room.nodeLabel } : {}),
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

function mapConfig(id,originOrWorker,quality,{requestedNodeId='',requestedRoomCode=''}={}){
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
    const routed=resolveWsOriginsForRequest(id,requestedNodeId,requestedRoomCode);
    const wsRouteMeta={
      ...(routed.wsOrigins.length?{wsOrigins:routed.wsOrigins}:{}),
      ...(clusterPeers.length||runtimeLocal.label?{nodeId:routed.node.id,nodeLabel:routed.node.label}:{}),
      ...(routed.clusterFull?{clusterFull:true}:{}),
      rtcEnabled:Boolean(rtcGateway&&runtimeRtcEnabled),
    };
    if(quality)return {...config,...urls,...cosmetics,...wsRouteMeta,flatOnly:false,graphicsMode:'quality',renderUrl:'/perf/quality/maps/'+id+'/render/map.gltf'};
    return {...config,...urls,...cosmetics,...compactMeta,...texturedMeta,...wsRouteMeta,flatOnly:true,...(fs.existsSync(remap)?{flatBreakableVisuals:JSON.parse(fs.readFileSync(remap))}:{})};
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
    if(p==='/internal/telemetry'){
      if(!isLoopbackReq(req)||req.headers.authorization!=='Bearer '+telemetryToken){json(res,403,{ok:false});return;}
      const body=await readJsonBody(req);
      const events=Array.isArray(body?.events)?body.events:(body&&typeof body==='object'&&body.k?[body]:[]);
      for(const ev of events.slice(0,256))telemetryStore.record(ev);
      json(res,200,{ok:true,accepted:Math.min(256,events.length)});return;
    }
    if(p==='/perf/internal/reload-config'){
      if(!isLoopbackReq(req)){json(res,403,{ok:false,error:'LOOPBACK_ONLY'});return;}
      const reloaded=loadClusterConfig(true);
      if(clusterPeers.length)await pollClusterPeers();
      json(res,200,{ok:true,reloaded,config:clusterConfigMeta,node:localNodeSnapshot(),cdn:deliveryConfig,peers:clusterPeers.map(peerNodeSnapshot)});return;
    }
    const rtcMatch=/^\/perf\/(?:quality\/)?play\/(de_[a-z0-9]+)\/rtc-offer$/.exec(p);
    if(rtcMatch){
      if(draining){json(res,503,{ok:false,error:'SERVER_DRAINING'});return;}
      if(allowedOrigins instanceof Set && req.headers.origin && !allowedOrigins.has(req.headers.origin)){
        json(res,403,{ok:false,error:'ORIGIN_NOT_ALLOWED'});return;
      }
      const mapId=rtcMatch[1];
      if(!maps.has(mapId)||(p.startsWith('/perf/quality/')&&!qualityPacks.has(mapId))){
        json(res,404,{ok:false,error:'UNKNOWN_MAP'});return;
      }
      if(!rtcGateway||!runtimeRtcEnabled){
        json(res,404,{ok:false,error:'RTC_DISABLED'});return;
      }
      const body=await readJsonBody(req);
      const {status,body:reply}=await rtcGateway.handleOffer(mapId,url.search||'',req,body);
      json(res,status,reply);return;
    }
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
  if(p==='/perf/rooms.json'){json(res,200,await performanceRooms({localOnly:url.searchParams.get('local')==='1'}));return;}
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
  if(p==='/perf/offline-maps.json'){
    if(!cachedOfflineManifests)cachedOfflineManifests=buildOfflineMapManifests(root);
    json(res,200,cachedOfflineManifests);return;
  }
  if(p==='/perf/ready'){json(res,draining?503:200,{ok:true,ready:!draining,draining,maps:maps.size,maxWorkers,workerMaxRooms:Number(workerMaxRooms),controlPlane:!!controlPlaneUrl,disableLocalAssets,logicGatewayOnly});return;}
  if(p==='/perf/internal/telemetry.json'){
    if(!isLoopbackReq(req)){json(res,403,{ok:false,error:'LOOPBACK_ONLY'});return;}
    const [network,store]=await Promise.all([refreshLiveNetwork(true),telemetryStore.summary()]);
    json(res,200,{ok:true,network,rtc:rtcGateway?rtcGateway.status():{enabled:false},...store});return;
  }
  if(p==='/perf/config.json'){
    const summary=buildClusterSummary();
    json(res,200,{
      ok:true,
      version:clusterConfigMeta.version,
      loadedAt:clusterConfigMeta.loadedAt,
      cdn:deliveryConfig,
      transport:{rtcEnabled:Boolean(rtcGateway&&runtimeRtcEnabled)},
      nodes:summary.nodes.map(n=>({
        id:n.id,label:n.label,enabled:n.enabled,acceptNewRooms:n.acceptNewRooms,weight:n.weight,
        healthy:n.healthy,ready:n.ready,humans:n.humans,maxHumans:n.maxHumans,hardMaxHumans:n.hardMaxHumans,
        publicWsOrigin:n.publicWsOrigin,
      })),
    });return;
  }
  if(p==='/perf/health'){
    const localOnly=url.searchParams.get('local')==='1';
    const network=await refreshLiveNetwork(false);
    const node=localNodeSnapshot();
    const cluster=!localOnly&&(clusterPeers.length>0||runtimeLocal.maxHumans>0||clusterConfigPath)?buildClusterSummary():undefined;
    json(res,200,{ok:true,ready:!draining&&runtimeLocal.enabled,draining,disableLocalAssets,logicGatewayOnly,maxWorkers,workerMaxRooms:Number(workerMaxRooms),shardTargetRooms,controlPlane:!!controlPlaneUrl,maps:maps.size,node,...(cluster?{cluster}:{}),...(clusterConfigPath?{config:{version:clusterConfigMeta.version,loadedAt:clusterConfigMeta.loadedAt,error:clusterConfigMeta.error}}:{}),rtc:rtcGateway&&runtimeRtcEnabled?rtcGateway.status():{enabled:false},network,workers:allWorkers().map(w=>({id:w.id,shard:w.shard,active:w.connections>0,connections:w.connections}))});return;
  }
  if(p==='/perf/api/maps'){
    if(controlPlaneUrl){
      const {status,data}=await fetchControlPlane('/api/v1/maps');
      json(res,status,data);return;
    }
    const localPools=PERFORMANCE_MAPS.filter(({id})=>maps.has(id)).map(({id})=>{
      const list=mapWorkers(id).filter(isLiveWorker);
      const humans=list.reduce((n,w)=>n+(w.connections||0),0);
      const limit=maxShardsForMap(id);
      return {mapId:id,status:list.length?'ready':'warm',activeWorkers:list.length,maxShards:limit,drainingWorkers:0,rooms:list.reduce((n,w)=>n+(w.lastLoad?.totalRooms||0),0),maxRooms:Number(workerMaxRooms)*limit,availableSlots:Math.max(0,Number(workerMaxRooms)*limit-list.reduce((n,w)=>n+(w.lastLoad?.totalRooms||0),0)),humans,bestTickP99Ms:0};
    });
    json(res,200,{ok:true,maps:localPools,totalMaps:localPools.length,federated:false});return;
  }
  if(p==='/perf/metrics'){
    res.writeHead(200,{'Content-Type':'text/plain; version=0.0.4; charset=utf-8','Cache-Control':'no-store'});
    if(req.method==='HEAD'){res.end();return;}
    const list=allWorkers();
    let localConns=0;for(const w of list)localConns+=w.connections||0;
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
      `cs2_gateway_local_workers ${list.length}`,
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
    const routeHint={requestedNodeId:url.searchParams.get('node')||'',requestedRoomCode:url.searchParams.get('room')||''};
    if(play[2]==='private-map.json'&&clusterPeers.length&&clusterPeers.some(peer=>peer.cfgEnabled&&peer.updatedAt===0)){
      await pollClusterPeers();
    }
    const remoteOrigin=controlPlaneUrl?await remoteWorkerOriginForMap(play[1]):null;
    if(remoteOrigin){
      json(res,200,play[2]==='private-map.json'?await mapConfig(play[1],remoteOrigin,quality,routeHint):await fetch(remoteOrigin+'/health').then(r=>r.json()));return;
    }
    const w=await ensureWorker(play[1]);
    json(res,200,play[2]==='private-map.json'?await mapConfig(play[1],w,quality,routeHint):await fetch('http://127.0.0.1:'+w.port+'/health').then(r=>r.json()));return;
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
const shardWss=new WebSocketServer({
  noServer:true,
  maxPayload:4096,
  perMessageDeflate:{serverNoContextTakeover:true,clientNoContextTakeover:true,threshold:256,concurrencyLimit:10,zlibDeflateOptions:{level:1,memLevel:7}},
});
const rtcAdapters=new Set();
const shardHeartbeat=setInterval(()=>{
  for(const ws of shardWss.clients){
    if(ws._cs2Alive===false){ws.terminate();continue;}
    ws._cs2Alive=false;
    ws._cs2PingAt=performance.now();
    try{ws.ping();}catch{}
  }
  for(const adapter of rtcAdapters){
    try{adapter.ping();}catch{}
  }
},15000);
shardHeartbeat.unref();

let cachedLiveNet={at:0,data:null};
function buildLiveNetworkSummary(){
  let humans=0,udp=0,ws=0;
  const allRtts=[],udpRtts=[],wsRtts=[];
  const byMap=Object.create(null);
  const ensureMap=id=>(byMap[id]||={humans:0,udp:0,ws:0,rtts:[]});
  for(const w of allWorkers()){
    const netInfo=w.lastLoad?.net;
    if(!netInfo)continue;
    const m=ensureMap(w.id);
    humans+=netInfo.humans||0;udp+=netInfo.udp||0;ws+=netInfo.ws||0;
    m.humans+=netInfo.humans||0;m.udp+=netInfo.udp||0;m.ws+=netInfo.ws||0;
    for(const sample of netInfo.rtts||[]){
      if(!Number.isFinite(sample?.ms))continue;
      allRtts.push(sample.ms);
      m.rtts.push(sample.ms);
      if(sample.tr==='udp')udpRtts.push(sample.ms);
      else wsRtts.push(sample.ms);
    }
  }
  // Also collect gateway-measured WS ping/pong RTTs and native WebRTC ICE/SCTP RTTs
  // so legacy clients that do not report RTT in JSON pings are measured accurately too.
  const gwWsRtts=[];
  for(const sock of shardWss.clients){
    if(Number.isFinite(sock._cs2LastRtt)&&sock._cs2LastRtt>=1&&sock._cs2LastRtt<=5000){
      gwWsRtts.push(sock._cs2LastRtt);
      if(sock._cs2MapId){
        const m=ensureMap(sock._cs2MapId);
        if(!m.gwWsRtts)m.gwWsRtts=[];
        m.gwWsRtts.push(sock._cs2LastRtt);
      }
    }
  }
  const gwUdpRtts=[];
  for(const adapter of rtcAdapters){
    const rtt=adapter.rttMs;
    if(Number.isFinite(rtt)&&rtt>=1&&rtt<=5000){
      gwUdpRtts.push(rtt);
      if(adapter._cs2MapId){
        const m=ensureMap(adapter._cs2MapId);
        if(!m.gwUdpRtts)m.gwUdpRtts=[];
        m.gwUdpRtts.push(rtt);
      }
    }
  }
  const effectiveUdpRtts=udpRtts.length>=gwUdpRtts.length?udpRtts:gwUdpRtts;
  const effectiveWsRtts=wsRtts.length>=gwWsRtts.length?wsRtts:gwWsRtts;
  const effectiveAllRtts=[...effectiveUdpRtts,...effectiveWsRtts];
  const mapSummary={};
  for(const [id,m] of Object.entries(byMap)){
    const rList=m.rtts.length?m.rtts:[...(m.gwUdpRtts||[]),...(m.gwWsRtts||[])];
    const p=percentiles(rList);
    mapSummary[id]={humans:m.humans,udp:m.udp,ws:m.ws,...(p?{p50:p.p50,p95:p.p95,samples:p.n}:{})};
  }
  return {
    humans,
    udp,
    ws,
    udpPct:humans?Math.round((udp/humans)*100):0,
    rttAll:percentiles(effectiveAllRtts),
    rttUdp:percentiles(effectiveUdpRtts),
    rttWs:percentiles(effectiveWsRtts),
    gwUdpRtt:percentiles(gwUdpRtts),
    gwWsRtt:percentiles(gwWsRtts),
    byMap:mapSummary,
  };
}
async function refreshLiveNetwork(force=false){
  const now=Date.now();
  if(!force&&cachedLiveNet.data&&now-cachedLiveNet.at<2000)return cachedLiveNet.data;
  const active=allWorkers().filter(w=>isReadyWorker(w)&&w.connections>0);
  if(active.length)await Promise.allSettled(active.map(w=>readWorkerInternal(w)));
  const data=buildLiveNetworkSummary();
  cachedLiveNet={at:Date.now(),data};
  return data;
}
const netLogTimer=setInterval(async()=>{
  try{
    const netSnap=await refreshLiveNetwork(true);
    if(netSnap.humans>0||netSnap.gwWsRtt){
      const compactMaps={};
      for(const [id,m] of Object.entries(netSnap.byMap)){
        if(m.humans>0)compactMaps[id]={h:m.humans,u:m.udp,...(m.p50!=null?{p50:m.p50,p95:m.p95}:{})};
      }
      telemetryStore.record({
        k:'net',
        h:netSnap.humans,
        u:netSnap.udp,
        w:netSnap.ws,
        ...(netSnap.rttAll?{all:{n:netSnap.rttAll.n,p50:netSnap.rttAll.p50,p95:netSnap.rttAll.p95}}:{}),
        ...(netSnap.rttUdp?{ur:{n:netSnap.rttUdp.n,p50:netSnap.rttUdp.p50,p95:netSnap.rttUdp.p95}}:{}),
        ...(netSnap.rttWs?{wr:{n:netSnap.rttWs.n,p50:netSnap.rttWs.p50,p95:netSnap.rttWs.p95}}:{}),
        ...(Object.keys(compactMaps).length?{maps:compactMaps}:{}),
      });
    }
  }catch{}
},60000);
netLogTimer.unref();
let rtcGateway=null;
createRtcGateway({
  onClientSocket:(mapId,query,req,adapter)=>{
    rtcAdapters.add(adapter);
    adapter.once('close',()=>rtcAdapters.delete(adapter));
    routeShardedWebSocket(mapId,query,req,adapter);
  },
}).then(gw=>{
  rtcGateway=gw;
  if(gw)console.log(`WebRTC UDP DataChannel enabled on port ${gw.udpPort}`);
}).catch(()=>{});
function safeCloseWs(ws,code,reason){
  if(!ws||ws.readyState===WebSocket.CLOSED||ws.readyState===WebSocket.CLOSING)return;
  if(code&&code>=1000&&code<=4999&&code!==1004&&code!==1005&&code!==1006&&code!==1015){
    try{ws.close(code,reason);}catch{try{ws.close();}catch{}}
  }else{
    try{ws.close();}catch{}
  }
}
function sendWsJson(ws,payload){
  if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(payload));
}
async function listMapRoomsForWs(mapId){
  const ready=mapWorkers(mapId).filter(w=>isReadyWorker(w)&&w.connections>0);
  if(!ready.length)return [];
  const results=await Promise.allSettled(ready.map(w=>readWorkerRooms(w)));
  const merged=[];
  for(const r of results)if(r.status==='fulfilled'&&Array.isArray(r.value))merged.push(...r.value);
  merged.sort((a,b)=>Number(b.joinable)-Number(a.joinable)||b.humans-a.humans||a.code.localeCompare(b.code));
  return merged;
}
function routeShardedWebSocket(mapId,query,req,clientWs){
  try{clientWs._socket?.setNoDelay?.(true);}catch{}
  const isRtc=rtcAdapters.has(clientWs);
  clientWs._cs2Alive=true;
  clientWs._cs2MapId=mapId;
  clientWs.on('pong',()=>{
    clientWs._cs2Alive=true;
    if(clientWs._cs2PingAt>0){
      const rtt=Math.round(performance.now()-clientWs._cs2PingAt);
      if(rtt>=1&&rtt<=5000)clientWs._cs2LastRtt=rtt;
      clientWs._cs2PingAt=0;
    }
  });
  if(!isRtc){
    // Sample real end-to-end WS RTT 2s after connect so even short sessions get measured.
    const firstPing=setTimeout(()=>{
      if(clientWs.readyState===WebSocket.OPEN){clientWs._cs2PingAt=performance.now();try{clientWs.ping();}catch{}}
    },2000);
    firstPing.unref?.();
    clientWs.once('close',()=>clearTimeout(firstPing));
  }
  let state='unbound',boundWorker=null,upstreamWs=null,released=false,welcomed=false;
  let lastBpSent=0,bpTimer=null;
  const pending=[];
  const idleTimer=setTimeout(()=>{if(state==='unbound')safeCloseWs(clientWs,1008,'Handshake timeout');},20000);
  idleTimer.unref?.();
  const sendBackpressure=(bytes)=>{
    if(state!=='bound'||upstreamWs?.readyState!==WebSocket.OPEN)return;
    const clamped=bytes>24576?Math.min(1048576,Math.round(bytes)):0;
    if(clamped===lastBpSent||(clamped>0&&lastBpSent>0&&Math.abs(clamped-lastBpSent)<8192))return;
    lastBpSent=clamped;
    try{upstreamWs.send(JSON.stringify({type:'_bp',b:clamped}));}catch{}
  };
  const scheduleBpDrainCheck=()=>{
    if(bpTimer||state==='closed')return;
    bpTimer=setInterval(()=>{
      if(state!=='bound'||clientWs.readyState!==WebSocket.OPEN){
        clearInterval(bpTimer);bpTimer=null;return;
      }
      const cur=clientWs.bufferedAmount||0;
      if(cur<=12288){
        sendBackpressure(0);
        clearInterval(bpTimer);bpTimer=null;
      }else{
        sendBackpressure(cur);
      }
    },60);
    bpTimer.unref?.();
  };
  const cleanup=(code,reason)=>{
    if(state==='closed')return;
    state='closed';
    clearTimeout(idleTimer);
    if(bpTimer){clearInterval(bpTimer);bpTimer=null;}
    if(boundWorker&&!released){
      released=true;
      boundWorker.connections=Math.max(0,boundWorker.connections-1);
      boundWorker.touched=Date.now();
      boundWorker.directoryRead=null;
      boundWorker.internalRead=null;
    }
    safeCloseWs(upstreamWs,code,reason);
    safeCloseWs(clientWs,code,reason);
  };
  clientWs.on('error',()=>cleanup());
  clientWs.on('close',(code,reason)=>cleanup(code,reason));
  clientWs.on('message',async(data,isBinary)=>{
    if(state==='closed')return;
    if(state==='bound'){
      if(upstreamWs?.readyState===WebSocket.OPEN)upstreamWs.send(data,{binary:isBinary});
      return;
    }
    if(state==='connecting'){
      if(pending.length<64)pending.push({data,isBinary});
      return;
    }
    let msg;
    try{
      if(isBinary)throw Error('binary');
      msg=JSON.parse(data.toString());
      if(!msg||typeof msg!=='object'||Array.isArray(msg))throw Error('object');
    }catch{
      sendWsJson(clientWs,{type:'error',code:'BAD_MESSAGE',message:'消息格式无效。'});
      safeCloseWs(clientWs,1008,'Bad message');
      return;
    }
    if(msg.type==='ping'){
      sendWsJson(clientWs,{type:'pong',time:typeof msg.time==='number'?msg.time:null,serverTime:Date.now()});
      return;
    }
    if(msg.type==='listRooms'){
      const rooms=await listMapRoomsForWs(mapId).catch(()=>[]);
      if(state==='unbound')sendWsJson(clientWs,{type:'rooms',mapId,rooms});
      return;
    }
    state='connecting';
    clearTimeout(idleTimer);
    pending.push({data,isBinary});
    try{
      let target=null;
      let peerBridgeUrl=null;
      const code=normalizeRoomCode(msg.room);
      if(msg.type==='roomCosmetics'){
        target=(code&&await findWorkerForRoom(mapId,code))||await ensureWorker(mapId);
      }else if(msg.type==='join'){
        const isResume=typeof msg.resumeToken==='string'&&msg.resumeToken.length>0;
        const curHardMax=runtimeLocal.hardMaxHumans;
        if(!runtimeLocal.enabled&&!isResume){
          sendWsJson(clientWs,{type:'error',code:'NODE_DISABLED',message:'当前战区节点维护中，请返回大厅重新匹配。'});
          cleanup(1013,'Node disabled');
          return;
        }
        if(code){
          target=await findWorkerForRoom(mapId,code);
          if(!target&&clusterPeers.length){
            const remotePeer=clusterRoomToPeer.get(mapId+':'+code);
            const pSnap=remotePeer?peerNodeSnapshot(remotePeer):null;
            if(pSnap&&pSnap.healthy){
              const base=new URL('/perf/play/'+mapId+'/ws'+(query||''),pSnap.origin);
              base.protocol=base.protocol==='https:'?'wss:':'ws:';
              peerBridgeUrl=base.href;
            }
          }
          if(!target&&!peerBridgeUrl){
            if(curHardMax>0&&!isResume&&localActiveConnections()>=curHardMax){
              sendWsJson(clientWs,{type:'error',code:'SERVER_FULL',message:`当前战区服务器已满载（上限 ${curHardMax} 人），请返回大厅重新匹配或稍后再试。`});
              cleanup(1013,'Server full');
              return;
            }
            if(!runtimeLocal.acceptNewRooms&&!isResume&&msg.existing!==true){
              sendWsJson(clientWs,{type:'error',code:'NODE_DRAINING',message:'当前战区节点暂不创建新房间，请返回大厅重新匹配。'});
              cleanup(1013,'Node draining');
              return;
            }
            target=msg.existing===true?await ensureWorker(mapId):await selectWorkerForNewRoom(mapId);
          }else if(target&&curHardMax>0&&!isResume&&localActiveConnections()>=curHardMax){
            sendWsJson(clientWs,{type:'error',code:'SERVER_FULL',message:`当前战区服务器已满载（上限 ${curHardMax} 人），请返回大厅重新匹配或稍后再试。`});
            cleanup(1013,'Server full');
            return;
          }
        }else{
          if(curHardMax>0&&!isResume&&localActiveConnections()>=curHardMax){
            sendWsJson(clientWs,{type:'error',code:'SERVER_FULL',message:`当前战区服务器已满载（上限 ${curHardMax} 人），请返回大厅重新匹配或稍后再试。`});
            cleanup(1013,'Server full');
            return;
          }
          if(!runtimeLocal.acceptNewRooms&&!isResume){
            sendWsJson(clientWs,{type:'error',code:'NODE_DRAINING',message:'当前战区节点暂不创建新房间，请返回大厅重新匹配。'});
            cleanup(1013,'Node draining');
            return;
          }
          target=await selectWorkerForNewRoom(mapId);
        }
      }else{
        target=await ensureWorker(mapId);
      }
      if(state==='closed')return;
      if(peerBridgeUrl){
        const up=new WebSocket(peerBridgeUrl,{perMessageDeflate:false,headers:req.headers.origin?{origin:req.headers.origin}:{}});
        upstreamWs=up;
        up.on('error',()=>cleanup(1011,'Peer bridge error'));
        up.on('close',(c,r)=>cleanup(c,r));
        up.on('open',()=>{
          try{up._socket?.setNoDelay?.(true);}catch{}
          if(state==='closed'){safeCloseWs(up);return;}
          state='bound';
          for(const frame of pending){
            if(up.readyState===WebSocket.OPEN)up.send(frame.data,{binary:frame.isBinary});
          }
          pending.length=0;
        });
        up.on('message',(uData,uBinary)=>{
          if(state==='closed'||clientWs.readyState!==WebSocket.OPEN)return;
          clientWs.send(uData,{binary:uBinary});
        });
        return;
      }
      boundWorker=target;
      boundWorker.connections++;
      boundWorker.touched=Date.now();
      boundWorker.directoryRead=null;
      boundWorker.internalRead=null;
      const forwardHeaders={
        'x-cs2-transport':isRtc?'udp':'ws',
        'x-cs2-gateway':'1',
        'x-cs2-client-ip-hash':telemetryStore.hashIp(req.headers['x-forwarded-for']||req.socket?.remoteAddress||''),
      };
      if(req.headers.origin)forwardHeaders.origin=req.headers.origin;
      if(req.headers['x-forwarded-for'])forwardHeaders['x-forwarded-for']=req.headers['x-forwarded-for'];
      const up=new WebSocket('ws://127.0.0.1:'+boundWorker.port+'/ws'+(query||''),{perMessageDeflate:false,headers:forwardHeaders});
      upstreamWs=up;
      up.on('error',()=>cleanup(1011,'Upstream error'));
      up.on('close',(c,r)=>cleanup(c,r));
      up.on('open',()=>{
        try{up._socket?.setNoDelay?.(true);}catch{}
        if(state==='closed'){safeCloseWs(up);return;}
        state='bound';
        for(const frame of pending){
          if(up.readyState===WebSocket.OPEN)up.send(frame.data,{binary:frame.isBinary});
        }
        pending.length=0;
      });
      up.on('message',(uData,uBinary)=>{
        if(state==='closed')return;
        if(!welcomed&&!uBinary&&uData.length<8192){
          const text=uData.toString();
          if(text.startsWith('{"type":"welcome"')){
            try{
              const parsed=JSON.parse(text);
              if(parsed.type==='welcome'&&parsed.room){
                welcomed=true;
                roomToWorker.set(mapId+':'+parsed.room,boundWorker);
                boundWorker.knownRooms.add(parsed.room);
                boundWorker.directoryRead=null;
                boundWorker.internalRead=null;
              }
            }catch{}
          }
        }
        if(clientWs.readyState===WebSocket.OPEN){
          const curBuf=clientWs.bufferedAmount||0;
          if(curBuf>512*1024){cleanup(1008,'Client too slow');return;}
          let useUnreliable=false;
          if(isRtc&&!uBinary&&clientWs.hasUnreliable){
            const head=uData.subarray(0,32).toString('utf8');
            if(head.startsWith('{"type":"pong"')||head.startsWith('{"type":"snapshotDelta","sid":')){
              useUnreliable=true;
            }
          }
          if(useUnreliable){
            clientWs.sendUnreliable(uData,{binary:uBinary});
          }else{
            clientWs.send(uData,{binary:uBinary});
          }
          const afterBuf=clientWs.bufferedAmount||0;
          if(afterBuf>24576){
            sendBackpressure(afterBuf);
            scheduleBpDrainCheck();
          }else if(lastBpSent>0&&afterBuf<=12288){
            sendBackpressure(0);
            if(bpTimer){clearInterval(bpTimer);bpTimer=null;}
          }
        }
      });
    }catch{
      sendWsJson(clientWs,{type:'error',code:'SERVER_BUSY',message:'当前地图服务繁忙，请稍后重试。'});
      cleanup(1013,'Server busy');
    }
  });
}
server.on('upgrade',async(req,socket,head)=>{
  if(draining){socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');return;}
  if(allowedOrigins instanceof Set && req.headers.origin && !allowedOrigins.has(req.headers.origin)){
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;
  }
  const match=/^\/perf\/(?:quality\/)?play\/(de_[a-z0-9]+)\/ws(\?.*)?$/.exec(req.url);
  if(!match||!maps.has(match[1])||(req.url.startsWith('/perf/quality/')&&!qualityPacks.has(match[1]))){socket.destroy();return;}
  const mapId=match[1],query=match[2]||'';
  if(runtimeLocal.hardMaxHumans>0&&shardWss.clients.size>=runtimeLocal.hardMaxHumans+24){
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');return;
  }
  if(maxShardsForMap(mapId)>1||mapWorkers(mapId).length>1||runtimeLocal.hardMaxHumans>0||clusterPeers.length>0||clusterConfigPath){
    shardWss.handleUpgrade(req,socket,head,clientWs=>routeShardedWebSocket(mapId,query,req,clientWs));
    return;
  }
  try{
    const w=await ensureWorker(mapId);if(socket.destroyed)return;
    w.connections++;w.touched=Date.now();w.directoryRead=null;w.internalRead=null;const upstream=net.connect(w.port,'127.0.0.1');
    try { socket.setNoDelay(true); upstream.setNoDelay(true); } catch {}
    socket.once('close',()=>{w.connections=Math.max(0,w.connections-1);w.touched=Date.now();w.directoryRead=null;w.internalRead=null;upstream.destroy();});
    upstream.on('error',()=>socket.destroy());upstream.on('close',()=>socket.destroy());socket.on('error',()=>upstream.destroy());
    upstream.once('connect',()=>{
      const headers=['GET /ws'+query+' HTTP/1.1'];
      for(let i=0;i<req.rawHeaders.length;i+=2)headers.push(req.rawHeaders[i]+': '+req.rawHeaders[i+1]);
      headers.push('X-CS2-Transport: ws');
      headers.push('X-CS2-Gateway: 1');
      headers.push('X-CS2-Client-Ip-Hash: '+telemetryStore.hashIp(req.headers['x-forwarded-for']||req.socket?.remoteAddress||''));
      upstream.write(headers.join('\r\n')+'\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream).pipe(socket);
    });
  }catch{socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');}
});
server.listen(port,host,()=>{
  console.log('Performance map pool: http://127.0.0.1:'+server.address().port+'/perf/');
  for(const [id,count] of warmShardTargets){
    for(let i=0;i<count;i++)spawnWorker(id).catch(()=>{});
  }
});
process.on('SIGUSR2',()=>{draining=true;for(const w of allWorkers())if(!w.retiring)w.child.kill('SIGUSR2');});
function shutdown(){clearInterval(reap);clearInterval(shardHeartbeat);clearInterval(netLogTimer);if(clusterPollTimer)clearInterval(clusterPollTimer);if(clusterConfigTimer)clearInterval(clusterConfigTimer);void telemetryStore.close();for(const w of allWorkers())w.child.kill();server.close();const forceExit=setTimeout(()=>process.exit(0),1500);forceExit.unref?.();rtcGateway?.close({cleanupNative:true});}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,shutdown);
if(process.send)process.once('disconnect',shutdown);
