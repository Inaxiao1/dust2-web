import {startingPistolForTeam} from '../shared/weapon-loadout.js';
import {FramePacer} from '../shared/frame-pacer.js';
import {MobileAim,mountMobileAimSettings} from './mobile-aim.js';
import {frameLimit,mountFrameSettings} from './frame-settings.js';
import {CLIENT_BUILD,RULES_VERSION,ASSET_VERSION,compatibilityError} from '../shared/online-build.js';
import {GameChat} from './chat.js';
import {combatPhase,equipmentPhase} from '../shared/round-actions.js';
import {ShotPrediction} from './shot-prediction.js';
import {RevolverTrigger,REVOLVER_PRIMARY_FIRE_DELAY_MS,weaponFireInterval} from '../shared/revolver.js';
import {normalizeClarity,renderPixelRatio,flatDrawingBuffer,normalizeFlatScale} from '../shared/render-quality.js';
import {mobileDevice} from './device-profile.js';
import './mobile-layout.css';
import {mountMobileShell} from './mobile-shell.js';
import {normalizeVideo,viewportSize} from '../shared/video-settings.js';
import {TouchControls,mountTouchSettings} from './touch-controls.js';
import {mountLobby} from './lobby.js';
import {preferences} from './persistence.js';
import {MatchAudio,mountMusicSettings} from './match-audio.js';
import {BombView} from './bomb-view.js';
import {RoomMenu} from './room-menu.js';
import './style.css';
import './controls.css';
import './interface.css';
import './cs2-hud.css';
import { GameControls, formatBinding } from './controls.js';
import { MatchView } from './match-view.js';
import { RuntimeDiagnostics, disconnectMessage } from './runtime-diagnostics.js';
import { CS2_BASE_FOV, cs2FovToVertical, mouseRadiansPerCount, DEFAULT_CROSSHAIR, normalizeCrosshair } from '../shared/cs2-settings.js';
import { Crosshair } from './crosshair.js';
import {mountBotSettings} from './bot-settings.js';
import {normalizeBotDifficulty,botDifficultyName} from '../shared/bot-difficulty.js';
import { mountSettings } from './settings-ui.js';
import { getStoredVisualStyle, setStoredVisualStyle, applyVisualStyleToScene, getVisualStylePreset } from './arena-look-presets.js';
import { upgradeAllSelects, upgradeSelect } from './tactical-select.js';
import { ToyIdentity, getStoredOperatorName, getStoredOperatorUid } from '../scripts/maps/mode-ui/toy-identity.js';
import { getSharedToyProgress } from './toy-cloud-progress.js';
import { ProgressionMenu } from './progression-menu.js';
import { applyDeltaSnapshot } from '../shared/snapshot-delta.js';
import { WeaponShop } from './shop.js';
import {LoadoutMenu} from './loadout-menu.js';
import { AgentMenu } from './agent-menu.js';
import { loadAgent,loadAgentArms,loadedPlayerAsset,requestAgent } from './player-assets.js';
import { DEFAULT_AGENT_IDS,getAgent } from '../shared/agents.js';
import { SkinMenu } from './skin-menu.js';
import { getSkin } from '../shared/skins.js';
import { STARTER_SKINS } from '../shared/progression.js';
import { warmRoomSkin, releaseRoomHands } from './skin-assets.js';
import { selectedSkinIds, skinResources } from '../shared/room-cosmetics.js';
import { queryRoomAppearance, readRoomAppearance, preloadRoomSkins, prepareRoomWeapons, reserveWarmIds } from './room-skin-preload.js';
import { createGameSocket, markRtcBackoff } from './rtc-transport.js';
import { mountOfflineMenu } from './offline-menu.js';
import * as THREE from 'three';
import { createWeaponLighting } from './weapon-lighting.js';
import {entryRenderQuality, flatMapSelected, mountMapStyle} from './map-style.js';
import { createMapScene } from './map-scene.js';
import { initPhysics, createPlayerState, stepPlayer, raycastWorld } from '../shared/physics.js';
import {PRIVATE_MOVEMENT_MODEL} from '../shared/ladder-movement.js';
import { MAP } from '../shared/map-data.js';
import { getWeapon, canTeamUseWeapon, defaultPrimaryForTeam, weaponSpeedScale } from '../shared/weapons.js';
import { UTILITY_IDS, EQUIPMENT } from '../shared/equipment.js';
import { UtilityEffects } from './utility-effects.js';
import { GameAudio } from './audio.js';
import { loadModels, PlayerModel, ViewWeapon } from './models.js';
import { Effects } from './shot-effects.js';
import { DroppedWeapons } from './dropped-weapons.js';
import { MatchPresentation } from './match-presentation.js';
import {RemotePlayers} from './remote-players.js';
import {aimPitch,eyePosition,accuracyForShot} from '../shared/aim.js';
import {ScopeOverlay} from './scope-overlay.js';
import {MovementPrediction} from './movement-prediction.js';
import {movementState} from '../shared/movement-commands.js';
import { HUD } from './hud.js';
import { downloadAssets, releaseDownloads } from './loading.js';
import { connectionTarget } from './connection-target.js';
import {knifeInterval} from '../shared/melee.js';
import {privateCompatibilityError} from './private-game-config.js';
import {parseMatchRoute,lobbyHref} from '../shared/static-runtime.js';

import {expandGlassState} from '../shared/private-map-breakables.js';
const privateMap=globalThis.__DUST2_PRIVATE_MAP__||null;
const TICKET_STORAGE_KEY='cs.join.ticket.v1';
const RESUME_STORAGE_KEY='cs.resume.v1';
function consumeJoinTicket(expectedMapId){
  try{
    const raw=sessionStorage.getItem(TICKET_STORAGE_KEY);
    if(!raw)return null;
    sessionStorage.removeItem(TICKET_STORAGE_KEY);
    const ticket=JSON.parse(raw);
    if(!ticket||typeof ticket.workerWsUrl!=='string'||typeof ticket.joinToken!=='string')return null;
    if(expectedMapId&&ticket.mapId&&ticket.mapId!==expectedMapId)return null;
    if(Number.isFinite(ticket.expiresAt)&&Date.now()/1000>ticket.expiresAt-2)return null;
    const u=new URL(ticket.workerWsUrl);
    if(!['ws:','wss:'].includes(u.protocol))return null;
    return ticket;
  }catch{return null;}
}
function readStoredResume(mapId,roomCode){
  if(!roomCode)return null;
  try{
    const raw=sessionStorage.getItem(RESUME_STORAGE_KEY);
    if(!raw)return null;
    const saved=JSON.parse(raw);
    if(!saved||saved.room!==roomCode||(saved.mapId||'de_dust2')!==(mapId||'de_dust2'))return null;
    if(Date.now()>(saved.expiresAt||0)){sessionStorage.removeItem(RESUME_STORAGE_KEY);return null;}
    return saved.resumeToken||null;
  }catch{return null;}
}
function saveStoredResume(mapId,roomCode,resumeToken,graceMs){
  try{
    if(!resumeToken||!roomCode){sessionStorage.removeItem(RESUME_STORAGE_KEY);return;}
    sessionStorage.setItem(RESUME_STORAGE_KEY,JSON.stringify({mapId:mapId||'de_dust2',room:roomCode,resumeToken,expiresAt:Date.now()+(graceMs||30000)}));
  }catch{}
}
let stagedJoinTicket=consumeJoinTicket(privateMap?.mapId||'de_dust2');
let activeResumeToken=null,activeReconnectGraceMs=30000,intentionalLeave=false,reconnectTimer=null,reconnectAttempts=0,lastFullSnapshot=null;
const snapHistory=new Map();
let lastAppliedSid=0,lastAckedSid=0,lastSentAckSid=0,lastAckSentAt=0,lastResyncReqAt=0;
function clearReconnect(){if(reconnectTimer){clearTimeout(reconnectTimer);reconnectTimer=null;}reconnectAttempts=0;}
const baseConnection = privateMap?{socketURL:privateMap.socketURL,inviteBase:null,offline:false}:connectionTarget(location.href, globalThis.__DUST2_PORTABLE__);
const connection = stagedJoinTicket?{...baseConnection,socketURL:stagedJoinTicket.workerWsUrl}:baseConnection;

const $=id=>document.getElementById(id);
const canvas=$('game-canvas');
canvas.tabIndex=-1;
const isPortalPerfMap = Boolean(privateMap && parseMatchRoute(location.href));
const storedQualityPref = preferences.getItem('dust2.quality.v2');
let quality = isPortalPerfMap
  ? (storedQualityPref === 'high' ? 'high' : 'low')
  : entryRenderQuality(storedQualityPref, privateMap);
let visualStyle = getStoredVisualStyle();
const isHighQualityTextured = () => quality === 'high' && Boolean(privateMap?.texturedRender);
const startTexturedHigh = Boolean(isPortalPerfMap && quality === 'high' && privateMap?.texturedRender);
let renderer;
try{renderer=new THREE.WebGLRenderer({canvas,antialias:!startTexturedHigh&&(mobileDevice()||privateMap?.flatOnly===true),powerPreference:'high-performance'});}catch(e){$('menu-status').textContent='无法启动 3D：请启用浏览器硬件加速后重试。';throw e;}
renderer.setPixelRatio(1);renderer.setSize(innerWidth,innerHeight);renderer.shadowMap.enabled=false;renderer.shadowMap.type=THREE.PCFShadowMap;renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.03;renderer.info.autoReset=false;
const scene=new THREE.Scene();
const camera=new THREE.PerspectiveCamera(cs2FovToVertical(CS2_BASE_FOV),innerWidth/innerHeight,.14,320);camera.rotation.order='YXZ';
const gunScene=new THREE.Scene();
const gunCamera=new THREE.PerspectiveCamera(62,innerWidth/innerHeight,.025,10);gunCamera.rotation.order='YXZ';gunScene.add(gunCamera);
const weaponLighting=createWeaponLighting(renderer,gunScene);
function rebuildWeaponEnvironment(){weaponLighting.rebuild();}
const hud=new HUD();
const audio=new GameAudio({context:globalThis.__DUSTII_BOOT_AUDIO_CONTEXT__||null});
delete globalThis.__DUSTII_BOOT_AUDIO_CONTEXT__;
const matchAudio=new MatchAudio(audio),bombView=new BombView(scene);
const actors=new Map();
const remotePlayers=new RemotePlayers();
const movementPrediction=new MovementPrediction();let movementSupported=false;
const scopeOverlay=new ScopeOverlay($('scope'));
const effects=new Effects(scene);
const utilityEffects=new UtilityEffects(scene);
const matchView=new MatchView();
const matchPresentation=new MatchPresentation(document.body,{onReturn:()=>{
  $('leave-button').click();
  if(document.body.classList.contains('portal-room'))location.assign(lobbyHref('#onlineRooms'));
},onEnd:()=>{clearGameInput();document.exitPointerLock?.();$('pause-menu').hidden=true;}});
const droppedWeapons=new DroppedWeapons(scene);
let spectatorLook=null;
let displayedHostBots=null;
const visibilityFrustum=new THREE.Frustum(),visibilityMatrix=new THREE.Matrix4(),actorBounds=new THREE.Sphere(new THREE.Vector3(),1.6);
const frameSamples=[];
function frameStats(){const percentile=key=>{const values=frameSamples.map(s=>s[key]).sort((a,b)=>a-b);return Math.round((values[Math.floor(values.length*.95)]||0)*100)/100;};return {samples:frameSamples.length,frameP95Ms:percentile('frame'),cpuP95Ms:percentile('cpu'),actorsP95Ms:percentile('actors'),renderSubmitP95Ms:percentile('render')};}
let diagnosticStorage=null;try{diagnosticStorage=localStorage;}catch{}
const diagnostics=new RuntimeDiagnostics(diagnosticStorage);
if(document.wasDiscarded)diagnostics.event('browser-discard-restored');
let contextLost=false,spectating=null;

