import {Chess} from './chess.js';
const respond=(obj,status=200)=>new Response(JSON.stringify(obj),{status,headers:{'content-type':'application/json'}});
const safe=(ws,obj)=>{try{ws.send(JSON.stringify(obj));return true}catch{return false}};
const validSquare=x=>typeof x==='string'&&/^[a-h][1-8]$/.test(x);
const dataKey='game';
const REMATCH_TTL_MS=120000;
const DRAW_TTL_MS=60000;
const validRematch=d=>d?.rematch?.status==='pending'&&Date.now()<d.rematch.expiresAt;
export class OnlineGame {
 constructor(ctx,env){this.ctx=ctx;this.env=env}
 async read(){return this.ctx.storage.get(dataKey)}
 async fetch(req){const url=new URL(req.url);
  if(url.pathname==='/init'&&req.method==='POST'){
   const d=await req.json();if(!d.id||!d.white||!d.black||d.white===d.black||!Number.isInteger(d.minutes)||!Number.isInteger(d.increment))return respond({error:'Datos inválidos'},400);
   const existing=await this.read();if(existing)return respond({ok:true,existing:true});
   const initial={id:d.id,white:d.white,black:d.black,minutes:d.minutes,increment:d.increment,rated:d.rated,playerNames:{white:typeof d.playerNames?.white==='string'?d.playerNames.white:null,black:typeof d.playerNames?.black==='string'?d.playerNames.black:null},playerRatings:{white:Number.isInteger(d.playerRatings?.white)?d.playerRatings.white:null,black:Number.isInteger(d.playerRatings?.black)?d.playerRatings.black:null},fen:new Chess().fen(),moves:[],remaining:{w:d.minutes*60000,b:d.minutes*60000},runningSince:null,started:false,result:null,reason:null,settlement:null,createdAt:Date.now(),updatedAt:Date.now(),rematch:null,drawOffer:null,drawAttempts:{}};
   await this.ctx.storage.put(dataKey,initial);return respond({ok:true});
  }
  if(url.pathname==='/authorize'){const uid=req.headers.get('x-player-uid'),d=await this.read();return d&&[d.white,d.black].includes(uid)?respond({ok:true}):respond({error:'No autorizado'},403)}
  if(url.pathname==='/ws'&&req.headers.get('Upgrade')?.toLowerCase()==='websocket'){
   const uid=req.headers.get('x-player-uid');const d=await this.read();if(!d||![d.white,d.black].includes(uid))return respond({error:'Jugador no autorizado'},403);
   await this.checkTime(d,Date.now());const latest=await this.read();
   for(const old of this.ctx.getWebSockets()){if(old.deserializeAttachment()?.uid===uid){try{old.close(1000,'Nueva conexión de la misma cuenta')}catch{}}}
   const pair=new WebSocketPair();this.ctx.acceptWebSocket(pair[1]);pair[1].serializeAttachment({uid});
   safe(pair[1],{type:'state',...this.publicState(latest)});return new Response(null,{status:101,webSocket:pair[0]});
  }
  return respond({error:'Ruta inválida'},404);
 }
 publicState(d){return {gameId:d.id,white:d.white,black:d.black,clock:`${d.minutes}+${d.increment}`,rated:d.rated,playerNames:d.playerNames||null,playerRatings:d.playerRatings||null,fen:d.fen,moves:d.moves,remaining:d.remaining,runningSince:d.runningSince,started:d.started,result:d.result,reason:d.reason,settlement:d.settlement,rematch:d.rematch||null,drawOffer:d.drawOffer||null,serverNow:Date.now()}}
 broadcast(obj){for(const ws of this.ctx.getWebSockets())safe(ws,obj)}
 async persist(d){d.updatedAt=Date.now();await this.ctx.storage.put(dataKey,d)}
 async settle(d){
  if(!d.result||d.settlement||!this.env?.RESULTS)return;
  try{const stub=this.env.RESULTS.get(this.env.RESULTS.idFromName('ledger-v1'));
   const response=await stub.fetch('https://internal/settle',{method:'POST',body:JSON.stringify({id:d.id,white:d.white,black:d.black,result:d.result,reason:d.reason,minutes:d.minutes,increment:d.increment,rated:d.rated,createdAt:d.createdAt,moves:d.moves})});
   if(!response.ok)throw Error('Registro no disponible');const result=await response.json();
   d.settlement=result.record?.ratings||null;await this.persist(d);
  }catch{await this.ctx.storage.setAlarm(Date.now()+5000)}
 }
 async finish(d){await this.persist(d);await this.settle(d);this.broadcast({type:'state',...this.publicState(d)})}
 async setAlarm(d){if(d.result)return;const c=new Chess(d.fen).turn();const clockDue=d.runningSince?d.runningSince+d.remaining[c]:Infinity;const drawDue=d.drawOffer?.status==='pending'?d.drawOffer.expiresAt:Infinity;const due=Math.min(clockDue,drawDue);if(Number.isFinite(due))await this.ctx.storage.setAlarm(Math.max(Date.now()+1,due));}
 async checkTime(d,now){if(d.result||!d.runningSince)return false;const side=new Chess(d.fen).turn();if(now-d.runningSince<d.remaining[side])return false;
  d.remaining[side]=0;d.runningSince=null;d.result=side==='w'?'0-1':'1-0';d.reason='tiempo';await this.finish(d);return true}
 async webSocketMessage(ws,message){const info=ws.deserializeAttachment();if(!info?.uid)return;let m;
  if(typeof message!=='string'||message.length>8192){safe(ws,{type:'error',message:'Mensaje demasiado grande'});return}
  try{m=JSON.parse(message)}catch{return}
  if(m?.type==='ping'){safe(ws,{type:'pong',serverNow:Date.now()});return}
  const d=await this.read();if(!d)return;const uid=info.uid,side=uid===d.white?'w':uid===d.black?'b':null;if(!side)return;
  if(m.type==='sync'){await this.checkTime(d,Date.now());safe(ws,{type:'state',...this.publicState(await this.read())});return}
  if(['rematch_request','rematch_accept','rematch_decline','rematch_cancel'].includes(m.type)){await this.handleRematch(ws,d,uid,m.type);return}
  if(['draw_offer','draw_accept','draw_decline'].includes(m.type)){await this.handleDrawOffer(ws,d,uid,m.type);return}
  if(d.result){safe(ws,{type:'error',message:'La partida ya terminó'});return}
  const now=Date.now();if(await this.checkTime(d,now))return;
  if(m.type==='resign'){d.result=side==='w'?'0-1':'1-0';d.reason='rendición';d.runningSince=null;await this.finish(d);return}
  if(m.type!=='move')return;
  if(!validSquare(m.from)||!validSquare(m.to)||!(m.promotion===undefined||'qrbn'.includes(m.promotion))){safe(ws,{type:'error',message:'Movimiento incorrecto'});return}
  const chess=new Chess(d.fen);if(chess.turn()!==side){safe(ws,{type:'error',message:'No es tu turno'});return}
  let candidate=null;try{candidate=chess.move({from:m.from,to:m.to,promotion:m.promotion||'q'})}catch{}
  if(!candidate){safe(ws,{type:'error',message:'Jugada ilegal'});return}
  if(d.started){d.remaining[side]=Math.max(0,d.remaining[side]-(now-d.runningSince))}
  d.remaining[side]+=d.increment*1000;d.started=true;d.runningSince=now;
  if(d.drawOffer?.status==='pending')d.drawOffer={...d.drawOffer,status:'declined'};
  d.fen=chess.fen();d.moves.push({from:candidate.from,to:candidate.to,promotion:candidate.promotion||null,san:candidate.san,fen:d.fen});
  if(chess.isGameOver()){d.result=chess.isCheckmate()?(side==='w'?'1-0':'0-1'):'1/2-1/2';d.reason=chess.isCheckmate()?'jaque mate':'tablas';d.runningSince=null}
  if(d.result)await this.finish(d);else{await this.persist(d);await this.setAlarm(d);this.broadcast({type:'state',...this.publicState(d)})}
 }

