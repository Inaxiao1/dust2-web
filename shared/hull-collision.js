import {Vector3} from 'three';

/** Triangle/AABB separating-axis contact. A flat sole stays supported at ledges;
 * the rounded end of the old capsule could slide off and alternate grounded. */
export class HullContact {
 constructor(){this.axes=Array.from({length:13},()=>new Vector3());this.center=new Vector3();this.half=new Vector3();this.edges=Array.from({length:3},()=>new Vector3());this.surface=new Vector3();}
 sweepDown(tri,box,maxDrop){
  const bMinX=box.min.x,bMinY=box.min.y,bMinZ=box.min.z;
  const bMaxX=box.max.x,bMaxY=box.max.y,bMaxZ=box.max.z;
  const a=tri.a,b=tri.b,c=tri.c;
  const ax=a.x,bx=b.x,cx=c.x;
  const minX=ax<bx?(ax<cx?ax:cx):(bx<cx?bx:cx);
  const maxX=ax>bx?(ax>cx?ax:cx):(bx>cx?bx:cx);
  if(minX>=bMaxX-1e-8||maxX<=bMinX+1e-8)return null;
  const az=a.z,bz=b.z,cz=c.z;
  const minZ=az<bz?(az<cz?az:cz):(bz<cz?bz:cz);
  const maxZ=az>bz?(az>cz?az:cz):(bz>cz?bz:cz);
  if(minZ>=bMaxZ-1e-8||maxZ<=bMinZ+1e-8)return null;
  const ay=a.y,by=b.y,cy=c.y;
  const minY=ay<by?(ay<cy?ay:cy):(by<cy?by:cy);
  const maxY=ay>by?(ay>cy?ay:cy):(by>cy?by:cy);
  const loY=minY-bMaxY,hiY=maxY-bMinY,speedY=-maxDrop;
  let firstY=-Infinity,lastY=1,hasYSlab=false;
  if(Math.abs(speedY)<1e-10){
   if(loY>=-1e-8||hiY<=1e-8)return null;
  }else{
   const t0=loY/speedY,t1=hiY/speedY;
   firstY=t0<t1?t0:t1;lastY=t0>t1?t0:t1;
   if(firstY>1||lastY<0||firstY>lastY+1e-8)return null;
   hasYSlab=true;
  }
  const e0x=bx-ax,e0y=by-ay,e0z=bz-az;
  const e1x=cx-bx,e1y=cy-by,e1z=cz-bz;
  let sx=e0y*e1z-e0z*e1y,sy=e0z*e1x-e0x*e1z,sz=e0x*e1y-e0y*e1x;
  const sLenSq=sx*sx+sy*sy+sz*sz;
  if(sLenSq>0){const inv=1/Math.sqrt(sLenSq);sx*=inv;sy*=inv;sz*=inv;}
  const midX=(bMinX+bMaxX)*.5,midY=(bMinY+bMaxY)*.5,midZ=(bMinZ+bMaxZ)*.5;
  const hX=(bMaxX-bMinX)*.5,hY=(bMaxY-bMinY)*.5,hZ=(bMaxZ-bMinZ)*.5;
  let enter=-Infinity,exit=1,normalY=0;
  // Axis 0: triangle face normal
  if(sLenSq>0){
   const center=sx*midX+sy*midY+sz*midZ;
   const radius=Math.abs(sx)*hX+Math.abs(sy)*hY+Math.abs(sz)*hZ;
   const pa=sx*ax+sy*ay+sz*az,pb=sx*bx+sy*by+sz*bz,pc=sx*cx+sy*cy+sz*cz;
   const lo=(pa<pb?(pa<pc?pa:pc):(pb<pc?pb:pc))-radius-center;
   const hi=(pa>pb?(pa>pc?pa:pc):(pb>pc?pb:pc))+radius-center;
   const speed=-maxDrop*sy;
   if(Math.abs(speed)<1e-10){if(lo>=-1e-8||hi<=1e-8)return null;}
   else{
    const t0=lo/speed,t1=hi/speed,first=t0<t1?t0:t1,last=t0>t1?t0:t1;
    if(first>enter){enter=first;normalY=speed<0?sy:-sy;}
    if(last<exit)exit=last;
    if(enter>exit+1e-8)return null;
   }
  }
  // Axis 1: (0, 1, 0) (Axes 2 & 3 have speed=0 and already passed AABB check)
  if(hasYSlab){
   if(firstY>enter){enter=firstY;normalY=speedY<0?1:-1;}
   if(lastY<exit)exit=lastY;
   if(enter>exit+1e-8)return null;
  }
  // Axes 4..12: edge cross-products with X, Y, Z
  const e2x=ax-cx,e2y=ay-cy,e2z=az-cz;
  for(let i=0;i<3;i++){
   const ex=i===0?e0x:i===1?e1x:e2x;
   const ey=i===0?e0y:i===1?e1y:e2y;
   const ez=i===0?e0z:i===1?e1z:e2z;
   // (0, ez, -ey)
   let l2=ez*ez+ey*ey;
   if(l2>=1e-20){
    const inv=1/Math.sqrt(l2),ny=ez*inv,nz=-ey*inv;
    const center=ny*midY+nz*midZ,radius=Math.abs(ny)*hY+Math.abs(nz)*hZ;
    const pa=ny*ay+nz*az,pb=ny*by+nz*bz,pc=ny*cy+nz*cz;
    const lo=(pa<pb?(pa<pc?pa:pc):(pb<pc?pb:pc))-radius-center;
    const hi=(pa>pb?(pa>pc?pa:pc):(pb>pc?pb:pc))+radius-center;
    const speed=-maxDrop*ny;
    if(Math.abs(speed)<1e-10){if(lo>=-1e-8||hi<=1e-8)return null;}
    else{
     const t0=lo/speed,t1=hi/speed,first=t0<t1?t0:t1,last=t0>t1?t0:t1;
     if(first>enter){enter=first;normalY=speed<0?ny:-ny;}
     if(last<exit)exit=last;
     if(enter>exit+1e-8)return null;
    }
   }
   // (-ez, 0, ex) -> ny=0 so speed=0
   l2=ez*ez+ex*ex;
   if(l2>=1e-20){
    const inv=1/Math.sqrt(l2),nx=-ez*inv,nz=ex*inv;
    const center=nx*midX+nz*midZ,radius=Math.abs(nx)*hX+Math.abs(nz)*hZ;
    const pa=nx*ax+nz*az,pb=nx*bx+nz*bz,pc=nx*cx+nz*cz;
    const lo=(pa<pb?(pa<pc?pa:pc):(pb<pc?pb:pc))-radius-center;
    const hi=(pa>pb?(pa>pc?pa:pc):(pb>pc?pb:pc))+radius-center;
    if(lo>=-1e-8||hi<=1e-8)return null;
   }
   // (ey, -ex, 0)
   l2=ey*ey+ex*ex;
   if(l2>=1e-20){
    const inv=1/Math.sqrt(l2),nx=ey*inv,ny=-ex*inv;
    const center=nx*midX+ny*midY,radius=Math.abs(nx)*hX+Math.abs(ny)*hY;
    const pa=nx*ax+ny*ay,pb=nx*bx+ny*by,pc=nx*cx+ny*cy;
    const lo=(pa<pb?(pa<pc?pa:pc):(pb<pc?pb:pc))-radius-center;
    const hi=(pa>pb?(pa>pc?pa:pc):(pb>pc?pb:pc))+radius-center;
    const speed=-maxDrop*ny;
    if(Math.abs(speed)<1e-10){if(lo>=-1e-8||hi<=1e-8)return null;}
    else{
     const t0=lo/speed,t1=hi/speed,first=t0<t1?t0:t1,last=t0>t1?t0:t1;
     if(first>enter){enter=first;normalY=speed<0?ny:-ny;}
     if(last<exit)exit=last;
     if(enter>exit+1e-8)return null;
    }
   }
  }
  if(enter<-.00001||enter>1||exit<0)return null;
  return {distance:Math.max(0,enter)*maxDrop,walkable:Math.abs(sy)>=.7&&normalY>=.7};
 }
 intersect(tri,box){
  const bMinX=box.min.x,bMinY=box.min.y,bMinZ=box.min.z;
  const bMaxX=box.max.x,bMaxY=box.max.y,bMaxZ=box.max.z;
  const a=tri.a,b=tri.b,c=tri.c;
  const ax=a.x,bx=b.x,cx=c.x;
  const minX=ax<bx?(ax<cx?ax:cx):(bx<cx?bx:cx);
  const maxX=ax>bx?(ax>cx?ax:cx):(bx>cx?bx:cx);
  const posX=maxX-bMinX,negX=bMaxX-minX;
  if(posX<=1e-8||negX<=1e-8)return null;
  const ay=a.y,by=b.y,cy=c.y;
  const minY=ay<by?(ay<cy?ay:cy):(by<cy?by:cy);
  const maxY=ay>by?(ay>cy?ay:cy):(by>cy?by:cy);
  const posY=maxY-bMinY,negY=bMaxY-minY;
  if(posY<=1e-8||negY<=1e-8)return null;
  const az=a.z,bz=b.z,cz=c.z;
  const minZ=az<bz?(az<cz?az:cz):(bz<cz?bz:cz);
  const maxZ=az>bz?(az>cz?az:cz):(bz>cz?bz:cz);
  const posZ=maxZ-bMinZ,negZ=bMaxZ-minZ;
  if(posZ<=1e-8||negZ<=1e-8)return null;

  const e0x=bx-ax,e0y=by-ay,e0z=bz-az;
  const e1x=cx-bx,e1y=cy-by,e1z=cz-bz;
  let sx=e0y*e1z-e0z*e1y,sy=e0z*e1x-e0x*e1z,sz=e0x*e1y-e0y*e1x;
  const sLenSq=sx*sx+sy*sy+sz*sz;
  const midX=(bMinX+bMaxX)*.5,midY=(bMinY+bMaxY)*.5,midZ=(bMinZ+bMaxZ)*.5;
  const hX=(bMaxX-bMinX)*.5,hY=(bMaxY-bMinY)*.5,hZ=(bMaxZ-bMinZ)*.5;
  let depth=Infinity,bestX=0,bestY=0,bestZ=0,hasBest=false,sign=1;
  // Axis 0: triangle face normal (evaluated first to preserve exact tie-breaking order)
  if(sLenSq>0){
   const inv=1/Math.sqrt(sLenSq);sx*=inv;sy*=inv;sz*=inv;
   const center=sx*midX+sy*midY+sz*midZ;
   const radius=Math.abs(sx)*hX+Math.abs(sy)*hY+Math.abs(sz)*hZ;
   const pa=sx*ax+sy*ay+sz*az,pb=sx*bx+sy*by+sz*bz,pc=sx*cx+sy*cy+sz*cz;
   const min0=pa<pb?(pa<pc?pa:pc):(pb<pc?pb:pc);
   const max0=pa>pb?(pa>pc?pa:pc):(pb>pc?pb:pc);
   const pos0=max0-center+radius,neg0=center+radius-min0;
   if(pos0<=1e-8||neg0<=1e-8)return null;
   depth=pos0<neg0?pos0:neg0;bestX=sx;bestY=sy;bestZ=sz;hasBest=true;sign=pos0<neg0?1:-1;
  }
  // Axis 1: (0, 1, 0), Axis 2: (1, 0, 0), Axis 3: (0, 0, 1)
  const ovY=posY<negY?posY:negY;
  if(ovY<depth-1e-7){depth=ovY;bestX=0;bestY=1;bestZ=0;hasBest=true;sign=posY<negY?1:-1;}
  const ovX=posX<negX?posX:negX;
  if(ovX<depth-1e-7){depth=ovX;bestX=1;bestY=0;bestZ=0;hasBest=true;sign=posX<negX?1:-1;}
  const ovZ=posZ<negZ?posZ:negZ;
  if(ovZ<depth-1e-7){depth=ovZ;bestX=0;bestY=0;bestZ=1;hasBest=true;sign=posZ<negZ?1:-1;}
  // Axes 4..12: edge cross-products with X, Y, Z
  const e2x=ax-cx,e2y=ay-cy,e2z=az-cz;
  for(let i=0;i<3;i++){
   const ex=i===0?e0x:i===1?e1x:e2x;
   const ey=i===0?e0y:i===1?e1y:e2y;
   const ez=i===0?e0z:i===1?e1z:e2z;
   // (0, ez, -ey)
   let l2=ez*ez+ey*ey;
   if(l2>=1e-20){
    const inv=1/Math.sqrt(l2),ny=ez*inv,nz=-ey*inv;
    const center=ny*midY+nz*midZ,radius=Math.abs(ny)*hY+Math.abs(nz)*hZ;
    const pa=ny*ay+nz*az,pb=ny*by+nz*bz,pc=ny*cy+nz*cz;
    const minP=pa<pb?(pa<pc?pa:pc):(pb<pc?pb:pc);
    const maxP=pa>pb?(pa>pc?pa:pc):(pb>pc?pb:pc);
    const pos=maxP-center+radius,neg=center+radius-minP;
    if(pos<=1e-8||neg<=1e-8)return null;
    const ov=pos<neg?pos:neg;
    if(ov<depth-1e-7){depth=ov;bestX=0;bestY=ny;bestZ=nz;hasBest=true;sign=pos<neg?1:-1;}
   }
   // (-ez, 0, ex)
   l2=ez*ez+ex*ex;
   if(l2>=1e-20){
    const inv=1/Math.sqrt(l2),nx=-ez*inv,nz=ex*inv;
    const center=nx*midX+nz*midZ,radius=Math.abs(nx)*hX+Math.abs(nz)*hZ;
    const pa=nx*ax+nz*az,pb=nx*bx+nz*bz,pc=nx*cx+nz*cz;
    const minP=pa<pb?(pa<pc?pa:pc):(pb<pc?pb:pc);
    const maxP=pa>pb?(pa>pc?pa:pc):(pb>pc?pb:pc);
    const pos=maxP-center+radius,neg=center+radius-minP;
    if(pos<=1e-8||neg<=1e-8)return null;
    const ov=pos<neg?pos:neg;
    if(ov<depth-1e-7){depth=ov;bestX=nx;bestY=0;bestZ=nz;hasBest=true;sign=pos<neg?1:-1;}
   }
   // (ey, -ex, 0)
   l2=ey*ey+ex*ex;
   if(l2>=1e-20){
    const inv=1/Math.sqrt(l2),nx=ey*inv,ny=-ex*inv;
    const center=nx*midX+ny*midY,radius=Math.abs(nx)*hX+Math.abs(ny)*hY;
    const pa=nx*ax+ny*ay,pb=nx*bx+ny*by,pc=nx*cx+ny*cy;
    const minP=pa<pb?(pa<pc?pa:pc):(pb<pc?pb:pc);
    const maxP=pa>pb?(pa>pc?pa:pc):(pb>pc?pb:pc);
    const pos=maxP-center+radius,neg=center+radius-minP;
    if(pos<=1e-8||neg<=1e-8)return null;
    const ov=pos<neg?pos:neg;
    if(ov<depth-1e-7){depth=ov;bestX=nx;bestY=ny;bestZ=0;hasBest=true;sign=pos<neg?1:-1;}
   }
  }
  if(!hasBest||!Number.isFinite(depth))return null;
  const nx=bestX*sign,ny=bestY*sign,nz=bestZ*sign;
  if(sx*nx+sy*ny+sz*nz<0){sx=-sx;sy=-sy;sz=-sz;}
  return {normal:new Vector3(nx,ny,nz),surface:new Vector3(sx,sy,sz),depth,walkable:sy>=.7&&ny>=.7};
 }
}
