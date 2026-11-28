import {mountTouchLayout} from './touch-layout-editor.js';
import {TouchInput,normalizeTouch,touchLookDelta,touchModeEnabled,touchActionKind} from '../shared/touch-input.js';
import './touch-controls.css';

export class TouchControls {
 constructor({controls,storage,onLook=()=>{},onCancel=()=>{},onMode=()=>{},onRoom=()=>{},onFullscreen=()=>{},getFov=()=>90,previewOnly=false}){
  Object.assign(this,{controls,storage,onCancel,onMode,previewOnly});
  this.settings=normalizeTouch(storage.readJSON('dust2.touch.v1'));
  if(!previewOnly&&typeof location!=='undefined'&&new URLSearchParams(location.search).get('touch')==='1')this.settings.mode='on';
  this.active=false;this.throwMode='full';
  this.media=matchMedia('(pointer: coarse)');this.enabled=false;
  this.element=document.createElement('div');this.element.id='touch-controls';this.element.hidden=true;this.element.setAttribute('aria-label','触屏游戏控制');
  this.element.innerHTML=`<div class="touch-look" data-touch-kind="look" aria-label="滑动瞄准区域"></div>
   <div class="touch-joystick" data-touch-kind="move" data-layout-id="move" role="group" aria-label="移动摇杆"><i></i><span>移动</span></div>
   <button class="touch-fire-left" type="button" data-action="fire" data-layout-id="fireLeft" data-touch-kind="button" aria-label="左侧开火">开火</button>
   <button class="touch-walk" type="button" data-action="walk" data-layout-id="walk" data-toggle aria-label="静步">静步</button>
   <div class="touch-toolbar">
     <button type="button" data-action="buy" data-layout-id="buy">商店</button>
     <button type="button" data-touch-command="room" data-layout-id="room">房间</button>
     <button type="button" data-action="scoreboard" data-layout-id="scoreboard">战况</button>
     <button type="button" data-action="chatTeam" data-layout-id="chatTeam">聊天</button>
     <button type="button" data-touch-command="fullscreen" data-layout-id="fullscreen">全屏</button>
     <button type="button" data-action="menu" data-layout-id="menu">菜单</button>
   </div>
   <div class="touch-combat">
     <button class="touch-fire" type="button" data-action="fire" data-layout-id="fire" aria-label="右侧开火">开火</button>
     <button class="touch-alt" type="button" data-action="altFire" data-layout-id="altFire">开镜</button>
     <button class="touch-jump" type="button" data-action="jump" data-layout-id="jump">跳跃</button>
     <button class="touch-reload" type="button" data-action="reload" data-layout-id="reload">换弹</button>
     <button class="touch-crouch" type="button" data-action="crouch" data-layout-id="crouch" data-toggle>蹲下</button>
     <button class="touch-use" type="button" data-action="interact" data-layout-id="interact">拾取</button>
   </div>
   <div class="touch-weapons">
     <button type="button" data-action="primary" data-layout-id="primary" data-slot="1">主枪</button>
     <button type="button" data-action="secondary" data-layout-id="secondary" data-slot="2">手枪</button>
     <button type="button" data-action="knife" data-layout-id="knife" data-slot="3">刀</button>
     <button type="button" data-action="utility" data-layout-id="utility" data-slot="4">道具</button>
     <button type="button" data-action="bomb" data-layout-id="bomb" data-slot="5">C4</button>
     <button type="button" data-action="drop" data-layout-id="drop">丢枪</button>
   </div>
   <div class="touch-throw" hidden><span>按住准备 · 松手投出</span><button type="button" data-throw="full">远投</button><button type="button" data-throw="lob">中投</button><button type="button" data-throw="drop">近投</button><button type="button" data-touch-command="cancel">取消</button></div>
   <div class="touch-portrait-note">建议横屏游玩 · 右侧滑屏瞄准 · 左上可点射</div>`;
  document.body.append(this.element);
  this.buttons=[...this.element.querySelectorAll('[data-action]')];
  this.stick=this.element.querySelector('.touch-joystick');
  this.knob=this.stick.querySelector('i');
  this.input=new TouchInput({
    onAction:(a,held,id)=>controls.setVirtual(a,held,'touch-'+id),
    onLook:(dx,dy)=>{const vw=globalThis.visualViewport?.width||innerWidth,vh=globalThis.visualViewport?.height||innerHeight;const d=touchLookDelta(dx,dy,Math.min(vw,vh),this.settings.sensitivity,getFov(),this.settings.zoomSensitivity);onLook(d);},
    onCancel:()=>this.onCancel(),
  });
  this.element.addEventListener('pointerdown',e=>{
   if(this.previewOnly||!this.active||!this.enabled||e.pointerType==='mouse'&&this.settings.mode!=='on')return;
   const target=e.target.closest('button,[data-touch-kind]');if(!target||target.disabled)return;
   e.preventDefault();e.stopPropagation();
   if(target.dataset.touchCommand){const command=target.dataset.touchCommand;if(command==='cancel'){this.clear();this.onCancel();}if(command==='room')onRoom();return;}
   if(target.dataset.throw){this.clear();this.onCancel();this.throwMode=target.dataset.throw;this.drawThrow();return;}
   const action=target.dataset.action;
   if(target.hasAttribute('data-toggle')){controls.setVirtual(action,!controls.down(action),'toggle-'+action);target.classList.toggle('pressed',controls.down(action));return;}
   let actions=action?[action]:[],kind=target.dataset.touchKind||touchActionKind(action,this.state?.weapon);
   if(action==='fire'&&this.state?.slot===4)actions=this.throwMode==='full'?['fire']:this.throwMode==='drop'?['altFire']:['fire','altFire'];
   const box=this.stick.getBoundingClientRect();
   if(!this.input.begin(e.pointerId,kind,e.clientX,e.clientY,{actions,radius:Math.max(24,box.width*.36),center:kind==='move'?{x:box.x+box.width/2,y:box.y+box.height/2}:null}))return;
   try{this.element.setPointerCapture?.(e.pointerId);}catch{}
   target.classList.add('pressed');this.drawStick();
  });
  this.element.addEventListener('pointermove',e=>{if(!this.input.pointers.has(e.pointerId))return;e.preventDefault();this.input.move(e.pointerId,e.clientX,e.clientY);this.drawStick();});
  this.element.addEventListener('pointerup',e=>{this.input.end(e.pointerId);this.drawHeld();this.drawStick();});
  for(const name of ['pointercancel','lostpointercapture'])this.element.addEventListener(name,e=>{this.input.end(e.pointerId,true);this.drawHeld();this.drawStick();});
  this.element.querySelector('[data-touch-command=fullscreen]').addEventListener('click',()=>{if(!this.previewOnly&&this.active&&this.enabled)onFullscreen();});
  this.element.addEventListener('contextmenu',e=>e.preventDefault());
  this.media.addEventListener('change',()=>this.refreshMode());
  this.refreshMode();this.drawThrow();
 }
 refreshMode(){
  if(this.previewOnly){
   this.enabled=false;
   this.element.style.setProperty('--touch-size',this.settings.size);
   this.element.hidden=true;
   return;
  }
  const enabled=touchModeEnabled(this.settings.mode,this.media.matches,navigator.userAgent);
  if(enabled!==this.enabled){this.clear();this.enabled=enabled;this.controls.mouse=!enabled;this.onMode?.(enabled);}
  document.body.classList.toggle('touch-device',enabled);
  this.element.style.setProperty('--touch-size',this.settings.size);
  this.element.hidden=!enabled||!this.active;
 }
 configure(values){this.settings=normalizeTouch({...this.settings,...values});this.storage.setItem('dust2.touch.v1',JSON.stringify(this.settings));this.refreshMode();}
 setActive(active){if(this.previewOnly){this.active=false;this.element.hidden=true;return;}active=!!active;if(this.active&&!active)this.clear();this.active=active;this.element.hidden=!this.enabled||!active;if(active&&this.enabled)this._applyCustomLayout?.();}
 clear(){this.input?.clear();this.drawStick();this.element?.querySelectorAll('.pressed').forEach(b=>b.classList.remove('pressed'));}
 drawStick(){if(!this.input)return;const {right,forward}=this.input.axes;const travel=Math.max(22,(this.stick?.offsetWidth||112)*0.3);this.knob.style.transform=`translate(${right*travel}px,${-forward*travel}px)`;}
 drawHeld(){this.buttons.forEach(b=>b.classList.toggle('pressed',this.controls.down(b.dataset.action)));}
 drawThrow(){this.element.querySelectorAll('[data-throw]').forEach(b=>b.classList.toggle('selected',b.dataset.throw===this.throwMode));}
 update(state){
  this.state=state;if(this.previewOnly)return;
  document.body.classList.toggle('touch-spectator',state.spectator);document.body.classList.toggle('touch-utility',state.slot===4);if(!this.enabled||!this.active)return;
  for(const b of this.buttons){const a=b.dataset.action;const combat=['fire','altFire','reload'].includes(a),movement=['jump','crouch','walk'].includes(a),equipment=['primary','secondary','knife','utility','bomb','drop','interact'].includes(a);
   b.disabled=(combat&&!state.combat&&!(state.equipment&&state.burstWeapon&&a==='altFire')&&!(state.spectator&&state.canCycle!==false&&['fire','altFire'].includes(a)))||(movement&&!state.moving)||(equipment&&!state.equipment&&!(a==='interact'&&state.canTakeBot))||(a==='buy'&&!state.alive);
   if(b.dataset.slot){const slot=Number(b.dataset.slot);b.disabled||=!state.slots.includes(slot);b.classList.toggle('selected',state.slot===slot);}
  }
  const fireLabel=state.spectator?'下一位':state.slot===4?'投掷':state.slot===5?'下包':'开火';
  const leftFireLabel=state.slot===4?'投掷':state.slot===5?'下包':'开火';
  const rightFire=this.element.querySelector('.touch-fire');
  const leftFire=this.element.querySelector('.touch-fire-left');
  if(rightFire)rightFire.textContent=fireLabel;
  if(leftFire)leftFire.textContent=leftFireLabel;
  this.element.querySelector('.touch-alt').textContent=state.spectator?'上一位':state.slot===3?'重刀':state.weapon==='revolver'?'扳锤':state.burstWeapon?'切模式':'开镜';
  this.element.querySelector('.touch-alt').disabled||=state.slot===4;
  this.element.querySelector('.touch-use').textContent=state.canTakeBot?'控制人机':state.hasBomb?'下包':state.planted?'拆包':'拾取';
  this.element.querySelector('.touch-throw').hidden=state.slot!==4||!state.alive;
 }
 get axes(){return this.input.axes;}
}

