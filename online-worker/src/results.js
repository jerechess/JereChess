// JereChess 2.4.4 — authoritative results and rating ledger.
// Single Durable Object owns settlement and per-user histories. No client-side writes.
export const INITIAL_RATING=1500;
const K=32;
const SCORE={'1-0':1,'0-1':0,'1/2-1/2':0.5};
export const category=(minutes)=>minutes<3?'bullet':minutes<10?'blitz':'rapid';
export function calculateElo(white,black,result){
 if(!(result in SCORE))throw Error('Resultado inválido');
 const a=SCORE[result],b=1-a;
 const expected=1/(1+10**((black-white)/400));
 return {white:Math.max(100,Math.round(white+K*(a-expected))),black:Math.max(100,Math.round(black+K*(b-(1-expected))))};
}
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const playerKey=uid=>'user:'+uid;
const gameKey=id=>'game:'+id;
const normalizePlayer=v=>v||{ratings:{bullet:INITIAL_RATING,blitz:INITIAL_RATING,rapid:INITIAL_RATING},history:[]};
const validId=s=>typeof s==='string'&&s.length>=1&&s.length<=128;
export class OnlineResults {
 constructor(ctx,env){this.ctx=ctx;this.env=env}
 async fetch(req){const route=new URL(req.url).pathname;
  if(route==='/me'){
   const uid=req.headers.get('x-verified-uid');if(!validId(uid))return json({error:'Cuenta inválida'},401);
   const record=normalizePlayer(await this.ctx.storage.get(playerKey(uid)));
   return json({ratings:record.ratings,history:record.history||[]});
  }
  if(route==='/rating'){
   const uid=req.headers.get('x-verified-uid');const categoryName=req.headers.get('x-category');
   if(!validId(uid)||!['bullet','blitz','rapid'].includes(categoryName))return json({error:'Datos inválidos'},400);
   const record=normalizePlayer(await this.ctx.storage.get(playerKey(uid)));
   return json({rating:record.ratings[categoryName]??INITIAL_RATING});
  }
  if(route==='/settle'&&req.method==='POST'){
   const d=await req.json().catch(()=>null);
   if(!d||!validId(d.id)||!validId(d.white)||!validId(d.black)||d.white===d.black||!(d.result in SCORE)||!Number.isInteger(d.minutes)||d.minutes<1||d.minutes>180||!Number.isInteger(d.increment)||d.increment<0||d.increment>120||typeof d.rated!=='boolean'||!Array.isArray(d.moves)||d.moves.length>2000)return json({error:'Partida inválida'},400);
   // This endpoint is invoked only through a private Durable Object binding, never exposed on the public Worker router.
   const outcome=await this.ctx.storage.transaction(async tx=>{
    const existing=await tx.get(gameKey(d.id));if(existing)return existing;
    const white=normalizePlayer(await tx.get(playerKey(d.white)));
    const black=normalizePlayer(await tx.get(playerKey(d.black)));
    const speed=category(d.minutes),before={white:white.ratings[speed]??INITIAL_RATING,black:black.ratings[speed]??INITIAL_RATING};
    const after=d.rated?calculateElo(before.white,before.black,d.result):{...before};
    const stamp=Date.now();const changes={white:after.white-before.white,black:after.black-before.black};
    const record={id:d.id,white:d.white,black:d.black,result:d.result,reason:String(d.reason||'finalizada').slice(0,100),clock:`${d.minutes}+${d.increment}`,rated:d.rated,category:speed,createdAt:Number.isFinite(d.createdAt)?d.createdAt:stamp,finishedAt:stamp,moves:d.moves.map(m=>({from:m.from,to:m.to,promotion:m.promotion||null,san:m.san})),ratings:{before,after,changes}};
    white.ratings[speed]=after.white;black.ratings[speed]=after.black;
    const listing={id:record.id,white:record.white,black:record.black,result:record.result,reason:record.reason,clock:record.clock,rated:record.rated,category:speed,createdAt:record.createdAt,finishedAt:stamp,ratings:record.ratings,moves:record.moves};
    white.history=[listing,...white.history.filter(x=>x.id!==d.id)].slice(0,100);
    black.history=[listing,...black.history.filter(x=>x.id!==d.id)].slice(0,100);
    await tx.put(playerKey(d.white),white);await tx.put(playerKey(d.black),black);await tx.put(gameKey(d.id),record);
    return record;
   });
   return json({ok:true,record:outcome});
  }
  return json({error:'Ruta desconocida'},404);
 }
}
