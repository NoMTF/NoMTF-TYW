import {tradeFees,type FeeQuote} from './trade-fees.ts';
import {parseUnits} from 'viem';
export function redeemProjection(supply:bigint,holdings:readonly bigint[],cash:bigint,shares:bigint){
 if(supply<=0n||shares<=0n||cash<0n||holdings.length!==4||holdings.some(v=>v<0n))throw Error('无法取得有效持仓');
 return{amounts:holdings.map(v=>v*shares/supply),cash:cash*shares/supply,indicative:shares>supply};
}
export function quoteCostChanged(reviewed:FeeQuote&{shares:string;indicative?:boolean},current:FeeQuote&{shares:string;indicative?:boolean},approvalNeeded:boolean){
 if(reviewed.mode!==current.mode||reviewed.budget!==current.budget)throw Error('报价与原订单不匹配');
 if(current.indicative)return '输入数量超过当前总发行量；这是测算报价，不能成交。';
 const old=tradeFees(reviewed,approvalNeeded),next=tradeFees(current,approvalNeeded);
 if(old.oneWayTotalCostPercent===null||next.oneWayTotalCostPercent===null)return '暂时无法完整核对费用，请重新预估后再交易。';
 const oldCost=parseUnits(old.oneWayTotalCostUsdt!,18),newCost=parseUnits(next.oneWayTotalCostUsdt!,18),oldRef=parseUnits(old.referenceUsdt!,18),newRef=parseUnits(next.referenceUsdt!,18);
 if(newCost*oldRef*1000n>oldCost*newRef*1000n+oldRef*newRef||BigInt(current.gasPriceWei)*100n>BigInt(reviewed.gasPriceWei)*110n)return '费用高于刚才预估，已更新报价，请核对后重试。';
 if(current.mode==='sell'&&parseUnits(current.expectedOutputUsdt,18)*1000n<parseUnits(reviewed.expectedOutputUsdt,18)*995n)return '预计到账比刚才下降超过 0.5%，请核对新报价后重试。';
 if(current.mode==='buy'&&BigInt(current.shares)*1000n<BigInt(reviewed.shares)*995n)return '预计份额比刚才下降超过 0.5%，请核对新报价后重试。';
 return null;
}
export function portfolioAllocation(state:any){
 if(!state)return{kind:'unavailable',weights:null,cashBps:null};
 if(state.supply==='0')return{kind:'target',weights:[2500,2500,2500,2500],cashBps:0};
 const w=state.valuation?.weightsBps;
 if(!Array.isArray(w)||w.length!==4||w.some(v=>!Number.isInteger(v)||v<0||v>10000)||w.reduce((a,b)=>a+b,0)>10000)return{kind:'unavailable',weights:null,cashBps:null};
 return{kind:'actual',weights:w as number[],cashBps:10000-w.reduce((a,b)=>a+b,0)};
}
