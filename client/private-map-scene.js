import {flattenMapDocument} from './flat-map-materials.js';
import {applyFlatMaterials} from './flat-map-renderer.js';
import {createFlatSiteMarkings,replaceOriginalFloorPaint} from './flat-site-markings.js';
import {loadFlatSurfaceDetail,getMapAtmosphere} from './flat-surface-detail.js';
import {prepareFlatSky} from './flat-sky.js';
import {decodeCompactMapMesh,decodePackedPhysics} from './compact-map-codec.js';
import {gameGLTFLoader} from './gltf-loader.js';
import {MeshoptDecoder} from 'three/addons/libs/meshopt_decoder.module.js';
import {repairMapOverlays} from './map-overlays.js';
import {mobileDevice} from './device-profile.js';
import * as THREE from 'three';
import {privateRenderManifest,privateRenderDependencies,deduplicatePrivateImages,readPrivateResource,PrivateMapProgress,privateGLTFLoader} from './private-map-loader.js';
import {PrivateMapTransport} from './private-map-transport.js';
import {useDownloadedAssets} from './loading.js';
import {MAP} from '../shared/map-data.js';
import {decodePrivateMapCollision} from '../shared/private-map-collision.js';
import {privateMapMemoryReason} from './private-game-config.js';
import {PrivateMapBreakables} from './private-map-breakables.js';
import {PrivateMapBreakables as BreakableCollisionState} from '../shared/private-map-breakables.js';
import {privateEntities,qualityEntityRenderMatches} from '../shared/private-map-entities.js';
import {PRIVATE_MOVEMENT_MODEL} from '../shared/ladder-movement.js';
import {privateMapFetcher} from './private-map-download.js';
import {assetDownloadURL} from './download-origin.js';
import {omitInactiveQualityMeshes} from './quality-map-layout.js';
import {sha256Hex} from '../shared/sha256.js';
import {applyVisualStyleToScene,getStoredVisualStyle} from './arena-look-presets.js';

function hashBytes(bytes){
 return sha256Hex(bytes);
}

function buildAtmosphereLights(mapId){
 const atm=getMapAtmosphere(mapId);
 const clampColor=rgb=>new THREE.Color(Math.min(1,rgb[0]*0.82),Math.min(1,rgb[1]*0.82),Math.min(1,rgb[2]*0.82));
 const hemisphere=new THREE.HemisphereLight(clampColor(atm.sky),clampColor(atm.bounce),0.82);
 const sun=new THREE.DirectionalLight(clampColor(atm.sun),1.38);
 const dir=new THREE.Vector3(...(atm.sunDir||[-0.48,0.78,0.40])).normalize();
 sun.position.copy(dir).multiplyScalar(110);
 sun.castShadow=false;
 return [hemisphere,sun];
}

function disposeScene(group){
 const textures=new Set(),materials=new Set(),geometries=new Set();
 group?.traverse(o=>{if(o.geometry)geometries.add(o.geometry);for(const m of [].concat(o.material||[])){materials.add(m);for(const value of Object.values(m))if(value?.isTexture)textures.add(value);}});
 textures.forEach(t=>{t.dispose();t.image?.close?.();});materials.forEach(m=>m.dispose());geometries.forEach(g=>g.dispose());
}