let viewWeapon=null, socket=null,connectionId=null,myId=null,room=null,mode='defuse',snapshot=null,self=null;
let loaded=false,loading=false,connected=false,lookYaw=0,lookPitch=0,slot=1;
let mouseFire=false,pendingFirePress=false,pendingAltFirePress=false,scoped=false,seq=0,lastShot=0,fireTimer=0,recoil=0;
let fixed=0,networkAcc=0,hudAcc=0,pingAcc=0,lastTime=performance.now(),fps=60,ping=0,lastStep=0;
let lastSnapshotAlive=false,previousHealth=100,inviteBase=connection.inviteBase;
let primary='ak47',primaryExplicit=false,downloadAbort=null,pendingJoin=false;
const handledEvents=new Set();
let previousWeapon=null,previousReload=0;
let modelsReady=false,mapResultCache=null;
mountMapStyle(() => {
  // Only the lobby offers this control. Release the previous WebGL context
  // and its decoded texture cache before building another material profile.
  if (mapResultCache || loaded) location.reload();
  else resizeViewport();
});
const shotPrediction=new ShotPrediction();
const revolverTrigger=new RevolverTrigger();
let serverAmmo=0,lastSnapshotAt=0,lastShotWarning=0,lastSentInputSeq=-1,shotId=0,lastShotEvidence=null;
let storedSettings=preferences.readJSON('dust2.cs-settings.v1');
let radarRotate=storedSettings.radarRotate!==false;
let mobileClarity=normalizeClarity(storedSettings.mobileClarity);
let flatRenderScale=normalizeFlatScale(storedSettings.flatRenderScale);
let preferredBotDifficulty=normalizeBotDifficulty(storedSettings.botDifficulty);
function saveBotPreference(value){preferredBotDifficulty=normalizeBotDifficulty(value);if($('home-bot-difficulty'))$('home-bot-difficulty').value=preferredBotDifficulty;preferences.setItem('dust2.cs-settings.v1',JSON.stringify({...preferences.readJSON('dust2.cs-settings.v1'),botDifficulty:preferredBotDifficulty}));}
if($('home-bot-difficulty')){$('home-bot-difficulty').value=preferredBotDifficulty;$('home-bot-difficulty').addEventListener('change',event=>{saveBotPreference(event.target.value);if(preferredBotDifficulty==='vitality'&&Number($('bots').value)<5)$('bots').value='5';});}
const videoDefaults=privateMap?{aspect:'4:3',display:'stretch'}:normalizeVideo();
const privateVideo=Boolean(privateMap&&!privateMap.publicPool);
let video=normalizeVideo(privateVideo?{...videoDefaults,...storedSettings.privateVideo}:storedSettings),viewport=viewportSize(innerWidth,innerHeight,video);
let sensitivity=Math.max(.05,Math.min(100,Number(storedSettings.sensitivity)||1));
let zoomSensitivity=Math.max(.05,Math.min(10,Number(storedSettings.zoomSensitivity)||1));
let invertY=Boolean(storedSettings.invertY);
let crosshairSettings=normalizeCrosshair(storedSettings.crosshair||DEFAULT_CROSSHAIR);
let brightness=Math.max(60,Math.min(160,Number(preferences.getItem('dust2.brightness'))||100));
let utilityId='hegrenade';
let pendingBurstMode=null,lastGlockTrigger=null;
let zoomLevel=0, resumeZoom=0, zoomResumeAt=0, lastSlot=2, jumpId=0, reloadId=0;
let touchControls=null,touchPlaying=false,mobileShell=null;
const mobileAim=new MobileAim({storage:preferences,raycast:raycastWorld});
const chat=new GameChat({send,onOpen:()=>{clearGameInput();sendInput(currentInput());$('scoreboard').hidden=true;document.exitPointerLock?.();},onClose:()=>lockPointer()});
const crosshair=new Crosshair($('crosshair'),{settings:crosshairSettings,getViewport:()=>viewport});
const controls=new GameControls({target:window,storage:preferences,enabled:(action)=>{
  if(!connected||$('loadout-menu')?.hidden===false||$('touch-layout-editor')?.hidden===false||$('settings-menu')?.hidden===false||$('skin-menu')?.hidden===false||$('offline-menu')?.hidden===false||$('agent-menu')?.hidden===false||$('room-menu')?.hidden===false||$('progression-menu')?.hidden===false)return false;
  if(chat.opened)return false;
  if(['chatAll','chatTeam'].includes(action))return $('buy-menu').hidden;
  if(snapshot?.match?.status==='ended')return false;
  if(['buy','menu'].includes(action))return true;
  if(action==='scoreboard')return inputCaptured()&&$('buy-menu').hidden&&$('pause-menu').hidden;
  return inputCaptured()&&$('buy-menu').hidden&&$('pause-menu').hidden&&(self?.alive||(['fire','altFire','interact'].includes(action)&&!contextLost));
},onAction:controlAction});
const shop=new WeaponShop($('buy-menu'),{buy:async weapon=>{
  if(!connected){shop.result({ok:false,message:'连接已断开，请重新加入。'});return;}
  send({type:'buy',weapon});
},refund:weapon=>send({type:'refund',weapon}),request:weapon=>send({type:'requestWeapon',weapon}),donate:(playerId,weapon)=>send({type:'donateWeapon',playerId,weapon}),close:()=>toggleBuy()});
function persistSettings(){
  preferences.setItem('dust2.cs-settings.v1',JSON.stringify({...preferences.readJSON('dust2.cs-settings.v1'),sensitivity,zoomSensitivity,invertY,crosshair:crosshairSettings,quality,brightness,mobileClarity,flatRenderScale,radarRotate,botDifficulty:preferredBotDifficulty,...(privateVideo?{privateVideo:video}:video)}));
}
function syncPauseSensitivityUI(){
  if($('sensitivity'))$('sensitivity').value=sensitivity;
  if($('sensitivity-range'))$('sensitivity-range').value=String(Math.min(50,Math.max(.1,sensitivity)));
  if($('sens-value'))$('sens-value').textContent=sensitivity.toFixed(2);
}
function applySensitivity(value){
  const n=Number(value);
  if(!Number.isFinite(n)||n<.05||n>100)return false;
  sensitivity=Math.round(n*100)/100;
  persistSettings();
  syncPauseSensitivityUI();
  return true;
}
function applyVolume(value){
  volume=Math.max(0,Math.min(1,Number(value)||0));
  audio.setVolume(volume);
  if($('volume'))$('volume').value=volume;
  if($('vol-value'))$('vol-value').textContent=`${Math.round(volume*100)}%`;
  preferences.setItem('dust2.volume',volume);
}
const settingsUI=mountSettings({controls,crosshair,videoDefaults,isInMatch:()=>Boolean(connected||loaded||isPortalPerfMap),getSettings:()=>({sensitivity,zoomSensitivity,invertY,crosshair:crosshairSettings,quality,visualStyle,brightness,mobileClarity,flatRenderScale,radarRotate,botDifficulty:preferredBotDifficulty,...video}),onSettings:values=>{
  if(values.aspect!==undefined||values.display!==undefined){video=normalizeVideo({...video,...values});resizeViewport();}
  if(values.radarRotate!==undefined)radarRotate=values.radarRotate;
  if(values.flatRenderScale!==undefined){flatRenderScale=normalizeFlatScale(values.flatRenderScale);resizeViewport();}
  if(values.mobileClarity!==undefined){mobileClarity=normalizeClarity(values.mobileClarity);resizeViewport();}
  if(values.sensitivity!==undefined)sensitivity=values.sensitivity;
  if(values.zoomSensitivity!==undefined)zoomSensitivity=values.zoomSensitivity;
  if(values.invertY!==undefined)invertY=Boolean(values.invertY);
  if(values.crosshair)crosshairSettings=values.crosshair;
  if(values.visualStyle!==undefined)setVisualStyle(values.visualStyle);
  if(values.quality!==undefined)setQuality(values.quality);
  if(values.brightness!==undefined)setBrightness(values.brightness);
  persistSettings();
  syncPauseSensitivityUI();
}});
const botSettings=mountBotSettings(settingsUI,{getState:()=>({connected,host:snapshot?.hostId===connectionId,value:connected?snapshot?.botDifficulty:preferredBotDifficulty}),onChange:value=>{if(connected)send({type:'setBotDifficulty',botDifficulty:value});else saveBotPreference(value);}});
mountMusicSettings(settingsUI,matchAudio,audio,{getVolume:()=>volume,setVolume:applyVolume});
matchAudio.onKitChange=kit=>{if(connected)send({type:'equipMusic',kit});};
mountFrameSettings(settingsUI);
let pendingSkinEquip=null,lastSkinEquipAt=0;
async function equipSkin(skin){
  if(!connected)return;
  const wait=Math.max(0,300-(performance.now()-lastSkinEquipAt));if(wait)await new Promise(resolve=>setTimeout(resolve,wait));
  if(!connected)throw new Error('连接已断开，请重试。');
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pendingSkinEquip=null;reject(new Error('服务器确认超时，请重试。'));},5000);pendingSkinEquip={skin:skin.id,resolve:()=>{clearTimeout(timer);pendingSkinEquip=null;resolve();},reject:message=>{clearTimeout(timer);pendingSkinEquip=null;reject(new Error(message));}};lastSkinEquipAt=performance.now();send({type:'equipSkin',weapon:skin.weapon,skin:skin.id});});
}
const toyProgress=getSharedToyProgress(globalThis[Symbol.for('cs2.toyIdentity')]||new ToyIdentity());
const progressionUI=new ProgressionMenu({progressStore:toyProgress,onOpenSkins:()=>skins.open(),onOpenAgents:()=>agentsUI.open(self?.team||$('team').value)});
const skins=new SkinMenu({progressStore:toyProgress,onEquip:equipSkin,onLoadout:()=>armory.open(),onProgression:()=>progressionUI.open()});
let pendingLoadout=null;
const armory=new LoadoutMenu({progressStore:toyProgress,getSkins:()=>skins.loadout,onSaved:()=>updateTeamLoadoutLabels(),openSkins:()=>skins.open(),canEdit:()=>!connected||myId===connectionId&&(mode==='deathmatch'||['waiting','freeze'].includes(snapshot?.round?.phase)),onApply:async weaponLoadout=>{
  if(!connected)return;
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pendingLoadout=null;reject(new Error('服务器确认超时，请重试。'));},5000);pendingLoadout={resolve:weaponLoadout=>{clearTimeout(timer);pendingLoadout=null;resolve(weaponLoadout);},reject:message=>{clearTimeout(timer);pendingLoadout=null;reject(new Error(message));}};send({type:'setWeaponLoadout',weaponLoadout});});
}});
let pendingAgentEquip=null;
const agentsUI=new AgentMenu({progressStore:toyProgress,onProgression:()=>progressionUI.open(),onEquip:async agent=>{
 if(!connected||agent.team!==self?.team)return;
 return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pendingAgentEquip=null;reject(new Error('服务器确认超时'));},5000);pendingAgentEquip={id:agent.id,resolve:()=>{clearTimeout(timer);pendingAgentEquip=null;resolve();},reject:message=>{clearTimeout(timer);pendingAgentEquip=null;reject(new Error(message));}};send({type:'equipAgent',agent:agent.id});});
}});
toyProgress.identity.addEventListener('change',()=>{const s=toyProgress.identity.state;if(s?.displayName&&$('nickname'))$('nickname').value=s.displayName;});
toyProgress.addEventListener('unlock',ev=>{
  const {skins:newSkins=[],agents:newAgents=[]}=ev?.detail||{};
  if(newAgents.length)hud.toast(`🎉 解锁新探员：${newAgents[0].name}${newAgents.length>1?` 等 ${newAgents.length} 名`:''}`);
  else if(newSkins.length)hud.toast(`🎉 解锁新皮肤：${getWeapon(newSkins[0].weapon)?.name||''} · ${newSkins[0].name}${newSkins.length>1?` 等 ${newSkins.length} 款`:''}`);
});
void toyProgress.init();
const roomMenu=new RoomMenu({send,invite,onClose:resume=>{clearGameInput();if(resume)lockPointer();else $('pause-menu').hidden=false;}});
const offlineMenu=mountOfflineMenu();
if(privateMap){
  offlineMenu.element.querySelector('.config-card>p').textContent=privateMap.publicPool?'当前地图按需加载并缓存；枪械、探员与声音在公共地图间复用。这里可单独保存共用装备与声音。':'原始地图按需从私有服务器载入。这里保存共用枪械、探员与声音；地图原始文件不会重复写入浏览器缓存。';
  offlineMenu.element.querySelector('#save-base-assets').textContent='保存共用装备与声音';
  offlineMenu.element.querySelector('#install-game').hidden=true;
}
touchControls=new TouchControls({controls,storage:preferences,getFov:zoomFov,onLook:d=>{if(!gameSurfaceActive()||!self?.alive)return;mobileAim.manualLook(d);lookYaw+=d.yaw;lookPitch=THREE.MathUtils.clamp(lookPitch+d.pitch,-1.48,1.48);},onCancel:()=>{clearGameInput();mouseFire=false;shotPrediction.triggered=false;pendingFirePress=false;pendingAltFirePress=false;if(connected)sendInput({...currentInput(),cancelGrenade:true});},onMode:enabled=>{touchPlaying=false;clearGameInput();if(connected)$('pause-menu').hidden=false;if(enabled)document.exitPointerLock?.();resizeViewport();},onRoom:()=>{roomMenu.update(snapshot,connectionId);roomMenu.open();},onFullscreen:()=>mobileShell?.enter(true)});
mountTouchSettings(settingsUI,touchControls);mountMobileAimSettings(settingsUI,mobileAim);
mobileShell=mountMobileShell({settingsUI,storage:preferences,onStatus:text=>hud.toast(text)});
let volume=Number(preferences.getItem('dust2.volume')??.6);

audio.setVolume(volume);$('volume').value=volume;$('vol-value').textContent=`${Math.round(volume*100)}%`;syncPauseSensitivityUI();syncPauseVisualUI();
$('nickname').value=getStoredOperatorName();
if($('pause-visual-style'))upgradeSelect($('pause-visual-style'),{variant:'pills',compact:true});
upgradeSelect($('host-bots'),{variant:'stepper',compact:true});
upgradeAllSelects(settingsUI.element,{
  'cs-aspect':{variant:'pills'},
  'cs-display':{variant:'pills'},
  'cs-radar-direction':{variant:'pills'},
  'cs-quality':{variant:'cards'},
  'cs-flat-render-scale':{variant:'pills'},
  'cs-mobile-clarity':{variant:'pills'},
  'frame-limit':{variant:'pills'},
  'bot-difficulty':{variant:'cards'},
  'music-kit':{variant:'grid'},
  'music-preview-cue':{variant:'grid',compact:true},
  'touch-mode':{variant:'pills'},
  'mode':{variant:'pills'},
  'assist':{variant:'pills'},
});
const initialQuery=new URLSearchParams(location.search);if(initialQuery.has('room')){$('room-code').value=initialQuery.get('room').replace(/[^A-Za-z0-9]/g,'').slice(0,12);$('menu-status').textContent='好友邀请已就绪，输入呼号后点击加入房间。';}

