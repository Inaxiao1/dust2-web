import {preferences} from './persistence.js';
import { SKINS, DEFAULT_SKINS } from '../shared/skins.js';
import { getWeapon } from '../shared/weapons.js';
import {
  STARTER_SKINS,
  enforceUnlockedSkinLoadout,
  getSkinUnlockRequirement,
  evaluateRequirement,
} from '../shared/progression.js';
import { getSharedToyProgress } from './toy-cloud-progress.js';
import { loadSkin,skinSaved,downloadSkin } from './skin-assets.js';
import './skins.css';
import {skinPreviewURL} from './skin-preview.js';
import {imageAssetURL} from './image-asset-url.js';
import {filterSkins} from './skin-library.js';
import {savedCatalogAssets} from './loading.js';

const pageSize=24;
const catalogFiles=SKINS.flatMap(skin=>skin.animation?[skin,skin.animation]:[skin]);

export function readSkinLoadout(progressStore = null){
  const key='dust2.skins.v1',saved=preferences.readJSON(key);
  const progress=(progressStore||getSharedToyProgress()).progress;
  const loadout=enforceUnlockedSkinLoadout(saved,progress);
  if(Object.keys(saved).some(weapon=>saved[weapon]!==loadout[weapon])||!Object.keys(saved).length)
    preferences.setItem(key,JSON.stringify(loadout));
  return loadout;
}

