import {bundled,bundledEntry,bundledManifest,remoteAsset} from './bundled-assets.js';
import {cutoutImagePaths,flatMatchManifest} from './flat-map-materials.js';
import {assetManifestName} from './device-profile.js';
import { DefaultLoadingManager } from 'three';
import {clientAssetManifest} from './private-game-config.js';
import {fetchAssetDownload,getDownloadOrigin,initDownloadOrigin} from './download-origin.js';
import {isTransientResourceError,resourceResponseError,retryResource} from './resource-retry.js';
import {publicPoolAssetCacheBase} from '../shared/public-map-paths.js';
import {resolveStaticAsset} from '../shared/static-runtime.js';
import {sha256Hex} from '../shared/sha256.js';
const blobs=new Map(),inflight=new Map();let manifestMemory=null,manifestChecked=false,persistRequested=false;
const MAPS_CACHE_NAME='dust2-maps-v1';
function requestPersistentStorage(){
  if(persistRequested)return;
  persistRequested=true;
  try{globalThis.navigator?.storage?.persist?.().catch?.(()=>{});}catch{}
}
const matchAnimations=new Set(['assets/characters-cs2/animations.glb','assets/viewmodel/animations.glb']);
const manifestMaxAgeMs=5*60*1000;
const validHash=value=>typeof value==='string'&&/^[a-f\d]{64}$/i.test(value);
const base=()=>new URL('.',document.baseURI),absolute=value=>new URL(value,document.baseURI);
const canonical=value=>{const u=absolute(value);return u.origin+u.pathname;};
const cacheBase=()=>publicPoolAssetCacheBase(document.baseURI,{installed:bundled||!!globalThis.__DUST2_PORTABLE__});
const cacheNames=()=>({assets:`dust2-assets-v1:${cacheBase().pathname}`,meta:`dust2-meta-v1:${cacheBase().pathname}`});
const privateMapCacheName=()=>globalThis.__DUST2_PRIVATE_MAP__?.renderUrl?'dust2-private-transport-v1:'+new URL('../../',globalThis.__DUST2_PRIVATE_MAP__.renderUrl).pathname:null;
const hashKey=hash=>new URL(`__asset_cache__/sha256/${hash}`,cacheBase()).href;
const indexKey=url=>new URL(`__asset_cache__/url/${encodeURIComponent(absolute(url).href)}`,base()).href;
const manifestURL=()=>new URL('assets/'+assetManifestName(),base()).href;
const check=signal=>{if(signal?.aborted)throw signal.reason||new DOMException('已取消','AbortError');};
const digest=data=>sha256Hex(data);
const changed=()=>{if(typeof window!=='undefined'&&typeof CustomEvent!=='undefined')window.dispatchEvent(new CustomEvent('dust2-cache-change'));};
async function ensureDownloadOrigin(signal){
  check(signal);const configured=getDownloadOrigin();if(configured)return configured;
  const render=globalThis.__DUST2_PRIVATE_MAP__?.renderUrl;
  const installed=bundled&&base().origin==='https://cs2.duskrain.cn'&&base().pathname.startsWith('/__installed__/');
  const configURL=render?new URL('../../../download-config.json',render):new URL(installed?'/download-config.json':'download-config.json',base());
  return initDownloadOrigin({configURL,pageURL:document.baseURI,signal});
}
async function stores(){try{if(!globalThis.caches)return null;const n=cacheNames();return{assets:await caches.open(n.assets),meta:await caches.open(n.meta)};}catch{return null;}}
export function assetURL(value){return blobs.get(canonical(value))||value;}
export function releaseDownloads(){for(const b of blobs.values())URL.revokeObjectURL(b);blobs.clear();}
export function useDownloadedAssets(manager=DefaultLoadingManager){manager.setURLModifier(assetURL);}
export async function isAssetSaved(sha256,bytes){if(bundled&&(await bundledManifest()).files.some(f=>f.sha256===sha256&&f.bytes===bytes))return true;const cache=await stores();if(!cache||!sha256)return false;const hit=await cache.assets.match(hashKey(sha256));return !!hit&&Number(hit.headers.get('x-dust2-bytes'))===bytes;}

