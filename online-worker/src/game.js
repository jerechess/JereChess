import {Chess} from './chess.js';
const respond=(obj,status=200)=>new Response(JSON.stringify(obj),{status,headers:{'content-type':'application/json'}});
const safe=(ws,obj)=>{try{ws.send(JSON.stringify(obj));return true}catch{return false}};
const validSquare=x=>typeof x==='string'&&/^[a-h][1-8]$/.test(x);
const dataKey='game';
export class OnlineGame {
 constructor(ctx,env){this.ctx=ctx;this.env=env}
 async read(){return this.ctx.storage.get(dataKey)}
 async fetch(req){const url=new URL(req.url);
  if(url.pathname==='/init'&&req.method==='POST'){
   const d=await req.json();if(!d.id||!d.white||!d.black||d.white===d.black||!Number.isInteger(d.minutes)||!Number.isInteger(d.increment))return respond({error:'Datos inválidos'},400);
   const existing=await this.read();if(existing)return respond({ok:true,existing:true});
   const initial={id:d.id,white:d.white,black:d.black,minutes:d.minutes,increment:d.increment,rated:d.rated,playerNames:{white:typeof d.playerNames?.white==='string'?d.playerNames.white:null,black:typeof d.playerNames?.black==='string'?d.playerNames.black:null},playerRatings:{white:Number.isInteger(d.playerRatings?.white)?d.playerRatings.white:null,black:Number.isInteger(d.playerRatings?.black)?d.playerRatings.black:null},fen:new Chess().fen(),moves:[],remaining:{w:d.minutes*60000,b:d.minutes*60000},runningSince:null,started:false,result:null,reason:null,settlement:null,createdAt:Date.now(),updatedAt:Date.now()};
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
 publicState(d){return {gameId:d.id,white:d.white,black:d.black,clock:`${d.minutes}+${d.increment}`,rated:d.rated,playerNames:d.playerNames||null,playerRatings:d.playerRatings||null,fen:d.fen,moves:d.moves,remaining:d.remaining,runningSince:d.runningSince,started:d.started,result:d.result,reason:d.reason,settlement:d.settlement,serverNow:Date.now()}}
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
 async setAlarm(d){if(d.result||!d.runningSince)return;const c=new Chess(d.fen).turn(),due=d.runningSince+d.remaining[c];await this.ctx.storage.setAlarm(Math.max(Date.now()+1,due))}
 async checkTime(d,now){if(d.result||!d.runningSince)return false;const side=new Chess(d.fen).turn();if(now-d.runningSince<d.remaining[side])return false;
  d.remaining[side]=0;d.runningSince=null;d.result=side==='w'?'0-1':'1-0';d.reason='tiempo';await this.finish(d);return true}
 async webSocketMessage(ws,message){const info=ws.deserializeAttachment();if(!info?.uid)return;let m;
  if(typeof message!=='string'||message.length>8192){safe(ws,{type:'error',message:'Mensaje demasiado grande'});return}
  try{m=JSON.parse(message)}catch{return}
  if(m?.type==='ping'){safe(ws,{type:'pong',serverNow:Date.now()});return}
  const d=await this.read();if(!d)return;const uid=info.uid,side=uid===d.white?'w':uid===d.black?'b':null;if(!side)return;
  if(m.type==='sync'){await this.checkTime(d,Date.now());safe(ws,{type:'state',...this.publicState(await this.read())});return}
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
  d.fen=chess.fen();d.moves.push({from:candidate.from,to:candidate.to,promotion:candidate.promotion||null,san:candidate.san,fen:d.fen});
  if(chess.isGameOver()){d.result=chess.isCheckmate()?(side==='w'?'1-0':'0-1'):'1/2-1/2';d.reason=chess.isCheckmate()?'jaque mate':'tablas';d.runningSince=null}
  if(d.result)await this.finish(d);else{await this.persist(d);await this.setAlarm(d);this.broadcast({type:'state',...this.publicState(d)})}
 }
 async alarm(){const d=await this.read();if(!d)return;if(d.result){await this.settle(d);if(d.settlement)this.broadcast({type:'state',...this.publicState(d)});return}
  await this.checkTime(d,Date.now());const fresh=await this.read();if(fresh&&!fresh.result)await this.setAlarm(fresh)}
 async webSocketClose(ws){try{ws.close(1000)}catch{}}
 async webSocketError(ws){try{ws.close(1011)}catch{}}
}