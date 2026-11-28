import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {TouchInput,joystickVector,touchLookDelta,normalizeTouch,touchActionKind} from '../shared/touch-input.js';
import {LAYOUT_IDS,buildTouchPresetLayout,layoutRect} from '../shared/touch-layout.js';
import {GameControls} from '../client/controls.js';
test('analog joystick deadzone, direction and diagonal speed remain bounded',()=>{
 assert.deepEqual(joystickVector(2,-3),{right:0,forward:0});assert.equal(joystickVector(0,-100).forward,1);
 const d=joystickVector(100,-100);assert.ok(Math.abs(Math.hypot(d.right,d.forward)-1)<1e-9);assert.ok(joystickVector(0,-25).forward<1);
});
test('movement, aim, fire and jump have independent pointer ownership',()=>{
 const actions=[],look=[];const input=new TouchInput({onAction:(...args)=>actions.push(args),onLook:(...args)=>look.push(args)});
 input.begin(11,'move',0,0);input.move(11,0,-52);input.begin(12,'look',200,100);input.begin(13,'fire',250,100,{actions:['fire']});input.begin(14,'button',300,120,{actions:['jump']});
 input.move(12,220,110);input.move(13,260,95);input.end(14);assert.equal(input.axes.forward,1);assert.equal(input.pointers.size,3);assert.deepEqual(look,[[20,10],[10,-5]]);assert.deepEqual(actions.map(a=>a.slice(0,2)),[['fire',true],['jump',true],['jump',false]]);
 input.end(12);assert.equal(input.axes.forward,1);input.end(11);assert.equal(input.axes.forward,0);assert.ok(input.pointers.has(13));input.end(13);
});
test('virtual actions preserve remaps, single edges and multiple held sources',()=>{
 let enabled=true;const changes=[];const c=new GameControls({target:new EventTarget(),storage:null,enabled:()=>enabled,onAction:(a,s)=>changes.push([a,s.pressed])});
 c.setBinding('fire','KeyP',{slot:0});c.setVirtual('fire',true,'finger1');c.setVirtual('fire',true,'finger2');assert.equal(c.consume('fire'),true);assert.equal(c.consume('fire'),false);
 c.setVirtual('fire',false,'finger1');assert.equal(c.down('fire'),true);c.setVirtual('fire',false,'finger2');assert.equal(c.down('fire'),false);assert.deepEqual(changes,[['fire',true],['fire',false]]);
 enabled=false;c.setVirtual('fire',true,'finger1');assert.equal(c.down('fire'),false);c.destroy();
});
test('touch cancellation resets every finger and cancels a held grenade instead of releasing it',()=>{
 const events=[];const c=new GameControls({target:new EventTarget(),storage:null,onAction:(a,s)=>events.push({a,...s})});
 const input=new TouchInput({onAction:(a,p,id)=>c.setVirtual(a,p,id),onCancel:()=>c.clear()});
 input.begin(1,'move',0,0);input.move(1,40,-30);input.begin(2,'fire',100,0,{actions:['fire','altFire']});input.end(2,true);
 assert.equal(input.pointers.size,0);assert.deepEqual(input.axes,{forward:0,right:0});assert.equal(c.down('fire'),false);assert.equal(c.down('altFire'),false);
 assert.ok(events.filter(e=>!e.pressed).every(e=>e.source==='clear'));input.end(2);assert.equal(events.length,4);c.destroy();
});
test('touch aim uses CSS-distance sensitivity and slows down under magnification',()=>{
 const normal=touchLookDelta(50,-10,390,1,90),zoom=touchLookDelta(50,-10,390,1,10);assert.ok(normal.yaw<0&&normal.pitch>0);assert.ok(Math.abs(zoom.yaw)<Math.abs(normal.yaw)/5);
 assert.equal(touchLookDelta(50,-10,390,2,90).yaw,normal.yaw*2);assert.deepEqual(normalizeTouch({mode:'invalid',size:100,sensitivity:-1}),{mode:'auto',size:1.15,sensitivity:.4,zoomSensitivity:1});
});

