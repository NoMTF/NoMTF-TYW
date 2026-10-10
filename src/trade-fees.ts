import {formatUnits,parseUnits} from 'viem';
export type FeeQuote={mode:'buy'|'sell';budget:string;expectedOutputUsdt:string;gasPriceWei:string;bnbUsdt:string|null;feeReferenceUsdt?:string|null;acquiredValueUsdt?:string;estimatedRefundUsdt?:string};
const scale=10n**18n;
export function tradeFees(q:FeeQuote,approvalNeeded=true){
 const price=BigInt(q.gasPriceWei),bnbPrice=q.bnbUsdt?parseUnits(q.bnbUsdt,18):null,gasUnits=q.mode==='buy'?930000n:720000n,approvalUnits=q.mode==='buy'&&approvalNeeded?50000n:0n;
 const convert=(units:bigint)=>bnbPrice===null?null:units*price*bnbPrice/scale;
 const gas=convert(gasUnits),approval=convert(approvalUnits),roundGas=convert(1650000n);
 const input=BigInt(q.budget),output=parseUnits(q.expectedOutputUsdt,18),reference=q.mode==='buy'?input:q.feeReferenceUsdt?parseUnits(q.feeReferenceUsdt,18):null;
 // Sell uses redeemable NAV, never assumes one TYW remains equal to one USDT.
 const deviation=reference===null?null:reference-output,cost=deviation===null?null:deviation>0n?deviation:0n;
 const total=cost!==null&&gas!==null&&approval!==null?cost+(q.mode==='buy'?roundGas!:gas)+approval:null;
 const acquired=q.mode==='buy'&&q.acquiredValueUsdt!==undefined?parseUnits(q.acquiredValueUsdt,18):null,refund=parseUnits(q.estimatedRefundUsdt||'0',18);
 const buyDeviation=acquired===null?null:input-acquired-refund,buyCost=buyDeviation===null?null:buyDeviation>0n?buyDeviation:0n;
 const oneWayTotal=q.mode==='sell'?total:buyCost!==null&&gas!==null&&approval!==null?buyCost+gas+approval:null;
 const fmt=(value:bigint|null)=>value===null?null:formatUnits(value,18);
 return {scope:q.mode==='buy'?'round-trip':'sell',referenceUsdt:fmt(reference),platformFeeUsdt:'0',
  executionGasBnb:formatUnits(gasUnits*price,18),executionGasUsdt:fmt(gas),approvalGasBnb:formatUnits(approvalUnits*price,18),approvalGasUsdt:fmt(approval),
  roundTripGasUsdt:q.mode==='buy'?fmt(roundGas):null,underlyingCostUsdt:fmt(cost),priceDeviationUsdt:fmt(deviation),totalCostUsdt:fmt(total),
  totalCostPercent:total!==null&&reference!==null&&reference>0n?Number(total*1000000n/reference)/10000:null,approvalNeeded:q.mode==='buy'&&approvalNeeded,
  acquiredValueUsdt:fmt(acquired),oneWayUnderlyingCostUsdt:q.mode==='buy'?fmt(buyCost):fmt(cost),oneWayTotalCostUsdt:fmt(oneWayTotal),
  oneWayTotalCostPercent:oneWayTotal!==null&&reference!==null&&reference>0n?Number(oneWayTotal*1000000n/reference)/10000:null,
  estimation:true,slippageTolerancePercent:0.5};
}
