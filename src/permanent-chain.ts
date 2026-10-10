import {parseAbi,formatUnits,parseUnits,type Address} from 'viem';
import {chainClient} from './chain.ts';
import {PERMANENT_ASSETS,USDT,WBNB} from './permanent-assets.ts';
import {PANCAKE} from './assets.ts';
import {tradeFees} from './trade-fees.ts';
import {redeemProjection} from './quote-safety.ts';
export const PERMANENT_ABI=parseAbi([
 'function totalSupply() view returns(uint256)','function owner() view returns(address)','function paused() view returns(bool)',
 'function balanceOf(address) view returns(uint256)','function allowance(address,address) view returns(uint256)','function approve(address,uint256) returns(bool)',
 'function balances() view returns(uint256[4])','function rebalanceNonce() view returns(uint256)','function lastRebalance() view returns(uint256)',
 'function cumulativeRebalanceCost() view returns(uint256)','function oracle() view returns(address)',
 'function valuation() view returns(uint256 value,uint256 perShare,uint256[4] weights,uint256[4] prices)',
 'function previewMint(uint256) view returns(uint256[4] required,uint256 requiredStable)',
 'function previewRedeem(uint256) view returns(uint256[4] amounts,uint256 stableOut)',
 'function buy(uint256 budget,uint256 shares,uint256[4] limits,uint256 deadline) returns(uint256 spent)',
 'function sell(uint256 shares,uint256 minimumStable,uint256[4] minimumLegs,uint256 deadline) returns(uint256 out)',
 'function redeemInKind(uint256 shares,uint256[4] minimum,uint256 minimumStable)',
 'function rebalance(uint256 expectedNonce,uint256[4] sellAmounts,uint256[4] minimumSales,uint256[4] buyBudgets,uint256[4] minimumBuys,uint256 deadline)',
 'event Bought(address indexed user,uint256 shares,uint256 spent,uint256 refund)',
 'event Redeemed(address indexed user,uint256 shares,uint256 stableOut,bool inKind)',
]);
export const PERMANENT_QUOTER_ABI=parseAbi([
 'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) p) returns(uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
 'function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96) p) returns(uint256 amountIn,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
]);
const scale=10n**18n;
export async function permanentQuote(rpc:string,vault:Address,amount:bigint,mode:'buy'|'sell') {
  if(amount<parseUnits('0.1',18)||amount>parseUnits('1000',18))throw new Error('报价范围为 0.1–1000');
  const client=chainClient(rpc),blockNumber=await client.getBlockNumber(),block=await client.getBlock({blockNumber});
  const supply=await client.readContract({address:vault,abi:PERMANENT_ABI,functionName:'totalSupply',blockNumber});
  const exactIn=async(i:number,input:bigint,buy=true)=>{
    if(!input)return 0n;const a=PERMANENT_ASSETS[i];
    const {result}=await client.simulateContract({address:PANCAKE.quoter,abi:PERMANENT_QUOTER_ABI,functionName:'quoteExactInputSingle',args:[{tokenIn:buy?USDT:a.address,tokenOut:buy?a.address:USDT,amountIn:input,fee:a.fee,sqrtPriceLimitX96:0n}],blockNumber});return result[0];
  };
  const exactOut=async(i:number,out:bigint)=>{
    const a=PERMANENT_ASSETS[i];const {result}=await client.simulateContract({address:PANCAKE.quoter,abi:PERMANENT_QUOTER_ABI,functionName:'quoteExactOutputSingle',args:[{tokenIn:USDT,tokenOut:a.address,amount:out,fee:a.fee,sqrtPriceLimitX96:0n}],blockNumber});return result[0];
  };
  let shares=amount,output=0n,limits:bigint[]=[],required:bigint[]=[],refund=0n,feeReferenceUsdt:string|null=null,acquiredValueUsdt:string|undefined,requiredCash=0n,prices:readonly bigint[]|undefined,indicative=false;
  if(mode==='buy'){
    if(supply===0n){required=await Promise.all(PERMANENT_ASSETS.map((_,i)=>exactIn(i,i===3?amount-3n*(amount/4n):amount/4n)));limits=required.map(v=>v*995n/1000n);}
    else {
      const [,perShare,,assetPrices]=await client.readContract({address:vault,abi:PERMANENT_ABI,functionName:'valuation',blockNumber});prices=assetPrices;
      if(perShare===0n)throw new Error('无法取得净值');shares=amount*scale/perShare*99n/100n;
      for(let tries=0;tries<4;tries++){
        const [need,cash]=await client.readContract({address:vault,abi:PERMANENT_ABI,functionName:'previewMint',args:[shares],blockNumber});required=[...need];requiredCash=cash;
        const costs=await Promise.all(required.map((v,i)=>exactOut(i,v)));limits=costs.map(v=>v*1005n/1000n+1n);const max=limits.reduce((a,b)=>a+b,cash);
        if(max<=amount){refund=amount-costs.reduce((a,b)=>a+b,cash);break;}shares=shares*amount/max*999n/1000n;
        if(tries===3)throw new Error('无法在预算内取得四项资产');
      }
    }
    if(shares===0n||required.some(v=>v===0n))throw new Error('金额过小');
    const back=await Promise.all(required.map((v,i)=>exactIn(i,v,false)));output=back.reduce((a,b)=>a+b,refund);
    try{if(!prices){const valuation=await client.readContract({address:vault,abi:PERMANENT_ABI,functionName:'valuation',blockNumber});prices=valuation[3];}acquiredValueUsdt=formatUnits(required.reduce((sum,v,i)=>sum+v*prices![i]/scale,requiredCash),18);}catch{/* Unknown asset valuation must not invent a one-way fee. */}
  }else{
    if(supply===0n)throw new Error('尚无组合持仓，无法测算卖出');
    let assets:readonly bigint[],cash:bigint;
    if(amount<=supply){[assets,cash]=await client.readContract({address:vault,abi:PERMANENT_ABI,functionName:'previewRedeem',args:[amount],blockNumber});}
    else{
      const [held,stableCash]=await Promise.all([client.readContract({address:vault,abi:PERMANENT_ABI,functionName:'balances',blockNumber}),client.readContract({address:USDT,abi:parseAbi(['function balanceOf(address) view returns(uint256)']),functionName:'balanceOf',args:[vault],blockNumber})]);
      const projection=redeemProjection(supply,held,stableCash,amount);assets=projection.amounts;cash=projection.cash;indicative=true;
    }
    required=[...assets];
    const proceeds=await Promise.all(required.map((v,i)=>exactIn(i,v,false)));limits=proceeds.map(v=>v*995n/1000n);output=proceeds.reduce((a,b)=>a+b,cash);
    try{const [,perShare]=await client.readContract({address:vault,abi:PERMANENT_ABI,functionName:'valuation',blockNumber});feeReferenceUsdt=formatUnits(amount*perShare/scale,18);}catch{/* Missing NAV must not become a misleading fee percentage. */}
  }
  // Independent fixed-block reverse quotes. Sequential actual fork benchmark is served separately.
  const gasPrice=await client.getGasPrice();let bnbUsdt:string|null=null;
  try{const {result}=await client.simulateContract({address:PANCAKE.quoter,abi:PERMANENT_QUOTER_ABI,functionName:'quoteExactInputSingle',args:[{tokenIn:WBNB,tokenOut:USDT,amountIn:parseUnits('0.01',18),fee:500,sqrtPriceLimitX96:0n}],blockNumber});bnbUsdt=formatUnits(result[0]*100n,18);}catch{}
  const roundTripGas=mode==='buy'?1650000n:720000n,gasBnb=formatUnits(roundTripGas*gasPrice,18),gasUsdt=bnbUsdt?Number(bnbUsdt)*Number(gasBnb):null;
  const gross=Number(formatUnits(amount,18)),back=Number(formatUnits(output,18));
  return{chainId:56,vault,mode,blockNumber:String(blockNumber),at:Number(block.timestamp)*1000,expiresAt:Date.now()+45000,first:supply===0n,budget:String(amount),shares:String(shares),limits:limits.map(String),required:required.map(String),expectedOutputUsdt:formatUnits(output,18),minimumStable:String(output*995n/1000n),estimatedRefundUsdt:formatUnits(refund,18),indicative,executionConstraint:indicative?'EXCEEDS_TOTAL_SUPPLY':null,
    independentQuote:true,gasPriceWei:String(gasPrice),gasEstimateUnits:String(roundTripGas),gasBnb,gasUsdt,bnbUsdt,approvalGasExcluded:true,
    approximateRoundTripCostPercent:mode==='buy'&&gasUsdt!==null?(gross-back+gasUsdt)/gross*100:null,
    feeReferenceUsdt,acquiredValueUsdt,fees:tradeFees({mode,budget:String(amount),expectedOutputUsdt:formatUnits(output,18),gasPriceWei:String(gasPrice),bnbUsdt,feeReferenceUsdt:feeReferenceUsdt||undefined,acquiredValueUsdt,estimatedRefundUsdt:formatUnits(refund,18)}),
    note:'固定区块独立报价；本次买入成本与即时买卖往返成本分别展示。gas 为保守估算，首次授权按需计入；不是未来成交费用保证。'};
}
