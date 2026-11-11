import test from 'node:test';
import assert from 'node:assert/strict';
import {rating,rangeAfter,compatible,eligible,chooseRival} from './src/queue-core.js';
import {calculateElo,category} from './src/results.js';

test('same clock and rated setting needed',()=>{
 const a={uid:'a',clock:'3+0',rated:true,status:'waiting',rating:1500,joinedAt:1000};
 assert.equal(compatible(a,{...a,uid:'b'}),true);
 assert.equal(compatible(a,{...a,uid:'b',clock:'5+0'}),false);
 assert.equal(compatible(a,{...a,uid:'b',rated:false}),false);
 assert.equal(compatible(a,a),false);
});

test('matching Elo window expands gradually',()=>{
 assert.equal(rangeAfter(0),150);
 assert.ok(rangeAfter(60000)>rangeAfter(0));
 assert.equal(rangeAfter(500000),2000);
 const a={uid:'a',clock:'3+0',rated:true,status:'waiting',rating:1500,joinedAt:0};
 const b={...a,uid:'b',rating:1800};
 assert.equal(eligible(a,b,0),false);
 assert.equal(eligible(a,b,60000),true);
 assert.equal(chooseRival(a,[{...b,uid:'c',rating:1510},b],60000)?.uid,'c');
});

test('Elo settled consistently and drawn peers stay equal',()=>{
 assert.deepEqual(calculateElo(1500,1500,'1-0'),{white:1516,black:1484});
 assert.deepEqual(calculateElo(1500,1500,'1/2-1/2'),{white:1500,black:1500});
 assert.throws(()=>calculateElo(1500,1500,'foo'));
 assert.equal(category(1),'bullet');
 assert.equal(category(3),'blitz');
 assert.equal(category(10),'rapid');
});