function setLoadStage(stage,label){
  $('load-label').textContent=label;
  const order=['download','scene','connect'];
  document.querySelectorAll('[data-load-step]').forEach(el=>{el.classList.toggle('active',el.dataset.loadStep===stage);el.classList.toggle('done',order.indexOf(el.dataset.loadStep)<order.indexOf(stage));});
  $('cancel-load').disabled=stage==='scene'&&!privateMap;
  if(stage!=='download'){$('load-percent').textContent=stage==='scene'?'准备中':'连接中';$('load-rate').textContent='';}
}
function downloadProgress(p){
  const percent=p.total?Math.min(100,p.bytes/p.total*100):0;
  $('load-percent').textContent=`${percent.toFixed(0)}%`;$('load-fill').style.width=`${percent}%`;
  const mb=n=>(n/1048576).toFixed(1);
  $('load-bytes').textContent=`已载入 ${mb(p.bytes)} / ${mb(p.total)} MB`;
  $('load-files').textContent=`${p.complete} / ${p.count} 个文件`;
  $('load-rate').textContent=p.rate>0?`资源读取 ${mb(p.rate)} MB/s`:'';
  const labels={map:'下载 Dust II 地图与原版材质',collision:'载入地图碰撞',characters:'载入对战角色',weapons:'下载武器、皮肤与手部动作'};
  $('load-label').textContent=labels[p.current]||'准备资源下载';
}
function privateLoadProgress(label,p){
  $('load-label').textContent=label;if(!p)return;
  const mb=n=>(n/1048576).toFixed(1),gpu=p.phase?.startsWith('gpu-');
  if(p.phase==='map-manifest'){$('load-percent').textContent='原图清单';$('load-fill').style.width='0%';$('load-bytes').textContent='通用武器与声音已就绪，开始读取所选地图';$('load-files').textContent='正在检查原图版本';$('load-rate').textContent='';return;}
  if(gpu){setLoadStage('scene',label);const ratio=p.count?p.complete/p.count:0;$('load-percent').textContent=p.count?Math.round(ratio*100)+'%':'显卡准备';$('load-fill').style.width=(ratio*100)+'%';$('load-bytes').textContent='原图资源已读取 · 正在显卡准备';$('load-files').textContent=p.count?`${p.complete} / ${p.count} ${p.phase==='gpu-upload'?'张纹理':'个视角'}`:'';$('load-rate').textContent='';return;}
  const percent=p.total?Math.min(100,p.bytes/p.total*100):0;setLoadStage(p.phase==='map-download'?'download':'scene',label);
  $('load-percent').textContent=p.phase==='map-download'?percent.toFixed(0)+'%':'材质准备';$('load-fill').style.width=percent+'%';
  $('load-bytes').textContent=`本图已读取 ${mb(p.bytes)} / ${mb(p.total)} MB`+(p.cacheBytes?` · 本地复用 ${mb(p.cacheBytes)} MB`:'');
  const pending=p.pending?.[0],name=pending?.name?.length>38?pending.name.slice(0,35)+'…':pending?.name;
  $('load-files').textContent=`文件 ${p.complete} / ${p.count} · 解码 ${p.decoded} / ${p.textureCount}`+(pending?` · 等待 ${name}`:'');
  $('load-rate').textContent=p.rate>0?'资源读取 '+mb(p.rate)+' MB/s':'';
}
function loadError(error){
  $('loading-screen').hidden=false;
  $('loading-error').hidden=false;$('loading-error-text').textContent=`${error.message || error}。可重试加载。`;
  $('loading-spinner').hidden=true;$('cancel-load').disabled=false;
  $('menu-status').textContent=`加载未完成：${error.message || error}`;
  loading=false;$('start-button').disabled=false;$('join-button').disabled=false;
}
const paint=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
function send(data){if(socket?.readyState!==WebSocket.OPEN)return false;socket.send(JSON.stringify(data));return true;}
function sendUnreliable(data){if(socket?.readyState!==WebSocket.OPEN)return false;const raw=JSON.stringify(data);if(socket.sendUnreliable)socket.sendUnreliable(raw);else socket.send(raw);return true;}
function sendInput(input){if(input.seq<=lastSentInputSeq||socket?.readyState!==WebSocket.OPEN)return false;lastSentInputSeq=input.seq;const ackPart=lastAckedSid>0?{ackSid:lastAckedSid}:{};if(lastAckedSid>0){lastSentAckSid=lastAckedSid;lastAckSentAt=performance.now();}return send({type:'input',bodyId:myId,lifeId:self?.lifeId,...ackPart,...input,...(movementSupported?{moves:movementPrediction.packet(),moveId:movementPrediction.nextId}: {})});}
function cancelRevolverPrepare(){revolverTrigger.reset();viewWeapon?.prepareRevolver(false);audio.cancelChannel('revolver-prepare');}
function clearGameInput(){touchControls?.clear();mobileAim.clear();controls.clear();mouseFire=false;pendingFirePress=false;pendingAltFirePress=false;shotPrediction.triggered=false;cancelRevolverPrepare();}
function inputCaptured(){return document.pointerLockElement===canvas||!!(touchControls?.enabled&&touchPlaying);}
function gameSurfaceActive(){return connected&&!chat.opened&&inputCaptured()&&!contextLost&&!document.hidden&&!['menu','pause-menu','buy-menu','room-menu','settings-menu','skin-menu','loadout-menu','agent-menu','offline-menu','touch-layout-editor'].some(id=>$(id)?.hidden===false);}
function controlsEnabled(){return gameSurfaceActive()&&self?.alive&&combatPhase(snapshot?.round?.phase);}
function movementControlsEnabled(){return gameSurfaceActive()&&self?.alive&&['live','ended'].includes(snapshot?.round?.phase);}
function equipmentControlsEnabled(){return gameSurfaceActive()&&self?.alive&&equipmentPhase(snapshot?.round?.phase);}
function currentInput(){
  const enabled=controlsEnabled(),moving=movementControlsEnabled();
  if(controls.consume('jump')&&moving)jumpId++;
  if(controls.consume('reload')&&enabled)reloadId++;
  const firePressed=controls.consume('fire');
  // A render frame can occur without a 60 Hz simulation step. Retain a short click
  // until simulation consumes it, just as jump/reload IDs survive between ticks.
  const utility=slot===4;
  if(!enabled||utility)pendingFirePress=false;else if(firePressed)pendingFirePress=true;
  return {seq:++seq,forward:moving?THREE.MathUtils.clamp(Number(controls.down('forward'))-Number(controls.down('back'))+(touchControls?.axes.forward||0),-1,1):0,right:moving?THREE.MathUtils.clamp(Number(controls.down('right'))-Number(controls.down('left'))+(touchControls?.axes.right||0),-1,1):0,yaw:lookYaw,pitch:aimPitch(lookPitch,recoil),jump:moving&&controls.down('jump'),jumpId,crouch:moving&&controls.down('crouch'),walk:moving&&controls.down('walk'),fire:enabled&&(utility?controls.down('fire'):(mouseFire||pendingFirePress)),fire2:enabled&&(utility||self?.weapon==='knife'||self?.weapon==='revolver')&&(controls.down('altFire')||pendingAltFirePress),cancelGrenade:!enabled,reload:enabled&&controls.down('reload'),reloadId,slot,utilityId,zoomLevel,speedScale:weaponSpeedScale(self?.weapon,zoomLevel),interact:equipmentControlsEnabled()&&controls.down('interact'),viewTime:remotePlayers.viewTime||null};
}
function resetScope(){zoomLevel=0;scoped=false;resumeZoom=0;zoomResumeAt=0;}
function zoomFov(){return getWeapon(self?.weapon).zoomFovs?.[zoomLevel]||CS2_BASE_FOV;}
function selectUtility(){const owned=UTILITY_IDS.filter(id=>(self?.utilityCounts?.[id]||0)>0);if(!owned.length){hud.toast('没有投掷物 · 按 B 购买');return;}const i=slot===4?owned.indexOf(utilityId):-1;utilityId=owned[(i+1)%owned.length];selectSlot(4);resetScope();sendInput(currentInput());}
function selectSlot(next){
  if(next===4&&!(self?.utilityCounts?.[utilityId]>0))utilityId=UTILITY_IDS.find(id=>self?.utilityCounts?.[id]>0)||'hegrenade';
  if(!self?.inventory?.some(id=>getWeapon(id).slot===next)||next===slot)return;
  cancelRevolverPrepare();lastSlot=slot;slot=next;fireTimer=Math.max(fireTimer,.2);resetScope();audio.cancelReload();
}
function takeoverTarget(){return matchView.takeoverTarget(self,snapshot,performance.now());}
function controlAction(action,{pressed,event,source}){
  if(['chatAll','chatTeam'].includes(action)){if(pressed)chat.open(action==='chatTeam'?'team':'all');return;}
  if(self&&!self.alive&&action==='interact'){const target=takeoverTarget();if(pressed&&source!=='clear'&&target)send({type:'takeBot',botId:target.id});return;}
  if(self&&!self.alive&&['fire','altFire'].includes(action)){if(pressed)matchView.cycle(self,snapshot,action==='fire'?1:-1);return;}
  if(action==='fire'){
    mouseFire=pressed&&controlsEnabled();
    if(slot>=4)sendInput({...currentInput(),...(source==='clear'?{cancelGrenade:true}:{} )});
    else if(mouseFire)localShoot(currentInput(),0);
    else {pendingFirePress=false;shotPrediction.triggered=false;cancelRevolverPrepare();sendInput(currentInput());}
    return;
  }
  if(action==='altFire'&&slot===4){sendInput({...currentInput(),...(source==='clear'?{cancelGrenade:true}:{} )});return;}
  if(action==='altFire'&&(slot===3||self?.weapon==='revolver')){if(pressed)pendingAltFirePress=true;if(source==='clear')pendingAltFirePress=false;if(self?.weapon==='revolver'){cancelRevolverPrepare();if(pressed)localShoot(currentInput(),0);else sendInput(currentInput());}else sendInput(currentInput());return;}
  if(action==='interact'){sendInput(currentInput());return;}
  if(action==='scoreboard'){$('scoreboard').hidden=!pressed;return;}
  if(!pressed)return;
  if(action==='drop'){if(equipmentControlsEnabled())send({type:'dropWeapon'});return;}
  if(action==='buy'){toggleBuy();return;}
  if(action==='menu'){$('buy-menu').hidden=true;$('scoreboard').hidden=true;document.exitPointerLock?.();$('pause-menu').hidden=false;clearGameInput();return;}
  if(action==='altFire'&&slot===self?.slot&&getWeapon(self?.weapon).burstSize&&equipmentControlsEnabled()){
    if(self.reloadRemaining>0||self.fireReadyRemaining>0||self.objectiveLocked||fireTimer>1e-8||shotPrediction.pending.length)return;
    const input=currentInput(),enabled=!(pendingBurstMode?.enabled??self.burstMode);
    if(sendInput({...input,toggleBurst:true}))pendingBurstMode={enabled,seq:input.seq};
    return;
  }
  if(action==='altFire'&&getWeapon(self?.weapon).zoomFovs?.length>1&&controlsEnabled()&&self.reloadRemaining<=0&&fireTimer<=0){zoomLevel=(zoomLevel+1)%getWeapon(self.weapon).zoomFovs.length;scoped=zoomLevel>0;resumeZoom=0;sendInput(currentInput());return;}
  if(action==='primary')selectSlot(1);
  if(action==='secondary')selectSlot(2);
  if(action==='knife')selectSlot(3);
  if(action==='bomb')selectSlot(5);
  if(action==='utility')selectUtility();
  if(action==='lastWeapon')selectSlot(lastSlot);
  if(action==='previousWeapon'||action==='nextWeapon'){
    const slots=[...new Set((self?.inventory||[]).map(id=>getWeapon(id).slot))].sort();
    if(slots.length)selectSlot(slots[(slots.indexOf(slot)+(action==='nextWeapon'?1:slots.length-1))%slots.length]);
  }
  if(action==='inspect'&&gameSurfaceActive()&&self?.alive)viewWeapon?.inspect();
  if(action==='reload'&&gameSurfaceActive()&&self?.alive){viewWeapon?.cancelInspect();resetScope();}
}


async function loadGame(audioUnlocked, directoryNavigation=false){
  // Cross-map joins can decode sounds before the browser allows playback.
  const prepareAudio = () => directoryNavigation ? audio.prepareSamples() : audioUnlocked.then(()=>audio.start());
  if(loaded){await prepareAudio();return;}
  setLoadStage('download',privateMap?'读取通用武器与声音资源':'下载地图与武器资源');
  downloadAbort=new AbortController();
  const signal=downloadAbort.signal;
  const useTexturedHigh = Boolean(privateMap?.texturedRender && typeof quality !== 'undefined' && quality === 'high');
  const flat = useTexturedHigh ? false : flatMapSelected();
  await downloadAssets({signal,flat:privateMap?true:flat,onProgress:downloadProgress});
  if(!privateMap)downloadAbort=null;
  setLoadStage('scene',useTexturedHigh?'载入 CS2 原版贴图与装备':flat?'准备标准场景与装备':mobileDevice()?'准备手机材质与骨骼动画':'解码原版材质与骨骼动画');await paint();
  // Original private maps are larger than the normal compressed Dust II scene.
  // Finish their decoding before starting the additional character/view models.
  if(privateMap&&!mapResultCache){mapResultCache=await createMapScene(scene,{signal,flat,highQuality:typeof quality!=='undefined'&&quality==='high',onProgress:privateLoadProgress});diagnostics.event('private-map-resources-ready',mapResultCache.loadStats);}
  if(privateMap)signal.throwIfAborted();
  // Do not leave audio readers running against a cancelled prefetch. The
  // context was unlocked by the click; samples start after resource preparation.
  const audioReady=prepareAudio();audioReady.catch(()=>{});
  // Wait for every parser before opening Retry. Successful heavy work is kept
  // so a failed audio/model request cannot append a second map on the next try.
  const tasks=await Promise.allSettled([
    modelsReady?Promise.resolve():loadModels().then(()=>{modelsReady=true;}),
    mapResultCache?Promise.resolve(mapResultCache):createMapScene(scene,{signal,flat,onProgress:message=>{$('load-label').textContent=message;}}).then(result=>{mapResultCache=result;return result;}),
    audioReady,
  ]);
  const failure=tasks.find(task=>task.status==='rejected');
  if(failure)throw failure.reason;
  if(privateMap)signal.throwIfAborted();
  const mapResult=mapResultCache;
  if(mapResult.breakables){const sounds=await import('./private-breakable-audio.js');await sounds.preparePrivateBreakableAudio(audio,signal,mapResult.breakables.entries.values());mapResult.breakables.onBroken=e=>sounds.playPrivateBreakableAudio(audio,e,{x:camera.position.x,y:camera.position.y,z:camera.position.z,yaw:camera.rotation.y});}
  $('load-label').textContent='建立碰撞与武器动作';await paint();const collisionStart=performance.now();
  initPhysics(mapResult.positions,null,privateMap?{map:privateMap.movementModel===PRIVATE_MOVEMENT_MODEL?MAP:null,collisionKey:()=>mapResult.breakableCollision.collisionKey(),mapPatches:false,airMovement:'source',triangleEnabled:(channel,index)=>mapResult.breakableCollision.triangleEnabled(channel,index),copyPositions:false,sharedChannelMask:mapResult.sharedChannelMask||null,bulletPositions:mapResult.bulletPositions,grenadePositions:mapResult.grenadePositions}:undefined);
  if(privateMap){mapResult.positions=null;mapResult.bulletPositions=null;mapResult.grenadePositions=null;mapResult.sharedChannelMask=null;}
  viewWeapon ||= new ViewWeapon(gunCamera);applyQuality();
  if(privateMap)diagnostics.event('private-map-collision-ready',{durationMs:Math.round(performance.now()-collisionStart)});
  if(privateMap)privateLoadProgress('编译原图着色器（显卡准备）',{phase:'gpu-compile'});else $('load-label').textContent='预热场景与武器着色器';await paint();const shaderStart=performance.now();
  const spawn=MAP.spawns[$('team').value==='CT'?'CT':'T'][0];camera.position.set(spawn.x,spawn.y+1.62,spawn.z);
  let shaderTimeout;
  try{await Promise.race([(async()=>{await renderer.compileAsync(scene,camera);await renderer.compileAsync(gunScene,gunCamera);})(),new Promise((_,reject)=>{shaderTimeout=setTimeout(()=>reject(new Error('显卡准备超时，请关闭其他应用后重试')),60000);})]);}finally{clearTimeout(shaderTimeout);}
  if(privateMap){
    diagnostics.event('private-map-shaders-ready',{durationMs:Math.round(performance.now()-shaderStart)});
    signal.throwIfAborted();camera.rotation.set(spawn.pitch||0,spawn.yaw||0,0,'YXZ');
    const {warmPrivateMap}=await import('./private-map-warmup.js');
    const warmup=await warmPrivateMap({renderer,scene,camera,gunScene,gunCamera,signal,yieldFrame:paint,onProgress:privateLoadProgress});
    diagnostics.event('private-map-gpu-ready',warmup);signal.throwIfAborted();
    lastTime=lastRenderTime=performance.now();fpsFrames=0;fpsSeconds=0;frameSamples.length=0;
  }
  loaded=true;downloadAbort=null;releaseDownloads();
}

