import {preferences} from './persistence.js';
import { AGENT_CATALOG, DEFAULT_AGENT_IDS, getAgent } from '../shared/agents.js';
import { AGENT_ASSETS } from '../shared/agent-assets.js';
import {AGENT_ARM_ASSETS} from '../shared/agent-arm-assets.js';
import {
  enforceUnlockedAgentLoadout,
  getAgentUnlockRequirement,
  evaluateRequirement,
} from '../shared/progression.js';
import { getSharedToyProgress } from './toy-cloud-progress.js';
import { loadAgent as loadAgentAsset, loadAgentArms } from './player-assets.js';
import './agents.css';
import {imageAssetURL} from './image-asset-url.js';

const STORAGE_KEY='dust2.agents.v1';
const TEAMS=[['CT','反恐精英'],['T','恐怖分子']];

export function readAgentLoadout(progressStore = null){
  const progress=(progressStore||getSharedToyProgress()).progress;
  try{
    const raw=JSON.parse(preferences.getItem(STORAGE_KEY)||'{}');
    const safe=enforceUnlockedAgentLoadout(raw,progress);
    if(raw?.CT!==safe.CT||raw?.T!==safe.T)preferences.setItem(STORAGE_KEY,JSON.stringify(safe));
    return safe;
  }catch{
    return {...DEFAULT_AGENT_IDS};
  }
}

/** Loading happens only after selecting a card, before the server equip callback. */
export class AgentMenu {
  constructor({onEquip=async()=>{},loadAgent=loadAgentAsset,loadArms=loadAgentArms,progressStore=null,onProgression=null}={}){
    this.store=progressStore||getSharedToyProgress();
    this.loadout=readAgentLoadout(this.store);
    this.onEquip=onEquip;this.loadAgent=loadAgent;this.loadArms=loadArms;this.onProgression=onProgression;
    this.busy=false;this.destroyed=false;this.activeTeam='CT';
    const modal=document.createElement('div');modal.id='agent-menu';modal.className='overlay';modal.hidden=true;
    modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');
    modal.setAttribute('aria-labelledby','agent-menu-title');
    modal.innerHTML=`<section class="agent-card">
      <header><h2 id="agent-menu-title">探员仓库</h2><div class="agent-header-actions">${onProgression?'<button class="agent-sub-btn" type="button" data-agent-open-prog>成长任务</button>':''}<button class="agent-close" type="button" aria-label="关闭探员仓库">完成 ×</button></div></header>
      <div class="agent-growth-bar"><div class="agent-growth-info" data-agent-growth-info></div><div class="agent-growth-actions"><button type="button" class="agent-social-btn" data-agent-verify-follow>关注解锁</button><button type="button" class="agent-social-btn agent-social-gold" data-agent-verify-triple>三连解锁</button></div></div>
      <div class="agent-teams"></div>
      <footer><progress class="agent-progress" max="100" hidden aria-label="探员下载进度"></progress><div class="agent-status" role="status" aria-live="polite"></div></footer>
    </section>`;
    document.body.append(modal);this.element=modal;
    modal.querySelector('.agent-close').onclick=()=>this.close();
    modal.querySelector('[data-agent-open-prog]')?.addEventListener('click',()=>{this.close();onProgression?.();});
    modal.querySelector('[data-agent-verify-follow]').onclick=()=>this.verifySocial('toy_follow');
    modal.querySelector('[data-agent-verify-triple]').onclick=()=>this.verifySocial('toy_triple');
    modal.addEventListener('keydown',event=>{
      if(event.code==='Escape'){event.preventDefault();event.stopPropagation();this.close();return;}
      if(event.code!=='Tab')return;
      const buttons=[...modal.querySelectorAll('button:not(:disabled)')];
      const first=buttons[0],last=buttons.at(-1);
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    });
    this._onStoreChange=()=>{
      this.loadout=readAgentLoadout(this.store);
      if(!this.element.hidden)this.render();
    };
    this.store.addEventListener('change',this._onStoreChange);
  }

