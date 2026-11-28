export const LAYOUT_KEY='dust2.touch-layout.v1';
export const LAYOUT_IDS=['move','fireLeft','fire','altFire','jump','reload','crouch','interact','walk','buy','scoreboard','menu','chatTeam','primary','secondary','knife','utility','bomb','drop','room','fullscreen'];
export const TOUCH_REQUIRED_IDS=Object.freeze(new Set(['move','menu']));
export const TOUCH_BUTTON_LABELS=Object.freeze({
  move:'移动摇杆',
  fireLeft:'左侧开火',
  fire:'右侧开火',
  altFire:'开镜 / 右键',
  jump:'跳跃',
  reload:'换弹',
  crouch:'蹲下',
  interact:'拾取 / 拆包',
  walk:'静步',
  buy:'商店',
  scoreboard:'战况',
  menu:'菜单',
  chatTeam:'聊天',
  primary:'主武器',
  secondary:'手枪',
  knife:'近战刀',
  utility:'投掷物',
  bomb:'C4 炸弹',
  drop:'丢枪',
  room:'房间',
  fullscreen:'全屏',
});
export const TOUCH_PRESETS=Object.freeze([
  {id:'two-finger',label:'双指默认',hint:'左侧移动上方配左开火，右侧瞄准+开火'},
  {id:'three-finger',label:'三指布局',hint:'左手食指左上角大开火键，右手纯滑屏瞄准'},
  {id:'four-finger',label:'四指布局',hint:'左食指左上开火，右食指右上开镜+跳跃'},
]);

const bound=(v,a,b,f)=>Number.isFinite(v)?Math.min(b,Math.max(a,v)):f;

export function normalizeLayout(input) {
  const out={version:1,buttons:{}};
  if(input?.version!==1||!input.buttons||typeof input.buttons!=='object')return out;
  for(const id of LAYOUT_IDS){
    const b=input.buttons[id];
    if(!b||typeof b!=='object')continue;
    const entry={
      x:bound(b.x,0,1,.5),
      y:bound(b.y,0,1,.5),
      size:bound(b.size,.65,1.5,1),
      opacity:bound(b.opacity,.25,1,.75),
    };
    if(b.hidden===true&&!TOUCH_REQUIRED_IDS.has(id))entry.hidden=true;
    out.buttons[id]=entry;
  }
  return out;
}

export function parseLayout(text) {
  if(typeof text!=='string'||text.length>16000)throw Error('布局代码过长');
  const value=JSON.parse(text);
  if(value.version!==1||!value.buttons||typeof value.buttons!=='object')throw Error('布局代码无效');
  return normalizeLayout(value);
}

export function layoutRect(button,base,width,height) {
  const w=Math.min(width,Math.max(44,base.width*button.size)),h=Math.min(height,Math.max(44,base.height*button.size));
  return {left:Math.max(0,Math.min(width-w,button.x*width-w/2)),top:Math.max(0,Math.min(height-h,button.y*height-h/2)),width:w,height:h};
}

/**
 * Build ergonomic 2/3/4-finger mobile FPS presets normalized to [0..1] viewport coordinates.
 * Works cleanly in both landscape (preferred) and portrait orientations.
 */
