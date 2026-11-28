/* Cache this installation's lobby, never another map's navigation or game API. */
const SCOPE=new URL(self.registration.scope);
const SHELL=`dust2-shell-v1:${SCOPE.pathname}`;
const ASSETS=`dust2-assets-v1:${SCOPE.pathname}`,META=`dust2-meta-v1:${SCOPE.pathname}`;
const HOME=new URL('./',SCOPE).href,MANIFEST=new URL('assets/asset-manifest.json',SCOPE).href;
const local=url=>url.origin===SCOPE.origin&&url.pathname.startsWith(SCOPE.pathname);
const hashKey=hash=>new URL(`__asset_cache__/sha256/${hash}`,SCOPE).href;
const indexKey=url=>new URL(`__asset_cache__/url/${encodeURIComponent(url.href)}`,SCOPE).href;
const mapResource=url=>/(?:^|\/)assets\/(?:valve-dust2|map-cs2|map-mobile)(?:\/|$)|(?:^|\/)maps(?:\/|$)/.test(url.pathname);
const validHash=value=>typeof value==='string'&&/^[a-f\d]{64}$/i.test(value);
const manifestMaxAgeMs=5*60*1000;

function dependencies(text,url,type){
  const found=new Set();let match;
  const patterns=type==='html'?[/[\s<](?:src|href)\s*=\s*["']([^"']+)["']/gi]:type==='css'?[/url\(\s*["']?([^\s"')]+)["']?\s*\)/gi,/\@import\s+["']([^"']+)["']/gi]:[/\b(?:import|export)\s*(?:[^;\n]*?\bfrom\s*)?["']([^"']+)["']/gi,/\bimport\(\s*["']([^"']+)["']\s*\)/gi];
  for(const re of patterns)while((match=re.exec(text))){
    try{const child=new URL(match[1],url);if(local(child)&&!mapResource(child)&&/\.(?:js|mjs|css|png|webp|jpg|jpeg|svg|ico|woff2?|webmanifest)(?:$|\?)/i.test(child.pathname+child.search))found.add(child.href);}catch{}
  }
  return found;
}

async function cacheShellResponse(homeResponse){
  if(!homeResponse.ok)throw new Error('大厅加载失败');
  const cache=await caches.open(SHELL),html=await homeResponse.clone().text();
  const queue=[...dependencies(html,HOME,'html'),new URL('manifest.webmanifest',SCOPE).href],seen=new Set();
  // Cache the referenced CSS/JS graph before replacing the working HTML. An
  // interrupted update therefore leaves the previous offline lobby usable.
  while(queue.length){
    const url=queue.shift();if(seen.has(url))continue;seen.add(url);
    const response=await fetch(url,{cache:'reload'});if(!response.ok)throw new Error(`大厅资源不可用: ${url}`);
    const ext=new URL(url).pathname;
    if(/\.(?:m?js|css)$/.test(ext))for(const dep of dependencies(await response.clone().text(),url,ext.endsWith('.css')?'css':'js'))if(!seen.has(dep))queue.push(dep);
    if(ext.endsWith('.webmanifest')){const manifest=await response.clone().json();for(const icon of manifest.icons||[]){const u=new URL(icon.src,url);if(local(u)&&!mapResource(u))queue.push(u.href);}}
    await cache.put(url,response);
  }
  await cache.put(HOME,homeResponse);
}
async function cacheShell(){await cacheShellResponse(await fetch(HOME,{cache:'reload'}));}

