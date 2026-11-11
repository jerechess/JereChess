import test from 'node:test';
import assert from 'node:assert/strict';
import {OnlineGame} from './src/game.js';
function setup(){
 const data=new Map();let sockets=[];
 const storage={get:async k=>structuredClone(data.get(k)),put:async(k,v)=>data.set(k,structuredClone(v)),setAlarm:async()=>{},getAlarm:async()=>null};
 const server=new OnlineGame({storage,getWebSockets:()=>sockets,acceptWebSocket:ws=>{sockets.push(ws)}},{});
 const init=()=>server.fetch(new Request('https://internal/init',{method:'POST',body:JSON.stringify({id:'game-security',white:'alice',black:'bob',minutes:1,increment:0,rated:false})}));
 return {server,init,data,setSockets:next=>{sockets=next}};
}
test('private authorization only permits assigned players',async()=>{
 const {server,init}=setup();await init();
 for(const uid of ['alice','bob'])assert.equal((await server.fetch(new Request('https://internal/authorize',{headers:{'x-player-uid':uid}}))).status,200);
 assert.equal((await server.fetch(new Request('https://internal/authorize',{headers:{'x-player-uid':'eve'}}))).status,403);
});
test('sync notices expiration even if an alarm has not fired',async()=>{
 const {server,init}=setup();await init();
 const old=await server.read();old.started=true;old.runningSince=Date.now()-62000;await server.persist(old);
 const received=[];const ws={deserializeAttachment:()=>({uid:'alice'}),send:message=>received.push(JSON.parse(message))};
 await server.webSocketMessage(ws,JSON.stringify({type:'sync'}));
 assert.equal((await server.read()).result,'0-1');
 assert.equal(received.at(-1).type,'state');
 assert.equal(received.at(-1).reason,'tiempo');
});
test('oversized websocket messages cannot alter a game',async()=>{
 const {server,init}=setup();await init();
 const received=[];const ws={deserializeAttachment:()=>({uid:'alice'}),send:message=>received.push(JSON.parse(message))};
 await server.webSocketMessage(ws,'x'.repeat(8193));
 assert.equal((await server.read()).moves.length,0);
 assert.equal(received[0].type,'error');
});
