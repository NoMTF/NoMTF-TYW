import {BrowserProvider,Contract,Interface,parseEther,formatEther} from 'ethers';
import {BATCH_ABI,BATCH_TYPES,wireOrder,parseOrder} from '../src/batch-orders.ts';
import {USDT} from '../src/permanent-assets.ts';import {TOKEN_ABI} from '../src/chain.ts';import {PERMANENT_ABI} from '../src/permanent-chain.ts';
type Options={state:()=>any;provider:()=>BrowserProvider|null;account:()=>string;connect:()=>Promise<void>;record:(p:Promise<any>,label:string)=>Promise<any>};
export function installBatch(options:Options){
 const section='<section class="panel operator" id="batch"><div class="panel-head"><h2>小额合批申赎</h2><span class="pill dim" id="batch-ready">读取队列</span></div><p class="footnote">签署金额、最低到账和最高执行费。等待期间 USDT 或 TYW 留在你的钱包里；成功结算后才建仓或到账。当前每个方向需 64 笔可执行订单，无法保证等待时间。执行费含 gas 报价余量。</p><p class="footnote">合批金库：<a id="batch-vault"></a>。请核对与本页金库的关系；旧版份额不会自动迁移。</p><div class="tabs"><button id="batch-buy" class="active">合批申购</button><button id="batch-sell">合批赎回</button></div><label for="batch-amount" id="batch-amount-label">申购金额 · USDT</label><input id="batch-amount" value="1" inputmode="decimal" maxlength="24"><button class="secondary" id="batch-prepare">查看签名金额与费用</button><div class="message" id="batch-terms" aria-live="polite"></div><button class="primary" id="batch-sign" disabled>先准备订单</button><div class="message" id="batch-message" aria-live="polite"></div><div class="stat-row"><span>等待申购 / 赎回订单</span><b id="batch-count">—</b></div><div id="batch-orders" class="empty">没有本钱包的签名订单。</div><button class="text-button" id="batch-refresh">刷新订单</button><button class="text-button" id="batch-cancel">链上取消未成交签名</button><button class="text-button" id="batch-in-kind">按合批底层资产赎回</button><button class="text-button" id="batch-add">添加合批 TYW 到钱包</button><div class="panel-head"><h2>执行凑齐的批次</h2><span class="muted">任意执行者均须钱包签名</span></div><p class="footnote">执行者先支付 BNB gas，成功后收到公开的 USDT 执行费用。只提供已经完整模拟的结算交易，最低到账或费用不满足时不会提交。</p><button class="secondary" id="batch-execute-prepare">准备当前方向的完整结算</button><div class="message" id="batch-execution" aria-live="polite"></div><button class="secondary" id="batch-execute-sign" hidden>在钱包签名结算整批</button></section>';
 document.querySelector('main')!.insertAdjacentHTML('beforeend',section);
 const el=(id:string)=>document.getElementById(id)!,button=(id:string)=>el(id) as HTMLButtonElement;
 const msg=(text:string)=>el('batch-message').textContent=text;
 let mode:'buy'|'sell'='buy',prepared:any=null,proposal:any=null,busy=false,activeVault='',lastOrders:any[]=[];
 const reset=()=>{prepared=null;proposal=null;el('batch-terms').textContent='';button('batch-sign').disabled=true;button('batch-sign').textContent='先准备订单';el('batch-execute-sign').hidden=true;};
 const api=async(path:string,body?:unknown)=>{const r=await fetch(path,body===undefined?undefined:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),data:any=await r.json();if(!r.ok)throw Error(data.error||'队列暂时不可用');return data;};
 const wallet=async()=>{if(!options.account())await options.connect();const provider=options.provider(),account=options.account();if(!provider||!account)throw Error('请先连接钱包');const signer=await provider.getSigner();if((await provider.getNetwork()).chainId!==56n||(await signer.getAddress()).toLowerCase()!==account.toLowerCase())throw Error('钱包或网络已改变，请重新连接');return{provider,account,signer};};
 const decimal=(raw:string)=>Number(raw).toLocaleString('en-US',{maximumFractionDigits:8});
 async function refresh(){
  const state=options.state();if(!state?.batchQueueEnabled||!state.batchVault){el('batch-ready').textContent='队列尚未开放';return;}
  const vault=state.batchVault;if(activeVault&&activeVault.toLowerCase()!==vault.toLowerCase())reset();activeVault=vault;
  const link=el('batch-vault') as HTMLAnchorElement;link.textContent=vault;link.href='https://bscscan.com/address/'+vault;link.target='_blank';link.rel='noopener noreferrer';
  try{const data=await api('/api/batch/status'+(options.account()?'?account='+encodeURIComponent(options.account()):''));el('batch-ready').textContent='签名队列开放';el('batch-count').textContent=`${data.queuedBuys}/64 · ${data.queuedSells}/64`;
   lastOrders=data.orders;const labels:Record<string,string>={QUEUED:'签名已收到，等待可执行批次',EXPIRED:'已过期，资金未由此订单提交',NONCE_ADVANCED:'链上序号已变化，请核验交易回执',CONFIRMED:'链上结算已确认'};
   const container=el('batch-orders');container.textContent='';if(!data.orders.length)container.textContent='没有本钱包的签名订单。';
   for(const order of data.orders.slice(-10).reverse()){
    const row=document.createElement('div');row.className='order';const text=document.createElement('span');text.textContent=(order.order.redeem?'赎回':'申购')+' · '+decimal(formatEther(order.order.amount))+' · '+labels[order.status]+(order.output?' · 到账 '+decimal(formatEther(order.output))+(order.order.redeem?' USDT':' TYW'):'');row.appendChild(text);
    if(order.transaction){const link=document.createElement('a');link.textContent='查看回执 ↗';link.href='https://bscscan.com/tx/'+order.transaction;link.target='_blank';link.rel='noopener noreferrer';row.appendChild(link);}container.appendChild(row);
   }
  }catch(e){el('batch-ready').textContent='状态待刷新';msg(e instanceof Error?e.message:'队列暂时不可用');}
 }
 async function prepare(){
  if(busy)return;reset();busy=true;button('batch-prepare').disabled=true;
  try{const {account}=await wallet(),raw=(el('batch-amount') as HTMLInputElement).value;prepared=await api(`/api/batch/prepare?account=${encodeURIComponent(account)}&mode=${mode}&amount=${encodeURIComponent(raw)}`);
   el('batch-terms').textContent=`金库：${prepared.vault}\n金额：${decimal(formatEther(prepared.order.amount))} ${mode==='buy'?'USDT':'TYW'}\n最高执行费：${decimal(prepared.feeUsdt)} USDT\n最低到账：${decimal(prepared.minimum)} ${prepared.minimumUnit}\n订单有效至：${new Date(Number(prepared.order.deadline)*1000).toLocaleString()}\n需凑齐 ${prepared.quorum} 笔可执行订单，金额与费用签名准备有效 45 秒。`;
   button('batch-sign').disabled=false;button('batch-sign').textContent='授权指定金额并签署订单';msg('尚未提交订单，也未转移资金。');
  }catch(e){msg(e instanceof Error?e.message:'无法准备签名订单');}finally{busy=false;button('batch-prepare').disabled=false;}
 }
 async function sign(){
  if(busy||!prepared)return;busy=true;button('batch-sign').disabled=true;
  try{const p=prepared,{provider,account,signer}=await wallet();if(p.expiresAt<Date.now()||p.order.user.toLowerCase()!==account.toLowerCase()||p.vault.toLowerCase()!==activeVault.toLowerCase()||parseEther((el('batch-amount') as HTMLInputElement).value).toString()!==p.order.amount||p.order.redeem!==(mode==='sell'))throw Error('订单准备已失效，请重新查看金额与费用');
   if(mode==='buy'){const stable=new Contract(USDT,TOKEN_ABI,signer);if(await stable.allowance(account,p.vault)<BigInt(p.order.amount)){msg('等待钱包签名指定金额的 USDT 授权。资金仍在钱包。');await options.record(stable.approve(p.vault,BigInt(p.order.amount)),'合批 USDT 限额授权');if(p.expiresAt<Date.now())throw Error('授权已完成，请重新准备价格，再签署订单。资金尚未申购。');}}
   const onChain=new Contract(p.vault,BATCH_ABI,provider);if(await onChain.orderNonces(account)!==BigInt(p.order.nonce))throw Error('序号已改变，请重新准备');
   // Domain, ABI and order fields are fixed locally; never sign a server-selected schema.
   const domain={name:'NoMTF Batch',version:'1',chainId:56,verifyingContract:p.vault},order=parseOrder(p.order);msg('请核对钱包中的金额、最低到账和最高执行费；这是订单签名，尚未成交。');
   const signature=await signer.signTypedData(domain,{Order:[...BATCH_TYPES.Order]},order);const result=await api('/api/batch/submit',{order:wireOrder(order),signature});msg(result.notice);reset();await refresh();
  }catch(e:any){msg(e?.shortMessage||e?.message||'签名未完成');}finally{busy=false;if(prepared)button('batch-sign').disabled=false;}
 }
 async function cancel(){if(busy||!activeVault)return;busy=true;try{const {account,signer}=await wallet(),vault=new Contract(activeVault,BATCH_ABI,signer),nonce=await vault.orderNonces(account);const matching=lastOrders.some(o=>o.status==='QUEUED'&&BigInt(o.order.nonce)===nonce);if(!matching)throw Error('没有当前序号的未成交签名。刷新状态即可。');msg('钱包将显示取消签名的链上交易，gas 由钱包支付。');await options.record(vault.invalidateNonce(nonce+1n),'取消合批签名');reset();await refresh();msg('取消交易已确认，旧序号订单无法再执行。');}catch(e:any){msg(e?.shortMessage||e?.message||'取消未完成');}finally{busy=false;}}
 async function prepareExecution(){if(busy)return;busy=true;proposal=null;el('batch-execute-sign').hidden=true;try{const {account}=await wallet();el('batch-execution').textContent='检查余额、授权、费用与最低到账，并模拟完整批次…';proposal=await api(`/api/batch/transaction?account=${encodeURIComponent(account)}&mode=${mode}`);el('batch-execution').textContent=`订单：${proposal.orderIds.length} 笔\n执行 gas 估算：${decimal(proposal.gasBnb)} BNB\n成功后收到：${decimal(proposal.totalFeeUsdt)} USDT 执行费用\n模拟通过，尚未发送；报价有效 45 秒。`;el('batch-execute-sign').hidden=false;}catch(e){el('batch-execution').textContent=e instanceof Error?e.message:'当前批次不可执行';}finally{busy=false;}}
 async function execute(){
  if(busy||!proposal)return;busy=true;button('batch-execute-sign').disabled=true;
  try{const p=proposal,{provider,account,signer}=await wallet();if(p.expiresAt<Date.now()||p.account.toLowerCase()!==account.toLowerCase()||p.vault.toLowerCase()!==activeVault.toLowerCase()||p.mode!==mode)throw Error('结算准备已失效，请重新模拟');
   const gasLimit=BigInt(p.transaction.gasLimit),gasPrice=BigInt(p.transaction.gasPrice);if(gasLimit<=0n||gasLimit>30000000n||gasLimit!==BigInt(p.gasUnits)||gasPrice!==BigInt(p.gasPriceWei))throw Error('gas 上限或价格与页面不匹配');
   const transaction={to:p.vault,data:p.transaction.data,value:0n,gasLimit,gasPrice},decoded=new Interface(BATCH_ABI).parseTransaction(transaction);
   if(!decoded||decoded.name!==(mode==='buy'?'settleBuys':'settleSells')||decoded.args[0].length!==64||decoded.args[2].reduce((a:bigint,b:bigint)=>a+b,0n)!==parseEther(p.totalFeeUsdt))throw Error('结算交易内容与页面费用不匹配');
   await provider.call({...transaction,from:account});msg('等待钱包签名完整合批结算；提高 gas 价格需要重新准备费用。');const receipt=await options.record(signer.sendTransaction(transaction),'四资产合批结算');await api('/api/batch/confirm',{hash:receipt.hash});msg('成功回执已核验，正在刷新实际到账。');proposal=null;el('batch-execute-sign').hidden=true;await refresh();
  }catch(e:any){msg(e?.shortMessage||e?.message||'结算未完成，请核验交易回执');}finally{busy=false;button('batch-execute-sign').disabled=false;}
 }
 async function inKind(){if(busy||!activeVault)return;busy=true;try{const {signer}=await wallet(),vault=new Contract(activeVault,PERMANENT_ABI,signer),shares=parseEther((el('batch-amount') as HTMLInputElement).value),[assets,cash]=await vault.previewRedeem(shares);msg('按当前输入的 TYW 数量赎回四项实际底层资产；暂停时也可用。');await options.record(vault.redeemInKind(shares,[...assets],cash),'合批底层资产赎回');await refresh();}catch(e:any){msg(e?.shortMessage||e?.message||'实物赎回未完成');}finally{busy=false;}}
 async function add(){try{await wallet();const injected=(window.okxwallet||window.ethereum) as {request:(args:any)=>Promise<unknown>}|undefined;if(!injected||!activeVault)return;await injected.request({method:'wallet_watchAsset',params:[{type:'ERC20',options:{address:activeVault,symbol:'TYW',decimals:18,image:location.origin+'/token-icon.png'}}]});msg('已请求钱包添加此合批金库的 TYW。');}catch(e){msg(e instanceof Error?e.message:'钱包未添加');}}
 button('batch-prepare').onclick=prepare;button('batch-sign').onclick=sign;button('batch-refresh').onclick=refresh;button('batch-cancel').onclick=cancel;button('batch-execute-prepare').onclick=prepareExecution;button('batch-execute-sign').onclick=execute;button('batch-in-kind').onclick=inKind;button('batch-add').onclick=add;
 button('batch-buy').onclick=()=>setMode('buy');button('batch-sell').onclick=()=>setMode('sell');function setMode(next:'buy'|'sell'){if(busy)return;mode=next;reset();button('batch-buy').classList.toggle('active',mode==='buy');button('batch-sell').classList.toggle('active',mode==='sell');el('batch-amount-label').textContent=mode==='buy'?'申购金额 · USDT':'赎回份额 · TYW';}
 el('batch-amount').oninput=reset;setInterval(()=>{if(prepared&&prepared.expiresAt<Date.now())reset();if(!busy)void refresh();},30000);void refresh();return{refresh,reset};
}
