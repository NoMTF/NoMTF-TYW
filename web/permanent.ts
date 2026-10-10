import './style.css';
import {BrowserProvider,Contract,parseEther,formatEther,isAddress} from 'ethers';
import {PERMANENT_ASSETS,USDT} from '../src/permanent-assets.ts';
import {PERMANENT_ABI} from '../src/permanent-chain.ts';
import {TOKEN_ABI} from '../src/chain.ts';
import {NATIVE_TEST_ROUTER_ABI} from '../src/native-test.ts';
import {PANCAKE} from '../src/assets.ts';
import {WBNB} from '../src/permanent-assets.ts';
import {installBatch} from './batch.ts';
type Injected={request:(a:{method:string;params?:unknown[]})=>Promise<any>;on?:(event:string,cb:()=>void)=>void};
declare global{interface Window{okxwallet?:Injected}}
const app=document.querySelector<HTMLDivElement>('#app')!;
const esc=(v:unknown)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const short=(v:string)=>v?`${v.slice(0,6)}…${v.slice(-4)}`:'—';
const number=(v:unknown,places=4)=>v==null?'—':Number(v).toLocaleString('en-US',{maximumFractionDigits:places});
let state:any=null,provider:BrowserProvider|null=null,address='',mode:'buy'|'sell'='buy',quote:any=null,busy=false,fundingQuote:any=null,rebalanceQuote:any=null;
let batchUi:ReturnType<typeof installBatch>|null=null;
const storageKey='nomtf:permanent-transactions';
let transactions:{hash:string;mode:string;status:string;at:number}[]=[];
try{transactions=JSON.parse(localStorage.getItem(storageKey)||'[]').filter((t:any)=>/^0x[0-9a-f]{64}$/i.test(t.hash)).slice(-20);}catch{}
app.innerHTML=`<header class="top"><a class="brand" href="/"><img class="token-avatar" src="/token-icon.png" alt="NoMTF 头像"><span>NoMTF<small>TYW / BNB CHAIN</small></span></a><nav><a href="#portfolio">组合</a><a href="#rules">规则</a><button id="wallet" class="wallet">连接 OKX 钱包 ↗</button></nav></header>
<main><section class="hero"><div><div class="eyebrow">THE PERMANENT PORTFOLIO</div><h1>四份资产。<br><span>一个组合。</span></h1><p>股票 · 长期国债 · 黄金 · 短期国债<br>各占 25%，首笔买入自动建立真实持仓。</p></div><aside class="hero-stat"><span class="pill" id="status">读取链上状态</span><div class="nav-label">每份真实资产估值 / USDT</div><div class="nav-value" id="nav">—<small>USDT</small></div><div class="stat-row"><span>平台申购 / 赎回费</span><strong>0%</strong></div><div class="stat-row"><span>资产储备</span><strong>链上余额可核验</strong></div><p>首笔交易无需站方种子本金。估值使用交易池时间加权价格，TYW 不固定锚定一美元。</p></aside></section>
<div id="notice" class="notice">核对固定路线与链上预言机…</div>
<section class="workspace"><article class="panel portfolio" id="portfolio"><div class="panel-head"><h2>组合储备</h2><span class="muted">实验版本 · 四项实物支持代币</span></div><div class="allocation permanent-allocation"><div class="segment stock">25%</div><div class="segment bond">25%</div><div class="segment gold">25%</div><div class="segment cash">25%</div></div><div id="assets"></div><div class="totals"><span>流通份额<b id="supply">—</b></span><span>组合估值<b id="total">—</b></span></div><p class="footnote">无预铸币；四项资产买入失败时整笔交易回滚。发行方、跨链表示及池子流动性仍会影响资产价值和赎回能力。</p></article>
<article class="panel trade"><div class="tabs"><button class="active" id="buy-tab">USDT 申购</button><button id="sell-tab">赎回 USDT</button></div><label id="amount-label" for="amount">申购金额 · USDT</label><div class="amount-input"><input id="amount" inputmode="decimal" maxlength="24" value="1"><span id="amount-unit">USDT</span></div><div class="presets"><button data-amount="1">1</button><button data-amount="10">10</button><button data-amount="50">50</button></div><div class="stat-row"><span>我的 TYW</span><b id="balance">—</b></div><button class="secondary" id="quote">查看四项资产报价与费用</button><div id="quote-details" class="message" aria-live="polite"></div><button class="primary" id="trade" disabled>先取得报价</button><div id="message" class="message" role="status" aria-live="polite"></div><button class="text-button" id="add-token">添加 TYW 到钱包</button><button class="text-button" id="in-kind">按四项底层资产赎回</button><div class="test-funding"><p class="footnote">小额实测：先将 0.0018 BNB 换成 USDT，到账到你自己的钱包；再用 1 USDT 申购、赎回检查。每一步都由钱包显示费用并签名。</p><button class="secondary" id="fund-quote">准备 BNB → USDT 测试资金</button><div class="message" id="fund-details" aria-live="polite"></div><button class="secondary" id="fund-sign" hidden>在钱包签名兑换 0.0018 BNB</button></div><p class="footnote">报价显示交易损耗与 gas 估算；首次授权另计。钱包签名后直接链上交割。1 USDT 单独买卖当前达不到总损耗 1% 的目标，合批功能尚未上线。</p></article></section>
<section class="panel order-panel"><div class="panel-head"><h2>本设备交易进度</h2><button id="refresh" class="text-button">刷新 ↻</button></div><div class="steps"><span>01 取得实时报价</span><span>02 钱包授权 / 签名</span><span>03 等待链上确认</span><span>04 核验储备与到账</span></div><div id="transactions" class="empty">没有提交过交易。</div></section>
<section class="rules" id="rules"><div><div class="eyebrow">CHECK HOURLY. TRADE ON A TRIGGER.</div><h2>每小时检查。<br>触线后才申请调仓。</h2><p>任一资产达到 15% 或 35%，四项资产共同恢复至各 25%。一次调仓使用一个链上序号。</p><p>目前 Worker 负责检查与发出待签名状态，实际调仓尚需用户或管理员钱包签名。不会显示成已经自动成交。</p></div><div class="rule-table">${PERMANENT_ASSETS.map(a=>`<div><b>${a.symbol}</b><span>15% — 35%</span><strong>目标 25%</strong></div>`).join('')}<p>30 分钟和 60 分钟时间加权价校验、最低流动性校验、0.25% 调仓交易损耗上限。调仓 gas 另计。</p></div></section>
<section class="panel"><div class="panel-head"><h2>链上运行状态</h2><span class="pill dim">可核验</span></div><div class="technical-grid"><div><span>TYW / 金库合约</span><a id="vault-link">—</a></div><div><span>最近小时检查</span><b id="last-check">—</b></div><div><span>调仓状态</span><b id="task">—</b></div><div><span>累计调仓交易损耗</span><b id="cost">—</b></div></div><p class="footnote">可在 OKX 钱包内打开本站、用 USDT 申购并自定义添加 TYW。尚未接入 OKX 聚合器 Swap，添加代币不会自动建立兑换池。</p><a class="text-button" href="/implementation.json" target="_blank" rel="noopener noreferrer">查看分叉测试与部署记录 ↗</a></section>
</main><footer><span>© 2026 NoMTF · TYW</span><span>真实资产支持 · 非收益承诺</span><a href="https://bscscan.com" target="_blank" rel="noopener noreferrer">BNB Chain ↗</a></footer>`;
document.querySelector('main')!.insertAdjacentHTML('beforeend','<section class="panel"><div class="panel-head"><h2>提交触线调仓</h2><span class="muted">钱包签名后才执行</span></div><p class="footnote">先检查当前权重，再取得经过合约模拟的完整交易。签名钱包支付 gas；四项资产必须共同恢复目标比例，超出损耗上限时整笔回滚。</p><button class="secondary" id="rebalance-prepare">检查并准备调仓</button><div class="message" id="rebalance-details" aria-live="polite"></div><button class="secondary" id="rebalance-sign" hidden>在钱包签名本次调仓</button></section>');
document.querySelector('main')!.insertAdjacentHTML('beforeend','<section class="panel operator"><div class="panel-head"><h2>小额合批费用验证</h2><span class="pill dim">队列尚未开放</span></div><p>真实池子的本地分叉：每人 1 USDT，买卖两侧各凑齐 64 笔后，总损耗约 <strong>0.954%</strong>，已包含交易损耗、实际支付的执行费和首次授权。执行费足以覆盖 gas，无需站方补贴。</p><p class="footnote">捕获时点 gas 为 0.05 gwei、BNB 约 739.6 USDT。32 人合批仍约 1.019%；单笔交易费用更高。等待凑单时间、未来 gas、价格波动及持有期间调仓费用没有得到保证。合批候选已部署并保持暂停，没有替换本页金库。</p><a class="text-button" href="/implementation.json" target="_blank" rel="noopener noreferrer">核对每批 gas、费用和独立部署记录 ↗</a></section>');
const el=(id:string)=>document.getElementById(id)!;
const amount=()=> (el('amount') as HTMLInputElement).value;
const message=(s:string,bad=false)=>{el('message').textContent=s;el('message').classList.toggle('bad',bad);};
async function api(path:string){const r=await fetch(path),data:any=await r.json();if(!r.ok)throw new Error(data.error||'暂时不可用');return data;}
function renderTransactions(){el('transactions').innerHTML=transactions.length?transactions.slice().reverse().map(t=>`<div class="order"><div><b>${esc(t.mode)}</b><small>${esc(new Date(t.at).toLocaleString())}</small></div><b>${esc(t.status)}</b><a href="https://bscscan.com/tx/${esc(t.hash)}" target="_blank" rel="noopener noreferrer">${esc(short(t.hash))} ↗</a></div>`).join(''):'没有提交过交易。';localStorage.setItem(storageKey,JSON.stringify(transactions));}
function render(){
  if(!state)return;
  const labels:Record<string,string>={PAUSED:'● 申购暂停',FIRST_BUY_READY:'● 可由首位买家建立持仓',ACTIVE:'● 储备已建立',ORACLE_UNAVAILABLE:'● 时间加权估值暂不可用'};
  el('status').textContent=labels[state.status]||'● 状态待核验';el('nav').innerHTML=`${number(state.valuation?.perShareUsdt,6)}<small>USDT</small>`;
  el('supply').textContent=number(state.supply,6)+' TYW';el('total').textContent=number(state.valuation?.totalUsdt,4)+' USDT';
  el('notice').textContent=state.paused?'合约申购与 USDT 赎回暂停；底层资产赎回仍可用。':!state.oracleReady?'交易池历史或流动性未通过检查，报价与交易可能不可用。':state.supply==='0'?'尚无流通份额、尚无买家资金入库。首笔成功申购会在同一笔交易中建立四项持仓。':'按实际储备发行份额；每笔交易由你的钱包签名。';
  el('assets').innerHTML=PERMANENT_ASSETS.map((a,i)=>`<div class="asset-row"><span class="asset-icon ${['stock','bond','gold','cash'][i]}">${a.symbol.slice(0,1)}</span><div class="asset-name"><b>${a.symbol}</b><small>${a.role}</small></div><div class="asset-number"><b>${state.supply==='0'?'尚未建仓':state.valuation?(state.valuation.weightsBps[i]/100).toFixed(2)+'%':'估值待核验'}</b><small>${number(formatEther(state.balances[i]),8)} 枚</small></div><a href="https://bscscan.com/token/${a.address}" target="_blank" rel="noopener noreferrer" aria-label="查看 ${a.symbol}">↗</a></div>`).join('');
  const link=el('vault-link') as HTMLAnchorElement;link.textContent=state.vault;link.href=`https://bscscan.com/address/${state.vault}`;link.target='_blank';link.rel='noopener noreferrer';
  el('last-check').textContent=state.lastCheck?new Date(state.lastCheck.at).toLocaleString()+' · '+state.lastCheck.result:'等待首次检查';el('task').textContent=state.task?.status||'无待执行调仓';el('cost').textContent=number(state.rebalanceCostUsdt,6)+' USDT';
  const button=el('trade') as HTMLButtonElement;button.disabled=busy||!quote||!address||state.paused;button.textContent=!quote?'先取得报价':!address?'先连接钱包':mode==='buy'?'按此报价申购':'按此报价赎回';
}
async function loadState(){try{state=await api('/api/state');render();await walletBalance();await batchUi?.refresh();}catch{el('notice').textContent='链上读取暂时不可用，请刷新。';(el('trade') as HTMLButtonElement).disabled=true;}}
async function walletBalance(){if(provider&&address&&isAddress(state?.vault||''))el('balance').textContent=number(formatEther(await new Contract(state.vault,PERMANENT_ABI,provider).balanceOf(address)),6);}
function invalidate(){quote=null;el('quote-details').textContent='';render();}
async function connect(){
  try{const p=(window.okxwallet||window.ethereum) as Injected|undefined;if(!p){message('请在 OKX 钱包的 DApp 浏览器中打开本站，或使用浏览器钱包插件。',true);return;}
    await p.request({method:'eth_requestAccounts'});await p.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x38'}]});provider=new BrowserProvider(p);address=await(await provider.getSigner()).getAddress();el('wallet').textContent=short(address);
    p.on?.('accountsChanged',()=>{address='';provider=null;fundingQuote=null;el('fund-sign').hidden=true;invalidate();el('wallet').textContent='连接 OKX 钱包 ↗';});p.on?.('chainChanged',()=>{address='';provider=null;fundingQuote=null;el('fund-sign').hidden=true;invalidate();el('wallet').textContent='重新连接钱包 ↗';});await walletBalance();render();
  }catch{message('钱包连接未完成，请确认网络是 BNB Chain。',true);}
}
async function getQuote(){
  (el('quote') as HTMLButtonElement).disabled=true;el('quote-details').textContent='读取四项资产实时路线…';quote=null;render();
  try{quote=await api(`/api/quote?mode=${mode}&amount=${encodeURIComponent(amount())}`);el('quote-details').textContent=mode==='buy'?`将获得 ${number(formatEther(quote.shares),8)} TYW\n独立反向报价：${number(quote.expectedOutputUsdt,6)} USDT\n往返 gas 估算：${quote.gasUsdt==null?quote.gasBnb+' BNB':number(quote.gasUsdt,4)+' USDT 等值'}，首次授权另计\n${quote.approximateRoundTripCostPercent==null?'暂无可靠总成本估算':'含往返 gas 的估算损耗：'+number(quote.approximateRoundTripCostPercent,2)+'%'}\n报价有效 45 秒；实际滑点限制 0.5%。`:`预计收到 ${number(quote.expectedOutputUsdt,6)} USDT\n最低到账 ${number(formatEther(quote.minimumStable),6)} USDT\n卖出 gas 估算 ${quote.gasUsdt==null?quote.gasBnb+' BNB':number(quote.gasUsdt,4)+' USDT 等值'}`;render();}
  catch(e){message(e instanceof Error?e.message:'暂时无法取得完整报价',true);el('quote-details').textContent='';}finally{(el('quote') as HTMLButtonElement).disabled=false;}
}
async function record(promise:Promise<any>,label:string){const sent=await promise;const t={hash:sent.hash,mode:label,status:'等待链上确认',at:Date.now()};transactions.push(t);transactions=transactions.slice(-20);renderTransactions();try{const receipt=await sent.wait(2);if(!receipt||receipt.status!==1)throw new Error('交易执行失败');t.status='已完成链上确认';renderTransactions();return receipt;}catch(e){t.status='未确认成功，请查交易链接';renderTransactions();throw e;}}
async function trade(){
  if(!quote||!provider||!address||!state||busy)return;const q=quote;busy=true;render();
  try{if(q.expiresAt<Date.now())throw new Error('报价已过期，请重新取得报价。');if(parseEther(amount()).toString()!==q.budget||mode!==q.mode)throw new Error('金额变化，请重新取得报价。');
    const signer=await provider.getSigner();if((await signer.getAddress()).toLowerCase()!==address.toLowerCase())throw new Error('钱包已切换，请重新连接');if((await provider.getNetwork()).chainId!==56n)throw new Error('请切换到 BNB Chain');
    const vault=new Contract(state.vault,PERMANENT_ABI,signer),deadline=Math.floor(Date.now()/1000)+600;
    if(mode==='buy'){const cash=new Contract(USDT,TOKEN_ABI,signer);if(await cash.allowance(address,state.vault)<BigInt(q.budget)){message('等待 USDT 限额授权签名与确认。');await record(cash.approve(state.vault,BigInt(q.budget)),'USDT 授权');if(q.expiresAt<Date.now())throw new Error('授权已完成；报价过期，请重新报价，资金尚未申购。');}
      await vault.buy.staticCall(BigInt(q.budget),BigInt(q.shares),q.limits.map(BigInt),deadline);message('请核对钱包的 gas 与获得份额；等待申购签名。');await record(vault.buy(BigInt(q.budget),BigInt(q.shares),q.limits.map(BigInt),deadline),'四资产申购');
    }else{await vault.sell.staticCall(BigInt(q.shares),BigInt(q.minimumStable),q.limits.map(BigInt),deadline);message('等待赎回签名。');await record(vault.sell(BigInt(q.shares),BigInt(q.minimumStable),q.limits.map(BigInt),deadline),'USDT 赎回');}
    message('链上确认完成，正在核验余额。');invalidate();await loadState();
  }catch(e:any){message(e?.shortMessage||e?.message||'操作未完成，请查看钱包和交易链接。',true);}finally{busy=false;render();}
}
async function inKind(){if(!provider||!address||busy)return;busy=true;render();try{const shares=parseEther(amount());const signer=await provider.getSigner(),vault=new Contract(state.vault,PERMANENT_ABI,signer);const [assets,cash]=await vault.previewRedeem(shares);message('钱包将显示底层四项代币赎回，数量取当前输入的 TYW 份额。');await record(vault.redeemInKind(shares,[...assets],cash),'底层资产赎回');invalidate();await loadState();}catch(e:any){message(e?.shortMessage||e?.message||'赎回未完成',true);}finally{busy=false;render();}}
async function addToken(){try{if(!address)await connect();const p=(window.okxwallet||window.ethereum) as Injected|undefined;if(!p||!address||!state?.vault)return;await p.request({method:'wallet_watchAsset',params:[{type:'ERC20',options:{address:state.vault,symbol:'TYW',decimals:18,image:location.origin+'/token-icon.png'}}]});message('已请求钱包添加 TYW。');}catch{message('钱包未添加。可手动使用下方 TYW 合约地址添加。',true);}}
async function prepareFunding(){
  if(busy)return;if(!address)await connect();if(!address||!provider)return;
  const button=el('fund-quote') as HTMLButtonElement;button.disabled=true;fundingQuote=null;el('fund-sign').hidden=true;el('fund-details').textContent='读取小额兑换报价与模拟结果…';
  try{fundingQuote=await api('/api/test-funding?address='+encodeURIComponent(address)+'&bnb=0.0018');el('fund-details').textContent=`支付：0.0018 BNB，gas 另计\n预计收到：${number(fundingQuote.expectedUsdt,6)} USDT\n最低到账：${number(fundingQuote.minimumUsdt,6)} USDT\n收款钱包：${address}\n尚未发送交易，请核对后在钱包签名。`;el('fund-sign').hidden=false;}catch(e){el('fund-details').textContent=e instanceof Error?e.message:'兑换报价暂时不可用';}finally{button.disabled=false;}
}
async function prepareRebalance(){
  if(busy)return;if(!address)await connect();if(!address||!provider)return;
  rebalanceQuote=null;el('rebalance-sign').hidden=true;el('rebalance-details').textContent='检查触发边界并模拟四项资产调仓…';const button=el('rebalance-prepare') as HTMLButtonElement;button.disabled=true;
  try{rebalanceQuote=await api('/api/rebalance?account='+encodeURIComponent(address));el('rebalance-details').textContent=`当前估值：${number(rebalanceQuote.beforeUsdt,6)} USDT\n预计调仓后：${number(rebalanceQuote.quotedAfterUsdt,6)} USDT\n预计权重：${rebalanceQuote.predictedWeightsBps.map((v:number)=>(v/100).toFixed(2)+'%').join(' / ')}\n估算 gas：${number(rebalanceQuote.gasBnb,8)} BNB，由签名钱包承担\n尚未提交交易，报价有效 45 秒。`;el('rebalance-sign').hidden=false;}catch(e){el('rebalance-details').textContent=e instanceof Error?e.message:'当前无法准备安全调仓';}finally{button.disabled=false;}
}
async function signRebalance(){
  if(busy||!provider||!address||!state||!rebalanceQuote)return;busy=true;render();const button=el('rebalance-sign') as HTMLButtonElement;button.disabled=true;
  try{const q=rebalanceQuote,signer=await provider.getSigner();if(q.expiresAt<Date.now())throw Error('调仓报价过期，请重新检查');if(q.account.toLowerCase()!==address.toLowerCase()||q.vault.toLowerCase()!==state.vault.toLowerCase()||(await signer.getAddress()).toLowerCase()!==address.toLowerCase()||(await provider.getNetwork()).chainId!==56n)throw Error('钱包、网络或金库已改变，请重新准备');
    const transaction={to:q.transaction.to,data:q.transaction.data,value:0n};await provider.call({...transaction,from:address});message('请核对调仓交易和 gas，等待钱包签名。');await record(signer.sendTransaction(transaction),'触线调仓');rebalanceQuote=null;el('rebalance-sign').hidden=true;await fetch('/api/check',{method:'POST'});await loadState();message('调仓交易已确认，已刷新链上储备与权重。');
  }catch(e:any){message(e?.shortMessage||e?.message||'调仓未执行',true);}finally{busy=false;button.disabled=false;render();}
}
async function signFunding(){
  if(busy||!provider||!address||!fundingQuote)return;busy=true;render();(el('fund-sign') as HTMLButtonElement).disabled=true;
  try{const q=fundingQuote,signer=await provider.getSigner();if(q.expiresAt<Date.now())throw new Error('兑换报价已过期，请重新准备');if((await provider.getNetwork()).chainId!==56n||(await signer.getAddress()).toLowerCase()!==address.toLowerCase()||q.recipient.toLowerCase()!==address.toLowerCase())throw new Error('钱包或网络已改变，请重新准备');
    const router=new Contract(PANCAKE.router,NATIVE_TEST_ROUTER_ABI,signer),value=parseEther('0.0018');
    const swap=router.interface.encodeFunctionData('exactInputSingle',[{tokenIn:WBNB,tokenOut:USDT,fee:500,recipient:address,amountIn:value,amountOutMinimum:parseEther(q.minimumUsdt),sqrtPriceLimitX96:0}]);
    const calls=[swap,router.interface.encodeFunctionData('refundETH')],deadline=BigInt(q.deadline);
    await router.multicall.staticCall(deadline,calls,{value});message('等待钱包签名 BNB → USDT。兑换后资金仍在你的钱包。');await record(router.multicall(deadline,calls,{value}),'BNB → USDT 测试资金');fundingQuote=null;el('fund-sign').hidden=true;el('fund-details').textContent='兑换已获链上确认。现在可取得 1 USDT 的四资产申购报价。';await loadState();
  }catch(e:any){message(e?.shortMessage||e?.message||'兑换未完成',true);}finally{busy=false;(el('fund-sign') as HTMLButtonElement).disabled=false;render();}
}
el('wallet').onclick=connect;el('quote').onclick=getQuote;el('trade').onclick=trade;el('add-token').onclick=addToken;el('in-kind').onclick=inKind;
el('fund-quote').onclick=prepareFunding;el('fund-sign').onclick=signFunding;
el('rebalance-prepare').onclick=prepareRebalance;el('rebalance-sign').onclick=signRebalance;
el('buy-tab').onclick=()=>setMode('buy');el('sell-tab').onclick=()=>setMode('sell');function setMode(next:'buy'|'sell'){mode=next;el('buy-tab').classList.toggle('active',mode==='buy');el('sell-tab').classList.toggle('active',mode==='sell');el('amount-label').textContent=mode==='buy'?'申购金额 · USDT':'赎回份额 · TYW';el('amount-unit').textContent=mode==='buy'?'USDT':'TYW';invalidate();}
el('amount').oninput=invalidate;document.querySelectorAll<HTMLButtonElement>('[data-amount]').forEach(b=>b.onclick=()=>{(el('amount') as HTMLInputElement).value=b.dataset.amount!;invalidate();});el('refresh').onclick=async()=>{await loadState();if(!provider)return;for(const t of transactions.filter(t=>t.status!=='已完成链上确认')){const receipt=await provider.getTransactionReceipt(t.hash);if(receipt)t.status=receipt.status===1?'已完成链上确认':'链上执行失败';}renderTransactions();};
batchUi=installBatch({state:()=>state,provider:()=>provider,account:()=>address,connect,record});
renderTransactions();void loadState();setInterval(()=>{if(quote&&quote.expiresAt<Date.now())invalidate();if(!busy)void loadState();},20000);
