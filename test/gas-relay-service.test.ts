import {test} from 'node:test';import assert from 'node:assert/strict';
import {privateKeyToAccount} from 'viem/accounts';import {recoverTypedDataAddress,keccak256,encodeAbiParameters} from 'viem';
import {relayFee,approvalGasWei,parseRelayRequest,relayDomain,relayMessage,relayLimitsHash,RELAY_TYPES,RELAY_LIMITS,RELAY_GAS} from '../src/gas-relay.ts';
const E18=10n**18n,executor='0x1111111111111111111111111111111111111111',relay='0x2222222222222222222222222222222222222222';
const user=privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'),now=1_800_000_000n;
const wire=(over:Record<string,unknown>={})=>({request:{owner:user.address,executor,mode:0,feeAsset:0,budget:String(10n*E18),shares:String(99n*E18/10n),limits:['1','2','3','4'],minNetStable:'0',fee:String(55n*10n**15n),nonce:'0',deadline:String(now+600n),...over},signature:'0x'+'11'.repeat(65)});

test('relay fee covers executor gas with headroom, rounds up to 0.001 USDT and never drops below 0.01 USDT',()=>{
 const price=50_000_000n,bnb=752n*E18,fee=relayFee('buy',price,bnb),cost=RELAY_GAS.buy*price*bnb/E18;
 assert.ok(fee>=cost*120n/100n+3n*10n**15n,'fee must exceed gas cost plus margin');assert.equal(fee%10n**15n,0n);
 assert.ok(fee<10n**17n,'a normal BSC buy costs well under 0.1 USDT');assert.ok(relayFee('sell',price,bnb)<fee);
 assert.equal(relayFee('buy',1n,E18),RELAY_LIMITS.minFee);
 assert.equal(approvalGasWei(price),RELAY_GAS.approve*price*130n/100n);
});
test('a valid signed buy request parses; executor, fee bounds, deadline and dust amounts are enforced',()=>{
 const {request,signature}=parseRelayRequest(wire(),executor,now);assert.equal(request.mode,0);assert.equal(request.fee,55n*10n**15n);assert.equal(signature.length,132);
 assert.throws(()=>parseRelayRequest(wire({executor:relay}),executor,now),/代付地址/);
 assert.throws(()=>parseRelayRequest(wire({feeAsset:1}),executor,now),/USDT/);
 assert.throws(()=>parseRelayRequest(wire({fee:'1'}),executor,now),/网络费/);
 assert.throws(()=>parseRelayRequest(wire({fee:String(2n*E18)}),executor,now),/网络费/);
 assert.throws(()=>parseRelayRequest(wire({budget:String(10n**17n)}),executor,now),/一半/);
 assert.throws(()=>parseRelayRequest(wire({deadline:String(now+5n)}),executor,now),/过期/);
 assert.throws(()=>parseRelayRequest(wire({deadline:String(now+3600n)}),executor,now),/过期/);
 assert.throws(()=>parseRelayRequest(wire({budget:'1.5'}),executor,now),/格式/);
 assert.throws(()=>parseRelayRequest(wire({limits:['1','2','3']}),executor,now),/报价/);
 assert.throws(()=>parseRelayRequest({...wire(),signature:'0x12'},executor,now),/签名/);
});
test('sell requests must carry a net USDT minimum and no budget',()=>{
 const sell={mode:1,budget:'0',minNetStable:String(4n*E18)};assert.equal(parseRelayRequest(wire(sell),executor,now).request.mode,1);
 assert.throws(()=>parseRelayRequest(wire({...sell,minNetStable:'0'}),executor,now),/卖出/);
 assert.throws(()=>parseRelayRequest(wire({...sell,budget:'1'}),executor,now),/卖出/);
});
test('typed data matches the contract layout: limits are hashed as abi.encode(uint256[4]) and the owner signature recovers',async()=>{
 const {request}=parseRelayRequest(wire(),executor,now);
 assert.equal(relayLimitsHash(request.limits),keccak256(encodeAbiParameters([{type:'uint256'},{type:'uint256'},{type:'uint256'},{type:'uint256'}],[1n,2n,3n,4n])));
 const signature=await user.signTypedData({domain:relayDomain(relay),types:RELAY_TYPES,primaryType:'TradeRequest',message:relayMessage(request)});
 assert.equal(await recoverTypedDataAddress({domain:relayDomain(relay),types:RELAY_TYPES,primaryType:'TradeRequest',message:relayMessage(request),signature}),user.address);
 const changed={...request,fee:request.fee+1n};
 assert.notEqual(await recoverTypedDataAddress({domain:relayDomain(relay),types:RELAY_TYPES,primaryType:'TradeRequest',message:relayMessage(changed),signature}),user.address);
});
