import {OnlineGame} from './game.js';
export {OnlineGame};
export {OnlineResults} from './results.js';
import {createRemoteJWKSet,jwtVerify} from 'jose';
import {rating,eligible,chooseRival} from './queue-core.js';
// JereChess 2.4.5 server. Authentication and game state are authoritative.
const GOOGLE_JWKS=createRemoteJWKSet(new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'));
const encoder=new TextEncoder();
const b64=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
const unb64=s=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-s.length%4)%4)),c=>c.charCodeAt(0));
async function mac(secret,data){const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);return b64(await crypto.subtle.sign('HMAC',key,encoder.encode(data)))}
async function ticket(payload,secret){const body=b64(encoder.encode(JSON.stringify(payload)));return body+'.'+await mac(secret,body)}
async function unticket(raw,secret){if(typeof raw!=='string'||raw.length>2500)throw Error('Ticket inválido');const [body,sig,extra]=raw.split('.');if(!body||!sig||extra)throw Error('Ticket inválido');const expected=await mac(secret,body);if(expected.length!==sig.length)throw Error('Ticket inválido');let mismatch=0;for(let i=0;i<sig.length;i++)mismatch|=expected.charCodeAt(i)^sig.charCodeAt(i);if(mismatch)throw Error('Ticket inválido');const obj=JSON.parse(new TextDecoder().decode(unb64(body)));if(!obj.uid||!obj.clock||!obj.nonce||!Number.isFinite(obj.exp)||Date.now()>obj.exp)throw Error('Ticket expirado');return obj}
const json=(body,status=200,extra={})=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json;charset=utf-8',...extra}});
function allowedOrigin(origin,allowed){return origin===allowed||(allowed==='https://jerechess.com'&&origin==='https://www.jerechess.com')}
function cors(origin,allowed){return allowedOrigin(origin,allowed)?{'access-control-allow-origin':origin,'vary':'Origin','access-control-allow-headers':'authorization,content-type','access-control-allow-methods':'GET,POST,OPTIONS'}:{}}
const validClock=(minutes,increment)=>Number.isInteger(minutes)&&minutes>=1&&minutes<=180&&Number.isInteger(increment)&&increment>=0&&increment<=120;
function safePlayerName(raw){return typeof raw==='string'&&raw.trim()?raw.trim().slice(0,24):null}
async function playerNameFromProfile(token,env,uid){
 const url='https://firestore.googleapis.com/v1/projects/'+encodeURIComponent(env.FIREBASE_PROJECT_ID)+'/databases/(default)/documents/jerechess_profiles/'+encodeURIComponent(uid);
 try{
  const response=await fetch(url,{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(4000)});
  if(!response.ok)return null;
  const data=await response.json();
  return safePlayerName(data?.fields?.displayName?.stringValue);
 }catch{return null}
}

