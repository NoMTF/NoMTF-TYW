import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';
import {privateKeyToAccount} from 'viem/accounts';import {TypedDataEncoder} from 'ethers';
import {parseOrder,wireOrder,orderId,batchDomain,BATCH_TYPES,validateLifetime,validateSignatureShape,requireUniqueNonce,chooseEntries,insufficientMinimumIndexes,executorGasBudget,type Entry,type Order} from '../src/batch-orders.ts';
import {boundedBody} from '../src/batch-queue.ts';
const unit=10n**18n,vault='0x17EE9B0e5eC4D006A816dEf32733E9f577fE00Af',zero='0x0000000000000000000000000000000000000000';
const account=privateKeyToAccount(('0x'+crypto.randomBytes(32).toString('hex')) as any);
const base:Order={user:account.address,redeem:false,amount:unit,minimum:unit,maxFee:0n,nonce:0n,deadline:2000n,executor:zero};
const entry=(o=base,at=1000):Entry=>({id:orderId(vault,o),order:wireOrder(o),signature:'0x1234',at,status:'QUEUED'});
test('executor gas cap cannot exceed signed stable fees; the next gas unit would exceed budget',()=>{const fee=123456789123456789n,gasPrice=51234567n,price=738123456789123456789n,cap=executorGasBudget(fee,gasPrice,price);assert.ok(cap*gasPrice*price<=fee*unit);assert.ok((cap+1n)*gasPrice*price>fee*unit);assert.throws(()=>executorGasBudget(fee,0n,price));});
test('fixed order domain matches ethers and every signed field changes the authorization digest',()=>{
 const id=orderId(vault,base);assert.equal(id,TypedDataEncoder.hash(batchDomain(vault),{Order:[...BATCH_TYPES.Order]},base));
 for(const key of ['amount','minimum','maxFee','nonce','deadline'] as const)assert.notEqual(orderId(vault,{...base,[key]:base[key]+1n}),id);
 assert.notEqual(orderId(vault,{...base,redeem:true}),id);assert.notEqual(orderId(zero,base),id);
});
test('wire parsing rejects unknown fields, unsafe numbers, negative or exponential values and oversized fees',()=>{
 assert.deepEqual(parseOrder(wireOrder(base)),base);
 for(const patch of [{extra:'1'},{amount:1},{amount:'1e18'},{amount:'-1'},{amount:'0'},{minimum:'0'},{user:zero},{nonce:String(2n**256n)},{maxFee:String(unit+1n)},{amount:String(11n*unit)},{redeem:'false'}])assert.throws(()=>parseOrder({...wireOrder(base),...patch}));
});
test('expired signatures and unreasonable deadlines are rejected without mistaking queued for settled',()=>{
 validateLifetime(base,1000n);assert.throws(()=>validateLifetime(base,2000n));assert.throws(()=>validateLifetime({...base,deadline:87401n},1000n));
 const entries=[entry(),{...entry({...base,nonce:1n}),status:'NONCE_ADVANCED' as const},{...entry({...base,nonce:2n}),status:'CONFIRMED' as const}];assert.equal(chooseEntries(entries,false,1500000).length,1);assert.equal(chooseEntries(entries,false,2000000).length,0);
});
test('server replacement cannot revoke a previously signed authorization at the same nonce',()=>{
 const e=entry();assert.equal(requireUniqueNonce([e],base,e.id),e);assert.throws(()=>requireUniqueNonce([e],{...base,minimum:unit-1n},orderId(vault,{...base,minimum:unit-1n})),/取消/);
 assert.equal(requireUniqueNonce([e],{...base,nonce:1n},orderId(vault,{...base,nonce:1n})),undefined);
});
test('ECDSA low-s enforcement matches the vault; malformed and malleable signatures cannot occupy a batch',async()=>{
 const signature=await account.signTypedData({domain:batchDomain(vault),types:BATCH_TYPES,primaryType:'Order',message:base});validateSignatureShape(signature);
 for(const value of ['0x','0x1234',signature.slice(0,-2)+'00',signature.slice(0,66)+'f'.repeat(64)+signature.slice(-2)])assert.throws(()=>validateSignatureShape(value));
 validateSignatureShape('0x1234',true);assert.throws(()=>validateSignatureShape('0x'+'12'.repeat(1025),true));
});
test('FIFO uses only live matching-direction entries and honors a bounded count',()=>{
 const entries=[entry({...base,nonce:1n},4000),entry({...base,nonce:2n},2000),entry({...base,nonce:3n,redeem:true},1000)];assert.equal(chooseEntries(entries,false,1500000,1)[0].order.nonce,'2');assert.equal(chooseEntries(entries,true,1500000,64).length,1);
});
test('minimum filtering uses actual proportional net budgets, not a misleading average payout',()=>{
 const orders=[{...base,amount:unit,minimum:unit},{...base,amount:2n*unit,minimum:2n*unit}];assert.deepEqual(insufficientMinimumIndexes(orders,[0n,0n],3n*unit,false),[]);
 assert.deepEqual(insufficientMinimumIndexes(orders,[unit/100n,0n],3n*unit,false),[0]);
 assert.deepEqual(insufficientMinimumIndexes(orders,[unit/100n,unit/100n],3n*unit,true),[0,1]);
 const odd=[{...base,amount:3n,minimum:1n},{...base,amount:7n,minimum:1n}];assert.deepEqual(insufficientMinimumIndexes(odd,[0n,0n],10n,false),[]);
});
test('request-size bound also covers chunked and dishonest content-length bodies',async()=>{
 assert.equal(await boundedBody(new Request('https://test',{method:'POST',body:'{}'}),2),'{}');
 await assert.rejects(boundedBody(new Request('https://test',{method:'POST',body:'xxx',headers:{'Content-Length':'1'}}),2),/过大/);
 const body=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('ab'));c.enqueue(new TextEncoder().encode('cd'));c.close();}});
 await assert.rejects(boundedBody(new Request('https://test',{method:'POST',body,duplex:'half'} as any),3),/过大/);
});
