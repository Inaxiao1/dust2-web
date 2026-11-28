import './style.css';
import {laddersForMap,PRIVATE_MOVEMENT_MODEL} from '../shared/ladder-movement.js';
import {configurePrivateMap} from '../shared/private-map-context.js';
import {privateConfig} from './private-game-config.js';
import {MIRAGE_JUMP_LINKS} from '../shared/private-map-jump-links.js';
import {sha256Hex} from '../shared/sha256.js';
import {initDownloadOrigin} from './download-origin.js';
import {hydrateHomeImages} from './image-asset-url.js';
import {privateMapDownloads,privateMapFetcher} from './private-map-download.js';
import {mountPortalRoom} from './portal-room.js';
import {consumeDirectoryJoin} from '../scripts/maps/mode-ui/room-directory.js';
import {getStaticRuntime,gameApiURL,lobbyHref,parseMatchRoute} from '../shared/static-runtime.js';
import {resourceResponseError,retryResource} from './resource-retry.js';

// Single-lobby flow: /perf/ (or Toy ./) is the only lobby & armory/settings homepage.
// /perf/play/<map>/ (or Toy play.html?map=<map>) is strictly the match runtime.
const parsedMatchRoute=parseMatchRoute(location.href);
const directoryRoute=parsedMatchRoute?[null,parsedMatchRoute.quality?'quality/':'',parsedMatchRoute.mapId]:null;
const initialParams=new URLSearchParams(location.search);
const hasDirectMatchIntent=Boolean(initialParams.get('room')||initialParams.get('autostart')==='1');
let redirectedToLobby=false;
if(directoryRoute){
 if(!hasDirectMatchIntent){
  redirectedToLobby=true;
  location.replace(lobbyHref('?map='+encodeURIComponent(directoryRoute[2])));
 }else{
  mountPortalRoom(directoryRoute[2],directoryRoute[1]?'quality':'performance');
  const menuEl=document.getElementById('menu');
  const loadingEl=document.getElementById('loading-screen');
  if(menuEl)menuEl.hidden=true;
  if(loadingEl)loadingEl.hidden=false;
  const loadLabel=document.getElementById('load-label');
  if(loadLabel)loadLabel.textContent='正在进入战局并载入地图资源…';
 }
}