  open(team){
    if(this.destroyed)return;
    this.loadout=readAgentLoadout(this.store);
    if(TEAMS.some(([id])=>id===team))this.activeTeam=team;
    this.previousFocus=document.activeElement;this.element.hidden=false;
    if(!this.busy)this.status('');
    this.render();
    this.element.querySelector('.agent-close').focus();
  }

  close(){
    this.element.hidden=true;
    if(this.previousFocus?.isConnected&&!this.previousFocus.closest('[hidden]'))this.previousFocus.focus?.({preventScroll:true});
  }

  status(text){this.element.querySelector('.agent-status').textContent=text;}

  setLoadout(loadout){this.loadout=enforceUnlockedAgentLoadout(loadout,this.store.progress);this.render();}

  async verifySocial(kind){
    if(this.busy||this.destroyed)return;
    this.busy=true;this.render();
    try{
      const res=kind==='toy_follow'?await this.store.verifyToyFollow():await this.store.verifyToyTriple();
      if(!this.destroyed)this.status(res.message||'校验完成');
    }finally{
      this.busy=false;if(!this.destroyed)this.render();
    }
  }

  render(){
    if(this.destroyed)return;
    const progress=this.store.progress;
    const summary=this.store.summary;
    this.element.querySelector('[data-agent-growth-info]').textContent=`已解锁 ${summary.agentsUnlocked} / ${summary.agentsTotal}`;
    const fBtn=this.element.querySelector('[data-agent-verify-follow]');
    const tBtn=this.element.querySelector('[data-agent-verify-triple]');
    if(fBtn){fBtn.textContent=progress.social.followed?'已关注':'关注解锁';fBtn.classList.toggle('done',progress.social.followed);fBtn.disabled=this.busy;}
    if(tBtn){tBtn.textContent=progress.social.tripled?'已三连':'三连解锁';tBtn.classList.toggle('done',progress.social.tripled);tBtn.disabled=this.busy;}

    const focusedAgent=this.element.contains(document.activeElement)?document.activeElement?.dataset?.agent:null;
    const teams=this.element.querySelector('.agent-teams');teams.replaceChildren();teams.setAttribute('aria-busy',String(this.busy));
    for(const [team,label]of TEAMS){
      const section=document.createElement('section');section.className='agent-team';section.dataset.team=team;
      section.classList.toggle('current-team',team===this.activeTeam);
      const heading=document.createElement('h3');heading.id=`agent-team-${team}`;heading.textContent=`${team} · ${label}`;
      section.setAttribute('aria-labelledby',heading.id);
      const grid=document.createElement('div');grid.className='agent-grid';
      for(const source of AGENT_CATALOG.filter(agent=>agent.team===team)){
        const agent={...source,...AGENT_ASSETS[source.id]};
        const req=getAgentUnlockRequirement(agent.id);
        const ev=evaluateRequirement(req,progress);
        const selected=this.loadout[team]===agent.id;
        const button=document.createElement('button');button.type='button';button.className='agent-item';button.dataset.agent=agent.id;
        button.classList.toggle('selected',selected);
        button.classList.toggle('locked',!ev.unlocked);
        button.disabled=this.busy;button.setAttribute('aria-pressed',String(selected));
        button.setAttribute('aria-label',`${label}：${agent.name}${selected?'，已装备':''}${!ev.unlocked?'，未解锁':''}`);
        button.title=agent.name;
        const visual=document.createElement('div');visual.className='agent-visual';
        const fallback=document.createElement('div');fallback.className='agent-placeholder';fallback.setAttribute('aria-hidden','true');
        const letters=document.createElement('strong');letters.textContent=team;
        fallback.append(letters);visual.append(fallback);
        const preview=typeof agent.preview==='string'?agent.preview:agent.preview?.file;
        if(preview){
          const image=document.createElement('img');image.alt='';image.loading='lazy';image.decoding='async';
          image.onload=()=>{fallback.hidden=true;};image.onerror=()=>{image.remove();};
          image.src=imageAssetURL(preview);visual.append(image);
        }
        const name=document.createElement('b');name.className='agent-name';
        const [character,unit]=agent.name.split(/\s*\|\s*|\s+·\s+/);
        name.textContent=agent.isDefault&&unit?unit:character;
        const note=document.createElement('small');note.className='agent-item-state';
        let state;
        if(!ev.unlocked){
          state=req?.type==='toy_follow'?'关注解锁':req?.type==='toy_triple'?'三连解锁':ev.progressText;
        }else{
          state=selected?'已装备':'装备';
        }
        for(const text of state.split(' · ')){
          const detail=document.createElement('span');detail.textContent=text;note.append(detail);
        }
        button.setAttribute('aria-description',state);
        button.append(visual,name,note);
        button.onclick=()=>this.equip(agent);grid.append(button);
      }
      section.append(heading,grid);teams.append(section);
    }
    if(focusedAgent){
      const replacement=[...teams.querySelectorAll('[data-agent]')].find(button=>button.dataset.agent===focusedAgent&&!button.disabled);
      (replacement||this.element.querySelector('.agent-close')).focus({preventScroll:true});
    }
  }