async function start(joinExisting=false, directoryNavigation=false){
  if(touchControls?.enabled&&!directoryNavigation)mobileShell?.enter();
  if(loading)return;loading=true;pendingJoin=joinExisting;matchAudio.stop();
  $('start-button').disabled=true;$('join-button').disabled=true;$('loading-screen').hidden=false;
  $('loading-error').hidden=true;$('loading-spinner').hidden=false;
  $('loading-mode').textContent=$('mode').value==='defuse'?'经典爆破 · 回合制':'团队死斗 · 自动重生';
  $('loading-team').textContent={T:'进攻方 T',CT:'防守方 CT',auto:'自动平衡阵营'}[$('team').value];
  const weapon=getWeapon(primary);$('loading-weapon').textContent=`${weapon.name} · ${getSkin(skins.loadout[primary])?.name||weapon.skin}`;
  $('menu-status').textContent='正在加载战场。资源会缓存，之后进入更快。';
  setLoadStage(loaded?'connect':'download',loaded?'连接对战房间':'准备资源清单');
  const audioUnlocked=directoryNavigation?Promise.resolve():audio.resume();audioUnlocked.catch(()=>{});
  try{
    await loadGame(audioUnlocked,directoryNavigation);
    downloadAbort=new AbortController();
    const signal=downloadAbort.signal;
    setLoadStage('download','核对房间武器外观');
    const code=$('room-code').value.trim().toUpperCase();
    let appearance=joinExisting?await queryRoomAppearance(connection.socketURL,code,{signal}):readRoomAppearance({});
    const sides=$('team').value==='auto'?['CT','T']:[$('team').value];
    const ownAgents=sides.map(side=>agentsUI.loadout[side]);
    const prepared={hands:new Set(),files:new Set()};
    const onFiles=({done,total,cached,downloadBytes})=>{
      $('load-label').textContent=`准备房间武器外观 ${done} / ${total} · 已缓存 ${cached}`;
      const percent=total?Math.round(done/total*100):100;
      $('load-fill').style.width=percent+'%';$('load-percent').textContent=percent+'%';
      $('load-bytes').textContent=`本次下载 ${(downloadBytes/1048576).toFixed(1)} MB`;
      $('load-files').textContent=`${done} / ${total} 个外观文件`;$('load-rate').textContent='';
    };
    for(let attempt=0;appearance;attempt++){
      const deathmatch=(appearance.mode||$('mode').value)==='deathmatch';
      const pistols=sides.map(side=>startingPistolForTeam(armory.loadout,side));
      const rifles=deathmatch?sides.map(side=>canTeamUseWeapon(side,primary)?primary:defaultPrimaryForTeam(side)):[];
      const ownHands=selectedSkinIds(skins.loadout,deathmatch?rifles:pistols);
      const ownReserves=selectedSkinIds(skins.loadout,[...pistols,'knife']);
      const botWeapons=new Set();
      if(!joinExisting && Number($('bots').value)>0){
        for(const side of ['T','CT']){
          const botSkins={...STARTER_SKINS,knife:side==='T'?'default-t-vanilla':'default-ct-vanilla'};
          for(const id of selectedSkinIds(botSkins,[startingPistolForTeam(null,side),'knife',...(deathmatch?[defaultPrimaryForTeam(side)]:[])]))botWeapons.add(id);
        }
      }
      setLoadStage('download',attempt?'装备已变更，补充房间外观':'准备房间探员与第一人称手套');
      $('load-bytes').textContent='正在并发加载探员、手套与音效';
      $('load-files').textContent='已跳过重复资源';$('load-rate').textContent='';
      await Promise.all([
        ...[...new Set([...ownAgents,...appearance.agentIds])].map(id=>loadAgent(id,{signal})),
        ...[...new Set(ownAgents)].map(id=>loadAgentArms(id,{signal})),
        matchAudio.prepareRoom(appearance.musicKitIds||[],!joinExisting&&Number($('bots').value)>0,signal),
      ]);
      const visible=[...ownHands,...appearance.activeSkinIds,...ownReserves,...botWeapons];
      const reserves=reserveWarmIds(appearance.carriedSkinIds,visible,mobileDevice());
      const activeHands=[...new Set([...visible,...reserves])].filter(id=>!prepared.hands.has(id));
      if(activeHands.length){
        const readyHashes=new Set(skinResources(prepared.files).map(item=>item.sha256));
        await preloadRoomSkins(activeHands,{signal,readyHashes,onProgress:onFiles});
      }
      const result=await prepareRoomWeapons({active:[...visible,...reserves],
        carried:appearance.skinIds,prepared,signal,warm:(id,signal)=>warmRoomSkin(id,signal,renderer),onFiles,
        onModel:(done,total)=>{
          const step=done+1,percent=total?Math.round(step/total*100):100;
          setLoadStage('scene',`解码手持武器与动作 ${step} / ${total}`);
          $('load-fill').style.width=percent+'%';$('load-percent').textContent=percent+'%';
          $('load-bytes').textContent='地图与材质已就绪 · 正在解码武器模型';
          $('load-files').textContent=`${step} / ${total} 把手持武器`;$('load-rate').textContent='';
        }});
      diagnostics.event('room-skins-ready',result);
      setLoadStage('connect','建立多人对战连接');
      $('load-fill').style.width='100%';$('load-percent').textContent='100%';
      $('load-bytes').textContent='优先建立低延迟 UDP 直连';
      $('load-files').textContent='自动兼容 WebSocket 线路';$('load-rate').textContent='';
      appearance=await connect(joinExisting,attempt===0&&joinExisting?appearance.revision:null);
    }
    if(!connected){
      releaseRoomHands();
      if(!$('loading-screen').hidden&&$('loading-error').hidden&&!intentionalLeave){
        loadError(new Error('未能建立战局连接，请重试'));
      }
    }
    downloadAbort=null;
  }
  catch(e){releaseRoomHands();downloadAbort=null;if(e.name==='AbortError'){$('loading-screen').hidden=true;loading=false;$('start-button').disabled=false;$('join-button').disabled=false;$('menu-status').textContent='已取消加载。';}else{console.error(e);loadError(e);}}
}
function connect(joinExisting,revision,resumeOpts=null,transportOpts=null){
  clearReconnect();
  if(socket){intentionalLeave=true;socket.close(1000,'reconnect');}
  intentionalLeave=false;
  const ticket=resumeOpts?null:stagedJoinTicket;
  if(ticket)stagedJoinTicket=null;
  const baseWsUrl=ticket?.workerWsUrl||connection.socketURL;
  const wsTarget=new URL(baseWsUrl);
  if(ticket?.joinToken)wsTarget.searchParams.set('token',ticket.joinToken);
  const url=wsTarget.href;
  const wsFallbackUrls=!ticket&&Array.isArray(privateMap?.wsFallbackUrls)
    ? privateMap.wsFallbackUrls.map(raw=>{const u=new URL(raw);if(wsTarget.search)u.search=wsTarget.search;return u.href;})
    : [];
  const forceWs=Boolean(transportOpts?.forceWs);
  let activeSocket=null;
  const onTransportStatus=({phase})=>{
    if(socket!==activeSocket||connected||$('loading-screen').hidden)return;
    if(phase==='ws-fallback'){
      $('load-bytes').textContent='UDP 连接超时，自动切换 WebSocket 稳定线路…';
      $('load-files').textContent='正在建立 WebSocket 加密连接';
    }else if(phase==='ws-direct'){
      $('load-bytes').textContent='使用 WebSocket 稳定线路连接中…';
      $('load-files').textContent='正在同步对战房间';
    }else if(phase==='udp-open'||phase==='ws-open'){
      $('load-bytes').textContent=phase==='udp-open'?'UDP 直连已建立，正在进入战局…':'WebSocket 已连接，正在进入战局…';
      $('load-files').textContent='正在同步房间与玩家状态';
    }
  };
  socket=createGameSocket(url,{enableRtc:!forceWs,wsFallbackUrls,onStatus:onTransportStatus});activeSocket=socket;
  let settle;
  const outcome=new Promise(resolve=>{settle=resolve;});
  let rejected=false,gotServerReply=false,handingOff=false,udpWelcomeTimer=null;
  const clearConnectTimers=()=>{clearTimeout(timeout);if(udpWelcomeTimer){clearTimeout(udpWelcomeTimer);udpWelcomeTimer=null;}};
  const isResuming=!!resumeOpts?.resumeToken;
  const timeout=setTimeout(()=>{
    if(!connected&&socket===activeSocket){
      clearConnectTimers();
      rejected=true;
      $('menu-status').textContent='服务器连接超时，请确认游戏服务已启动。';
      if(!$('loading-screen').hidden)loadError(new Error('服务器连接超时，请检查网络后重试'));
      settle(null);
      activeSocket.close(1000,'timeout');
    }
  },12000);
  socket.addEventListener('open',()=>{if(socket!==activeSocket)return;const name=$('nickname').value.trim()||'Player';preferences.setItem('dust2.name',name);
    const reqRoom=resumeOpts?.room||ticket?.roomCode||(joinExisting?$('room-code').value.trim().toUpperCase():undefined);
    const reqExisting=isResuming?true:(ticket?.action==='join'?true:(ticket?.action==='create'?false:joinExisting));
    const storedResume=resumeOpts?.resumeToken||(reqExisting?readStoredResume(privateMap?.mapId||'de_dust2',reqRoom):null);
    lastFullSnapshot=null;snapHistory.clear();lastAppliedSid=0;lastAckedSid=0;lastSentAckSid=0;lastAckSentAt=0;lastResyncReqAt=0;
    activeSocket.send(JSON.stringify({type:'join',clientBuild:CLIENT_BUILD,rulesVersion:RULES_VERSION,assetVersion:ASSET_VERSION,rtcAsyncClose:1,ackDelta:1,...(privateMap?{mapId:privateMap.mapId,mapSignature:privateMap.mapSignature,physicsSha256:privateMap.physicsSha256}:{}),existing:reqExisting,...(revision?{appearanceRevision:revision}:{}),...(ticket?.joinToken?{joinToken:ticket.joinToken}:{}),...(storedResume?{resumeToken:storedResume}:{}),playerUid:toyProgress.uid||getStoredOperatorUid(),reconnect:true,snapshotDelta:1,name,movementProtocol:1,shotProtocol:1,room:reqRoom,mode:ticket?.mode||$('mode').value,team:$('team').value,primary,skins:skins.loadout,weaponLoadout:armory.loadout,agents:agentsUI.loadout,musicKit:matchAudio.kit,bots:Number($('bots').value),botDifficulty:preferredBotDifficulty}));
    // Watchdog for half-open UDP: if DataChannel opened but no server reply arrives within 3s,
    // transparently fall back to WebSocket instead of leaving the player stuck on the loading screen.
    if(!forceWs&&activeSocket.transportMode==='UDP'){
      udpWelcomeTimer=setTimeout(()=>{
        udpWelcomeTimer=null;
        if(gotServerReply||connected||socket!==activeSocket)return;
        clearConnectTimers();
        markRtcBackoff();
        if(!$('loading-screen').hidden){
          $('load-bytes').textContent='UDP 同步超时，自动切换 WebSocket 稳定线路…';
          $('load-files').textContent='正在重新连接对战房间';
        }
        handingOff=true;
        socket=null;intentionalLeave=true;
        activeSocket.close(1000,'udp-welcome-timeout');
        connect(joinExisting,revision,resumeOpts,{forceWs:true}).then(settle);
      },3000);
    }
  });
  socket.addEventListener('message',e=>{if(socket!==activeSocket)return;let data;try{data=JSON.parse(e.data);}catch{return;}
    if(data.type==='roomCosmeticsChanged' && revision && data.room===$('room-code').value.trim().toUpperCase()){
      gotServerReply=true;clearConnectTimers();socket=null;intentionalLeave=true;settle(readRoomAppearance(data));activeSocket.close(1000,'cosmetics');return;
    }
    if(data.type==='welcome'){
      gotServerReply=true;
      const incompatible=compatibilityError(data)||privateCompatibilityError(data,privateMap);if(incompatible){rejected=true;clearConnectTimers();loadError(new Error(incompatible));settle(null);activeSocket.close();return;}
      preferences.setItem('dust2.last-session',JSON.stringify({room:data.room,mode:data.mode,mapId:privateMap?.mapId||'de_dust2',at:Date.now()}));
      activeResumeToken=data.resumeToken||null;activeReconnectGraceMs=Number(data.reconnectGraceMs)||30000;reconnectAttempts=0;
      saveStoredResume(privateMap?.mapId||'de_dust2',data.room,activeResumeToken,activeReconnectGraceMs);
      movementSupported=data.movementProtocol===1;movementPrediction.reset();fixed=0;networkAcc=0;
      clearConnectTimers();displayedHostBots=null;matchPresentation.reset();connectionId=myId=data.id;room=data.room;mode=data.mode;connected=true;seq=0;shotId=0;lastShotEvidence=null;shotPrediction.reset();remotePlayers.clear();frameSamples.length=0;jumpId=0;reloadId=0;resetScope();clearGameInput();lastSentInputSeq=-1;shotPrediction.pending=[];self=null;lastSnapshotAlive=false;previousHealth=100;handledEvents.clear();previousWeapon=null;previousReload=0;hud.reset();chat.reset();chat.element.hidden=false;matchView.reset();spectating=null;diagnostics.event(data.resumed?'reconnected':'connected');
      document.exitPointerLock?.();document.body.classList.remove('mouse-captured');$('loading-screen').hidden=true;
      $('menu').hidden=true;$('hud').hidden=false;document.body.classList.add('playing');
      $('pause-menu').dataset.entry='first';
      $('pause-title').textContent=data.resumed?'重连成功':'准备就绪';
      $('pause-context').textContent=`房间 ${room} · ${data.team==='CT'?'反恐精英':'恐怖分子'} · ${mode==='defuse'?'竞技爆破':'团队死斗'}`;
      $('resume-button').firstChild.textContent='进入战场 ';
      $('pause-menu').hidden=false;
      roomMenu.update(snapshot,connectionId);
      $('room-label').textContent=room;$('board-room').textContent=`房间 ${room}`;$('room-code').value=room;
      const q=new URL(location.href);q.searchParams.set('room',room);history.replaceState(null,'',q);
      loading=false;$('start-button').disabled=false;$('join-button').disabled=false;
      hud.toast(data.resumed?'重连成功 · 已恢复战绩与经济':`已加入 ${data.team} 阵营 · 点击进入战场`);
      settle(null);
    } else if(data.type==='snapshot'||data.type==='snapshotDelta'){
      let full=null;
      if(Number.isInteger(data.sid)){
        if(data.sid<=lastAppliedSid)return;
        if(data.type==='snapshot'){
          full=data;
        }else{
          const base=Number.isInteger(data.baseSid)?snapHistory.get(data.baseSid):lastFullSnapshot;
          if(!base){
            const nowMs=performance.now();
            if(nowMs-lastResyncReqAt>350){lastResyncReqAt=nowMs;sendUnreliable({type:'snapAck',ackSid:0});}
            return;
          }
          full=applyDeltaSnapshot(data,base);
        }
        if(!full)return;
        snapHistory.set(data.sid,full);
        if(snapHistory.size>25){
          for(const oldSid of snapHistory.keys()){
            if(oldSid<data.sid-20)snapHistory.delete(oldSid);
            else break;
          }
        }
        lastAppliedSid=data.sid;
        lastAckedSid=data.sid;
        const nowMs=performance.now();
        if(lastAckedSid>lastSentAckSid&&nowMs-lastAckSentAt>150){
          lastSentAckSid=lastAckedSid;lastAckSentAt=nowMs;
          sendUnreliable({type:'snapAck',ackSid:lastAckedSid});
        }
      }else{
        full=data.type==='snapshotDelta'?applyDeltaSnapshot(data,lastFullSnapshot):data;
        if(!full)return;
      }
      lastFullSnapshot=full;
      const mismatch=privateCompatibilityError(full,privateMap);
      if(mismatch){rejected=true;clearConnectTimers();clearGameInput();document.exitPointerLock?.();loadError(new Error(mismatch));connected=false;activeSocket.close();return;}
      handleSnapshot(full);
    }
    else if(data.type==='events'&&snapshot){
      for(const ev of data.events||[]){
        if(ev.id&&handledEvents.has(ev.id))continue;
        if(ev.id){handledEvents.add(ev.id);if(handledEvents.size>512)handledEvents.delete(handledEvents.values().next().value);}
        hud.event(ev,snapshot,myId);handleEvent(ev);
      }
    }
    else if(data.type==='agentEquipped'){if(pendingAgentEquip?.id===data.agent)pendingAgentEquip.resolve();hud.toast(`已装备 ${getAgent(data.agent)?.name||'探员'}`);}
    else if(data.type==='skinEquipped'){if(pendingSkinEquip?.skin===data.skin)pendingSkinEquip.resolve();hud.toast(`已装备 ${getSkin(data.skin)?.name||'新皮肤'}`);}
    else if(data.type==='weaponLoadoutUpdated'){pendingLoadout?.resolve(data.weaponLoadout);hud.toast('装备携带配置已更新');}
    else if(data.type==='refund'){shop.result(data);hud.toast('已退还 '+getWeapon(data.weapon).name);}
    else if(data.type==='purchase'){shop.result(data);if(data.slot>0){lastSlot=slot;slot=data.slot;if(data.slot===4)utilityId=data.weapon;resetScope();}hud.toast(`已购买 ${(EQUIPMENT[data.weapon]||getWeapon(data.weapon)).name}`);}
    else if(data.type==='pong'){ping=Math.round(performance.now()-data.time);}
    else if(data.type==='botDifficultyUpdated'){if(data.ok){snapshot.botDifficulty=data.botDifficulty;saveBotPreference(data.botDifficulty);hud.toast('人机难度已设为'+botDifficultyName(data.botDifficulty));}botSettings.settle();}
    else if(data.type==='botsUpdated'){hud.toast(data.ok?'机器人数量已更新':data.message||'更新未完成');}
    else if(data.type==='weaponDropped'){if(data.ok)hud.toast('已丢弃 '+getWeapon(data.weaponId).name);}
    else if(data.type==='teamGear'){shop.message('已确认，请留意队伍聊天和地上的枪械。');}
    else if(data.type==='error'){gotServerReply=true;if(data.code==='CHAT_REJECTED')chat.error(data.message);if(data.code==='TEAM_GEAR_REJECTED')shop.message(data.message);if(data.code?.startsWith('BOT_DIFFICULTY'))botSettings.settle();if(data.code?.startsWith('AGENT'))pendingAgentEquip?.reject(data.message);if(data.code?.startsWith('SKIN'))pendingSkinEquip?.reject(data.message);if(data.code?.startsWith('LOADOUT'))pendingLoadout?.reject(data.message);if(/^(BUY|REFUND)/.test(data.code||''))shop.result({ok:false,message:data.message});hud.toast(data.message||'操作未完成');$('menu-status').textContent=data.message||'服务器拒绝连接';if(!connected){rejected=true;clearConnectTimers();loadError(new Error(data.message||'服务器拒绝连接'));settle(null);activeSocket.close();}}
  });
  socket.addEventListener('close',event=>{clearConnectTimers();if(socket!==activeSocket)return;const wasConnected=connected;connected=false;loading=false;mouseFire=false;$('start-button').disabled=false;$('join-button').disabled=false;if(rejected||intentionalLeave)return;
    const canAutoReconnect=(wasConnected||isResuming)&&event.code!==1000&&activeResumeToken&&room&&activeReconnectGraceMs>0&&reconnectAttempts<4;
    if(canAutoReconnect){
      const delayMs=Math.min(6000,1000*(2**reconnectAttempts));
      reconnectAttempts++;
      saveStoredResume(privateMap?.mapId||'de_dust2',room,activeResumeToken,activeReconnectGraceMs);
      hud.toast(`网络波动，${Math.round(delayMs/1000)}秒后自动重连 (${reconnectAttempts}/4)…`);
      diagnostics.event('reconnecting',{attempt:reconnectAttempts,code:event.code});
      reconnectTimer=setTimeout(()=>{reconnectTimer=null;connect(true,null,{room,resumeToken:activeResumeToken});},delayMs);
      return;
    }
    if(wasConnected||isResuming){clearReconnect();activeResumeToken=null;saveStoredResume(privateMap?.mapId||'de_dust2',room,null,0);diagnostics.event('disconnected',{code:event.code,reason:event.reason.slice(0,120),wasClean:event.wasClean});pendingLoadout?.reject('连接已断开');shop.cancel();pendingAgentEquip?.reject('连接已断开');pendingSkinEquip?.reject('连接已断开，请重新加入后装备。');if(snapshot?.match?.status==='ended'||snapshot?.round?.phase==='matchEnded')return;if(isPortalMatchRoute){showMenu();$('menu').hidden=true;loadError(new Error(disconnectMessage(event.code,event.reason)));return;}showMenu();$('menu-status').textContent=disconnectMessage(event.code,event.reason);}else if(!$('loading-screen').hidden)loadError(new Error('连接失败，请确认服务器地址和网络后重试')); });
  socket.addEventListener('error',()=>{if(socket!==activeSocket)return;if(!connected)$('menu-status').textContent='无法连接游戏服务器，请稍后重试。';});
  activeSocket.addEventListener('close',()=>{if(!handingOff)settle(null);},{once:true});
  return outcome;
}

