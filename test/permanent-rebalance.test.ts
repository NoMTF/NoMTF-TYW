import test from 'node:test';import assert from 'node:assert/strict';
import {restorationPlan} from '../src/permanent-rebalance.ts';
const u=10n**18n,p=[u,u,u,u] as const;
const quote=async(_i:number,n:bigint)=>n*9995n/10000n;
test('four-leg restoration checks inclusive trigger bands and does not trade in-band',async()=>{
 await assert.rejects(restorationPlan([25n*u,25n*u,25n*u,25n*u],p,0n,quote),/trigger/);
 for(const b of [[35n,25n,25n,15n],[15n,28n,28n,29n],[50n,20n,20n,10n]]){
  const plan=await restorationPlan(b.map(v=>v*u) as any,p,0n,quote);assert(plan.finalWeights.every(w=>w>=2485n&&w<=2515n));assert(plan.after>=plan.before*9975n/10000n);assert.equal(plan.buys.reduce((a,b)=>a+b,0n),plan.sells.reduce((a,b)=>a+b,0n)*9995n/10000n);
 }
});
test('plan spends existing cash once, preserves total budget and avoids simultaneous buy/sell same leg',async()=>{
 const plan=await restorationPlan([80n*u,20n*u,20n*u,20n*u],p,20n*u,quote);
 const proceeds=(await Promise.all(plan.sells.map((v,i)=>quote(i,v)))).reduce((a,b)=>a+b,20n*u);
 assert.equal(plan.buys.reduce((a,b)=>a+b,0n),proceeds);for(let i=0;i<4;i++)assert(!(plan.sells[i]>0n&&plan.buys[i]>0n));
});
test('unsafe quotes and missing routes are rejected before preparing an executable transaction',async()=>{
 await assert.rejects(restorationPlan([50n*u,20n*u,20n*u,10n*u],p,0n,async()=>0n),/unavailable/);
 await assert.rejects(restorationPlan([50n*u,20n*u,20n*u,10n*u],p,0n,async(_i,n)=>n/2n),/loss cap/);
 await assert.rejects(restorationPlan([50n*u,20n*u,20n*u,10n*u],p,0n,async(i,n)=>i===1?n*2n:n),/tolerance/);
 await assert.rejects(restorationPlan([0n,0n,0n,0n],p,0n,quote),/Empty/);
 await assert.rejects(restorationPlan([u,u,u,u],[u,u,0n,u],0n,quote),/Invalid/);
});
