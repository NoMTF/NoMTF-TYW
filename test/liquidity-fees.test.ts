import {test} from 'node:test';import assert from 'node:assert/strict';
import {keccak256,parseEther} from 'viem';import {positionIds,mintedPositionIds,feeHarvestWorthwhile,LP_POSITIONS,LP_TREASURY} from '../src/liquidity-fees.ts';
test('position tracking deduplicates, sorts numerically and rejects malformed or unbounded IDs',()=>{
 assert.deepEqual(positionIds('10,2',['3','02']),[2n,3n,10n]);
 for(const config of['0','-1','1e2',' 2','2,','0x12','9'.repeat(21)])assert.throws(()=>positionIds(config));
 assert.throws(()=>positionIds(undefined,Array.from({length:257},(_,i)=>String(i+1))));
});
test('new LP discovery accepts only position-manager mints directly to the original treasury',()=>{
 const topic=(s:string)=>'0x'+s.replace(/^0x/,'').padStart(64,'0');
 const valid={address:LP_POSITIONS,topics:[keccak256(new TextEncoder().encode('Transfer(address,address,uint256)')),topic('0'),topic(LP_TREASURY),topic('21')] as `0x${string}`[]};
 assert.deepEqual(mintedPositionIds([valid]),['33']);
 assert.deepEqual(mintedPositionIds([{...valid,address:LP_TREASURY},{...valid,topics:[...valid.topics.slice(0,1),topic('1'),...valid.topics.slice(2)] as `0x${string}`[]},{...valid,topics:[...valid.topics.slice(0,2),topic('2'),valid.topics[3]] as `0x${string}`[]}]),[]);
});
test('zero fee claims and total inventory below the addition floor cannot consume gas',()=>{
 const floor=parseEther('20');assert.equal(feeHarvestWorthwhile(0n,parseEther('100'),floor),false);
 assert.equal(feeHarvestWorthwhile(parseEther('0.05'),0n,floor),false);
 assert.equal(feeHarvestWorthwhile(parseEther('2'),parseEther('18'),floor),true);
 assert.equal(feeHarvestWorthwhile(parseEther('2'),parseEther('18')-1n,floor),false);
});
