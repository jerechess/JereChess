import test from 'node:test';
import assert from 'node:assert/strict';
import {OnlineGame} from './src/game.js';
function harness(){
 const store=new Map(),sent=[];
 const sockets=['alice','bob','eve'].map(uid=>({deserializeAttachment:()=>({uid}),send:s=>sent.push({uid,...JSON.parse(s)})}));
 const storage={get:async k=>structuredClone(store.get(k)),put:async(k,v)=>store.set(k,structuredClone(v)),setAlarm:async()=>{},getAlarm:async()=>null};
 const game=new OnlineGame({storage,getWebSockets:()=>sockets},{});
 const send=(uid,type,extra={})=>game.webSocketMessage(sockets.find(s=>s.deserializeAttachment().uid===uid),JSON.stringify({type,...extra}));
 const init=()=>game.fetch(new Request('https://internal/init',{method:'POST',body:JSON.stringify({id:'draw-test',white:'alice',black:'bob',minutes:5,increment:0,rated:true})}));
 return {game,send,sent,init};
}
test('opponent accepts and game ends in draw',async()=>{
 const v=harness();await v.init();await v.send('alice','draw_offer');
 assert.equal((await v.game.read()).drawOffer.requestedBy,'alice');
 await v.send('bob','draw_accept');const d=await v.game.read();
 assert.equal(d.result,'1/2-1/2');assert.equal(d.reason,'tablas por acuerdo');
});
test('proposer cannot accept own offer',async()=>{
 const v=harness();await v.init();await v.send('alice','draw_offer');await v.send('alice','draw_accept');
 assert.equal((await v.game.read()).result,null);
});
test('decline blocks repeat on same ply',async()=>{
 const v=harness();await v.init();await v.send('alice','draw_offer');await v.send('bob','draw_decline');await v.send('alice','draw_offer');
 assert.equal((await v.game.read()).drawOffer.status,'declined');
});
test('expired request cannot be accepted',async()=>{
 const v=harness();await v.init();await v.send('alice','draw_offer');const d=await v.game.read();
 d.drawOffer.expiresAt=Date.now()-1;await v.game.persist(d);await v.send('bob','draw_accept');
 assert.equal((await v.game.read()).result,null);
});
test('third account cannot offer or accept',async()=>{
 const v=harness();await v.init();await v.send('eve','draw_offer');assert.equal((await v.game.read()).drawOffer,null);
 await v.send('alice','draw_offer');await v.send('eve','draw_accept');assert.equal((await v.game.read()).result,null);
});
test('a move cancels a pending offer',async()=>{
 const v=harness();await v.init();await v.send('alice','draw_offer');await v.send('alice','move',{from:'e2',to:'e4'});
 const d=await v.game.read();assert.equal(d.moves.length,1);assert.equal(d.drawOffer.status,'declined');
});