 async handleDrawOffer(ws,d,uid,action){
  if(d.result){safe(ws,{type:'error',message:'La partida ya terminó.'});return}
  const now=Date.now();
  if(d.drawOffer?.status==='pending'&&now>=d.drawOffer.expiresAt){
   d.drawOffer={...d.drawOffer,status:'expired'};
   await this.persist(d);
   this.broadcast({type:'state',...this.publicState(d)});
  }
  const pending=d.drawOffer?.status==='pending'&&now<d.drawOffer.expiresAt;
  if(action==='draw_offer'){
   if(pending){safe(ws,{type:'error',message:'Ya hay una propuesta de tablas pendiente.'});return}
   const ply=d.moves.length;
   if(d.drawAttempts?.[uid]===ply){safe(ws,{type:'error',message:'Ya propusiste tablas en esta jugada.'});return}
   d.drawAttempts={...(d.drawAttempts||{}),[uid]:ply};
   d.drawOffer={status:'pending',requestedBy:uid,expiresAt:now+DRAW_TTL_MS,ply};
   await this.persist(d);
   this.broadcast({type:'state',...this.publicState(d)});
   const turn=new Chess(d.fen).turn(),clockDue=d.runningSince?d.runningSince+d.remaining[turn]:Infinity;
   await this.ctx.storage.setAlarm(Math.max(now+1,Math.min(clockDue,now+DRAW_TTL_MS)));
   return;
  }
  if(!pending){safe(ws,{type:'error',message:'La propuesta de tablas ya no está disponible.'});return}
  if(d.drawOffer.requestedBy===uid){safe(ws,{type:'error',message:'El rival debe responder a la propuesta.'});return}
  if(action==='draw_decline')d.drawOffer={...d.drawOffer,status:'declined'};
  else if(action==='draw_accept'){
   d.drawOffer={...d.drawOffer,status:'accepted'};
   d.result='1/2-1/2';d.reason='tablas por acuerdo';d.runningSince=null;
   await this.finish(d);return;
  }
  await this.persist(d);
  this.broadcast({type:'state',...this.publicState(d)});
  await this.setAlarm(d);
 }
 async handleRematch(ws,d,uid,action){
  if(!d.result){safe(ws,{type:'error',message:'La revancha está disponible al terminar la partida.'});return}
  const now=Date.now();
  if(d.rematch?.status==='pending'&&now>=d.rematch.expiresAt){
   d.rematch={...d.rematch,status:'expired'};
   await this.persist(d);
   this.broadcast({type:'state',...this.publicState(d)});
  }
  const previous=d.rematch;
  if(action==='rematch_request'){
   if(previous?.status==='accepted'){safe(ws,{type:'error',message:'Ya se creó una revancha.'});return}
   if(previous?.status==='pending'){
    if(previous.requestedBy===uid){safe(ws,{type:'state',...this.publicState(d)});return}
    safe(ws,{type:'error',message:'Tu rival ya te propuso revancha. Podés aceptarla o rechazarla.'});return;
   }
   const attempts=d.rematchAttempts||{};
   if(attempts[uid]){safe(ws,{type:'error',message:'Ya solicitaste revancha en esta partida.'});return}
   d.rematchAttempts={...attempts,[uid]:true};
   d.rematch={status:'pending',requestedBy:uid,expiresAt:now+REMATCH_TTL_MS};
   await this.persist(d);
   this.broadcast({type:'state',...this.publicState(d)});
   await this.ctx.storage.setAlarm(now+REMATCH_TTL_MS);
   return;
  }
  if(!validRematch(d)){safe(ws,{type:'error',message:'La solicitud de revancha ya no está disponible.'});return}
  const requester=d.rematch.requestedBy;
  if(action==='rematch_cancel'){
   if(uid!==requester){safe(ws,{type:'error',message:'Solo quien solicitó la revancha puede cancelarla.'});return}
   d.rematch={...d.rematch,status:'cancelled'};
  }else if(action==='rematch_decline'){
   if(uid===requester){safe(ws,{type:'error',message:'No podés rechazar tu propia solicitud.'});return}
   d.rematch={...d.rematch,status:'declined'};
  }else if(action==='rematch_accept'){
   if(uid===requester){safe(ws,{type:'error',message:'La revancha debe aceptarla el otro jugador.'});return}
   const newId=crypto.randomUUID(),white=d.black,black=d.white;
   let newRatings={white:d.playerRatings?.black??null,black:d.playerRatings?.white??null};
   if(this.env.RESULTS){
    try{
     const ledger=this.env.RESULTS.get(this.env.RESULTS.idFromName('ledger-v1'));
     const category=d.minutes<3?'bullet':d.minutes<10?'blitz':'rapid';
     const [w,b]=await Promise.all([white,black].map(player=>ledger.fetch('https://internal/rating',{headers:{'x-verified-uid':player,'x-category':category}})));
     if(w.ok&&b.ok){const wRating=(await w.json()).rating,bRating=(await b.json()).rating;if(Number.isInteger(wRating)&&Number.isInteger(bRating))newRatings={white:wRating,black:bRating}}
    }catch{}
   }
   const candidate=this.env.GAMES.get(this.env.GAMES.idFromName(newId));
   try{
    const created=await candidate.fetch('https://internal/init',{method:'POST',body:JSON.stringify({id:newId,white,black,minutes:d.minutes,increment:d.increment,rated:d.rated,playerNames:{white:d.playerNames?.black||null,black:d.playerNames?.white||null},playerRatings:newRatings})});
    if(!created.ok)throw Error('No se pudo crear la nueva partida');
   }catch{safe(ws,{type:'error',message:'No se pudo preparar la revancha. Intentá aceptarla otra vez.'});return}
   d.rematch={...d.rematch,status:'accepted',newGameId:newId,acceptedAt:Date.now()};
  }
  await this.persist(d);
  this.broadcast({type:'state',...this.publicState(d)});
 }
 async alarm(){const d=await this.read();if(!d)return;
  if(d.drawOffer?.status==='pending'&&Date.now()>=d.drawOffer.expiresAt){d.drawOffer={...d.drawOffer,status:'expired'};await this.persist(d);this.broadcast({type:'state',...this.publicState(d)})}
  if(d.rematch?.status==='pending'&&Date.now()>=d.rematch.expiresAt){d.rematch={...d.rematch,status:'expired'};await this.persist(d);this.broadcast({type:'state',...this.publicState(d)})}
  if(d.result){await this.settle(d);if(d.settlement)this.broadcast({type:'state',...this.publicState(d)});return}
  await this.checkTime(d,Date.now());const fresh=await this.read();if(fresh&&!fresh.result)await this.setAlarm(fresh)}
 async webSocketClose(ws){try{ws.close(1000)}catch{}}
 async webSocketError(ws){try{ws.close(1011)}catch{}}
}