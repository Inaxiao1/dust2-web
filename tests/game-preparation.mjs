import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {GameAudio} from '../client/audio.js';
import {startingPistolForTeam} from '../shared/weapon-loadout.js';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const source=await readFile(new URL('../client/main.js',import.meta.url),'utf8');
const preparation=source.slice(source.indexOf('async function loadGame('),source.indexOf('\nasync function start(',source.indexOf('async function loadGame(')));

function fixture({download=async()=>{},privateMap=false,map=async()=>({positions:[]})}={}){
 const events=[],element={value:'T',textContent:''};
 const context=vm.createContext({
  AbortController,DOMException,setTimeout,clearTimeout,performance,Promise,
  loaded:false,privateMap,connection:{offline:false},downloadAbort:null,downloadProgress:()=>{},privateLoadProgress:()=>{},
  flatMapSelected:()=>false,downloadAssets:download,setLoadStage:()=>{},mobileDevice:()=>false,paint:async()=>{},
  modelsReady:true,mapResultCache:privateMap?null:{positions:[]},createMapScene:map,
  diagnostics:{event:()=>{}},audio:{start:async()=>events.push('audio-samples')},
  loadModels:async()=>{},loadAgent:async()=>{},agentsUI:{loadout:{T:'t-phoenix',CT:'ct-sas'}},
  skins:{loadout:{}},armory:{loadout:null},startingPistolForTeam,primary:'ak47',loadSkin:async()=>{},$:()=>element,
  initPhysics:()=>{},viewWeapon:{},applyQuality:()=>{},scene:{},gunScene:{},gunCamera:{},
  renderer:{compileAsync:async()=>{}},camera:{position:{set:()=>{}}},
  MAP:{spawns:{T:[{x:0,y:0,z:0}],CT:[{x:0,y:0,z:0}]}},
  releaseDownloads:()=>events.push('released')
 });
 vm.runInContext(preparation+'\nglobalThis.prepareGame=loadGame;',context);
 return{context,events,run:()=>context.prepareGame(Promise.resolve())};
}

test('native audio unlock happens in the gesture without reading sample assets',async()=>{
 const previous=globalThis.window,events=[],gate=deferred();
 const node=()=>({connect:()=>{},gain:{value:0},threshold:{value:0},knee:{value:0},ratio:{value:0},attack:{value:0},release:{value:0}});
 class AudioContext{destination={};createDynamicsCompressor=node;createGain=node;createWaveShaper=node;resume(){events.push('native-resume');return gate.promise;}}
 globalThis.window={AudioContext};
 try{
  const audio=new GameAudio();audio.loadSamples=async()=>events.push('sample-assets');
  const unlock=audio.resume();assert.deepEqual(events,['native-resume']);assert.equal(audio.loading,null);
  gate.resolve();await unlock;assert.deepEqual(events,['native-resume']);assert.equal(audio.ready,false);
  await audio.start();assert.equal(events.filter(x=>x==='sample-assets').length,1);assert.equal(audio.ready,true);
 }finally{if(previous===undefined)delete globalThis.window;else globalThis.window=previous;}
});

test('cancelled base prefetch starts no independent audio reader and retry can finish',async()=>{
 let attempt=0;const f=fixture({download:async()=>{if(++attempt===1)throw new DOMException('Cancelled','AbortError');}});
 await assert.rejects(f.run(),{name:'AbortError'});assert.deepEqual(f.events,[]);
 await f.run();assert.equal(f.events.filter(x=>x==='audio-samples').length,1);assert.equal(f.context.loaded,true);
});

test('sample preparation waits for successful base prefetch',async()=>{
 const gate=deferred(),f=fixture({download:()=>gate.promise}),ready=f.run();
 await Promise.resolve();assert.deepEqual(f.events,[]);gate.resolve();await ready;
 assert.deepEqual(f.events,['audio-samples','released']);
});

test('cancelled original-map preparation does not leave audio sample work running',async t=>{
 if(!preparation.includes('if(privateMap'))return t.skip('Public baseline has no private-map preparation branch');
 const f=fixture({privateMap:true,map:async()=>{throw new DOMException('Cancelled','AbortError');}});
 await assert.rejects(f.run(),{name:'AbortError'});assert.deepEqual(f.events,[]);
});

test('standard map and animation loading overlap and cancel together on failure',async()=>{
 const failure=new Error('map unavailable'),events=[];
 const f=fixture({
  privateMap:{flatOnly:true},
  download:({signal,matchOnly})=>new Promise((_resolve,reject)=>{
   assert.equal(matchOnly,true);
   events.push('animations');
   signal.addEventListener('abort',()=>{events.push('cancelled');reject(signal.reason);},{once:true});
  }),
  map:async()=>{events.push('map');throw failure;},
 });
 await assert.rejects(f.run(),error=>error===failure);
 assert.deepEqual(events,['animations','map','cancelled']);
 assert.deepEqual(f.events,[]);
});

test('a graphics preparation retry reuses the already installed collision data',async()=>{
 const positions=[0,0,0],initialized=[];
 const f=fixture({privateMap:true,map:async()=>({positions})});
 f.context.PRIVATE_MOVEMENT_MODEL='private-movement';
 f.context.initPhysics=source=>initialized.push(source);
 f.context.renderer.compileAsync=async()=>{throw new Error('GPU preparation failed');};
 await assert.rejects(f.run(),/GPU preparation failed/);
 await assert.rejects(f.run(),/GPU preparation failed/);
 assert.deepEqual(initialized,[positions]);
});

test('already prepared scene resumes audio without repeating base prefetch',async()=>{
 const f=fixture({download:async()=>assert.fail('Unexpected base download')});f.context.loaded=true;
 await f.run();assert.deepEqual(f.events,['audio-samples']);
});