export function buildTouchPresetLayout(presetId,bases,width=844,height=390) {
  const portrait=height>width;
  const buttons={};
  for(const [key,base] of bases){
    buttons[key]={x:bound(base.x,0,1,.5),y:bound(base.y,0,1,.5),size:1,opacity:.82};
  }
  const set=(key,patch)=>{
    if(!buttons[key])return;
    buttons[key]={...buttons[key],...patch};
    delete buttons[key].hidden;
  };
  if(presetId==='two-finger'){
    if(portrait){
      set('move',{x:.20,y:.74,size:1,opacity:.8});
      set('fireLeft',{x:.16,y:.57,size:1.05,opacity:.9});
      set('walk',{x:.34,y:.60,size:.95,opacity:.78});
      set('fire',{x:.76,y:.68,size:1.05,opacity:.9});
      set('altFire',{x:.60,y:.72,size:.95,opacity:.85});
      set('jump',{x:.90,y:.64,size:.95,opacity:.85});
      set('crouch',{x:.90,y:.75,size:.95,opacity:.85});
      set('reload',{x:.75,y:.80,size:.9,opacity:.85});
      set('interact',{x:.60,y:.81,size:.9,opacity:.85});
    }else{
      set('move',{x:.13,y:.72,size:1,opacity:.8});
      set('fireLeft',{x:.09,y:.44,size:1.05,opacity:.9});
      set('walk',{x:.19,y:.48,size:.95,opacity:.78});
      set('fire',{x:.82,y:.65,size:1.08,opacity:.9});
      set('altFire',{x:.72,y:.66,size:1,opacity:.86});
      set('jump',{x:.93,y:.56,size:1,opacity:.86});
      set('crouch',{x:.93,y:.75,size:1,opacity:.86});
      set('reload',{x:.82,y:.83,size:.95,opacity:.86});
      set('interact',{x:.72,y:.83,size:.95,opacity:.86});
    }
  }else if(presetId==='three-finger'){
    // Left index finger on upper-left large Fire; left thumb on move; right thumb aims + jump/crouch/scope.
    if(portrait){
      set('move',{x:.20,y:.76,size:1.02,opacity:.78});
      set('fireLeft',{x:.17,y:.26,size:1.28,opacity:.92});
      set('walk',{x:.14,y:.59,size:.92,opacity:.75});
      set('fire',{x:.80,y:.73,size:.9,opacity:.65});
      set('altFire',{x:.88,y:.56,size:1.08,opacity:.88});
      set('jump',{x:.89,y:.67,size:1.05,opacity:.88});
      set('crouch',{x:.73,y:.81,size:1.0,opacity:.86});
      set('reload',{x:.89,y:.79,size:.95,opacity:.86});
      set('interact',{x:.61,y:.81,size:.92,opacity:.84});
    }else{
      set('move',{x:.13,y:.73,size:1.02,opacity:.78});
      set('fireLeft',{x:.17,y:.24,size:1.25,opacity:.92});
      set('walk',{x:.07,y:.47,size:.92,opacity:.76});
      set('fire',{x:.84,y:.72,size:.9,opacity:.62});
      set('altFire',{x:.91,y:.50,size:1.08,opacity:.88});
      set('jump',{x:.81,y:.52,size:1.05,opacity:.88});
      set('crouch',{x:.93,y:.72,size:1.02,opacity:.88});
      set('reload',{x:.74,y:.76,size:.95,opacity:.86});
      set('interact',{x:.65,y:.78,size:.92,opacity:.84});
    }
  }else if(presetId==='four-finger'){
    // Left index -> upper-left Fire; Right index -> upper-right Scope + Jump; Thumbs -> Move / Aim + Crouch/Reload.
    if(portrait){
      set('move',{x:.20,y:.77,size:1.02,opacity:.76});
      set('fireLeft',{x:.17,y:.25,size:1.28,opacity:.92});
      set('walk',{x:.14,y:.60,size:.92,opacity:.75});
      set('altFire',{x:.84,y:.25,size:1.2,opacity:.92});
      set('jump',{x:.66,y:.28,size:1.08,opacity:.9});
      set('crouch',{x:.88,y:.67,size:1.06,opacity:.88});
      set('reload',{x:.88,y:.79,size:.98,opacity:.86});
      set('interact',{x:.72,y:.79,size:.95,opacity:.86});
      set('fire',{x:.74,y:.67,size:.85,opacity:.55});
    }else{
      set('move',{x:.13,y:.73,size:1.02,opacity:.76});
      set('fireLeft',{x:.16,y:.24,size:1.25,opacity:.92});
      set('walk',{x:.07,y:.47,size:.92,opacity:.76});
      set('altFire',{x:.89,y:.27,size:1.18,opacity:.92});
      set('jump',{x:.79,y:.29,size:1.08,opacity:.9});
      set('crouch',{x:.92,y:.69,size:1.06,opacity:.88});
      set('reload',{x:.82,y:.76,size:.98,opacity:.86});
      set('interact',{x:.72,y:.78,size:.95,opacity:.86});
      set('fire',{x:.83,y:.58,size:.85,opacity:.55});
    }
  }
  return normalizeLayout({version:1,buttons});
}
