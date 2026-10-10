import {parseAbi,keccak256,stringToHex,encodeFunctionData}from'viem';
import {ASSETS,STABLES,PANCAKE}from'./assets.ts';
import {chainClient,VAULT_ABI,TOKEN_ABI}from'./chain.ts';
import {EXECUTION_ABI,bnbPrice}from'./planner.ts';
import {breached}from'./portfolio.ts';
const adapterAbi=parseAbi(['function fees(uint256) view returns(uint24)','function bid() view returns(uint256)','function ask() view returns(uint256)','function quoteValidUntil() view returns(uint64)']);
const quoterAbi=parseAbi(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) p) returns(uint256,uint160,uint32,uint256)','function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96) p) returns(uint256,uint160,uint32,uint256)']);
type Report={p0:string;p1:string;p2:string;validUntil:number;nonce:string;signature:`0x${string}`};
const triple=(v:bigint[]):[bigint,bigint,bigint]=>{if(v.length!==3)throw new Error('资产数量不是三项');return[v[0],v[1],v[2]];};
export async function makeRebalanceProposal(rpc:string,vault:`0x${string}`,report:Report){
 const now=Math.floor(Date.now()/1000);if(report.validUntil<now+30)throw new Error('等待新的价格签名');
 const c=chainClient(rpc),prices=[report.p0,report.p1,report.p2].map(BigInt),units=ASSETS.map(a=>10n**BigInt(a.decimals));
 const p={p0:prices[0],p1:prices[1],p2:prices[2],validUntil:BigInt(report.validUntil),nonce:BigInt(report.nonce)};
 await c.readContract({address:vault,abi:VAULT_ABI,functionName:'netAssetValue',args:[p,report.signature]});
 const [adapter,executor,nonce,balances]=await Promise.all([c.readContract({address:vault,abi:VAULT_ABI,functionName:'adapter'}),c.readContract({address:vault,abi:VAULT_ABI,functionName:'executor'}),c.readContract({address:vault,abi:VAULT_ABI,functionName:'rebalanceNonce'}),Promise.all(ASSETS.map(a=>c.readContract({address:a.address,abi:TOKEN_ABI,functionName:'balanceOf',args:[vault]})))]);
 const values=balances.map((b,i)=>b*prices[i]/units[i]),total=values.reduce((a,b)=>a+b,0n);if(!breached(values))throw new Error('未达到调仓阈值');
 const [bid,ask,until,fees,gasPrice,bnb]=await Promise.all([c.readContract({address:adapter,abi:adapterAbi,functionName:'bid'}),c.readContract({address:adapter,abi:adapterAbi,functionName:'ask'}),c.readContract({address:adapter,abi:adapterAbi,functionName:'quoteValidUntil'}),Promise.all([0n,1n,2n].map(i=>c.readContract({address:adapter,abi:adapterAbi,functionName:'fees',args:[i]}))),c.getGasPrice(),bnbPrice(rpc)]);
 if(until<BigInt(now+30)||bid===0n||ask===0n)throw new Error('等待有效 IEF 库存报价');
 const weights=[2500n,5000n,2500n];
 const sells=balances.map((b,i)=>{const remaining=total*weights[i]*9980n*units[i]/10000n/10000n/prices[i];return b>remaining?b-remaining:0n;});
 const minOutputs=await Promise.all(sells.map(async(amount,i)=>{
  if(amount===0n)return 0n;if(i===1)return amount*bid/units[i];
  const q=await c.simulateContract({address:PANCAKE.quoter,abi:quoterAbi,functionName:'quoteExactInputSingle',args:[{tokenIn:ASSETS[i].address,tokenOut:STABLES.USDT.address,amountIn:amount,fee:fees[i],sqrtPriceLimitX96:0n}]});return q.result[0]*9995n/10000n;
 }));
 const available=minOutputs.reduce((a,b)=>a+b,0n),held=balances.map((b,i)=>b-sells[i]);
 const availableNav=held.reduce((sum,b,i)=>sum+b*prices[i]/units[i],0n)+available;
 const taskId=keccak256(stringToHex(`56:${vault.toLowerCase()}:${nonce}`));
 for(const guess of [5n,0n,10n,15n,20n]){
  try{
   const finalTotal=availableNav*(10000n-guess)/10000n;
   const buys=held.map((b,i)=>{const goal=finalTotal*weights[i]*units[i]/10000n/prices[i];return goal>b?goal-b:0n;});
   const maxInputs=await Promise.all(buys.map(async(amount,i)=>{
    if(i===1||amount===0n)return 0n;
    const q=await c.simulateContract({address:PANCAKE.quoter,abi:quoterAbi,functionName:'quoteExactOutputSingle',args:[{tokenIn:STABLES.USDT.address,tokenOut:ASSETS[i].address,amount,fee:fees[i],sqrtPriceLimitX96:0n}]});return(q.result[0]*10005n+9999n)/10000n;
   }));
   const otherSpend=maxInputs[0]+maxInputs[2];if(otherSpend>available)continue;
   maxInputs[1]=available-otherSpend;buys[1]=maxInputs[1]*units[1]/ask;
   const args=[taskId,nonce,p,report.signature,triple(sells),triple(minOutputs),triple(buys),triple(maxInputs),0n]as const;
   await c.simulateContract({address:vault,abi:EXECUTION_ABI,functionName:'rebalance',args,account:executor});
   const estimate=await c.estimateContractGas({address:vault,abi:EXECUTION_ABI,functionName:'rebalance',args,account:executor});const gasLimit=estimate*120n/100n,gasUsd=gasLimit*gasPrice*bnb/10n**18n;
   if(gasUsd*10000n>total*10n)throw new Error('调仓gas超过0.1%');
   const finalArgs=[taskId,nonce,p,report.signature,triple(sells),triple(minOutputs),triple(buys),triple(maxInputs),gasUsd]as const;
   await c.simulateContract({address:vault,abi:EXECUTION_ABI,functionName:'rebalance',args:finalArgs,account:executor});
   return{status:'READY_TO_SIGN',chainId:56,id:taskId,nonce:String(nonce),to:vault,data:encodeFunctionData({abi:EXECUTION_ABI,functionName:'rebalance',args:finalArgs}),value:'0',gasLimit:String(gasLimit),gasPrice:String(gasPrice),gasUsd:String(gasUsd),validUntil:Math.min(report.validUntil,Number(until)),automaticExecution:false};
  }catch{/* A failing candidate is never broadcast; try bounded precision adjustments. */}
 }
 throw new Error('没有通过目标配比、库存、滑点和成本检查的原子调仓方案');
}
