import { MinHeap } from '../shared/min-heap.js';

/** Private map AI adapter. Uses the map's own NAV, never Dust II coordinates.
 * Collision-validated edges are supplied by the preview validator. No known
 * valid path means no move order, rather than a direct line through a wall.
 */
export class MapTacticalGraph {
  constructor(map, areas, {edgeAllowed=()=>false, standAllowed=()=>false}={}) {
    this.map=map;
    this.nodes=areas instanceof Map?areas:new Map(areas.filter(a=>a.hull===0).map(a=>[a.id,a]));
    this.edgeAllowed=edgeAllowed;
    this.standAllowed=standAllowed;
    this._standNodes=null;
    this._guardsCache=new Map();
  }
  nearest(point) {
    if(!this._standNodes){
      const list=[];
      for(const a of this.nodes.values())if(this.standAllowed(a))list.push(a);
      this._standNodes=list;
    }
    const px=point.x,py=point.y,pz=point.z,list=this._standNodes;
    let best=null, bestSq=Infinity;
    for(let i=0;i<list.length;i++) {
      const a=list[i];
      // Vertical distance must count, especially on Nuke. Do not snap to a
      // floor directly overhead because its horizontal distance is shorter.
      const dx=px-a.x,dy=2*(py-a.y),dz=pz-a.z,sq=dx*dx+dy*dy+dz*dz;
      if(sq<bestSq){best=a;bestSq=sq;}
    }
    return best;
  }
  route(start, end, {penalties=null, maxVisited=12000}={}) {
    const from=typeof start==='number'?this.nodes.get(start):this.nearest(start);
    const to=typeof end==='number'?this.nodes.get(end):this.nearest(end);
    if(!from||!to||!this.standAllowed(from)||!this.standAllowed(to))return null;
    const toX=to.x,toY=to.y,toZ=to.z,hasPenalties=!!(penalties&&penalties.size);
    const scores=new Map([[from.id,0]]),parent=new Map(),closed=new Set(),open=new MinHeap();
    const fdx=from.x-toX,fdy=from.y-toY,fdz=from.z-toZ;
    open.push({id:from.id,cost:Math.sqrt(fdx*fdx+fdy*fdy+fdz*fdz)});
    let visited=0;
    while(open.size&&visited<maxVisited) {
      const current=open.pop().id;
      if(closed.has(current))continue;
      closed.add(current);
      visited++;
      if(current===to.id){const path=[];for(let id=current;id!==undefined;id=parent.get(id))path.push(this.nodes.get(id));return path.reverse();}
      const a=this.nodes.get(current),base=scores.get(current),ax=a.x,ay=a.y,az=a.z,neighbors=a.neighbors;
      for(let i=0;i<neighbors.length;i++) {
        const id=neighbors[i];
        if(closed.has(id))continue;
        const b=this.nodes.get(id);
        if(!b||!this.standAllowed(b)||!this.edgeAllowed(a,b))continue;
        const dx=ax-b.x,dy=ay-b.y,dz=az-b.z;
        const cost=base+Math.sqrt(dx*dx+dy*dy+dz*dz)+(hasPenalties?(penalties.get(id)||0):0);
        if(cost>=(scores.get(id)??Infinity))continue;
        scores.set(id,cost);parent.set(id,current);
        const hdx=b.x-toX,hdy=b.y-toY,hdz=b.z-toZ;
        open.push({id,cost:cost+Math.sqrt(hdx*hdx+hdy*hdy+hdz*hdz)});
      }
    }
    return null;
  }
  alternatives(start,end,count=3,{firstPath=null}={}) {
    const from=typeof start==='number'?this.nodes.get(start):this.nearest(start);
    const to=typeof end==='number'?this.nodes.get(end):this.nearest(end);
    if(!from||!to)return [];
    const paths=[],penalties=new Map();
    for(let i=0;i<count;i++){
      const p=i===0&&firstPath?firstPath:this.route(from.id,to.id,{penalties});
      if(!p||paths.some(old=>old.length===p.length&&old.every((n,idx)=>n.id===p[idx].id)))break;
      paths.push(p);
      for(let j=1;j<p.length-1;j++){const id=p[j].id;penalties.set(id,(penalties.get(id)||0)+8);}
    }
    return paths;
  }
  guards(site, round=0, count=5) {
    const target=this.map.sites[site];
    if(!target)return [];
    const cacheKey=`${site}:${round}:${count}`;
    const cached=this._guardsCache.get(cacheKey);
    if(cached)return cached;
    const candidates=[];
    for(const a of this.nodes.values()){
      if(this.standAllowed(a)&&Math.abs(a.y-target.y)<2.2&&Math.hypot(a.x-target.x,a.z-target.z)<15)candidates.push(a);
    }
    candidates.sort((a,b)=>((a.id*31+round*79)%997)-((b.id*31+round*79)%997));
    const targetNode=this.nearest(target);
    if(!targetNode)return [];
    const chosen=[];
    for(const p of candidates){if(chosen.every(a=>Math.hypot(a.x-p.x,a.z-p.z)>2.5)&&this.route(p.id,targetNode.id))chosen.push(p);if(chosen.length===count)break;}
    if(this._guardsCache.size>=64)this._guardsCache.clear();
    this._guardsCache.set(cacheKey,chosen);
    return chosen;
  }
}