function handleSnapshot(data){
  lastSnapshotAt=performance.now();
  const previousRound=snapshot?.round?.number;
  if(privateMap)expandGlassState(data,privateMap.breakables||[]);
  snapshot=data;if(privateMap&&Array.isArray(data.mapBreakables))mapResultCache?.breakableCollision?.applySnapshot(data.mapBreakables);mapResultCache?.breakables?.sync(data);botSettings.refresh();roomMenu.update(data,connectionId);utilityEffects.sync(data);droppedWeapons.sync(data);
  const identity=data.players.find(p=>p.id===connectionId);if(!identity)return;
  const bodyId=identity.controlledBotId||connectionId;
  if(bodyId!==myId){
    clearGameInput();myId=bodyId;self=null;lastSnapshotAlive=false;previousWeapon=null;previousReload=0;
    shotPrediction.pending=[];mouseFire=shotPrediction.triggered=pendingFirePress=pendingAltFirePress=false;fireTimer=0;recoil=0;
    resetScope();movementPrediction.reset();remotePlayers.clear();fixed=networkAcc=0;matchView.reset();spectating=null;
    actors.get(myId)?.dispose(scene);actors.delete(myId);
    if(bodyId!==connectionId)hud.toast('已控制己方人机 · 保留其装备与生命');
  }
  const body=data.players.find(p=>p.id===myId);if(!body)return;
  const p=bodyId===connectionId?body:{...body,kills:identity.kills,deaths:identity.deaths,assists:identity.assists,headshots:identity.headshots,roundKills:identity.roundKills,lifeKills:identity.lifeKills,killCards:identity.killCards};
  const relocated=!!self&&(p.team!==self.team||p.lifeId!==self.lifeId||previousRound!==data.round.number);
  if(relocated||!self||!p.alive||p.weapon!=='pistol'){pendingBurstMode=null;lastGlockTrigger=null;}
  if(pendingBurstMode&&p.seq>=pendingBurstMode.seq)pendingBurstMode=null;
  if(relocated||!self)remotePlayers.clear();remotePlayers.push(data,performance.now());
  matchPresentation.update(data,connectionId);
  if($('host-bot-controls')){$('host-bot-controls').hidden=data.hostId!==connectionId;if(displayedHostBots!==data.desiredBots){displayedHostBots=data.desiredBots;$('host-bots').value=String(data.desiredBots??0);}$('host-bots-status').textContent=`当前 ${data.botCount??0} 个机器人 · 房间最多 10 人`;}
  const life=matchView.update(p,data,performance.now());
  if(previousRound!==data.round.number)shop.cancel();
  if(life.died||life.respawned){shop.cancel();utilityEffects.resetFlash();clearGameInput();mouseFire=false;shotPrediction.triggered=false;resetScope();fireTimer=0;shotPrediction.pending=[];diagnostics.event(life.died?'death':'respawn');}
  if(previousWeapon!==p.weapon||!p.alive||!lastSnapshotAlive||!Number.isSafeInteger(p.shotAck)&&p.ammo>serverAmmo)shotPrediction.pending=[];
  else if(!Number.isSafeInteger(p.shotAck)&&p.ammo<serverAmmo)shotPrediction.pending.splice(0,serverAmmo-p.ammo);
  if(p.shotRejected&&p.shotRejected.id>(shotPrediction.lastRejected?.id||0)){
    diagnostics.event('shot-rejected',p.shotRejected);
    if(['expired','queue_full'].includes(p.shotRejected.reason)&&performance.now()-lastShotWarning>4000){lastShotWarning=performance.now();hud.toast('射击确认超时 · 网络或服务器响应延迟');}
  }
  shotPrediction.reconcile(p);
  serverAmmo=p.ammo;
  if(previousWeapon!==p.weapon||!p.alive){cancelRevolverPrepare();audio.cancelReload();audio.cancelDraw();if(p.alive){audio.prepareWeapon(p.weapon);audio.draw(p.weapon);}resetScope();}
  if(p.alive&&p.reloadRemaining>0&&(previousReload<=0||previousWeapon!==p.weapon||getWeapon(p.weapon).reloadStyle==='shell'&&p.reloadRemaining>previousReload+.05))audio.weaponReload(p.weapon,{team:p.team,duration:p.reloadDuration||p.reloadRemaining,elapsed:p.reloadElapsed,empty:p.reloadEmpty});
  if(previousWeapon&&getWeapon(previousWeapon).slot>=4&&getWeapon(p.weapon).slot<4){slot=p.slot;mouseFire=false;pendingFirePress=false;pendingAltFirePress=false;}
  if(!p.inventory.some(id=>getWeapon(id).slot===slot))slot=p.slot;
  if(previousWeapon!==p.weapon&&p.slot===4)utilityId=p.weapon;
  if(p.weapon==='c4'&&p.bombAction==='plant')slot=5;
  if(p.alive&&self?.alive&&self.id===p.id&&self.weapon===p.weapon&&getWeapon(p.weapon).burstSize&&!!self.burstMode!==!!p.burstMode)
    hud.toast(p.burstMode?'已切换至三连发':'已切换至半自动');
  previousWeapon=p.weapon;previousReload=p.reloadRemaining;
  if(!self||p.alive&&!lastSnapshotAlive||relocated){self={...createPlayerState(p),...p};lookYaw=p.yaw;lookPitch=p.pitch;slot=p.slot;camera.position.set(p.x,p.y+1.6,p.z);recoil=0;self.lastJumpId=jumpId;lastStep=p.stepDistance||0;resetScope();if(relocated){clearGameInput();shotPrediction.pending=[];}}
  else {
    const predicted=movementState(self);Object.assign(self,p,predicted);
    if(movementSupported&&p.alive)movementPrediction.reconcile(self,p);
    else{Object.assign(self,p);movementPrediction.reset(self);}
  }
  if(relocated||!lastSnapshotAlive){movementPrediction.reset(self);fixed=0;}
  if(p.health<previousHealth&&p.alive)hud.damage();previousHealth=p.health;lastSnapshotAlive=p.alive;
  const present=new Set(data.players.map(p=>p.id));for(const [id,actor]of actors){if(!present.has(id)){actor.dispose(scene);actors.delete(id);}}
  for(const other of data.players){
    if(other.id===myId)continue;
    const wanted=other.agentId||DEFAULT_AGENT_IDS[other.team];
    requestAgent(wanted);
    const visible=loadedPlayerAsset(wanted)?wanted:DEFAULT_AGENT_IDS[other.team],actor=actors.get(other.id);
    // Keep an existing death pose until respawn; a late skin download must not replay it.
    if(actor&&!other.alive&&actor.team===other.team)continue;
    if(!actor||actor.agentId!==visible||actor.team!==other.team){
      const replacement=new PlayerModel(other.team,scene,visible,{weaponId:other.weapon,skinId:other.skinId});
      replacement.group.position.set(other.x,other.y,other.z);
      replacement.group.rotation.y=other.yaw;
      actor?.dispose();actors.set(other.id,replacement);
    }
  }
  if(!p.inventory.some(id=>getWeapon(id).slot===slot))slot=p.slot;
  for(const e of data.events||[]){if(e.id&&handledEvents.has(e.id))continue;if(e.id){handledEvents.add(e.id);if(handledEvents.size>512)handledEvents.delete(handledEvents.values().next().value);}hud.event(e,data,myId);handleEvent(e);}
}

