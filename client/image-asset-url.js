import {assetDownloadURL,getDownloadOrigin,initDownloadOrigin} from './download-origin.js';
import {bundled} from './bundled-assets.js';

/** Shared UI art follows the verified delivery config; installed art stays local.
 * Radar/preview URLs outside this document's assets directory stay unchanged. */
export function imageAssetURL(value,pageURL=document.baseURI){
 if(bundled)return value;
 const original=new URL(value,pageURL),mapped=assetDownloadURL(original,{pageURL});
 return mapped.href===original.href?value:mapped.href;
}
export function hydrateHomeImages(root=document){
 for(const image of root.querySelectorAll('img[data-game-src]'))image.src=imageAssetURL(image.dataset.gameSrc);
}
export async function initHomeImages(){
 if(!bundled&&!getDownloadOrigin())await initDownloadOrigin({pageURL:document.baseURI});
 hydrateHomeImages();
}
// Hidden <img> still download. Assign map art only after Start/Join, never on
// card selection. Mirage's verified bootstrap supplies its own radar/cover.
export function prepareHomeMapImages(mapId,root=document){
 root.documentElement.style.setProperty('--loading-map-cover','none');
 for(const image of root.querySelectorAll('img[data-map-image]')){
  if(image.dataset.mapImage===mapId)image.src=imageAssetURL(image.dataset.mapSrc);
  else image.removeAttribute('src');
 }
 const rt = globalThis.__CS2_STATIC_RUNTIME__;
 if(mapId==='de_dust2'){
  const dust2Cover = rt ? new URL('./mode-previews/de_dust2-performance.webp',document.baseURI).href : new URL(imageAssetURL('assets/valve-dust2/de_dust2_1_png.png'),document.baseURI).href;
  root.documentElement.style.setProperty('--loading-map-cover',`url(${JSON.stringify(dust2Cover)})`);
 }else if(globalThis.__DUST2_PRIVATE_MAP__?.mapId===mapId){
  const render=globalThis.__DUST2_PRIVATE_MAP__.renderUrl;
  const isPerfCdn = typeof render === 'string' && render.includes('/compiled/');
  const radar=rt ? new URL('./radars/'+mapId+'.png',document.baseURI).href : new URL('../../../radars/'+mapId+'.png',render).href;
  const cover=rt
   ? new URL('./mode-previews/'+mapId+'-performance.webp',document.baseURI).href
   : isPerfCdn
     ? new URL('../../../mode-previews/'+mapId+'-performance.webp',render).href
     : new URL('../../../previews/'+mapId+'.png',render).href;
  for(const image of root.querySelectorAll('.loading-tactical img,.map-emblem img')){image.src=radar;image.alt=mapId+' 战术地图';}
  root.documentElement.style.setProperty('--loading-map-cover',`url(${JSON.stringify(cover)})`);
 }
}
