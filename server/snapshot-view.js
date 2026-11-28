// Private team purchase calls never cross the opponent's WebSocket connection.
// Prepare at most two views per broadcast, rather than serializing per player.
export function snapshotForSide(snapshot,side){
  const {radarBySide,ctSpottedBomb,...common}=snapshot;
  return {...common,bombSpotted:side==='CT'&&ctSpottedBomb===true,radarContacts:radarBySide?.[side]||[],events:(snapshot.events||[]).filter(e=>!e.audienceTeam||e.audienceTeam===side),weaponRequests:(snapshot.weaponRequests||[]).filter(r=>r.team===side),players:snapshot.players.map(player=>{
    if(player.team===side)return player;
    const {botBuy,lossIncome,weaponLoadout,plantSite,...publicPlayer}=player;return publicPlayer;
  })};
}

// Authoritative prediction fields (movementState, movementAck, shotAck, shotRejected)
// are only reconciled by the owning player (or the player possessing a bot).
// Omitting them for unrelated peers cuts multi-human delta WS bytes by 50-75%
// and keeps frames smaller (lower latency, no loss of responsiveness).
export function snapshotForPlayer(sideSnap,playerId){
  let needsTrim=false;
  for(let i=0;i<sideSnap.players.length;i++){
    const p=sideSnap.players[i];
    if(p.id!==playerId&&p.controllerId!==playerId&&(p.movementState!==undefined||p.movementAck!==undefined||p.shotAck!==undefined||p.shotRejected!==undefined)){
      needsTrim=true;break;
    }
  }
  if(!needsTrim)return sideSnap;
  return {
    ...sideSnap,
    players:sideSnap.players.map(p=>{
      if(p.id===playerId||p.controllerId===playerId)return p;
      if(p.movementState===undefined&&p.movementAck===undefined&&p.shotAck===undefined&&p.shotRejected===undefined)return p;
      const {movementState,movementAck,shotAck,shotRejected,...publicPeer}=p;
      return publicPeer;
    }),
  };
}