// Inventory badges scan keys once. Open responses only for catalog hashes
// actually present, using the same byte-count check as individual equips.
export async function savedCatalogAssets(resources, signal){
  const expected=new Map(resources.map(item=>[item.sha256,item.bytes]));
  const saved=new Set();
  if(bundled){
    for(const file of (await bundledManifest()).files)
      if(expected.get(file.sha256)===file.bytes)saved.add(file.sha256);
  }
  if(!globalThis.caches||signal?.aborted)return saved;
  let cache,keys;
  try{
    cache=await caches.open(cacheNames().assets);
    keys=await cache.keys();
  }catch{return saved;}
  const prefix=hashKey('');
  const candidates=keys.filter(key=>{
    if(!key.url.startsWith(prefix))return false;
    const hash=key.url.slice(prefix.length);
    return expected.has(hash)&&!saved.has(hash);
  }).values();
  const checkNext=async()=>{
    for(const key of candidates){
      if(signal?.aborted)return;
      const hash=key.url.slice(prefix.length);
      const hit=await cache.match(key).catch(()=>null);
      if(hit&&Number(hit.headers.get('x-dust2-bytes'))===expected.get(hash))saved.add(hash);
    }
  };
  await Promise.all(Array.from({length:4},checkNext));
  return saved;
}

/** SHA-keyed immutable assets. Without a supplied hash, the computed SHA is
 * indexed by URL; use sha256 or a versioned URL when optional content changes.
 * onProgress receives {loaded,total,fromCache,cached}, in decoded bytes. */