export class SkinMenu{
  constructor({onEquip,onLoadout=()=>{},onProgression=null,progressStore=null}){
    this.store=progressStore||getSharedToyProgress();
    this.loadout=readSkinLoadout(this.store);
    this.weapon='all';this.category='all';this.query='';this.availability='all';
    this.onEquip=onEquip;this.onProgression=onProgression;
    this.busy=false;this.downloaded=new Set();this.scan=null;this.limit=pageSize;

    const modal=document.createElement('div');modal.className='overlay';modal.id='skin-menu';modal.hidden=true;
    modal.innerHTML=`<section class="skin-card"><header><h2>皮肤库</h2><div class="skin-tabs"><button data-open-loadout>装备携带</button>${onProgression?'<button data-open-progression>成长任务</button>':''}</div><button id="close-skins">返回 ×</button></header><div class="skin-growth-bar"><div class="skin-growth-info" data-skin-growth-info></div><div class="skin-growth-actions"><button type="button" class="skin-social-btn" data-skin-verify-follow>关注解锁</button><button type="button" class="skin-social-btn skin-social-gold" data-skin-verify-triple>三连解锁</button></div></div><div class="skin-toolbar"><input type="search" placeholder="搜索武器或皮肤" aria-label="搜索皮肤"><select aria-label="武器分类" data-skin-category><option value="all">全部分类</option><option value="pistols">手枪</option><option value="mid">中级</option><option value="rifles">步枪</option><option value="melee">近战武器</option></select><select aria-label="皮肤筛选" data-skin-availability><option value="all">全部皮肤</option><option value="unlocked">已解锁</option><option value="vanilla">原厂基础</option><option value="growth">成长任务</option><option value="toy_follow">关注解锁</option><option value="toy_triple">三连解锁</option><option value="equipped">已装备</option><option value="saved">已下载</option></select><span class="skin-count"></span></div><div class="skin-body"><nav aria-label="武器筛选"><button data-skin-weapon="all">全部武器</button>${Object.keys(DEFAULT_SKINS).map(id=>`<button data-skin-weapon="${id}">${id==='knife'?'近战匕首':getWeapon(id).name}</button>`).join('')}</nav><div class="skin-results"><div id="skin-grid" class="skin-grid"></div></div></div><footer><span><a class="full-skin-list" href="${imageAssetURL('assets/weapons/cs2-skins/library/index.html')}" target="_blank" rel="noopener">完整清单 ↗</a></span><div class="skin-status" role="status"></div></footer></section>`;
    document.body.append(modal);this.element=modal;
    this.grid=modal.querySelector('#skin-grid');
    this.more=document.createElement('button');this.more.type='button';this.more.dataset.moreSkins='';this.more.textContent='显示更多皮肤';this.more.hidden=true;
    this.grid.after(this.more);
    const showMore=()=>{if(!this.element.hidden&&!this.more.hidden){this.limit+=pageSize;this.render();}};
    this.more.onclick=showMore;
    if(typeof IntersectionObserver==='function'){
      this.pages=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting))showMore();},{root:modal.querySelector('.skin-results'),rootMargin:'80px'});
    }
    modal.querySelector('#close-skins').onclick=()=>this.close();
    modal.querySelector('[data-open-loadout]').onclick=()=>{this.close();onLoadout();};
    modal.querySelector('[data-open-progression]')?.addEventListener('click',()=>{this.close();onProgression?.();});
    modal.querySelector('[data-skin-verify-follow]').onclick=()=>this.verifySocial('toy_follow');
    modal.querySelector('[data-skin-verify-triple]').onclick=()=>this.verifySocial('toy_triple');

    const searchInput=modal.querySelector('input[type=search]');
    if(searchInput){searchInput.hidden=true;searchInput.oninput=e=>{this.query=e.target.value;this.resetPage();};}
    const categorySel=modal.querySelector('[data-skin-category]');
    const availSel=modal.querySelector('[data-skin-availability]');
    categorySel.onchange=e=>{this.category=e.target.value;this.weapon='all';this.resetPage();};
    availSel.onchange=e=>{this.availability=e.target.value;this.resetPage();};
    modal.addEventListener('keydown',e=>{if(e.code==='Escape'){this.close();e.preventDefault();}});
    modal.querySelectorAll('[data-skin-weapon]').forEach(b=>b.onclick=()=>{this.weapon=b.dataset.skinWeapon;this.category='all';categorySel.value='all';this.resetPage();});

    this.store.addEventListener('change',()=>{
      this.loadout=readSkinLoadout(this.store);
      if(!this.element.hidden)this.render();
    });
  }
  resetPage(){this.limit=pageSize;this.element.querySelector('.skin-results').scrollTop=0;this.render();}
  open(){this.loadout=readSkinLoadout(this.store);this.element.hidden=false;this.resetPage();this.pages?.observe(this.more);this.refreshDownloads();this.element.querySelector('#close-skins').focus();}
  async refreshDownloads(){
    this.scan?.abort();
    const scan=new AbortController();this.scan=scan;
    const addedWhileScanning=new Set();this.addedWhileScanning=addedWhileScanning;
    try{
      const hashes=await savedCatalogAssets(catalogFiles,scan.signal);
      if(scan.signal.aborted)return;
      const saved=new Set(SKINS.filter(skin=>hashes.has(skin.sha256)&&(!skin.animation||hashes.has(skin.animation.sha256))).map(skin=>skin.id));
      for(const id of addedWhileScanning)saved.add(id);
      this.downloaded=saved;
      this.render();
    }catch{/* Keep the previous download state when the installed manifest is unavailable. */}
    finally{if(this.scan===scan){this.scan=null;this.addedWhileScanning=null;}}
  }
  close(){this.element.hidden=true;this.scan?.abort();this.pages?.disconnect();}
  status(text){this.element.querySelector('.skin-status').textContent=text;}
  async verifySocial(kind){
    if(this.busy)return;
    this.busy=true;this.render();
    try{
      const res=kind==='toy_follow'?await this.store.verifyToyFollow():await this.store.verifyToyTriple();
      this.status(res.message||'已完成校验');
    }finally{
      this.busy=false;this.render();
    }
  }
  card(skin){
    const button=document.createElement('button');button.className='skin-item';button.type='button';
    const image=document.createElement('img');image.loading='lazy';image.decoding='async';image.alt='';image.src=skinPreviewURL(skin);
    const weaponName=skin.weapon==='knife'?'匕首':getWeapon(skin.weapon).name;
    const stock=skin.name==='原厂涂装';
    const name=document.createElement('b');name.textContent=stock?weaponName:skin.name;
    const detail=document.createElement('span');detail.className='skin-item-detail';
    const condition=({'Factory New':'崭新出厂','Field-Tested':'久经沙场','Minimal Wear':'略有磨损'})[skin.condition];
    detail.textContent=stock?skin.name:[weaponName,condition].filter(Boolean).join(' · ');
    const label=document.createElement('small');
    button.dataset.skinId=skin.id;
    button.append(image,name,detail,label);
    button.onclick=()=>this.equip(skin);
    return button;
  }
  render(){
    if(this.element.hidden)return;
    const progress=this.store.progress;
    const summary=this.store.summary;
    const growthInfo=this.element.querySelector('[data-skin-growth-info]');
    if(growthInfo){
      growthInfo.textContent=`已解锁 ${summary.skinsUnlocked} / ${summary.skinsTotal}`;
    }
    const fBtn=this.element.querySelector('[data-skin-verify-follow]');
    const tBtn=this.element.querySelector('[data-skin-verify-triple]');
    if(fBtn){fBtn.textContent=progress.social.followed?'已关注':'关注解锁';fBtn.classList.toggle('done',progress.social.followed);fBtn.disabled=this.busy;}
    if(tBtn){tBtn.textContent=progress.social.tripled?'已三连':'三连解锁';tBtn.classList.toggle('done',progress.social.tripled);tBtn.disabled=this.busy;}

    this.element.querySelectorAll('[data-skin-weapon]').forEach(b=>b.classList.toggle('selected',b.dataset.skinWeapon===this.weapon));
    const visible=filterSkins({...this,progress});
    // Sort: equipped first -> unlocked -> closest-to-unlock locked -> social locked
    visible.sort((a,b)=>{
      const eqA=this.loadout[a.weapon]===a.id?1:0, eqB=this.loadout[b.weapon]===b.id?1:0;
      if(eqA!==eqB)return eqB-eqA;
      const evA=evaluateRequirement(getSkinUnlockRequirement(a.id),progress);
      const evB=evaluateRequirement(getSkinUnlockRequirement(b.id),progress);
      if(evA.unlocked!==evB.unlocked)return evB.unlocked?1:-1;
      return evB.pct-evA.pct;
    });
    this.element.querySelector('.skin-count').textContent=`${visible.length} 件`;
    this.more.hidden=visible.length<=this.limit;
    if(!visible.length){
      if(!this.grid.querySelector('.skin-empty')){
        const empty=document.createElement('p');empty.className='skin-empty';empty.textContent='没有符合筛选条件的皮肤';this.grid.replaceChildren(empty);
      }
      return;
    }
    const shown=visible.slice(0,this.limit);
    const ids=new Set(shown.map(skin=>skin.id)),cards=new Map();
    for(const button of Array.from(this.grid.children)){
      if(ids.has(button.dataset.skinId))cards.set(button.dataset.skinId,button);
      else button.remove();
    }
    let cursor=this.grid.firstChild;
    for(const skin of shown){
      const button=cards.get(skin.id)||this.card(skin);
      if(button!==cursor)this.grid.insertBefore(button,cursor);
      cursor=button.nextSibling;
      const req=getSkinUnlockRequirement(skin.id);
      const ev=evaluateRequirement(req,progress);
      const selected=this.loadout[skin.weapon]===skin.id;
      button.classList.toggle('selected',selected);
      button.classList.toggle('locked',!ev.unlocked);
      button.dataset.unlockType=req?.type||'starter';
      if(button.disabled!==this.busy)button.disabled=this.busy;
      if(button.getAttribute('aria-pressed')!==String(selected))button.setAttribute('aria-pressed',String(selected));

      let text;
      if(!ev.unlocked){
        text=req?.type==='toy_follow'?'关注解锁':req?.type==='toy_triple'?'三连解锁':ev.progressText;
      }else{
        text=selected?'已装备':this.downloaded.has(skin.id)?'装备':`下载 ${((skin.bytes+(skin.animation?.bytes||0))/1048576).toFixed(1)} MB`;
      }
      if(button.lastElementChild.textContent!==text)button.lastElementChild.textContent=text;
    }
  }
  markSaved(id){this.downloaded.add(id);this.addedWhileScanning?.add(id);}
  async equip(skin){
    if(this.busy)return;
    const req=getSkinUnlockRequirement(skin.id);
    const ev=evaluateRequirement(req,this.store.progress);
    if(!ev.unlocked){
      if(req?.type==='toy_follow'||req?.type==='toy_triple'){
        await this.verifySocial(req.type);
        const recheck=evaluateRequirement(req,this.store.progress);
        if(!recheck.unlocked)return;
      }else{
        this.status(`「${skin.name}」尚未解锁：需达成 ${req?.summary||ev.progressText}（当前：${ev.progressText}）。`);
        return;
      }
    }
    this.busy=true;this.render();this.status(`准备 ${skin.name}…`);
    try{
      if(skin.downloadRequired&&!await skinSaved(skin)){const saved=await downloadSkin(skin,{onProgress:p=>this.status(`正在下载 ${skin.name} · ${((p?.loaded||p?.bytes||0)/1048576).toFixed(1)} MB`)});if(!saved)throw Error('浏览器未能保存资源，请释放本地存储空间后重试');this.markSaved(skin.id);}
      await loadSkin(skin.id,{onProgress:p=>{const bytes=typeof p==='number'?p:p?.bytes||p?.loaded||0;this.status(`下载 ${skin.name} · ${Math.min(100,Math.round(bytes/skin.bytes*100))}%`);}});
      const next=enforceUnlockedSkinLoadout({...this.loadout,[skin.weapon]:skin.id},this.store.progress);
      await this.onEquip(skin,next);
      this.loadout=next;preferences.setItem('dust2.skins.v1',JSON.stringify(this.loadout));
      this.store.noteLoadoutChanged();
      if(await skinSaved(skin))this.markSaved(skin.id);
      this.status(`已装备 ${skin.name}（已自动同步到存档）。`);
    }catch(error){this.status(`未能装备：${error.message}。点击皮肤可重试。`);}
    finally{this.busy=false;this.render();}
  }
}

export { STARTER_SKINS };