export function mountTouchSettings(settingsUI,touch){
 const modal=settingsUI.element,panel=document.createElement('section');
 panel.innerHTML=`
  <div class="settings-panel-head">
   <div><h3>移动端触屏与按键布局</h3><p>左侧摇杆上方已新增独立开火键，支持自由拖动每个按键位置，并内置双指 / 三指 / 四指预设。</p></div>
  </div>
  <div class="settings-group" data-touch-layout-group>
   <div class="group-header-row">
    <h4>自定义按键位置（支持 2 / 3 / 4 指）</h4>
    <span class="settings-badge badge-live">大厅与局内同步</span>
   </div>
   <p class="group-hint" style="margin:0 0 12px">左开火键仅触发射击不抢视角，适合右手滑动瞄准 + 左手点射/扫射，或三指/四指玩家拖到左上角操作。</p>
   <div class="touch-layout-launcher" data-layout-launcher></div>
  </div>
  <div class="settings-group">
   <h4>触屏基础控制</h4>
   <label class="config-row"><span><strong>触屏控制</strong><small>在手机或平板上启用虚拟摇杆与战斗按钮</small></span><select id="touch-mode"><option value="auto">自动检测</option><option value="on">始终开启</option><option value="off">关闭</option></select></label>
   <div class="slider-control-head" style="margin-top:12px"><div><label class="control-title" for="touch-sensitivity">触屏滑动灵敏度</label><span class="control-sub">控制右侧滑屏转向速度</span></div><output id="touch-sens-value" class="value-pill"></output></div>
   <input id="touch-sensitivity" class="cs-range" type="range" min="0.4" max="2.5" step="0.05">
   <div class="slider-control-head" style="margin-top:12px"><div><label class="control-title" for="touch-zoom-sensitivity">开镜触屏倍率</label><span class="control-sub">狙击镜缩放时的滑屏微调比例</span></div><output id="touch-zoom-value" class="value-pill"></output></div>
   <input id="touch-zoom-sensitivity" class="cs-range" type="range" min="0.2" max="2.5" step="0.05">
   <div class="slider-control-head" style="margin-top:12px"><div><label class="control-title" for="touch-size">全局按钮缩放</label><span class="control-sub">统一微调所有触控按钮的默认大小</span></div><output id="touch-size-value" class="value-pill"></output></div>
   <input id="touch-size" class="cs-range" type="range" min="0.85" max="1.15" step="0.05">
  </div>`;
 settingsUI.registerTab({ group: 'control', id: 'touch', label: '触屏与按键布局', panel });
 const setFill=el=>{if(!el)return;const min=Number(el.min||0),max=Number(el.max||1),v=Number(el.value||0);el.style.setProperty('--range-pct',((v-min)/(max-min)*100).toFixed(1)+'%');};
 const sync=()=>{
  panel.querySelector('#touch-mode').value=touch.settings.mode;
  const s1=panel.querySelector('#touch-sensitivity'),s2=panel.querySelector('#touch-zoom-sensitivity'),s3=panel.querySelector('#touch-size');
  s1.value=touch.settings.sensitivity;s2.value=touch.settings.zoomSensitivity;s3.value=touch.settings.size;
  setFill(s1);setFill(s2);setFill(s3);
  panel.querySelector('#touch-sens-value').textContent=touch.settings.sensitivity.toFixed(2);
  panel.querySelector('#touch-zoom-value').textContent=touch.settings.zoomSensitivity.toFixed(2);
  panel.querySelector('#touch-size-value').textContent=Math.round(touch.settings.size*100)+'%';
 };
 sync();
 mountTouchLayout(panel,modal,touch);
 for(const [id,key] of [['touch-mode','mode'],['touch-sensitivity','sensitivity'],['touch-zoom-sensitivity','zoomSensitivity'],['touch-size','size']])panel.querySelector('#'+id).addEventListener('input',e=>{touch.configure({[key]:key==='mode'?e.target.value:Number(e.target.value)});sync();});
}
