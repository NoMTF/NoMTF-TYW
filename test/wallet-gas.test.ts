import {test} from 'node:test';import assert from 'node:assert/strict';
import {withWalletGasPrice} from '../src/wallet-gas.ts';
import {quoteCostChanged} from '../src/quote-safety.ts';
import {tradeFees} from '../src/trade-fees.ts';
const q={mode:'buy' as const,budget:'14890000000000000000',shares:'14760821170000000000',expectedOutputUsdt:'14.718',acquiredValueUsdt:'14.7411',estimatedRefundUsdt:'0.129264',gasPriceWei:'50000000',bnbUsdt:'745.18',indicative:false};
test('14.89-USDT buy does not loop when wallet consistently suggests twice the public RPC gas price',()=>{
 const reviewed=withWalletGasPrice(q,100000000n),fresh=withWalletGasPrice({...q},100000000n);
 assert.equal(quoteCostChanged(reviewed,fresh,false),null);
 assert.equal(tradeFees(fresh,false).executionGasBnb,'0.000093');
 assert.equal(fresh.shares,q.shares);assert.deepEqual(fresh,{...q,gasPriceWei:'100000000'});assert.equal(q.gasPriceWei,'50000000');
});
test('real wallet fee increase updates the review baseline, requires another confirmation, and then settles',()=>{
 const reviewed=withWalletGasPrice(q,100000000n),increased=withWalletGasPrice(q,200000000n);
 assert.match(quoteCostChanged(reviewed,increased,false)!,/费用/);
 assert.equal(quoteCostChanged(increased,withWalletGasPrice(q,200000000n),false),null);
 assert.equal(quoteCostChanged(reviewed,withWalletGasPrice(q,90000000n),false),null);
});
test('invalid wallet fee cannot silently revert to a misleading RPC estimate or reach signing',()=>{
 for(const price of [null,0n,-1n,1n<<256n])assert.throws(()=>withWalletGasPrice(q,price),/有效网络费/);
});
test('sell uses the same wallet fee source without bypassing minimum output or price protection',()=>{
 const sell={...q,mode:'sell' as const,feeReferenceUsdt:'14.89',expectedOutputUsdt:'14.87'};
 const reviewed=withWalletGasPrice(sell,100000000n);
 assert.equal(quoteCostChanged(reviewed,withWalletGasPrice(sell,100000000n),false),null);
 assert.match(quoteCostChanged(reviewed,withWalletGasPrice({...sell,expectedOutputUsdt:'14.7'},100000000n),false)!,/费用|到账/);
});