async function bootstrap(){
 if(redirectedToLobby)return null;
 const rt=getStaticRuntime();
 const request=(url,label,cache='no-store')=>retryResource(async()=>{
  const response=await fetch(url,{cache});
  if(!response.ok)throw resourceResponseError(response,label+'暂不可用 ('+response.status+')');
  return response.json();
 });
 const configEndpoint=rt&&parsedMatchRoute
  ? gameApiURL('/perf/play/'+parsedMatchRoute.mapId+'/private-map.json')
  : new URL('private-map.json',location.href);
 const originalConfig=privateConfig(await request(configEndpoint,'私有地图配置'),location.href,{apiOrigin:rt?.gameServerOrigin||null});
 const delivery=await retryResource(()=>initDownloadOrigin({configURL:new URL('../../../download-config.json',originalConfig.renderUrl),pageURL:location.href}));
 hydrateHomeImages();
 const config=privateMapDownloads(originalConfig,delivery),mapFetch=privateMapFetcher(config);
 const jumpLinks=config.id==='de_mirage'?MIRAGE_JUMP_LINKS:[];
 const jumpDigest=await sha256Hex(JSON.stringify(jumpLinks));
 if(config.jumpLinksSha256!==jumpDigest)throw Error('私有地图跳点与服务器版本不同');
 const verifiedJSON=async(url,expected,label)=>{
  const bytes=await retryResource(async retry=>{
   const response=await mapFetch(url,{cache:retry?'reload':'no-store'});
   if(!response.ok)throw resourceResponseError(response,label+'暂不可用 ('+response.status+')');
   return response.arrayBuffer();
  });
  if(await sha256Hex(bytes)!==expected)throw Error(label+'与服务器版本不同');
  return JSON.parse(new TextDecoder().decode(bytes));
 };
 // Local Toy assets, a configured map CDN, or the game's own radar files.
 const radarBase=rt
  ? new URL('./radars/',document.baseURI)
  : delivery.mapBaseURL
    ? new URL('../radars/',delivery.mapBaseURL)
    : new URL('../../../radars/',config.renderUrl);
 const [meta,nav,transforms]=await Promise.all([
  verifiedJSON(config.metadataUrl,config.metadataSha256,'出生与包点信息'),
  verifiedJSON(config.navUrl,config.navigationSha256,'导航'),
  request(new URL('transforms.json',radarBase),'地图雷达标定',rt?'force-cache':'default'),
 ]);
 if(meta.id!==config.id||meta.public!==false||meta.sourceSha256!==config.sourceSha256)throw Error('原始地图版本与服务器不一致');
 if(config.movementModel===PRIVATE_MOVEMENT_MODEL){
  const ladderHash=await sha256Hex(JSON.stringify(laddersForMap(meta)));
  if(ladderHash!==config.laddersSha256)throw Error('梯子数据与服务器版本不同');
 }
 const map=configurePrivateMap(meta,nav,config);
 const radar=transforms[map.id];if(!radar||![radar.pos_x,radar.pos_y,radar.scale].every(Number.isFinite))throw Error('地图雷达标定缺失');
 map.overview={...radar,size:1024,image:new URL(map.id+'.png',radarBase).href};
 map.version='CS2 private '+meta.sourceBuild+' / '+config.mapSignature.slice(0,12);
 map.labels=[...Object.entries(map.sites).map(([text,p])=>({...p,text})),...['CT','T'].map(team=>({...map.spawns[team][0],text:team+' SPAWN'}))];
 globalThis.__DUST2_PRIVATE_MAP__=config;
 document.body.classList.add('private-game');document.title=map.nameZh+' · 随时随地CS';
 for(const card of document.querySelectorAll('[data-map-id]')){const selected=card.dataset.mapId===map.id;card.classList.toggle('selected',selected);card.setAttribute('aria-pressed',String(selected));}
 for(const label of document.querySelectorAll('.selected-map-name'))label.textContent=map.name.toUpperCase();
 for(const el of document.querySelectorAll('.hero-copy h1,.loading-map-title h1'))el.textContent=map.name.toUpperCase();
 for(const el of document.querySelectorAll('.map-subtitle,.loading-location'))el.textContent=map.nameZh;
 const mapLabel=document.querySelector('.play-bar>span:nth-child(2)');if(mapLabel)mapLabel.textContent=map.name.toUpperCase()+' · '+map.nameZh;
 const region=document.querySelector('.match-heading .region');if(region)region.textContent=map.name.toUpperCase();
 const pauseHeading=document.querySelector('#pause-menu .eyebrow');if(pauseHeading)pauseHeading.textContent=map.name.toUpperCase()+' / IN MATCH';
 const boardHeading=document.querySelector('#scoreboard .board-heading h2');if(boardHeading){boardHeading.replaceChildren(document.createTextNode(map.name.toUpperCase()+' '));const label=document.createElement('small');label.textContent='战况';boardHeading.append(label);}
 for(const el of document.querySelectorAll('.map-emblem img,.loading-tactical img')){el.src=map.overview.image;el.alt=map.name+' 战术地图';}
 const banner=document.querySelector('.loading-map-title>p');if(banner)banner.textContent=map.nameZh+' · 5v5 联网战术对战';
 const cover=rt
  ? new URL('./mode-previews/'+map.id+'-performance.webp',document.baseURI).href
  : delivery.mapBaseURL
    ? new URL('../mode-previews/'+map.id+'-performance.webp',delivery.mapBaseURL).href
    : new URL('../../../mode-previews/'+map.id+'-performance.webp',config.renderUrl).href;
 if(!directoryRoute&&!config.publicPool)document.documentElement.style.setProperty('--loading-map-cover',`url(${JSON.stringify(cover)})`);
 if(!directoryRoute){const style=document.createElement('style');style.textContent=`body.private-game .loading-image,body.private-game .menu-photo{background-image:url(${JSON.stringify(cover)})}body.private-game .map-showcase{background-image:none}
 body.private-game .private-map-switch{display:inline-flex;gap:12px;align-items:center;justify-content:center;min-height:40px;padding:9px 16px;border:1px solid #8e7950;background:#26332d;color:#f3d995;text-decoration:none;font-size:12px;white-space:nowrap;font-weight:650}
 body.private-game .play-bar>.private-map-switch{margin-left:auto}body.private-game .private-map-switch:hover{background:#35443a}body.private-game .private-map-switch:focus-visible{outline:2px solid #f3d995;outline-offset:3px}body.private-game .private-map-switch span{font-size:10px;font-weight:400;color:#cbd2bd}
 body.private-game .pause-map-switch{width:100%;min-height:42px;margin-top:5px}body.private-game .pause-actions{flex-wrap:wrap}
 @media(max-width:760px){body.private-game .private-map-switch{min-height:36px;padding:7px 11px;font-size:11px}body.private-game .play-bar>.private-map-switch span{display:none}body.private-game .play-bar{gap:12px;flex-wrap:wrap}body.private-game .play-bar>span:nth-child(2){max-width:42vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}}
 `;document.head.append(style);}
 const modeLibrary=config.flatOnly||config.graphicsMode==='quality';
 if(!directoryRoute)for(const back of document.querySelectorAll('[data-map-library]'))back.href=modeLibrary?lobbyHref():new URL('../../',location.href).href;
 if(modeLibrary){
  document.title=map.nameZh+' · 随时随地CS';
  const cards=document.querySelector('.home-map-grid');
  if(cards){const link=document.createElement('a');link.className='private-map-switch';link.href=lobbyHref();link.textContent='更换地图';cards.replaceChildren(link);}
  const promo=document.querySelector('.menu-profile span');if(promo)promo.textContent='ONLINE';
 }
 return import('./main.js');
}
export const ready=bootstrap().then(module=>{
 if(!module)return null;
 for(const button of document.querySelectorAll('[data-enable-after-map]'))button.disabled=false;
 if(directoryRoute){
  const target=consumeDirectoryJoin(new URL(location.href),url=>history.replaceState(null,'',url));
  if(target){
   module.joinDirectoryRoom(target,true);
  }else{
   const currentUrl=new URL(location.href);
   const rawRoom=(currentUrl.searchParams.get('room')||'').replace(/[^A-Za-z0-9]/g,'').slice(0,12);
   if(rawRoom){
    const requestedMode=currentUrl.searchParams.get('matchMode')==='deathmatch'?'deathmatch':'defuse';
    module.joinDirectoryRoom({code:rawRoom,mode:requestedMode},true);
   }else{
    const requestedMode=currentUrl.searchParams.get('matchMode')||'defuse';
    const requestedBots=currentUrl.searchParams.get('bots');
    const requestedTeam=currentUrl.searchParams.get('team')||'auto';
    currentUrl.searchParams.delete('autostart');
    currentUrl.searchParams.delete('matchMode');
    currentUrl.searchParams.delete('bots');
    currentUrl.searchParams.delete('team');
    history.replaceState(null,'',currentUrl);
    module.quickStartRoom({mode:requestedMode,bots:requestedBots,team:requestedTeam});
   }
  }
 }
 return module;
}).catch(error=>{
 console.error(error);
 if(directoryRoute){
  const loadingEl=document.getElementById('loading-screen');
  const errBox=document.getElementById('loading-error');
  const errText=document.getElementById('loading-error-text');
  const spinner=document.getElementById('loading-spinner');
  const backBtn=document.getElementById('back-load');
  const retryBtn=document.getElementById('retry-load');
  if(loadingEl)loadingEl.hidden=false;
  if(errBox)errBox.hidden=false;
  if(errText)errText.textContent='无法进入战局：'+error.message;
  if(spinner)spinner.hidden=true;
  if(retryBtn)retryBtn.onclick=()=>location.reload();
  if(backBtn){backBtn.textContent='返回大厅';backBtn.onclick=()=>location.assign(lobbyHref());}
 }else{
  const status=document.getElementById('menu-status');if(status)status.textContent='无法启动地图：'+error.message;
  for(const id of ['start-button','join-button']){const button=document.getElementById(id);if(button)button.disabled=true;}
 }
 throw error;
});
// Private HTML uses this module directly; keep its rejection handled as well.
ready.catch(()=>{});