async function buildTexturedDust2Package(config,{onProgress=()=>{},signal}){
 const manager=new THREE.LoadingManager();
 useDownloadedAssets(manager);
 manager.onProgress=(_url,loaded,total)=>{
  if(total>3)onProgress(`载入 CS2 原版贴图 ${Math.min(loaded,total)} / ${total}…`,{phase:'map-download',bytes:loaded*150000,total:total*150000,complete:loaded,count:total,decoded:loaded,textureCount:total,rate:0});
 };
 onProgress('正在载入 CS2 原版贴图场景…',{phase:'map-manifest'});
 const loader=gameGLTFLoader(manager,{signal}).setMeshoptDecoder(MeshoptDecoder);
 const rawUrl=mobileDevice()?config.texturedRender.mobileUrl:config.texturedRender.desktopUrl;
 const logicalUrl=new URL(rawUrl.replace(/^\/perf\//,''),document.baseURI).href;
 const mapURL=assetDownloadURL(logicalUrl,{pageURL:document.baseURI}).href;
 const gltf=await loader.loadAsync(mapURL);
 signal?.throwIfAborted();
 onProgress('对齐原版材质与光照…',{phase:'gpu-compile',count:1,complete:0});
 const group=new THREE.Group();
 group.name=MAP.name+' · CS2 original textured render';
 group.rotation.y=Math.PI/2;
 group.add(gltf.scene);
 group.updateMatrixWorld(true);
 const overlayRepair=repairMapOverlays(group);
 const originalLights=[];
 const textures=new Set(),materials=new Set();
 let meshCount=0,triangles=0;
 group.traverse(object=>{
  if(object.isLight){originalLights.push(object);return;}
  if(!object.isMesh)return;
  meshCount++;
  triangles+=(object.geometry.index?.count||object.geometry.attributes.position.count)/3;
  object.castShadow=false;
  object.receiveShadow=false;
  object.frustumCulled=true;
  for(const material of Array.isArray(object.material)?object.material:[object.material]){
   const shaderFlags=material.userData?.vmat?.IntParams||{};
   const shaderName=material.userData?.vmat?.ShaderName||'';
   const sourceName=material.userData?.vmat?.Name||material.name||'';
   const isOverlay=Boolean(object.userData.overlayAligned||shaderFlags.F_OVERLAY||shaderName==='csgo_static_overlay.vfx'||material.transparent||/overlay|decal|graffiti|poster|signage/i.test(sourceName));
   if(isOverlay&&(material.transparent||shaderFlags.F_OVERLAY||shaderName==='csgo_static_overlay.vfx'))object.renderOrder=Math.max(object.renderOrder,2);
   if(materials.has(material))continue;
   materials.add(material);
   if(sourceName.startsWith('materials/tools/')||shaderFlags.F_DEPTH_FEATHER)material.visible=false;
   if(shaderFlags.F_VERTEX_ANIMATION||['csgo_effects.vfx','csgo_foliage.vfx'].includes(shaderName))material.vertexColors=false;
   for(const value of Object.values(material))if(value?.isTexture)textures.add(value);
   if(isOverlay){
    material.polygonOffset=true;material.polygonOffsetFactor=-2;material.polygonOffsetUnits=-4;
    if(material.transparent||shaderFlags.F_OVERLAY||shaderName==='csgo_static_overlay.vfx')material.depthWrite=false;
   }
  }
 });
 for(const texture of textures)texture.anisotropy=4;
 const sunDirection=new THREE.Vector3(-.43,-.84,-.33);
 const originalSun=originalLights.find(l=>l.isDirectionalLight);
 if(originalSun){
  const origin=new THREE.Vector3(),target=new THREE.Vector3();
  originalSun.getWorldPosition(origin);originalSun.target.getWorldPosition(target);
  if(target.distanceToSquared(origin)>1e-8)sunDirection.subVectors(target,origin).normalize();
 }
 for(const light of originalLights)light.removeFromParent();
 group.traverse(object=>{object.matrixAutoUpdate=false;object.matrixWorldAutoUpdate=false;});
 const hemisphere=new THREE.HemisphereLight(0xd5e9ff,0x99805f,2.15);
 hemisphere.name='dust2-web-sky';
 const sun=new THREE.DirectionalLight(0xfff0d7,3.3);
 sun.name='dust2-web-sun';
 const center=new THREE.Vector3(-5,0,-25);
 sun.target.position.copy(center);
 sun.position.copy(center).addScaledVector(sunDirection,-110);
 sun.castShadow=false;
 group.userData.renderStats={meshCount,triangles,materials:materials.size,textures:textures.size,originalCS2Materials:true,style:'original',overlayRepair};
 return {group,lights:[hemisphere,sun],sunTarget:sun.target,fog:new THREE.Fog(0xc9d8de,140,300),finishAtlas:null,highQualityTextured:true};
}

async function buildStandardCompactPackage(config,{onProgress=()=>{},signal}){
 const fetcher=privateMapFetcher(config);
 const manager=new THREE.LoadingManager();useDownloadedAssets(manager);
 const progress=new PrivateMapProgress((label,state)=>onProgress(label,state));
 progress.plan('map.mgp',config.compactRender.bytes,'file');
 progress.begin('map.mgp');
 const raw=await readPrivateResource(new URL(config.compactRender.url,location.href),{signal,bytes:config.compactRender.bytes,onBytes:(loaded,total)=>progress.bytes('map.mgp',loaded,total),maxBytes:64*1024*1024,fetcher});
 progress.done('map.mgp');
 signal?.throwIfAborted();
 const decoded=decodeCompactMapMesh(raw);
 const loadedRoot=decoded.scene;
 const group=new THREE.Group();group.name=MAP.name+' · standard compact render';group.rotation.y=Math.PI/2;group.add(loadedRoot);group.updateMatrixWorld(true);
 const textures=new Set(),materials=new Set();let meshCount=0,triangles=0;
 group.traverse(o=>{
  if(o.isLight){o.visible=false;return;}
  if(!o.isMesh)return;
  meshCount++;triangles+=(o.geometry.index?.count||o.geometry.attributes.position.count)/3;
  o.frustumCulled=true;o.castShadow=false;o.receiveShadow=true;
  for(const material of [].concat(o.material||[]))materials.add(material);
 });
 const finishAtlas=decoded.extras?.surfaceMaterialVersion===1?await loadFlatSurfaceDetail(config.id):null;
 signal?.throwIfAborted();
 if(finishAtlas)textures.add(finishAtlas);
 applyFlatMaterials(group,finishAtlas,config.id);
 applyVisualStyleToScene(group,getStoredVisualStyle());
 const markings=await createFlatSiteMarkings(MAP,manager);
 if(markings){
  textures.add(markings.material.map);
  loadedRoot.add(markings);
  markings.updateWorldMatrix(true,false);
 }
 for(const texture of textures)texture.anisotropy=4;
 group.traverse(o=>{o.matrixAutoUpdate=false;o.matrixWorldAutoUpdate=false;});
 const lights=buildAtmosphereLights(config.id);
 group.userData.renderStats={meshCount,triangles,materials:materials.size,textures:textures.size,originalCS2Materials:false,style:'flat',lightingParityValidated:false};
 return {group,lights,sunTarget:null,fog:null,finishAtlas,highQualityTextured:false};
}

/** Hot-swap Standard compact mesh <-> CS2 Full-Textured mesh in-place without disconnecting. */
export async function swapPrivateMapRender(scene,existingResult,{highQuality=false,onProgress=()=>{},signal}={}){
 const config=globalThis.__DUST2_PRIVATE_MAP__;
 if(!config||!config.texturedRender)return existingResult;
 const wantTextured=Boolean(highQuality);
 if(Boolean(existingResult?.highQualityTextured)===wantTextured)return existingResult;
 const next=wantTextured
  ? await buildTexturedDust2Package(config,{onProgress,signal})
  : await buildStandardCompactPackage(config,{onProgress,signal});
 signal?.throwIfAborted();
 if(existingResult.group){scene.remove(existingResult.group);disposeScene(existingResult.group);}
 for(const light of existingResult.lights||[])scene.remove(light);
 if(existingResult.sunTarget)scene.remove(existingResult.sunTarget);
 if(existingResult.finishAtlas?.userData?.mapTiles)existingResult.finishAtlas.dispose();
 scene.add(next.group,...next.lights);
 if(next.sunTarget)scene.add(next.sunTarget);
 scene.fog=next.fog;
 existingResult.group=next.group;
 existingResult.lights=next.lights;
 existingResult.sunTarget=next.sunTarget;
 existingResult.finishAtlas=next.finishAtlas;
 existingResult.highQualityTextured=next.highQualityTextured;
 return existingResult;
}

/** The private route keeps original scene geometry/UVs/textures and uses the
 * exact same hash-bound player, bullet and grenade channels as its server. */
export async function createPrivateMapScene(scene,{onProgress=()=>{},signal,flat=false,highQuality=false}={}){
 const config=globalThis.__DUST2_PRIVATE_MAP__;if(!config||!MAP.private)throw Error('私有地图尚未初始化');
 const useTexturedHigh=Boolean(highQuality&&config.texturedRender);
 flat = useTexturedHigh ? false : (flat || config.flatOnly === true);
 const fetcher=privateMapFetcher(config);
 const manager=new THREE.LoadingManager();useDownloadedAssets(manager);
 const parentSignal=signal,controller=new AbortController();signal=controller.signal;
 const abort=()=>{controller.abort(parentSignal.reason);manager.abort();};parentSignal?.addEventListener('abort',abort,{once:true});if(parentSignal?.aborted)abort();
 const check=()=>signal?.throwIfAborted();
 let transport=null;
 const progress=new PrivateMapProgress((label,state)=>onProgress(label,{...state,cacheBytes:transport?.stats.cacheBytes||0}));
 let loadedRoot=null,sky=null,breakables=null,loader=null,finishAtlas=null,committed=false,firstFailure=null;
 const stopFailedJob=error=>{firstFailure||=error;controller.abort(firstFailure);manager.abort();return firstFailure;};
 const failTogether=promise=>promise.catch(error=>{throw stopFailedJob(error);});
 try{
  check();
  if(!config.flatOnly&&config.mapDownloadBaseURL&&typeof DecompressionStream!=='function')throw Error('当前浏览器不支持地图分块解压，请升级 Chrome 或 Edge；安卓请更新 Android System WebView 后重试');
  const useCompactMesh = Boolean(!useTexturedHigh && config.flatOnly && config.compactRender?.url);
  const useCompactPhysics = Boolean(config.compactPhysics?.url);
  let json = null, gltfBytes = null, gltfFile = null, files = null, root = null, duplicateImages = 0, inactiveLayoutMeshes = 0;
  let visualDefinitions = config.breakables || [];
  let initialHidden = config.initialHiddenNodeIndices || [];

  const fetchFile=async(url,binary=false)=>{
    if(url===config.physicsUrl&&useCompactPhysics){
      const key='physics.vidx';
      progress.plan(key,config.compactPhysics.bytes);progress.begin(key);
      const onBytes=(loaded,total)=>progress.bytes(key,loaded,total);
      const packed=await readPrivateResource(new URL(config.compactPhysics.url,location.href),{signal,bytes:config.compactPhysics.bytes,onBytes,maxBytes:64*1024*1024,fetcher});
      progress.done(key);
      return decodePackedPhysics(packed);
    }
    const key=new URL(url).pathname.split('/').pop(),path=key==='entity-collision-policy.json'?key:'compiled/'+key,expected=url===config.physicsUrl?MAP.physics.triangles*36:url===config.maskUrl?MAP.physics.triangles:0,entry=transport?.file(path);if(entry&&expected&&entry.bytes!==expected)throw Error('加速碰撞长度与原图不一致');progress.plan(key,transport?.bytes(path,expected)||expected);progress.begin(key);const onBytes=(loaded,total)=>progress.bytes(key,loaded,total);const bytes=entry?await transport.read(path,{onBytes}):await readPrivateResource(url,{signal,bytes:expected,onBytes,maxBytes:expected||(url===config.groupsUrl?16:4)*1024*1024,cache:'no-store',fetcher});progress.done(key);return binary?bytes:new TextDecoder().decode(bytes);
  };

  if(useTexturedHigh){
   const collisionPromise=failTogether(Promise.all([fetchFile(config.physicsUrl,true),fetchFile(config.maskUrl,true),fetchFile(config.groupsUrl),fetchFile(config.policyUrl)]).then(([bytes,maskBytes,groupsText,policyText])=>decodePrivateMapCollision({bytes,maskBytes,groupsText,policyText,map:MAP,expected:config},{channels:[1,2,4],shared:true})));
   const jobs=await Promise.allSettled([
    failTogether(buildTexturedDust2Package(config,{onProgress,signal})),
    collisionPromise,
    failTogether(prepareFlatSky(config.id,{signal}).then(value=>{sky=value;return value;})),
   ]);
   const failed=jobs.find(job=>job.status==='rejected');if(failed)throw firstFailure||failed.reason;check();
   const pkg=jobs[0].value,collision=jobs[1].value;
   loadedRoot=pkg.group;
   const breakableCollision=new BreakableCollisionState(config.breakables||[],collision.sourceTrianglesByChannel);
   scene.add(pkg.group,...pkg.lights);
   if(pkg.sunTarget)scene.add(pkg.sunTarget);
   scene.fog=pkg.fog;
   sky.mount(scene);
   committed=true;
   onProgress(MAP.name+' 高画质原版贴图场景已就绪');
   return {mapData:MAP,positions:collision.sharedPositions,sharedChannelMask:collision.sharedChannelMask,bulletPositions:null,grenadePositions:null,mapPatches:false,group:pkg.group,sunTarget:pkg.sunTarget,finishAtlas:null,highQualityTextured:true,breakables:null,breakableCollision,lights:pkg.lights,spawn:MAP.spawns.T[0],physicsSha256:collision.physicsSha256,loadStats:{...progress.snapshot(),duplicateImages:0,transport:null}};
  }

  if (!useCompactMesh) {
    onProgress('读取 '+MAP.name+' 原图资源清单…',{phase:'map-manifest'});
    const manifestBytes=await readPrivateResource(new URL('../render-manifest.json',config.renderUrl),{signal,maxBytes:4*1024*1024,cache:'no-store',fetcher});
    files=privateRenderManifest(JSON.parse(new TextDecoder().decode(manifestBytes)),config);
    root=new URL('.',config.renderUrl);
    if(!config.flatOnly&&typeof DecompressionStream==='function'){
     const transportURL=new URL('../transport-manifest.json',config.renderUrl);
     const bytes=await readPrivateResource(transportURL,{signal,maxBytes:4*1024*1024,cache:'no-store',fetcher}).catch(error=>{if(!config.mapDownloadBaseURL&&error.message==='原图下载失败 (404)')return null;throw error;});
     if(bytes){transport=new PrivateMapTransport(JSON.parse(new TextDecoder().decode(bytes)),{identity:{...config,originalRenderGltfSha256:files.get('map.gltf').sha256},baseURL:new URL('../transport/',config.renderUrl),signal,fetcher});for(const [path,entry]of transport.files){if(path.startsWith('raw/')){const original=files.get(path.slice(4));if(!original)throw Error('加速资源未列入原图清单');transport.file(path,original);}const expected={'compiled/physics.f32':config.physicsSha256,'compiled/physics-mask.u8':config.maskSha256,'entity-collision-policy.json':config.policySha256}[path];if(expected&&entry.sha256!==expected)throw Error('地图加速碰撞版本不一致');}}
    }
    gltfFile=files.get('map.gltf');progress.plan('map.gltf',transport?.bytes('raw/map.gltf',gltfFile.bytes)||gltfFile.bytes);progress.begin('map.gltf');
    const gltfURL=new URL(config.renderUrl);gltfURL.searchParams.set('v',gltfFile.sha256);
    const gltfProgress=(loaded,total)=>progress.bytes('map.gltf',loaded,total);
    gltfBytes=transport?.file('raw/map.gltf')?await transport.read('raw/map.gltf',{onBytes:gltfProgress}):await readPrivateResource(gltfURL,{signal,bytes:gltfFile.bytes,onBytes:gltfProgress,fetcher});
    progress.done('map.gltf');const text=new TextDecoder().decode(gltfBytes);json=JSON.parse(text);
    const qualityHash=config.flatOnly?null:await hashBytes(gltfBytes);
    if(qualityHash&&qualityHash!==gltfFile.sha256)throw Error('原图模型与渲染清单版本不一致');
    inactiveLayoutMeshes=qualityHash?omitInactiveQualityMeshes(json,config.id,qualityHash):0;
    privateRenderDependencies(json,files);
    if(flat)flattenMapDocument(json,{authoredColors:config.flatOnly===true});
    duplicateImages=deduplicatePrivateImages(json,files);
    for(const name of privateRenderDependencies(json,files))progress.plan(name,transport?.bytes('raw/'+name,files.get(name).bytes)||files.get(name).bytes,(json.images||[]).some(image=>image.uri===name)?'texture':'file');
  } else {
    progress.plan('map.mgp', config.compactRender.bytes, 'file');
  }
  const entityPolicy=privateEntities(config.id);
  if(entityPolicy&&(config.id==='de_mirage'||config.movementModel===PRIVATE_MOVEMENT_MODEL||config.breakablesSha256)){
   if(await hashBytes(new TextEncoder().encode(JSON.stringify(entityPolicy)))!==config.breakablesSha256||JSON.stringify(config.breakables)!==JSON.stringify(entityPolicy.objects)||JSON.stringify(config.initialHiddenNodeIndices)!==JSON.stringify(entityPolicy.initialHiddenNodeIndices))throw Error('可破坏物配置与当前原始地图不一致');
   if(!useCompactMesh){
    const visualMatches = config.flatOnly
      ? await hashBytes(gltfBytes) === (config.flatBreakableVisuals?.renderSha256 || gltfFile.sha256)
      : qualityEntityRenderMatches(entityPolicy,qualityHash,files.get('map.bin')?.sha256);
    if(!visualMatches)throw Error('可破坏物配置与当前原始地图不一致');
   }
   if (config.flatOnly && !useCompactMesh) {
     visualDefinitions = config.breakables.map(definition => {
       if(definition.pane)return {...definition, proceduralPane:true, nodeNames:[], nodeIndices:[]};
       const node = config.flatBreakableVisuals?.nodesById?.[definition.id];
       if (!Number.isInteger(node) || json.nodes[node]?.name !== definition.id)
         throw Error('极简地图的可破坏物节点与配置不一致');
       const opened=definition.openNodeName?config.flatBreakableVisuals.nodesById?.[definition.openNodeName]:null;
       if(definition.openNodeName&&(!Number.isInteger(opened)||json.nodes[opened]?.name!==definition.openNodeName))throw Error('地图缺少通风百叶打开姿态');
       return {...definition, nodeIndices: [node], nodeNames: [definition.id], restoredNodeIndices: opened===null?[]:[opened]};
     });
     initialHidden = [];
   }
  }
  const renderBytes=useCompactMesh?config.compactRender.bytes:(json.buffers||[]).reduce((n,b)=>n+b.byteLength,0),physicsBytes=MAP.physics.triangles*36;
  const memory=performance.memory,reason=privateMapMemoryReason({renderBytes,physicsBytes,deviceMemory:navigator.deviceMemory||0,remainingHeap:memory?memory.jsHeapSizeLimit-memory.usedJSHeapSize:Infinity});
  if(reason)throw Error(reason);
  const meshPromise = useCompactMesh
    ? failTogether((async()=>{
        progress.begin('map.mgp');
        const raw=await readPrivateResource(new URL(config.compactRender.url,location.href),{signal,bytes:config.compactRender.bytes,onBytes:(loaded,total)=>progress.bytes('map.mgp',loaded,total),maxBytes:64*1024*1024,fetcher});
        progress.done('map.mgp');
        const decoded=decodeCompactMapMesh(raw);
        loadedRoot=decoded.scene;
        json={extras:decoded.extras};
        return decoded;
      })())
    : (()=>{
        loader=privateGLTFLoader(manager,{signal,files,baseURL:root.href,progress,transport,fetcher,onFailure:stopFailedJob});
        return failTogether(loader.parseAsync(json,root.href).then(gltf=>{loadedRoot=gltf.scene;return gltf;}));
      })();
  const collisionPromise=failTogether(Promise.all([fetchFile(config.physicsUrl,true),fetchFile(config.maskUrl,true),fetchFile(config.groupsUrl),fetchFile(config.policyUrl)]).then(([bytes,maskBytes,groupsText,policyText])=>decodePrivateMapCollision({bytes,maskBytes,groupsText,policyText,map:MAP,expected:config},{channels:[1,2,4],shared:true})));
  const jobs=await Promise.allSettled([
   meshPromise,
   collisionPromise,
   failTogether(prepareFlatSky(config.id,{signal}).then(value=>{sky=value;return value;})),
  ]);
  const failed=jobs.find(job=>job.status==='rejected');if(failed)throw firstFailure||failed.reason;check();progress.finish();
  if(useCompactMesh&&config.flatOnly&&entityPolicy&&config.breakables?.length){
   const decodedNodes=jobs[0].value.parser?.json?.nodes||[];
   visualDefinitions=config.breakables.map(definition=>{
    if(definition.pane)return {...definition,proceduralPane:true,nodeNames:[],nodeIndices:[]};
    const node=config.flatBreakableVisuals?.nodesById?.[definition.id];
    if(!Number.isInteger(node)||decodedNodes[node]?.name!==definition.id)throw Error('极简地图的可破坏物节点与配置不一致');
    const opened=definition.openNodeName?config.flatBreakableVisuals.nodesById?.[definition.openNodeName]:null;
    if(definition.openNodeName&&(!Number.isInteger(opened)||decodedNodes[opened]?.name!==definition.openNodeName))throw Error('地图缺少通风百叶打开姿态');
    return {...definition,nodeIndices:[node],nodeNames:[definition.id],restoredNodeIndices:opened===null?[]:[opened]};
   });
   initialHidden=[];
  }
  const collision=jobs[1].value;
  const breakableCollision=new BreakableCollisionState(config.breakables||[],collision.sourceTrianglesByChannel);
  const group=new THREE.Group();group.name=MAP.name+' · private original CS2 render';group.rotation.y=Math.PI/2;group.add(loadedRoot);group.updateMatrixWorld(true);
  const materials=new Set(),textures=new Set();let meshCount=0,triangles=0,outlineSegments=0;
  group.traverse(o=>{
   if(o.isLineSegments){outlineSegments+=(o.geometry.index?.count||o.geometry.attributes.position.count)/2;return;}
   if(o.isLight){o.visible=false;return;}if(!o.isMesh)return;
   meshCount++;triangles+=(o.geometry.index?.count||o.geometry.attributes.position.count)/3;o.frustumCulled=true;o.castShadow=false;o.receiveShadow=true;
   for(const material of [].concat(o.material||[])){
    if(materials.has(material))continue;materials.add(material);
    const v=material.userData?.vmat||{},flags=v.IntParams||{};
    if(v.Name?.startsWith('materials/tools/')||flags.F_DEPTH_FEATHER)material.visible=false;
    if(flags.F_VERTEX_ANIMATION||['csgo_effects.vfx','csgo_foliage.vfx'].includes(v.ShaderName))material.vertexColors=false;
    if(/overlay|decal|graffiti|poster/i.test(v.Name||material.name)){material.polygonOffset=true;material.polygonOffsetFactor=-1;material.polygonOffsetUnits=-1;}
    for(const value of Object.values(material))if(value?.isTexture)textures.add(value);
   }
  });
  if(flat){
    finishAtlas=json.extras?.surfaceMaterialVersion===1 ? await loadFlatSurfaceDetail(config.id) : null;
    check();
    if(finishAtlas)textures.add(finishAtlas);
    applyFlatMaterials(group,finishAtlas,config.id);
    applyVisualStyleToScene(group,getStoredVisualStyle());
    if(config.flatOnly){
      const markings=await createFlatSiteMarkings(MAP,manager);
      if(markings){
        textures.add(markings.material.map);
        if(!useCompactMesh)replaceOriginalFloorPaint(loadedRoot,MAP,gltfFile.sha256,files.get('map.bin')?.sha256);
        loadedRoot.add(markings);
        markings.updateWorldMatrix(true,false);
      }
      check();
    }
  }
  for(const texture of textures)texture.anisotropy=4;
  group.traverse(o=>{o.matrixAutoUpdate=false;o.matrixWorldAutoUpdate=false;});
  const lights=buildAtmosphereLights(config.id);
  check();if(config.breakables?.length)breakables=new PrivateMapBreakables({gltf:jobs[0].value,scene,definitions:visualDefinitions,initialHiddenNodeIndices:initialHidden});
  scene.add(group,...lights);
  scene.fog=null;
  sky.mount(scene);
  group.userData.renderStats={meshCount,triangles,outlineSegments,inactiveLayoutMeshes,materials:materials.size,textures:textures.size,originalCS2Materials:!flat,style:flat?'flat':'original',lightingParityValidated:false};
  committed=true;onProgress(MAP.name+(flat?' 标准场景已就绪':' 原始场景已就绪'));
  return {mapData:MAP,positions:collision.sharedPositions,sharedChannelMask:collision.sharedChannelMask,bulletPositions:null,grenadePositions:null,mapPatches:false,group,sunTarget:null,finishAtlas,highQualityTextured:false,breakables,breakableCollision,lights,spawn:MAP.spawns.T[0],physicsSha256:collision.physicsSha256,loadStats:{...progress.snapshot(),duplicateImages,transport:transport?.stats||null}};
 }finally{
  parentSignal?.removeEventListener('abort',abort);
  if(!committed){controller.abort();manager.abort();loader?.disposePrivateTextures();breakables?.dispose();disposeScene(loadedRoot);sky?.dispose();if(finishAtlas?.userData.mapTiles)finishAtlas.dispose();}
 }
}
