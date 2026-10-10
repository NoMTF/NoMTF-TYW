import test from'node:test';import assert from'node:assert/strict';
import {breached,portfolioValues,weights,targetTrades,transition,decimalRaw,costBudget,USD_UNIT}from'../src/portfolio.ts';
import {xQuote}from'../src/quotes.ts';
test('所有触发边界包含等号；中间区域完全不调仓',()=>{
 for(const v of [[15n,50n,35n],[35n,40n,25n],[35n,30n,35n],[15n,70n,15n],[25n,40n,35n],[25n,60n,15n]])assert.equal(breached(v),true);
 assert.equal(breached([25n,50n,25n]),false);assert.equal(breached([16n,68n,16n]),false);assert.equal(breached([0n,0n,0n]),false);
});
test('不能因百分比四舍五入提前触发',()=>{assert.equal(breached([34999n,45002n,19999n]),false);assert.equal(breached([35000n,45000n,20000n]),true);});
test('价格过期、不可信、未来及缺腿都拒绝估值',()=>{const p=[1,1,1].map(()=>({usdPerToken:USD_UNIT,observedAt:100,trusted:true}));assert.throws(()=>portfolioValues([1n,1n,1n],p,230));assert.throws(()=>portfolioValues([1n,1n,1n],p.map(a=>({...a,trusted:false})),100));assert.throws(()=>portfolioValues([1n,1n],p,100));});
test('原始18/18/6位资产金额不能串用或重复计入展示乘数',()=>{const p=[500n,100n,2000n].map(v=>({usdPerToken:v*USD_UNIT,observedAt:100,trusted:true}));const v=portfolioValues([USD_UNIT/20n,USD_UNIT/2n,12500n],p,100);assert.deepEqual(weights(v),[2500n,5000n,2500n]);});
test('交易计划从当前权重计算，不因小时轮询生成交易',()=>{const v=[50n,50n,25n].map(n=>n*USD_UNIT);const trades=targetTrades(v,[1000n,100n,2000n].map(n=>n*USD_UNIT));assert.equal(trades[0].side,'sell');assert.equal(trades[1].amountRaw,USD_UNIT/8n);assert.equal(trades[2].amountRaw,3125n);});
test('SUBMITTED只是进行中；终态不能被覆盖成成功',()=>{assert.equal(transition('READY','SUBMITTED'),'SUBMITTED');assert.throws(()=>transition('QUEUED','CONFIRMED'));assert.throws(()=>transition('CANCELLED','CONFIRMED'));assert.throws(()=>transition('SUBMITTED','QUEUED'));});
test('所有磨损纳入一分钱预算，包含持有期调仓成本',()=>{assert.equal(costBudget(USD_UNIT,0n,0n,USD_UNIT/200n,USD_UNIT/200n).withinBudget,true);assert.equal(costBudget(USD_UNIT,0n,1n,USD_UNIT/200n,USD_UNIT/200n).withinBudget,false);});
test('金额使用十进制整数，不接受指数、负数或超精度',()=>{assert.equal(decimalRaw('0.1',18),USD_UNIT/10n);for(const s of ['1e3','-1','0.0000001','nan'])assert.throws(()=>decimalRaw(s,6));});
test('X市场最小金额解析；不会伪装成已成交',async()=>{const mock=async()=>new Response(JSON.stringify({messageType:'ERROR',message:{error:'Amount is below OrderBook level. Min amount: 2.01'}}),{status:400});const q=await xQuote(0,USD_UNIT/4n,undefined,false,mock as typeof fetch);assert.equal(q.ok,false);assert.equal(q.minimumUsd,'2.01');});
test('X未知订单返回结构不得被当作可执行报价',async()=>{const mock=async()=>Response.json({messageType:'PRICE_RESPONSE',message:{bestOrder:{order:{}}}});const q=await xQuote(1,USD_UNIT,undefined,false,mock as typeof fetch);assert.equal(q.ok,false);});
test('X报价只计算本人收款并取拍卖保底数量，忽略第三方费用',async()=>{
 const me='0x1111111111111111111111111111111111111111';
 const mock=async()=>Response.json({messageType:'PRICE_RESPONSE',message:{bestOrder:{order:{permitData:{domain:{chainId:56}},orderInfo:{outputs:[{token:'0xa486a0a05250e8621ba3b26c3bbc517145eba619',recipient:me,startAmount:'110',endAmount:'100'},{token:'0xa486a0a05250e8621ba3b26c3bbc517145eba619',recipient:'0x2222222222222222222222222222222222222222',startAmount:'1000',endAmount:'1000'}]}}}}});
 assert.equal((await xQuote(1,USD_UNIT,me,false,mock as typeof fetch)).outputRaw,'100');
});