export function planMapRound(graph,{players,round=1,previousSite=null,eco=false}={}) {
  const bots=players.filter(p=>p.bot&&!p.controlledBy&&!p.controllerId&&p.alive!==false);
  const site=previousSite==='A'?'B':previousSite==='B'?'A':round%2?'A':'B';
  const attacks=bots.filter(p=>p.team==='T'),defenders=bots.filter(p=>p.team==='CT');
  const orders=[];
  const alternatives=attacks.length?graph.alternatives(attacks[0],graph.map.sites[site]):[];
  for(let i=0;i<attacks.length;i++){
    const p=attacks[i],preferred=alternatives[eco?0:i%Math.max(1,alternatives.length)];
    const path=preferred&&graph.route(p,preferred[0]);
    orders.push({playerId:p.id,site,role:i===0?'entry':i===1?'trade':i===2?'carrier':'support',
      path:path?[...path,...preferred.slice(1)]:[],state:path?'advance':'await-valid-route',
      // Tactical intent is separate from a verified lineup. No blind throws.
      utility:[],minTradeGap:1.5,maxTradeGap:4});
  }
  for(let i=0;i<defenders.length;i++){
    const p=defenders[i],hold=i%2?'B':'A',positions=graph.guards(hold,round,defenders.length),goal=positions[Math.floor(i/2)]||null;
    const path=goal&&graph.route(p,goal);
    orders.push({playerId:p.id,site:hold,role:i<2?'anchor':'rotator',path:path||[],state:path?'defend':'await-valid-route',utility:[]});
  }
  return {map:graph.map.id,round,site,tempo:eco?'contact':'split',orders};
}

export function verifiedUtility(profile, {sourceSha256,physicsSha256}={}) {
  // A strategy description or an old CS:GO lineup is not trajectory evidence.
  return (profile?.lineups||[]).filter(p=>p.validation?.passed===true&&p.validation.sourceSha256===sourceSha256&&p.validation.physicsSha256===physicsSha256&&p.release&&p.target);
}

/** Route through the actual shared NAV edge, not the centre-to-centre chord
 * which can cut the corner of two convex navigation polygons. */
export function navigationPortal(a,b) {
  const edge=a.portals?.find(p=>p.to===b.id);
  if(!edge)return null;
  const p=edge.a,q=edge.b,dx=q[0]-p[0],dz=q[2]-p[2],length2=dx*dx+dz*dz;
  if(length2<1e-8)return null;
  const reverse=b.portals?.find(p=>p.to===a.id);
  let lo=0,hi=1;
  if(reverse){
    const along=v=>((v[0]-p[0])*dx+(v[2]-p[2])*dz)/length2;
    const side=v=>Math.abs((v[0]-p[0])*dz-(v[2]-p[2])*dx)/Math.sqrt(length2);
    if(side(reverse.a)<.06&&side(reverse.b)<.06){lo=Math.max(0,Math.min(along(reverse.a),along(reverse.b)));hi=Math.min(1,Math.max(along(reverse.a),along(reverse.b)));}
  }
  if(hi<lo)return null;
  const t=(lo+hi)/2;
  return{x:p[0]+dx*t,y:p[1]+(q[1]-p[1])*t,z:p[2]+dz*t,width:Math.sqrt(length2)*(hi-lo)};
}