function handleEvent(e){
  mapResultCache?.breakables?.event(e,camera.position);
  chat.receive(e);
  matchPresentation.handleEvent(e,snapshot,connectionId);matchAudio.event(e,self,snapshot);
  if(e.type==='round_end'){toyProgress.recordRoundComplete();}
  if(e.type==='match_end'){const won=Boolean(self?.team&&e.winner&&self.team===e.winner);toyProgress.recordMatchComplete({won});clearGameInput();mouseFire=false;document.exitPointerLock?.();$('pause-menu').hidden=true;$('buy-menu').hidden=true;}
  if(e.type==='weapon_picked_up'&&e.playerId===myId){slot=self.slot;resetScope();hud.toast(`已拾取 ${getWeapon(e.weaponId).name}`);}
  utilityEffects.event(e,spectating?.id||myId);
  if(e.type==='bomb_exploded')utilityEffects.event({type:'explosion',origin:{x:e.x,y:e.y+.1,z:e.z}},myId);
  audio.utilityEvent(e,{x:camera.position.x,y:camera.position.y,z:camera.position.z,yaw:camera.rotation.y},myId);
  if(e.type==='decoy_pulse'&&e.origin){const d=camera.position.distanceTo(e.origin);audio.shot(e.weapon,d,0,{remote:true});}
  if(e.type==='kit_picked_up'&&e.playerId===myId)hud.toast('已拾取拆弹器 · 拆弹 5 秒');
  if(e.type==='grenade_thrown')actors.get(e.shooterId)?.throwGrenade(e.mode);
  if(e.type==='grenade_thrown'&&e.shooterId===(spectating?.id||myId))viewWeapon?.shoot({mode:e.mode});
  if(e.type==='grenade_thrown'&&e.shooterId===myId){slot=self?.inventory?.some(id=>getWeapon(id).slot===1)?1:self?.inventory?.some(id=>getWeapon(id).slot===2)?2:3;mouseFire=false;shotPrediction.triggered=false;pendingFirePress=false;pendingAltFirePress=false;resetScope();sendInput(currentInput());}
  if(e.type==='shot'){
    if(spectating&&e.shooterId===spectating.id)viewWeapon?.shoot({heavy:e.heavy,fireMode:e.fireMode});
    if(e.shooterId===myId)lastShotEvidence={weapon:e.weapon,burstIndex:e.burstIndex||0,shotId:e.shotId,fireMode:e.fireMode,heavy:!!e.heavy,backstab:!!e.backstab,zoomLevel:e.zoomLevel,accuracy:e.accuracy,rewindMs:e.rewindMs,aim:e.aim,origin:e.origin,end:e.end,hitId:e.hitId,at:performance.now()};
    if(e.weapon!=='knife'&&e.origin&&e.end){const own=e.shooterId===(spectating?.id||myId),muzzle=own?viewWeapon?.getMuzzleWorldPosition(new THREE.Vector3(),camera):null;for(const pellet of e.pellets?.length?e.pellets:[e])effects.shot(e.origin,pellet.end||e.end,own,{weapon:e.weapon,shooterId:e.shooterId,muzzle,hitWorld:pellet.hitWorld??e.hitWorld,segments:pellet.segments||e.segments||[]});}
    if(e.shooterId===myId&&e.weapon==='pistol'&&e.shotId&&lastGlockTrigger?.id===e.shotId){
      const burst=e.burstIndex===1;
      if(burst!==lastGlockTrigger.burst&&self?.weapon==='pistol'){
        const weapon=getWeapon('pistol'),cycle=burst?weapon.burstCycle:weapon.fireInterval;
        fireTimer=Math.max(0,cycle-(performance.now()-lastGlockTrigger.at)/1000);
      }
      lastGlockTrigger=null;
    }
    if(e.shooterId===myId&&e.burstIndex>1){
      audio.shot(e.weapon,0,0,{team:self?.team,burstIndex:e.burstIndex,shooterId:myId});
      if(self?.alive&&self.weapon===e.weapon)applyShotKick(getWeapon(e.weapon));
    }
    if(e.weapon==='knife'&&e.shooterId===myId&&e.hitWorld)audio.knife('wall');
    if(e.shooterId!==myId&&self&&e.origin){const listener=spectating?camera.position:self,listenerYaw=spectating?camera.rotation.y:lookYaw;const dx=e.origin.x-listener.x,dz=e.origin.z-listener.z;const distance=Math.hypot(dx,dz);const pan=(dx*Math.cos(listenerYaw)-dz*Math.sin(listenerYaw))/Math.max(1,distance);audio.shot(e.weapon,distance,pan,{remote:true,burstIndex:e.burstIndex,shooterId:e.shooterId,heavy:e.heavy,team:snapshot.players.find(p=>p.id===e.shooterId)?.team});}
  }
  if(e.type==='hit'&&e.shooterId===myId){audio.hit({headshot:e.headshot,armor:e.armor,weapon:e.weapon,heavy:e.heavy});}
  if(e.type==='kill'&&(e.killerId===myId||(connectionId&&e.killerControllerId===connectionId))){audio.kill({headshot:e.headshot});if(e.credited!==false)toyProgress.recordKill({weapon:e.weapon,headshot:Boolean(e.headshot)});}
  if(e.type==='buy'&&e.playerId===myId){audio.beep(440,.08,.08);}
}

function localShoot(input,dt){
  pendingFirePress=false;pendingAltFirePress=false;
  fireTimer=Math.max(0,fireTimer-dt);
  if(!self?.alive||self.objectiveLocked){cancelRevolverPrepare();return;}
  const w=getWeapon(self.weapon),melee=w.id==='knife',heavy=melee&&input.fire2,revolver=w.id==='revolver';
  if(w.slot>=4||self.bombAction){shotPrediction.triggered=false;return;}
  const now=performance.now();shotPrediction.expire(now,ping);
  const triggerReady=shotPrediction.triggerReady(input.fire||heavy||revolver&&input.fire2,w.automatic||melee);
  if(!triggerReady){cancelRevolverPrepare();return;}
  // Keep a held semi-automatic trigger until the switch/reload is actually ready.
  // Only a sent command may produce recoil, sound or an ammunition reservation.
  if(socket?.readyState!==WebSocket.OPEN||now-lastSnapshotAt>1500){
    cancelRevolverPrepare();
    if(now-lastShotWarning>4000){lastShotWarning=now;hud.toast('网络响应中断 · 正在等待服务器确认');}
    return;
  }
  if(self.slot!==slot||self.fireReadyRemaining>0||revolver&&input.reload||self.reloadRemaining>0&&!(w.reloadStyle==='shell'&&self.ammo>0)||!melee&&self.ammo-shotPrediction.pending.length<=0){cancelRevolverPrepare();return;}
  let fireMode='primary';
  if(revolver){
    // Preserve the discharge pose until the last preparation window of cooldown.
    if(!input.fire2&&revolverTrigger.startedAt===null&&fireTimer>REVOLVER_PRIMARY_FIRE_DELAY_MS/1000+1e-8)return;
    const startedAt=revolverTrigger.startedAt;
    fireMode=revolverTrigger.update(input,now);
    if(revolverTrigger.startedAt!==null&&startedAt===null){
      // Tell the authority when the trigger starts; a shot ID is sent only on discharge.
      sendInput(input);viewWeapon?.prepareRevolver(true,REVOLVER_PRIMARY_FIRE_DELAY_MS/1000);audio.prepareRevolver();
    }
    if(input.fire2){viewWeapon?.prepareRevolver(false);audio.cancelChannel('revolver-prepare');}
    if(!fireMode)return;
  }else cancelRevolverPrepare();
  if(fireTimer>1e-8)return;
  const nextShot=shotId+1;
  if(!sendInput({...input,shotId:nextShot,shotWeapon:w.id}))return;
  shotId=nextShot;shotPrediction.triggered=true;
  if(revolver)cancelRevolverPrepare();
  if(!melee)shotPrediction.reserve(shotId,now,w.id);
  if(w.reloadStyle==='shell'&&self.reloadRemaining>0){audio.cancelReload();self.reloadRemaining=0;}
  const burst=!!w.burstSize&&(pendingBurstMode?.enabled??!!self.burstMode);
  if(w.burstSize)lastGlockTrigger={id:shotId,at:now,burst};
  audio.cancelDraw();fireTimer=melee?knifeInterval(heavy):burst?w.burstCycle:weaponFireInterval(w,fireMode);lastShot=now;
  if(w.unzoomsAfterShot){resumeZoom=zoomLevel;zoomResumeAt=now+w.fireInterval*1000;zoomLevel=0;scoped=false;}
  audio.shot(w.id,0,0,{team:self.team,heavy,burstIndex:burst?1:0,shooterId:myId});
  applyShotKick(w,heavy,fireMode);
}

function applyShotKick(w,heavy=false,fireMode='primary'){
  viewWeapon?.shoot({heavy,fireMode});recoil=Math.min(.10,recoil+w.recoil*.55);lookPitch=Math.min(1.48,lookPitch+w.recoil*.35);
}

function setPauseMenuState(first=false){
  $('pause-menu').dataset.entry=first?'first':'paused';
  $('pause-title').textContent=first?'准备就绪':'对局菜单';
  $('pause-context').textContent=first
    ? `房间 ${room||'------'} · 点击下方按钮启用${touchControls?.enabled?'触屏控制':'鼠标控制'}`
    : `房间 ${room||'------'} · 对局仍在运行`;
  $('resume-button').firstChild.textContent=first?'进入战场 ':'继续游戏 ';
}
async function lockPointer(){
  if(!connected||contextLost||snapshot?.match?.status==='ended')return;
  canvas.focus({preventScroll:true});
  $('pause-menu').hidden=true;
  $('buy-menu').hidden=true;
  clearGameInput();
  if(touchControls?.enabled){
    mobileShell?.enter();
    const motionPermission=mobileAim.authorize();
    touchPlaying=true;
    setPauseMenuState(false);
    syncTouchSurface();
    await Promise.allSettled([audio.start(),motionPermission]);
    return;
  }
  // Request mouse capture within the click, before audio resumes asynchronously.
  void audio.start().catch(()=>{});
  try {
    await canvas.requestPointerLock({unadjustedMovement:true});
  } catch {
    try {
      await canvas.requestPointerLock();
    } catch {
      $('pause-menu').hidden=false;
      hud.toast('请点击进入战场以启用鼠标控制。');
      return;
    }
  }
  setPauseMenuState(false);
}
function showMenu(){void toyProgress.flushCloud();progressionUI.close();releaseRoomHands();shop.cancel();armory.close();skins.close();mapResultCache?.breakableCollision?.reset();mapResultCache?.breakables?.reset();chat.reset();chat.element.hidden=true;matchAudio.stop();bombView.clear();roomMenu.element.hidden=true;displayedHostBots=null;audio.stopAll();effects.clear();utilityEffects.clear();droppedWeapons.clear();hud.reset();matchView.reset();matchPresentation.reset();spectating=null;spectatorLook=null;shotPrediction.pending=[];mouseFire=false;shotPrediction.triggered=false;clearGameInput();resetScope();document.exitPointerLock?.();document.body.classList.remove('playing');$('menu').hidden=false;$('hud').hidden=true;$('pause-menu').hidden=true;$('buy-menu').hidden=true;$('scoreboard').hidden=true;for(const a of actors.values())a.dispose(scene);actors.clear();self=null;snapshot=null;if(document.visibilityState==='visible'&&audio.ctx?.state==='running')matchAudio.play('menu');}
function toggleBuy(){if(!connected)return;if(!self?.alive&&$('buy-menu').hidden){hud.toast('阵亡时无法购买，重生或下一回合后可打开商店。');return;}if($('buy-menu').hidden){$('buy-menu').hidden=false;$('pause-menu').hidden=true;mouseFire=false;resetScope();clearGameInput();shop.update({player:{...self,skins:skins.loadout,weaponLoadout:myId===connectionId?armory.loadout:null},mode,round:snapshot?.round,time:snapshot?.time});document.exitPointerLock();$('close-buy').focus();}else{$('buy-menu').hidden=true;lockPointer();}}

async function invite(){if(!room)return;if(connection.offline){hud.toast('当前是本机练习；与朋友对战请使用“在线联机”启动入口');return;}let url=new URL(location.href);url.searchParams.set('room',room);if(inviteBase){url=new URL(inviteBase);url.searchParams.set('room',room);}try{await navigator.clipboard.writeText(url.href);hud.toast('邀请链接已复制，发送给朋友即可加入');}catch{hud.toast(`房间 ${room} · ${url.href}`);}}
function syncPauseVisualUI(){
  const styleSelect=$('pause-visual-style');
  if(styleSelect&&styleSelect.value!==visualStyle)styleSelect.value=visualStyle;
  const usingOriginal=isHighQualityTextured();
  const liveTag=document.querySelector('#pause-menu .pause-live-tag');
  if(liveTag)liveTag.textContent=usingOriginal?'PBR 模式生效':'实时生效';
  const texMode=$('pause-texture-mode');
  if(texMode)texMode.textContent=usingOriginal?'CS2 原版贴图':'性能重制 PBR';
}
function setVisualStyle(value,{silent=false}={}){
  const prev=visualStyle;
  visualStyle=setStoredVisualStyle(value);
  applyVisualStyleToScene(scene,visualStyle);
  syncPauseVisualUI();
  settingsUI.videoRefresh?.();
  if(!silent&&loaded&&prev!==visualStyle){
    const preset=getVisualStylePreset(visualStyle);
    hud.toast(isHighQualityTextured()
      ? `视觉风格已保存 · ${preset.name}（将在性能重制 PBR 地图中生效）`
      : `视觉风格已实时切换 · ${preset.name}`);
  }
}
function setQuality(value){
  const target=value==='high'?'high':'low';
  if(connected||loaded||isPortalPerfMap){
    if(target!==quality){
      hud.toast('地图贴图源仅限在对局外切换，请退出战局返回大厅设置修改');
    }
    const csQual=settingsUI.element?.querySelector('#cs-quality');
    if(csQual&&csQual.value!==quality)csQual.value=quality;
    settingsUI.videoRefresh?.();
    syncPauseVisualUI();
    return;
  }
  quality=target;
  preferences.setItem('dust2.quality.v2',quality);
  const csQual=settingsUI.element?.querySelector('#cs-quality');
  if(csQual&&csQual.value!==quality)csQual.value=quality;
  syncPauseVisualUI();
  applyQuality();
}
function setBrightness(value){brightness=Math.max(60,Math.min(160,Number(value)||100));preferences.setItem('dust2.brightness',brightness);renderer.toneMappingExposure=1.03*brightness/100;}
function applyQuality(){
  renderer.toneMappingExposure=1.03*brightness/100;
  renderer.shadowMap.enabled=quality==='high'&&!privateMap&&!flatMapSelected()&&!mobileDevice();
  const hq=quality==='high'?1.0:0.0;
  scene.traverse(o=>{
    if(o.isLight&&o.shadow&&o.castShadow)o.shadow.needsUpdate=true;
    if(!o.isMesh)return;
    for(const m of [].concat(o.material||[])){
      m.userData.highQuality=quality==='high';
      if(m.userData.surfaceUniforms?.uHighQuality)m.userData.surfaceUniforms.uHighQuality.value=hq;
      if(Array.isArray(m.userData.surfaceUniformsList)){
        for(const u of m.userData.surfaceUniformsList)if(u?.uHighQuality)u.uHighQuality.value=hq;
      }
    }
  });
  applyVisualStyleToScene(scene,visualStyle);
  syncPauseVisualUI();
  resizeViewport();
}

