import {getStaticRuntime,resolveStaticMapFile,maybeGunzipResponse} from '../shared/static-runtime.js';

/** Keep game URLs and cache identities stable while moving map transfers.
 * The delivery configuration comes only from the game's same-origin endpoint.
 * Metadata and transport hashes remain checked by the existing loaders.
 */
export function privateMapDownloads(config, delivery) {
 return Object.freeze({...config,mapDownloadBaseURL:delivery.mapBaseURL||null,
  downloadFallbackToGameServer:delivery.fallbackToGameServer===true});
}

function extractMapRelative(value, config) {
 const url=new URL(value),page=new URL(config.socketURL);
 page.protocol=page.protocol==='wss:'?'https:':'http:';
 if(url.origin!==page.origin)return null;
 const render=new URL(config.renderUrl),prefixes=[new URL('../',render).pathname,
  new URL('.',page).pathname+'maps/'+config.id+'/'];
 const prefix=prefixes.find(path=>url.pathname.startsWith(path));
 if(!prefix||url.username||url.password||url.hash)return null;
 const relative=url.pathname.slice(prefix.length);
 if(!relative||relative.split('/').some(part=>!part||part==='.'||part==='..')||/%(?:2e|2f|5c)/i.test(relative)||relative.includes('\\'))
  throw Error('地图下载地址越过当前地图');
 return {url,relative};
}

export function privateMapDownloadURL(value, config) {
 const extracted=extractMapRelative(value,config);
 if(!extracted)return new URL(value);
 const {url,relative}=extracted;
 const rt=getStaticRuntime();
 if(rt){
  const pageBase=globalThis.document?.baseURI||globalThis.location?.href||url.href;
  const hit=resolveStaticMapFile(config.id,relative,pageBase);
  if(hit){
   const remote=new URL(hit.url.href);
   if(hit.source==='cdn')remote.search=url.search;
   return remote;
  }
 }
 if(!config.mapDownloadBaseURL)return url;
 const remote=new URL(config.id+'/'+relative,config.mapDownloadBaseURL);
 remote.search=url.search;
 return remote;
}

export const PRIVATE_MAP_CACHE_NAME='dust2-maps-v1';
const pendingMapWrites=new Map();

async function openMapCache(cachesApi){
 if(!cachesApi?.open)return null;
 try{return await cachesApi.open(PRIVATE_MAP_CACHE_NAME);}catch{return null;}
}

function mapCacheKey(sha,pageHref){
 return new URL('/__map_cache__/sha256/'+sha.toLowerCase(),pageHref||'https://cache.local/').href;
}

export function privateMapFetcher(config,{fetcher=fetch,cachesApi=globalThis.caches}={}) {
 return async(value,options={})=>{
  const original=new URL(value),remote=privateMapDownloadURL(original,config);
  const rt=getStaticRuntime();
  const versionSha=/^[a-f0-9]{64}$/i.test(original.searchParams.get('v')||'')?original.searchParams.get('v').toLowerCase():null;
  // The performance gateway verifies these URLs against its sealed, per-file manifest.
  // Leave the live room configuration and unversioned asset paths fresh.
  if(config.flatOnly && options.cache==='no-store' && versionSha){
    options={...options,cache:'default'};
  }
  const cacheable=Boolean(config.flatOnly && versionSha);
  const cache=cacheable?await openMapCache(cachesApi):null;
  const cacheKey=cache?mapCacheKey(versionSha,globalThis.location?.href||original.origin):null;
  if(cache&&cacheKey){
   const pending=pendingMapWrites.get(cacheKey);
   if(pending){try{await pending;}catch{}}
   try{
    const hit=await cache.match(cacheKey);
    if(hit){options.signal?.throwIfAborted();return hit;}
   }catch{}
  }
  const saveToCache=(response)=>{
   if(!cache||!cacheKey||!(response instanceof Response)||!response.ok||response.type==='opaque')return response;
   try{
    const cloned=response.clone();
    const write=(async()=>{
     try{
      const buf=await cloned.arrayBuffer();
      const headers=new Headers(response.headers);
      headers.delete('content-encoding');
      headers.delete('transfer-encoding');
      headers.set('content-length',String(buf.byteLength));
      headers.set('x-dust2-sha256',versionSha);
      headers.set('x-dust2-bytes',String(buf.byteLength));
      await cache.put(cacheKey,new Response(buf,{status:200,headers}));
     }catch{}
    })();
    pendingMapWrites.set(cacheKey,write);
    write.finally(()=>{if(pendingMapWrites.get(cacheKey)===write)pendingMapWrites.delete(cacheKey);});
   }catch{}
   return response;
  };
  if(remote.href===original.href)return saveToCache(await fetcher(original,options));
  options.signal?.throwIfAborted();
  const isLocalStatic=Boolean(rt&&globalThis.location&&remote.origin===globalThis.location.origin);
  if(isLocalStatic){
   const response=await fetcher(remote,options);
   options.signal?.throwIfAborted();
   const fallbackMapBase=config.mapDownloadBaseURL||rt.mapBaseURL;
   if(!response.ok&&fallbackMapBase&&[404,408,429,500,502,503,504].includes(response.status)){
    await response.body?.cancel().catch(()=>{});
    const extracted=extractMapRelative(original,config);
    if(extracted){
     const diskRel=/^(?:map\.json|nav\.json|physics\.f32|physics\.vidx|physics-mask\.u8|physics-groups\.json)$/.test(extracted.relative)?'compiled/'+extracted.relative:extracted.relative;
     const cdnFallback=new URL('./'+config.id+'/'+diskRel,fallbackMapBase);
     cdnFallback.search=original.search;
     return saveToCache(await fetcher(cdnFallback,{...options,mode:'cors',credentials:'omit'}));
    }
   }
   const out=remote.pathname.endsWith('.gz')&&!original.pathname.endsWith('.gz')?await maybeGunzipResponse(response):response;
   return saveToCache(out);
  }
  let response;
  try{response=await fetcher(remote,{...options,mode:'cors',credentials:'omit'});}
  catch(error){
   options.signal?.throwIfAborted();
   if(!config.downloadFallbackToGameServer||error?.name==='AbortError'||!['TypeError','NetworkError'].includes(error?.name))throw error;
   return saveToCache(await fetcher(original,options));
  }
  if(config.downloadFallbackToGameServer&&[404,408,429,500,502,503,504].includes(response.status)){
   await response.body?.cancel().catch(()=>{});
   options.signal?.throwIfAborted();
   return saveToCache(await fetcher(original,options));
  }
  return saveToCache(response);
 };
}
