import test from 'node:test';
import assert from 'node:assert/strict';
import {OnlineGame} from './src/game.js';
function harness(){
 const store=new Map(),games=new Map(),received=[];
 const sockets=['alice','bob'].map(uid=>({deserializeAttachment:()=>({uid}),send:text=>received.push({uid,...JSON.parse(text)})}));
 const storage={get:async k=>structuredClone(store.get(k)),put:async(k,v)=>store.set(k,structuredClone(v)),setAlarm:async()=>{},getAlarm:async()=>null};
 const env={GAMES:{idFromName:x=>x,get:x=>({fetch:async(_url,opts)=>{games.set(x,JSON.parse(opts.body));return new Response('{"ok":true}')})}},RESULTS:{idFromName:x=>x,get:()=>({fetch:async(_url,opts)=>new Response(JSON.stringify({rating:opts.headers['x-verified-uid']==='alice'?1530:1490}))})}};
 const game=new OnlineGame({storage,getWebSockets:()=>sockets},env);
 const send=(uid,type)=>game.webSocketMessage(sockets.find(s=>s.deserializeAttachment().uid===uid),JSON.stringify({type}));
 return {game,send,games,received};
}
async function finished(){const v=harness();await v.game.fetch(new Request('https://internal/init',{method:'POST',body:JSON.stringify({id:'previous',white:'alice',black:'bob',minutes:3,increment:2,rated:true,playerNames:{white:'Alicia',black:'Beto'}})}));await v.send('alice','resign');return v}
test('revancha solamente después de terminar',async()=>{const v=harness();await v.game.fetch(new Request('https://internal/init',{method:'POST',body:JSON.stringify({id:'previous',white:'alice',black:'bob',minutes:3,increment:0,rated:true})}));await v.send('alice','rematch_request');assert.equal((await v.game.read()).rematch,null)});
test('only the opponent can accept and colors alternate',async()=>{const v=await finished();await v.send('alice','rematch_request');await v.send('alice','rematch_accept');assert.equal((await v.game.read()).rematch.status,'pending');await v.send('bob','rematch_accept');const old=await v.game.read(),next=v.games.get(old.rematch.newGameId);assert.ok(next);assert.equal(next.white,'bob');assert.equal(next.black,'alice');assert.equal(next.minutes,3);assert.equal(next.increment,2);assert.equal(next.rated,true);assert.deepEqual(next.playerRatings,{white:1490,black:1530});assert.equal(old.result,'0-1');await v.send('bob','rematch_accept');assert.equal(v.games.size,1)});
test('declined and expired invitations do not create new games',async()=>{const v=await finished();await v.send('alice','rematch_request');await v.send('bob','rematch_decline');assert.equal(v.games.size,0);assert.equal((await v.game.read()).rematch.status,'declined');const w=await finished();await w.send('alice','rematch_request');const d=await w.game.read();d.rematch.expiresAt=Date.now()-1;await w.game.persist(d);await w.send('bob','rematch_accept');assert.equal(w.games.size,0);assert.equal((await w.game.read()).rematch.status,'expired')});
