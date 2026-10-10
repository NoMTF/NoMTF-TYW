import {test} from 'node:test';import assert from 'node:assert/strict';import {keeperGasLimit,liquidityTick} from '../src/liquidity-keeper.ts';import {requestPolicy} from '../src/http-security.ts';
import {parseEther} from 'viem';import {liquidityCostPolicy,liquidityGasCost} from '../src/liquidity-cost-policy.ts';
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
test('automatic additions accumulate 20 USDT of total value, with a 0.5% gas ceiling',()=>{
 const p=liquidityCostPolicy({});assert.equal(p.minimumValue,parseEther('20'));assert.equal(p.maximumGasBps,50n);
 assert.deepEqual(liquidityCostPolicy({LIQUIDITY_MIN_VALUE_USDT:'25.5',LIQUIDITY_MAX_GAS_BPS:'30'}),{minimumValue:parseEther('25.5'),maximumGasBps:30n});
 for(const env of [{LIQUIDITY_MIN_VALUE_USDT:'0'},{LIQUIDITY_MIN_VALUE_USDT:'1.09'},{LIQUIDITY_MIN_VALUE_USDT:'1901'},{LIQUIDITY_MIN_VALUE_USDT:'1e2'},{LIQUIDITY_MIN_VALUE_USDT:'Infinity'},{LIQUIDITY_MAX_GAS_BPS:'0'},{LIQUIDITY_MAX_GAS_BPS:'101'},{LIQUIDITY_MAX_GAS_BPS:'0.5'}])assert.throws(()=>liquidityCostPolicy(env));
});
test('the relative gas guard admits the exact boundary and rejects one wei over it',()=>{
 const exact=liquidityGasCost(parseEther('20'),2000000n,50000000n,parseEther('1000'),50n);
 assert.equal(exact.cost,parseEther('0.1'));assert.equal(exact.allowed,true);
 assert.equal(liquidityGasCost(parseEther('20')-1n,2000000n,50000000n,parseEther('1000'),50n).allowed,false);
 assert.equal(liquidityGasCost(parseEther('5'),1440000n,50000000n,parseEther('750'),50n).allowed,false);
 assert.equal(liquidityGasCost(parseEther('20'),1440000n,50000000n,parseEther('750'),50n).allowed,true);
 assert.equal(liquidityGasCost(10000n,1n,1n,1n,50n).cost,1n);
 for(const args of [[0n,1n,1n,1n,50n],[1n,0n,1n,1n,50n],[1n,1n,0n,1n,50n],[1n,1n,1n,0n,50n],[1n,1n,1n,1n,101n]])assert.throws(()=>liquidityGasCost(...args as [bigint,bigint,bigint,bigint,bigint]));
});
