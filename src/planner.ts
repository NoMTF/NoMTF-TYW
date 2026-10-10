import {parseAbi,encodeFunctionData}from'viem';
import {ASSETS,PANCAKE,STABLES}from'./assets.ts';
import {chainClient,VAULT_ABI}from'./chain.ts';
import {formatRaw}from'./portfolio.ts';
export const EXECUTION_ABI=parseAbi([
 'function settleDeposits(uint256[] ids,uint256 totalShares,uint256[3] maxInputs)',
 'function settleRedemptions(uint256[] ids,uint256[3] minOutputs)',
 'function previewMint(uint256) view returns(uint256[3])',
 'function previewRedeem(uint256) view returns(uint256[3])',
 'function previewStableMint(uint256) view returns(uint256)',
 'function previewStableRedeem(uint256) view returns(uint256)',
 'function rebalance(bytes32 taskId,uint256 expectedNonce,(uint256 p0,uint256 p1,uint256 p2,uint256 validUntil,uint256 nonce) p,bytes sig,uint256[3] sells,uint256[3] minOutputs,uint256[3] buys,uint256[3] maxInputs,uint256 gasUsd)',
]);
const adapterAbi=parseAbi(['function fees(uint256) view returns(uint24)','function bid() view returns(uint256)','function ask() view returns(uint256)','function quoteValidUntil() view returns(uint64)']);
const quoteAbi=parseAbi([
 'function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96) p) returns(uint256 amountIn,uint160,uint32,uint256)',
 'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) p) returns(uint256 amountOut,uint160,uint32,uint256)',
]);
const feedAbi=parseAbi(['function decimals() view returns(uint8)','function latestRoundData() view returns(uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)']);
const BNB_USD='0x0567f2323251f0aab15c8dfb1967e4e8a7d42aee';
type Row={id:string;amount:string;minimum:string;redeem:boolean;deadline:number;payoutUsdc?:boolean};
type Report={p0:string;p1:string;p2:string;validUntil:number;nonce:string;signature:`0x${string}`};
const ceil=(a:bigint,b:bigint)=>(a+b-1n)/b;
export async function bnbPrice(rpc:string){
 const c=chainClient(rpc);const[d,r]=await Promise.all([c.readContract({address:BNB_USD,abi:feedAbi,functionName:'decimals'}),c.readContract({address:BNB_USD,abi:feedAbi,functionName:'latestRoundData'})]);
 const now=BigInt(Math.floor(Date.now()/1000));if(r[1]<=0n||r[3]>now||now-r[3]>3600n||r[4]<r[0])throw new Error('BNB/USD预言机过期或无效');return r[1]*10n**18n/10n**BigInt(d);
}
export async function makeBatchProposal(rpc:string,vault:`0x${string}`,rows:Row[],report:Report){
 if(!rows.length||rows.length>64)throw new Error('空批次或超过64笔');
 const now=Math.floor(Date.now()/1000);if(report.validUntil<=now+20)throw new Error('净值报告快过期，等待新报告');
 const client=chainClient(rpc),ids=rows.map(r=>BigInt(r.id)),redeem=rows[0].redeem;
 if(rows.some(r=>r.redeem!==redeem||r.deadline<=now+20||r.payoutUsdc!==rows[0].payoutUsdc))throw new Error('批次类别或期限不一致');
 const p={p0:BigInt(report.p0),p1:BigInt(report.p1),p2:BigInt(report.p2),nonce:BigInt(report.nonce),validUntil:BigInt(report.validUntil)};
 const[adapter,executor,nav]=await Promise.all([client.readContract({address:vault,abi:VAULT_ABI,functionName:'adapter'}),client.readContract({address:vault,abi:VAULT_ABI,functionName:'executor'}),client.readContract({address:vault,abi:VAULT_ABI,functionName:'netAssetValue',args:[p,report.signature]})]);
 const[bid,ask,valid,fees]=await Promise.all([client.readContract({address:adapter,abi:adapterAbi,functionName:'bid'}),client.readContract({address:adapter,abi:adapterAbi,functionName:'ask'}),client.readContract({address:adapter,abi:adapterAbi,functionName:'quoteValidUntil'}),Promise.all([0n,1n,2n].map(i=>client.readContract({address:adapter,abi:adapterAbi,functionName:'fees',args:[i]})))]);
 if(valid<=BigInt(now+20)||bid===0n||ask===0n)throw new Error('IEF库存报价无效');
 const sum=rows.reduce((s,r)=>s+BigInt(r.amount),0n);const minTotal=rows.reduce((s,r)=>s+BigInt(r.minimum),0n);
 const value=redeem?sum*nav[1]/10n**18n:sum;
 if(value<5n*10n**18n)throw new Error('等待合批：当前批次不足5美元');
 let args:any[],fn:'settleDeposits'|'settleRedemptions',expectedValue:bigint;
 if(!redeem){
  const shares=sum*10n**18n/nav[1]*9970n/10000n;
  if(shares<minTotal||rows.some(r=>shares*BigInt(r.amount)/sum<BigInt(r.minimum)))throw new Error('申购最低份额不能满足');
  const need=await client.readContract({address:vault,abi:EXECUTION_ABI,functionName:'previewMint',args:[shares]});
  const inputs=await Promise.all(ASSETS.map(async(a,i)=>{
   if(i===1)return ceil(need[i]*ask,10n**18n);
   const q=await client.simulateContract({address:PANCAKE.quoter,abi:quoteAbi,functionName:'quoteExactOutputSingle',args:[{tokenIn:STABLES.USDT.address,tokenOut:a.address,amount:need[i],fee:fees[i],sqrtPriceLimitX96:0n}]});return ceil(q.result[0]*10010n,10000n);
  }));
  const dust=await client.readContract({address:vault,abi:EXECUTION_ABI,functionName:'previewStableMint',args:[shares]});
  const spending=inputs.reduce((a,b)=>a+b,0n)+dust;if(spending>sum)throw new Error('三腿总成本超过批次金额');
  expectedValue=shares*nav[1]/10n**18n+(sum-spending);args=[ids,shares,inputs];fn='settleDeposits';
 }else{
  const need=await client.readContract({address:vault,abi:EXECUTION_ABI,functionName:'previewRedeem',args:[sum]});
  const outputs=await Promise.all(ASSETS.map(async(a,i)=>{
   if(i===1)return need[i]*bid/10n**18n;
   const q=await client.simulateContract({address:PANCAKE.quoter,abi:quoteAbi,functionName:'quoteExactInputSingle',args:[{tokenIn:a.address,tokenOut:STABLES.USDT.address,amountIn:need[i],fee:fees[i],sqrtPriceLimitX96:0n}]});return q.result[0]*9990n/10000n;
  }));
  const dust=await client.readContract({address:vault,abi:EXECUTION_ABI,functionName:'previewStableRedeem',args:[sum]});expectedValue=outputs.reduce((a,b)=>a+b,0n)+dust;
  if(rows[0].payoutUsdc){
   const converter=await client.readContract({address:vault,abi:VAULT_ABI,functionName:'stableConverter'});
   const fee=await client.readContract({address:converter,abi:parseAbi(['function fee() view returns(uint24)']),functionName:'fee'});
   const q=await client.simulateContract({address:PANCAKE.quoter,abi:quoteAbi,functionName:'quoteExactInputSingle',args:[{tokenIn:STABLES.USDT.address,tokenOut:STABLES.USDC.address,amountIn:expectedValue,fee,sqrtPriceLimitX96:0n}]});expectedValue=q.result[0]*9990n/10000n;
  }
  if(expectedValue<minTotal||rows.some(r=>expectedValue*BigInt(r.amount)/sum<BigInt(r.minimum)))throw new Error('赎回最低到账不能满足');args=[ids,outputs];fn='settleRedemptions';
 }
 // eth_call plus estimateGas: no broadcast and no invented success.
 await client.simulateContract({address:vault,abi:EXECUTION_ABI,functionName:fn,args:args as any,account:executor});
 const [gas,gasPrice,bnb]=await Promise.all([client.estimateContractGas({address:vault,abi:EXECUTION_ABI,functionName:fn,args:args as any,account:executor}),client.getGasPrice(),bnbPrice(rpc)]);
 const gasLimit=ceil(gas*120n,100n),gasBnb=gasLimit*gasPrice,gasUsd=gasBnb*bnb/10n**18n;
 const tradeLoss=value>expectedValue?value-expectedValue:0n;
 if((tradeLoss+gasUsd)*10000n>value*50n)throw new Error('本侧费用加gas超过0.5%，保留另半边成本预算');
 return{status:'READY_TO_SIGN',ids:ids.map(String),chainId:56,to:vault,data:encodeFunctionData({abi:EXECUTION_ABI,functionName:fn,args:args as any}),value:'0',gasLimit:gasLimit.toString(),gasPrice:gasPrice.toString(),gasBnb:formatRaw(gasBnb),gasUsd:formatRaw(gasUsd),tradeLossUsd:formatRaw(tradeLoss),validUntil:Math.min(report.validUntil,Number(valid)),functionName:fn,automaticExecution:false};
}