async function verifiedUser(req,env){
 const authorization=req.headers.get('authorization')||'';
 if(!authorization.startsWith('Bearer '))throw Error('Sesión requerida');
 const {payload}=await jwtVerify(authorization.slice(7),GOOGLE_JWKS,{issuer:`https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,audience:env.FIREBASE_PROJECT_ID,algorithms:['RS256']});
 if(typeof payload.sub!=='string'||!payload.sub||payload.firebase?.sign_in_provider==='anonymous')throw Error('Cuenta inválida');
 return payload.sub;
}
export default {
 async fetch(req,env){const u=new URL(req.url),origin=req.headers.get('Origin')||'',headers=cors(origin,env.ALLOWED_ORIGIN);
  if(u.pathname==='/health'){
   const configured=!!env.TICKET_SECRET&&!!env.FIREBASE_PROJECT_ID&&env.FIREBASE_PROJECT_ID!=='REEMPLAZAR_PROJECT_ID';
   const bindings={matchmaker:!!env.MATCHMAKER,games:!!env.GAMES,results:!!env.RESULTS};
   let ratingService='unavailable',diagnostic=null;
   if(bindings.results){try{
    const ledger=env.RESULTS.get(env.RESULTS.idFromName('ledger-v1'));
    const check=await ledger.fetch('https://internal/rating',{headers:{'x-verified-uid':'healthcheck-readonly','x-category':'blitz'}});
    ratingService=check.ok?'ok':'http_'+check.status;
   }catch(e){ratingService='error';diagnostic=String(e?.name||'RuntimeError')}}
   return json({service:'jerechess-online',phase:'2.4.5',ready:configured&&Object.values(bindings).every(Boolean)&&ratingService==='ok',configured,bindings,ratingService,...(diagnostic?{diagnostic}:{})});
  }
  if(req.method==='OPTIONS')return allowedOrigin(origin,env.ALLOWED_ORIGIN)?new Response(null,{status:204,headers}):new Response(null,{status:403});
  if(!env.TICKET_SECRET||!env.FIREBASE_PROJECT_ID||env.FIREBASE_PROJECT_ID==='REEMPLAZAR_PROJECT_ID')return json({error:'Servidor sin configurar'},503,headers);
  if(!allowedOrigin(origin,env.ALLOWED_ORIGIN))return json({error:'Origen no permitido'},403,headers);
  if(u.pathname==='/api/me'&&req.method==='GET'){
   try{const uid=await verifiedUser(req,env);
    const stub=env.RESULTS.get(env.RESULTS.idFromName('ledger-v1'));
    const response=await stub.fetch('https://internal/me',{headers:{'x-verified-uid':uid}});
    return json(await response.json(),response.status,headers);
   }catch{return json({error:'No se pudo validar la sesión'},401,headers)}
  }
  if(u.pathname==='/api/game-ticket'&&req.method==='POST'){
   try{
    const uid=await verifiedUser(req,env);
    const data=await req.json().catch(()=>null),gameId=data?.gameId;
    if(typeof gameId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(gameId))return json({error:'Partida inválida'},400,headers);
    const stub=env.GAMES.get(env.GAMES.idFromName(gameId));
    const permission=await stub.fetch('https://internal/authorize',{headers:{'x-player-uid':uid}});
    if(!permission.ok)return json({error:'No pertenecés a esta partida'},403,headers);
    const signed=await ticket({type:'game',uid,gameId,nonce:crypto.randomUUID(),clock:'game',exp:Date.now()+10*60*1000},env.TICKET_SECRET);
    return json({ticket:signed},200,headers);
   }catch{return json({error:'No fue posible verificar el acceso a la partida'},401,headers)}
  }
  if(u.pathname==='/api/queue-ticket'&&req.method==='POST'){
   let uid;
   try{uid=await verifiedUser(req,env)}
   catch(e){console.warn('Queue auth rejected:',e?.name||'auth_error');return json({error:'No se pudo verificar la sesión de JereChess ID. Cerrá sesión, volvé a entrar y probá otra vez.',code:'AUTH_REJECTED'},401,headers)}
   const data=await req.json().catch(()=>null);
   const {minutes,increment,rated=true}=data||{};
   if(typeof rated!=='boolean')return json({error:'Modalidad inválida'},400,headers);
   if(!validClock(minutes,increment))return json({error:'Tiempo incorrecto'},400,headers);
   try{
    if(!env.RESULTS)throw Error('RESULTS binding absent');
    const ledger=env.RESULTS.get(env.RESULTS.idFromName('ledger-v1'));
    const playerRate=await ledger.fetch('https://internal/rating',{headers:{'x-verified-uid':uid,'x-category':minutes<3?'bullet':minutes<10?'blitz':'rapid'}});
    if(!playerRate.ok)return json({error:'Servicio de Elo temporalmente no disponible',code:'RATING_SERVICE'},503,headers);
    const {rating:verifiedRating}=await playerRate.json();
    const playerName=await playerNameFromProfile(req.headers.get('authorization').slice(7),env,uid);
    const ticketData={uid,clock:`${minutes}+${increment}`,rated,estimatedRating:rating(verifiedRating),playerName,nonce:crypto.randomUUID(),exp:Date.now()+60000};
    const signed=await ticket(ticketData,env.TICKET_SECRET);
    return json({ticket:signed,queueUrl:`${u.protocol==='https:'?'wss:':'ws:'}//${u.host}/ws?ticket=${encodeURIComponent(signed)}`},200,headers);
   }catch(e){console.error('Queue internal error:',e?.name||'internal_error',e?.message||'');return json({error:'Error interno al preparar la búsqueda. Revisar los registros del Worker.',code:'QUEUE_INTERNAL'},503,headers)}
  }
  if(u.pathname==='/game/ws'&&req.headers.get('Upgrade')?.toLowerCase()==='websocket'){
   try{const v=await unticket(u.searchParams.get('ticket'),env.TICKET_SECRET);if(v.type!=='game'||!v.gameId||!v.uid)return json({error:'Credencial de partida inválida'},403,headers);
    const stub=env.GAMES.get(env.GAMES.idFromName(v.gameId));
    return stub.fetch('https://internal/ws',{headers:{'Upgrade':'websocket','x-player-uid':v.uid}})
   }catch{return json({error:'Acceso a partida denegado'},401,headers)}
  }
  if(u.pathname==='/ws'&&req.headers.get('Upgrade')?.toLowerCase()==='websocket'){
   try{const v=await unticket(u.searchParams.get('ticket'),env.TICKET_SECRET);
    if(v.type==='game')return json({error:'Tipo de credencial incorrecto'},403,headers);
    const id=env.MATCHMAKER.idFromName('jerechess-queue-v1');
    return env.MATCHMAKER.get(id).fetch('https://internal/join',{headers:{'Upgrade':'websocket','x-uid':v.uid,'x-clock':v.clock,'x-rated':String(v.rated!==false),'x-rating':String(rating(v.estimatedRating)),'x-name':encodeURIComponent(v.playerName||''),'x-nonce':v.nonce}})
   }catch{return json({error:'Ticket expirado o inválido'},401,headers)}
  }
  return json({error:'Ruta desconocida'},404,headers);
 }
};
export class Matchmaker {
 constructor(ctx,env){this.ctx=ctx;this.env=env}
 sockets(){return this.ctx.getWebSockets().filter(s=>s.readyState===WebSocket.OPEN)}
 async fetch(req){if(req.headers.get('Upgrade')?.toLowerCase()!=='websocket')return new Response('WebSocket requerido',{status:426});
  const uid=req.headers.get('x-uid'),clock=req.headers.get('x-clock'),rated=req.headers.get('x-rated')==='true',nonce=req.headers.get('x-nonce'),elo=rating(Number(req.headers.get('x-rating'))),name=safePlayerName(decodeURIComponent(req.headers.get('x-name')||''));
  if(!uid||!/^(?:[1-9]\d{0,2})\+(?:0|[1-9]\d{0,2})$/.test(clock)||!nonce)return new Response('Inválido',{status:403});
  const nonceKey=`nonce:${nonce}`;if(await this.ctx.storage.get(nonceKey))return new Response('Ticket ya utilizado',{status:409});
  await this.ctx.storage.put(nonceKey,Date.now()+65000);
  if(!(await this.ctx.storage.getAlarm()))await this.ctx.storage.setAlarm(Date.now()+65000);
  for(const old of this.sockets()){const info=old.deserializeAttachment();if(info?.uid===uid){this.safeSend(old,{type:'error',message:'La cuenta inició otra búsqueda.'});try{old.close(1000,'Búsqueda reemplazada')}catch{}}}
  const pair=new WebSocketPair(),client=pair[0],server=pair[1];this.ctx.acceptWebSocket(server);
  server.serializeAttachment({uid,clock,rated,rating:elo,name,nonce,status:'connecting',joinedAt:Date.now()});
  return new Response(null,{status:101,webSocket:client});
 }
 safeSend(ws,obj){try{ws.send(JSON.stringify(obj));return true}catch{return false}}
 async webSocketMessage(ws,message){let d;try{d=JSON.parse(message)}catch{try{ws.close(1003,'Mensaje inválido')}catch{};return}
  const mine=ws.deserializeAttachment();if(d.type==='ping'){this.safeSend(ws,{type:'pong'});return}
  if(d.type!=='join'||!mine||mine.status!=='connecting'){this.safeSend(ws,{type:'error',message:'Solicitud inválida'});return}
  ws.serializeAttachment({...mine,status:'waiting'});this.safeSend(ws,{type:'waiting',clock:mine.clock,rated:mine.rated});await this.findPairs();
 }
 async findPairs(){const now=Date.now(),sockets=this.sockets();
  const waiting=sockets.filter(s=>s.deserializeAttachment()?.status==='waiting').sort((a,b)=>a.deserializeAttachment().joinedAt-b.deserializeAttachment().joinedAt);
  const reserved=new Set();
  for(const a of waiting){if(reserved.has(a))continue;
   const ai=a.deserializeAttachment(),options=waiting.filter(b=>b!==a&&!reserved.has(b));
   const ranked=options.map(s=>({s,...s.deserializeAttachment()})),picked=chooseRival(ai,ranked,now);
   if(!picked)continue;const b=picked.s,bi=b.deserializeAttachment();if(!eligible(ai,bi,now))continue;
   reserved.add(a);reserved.add(b);
   const gameId=crypto.randomUUID(),whiteFirst=crypto.getRandomValues(new Uint8Array(1))[0]%2===0;
   const [minutes,increment]=ai.clock.split('+').map(Number),white=whiteFirst?ai.uid:bi.uid,black=whiteFirst?bi.uid:ai.uid;
   const stub=this.env.GAMES.get(this.env.GAMES.idFromName(gameId));
   let created=false;try{const response=await stub.fetch('https://internal/init',{method:'POST',body:JSON.stringify({id:gameId,white,black,minutes,increment,rated:ai.rated,playerNames:{white:whiteFirst?ai.name:bi.name,black:whiteFirst?bi.name:ai.name},playerRatings:{white:whiteFirst?ai.rating:bi.rating,black:whiteFirst?bi.rating:ai.rating}})});created=response.ok}catch{}
   if(!created){this.safeSend(a,{type:'error',message:'No se pudo crear la partida'});this.safeSend(b,{type:'error',message:'No se pudo crear la partida'});continue}
   const at=Date.now();
   const [ticketA,ticketB]=await Promise.all([
    ticket({type:'game',uid:ai.uid,gameId,nonce:crypto.randomUUID(),clock:ai.clock,exp:at+86400000},this.env.TICKET_SECRET),
    ticket({type:'game',uid:bi.uid,gameId,nonce:crypto.randomUUID(),clock:bi.clock,exp:at+86400000},this.env.TICKET_SECRET)
   ]);
   a.serializeAttachment({...ai,status:'matched',gameId});b.serializeAttachment({...bi,status:'matched',gameId});
   this.safeSend(a,{type:'matched',gameId,opponent:'Rival encontrado',color:whiteFirst?'white':'black',clock:ai.clock,rated:ai.rated,gameTicket:ticketA});
   this.safeSend(b,{type:'matched',gameId,opponent:'Rival encontrado',color:whiteFirst?'black':'white',clock:bi.clock,rated:bi.rated,gameTicket:ticketB});
   try{a.close(1000,'Emparejamiento completado')}catch{}try{b.close(1000,'Emparejamiento completado')}catch{}
  }
  if(this.sockets().some(s=>s.deserializeAttachment()?.status==='waiting'))await this.ctx.storage.setAlarm(Date.now()+10000);
 }
 async alarm(){const now=Date.now();let nextExpiry=Infinity;
  for(const [k,v] of await this.ctx.storage.list({prefix:'nonce:'})){if(v<=now)await this.ctx.storage.delete(k);else nextExpiry=Math.min(nextExpiry,v)}
  await this.findPairs();
  if(Number.isFinite(nextExpiry)&&!(await this.ctx.storage.getAlarm()))await this.ctx.storage.setAlarm(Math.max(Date.now()+1000,nextExpiry));
 }
 async webSocketClose(ws){try{ws.close(1000,'Conexión terminada')}catch{}}
 async webSocketError(ws){try{ws.close(1011,'Error de conexión')}catch{}}
}