test('touch scoped sensitivity can be tuned independently and old saved settings keep their aiming scale',()=>{
 const old=normalizeTouch({sensitivity:1.4});assert.equal(old.zoomSensitivity,1);
 const base=touchLookDelta(50,10,390,old.sensitivity,40),half=touchLookDelta(50,10,390,old.sensitivity,40,.5);
 assert.equal(half.yaw,base.yaw*.5);assert.equal(half.pitch,base.pitch*.5);
 assert.deepEqual(touchLookDelta(50,10,390,1.4,90,.5),touchLookDelta(50,10,390,1.4,90,2));
 assert.equal(normalizeTouch({zoomSensitivity:-10}).zoomSensitivity,.2);
 assert.equal(normalizeTouch({zoomSensitivity:10}).zoomSensitivity,2.5);
 const saved=normalizeTouch(JSON.parse(JSON.stringify(normalizeTouch({zoomSensitivity:.75}))));assert.equal(saved.zoomSensitivity,.75);
});

test('R8 alternate fire can drag aim while movement and primary aim keep independent pointers',()=>{
 const c=new GameControls({target:new EventTarget(),storage:null}),look=[];
 const input=new TouchInput({onAction:(a,p,id)=>c.setVirtual(a,p,id),onLook:(...d)=>look.push(d)});
 input.begin(1,'move',0,0);input.move(1,0,-52);
 input.begin(2,touchActionKind('altFire','revolver'),200,100,{actions:['altFire']});input.move(2,212,94);
 assert.equal(c.down('altFire'),true);assert.deepEqual(look,[[12,-6]]);assert.equal(input.axes.forward,1);
 input.end(2);assert.equal(c.down('altFire'),false);assert.equal(input.axes.forward,1);
 for(const weapon of ['awp','knife','ak47'])assert.equal(touchActionKind('altFire',weapon),'button');
 assert.equal(touchActionKind('fire','ak47'),'fire');c.destroy();
});
test('a second joystick finger cannot steal or reset the first joystick',()=>{
 const input=new TouchInput();assert.equal(input.begin(1,'move',0,0),true);input.move(1,0,-52);assert.equal(input.begin(2,'move',100,100),false);input.end(2,true);assert.equal(input.axes.forward,1);
});

test('focusing another game button does not count as leaving the window',()=>{
 const target=new EventTarget(),c=new GameControls({target,storage:null});c.setVirtual('crouch',true,'toggle');
 c.handlers.blur({target:{tagName:'BUTTON'}});assert.equal(c.down('crouch'),true);
 target.dispatchEvent(new Event('blur'));assert.equal(c.down('crouch'),false);c.destroy();
});

test('touch control containers never set CSS transform that would break custom fixed-position weapon buttons',()=>{
 const css=fs.readFileSync(path.resolve(import.meta.dirname,'../client/touch-controls.css'),'utf8');
 // Match rule blocks targeting #touch-controls, .touch-weapons, .touch-combat, or .touch-toolbar (not child buttons)
 for(const m of css.matchAll(/([^{}]+)\{([^{}]+)\}/g)){
  const sel=m[1].trim(),body=m[2];
  if(/(?:^|[\s,])(?:#touch-controls|\.touch-weapons|\.touch-combat|\.touch-toolbar)(?:\s|$|,)/.test(sel) && !/button\b/.test(sel)){
   assert.equal(/\btransform\s*:/i.test(body),false,`selector "${sel}" must not use transform (breaks position:fixed custom layout buttons)`);
  }
 }
 // Verify 2/3/4-finger presets position combat buttons inside viewport AND leave weapon/toolbar responsive!
 const bases=new Map(LAYOUT_IDS.map((id,i)=>[id,{width:42,height:34,x:0.2+(i%6)*0.11,y:0.9}]));
 for(const preset of ['two-finger','three-finger','four-finger']){
  for(const [w,h] of [[844,390],[390,844]]){
   const lay=buildTouchPresetLayout(preset,bases,w,h);
   for(const id of ['move','fireLeft','fire','altFire','jump','crouch','reload','interact','walk']){
    const btn=lay.buttons[id];
    assert.ok(btn,`preset ${preset} missing combat button ${id}`);
    assert.notEqual(btn.hidden,true,`preset ${preset} must not hide ${id}`);
    const r=layoutRect(btn,bases.get(id),w,h);
    assert.ok(r.left>=0 && r.left+r.width<=w && r.top>=0 && r.top+r.height<=h,`${preset} ${id} out of bounds on ${w}x${h}`);
   }
   for(const id of ['primary','secondary','knife','utility','bomb','drop','buy','room','scoreboard','menu']){
    assert.equal(lay.buttons[id],undefined,`preset ${preset} should leave ${id} in responsive flex layout`);
   }
  }
 }
});
