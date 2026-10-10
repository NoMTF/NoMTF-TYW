import {encodeFunctionData,formatUnits,type Address} from 'viem';
import {chainClient} from './chain.ts';
import {PERMANENT_ABI,PERMANENT_QUOTER_ABI} from './permanent-chain.ts';
import {PERMANENT_ASSETS,USDT} from './permanent-assets.ts';
import {PANCAKE} from './assets.ts';
const unit=10n**18n;
type Four=readonly [bigint,bigint,bigint,bigint];
type Quote=(i:number,amount:bigint,buy:boolean)=>Promise<bigint>;
export async function restorationPlan(balances:Four,prices:Four,cash:bigint,quote:Quote){
  if(balances.some(v=>v<0n)||prices.some(v=>v<=0n)||cash<0n)throw Error('Invalid balances or prices');
  const values=balances.map((v,i)=>v*prices[i]/unit),before=values.reduce((a,b)=>a+b,cash);
  if(before===0n)throw Error('Empty portfolio');
  const weights=values.map(v=>v*10000n/before);
  if(!weights.some(w=>w<=1500n||w>=3500n))throw Error('Weights are within trigger bands');
  const target=before/4n;
  const sells=values.map((v,i)=>v>target?(v-target)*unit/prices[i]:0n);
  const saleOutputs=await Promise.all(sells.map((v,i)=>v?quote(i,v,false):0n));
  if(saleOutputs.some((v,i)=>sells[i]>0n&&v<=0n))throw Error('Sale route unavailable');
  const available= saleOutputs.reduce((a,b)=>a+b,cash);
  const deficits=values.map(v=>v<target?target-v:0n),totalDeficit=deficits.reduce((a,b)=>a+b,0n);
  if(totalDeficit===0n||available===0n)throw Error('Cannot restore using available cash');
  // Allocate the sale proceeds once. Prefix allocation conserves every stable wei.
  let prefix=0n,allocated=0n;
  const buys=deficits.map(v=>{prefix+=v;const next=available*prefix/totalDeficit,out=next-allocated;allocated=next;return out;});
  const bought=await Promise.all(buys.map((v,i)=>v?quote(i,v,true):0n));
  if(bought.some((v,i)=>buys[i]>0n&&v<=0n))throw Error('Buy route unavailable');
  const afterBalances=balances.map((v,i)=>v-sells[i]+bought[i]);
  const afterValues=afterBalances.map((v,i)=>v*prices[i]/unit),after=afterValues.reduce((a,b)=>a+b,0n),finalWeights=afterValues.map(v=>v*10000n/after);
  if(after<before*9975n/10000n)throw Error('Quoted restoration exceeds 0.25% NAV loss cap');
  if(finalWeights.some(w=>w<2485n||w>2515n))throw Error('Quoted restoration misses target tolerance');
  return {sells,minimumSales:saleOutputs.map(v=>v*9995n/10000n),buys,minimumBuys:bought.map(v=>v*9995n/10000n),before,after,finalWeights};
}
/** Read-only proposal. No signer, private key, transaction submission or operator reimbursement. */
export async function permanentRebalanceProposal(rpc:string,vault:Address,account:Address){
 const client=chainClient(rpc),blockNumber=await client.getBlockNumber(),block=await client.getBlock({blockNumber});
 const [supply,paused,balances,valuation,nonce,lastRebalance]=await Promise.all([
  client.readContract({address:vault,abi:PERMANENT_ABI,functionName:'totalSupply',blockNumber}),
  client.readContract({address:vault,abi:PERMANENT_ABI,functionName:'paused',blockNumber}),
  client.readContract({address:vault,abi:PERMANENT_ABI,functionName:'balances',blockNumber}),
  client.readContract({address:vault,abi:PERMANENT_ABI,functionName:'valuation',blockNumber}),
  client.readContract({address:vault,abi:PERMANENT_ABI,functionName:'rebalanceNonce',blockNumber}),
  client.readContract({address:vault,abi:PERMANENT_ABI,functionName:'lastRebalance',blockNumber}),
 ]);
 if(paused||supply===0n)throw Error('Vault paused or empty');
 if(block.timestamp<lastRebalance+3600n)throw Error('Rebalance cooldown active');
 const cash=await client.readContract({address:USDT,abi:[{type:'function',name:'balanceOf',inputs:[{type:'address',name:'account'}],outputs:[{type:'uint256',name:'balance'}],stateMutability:'view'}],functionName:'balanceOf',args:[vault],blockNumber});
 const plan=await restorationPlan(balances,valuation[3],cash,async(i,amount,buy)=>{
  const asset=PERMANENT_ASSETS[i];const {result}=await client.simulateContract({address:PANCAKE.quoter,abi:PERMANENT_QUOTER_ABI,functionName:'quoteExactInputSingle',args:[{tokenIn:buy?USDT:asset.address,tokenOut:buy?asset.address:USDT,amountIn:amount,fee:asset.fee,sqrtPriceLimitX96:0n}],blockNumber});return result[0];
 });
 const deadline=block.timestamp+300n;
 const args=[nonce,plan.sells as unknown as Four,plan.minimumSales as unknown as Four,plan.buys as unknown as Four,plan.minimumBuys as unknown as Four,deadline] as const;
 // The actual bounded call must simulate successfully for this caller before it is offered.
 await client.simulateContract({address:vault,abi:PERMANENT_ABI,functionName:'rebalance',args,account,blockNumber});
 const data=encodeFunctionData({abi:PERMANENT_ABI,functionName:'rebalance',args});
 const gas=await client.estimateGas({account,to:vault,data}),gasPrice=await client.getGasPrice();
 return {status:'AWAITING_WALLET_SIGNATURE',chainId:56,blockNumber:String(blockNumber),account,vault,nonce:String(nonce),deadline:String(deadline),expiresAt:Date.now()+45000,
   transaction:{to:vault,data,value:'0'},gasUnits:String(gas),gasPriceWei:String(gasPrice),gasBnb:formatUnits(gas*gasPrice,18),
   beforeUsdt:formatUnits(plan.before,18),quotedAfterUsdt:formatUnits(plan.after,18),predictedWeightsBps:plan.finalWeights.map(Number),
   note:'仅准备并模拟交易；尚未广播。调仓 gas 由签名钱包承担，交易损耗影响组合净值。'};
}