function choosePrimary(id,explicit=true){
  primary=id;if(explicit)primaryExplicit=true;
  document.querySelectorAll('[data-primary]').forEach(el=>{const selected=el.dataset.primary===id;el.classList.toggle('selected',selected);el.setAttribute('aria-pressed',String(selected));});
}
function updateTeamLoadoutLabels(){
  for(const el of document.querySelectorAll('[data-team]')){
    const id=startingPistolForTeam(armory.loadout,el.dataset.team),skin=getSkin(skins.loadout[id]);
    const label=el.querySelector('small');if(label)label.textContent=`${getWeapon(id).name} · ${skin?.name||getWeapon(id).skin}`;
  }
}
function chooseTeam(team){
  updateTeamLoadoutLabels();
  $('team').value=team;$('auto-team').setAttribute('aria-pressed',String(team==='auto'));
  document.querySelectorAll('[data-team]').forEach(el=>{const selected=el.dataset.team===team;el.classList.toggle('selected',selected);el.setAttribute('aria-pressed',String(selected));});
  if(!primaryExplicit||team!=='auto'&&!canTeamUseWeapon(team,primary))choosePrimary(defaultPrimaryForTeam(team),false);
  document.querySelectorAll('[data-primary]').forEach(el=>{el.disabled=team!=='auto'&&!canTeamUseWeapon(team,el.dataset.primary);});
}
document.querySelectorAll('[data-team]').forEach(el=>el.addEventListener('click',()=>chooseTeam(el.dataset.team)));
document.querySelectorAll('[data-primary]').forEach(el=>el.addEventListener('click',()=>choosePrimary(el.dataset.primary)));
$('auto-team').addEventListener('click',()=>chooseTeam('auto'));chooseTeam($('team').value);
function updateModeLabels(){const defuse=$('mode').value==='defuse';$('loadout-mode').textContent=defuse?'爆破从手枪局开始，B 购买主武器':'团队死斗开局直接装备';if($('room-mode-note'))$('room-mode-note').textContent=defuse?'13 回合获胜 · 每 12 回合换边 · 12:12 进入加时，每 3 回合换边':'团队击杀累计至 100，比赛结束';if($('lobby-mode-label'))$('lobby-mode-label').textContent=defuse?'竞技爆破':'团队死斗';}
$('mode').addEventListener('change',updateModeLabels);updateModeLabels();
$('host-bots-apply')?.addEventListener('click',()=>{send({type:'setBots',bots:Number($('host-bots').value)});});
$('menu-play-tab')?.addEventListener('click',()=>$('start-button').focus());
const isPortalMatchRoute=Boolean(parseMatchRoute(location.href));
$('cancel-load').addEventListener('click',()=>{if(downloadAbort)downloadAbort.abort();if(socket&&!connected){intentionalLeave=true;socket.close(1000,'cancel');socket=null;}if(isPortalMatchRoute){location.assign(lobbyHref());return;}loading=false;$('start-button').disabled=false;$('join-button').disabled=false;$('loading-screen').hidden=true;});
$('back-load').addEventListener('click',()=>{if(isPortalMatchRoute){location.assign(lobbyHref());return;}$('loading-screen').hidden=true;});
$('retry-load').addEventListener('click',()=>start(pendingJoin));

for(const parent of [$('pause-menu').querySelector('.utility-row'),$('invite-button').parentElement]){const button=document.createElement('button');button.className='room-open';button.textContent='房间 / 阵营';button.onclick=()=>{clearGameInput();mouseFire=false;roomMenu.update(snapshot,connectionId);roomMenu.open();};parent.append(button);}
$('start-button').addEventListener('click',()=>start(false));$('join-button').addEventListener('click',()=>{if(!$('room-code').value.trim()){$('menu-status').textContent='请输入朋友发来的房间码。';return;}start(true);});
for(const id of ['menu-agents','game-agents']) if($(id))$(id).onclick=()=>openHomePanel('agents');
for(const id of ['menu-music','game-music']) if($(id))$(id).onclick=()=>openHomePanel('music');
for(const id of ['menu-progression','game-progression']) if($(id))$(id).onclick=()=>openHomePanel('progression');
$('menu-skins').onclick=()=>armory.open();$('game-loadout').onclick=()=>armory.open();$('game-skins').onclick=()=>skins.open();$('menu-offline').onclick=()=>offlineMenu.open();
$('game-settings').addEventListener('click',()=>settingsUI.open());$('menu-settings').addEventListener('click',()=>settingsUI.open());
$('resume-button').addEventListener('click',lockPointer);
$('invite-button').addEventListener('click',invite);$('pause-invite').addEventListener('click',invite);
$('leave-button').addEventListener('click',()=>{intentionalLeave=true;clearReconnect();activeResumeToken=null;saveStoredResume(privateMap?.mapId||'de_dust2',room,null,0);connected=false;socket?.close(1000,'leave');socket=null;if(isPortalMatchRoute){location.assign(lobbyHref());return;}showMenu();const q=new URL(location.href);q.searchParams.delete('room');history.replaceState(null,'',q);$('menu-status').textContent='已退出房间，可以开始新的对局。';});
$('credits-button').addEventListener('click',()=>$('credits').hidden=false);$('close-credits').addEventListener('click',()=>$('credits').hidden=true);
$('sensitivity').addEventListener('change',e=>{if(!applySensitivity(e.target.value)){e.target.value=sensitivity;return;}settingsUI.syncMouse();});
$('sensitivity-range')?.addEventListener('input',e=>{if(applySensitivity(e.target.value))settingsUI.syncMouse();});
$('volume').addEventListener('input',e=>{applyVolume(e.target.value);});
$('pause-visual-style')?.addEventListener('change',e=>setVisualStyle(e.target.value));
document.addEventListener('pointerlockchange',()=>{document.body.classList.toggle('mouse-captured',document.pointerLockElement===canvas);if(touchControls?.enabled){syncTouchSurface();return;}if(document.pointerLockElement!==canvas){clearGameInput();mouseFire=false;resetScope();if(connected&&$('buy-menu').hidden&&!chat.opened&&snapshot?.match?.status!=='ended')$('pause-menu').hidden=false;}else $('pause-menu').hidden=true;});
const pointerMenus=[progressionUI.element,roomMenu.element,agentsUI.element,$('menu'),$('pause-menu'),$('buy-menu'),settingsUI.element,skins.element,offlineMenu.element,$('touch-layout-editor')].filter(Boolean);
const pointerGuard=new MutationObserver(()=>{if(pointerMenus.some(menu=>!menu.hidden)){if(document.pointerLockElement===canvas)document.exitPointerLock();if(touchPlaying){touchPlaying=false;clearGameInput();}}syncTouchSurface();});
pointerMenus.forEach(menu=>pointerGuard.observe(menu,{attributes:true,attributeFilter:['hidden']}));
document.addEventListener('mousemove',e=>{if(document.pointerLockElement!==canvas||!self?.alive)return;const fov=zoomFov();lookYaw-=e.movementX*mouseRadiansPerCount(sensitivity,'yaw',fov,zoomSensitivity);const pitchDelta=e.movementY*mouseRadiansPerCount(sensitivity,'pitch',fov,zoomSensitivity);lookPitch=THREE.MathUtils.clamp(lookPitch+(invertY?pitchDelta:-pitchDelta),-1.48,1.48);});
document.addEventListener('contextmenu',e=>{if(document.pointerLockElement===canvas)e.preventDefault();});
function suspendInput(){touchPlaying=false;clearGameInput();if(connected&&self)sendInput({...currentInput(),cancelGrenade:true});fixed=0;networkAcc=0;lastTime=performance.now();}
window.addEventListener('blur',()=>{suspendInput();mouseFire=false;resetScope();document.exitPointerLock?.();document.body.classList.remove('mouse-captured');if(connected&&snapshot?.match?.status!=='ended')$('pause-menu').hidden=false;syncTouchSurface();});
function resizeViewport(){
 const width=Math.max(1,Math.round(globalThis.visualViewport?.width||innerWidth)),height=Math.max(1,Math.round(globalThis.visualViewport?.height||innerHeight));
 document.body.style.setProperty('--app-height',height+'px');
 viewport=viewportSize(width,height,{...video,mobile:mobileDevice()&&!privateMap});camera.aspect=gunCamera.aspect=viewport.aspect;camera.updateProjectionMatrix();gunCamera.updateProjectionMatrix();
 const useFlatBuffer = flatMapSelected() && !isHighQualityTextured();
 const effectiveFlatScale = quality === 'high' && flatRenderScale <= 1 ? 1.25 : flatRenderScale;
 const buffer = useFlatBuffer
   ? flatDrawingBuffer(viewport,{dpr:devicePixelRatio,mobile:mobileDevice(),scale:effectiveFlatScale,maxDimension:renderer.capabilities.maxTextureSize})
   : {width:viewport.width,height:viewport.height,ratio:renderPixelRatio({...viewport,dpr:devicePixelRatio,mobile:mobileDevice(),quality,clarity:mobileClarity})};
 renderer.setPixelRatio(buffer.ratio);
 renderer.setSize(buffer.width,buffer.height,false);
 const dimensions = $('cs-render-dimensions');
 if (dimensions) dimensions.textContent = renderer.domElement.width + ' × ' + renderer.domElement.height;
 canvas.style.inset='auto';canvas.style.left='50%';canvas.style.top='50%';canvas.style.width=viewport.displayWidth+'px';canvas.style.height=viewport.displayHeight+'px';
 crosshair.refreshLayout();
 for(const [key,value]of Object.entries({'--game-width':viewport.width+'px','--game-height':viewport.height+'px','--game-scale-x':viewport.displayWidth/viewport.width,'--game-scale-y':viewport.displayHeight/viewport.height}))document.body.style.setProperty(key,String(value));
}
window.addEventListener('resize',()=>{resizeViewport();if(touchControls?.enabled){clearGameInput();touchControls.clear();}});globalThis.visualViewport?.addEventListener('resize',resizeViewport);resizeViewport();
function syncTouchSurface(){touchControls?.setActive(touchPlaying&&gameSurfaceActive()&&snapshot?.match?.status!=='ended');}
document.addEventListener('visibilitychange',()=>{if(document.hidden){suspendInput();touchControls?.clear();if(connected)$('pause-menu').hidden=false;syncTouchSurface();}});
export function joinDirectoryRoom({code,mode}, directoryNavigation=false){
  $('room-code').value=code;
  $('mode').value=mode;
  chooseTeam('auto');
  updateModeLabels();
  return start(true,directoryNavigation);
}
export function quickStartRoom(options='defuse'){
  const opts=typeof options==='string'?{mode:options}:(options||{});
  if(opts.mode==='deathmatch'||opts.mode==='defuse')$('mode').value=opts.mode;
  if(opts.bots!==undefined&&opts.bots!==null&&/^[0-9]$/.test(String(opts.bots)))$('bots').value=String(opts.bots);
  chooseTeam(['auto','T','CT'].includes(opts.team)?opts.team:'auto');
  updateModeLabels();
  return start(false,true);
}
if(!privateMap?.flatOnly&&privateMap?.graphicsMode!=='quality'){
  mountLobby({connection,mapId:privateMap?.mapId||'de_dust2',onJoin:()=>{$('team').value='auto';$('join-button').click();}});
}

export function prepareHomeLoadout({team,primary:weapon}){choosePrimary(weapon);chooseTeam(team);updateModeLabels();}
export function startFromHome(join=false){return start(join);}
export function unlockAudioFromHome(){audio.resume().catch(()=>{});}
export function openHomePanel(panel){
  if(panel==='music'){
    settingsUI.open('audio');
  }else if(panel==='agents')agentsUI.open(self?.team||$('team').value);
  else if(panel==='settings')settingsUI.open();
  else if(panel==='skins')armory.open();
  else if(panel==='progression')progressionUI.open();
  else if(panel==='offline')offlineMenu.open();
}