self.addEventListener('install',event=>{event.waitUntil(cacheShell().then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil(self.clients.claim());});
self.addEventListener('message',event=>{
  if(event.data?.type==='CACHE_SHELL')event.waitUntil(cacheShell().then(()=>event.ports[0]?.postMessage({ok:true}),error=>event.ports[0]?.postMessage({ok:false,error:error.message})));
});

async function verifiedAsset(assets,file){
  if(!validHash(file?.sha256))return;
  const expected=file.sha256.toLowerCase(),key=hashKey(expected),response=await assets.match(key);
  if(!response)return;
  try{
    const bytes=await response.arrayBuffer();
    if(response.status===200&&(!Number.isSafeInteger(file.bytes)||file.bytes===bytes.byteLength)){
      const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
      const actual=Array.from(digest,byte=>byte.toString(16).padStart(2,'0')).join('');
      if(actual===expected){
        const headers=new Headers(response.headers);
        headers.delete('content-encoding');headers.delete('transfer-encoding');
        headers.set('content-length',String(bytes.byteLength));
        return new Response(bytes,{headers});
      }
    }
  }catch{}
  await assets.delete(key).catch(()=>{});
}

async function cachedAsset(url){
  try{
    const meta=await caches.open(META),assets=await caches.open(ASSETS);
    const version=url.searchParams.get('v'),offline=self.navigator?.onLine===false;
    for(const manifestURL of [MANIFEST,new URL('assets/asset-manifest-mobile.json',SCOPE).href]){
      const response=await meta.match(manifestURL);
      if(!response)continue;
      const savedAt=Number(response.headers.get('x-dust2-manifest-fetched-at')),age=Date.now()-savedAt;
      if(!version&&!offline&&(!savedAt||age<0||age>manifestMaxAgeMs))continue;
      const manifest=await response.json().catch(()=>null);
      if(!Array.isArray(manifest?.files))continue;
      const file=manifest.files.find(file=>typeof file?.path==='string'&&file.path.startsWith('assets/')
        &&new URL(file.path,SCOPE).href===url.origin+url.pathname&&validHash(file.sha256)
        &&(!version||file.sha256.toLowerCase().startsWith(version)));
      const hit=await verifiedAsset(assets,file);
      if(hit)return hit;
    }
    if(version||offline){
      const indexed=await meta.match(indexKey(url));
      if(indexed)return await verifiedAsset(assets,await indexed.json().catch(()=>null));
    }
  }catch{
    // Unavailable storage falls through to a regular network request.
  }
}

self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  if(request.method!=='GET'||!local(url)||url.pathname.startsWith('/__installed__/'))return;
  const relative=url.pathname.slice(SCOPE.pathname.length);
  if(/^(?:play(?:\/|$)|maps(?:\/|$)|api(?:\/|$)|ws(?:\/|$)|health(?:\/|$)|config(?:\/|$)|__asset_cache__\/)/.test(relative))return;
  // Bootstrap, catalog and delivery settings must be read from the server.
  // Asset JSON keeps its existing SHA-based offline behavior.
  if(!relative.startsWith('assets/')&&/\.json$/.test(url.pathname))return;
  // The page refreshes this small manifest and falls back to its metadata
  // copy itself. Serving an old asset index here would hide new releases.
  if(/^assets\/asset-manifest(?:-mobile)?\.json$/.test(relative))return;
  if(request.mode==='navigate'){
    if(url.pathname!==SCOPE.pathname&&url.pathname!==new URL('index.html',SCOPE).pathname)return;
    event.respondWith((async()=>{
      try{const response=await fetch(request);if(!response.ok)throw new Error('大厅暂时不可用');event.waitUntil(cacheShellResponse(response.clone()).catch(()=>{}));return response;}
      catch{const cache=await caches.open(SHELL);return await cache.match(HOME)||new Response('<!doctype html><meta charset="utf-8"><title>Dust II</title><h1>尚未保存离线大厅</h1><p>请联网打开一次；多人对战需要网络。</p>',{status:503,headers:{'content-type':'text/html; charset=utf-8'}});}
    })());return;
  }
  // The page owns integrity verification and writes large assets once. The
  // worker serves those bytes offline without creating a second map cache.
  if(relative.startsWith('assets/')&&!/\.(?:m?js|css)$/.test(url.pathname)){
    if(request.cache==='reload'||request.cache==='no-store')return;
    event.respondWith((async()=>await cachedAsset(url)
      ||await caches.open(SHELL).then(cache=>cache.match(request)).catch(()=>null)
      ||fetch(request))());return;
  }
  event.respondWith((async()=>{
    const cache=await caches.open(SHELL),hit=await cache.match(request);
    if(hit)return hit;
    const response=await fetch(request);
    if(response.ok&&/\.(?:m?js|css|png|svg|ico|woff2?|webmanifest)$/.test(url.pathname))event.waitUntil(cache.put(request,response.clone()));
    return response;
  })());
});