function pendingResult(promise,signal){
  if(!signal)return promise;
  return new Promise((resolve,reject)=>{const abort=()=>reject(signal.reason||new DOMException('已取消','AbortError'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});
}
export async function fetchCachedAsset(value,options={}){
  check(options.signal);const installed=await bundledEntry(value);
  if(installed&&(!options.sha256||options.sha256===installed.sha256)&&(!options.bytes||options.bytes===installed.bytes)){
    const response=await fetch(absolute(value),{signal:options.signal});if(!response.ok)throw Error('本地资源损坏，请重新安装客户端。');
    options.onProgress?.({loaded:installed.bytes,total:installed.bytes,fromCache:true,cached:true});return response;
  }
  const settings={...options};
  if(!settings.sha256){
    const manifest=manifestChecked?manifestMemory:await loadManifest({signal:settings.signal}).catch(error=>{check(settings.signal);return null;});
    const file=manifest?.files.find(f=>canonical(f.path)===canonical(value));
    if(file){settings.sha256=file.sha256;settings.bytes??=file.bytes;}
  }
  const key=settings.sha256?canonical(value)+'#'+String(settings.sha256).toLowerCase():absolute(value).href;
  const existing=inflight.get(key);
  if(existing){
    try{const response=await pendingResult(existing,settings.signal);check(settings.signal);
      if((!settings.sha256||response.headers.get('x-dust2-sha256')===settings.sha256.toLowerCase())&&(!Number.isFinite(settings.bytes)||Number(response.headers.get('x-dust2-bytes'))===settings.bytes)){
        const n=Number(response.headers.get('x-dust2-bytes'));settings.onProgress?.({loaded:n,total:n,fromCache:true,cached:true});return response.clone();}}
    catch(error){check(settings.signal);}
  }
  const promise=readCachedAsset(value,settings);inflight.set(key,promise);
  try{return(await promise).clone();}finally{if(inflight.get(key)===promise)inflight.delete(key);}
}
async function readCachedAsset(value,{sha256,bytes,signal,onProgress}={}){
  check(signal);const url=absolute(value);url.hash='';
  if(sha256&&!validHash(sha256))throw new Error('无效的资源 SHA-256');
  sha256=sha256?.toLowerCase();if(sha256)url.searchParams.set('v',sha256.slice(0,12));
  const cache=await stores();let expected=sha256;
  if(!expected&&cache&&(url.searchParams.has('v')||globalThis.navigator?.onLine===false)){
    const hit=await cache.meta.match(indexKey(url)).catch(()=>null);
    const index=await hit?.json().catch(()=>null);
    if(validHash(index?.sha256))expected=index.sha256.toLowerCase();
  }
  let damaged=false;
  if(expected&&cache){
    const key=hashKey(expected),hit=await cache.assets.match(key).catch(()=>null);
    if(hit){
      const blob=await hit.blob().catch(()=>null);
      const actual=hit.status===200&&blob&&(!Number.isFinite(bytes)||blob.size===bytes)
        ?await blob.arrayBuffer().then(digest).catch(()=>null):null;
      check(signal);
      if(actual===expected){
        const headers=new Headers(hit.headers);
        headers.delete('content-encoding');headers.delete('transfer-encoding');
        headers.set('x-dust2-sha256',expected);
        headers.set('x-dust2-bytes',String(blob.size));
        headers.set('content-length',String(blob.size));
        onProgress?.({loaded:blob.size,total:blob.size,fromCache:true,cached:true});
        return new Response(blob,{status:200,headers});
      }
      damaged=true;
      await cache.assets.delete(key).catch(()=>{});
    }
  }
  await ensureDownloadOrigin(signal);
  const {blob,headers,received}=await retryResource(retry=>{
    if(retry)onProgress?.({loaded:0,total:bytes||0,fromCache:false,cached:false});
    return readAssetBody(url,{signal,bytes,onProgress,cache:retry||damaged?'reload':sha256?'force-cache':'default'});
  },signal);
  const actual=await digest(await blob.arrayBuffer());
  check(signal);if(sha256&&actual!==sha256)throw new Error(`资源校验失败：${url.pathname.split('/').pop()}，请重试`);
  headers.delete('content-encoding');headers.delete('transfer-encoding');headers.set('content-length',String(received));
  headers.set('x-dust2-sha256',actual);headers.set('x-dust2-bytes',String(received));headers.set('x-dust2-asset-url',url.href);
  const result=new Response(blob,{status:200,headers});let cached=false;
  if(cache){try{await cache.assets.put(hashKey(actual),result.clone());await cache.meta.put(indexKey(url),new Response(JSON.stringify({sha256:actual,bytes:received}),{headers:{'content-type':'application/json'}}));cached=true;requestPersistentStorage();changed();}
    catch(error){console.warn('资源已加载，但浏览器未保存持久缓存：',error.name||error.message);}}
  check(signal);onProgress?.({loaded:received,total:bytes||received,fromCache:false,cached});return result;
}

async function readAssetBody(url,{signal,bytes,onProgress,cache}){
  check(signal);
  const name=url.pathname.split('/').pop(),controller=new AbortController();
  const cancel=()=>controller.abort(signal.reason);
  let timer,reader;
  const touch=()=>{
    clearTimeout(timer);
    timer=setTimeout(()=>controller.abort(new Error(`资源长时间没有响应：${name}`)),20000);
  };
  signal?.addEventListener('abort',cancel,{once:true});
  touch();
  try{
    const response=await fetchAssetDownload(url,{pageURL:document.baseURI,signal:controller.signal,cache,
      fetcher:(target,request)=>fetch(remoteAsset(target),request)});
    const type=response.headers.get('content-type')||'application/octet-stream';
    if(!response.ok||response.type==='opaque')throw resourceResponseError(response,`资源下载失败 (${response.status})：${name}`);
    if(type.includes('text/html')&&!url.pathname.endsWith('.html'))throw resourceResponseError(response,`资源地址返回了网页：${name}`);
    touch();
    const chunks=[];
    let received=0;
    reader=response.body?.getReader();
    if(reader){
      while(true){
        const {done,value}=await reader.read();
        if(done)break;
        touch();
        chunks.push(value);received+=value.byteLength;
        onProgress?.({loaded:received,total:bytes||received,fromCache:false,cached:false});
      }
    }else{
      const value=await response.arrayBuffer();
      chunks.push(value);received=value.byteLength;
    }
    controller.signal.throwIfAborted();
    if(Number.isFinite(bytes)&&received!==bytes)throw new Error(`资源不完整：${name}，请重试`);
    return {blob:new Blob(chunks,{type}),headers:new Headers(response.headers),received};
  }catch(error){
    controller.abort(error);
    await reader?.cancel(error).catch(()=>{});
    throw controller.signal.reason;
  }finally{
    clearTimeout(timer);
    signal?.removeEventListener('abort',cancel);
    reader?.releaseLock();
  }
}

function validateManifest(manifest){
  if(!Array.isArray(manifest?.files))throw new Error('资源清单格式错误');
  const prefix=new URL('assets/',base()).href,seen=new Set();
  for(const file of manifest.files){
    if(typeof file?.path!=='string'||!file.path.startsWith('assets/')||/[\\?#]/.test(file.path)
      ||!Number.isSafeInteger(file.bytes)||file.bytes<0||!validHash(file.sha256))throw new Error('资源清单格式错误');
    const url=absolute(file.path).href;
    if(url===prefix||!url.startsWith(prefix)||seen.has(url))throw new Error('资源清单路径错误');
    seen.add(url);
  }
  return manifest;
}

async function cachedManifest(cache,{allowStale,signal}){
  const url=manifestURL(),hit=await cache?.meta.match(url).catch(()=>null);
  check(signal);
  if(!hit)return null;
  const savedAt=Number(hit.headers.get('x-dust2-manifest-fetched-at')),age=Date.now()-savedAt;
  if(!allowStale&&(!savedAt||age<0||age>manifestMaxAgeMs))return null;
  try{
    const manifest=validateManifest(await hit.json());
    check(signal);
    return manifest;
  }
  catch{
    check(signal);
    await cache.meta.delete(url).catch(()=>{});
    return null;
  }
}

async function loadManifest({signal,refresh=true,offline=false}={}){
  check(signal);if(!refresh&&manifestMemory)return manifestMemory;const cache=await stores();
  const filtered=manifest=>clientAssetManifest(manifest,!!globalThis.__DUST2_PRIVATE_MAP__);
  if(!refresh){
    const cached=await cachedManifest(cache,{allowStale:true,signal});
    if(cached)return filtered(cached);
  }
  try{if(!bundled)await ensureDownloadOrigin(signal);
    const manifest=validateManifest(await retryResource(async()=>{
      const localManifest=resolveStaticAsset('assets/'+assetManifestName(),document.baseURI)?.source==='toy';
      const options={cache:!bundled&&localManifest?'force-cache':'no-cache',signal};
      const response=bundled?await fetch(manifestURL(),options):await fetchAssetDownload(manifestURL(),{...options,pageURL:document.baseURI});
      if(!response.ok)throw resourceResponseError(response,`资源清单加载失败 (${response.status})`);
      return response.json();
    },signal));
    check(signal);
    const response=new Response(JSON.stringify(manifest),{headers:{
      'content-type':'application/json','x-dust2-manifest-fetched-at':String(Date.now()),
    }});
    await cache?.meta.put(manifestURL(),response).catch(()=>{});
    manifestMemory=filtered(manifest);manifestChecked=true;return manifestMemory;
  }catch(error){
    check(signal);
    if(isTransientResourceError(error)){
      const cached=await cachedManifest(cache,{allowStale:offline,signal});
      if(cached){manifestMemory=filtered(cached);manifestChecked=true;return manifestMemory;}
    }
    throw error;
  }
}

async function matchManifest(manifest, flat, signal, matchOnly) {
  // The other match resources verify their own files when they are first used.
  if(matchOnly){
    const files=manifest.files.filter(file=>matchAnimations.has(file.path));
    if(files.length!==matchAnimations.size)throw new Error('资源清单缺少对局动画，请刷新后重试');
    return {...manifest,files,totalBytes:files.reduce((sum,file)=>sum+file.bytes,0)};
  }
  if (!flat) return manifest;
  const sceneFile = manifest.files.find(file => /\/dust2-(web|clear)\.gltf$/.test(file.path));
  if (!sceneFile) return flatMatchManifest(manifest);
  const response = await fetchCachedAsset(sceneFile.path, {...sceneFile, signal});
  return flatMatchManifest(manifest, cutoutImagePaths(await response.json(), sceneFile.path));
}

async function collectAssets({signal,onProgress,makeBlobs=false,flat=false,matchOnly=false,offline=false}={}){
  if(makeBlobs)releaseDownloads();const controller=new AbortController(),parent=signal,abort=()=>controller.abort(parent?.reason);
  parent?.addEventListener('abort',abort,{once:true});if(parent?.aborted)abort();signal=controller.signal;let workers=[];
  try{const manifest=await matchManifest(await loadManifest({signal,offline}),flat,signal,matchOnly),total=manifest.files.reduce((n,f)=>n+f.bytes,0);
    let next=0,complete=0,bytes=0,lastBytes=0,lastTime=performance.now(),rate=0,cachedFiles=0;
    const tick=current=>{const now=performance.now(),elapsed=(now-lastTime)/1000;if(elapsed>.35){rate=(bytes-lastBytes)/elapsed;lastTime=now;lastBytes=bytes;}onProgress?.({bytes,total,complete,count:manifest.files.length,rate,current,cachedFiles});};tick('准备地图资源');
    workers=Array.from({length:2},async()=>{while(next<manifest.files.length){check(signal);const file=manifest.files[next++],url=absolute(file.path);url.searchParams.set('v',file.sha256.slice(0,12));let seen=0,fromCache=false;
      const response=await fetchCachedAsset(url,{sha256:file.sha256,bytes:file.bytes,signal,onProgress:p=>{bytes+=p.loaded-seen;seen=p.loaded;fromCache=p.fromCache;tick(file.group);}});
      if(makeBlobs)blobs.set(canonical(url),URL.createObjectURL(await response.blob()));if(fromCache)cachedFiles++;complete++;tick(file.group);
    }});await Promise.all(workers);if(makeBlobs)useDownloadedAssets();return manifest;
  }catch(error){controller.abort();await Promise.allSettled(workers);if(makeBlobs)releaseDownloads();throw error;}
  finally{parent?.removeEventListener('abort',abort);}
}
export async function downloadAssets(options={}){
  if(bundled){const manifest=await matchManifest(await loadManifest({signal:options.signal,offline:options.offline}),options.flat,options.signal,options.matchOnly);const installed=await bundledManifest();const files=new Map(installed.files.map(f=>[f.path,f]));if(!manifest.files.every(f=>files.get(f.path)?.sha256===f.sha256))throw Error('基础资源不完整，请下载完整客户端。');options.onProgress?.({bytes:manifest.totalBytes,total:manifest.totalBytes,complete:manifest.files.length,count:manifest.files.length,rate:0,current:'读取已安装资源'});return manifest;}
  // A worker serves verified asset entries only in its own document directory.
  // The root worker deliberately passes /play/ through; those map pages need
  // Blob URLs so GLTF/texture readers reuse the bytes just fetched from CDN.
  const worker=globalThis.navigator?.serviceWorker?.controller;
  const controlled=!globalThis.__DUST2_PRIVATE_MAP__&&!!worker?.scriptURL&&new URL('.',worker.scriptURL).href===base().href;
  return collectAssets({...options,makeBlobs:!controlled});
}
export async function saveBaseAssets(options={}){
  if(!await stores())throw new Error('此浏览器无法使用离线缓存，请使用 HTTPS 或本机地址');await collectAssets({...options,makeBlobs:false});
  const stats=await getAssetCacheStats();if(!stats.complete)throw new Error('浏览器存储空间不足或缓存未能保存，请释放空间后重试');return stats;
}
export async function getAssetCacheStats(){
  const cache=await stores(),manifest=await loadManifest({refresh:false}).catch(()=>null);
  const stats={supported:!!cache,bytes:0,count:0,baseBytes:0,baseCount:0,totalBytes:manifest?.files.reduce((n,f)=>n+f.bytes,0)||0,totalCount:manifest?.files.length||0,complete:false,persisted:false,usage:null,quota:null};
  if(cache){for(const key of await cache.assets.keys()){const r=await cache.assets.match(key);stats.bytes+=Number(r?.headers.get('x-dust2-bytes'))||0;stats.count++;}
    for(const file of manifest?.files||[]){const r=await cache.assets.match(hashKey(file.sha256.toLowerCase()));if(r&&Number(r.headers.get('x-dust2-bytes'))===file.bytes){stats.baseCount++;stats.baseBytes+=file.bytes;}}
    stats.complete=stats.totalCount>0&&stats.baseCount===stats.totalCount;}
  const privateName=privateMapCacheName();stats.privateMapBytes=0;
  for(const mapStore of [privateName,MAPS_CACHE_NAME].filter(Boolean)){
    if(globalThis.caches){try{const maps=await caches.open(mapStore);for(const key of await maps.keys()){const response=await maps.match(key),bytes=Number(response?.headers.get('x-dust2-bytes')||response?.headers.get('Content-Length'))||0;stats.privateMapBytes+=bytes;stats.bytes+=bytes;stats.count++;}}catch{}}
  }
  try{stats.persisted=await navigator.storage?.persisted?.()||false;const e=await navigator.storage?.estimate?.();stats.usage=e?.usage??null;stats.quota=e?.quota??null;}catch{}return stats;
}
export async function clearAssetCache(){const n=cacheNames(),privateName=privateMapCacheName();if(globalThis.caches)await Promise.all([caches.delete(n.assets),caches.delete(n.meta),caches.delete(MAPS_CACHE_NAME),...(privateName?[caches.delete(privateName)]:[])]);manifestMemory=null;manifestChecked=false;changed();return getAssetCacheStats();}