const framePacer=new FramePacer();let lastRenderTime=performance.now(),fpsFrames=0,fpsSeconds=0;
function frame(now){
  requestAnimationFrame(frame);const frameSeconds=(now-lastTime)/1000,dt=Math.min(.05,Math.max(0,frameSeconds));lastTime=now;
  syncTouchSurface();
  if(!loaded||!connected||!self||contextLost||document.hidden)return;
  const cpuStart=performance.now(),renderPlayers=remotePlayers.sample(now);
  fixed+=dt;networkAcc+=dt;hudAcc+=dt;pingAcc+=dt;
  recoil=Math.max(0,recoil-dt*.15);
  const mobileLook=mobileAim.update({now,dt,enabled:controlsEnabled(),touch:touchControls.enabled,self,players:renderPlayers,weapon:getWeapon(self.weapon),zoom:zoomLevel,fov:zoomFov(),yaw:lookYaw,pitch:lookPitch,origin:eyePosition(self),smokes:snapshot.smokes||[],blind:utilityEffects.flashRemaining>0,snapshotAge:now-lastSnapshotAt,firing:mouseFire||pendingFirePress,recoil});lookYaw=mobileLook.yaw;lookPitch=mobileLook.pitch;
  const input=currentInput();
  while(fixed>=1/60){if(self.alive){if(movementSupported)movementPrediction.step(self,input,['live','ended'].includes(snapshot.round.phase));else if(['live','ended'].includes(snapshot.round.phase))stepPlayer(self,input,1/60);}localShoot(input,1/60);fixed-=1/60;}
  if(networkAcc>=1/30){networkAcc%=1/30;sendInput(input);}
  if(pingAcc>=2){pingAcc=0;const ackPart=lastAckedSid>0?{ackSid:lastAckedSid}:{};if(lastAckedSid>0){lastSentAckSid=lastAckedSid;lastAckSentAt=performance.now();}sendUnreliable({type:'ping',time:performance.now(),...ackPart,...(ping>0?{rtt:Math.round(ping)}:{}),...(fps>0?{fps:Math.round(fps)}:{}),tr:socket?.transportMode==='UDP'?'u':'w'});}
  if(self.grounded&&controlsEnabled()&&Math.hypot(self.vx,self.vz)>.8&&(self.stepDistance||0)-lastStep>(self.crouch?2.6:1.8)){audio.step();lastStep=self.stepDistance;}
  // Simulation, shot prediction and 30 Hz input above always run, even on skipped render frames.
  if(!framePacer.due(now,frameLimit))return;
  const renderSeconds=(now-lastRenderTime)/1000,renderDt=Math.min(.1,Math.max(0,renderSeconds));lastRenderTime=now;
  if(renderSeconds>1){fpsFrames=0;fpsSeconds=0;}else{fpsFrames++;fpsSeconds+=renderSeconds;if(fpsSeconds>=.5){fps=fpsFrames/fpsSeconds;fpsFrames=0;fpsSeconds=0;}}
  const renderedPosition=movementSupported?movementPrediction.render(self,fixed*60,renderDt):self;
  const eye=self.alive?eyePosition({...self,...renderedPosition}):{x:self.x,y:self.y+.75,z:self.z};
  camera.position.set(eye.x,eye.y,eye.z);
  camera.rotation.set(aimPitch(lookPitch,recoil),lookYaw,0,'YXZ');if(!self.alive)resetScope();
  if(!self.alive){const death=matchView.deathCamera(now);if(death){camera.position.set(death.x,death.y,death.z);camera.rotation.set(death.pitch,death.yaw,death.roll,'YXZ');}}
  spectating=matchView.spectating(self,snapshot,now);
  if(spectating)spectating=renderPlayers.find(p=>p.id===spectating.id)||spectating;
  if(spectating){const actor=actors.get(spectating.id);const position=actor?.group.position||spectating;camera.position.set(position.x,position.y+(spectating.crouch?.95:1.62),position.z);if(spectatorLook?.id!==spectating.id)spectatorLook={id:spectating.id,yaw:spectating.yaw,pitch:spectating.pitch};const blend=1-Math.exp(-12*renderDt),delta=Math.atan2(Math.sin(spectating.yaw-spectatorLook.yaw),Math.cos(spectating.yaw-spectatorLook.yaw));spectatorLook.yaw+=delta*blend;spectatorLook.pitch=THREE.MathUtils.lerp(spectatorLook.pitch,spectating.pitch,blend);camera.rotation.set(spectatorLook.pitch,spectatorLook.yaw,0,'YXZ');}else spectatorLook=null;
  const bombCamera=matchView.bombCamera(self,snapshot,now,raycastWorld);
  if(bombCamera){camera.position.set(bombCamera.x,bombCamera.y,bombCamera.z);camera.rotation.set(bombCamera.pitch,bombCamera.yaw,0,'YXZ');}
  if(resumeZoom&&now>=zoomResumeAt&&controlsEnabled()&&getWeapon(self.weapon).unzoomsAfterShot&&self.reloadRemaining<=0&&self.ammo>0){zoomLevel=resumeZoom;scoped=true;resumeZoom=0;}
  const viewed=spectating||self,renderZoom=spectating?(spectating.zoomLevel||0):zoomLevel,renderFov=getWeapon(viewed.weapon).zoomFovs?.[renderZoom]||CS2_BASE_FOV;
  hud.radarFrame(snapshot,self,{id:viewed.id,x:camera.position.x,z:camera.position.z,
    y:bombCamera?snapshot.bomb.y:viewed.y,yaw:camera.rotation.y},now,!!bombCamera,radarRotate);
  const targetFov=cs2FovToVertical(renderFov);if(camera.fov!==targetFov){camera.fov=Math.abs(camera.fov-targetFov)<.1?targetFov:THREE.MathUtils.lerp(camera.fov,targetFov,Math.min(1,renderDt/.05));camera.updateProjectionMatrix();}
  const renderWeapon=getWeapon(viewed.weapon),fullScope=renderZoom>0&&renderWeapon.zoomStyle==='scope',optic=renderZoom>0&&renderWeapon.zoomStyle==='optic';
  const accuracy=accuracyForShot(renderWeapon,viewed,renderZoom).total;
  scopeOverlay.update({width:viewport.width,height:viewport.height,weapon:renderWeapon,zoomLevel:renderZoom,accuracy,verticalFov:camera.fov});
  crosshair.update({scoped:fullScope||optic,alive:viewed.alive,zoomStyle:renderWeapon.zoomStyle,bombCamera:!!bombCamera,
    spread:accuracy*viewport.height/(2*Math.tan(camera.fov*Math.PI/360))});

  const actorStart=performance.now();camera.updateMatrixWorld();visibilityFrustum.setFromProjectionMatrix(visibilityMatrix.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse));
  for(const p of renderPlayers){if(p.id===myId)continue;const actor=actors.get(p.id);if(!actor)continue;actorBounds.center.set(p.x,p.y+.9,p.z);const visible=visibilityFrustum.intersectsSphere(actorBounds);actor.group.visible=visible;const distance=camera.position.distanceTo(actorBounds.center);actor.update(p,renderDt,{exactPosition:true,animationRate:visible?(distance<25?60:30):12});}
  const actorMs=performance.now()-actorStart;
  viewWeapon?.update(renderDt,viewed,fullScope,{optic});if(!fullScope)weaponLighting.update(scene,camera);effects.update(renderDt);mapResultCache?.breakables?.update(renderDt);utilityEffects.update(renderDt,camera,self.alive||!!spectating);audio.utilityAmbient(snapshot,camera.position);bombView.update(snapshot.bomb,now);matchAudio.update(snapshot,camera.position,now);
  if(hudAcc>.075){hudAcc=0;touchControls?.update({alive:self.alive,burstWeapon:slot===self.slot&&!!getWeapon(self.weapon).burstSize,moving:movementControlsEnabled(),combat:controlsEnabled(),equipment:equipmentControlsEnabled(),canTakeBot:!!takeoverTarget(),spectator:!self.alive,canCycle:matchView.candidates(self,snapshot).length>0,slot,weapon:self.weapon,hasBomb:self.hasBomb&&snapshot.round?.phase==='live',planted:snapshot.round?.phase==='live'&&snapshot.bomb?.state==='planted',slots:[...new Set((self.inventory||[]).map(id=>getWeapon(id).slot))]});hud.update(snapshot,self,{ping,transport:socket?.transportMode,fps:Math.round(fps),spectating,equippedSkins:myId===connectionId?skins.loadout:null,touch:!!touchControls?.enabled,interactKey:touchControls?.enabled?'点击右侧按钮':formatBinding(controls.getBindings().interact[0]),canTakeBot:!!takeoverTarget(),scoreboardKey:formatBinding(controls.getBindings().scoreboard[0]),menuKey:formatBinding(controls.getBindings().menu[0]),nextSpectatorKey:touchControls?.enabled?'右侧「下一位」':formatBinding(controls.getBindings().fire[0]),previousSpectatorKey:touchControls?.enabled?'「上一位」':formatBinding(controls.getBindings().altFire[0])});$('weapon-skin').textContent=getWeapon(self.weapon).slot>=4?'原厂装备':getSkin(self.skinId||STARTER_SKINS[self.weapon])?.name||'原厂涂装';if(!$('buy-menu').hidden)shop.update({player:{...self,skins:skins.loadout,weaponLoadout:myId===connectionId?armory.loadout:null},mode,round:snapshot.round,time:snapshot.time,requests:snapshot.weaponRequests});}
  droppedWeapons.update(self,camera,equipmentControlsEnabled(),formatBinding(controls.getBindings().interact[0]));
  const observedActor=spectating&&actors.get(spectating.id);if(observedActor)observedActor.group.visible=false;
  const renderStart=performance.now();renderer.info.reset();renderer.autoClear=true;renderer.render(scene,camera);
  if(observedActor)observedActor.group.visible=true;
  if((self.alive||spectating)&&!fullScope){renderer.autoClear=false;renderer.clearDepth();renderer.render(gunScene,gunCamera);renderer.autoClear=true;}
  releaseRoomHands();
  frameSamples.push({frame:renderSeconds*1000,cpu:performance.now()-cpuStart,actors:actorMs,render:performance.now()-renderStart});if(frameSamples.length>300)frameSamples.shift();
}
requestAnimationFrame(frame);
function resourceMetrics(){return {clientBuild:CLIENT_BUILD,motion:mobileAim.diagnostics(),graphics:{webgl:renderer.getContext().getParameter(renderer.getContext().VERSION),maxTextureSize:renderer.capabilities.maxTextureSize,maxTextures:renderer.capabilities.maxTextures},frameLimit,shooting:shotPrediction.status(),snapshotAgeMs:Math.round(performance.now()-lastSnapshotAt),renderWidth:canvas.width,renderHeight:canvas.height,pixelRatio:renderer.getPixelRatio(),antialias:renderer.getContext().getContextAttributes()?.antialias,clarity:mobileClarity,fps:Math.round(fps),ping,transport:socket?.transportMode||null,connected,contextLost,geometries:renderer.info.memory.geometries,textures:renderer.info.memory.textures,programs:renderer.info.programs?.length||0,actors:actors.size,animatedAgents:[...actors.values()].filter(actor=>actor.nativeAgent&&actor.mixer).length,effects:effects.items.length,audioVoices:audio.voices.size,audioDecodedMiB:Math.round((audio.decodedBytes||0)/1048576),viewWeapons:viewWeapon?.cache.size||0,heapMiB:performance.memory?Math.round(performance.memory.usedJSHeapSize/1048576):null,timing:frameStats()};}
setInterval(()=>{if(loaded)diagnostics.sample(resourceMetrics());},10000);
window.addEventListener('error',event=>diagnostics.event('javascript-error',{message:String(event.message).slice(0,300)}));
window.addEventListener('unhandledrejection',event=>diagnostics.event('unhandled-rejection',{message:String(event.reason?.message||event.reason).slice(0,300)}));
window.addEventListener('pagehide',event=>diagnostics.event('page-hide',{persisted:event.persisted}));
for(const parent of [$('pause-menu').querySelector('.pause-actions'),$('menu').querySelector('footer')||$('menu').querySelector('.utility-row')||$('menu').querySelector('main')]){const button=document.createElement('button');button.textContent='导出运行诊断';button.className='diagnostics-button';button.onclick=()=>diagnostics.download();parent.append(button);}
const recovery=document.createElement('div');recovery.id='graphics-recovery';recovery.className='overlay';recovery.hidden=true;recovery.innerHTML='<section class="pause-card"><div class="eyebrow">DUST II / GRAPHICS</div><h2>正在恢复游戏画面</h2><p>浏览器中断了 3D 渲染，正在等待显卡恢复。若长时间没有恢复，可重新载入；已缓存的资源会继续复用。</p><button class="primary-button" id="reload-graphics">重新载入游戏</button><button id="graphics-report">导出运行诊断</button></section>';document.body.append(recovery);
$('reload-graphics').onclick=()=>location.reload();$('graphics-report').onclick=()=>diagnostics.download();
canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();contextLost=true;diagnostics.event('webgl-context-lost',resourceMetrics());clearGameInput();mouseFire=false;resetScope();document.exitPointerLock?.();recovery.hidden=false;});
canvas.addEventListener('webglcontextrestored',()=>{try{rebuildWeaponEnvironment();applyQuality();contextLost=false;diagnostics.event('webgl-context-restored');recovery.hidden=true;if(connected)$('pause-menu').hidden=false;}catch(error){diagnostics.event('graphics-recovery-failed',{message:String(error.message).slice(0,300)});}});
window.__dust2={getDiagnostics:()=>diagnostics.report(),getStatus:()=>({mobileAim:mobileAim.diagnostics(),mobileShell:mobileShell?.status(),touch:touchControls?{enabled:touchControls.enabled,active:touchControls.active,axes:{...touchControls.axes},pointers:touchControls.input.pointers.size,settings:touchControls.settings,throwMode:touchControls.throwMode}:null,inputState:{fire:controls.down('fire'),altFire:controls.down('altFire'),crouch:controls.down('crouch'),interact:controls.down('interact')},audio:{lastUtility:audio.lastUtility,drawCount:audio.drawCount||0,lastDraw:audio.lastDraw,heavySwingCount:audio.heavySwingCount||0,lastKnife:audio.lastKnife},viewModel:{id:viewWeapon?.id,skinId:viewWeapon?.skinId,agentId:viewWeapon?.agentId,waiting:viewWeapon?.waiting||false,visible:viewWeapon?.group.visible||false,action:viewWeapon?.active?.actionName,actionTime:viewWeapon?.active?.current?.time,actionDuration:viewWeapon?.active?.current?.getClip().duration},music:matchAudio.status(),loaded,connected,contextLost,spectatingId:spectating?.id||null,resources:resourceMetrics(),room,mode,myId,connectionId,fps:Math.round(fps),ping,transport:socket?.transportMode||null,player:self?{...self}:null,players:snapshot?.players||[],round:snapshot?.round,match:snapshot?.match,hostId:snapshot?.hostId,desiredBots:snapshot?.desiredBots,botDifficulty:snapshot?.botDifficulty,seats:snapshot?.seats,droppedWeapons:snapshot?.droppedWeapons||[],bomb:snapshot?.bomb,mapBreakables:mapResultCache?.breakables?.status()||null,drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles,mapVersion:MAP.version,mapRenderStats:mapResultCache?.group?.userData.renderStats,sky:scene.userData.sky,zoomLevel,zoomFov:zoomFov(),cameraFov:camera.fov,cameraPosition:{x:camera.position.x,y:camera.position.y,z:camera.position.z},cameraAim:{yaw:camera.rotation.y,pitch:camera.rotation.x},lastShot:lastShotEvidence,shooting:{...shotPrediction.status(),lastSentInputSeq,shotId,snapshotAgeMs:Math.round(performance.now()-lastSnapshotAt)},renderPlayers:remotePlayers.sample(performance.now()),viewTime:remotePlayers.viewTime,movement:movementPrediction.status(),settings:{sensitivity,zoomSensitivity,invertY,crosshair:crosshairSettings,quality,brightness,mobileClarity,flatRenderScale,radarRotate,botDifficulty:preferredBotDifficulty,...video},bindings:controls.getBindings(),jumpId,reloadId,utilityId,agentLoadout:{...agentsUI.loadout},grenades:snapshot?.grenades||[],smokes:snapshot?.smokes||[],fires:snapshot?.fires||[],decoys:snapshot?.decoys||[],defuseKits:snapshot?.defuseKits||[]})};
