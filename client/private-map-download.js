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

export function privateMapFetcher(config,{fetcher=fetch}={}) {
 return async(value,options={})=>{
  const original=new URL(value),remote=privateMapDownloadURL(original,config);
  const rt=getStaticRuntime();
  // The performance gateway verifies these URLs against its sealed, per-file manifest.
  // Leave the live room configuration and unversioned asset paths fresh.
  if(config.flatOnly && options.cache==='no-store' && /^[a-f0-9]{64}$/.test(original.searchParams.get('v') || '')){
    options={...options,cache:'default'};
  }
  if(remote.href===original.href)return fetcher(original,options);
  options.signal?.throwIfAborted();
  const isLocalStatic=Boolean(rt&&globalThis.location&&remote.origin===globalThis.location.origin);
  if(isLocalStatic){
   const response=await fetcher(remote,options);
   options.signal?.throwIfAborted();
   if(!response.ok&&rt.mapBaseURL&&[404,408,429,500,502,503,504].includes(response.status)){
    await response.body?.cancel().catch(()=>{});
    const extracted=extractMapRelative(original,config);
    if(extracted){
     const diskRel=/^(?:map\.json|nav\.json|physics\.f32|physics\.vidx|physics-mask\.u8|physics-groups\.json)$/.test(extracted.relative)?'compiled/'+extracted.relative:extracted.relative;
     const cdnFallback=new URL('./'+config.id+'/'+diskRel,rt.mapBaseURL);
     cdnFallback.search=original.search;
     return fetcher(cdnFallback,{...options,mode:'cors',credentials:'omit'});
    }
   }
   return remote.pathname.endsWith('.gz')&&!original.pathname.endsWith('.gz')?maybeGunzipResponse(response):response;
  }
  let response;
  try{response=await fetcher(remote,{...options,mode:'cors',credentials:'omit'});}
  catch(error){
   options.signal?.throwIfAborted();
   if(!config.downloadFallbackToGameServer||error?.name==='AbortError'||!['TypeError','NetworkError'].includes(error?.name))throw error;
   return fetcher(original,options);
  }
  if(config.downloadFallbackToGameServer&&[404,408,429,500,502,503,504].includes(response.status)){
   await response.body?.cancel().catch(()=>{});
   options.signal?.throwIfAborted();
   return fetcher(original,options);
  }
  return response;
 };
}
