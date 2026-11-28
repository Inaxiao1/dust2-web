import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {viewportSize} from '../shared/video-settings.js';
import {LAYOUT_IDS,normalizeLayout,buildTouchPresetLayout,layoutRect} from '../shared/touch-layout.js';
const json=async path=>JSON.parse(await readFile(new URL(path,import.meta.url),'utf8'));
test('phone viewport fills portrait, wide landscape and browser chrome sizes without stretching a fixed 16:9 frame',()=>{
 for(const [width,height] of [[390,844],[844,390],[667,320],[960,432]]){
   const v=viewportSize(width,height,{mobile:true,aspect:'4:3'});
   assert.deepEqual(v,{aspect:width/height,width,height,displayWidth:width,displayHeight:height});
 }
});
test('touch layout includes independent left fire button, optional hidden flag, and 2/3/4-finger presets',()=>{
 assert.ok(LAYOUT_IDS.includes('fireLeft'));
 assert.ok(LAYOUT_IDS.includes('fire'));
 const norm=normalizeLayout({version:1,buttons:{fire:{x:.8,y:.7,size:1,opacity:.8,hidden:true},move:{x:.15,y:.75,size:1,opacity:.8,hidden:true},fireLeft:{x:.1,y:.4,size:1.2,opacity:.9,hidden:false}}});
 assert.equal(norm.buttons.fire.hidden,true);
 assert.equal(norm.buttons.move.hidden,undefined,'move cannot be hidden');
 assert.equal(norm.buttons.fireLeft.hidden,undefined,'false hidden is omitted');
 const bases=new Map(LAYOUT_IDS.map(id=>[id,{x:.5,y:.5,width:50,height:50}]));
 for(const [w,h] of [[844,390],[390,844]]){
   const two=buildTouchPresetLayout('two-finger',bases,w,h);
   assert.ok(two.buttons.fireLeft.y<two.buttons.move.y,'left fire sits above movement joystick in two-finger preset');
   const three=buildTouchPresetLayout('three-finger',bases,w,h);
   assert.ok(three.buttons.fireLeft.x<0.3&&three.buttons.fireLeft.y<0.35,'three-finger places left fire in top-left claw zone');
   const four=buildTouchPresetLayout('four-finger',bases,w,h);
   assert.ok(four.buttons.fireLeft.x<0.3&&four.buttons.fireLeft.y<0.35,'four-finger places left fire in top-left claw zone');
   assert.ok(four.buttons.altFire.x>0.7&&four.buttons.altFire.y<0.35,'four-finger places scope in top-right claw zone');
   for(const preset of [two,three,four]){
     for(const [id,btn] of Object.entries(preset.buttons)){
       const rect=layoutRect(btn,bases.get(id),w,h);
       assert.ok(rect.left>=0&&rect.top>=0&&rect.left+rect.width<=w+0.01&&rect.top+rect.height<=h+0.01,`${id} stays in bounds`);
     }
   }
 }
});
test('mobile map preserves every mesh, material and texture association; manifest excludes desktop images',async()=>{
 const desktop=await json('../public/assets/map-cs2/dust2-web.gltf'),mobile=await json('../public/assets/map-mobile/dust2-clear.gltf');
 for(const key of ['meshes','accessors','bufferViews','materials','textures','nodes'])assert.deepEqual(mobile[key],desktop[key]);
 assert.equal(mobile.images.length,desktop.images.length);assert.ok(mobile.images.every(i=>i.uri.startsWith('textures/')));
 const manifest=await json('../public/assets/asset-manifest-mobile.json'),full=await json('../public/assets/asset-manifest.json');
 assert.ok(!manifest.files.some(f=>f.path.startsWith('assets/map-cs2/textures/')));
 assert.ok(manifest.files.some(f=>f.path==='assets/map-mobile/dust2-clear.gltf'));
 const mobileTex=manifest.files.filter(f=>f.path.startsWith('assets/map-mobile/textures/')).reduce((s,f)=>s+f.bytes,0);
 const desktopTex=full.files.filter(f=>f.path.startsWith('assets/map-cs2/textures/')).reduce((s,f)=>s+f.bytes,0);
 assert.ok(manifest.totalBytes<full.totalBytes && mobileTex<desktopTex*.65);
});
