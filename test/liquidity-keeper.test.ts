import {test} from 'node:test';import assert from 'node:assert/strict';import {keeperGasLimit,liquidityTick} from '../src/liquidity-keeper.ts';import {requestPolicy} from '../src/http-security.ts';
test('keeper caps single and daily gas spend, preserves reserve, and refuses expensive/invalid gas',()=>{
 assert.equal(keeperGasLimit(650000n,50000000n,200000000000000n,0n),780000n);
 assert.equal(keeperGasLimit(1800000n,50000000n,200000000000000n,0n),2160000n);
 for(const args of [[0n,1n,1000000000000000n,0n],[2200001n,50000000n,1000000000000000n,0n],[650000n,150000001n,1000000000000000n,0n],[650000n,50000000n,20000000000000n,0n],[650000n,50000000n,1000000000000000n,190000000000000n]])assert.throws(()=>keeperGasLimit(...args as [bigint,bigint,bigint,bigint]));
});
test('unconfigured keeper cannot sign, fetch RPC, or broadcast transactions',async()=>{const values=new Map<string,unknown>();const r=await liquidityTick({RPC_URL:'https://invalid.local'}, {get:async<T>(k:string)=>values.get(k) as T|undefined,put:async(k,v)=>{values.set(k,v);}});assert.equal(r.status,'DISABLED');assert.equal(values.size,1);});
test('public callers can only read liquidity, not invoke provisioning/signing or forge internal scheduler',()=>{
 assert.equal(requestPolicy(new Request('https://xyn.lgbt/api/liquidity')).method,'GET');
 for(const [path,method]of [['/api/liquidity','POST'],['/__liquidity_tick','POST'],['/api/liquidity?to=0x123','GET']])assert.throws(()=>requestPolicy(new Request('https://xyn.lgbt'+path,{method})));
});