  async equip(value){
    const source=getAgent(typeof value==='string'?value:value?.id);
    if(this.busy||this.destroyed||!source)return;
    const req=getAgentUnlockRequirement(source.id);
    const ev=evaluateRequirement(req,this.store.progress);
    if(!ev.unlocked){
      if(req?.type==='toy_follow'||req?.type==='toy_triple'){
        await this.verifySocial(req.type);
        const recheck=evaluateRequirement(req,this.store.progress);
        if(!recheck.unlocked)return;
      }else{
        this.status(`「${source.name}」尚未解锁：需达成 ${req?.summary||ev.progressText}（当前：${ev.progressText}）。`);
        return;
      }
    }
    const agent={...source,...AGENT_ASSETS[source.id]};this.busy=true;this.activeTeam=agent.team;this.render();
    const progress=this.element.querySelector('.agent-progress');progress.hidden=false;progress.removeAttribute('value');
    this.status(`准备 ${agent.name}…`);
    try{
      const arms=AGENT_ARM_ASSETS[agent.id];
      const total=agent.bytes+arms.bytes;
      const report=(previous,limit,label)=>update=>{
        if(this.destroyed)return;
        const received=typeof update==='number'?update:Number(update?.bytes??update?.loaded)||0;
        const percent=Math.round(100*(previous+Math.max(0,Math.min(limit,received)))/total);
        progress.value=percent;
        this.status(`${update?.cached?'读取本机缓存':'准备'}${label} · ${percent}%`);
      };
      await this.loadAgent(agent.id,{onProgress:report(0,agent.bytes,'探员模型')});
      if(this.destroyed)return;
      await this.loadArms(agent.id,{onProgress:report(agent.bytes,arms.bytes,'第一人称手臂')});
      if(this.destroyed)return;
      progress.value=100;this.status(`正在装备 ${agent.name}…`);
      const next=enforceUnlockedAgentLoadout({...this.loadout,[agent.team]:agent.id},this.store.progress);
      await this.onEquip(agent,next);
      if(this.destroyed)return;
      this.loadout=next;
      let saved=true;try{preferences.setItem(STORAGE_KEY,JSON.stringify(next));}catch{saved=false;}
      this.store.noteLoadoutChanged();
      this.status(saved?`已装备 ${agent.name}（已自动同步到存档）。`:`已装备 ${agent.name}。浏览器未能保存选择，下次进入需重新选择。`);
    }catch(error){
      if(!this.destroyed)this.status(`未能装备：${error?.message||'下载或连接失败'}。点击探员可重试。`);
    }finally{
      this.busy=false;progress.hidden=true;if(!this.destroyed)this.render();
    }
  }

  destroy(){
    this.destroyed=true;
    this.store.removeEventListener('change',this._onStoreChange);
    this.element.remove();
  }
}
