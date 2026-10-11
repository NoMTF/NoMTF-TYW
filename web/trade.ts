import './trade.css';
import {BrowserProvider,Contract,parseEther,formatEther,isAddress,MaxUint256,keccak256} from 'ethers';
import {USDT} from '../src/permanent-assets.ts';import {PERMANENT_ABI} from '../src/permanent-chain.ts';import {TOKEN_ABI} from '../src/chain.ts';
import {walletLink,walletPage,poolSwapPage,initialTrade,isMobileAgent,type WalletKind} from '../src/wallet-links.ts';
import type {Wallet} from '@reown/appkit-wallet-button';
import {tradeFees} from '../src/trade-fees.ts';
import {injectedWallets,validAnnouncement,type Injected,type Discovered} from '../src/wallet-providers.ts';
import {WALLET_CATALOG,catalogProvider,type WalletEntry} from '../src/wallet-catalog.ts';
import {ensureBsc} from '../src/wallet-network.ts';
import {portfolioAllocation,quoteCostChanged} from '../src/quote-safety.ts';
import {validateTradeQuote,readJsonResponse,type TradeQuote} from '../src/quote-validation.ts';
import {assertWalletSession} from '../src/wallet-session.ts';
import {parseTradeInput} from '../src/trade-input.ts';
import {withWalletGasPrice} from '../src/wallet-gas.ts';
import {RELAY_TYPES,RELAY_ADDRESS,RELAY_RUNTIME_HASH,relayDomain,relayMessage,relayWire,type RelayRequest} from '../src/relay-typed-data.ts';
// Lazy chunks share code through this entry; if a browser ever evaluates it twice, only the first copy runs the app.
function main(){
const VAULT='0xaE7eA21fBf3613fFc17fe962EE66bfe03015fBa7',boot=initialTrade(location.search),app=document.querySelector<HTMLDivElement>('#app')!;
const MOBILE=isMobileAgent(navigator.userAgent,navigator.maxTouchPoints||0);
const esc=(v:unknown)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const short=(v:string)=>v?`${v.slice(0,6)}…${v.slice(-4)}`:'—',n=(v:unknown,p=6)=>v==null?'—':Number(v).toLocaleString('en-US',{maximumFractionDigits:p});
let state:any=null,provider:BrowserProvider|null=null,injected:Injected|null=null,address='',mode:'buy'|'sell'=boot.mode,quote:TradeQuote|null=null,busy=false,revision=0,directMode=false;
let balances={tyw:0n,usdt:0n,bnb:0n},balanceReady=false,allowance:bigint|null=null,quoteSeq=0,quoteBusy=false;const discovered=new Map<string,Discovered>();let quoteTimer:ReturnType<typeof setTimeout>|undefined,quoteAbort:AbortController|undefined,projectId:string|null=null,lastQuoteAt=0,walletCleanup:()=>void=()=>{},connecting=false;
type Relay={enabled:boolean;available?:boolean;relay?:string;executor?:string;fees?:{buy:string;sell:string};gasPriceWei?:string;approveGas?:string;approvalGasWei?:string};
let relay:Relay|null=null,relayAt=0;
type Transaction={hash:string;mode:string;status:string;at:number};const storageKey='nomtf:permanent-transactions';let transactions:Transaction[]=[];
try{transactions=JSON.parse(localStorage.getItem(storageKey)||'[]').filter((t:any)=>/^0x[0-9a-f]{64}$/i.test(t.hash)).slice(-20);}catch{}
// [data-open] kind, label shown on the tile, catalog id used to find an installed extension.
const TILES:[WalletKind,string,string][]=[['okx','欧易 App','okx'],['okxwallet','OKX Wallet','okx'],['metamask','MetaMask','metamask'],['trust','Trust Wallet','trust'],['bitget','Bitget Wallet','bitget'],['tokenpocket','TokenPocket','tokenpocket']];
const LEGS=[['SPYB','美股'],['TLTon','长债'],['XAUm','黄金'],['SGOVon','短债']];
const external='target="_blank" rel="noopener noreferrer"';
app.innerHTML=`<div class="flag" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
<div class="shell">
<header class="top"><a class="brand" href="/"><img src="/token-icon-120.png" width="44" height="44" alt=""><h1>唐毓文币<small>NoMTF · TYW</small></h1></a><button id="wallet" class="wallet-button">连接钱包</button></header>
<main class="layout">
<section class="intro" aria-labelledby="headline">
 <p class="eyebrow">老唐的 meme 币 · BNB Chain</p>
 <h2 id="headline">一枚币，<br>一份<em>永久组合</em></h2>
 <p class="lede">股票、长债、黄金、短债，目标各占四分之一。每枚 TYW 都对应金库里同比例的真实资产，净值跟着这份组合走。</p>
</section>
<section class="trade-card card" aria-label="买卖 TYW">
 <div class="tabs" role="group" aria-label="买卖方向"><button id="buy-tab">买入</button><button id="sell-tab">卖出</button></div>
 <div class="field">
  <div class="field-head"><label id="amount-label" for="amount">支付</label><span class="available"><span id="available">连接钱包查看可用余额</span><button id="max" hidden>全部</button></span></div>
  <div class="amount-row"><input id="amount" inputmode="decimal" maxlength="24" autocomplete="off" value="${esc(boot.amount)}"><span id="amount-unit" class="unit">USDT</span></div>
 </div>
 <div class="field receive">
  <div class="field-head"><span>预计获得</span><button class="estimate-button" id="estimate">刷新报价</button></div>
  <div class="amount-row"><output id="receive" for="amount">—</output><span id="receive-unit" class="unit">TYW</span></div>
 </div>
 <div id="fee-summary" class="fee-summary" aria-live="polite"><span>预计本次买入总成本</span><strong>—</strong><small>输入金额就自动估算，这一步不会下单。</small></div>
 <details class="fee-details"><summary>费用明细 · 官网平台费 0%</summary><div id="roundtrip-summary" class="roundtrip-summary" hidden><span>预计买卖往返总成本</span><b>—</b></div><div id="quote-details" class="quote-box" hidden aria-live="polite"></div></details>
 <button class="primary" id="trade">连接钱包</button>
 <p class="execution-note" id="execution-note">确认前会重新核对一次费用，明显变贵会先停下来问你。</p>
 <div id="message" class="message" role="status" aria-live="polite"></div>
 <details id="sell-options" hidden><summary>其他赎回方式</summary><p>USDT 赎回不可用时，可以按输入的份额直接取回四种底层代币和现金。</p><button id="in-kind" class="secondary">赎回底层资产</button></details>
 <details class="direct-trade"><summary>直连链上 · 官网报价出故障时用</summary><p>不走官网报价接口，直接从 BNB Chain 读价格。最高支付、最低到账和费用照样核对。</p><label><input type="checkbox" id="direct-mode"> 改用链上直连</label><p><a href="/exit.html">卖不成 USDT？独立赎回四种原资产 ↗</a></p></details>
 <details id="activity"><summary>交易进度</summary><div id="transactions"></div></details>
</section>
<section class="portfolio card" aria-labelledby="portfolio-title">
 <div class="card-head"><h3 id="portfolio-title">金库里有什么</h3><span id="share-nav" class="nav"></span></div>
 <p id="allocation-caption" class="caption">资产占比读取中</p>
 <div id="allocation-track" class="allocation-track" role="img" aria-label="资产占比读取中">${LEGS.map((_,i)=>`<span data-leg="${i}"></span>`).join('')}</div>
 <ul class="allocation-legend">${LEGS.map(([name,kind],i)=>`<li><i class="dot leg-${i}"></i><span>${name}<small>${kind}</small></span><b data-weight="${i}">—</b></li>`).join('')}</ul>
 <small id="allocation-cash" class="caption" hidden></small><small id="allocation-updated" class="caption"></small>
</section>
<section class="balance-card card" aria-label="我的持仓">
 <div class="card-head"><h3>我的持仓</h3><button id="refresh" class="link-button" aria-label="刷新余额">↻ 刷新</button></div>
 <div class="balance-value"><strong id="balance">—</strong><span>TYW</span></div>
 <div class="balance-sub"><span id="value">连接钱包后查看</span><span id="account"></span></div>
 <div class="cash-balances"><span>USDT <b id="usdt">—</b></span><span>BNB <b id="bnb">—</b></span></div>
</section>
<section class="wallets" aria-labelledby="wallets-title">
 <div class="section-head"><h3 id="wallets-title">在钱包里打开</h3><p id="wallet-hint">${MOBILE?'点一下直接跳进钱包 App 的交易页，再连接、签名。':'装了浏览器插件会直接连接；没装的话会弹出二维码，用手机钱包扫一下就能打开。'}</p></div>
 <div class="wallet-grid">${TILES.map(([kind,name,id])=>`<a class="wallet-tile" data-open="${kind}" data-catalog="${id}" data-name="${name}"><b>${name}</b><small data-tile-state></small></a>`).join('')}<button class="wallet-tile" data-binance data-catalog="binance"><b>Binance Wallet</b><small data-tile-state></small></button><button class="wallet-tile more" data-more-wallets><b>更多钱包</b><small>${WALLET_CATALOG.length} 个常用钱包 · 扫码</small></button></div>
 <div class="launch-fallback" id="launch-fallback" hidden><p>App 没打开？直接连接钱包，或者打开下面的交易页：</p><button id="fallback-connect" class="secondary">连接钱包 / 扫码</button><a data-dapp-site class="secondary" ${external}>打开官网交易页 ↗</a><a data-pool-swap class="secondary" ${external}>打开 PancakeSwap ↗</a></div>
 <div class="pool-entry"><div><b>也可以去 PancakeSwap 池子换</b><small>池子里买入多付约 5%、卖出少拿约 5%，另加网络费，以兑换页报价为准。官网直接买卖没有这笔 5%。</small></div><span class="pool-actions"><a data-pool-swap class="secondary" ${external}>打开 PancakeSwap ↗</a><button data-copy-contract class="secondary">复制 TYW 合约</button></span></div>
</section>
<section class="promises" aria-label="为什么可以放心">
 <div><b>管理权已弃权</b><p>金库合约已经没有管理员：老唐也提不走里面的资产，暂停开关也永久作废了。<a href="https://bscscan.com/tx/0xdd101a9ee5aaf9d932a063f09bfefbd2c43db08646f885c7b421a11d9a0d2676" ${external}>弃权交易 ↗</a></p></div>
 <div><b>1:1 跟踪永久组合</b><p>每枚 TYW 对应金库里同比例的四种资产，净值跟着组合涨跌。买入时真的去买，卖出时真的去卖，链上随时可查。</p></div>
 <div><b>代码全部开源</b><p>线上跑的合约、网站和自动补池程序，源码都在 GitHub，谁都能审。<a href="https://github.com/NoMTF/NoMTF-TYW" ${external}>看源码 ↗</a></p></div>
 <div><b>跑路也能赎回</b><p>就算这个网站哪天关了，也能用 GitHub 上的备用页面直接找合约，按份额领走你那份四种资产。<a href="https://nomtf.github.io/NoMTF-TYW/" ${external}>备用赎回页 ↗</a></p></div>
</section>
</main>
<section class="about" aria-labelledby="about-title"><h3 id="about-title">关于唐毓文币</h3><p>唐毓文币（NoMTF · TYW）是老唐的个人 meme 币，也是一份能揣进钱包的永久组合。SPYB、TLTon、XAUm、SGOVon 分别对应美股、美国长债、黄金和美国短债，目标各占 25%。</p><p>在官网买入，金库会用你的 USDT 买进这四样资产，再给你铸出对应份额；卖出时金库把你那份资产卖成 USDT 打给你，份额随即销毁。</p><p>每小时检查一次比例：哪一项跌到 15% 或涨到 35%，才需要调仓。调仓任何人都能签名发起，合约只允许把各项拉回 25% 附近。</p></section>
<footer><span>© 2026 NoMTF</span><nav><button id="add-token" class="link-button">把 TYW 添加到钱包</button><a href="https://bscscan.com/token/${VAULT}" ${external}>合约 ↗</a><a href="/exit.html">独立赎回 ↗</a><a href="https://nomtf.github.io/NoMTF-TYW/">备用赎回入口 ↗</a><a href="https://github.com/NoMTF/NoMTF-TYW" ${external}>源码 ↗</a></nav></footer>
</div>
<dialog id="wallet-dialog" aria-labelledby="wallet-title"><div class="dialog-head"><h2 id="wallet-title">连接钱包</h2><button id="close-wallet" class="close" aria-label="关闭">×</button></div><div id="extensions"></div><button id="walletconnect" class="option wc" hidden><b>${MOBILE?'用钱包 App 连接':'手机扫码连接'}</b><small>${MOBILE?'WalletConnect · 选这台手机上的钱包 App':'WalletConnect · 留在这个页面交易，用手机钱包签名'}</small></button><p id="wc-status" class="hint">正在准备扫码连接…</p><input id="wallet-search" class="wallet-search" aria-label="搜索钱包" placeholder="搜索钱包名称"><p id="installed-count" class="hint"></p><div id="wallet-catalog" class="wallet-catalog"></div><p id="launch-hint" class="message"></p><input id="manual-page" class="manual-page" aria-label="钱包浏览器链接" readonly hidden><div class="dialog-foot"><button data-copy-contract class="link-button">复制 TYW 合约地址</button><button id="copy-page" class="link-button">复制交易页链接</button><button id="disconnect" class="link-button" hidden>断开本站连接</button></div><a class="download" href="https://web3.okx.com/download" ${external}>还没有钱包？安装 OKX Wallet ↗</a></dialog>
<dialog id="handoff-dialog" aria-labelledby="handoff-title"><div class="dialog-head"><h2 id="handoff-title">用手机打开</h2><button id="handoff-close" class="close" aria-label="关闭">×</button></div><p id="handoff-lead"></p><div id="handoff-qr" class="qr" role="img" aria-label="交易页二维码"></div><p class="hint">用手机相机扫也行：先在手机浏览器打开，再点一次钱包名字。</p><div class="copy-row"><input id="handoff-link" aria-label="交易页链接" readonly><button id="handoff-copy" class="secondary">复制</button></div><button id="handoff-connect" class="option wc" hidden><b>留在电脑上交易</b><small id="handoff-connect-note">手机钱包扫码签名，不用离开这个页面</small></button><div id="handoff-installed"></div><a id="handoff-install" class="download" ${external}>给电脑装插件 ↗</a></dialog>
<dialog id="force-dialog" aria-labelledby="force-title"><div class="dialog-head"><h2 id="force-title">你仍要交易吗？</h2><button id="force-close" class="close" aria-label="取消强制交易">×</button></div><p id="force-reason"></p><div class="force-fees"><span>预计本次手续费和兑换损耗</span><strong id="force-fee">—</strong><small id="force-percent"></small><small id="force-gas"></small></div><p>继续就按最新报价直接发起，不再拦费用涨幅。最低到账和最高支付照样生效，网络费以钱包为准。</p><button class="primary" id="force-continue">仍然强制买入</button><button class="secondary wide" id="force-cancel">取消，暂不交易</button></dialog>`;
const el=(id:string)=>document.getElementById(id)!,amount=()=> (el('amount') as HTMLInputElement).value.trim();
const message=(s:string,bad=false)=>{el('message').textContent=s;el('message').classList.toggle('bad',bad);};
async function api(path:string){const r=await fetch(path,{signal:AbortSignal.timeout(30000)}),data:any=await readJsonResponse(r);if(!r.ok)throw new Error(data.error||'暂时不可用');return data;}
function renderTransactions(){el('transactions').innerHTML=transactions.length?transactions.slice().reverse().map(t=>`<a class="transaction" href="https://bscscan.com/tx/${esc(t.hash)}" target="_blank" rel="noopener noreferrer"><span>${esc(t.mode)}<small>${esc(t.status)}</small></span><span>${esc(short(t.hash))} ↗</span></a>`).join(''):'<p>暂无交易。</p>';try{localStorage.setItem(storageKey,JSON.stringify(transactions));}catch{}}
function updateLinks(){document.querySelectorAll<HTMLAnchorElement>('[data-open]').forEach(a=>{a.href=MOBILE?walletLink(a.dataset.open as WalletKind,mode,amount()):walletPage(mode,amount(),a.dataset.open as WalletKind);});document.querySelectorAll<HTMLAnchorElement>('[data-pool-swap]').forEach(a=>{a.href=poolSwapPage(mode,amount());});document.querySelectorAll<HTMLAnchorElement>('[data-dapp-site]').forEach(a=>{a.href=walletPage(mode,amount());});}
function walletChoices(){const choices=[...discovered.values()];for(const d of injectedWallets(window))if(!choices.some(c=>c.provider===d.provider))choices.push(d);return choices;}
async function copyWalletPage(name='钱包'){const url=new URL('/',location.origin);url.searchParams.set('mode',mode);if(/^\d{1,4}(\.\d{1,18})?$/.test(amount()))url.searchParams.set('amount',amount());const field=el('manual-page') as HTMLInputElement;field.value=url.toString();field.hidden=false;try{await navigator.clipboard.writeText(url.toString());el('launch-hint').textContent=`已复制。在 ${name} 的 DApp 浏览器粘贴打开，再连接 BNB Chain。`;}catch{field.select();el('launch-hint').textContent=`请复制下方链接，在 ${name} 的 DApp 浏览器打开。`;}}
function installedProvider(entry?:WalletEntry){if(!entry)return undefined;const choices=walletChoices().filter(d=>MOBILE||(d.info.uuid!=='injected'&&!d.info.uuid.startsWith('legacy-')));return catalogProvider(entry,choices);}
function renderWalletTiles(){document.querySelectorAll<HTMLElement>('[data-catalog]').forEach(tile=>{const entry=WALLET_CATALOG.find(e=>e.id===tile.dataset.catalog),found=installedProvider(entry),state=tile.querySelector('[data-tile-state]');tile.classList.toggle('installed',!!found);if(state)state.textContent=found?'已检测到 · 直接连接':tile.dataset.binance!==undefined?'连接 / 扫码':MOBILE?'打开 App':'手机扫码打开';});}
function renderDiscovered(){
 const container=el('extensions');container.replaceChildren();const choices=walletChoices(),search=(el('wallet-search') as HTMLInputElement).value.trim().toLowerCase();el('installed-count').textContent=`${choices.length?`检测到 ${choices.length} 个已装钱包`:'这台设备上没检测到钱包插件'} · 下面是 ${WALLET_CATALOG.length} 个常用钱包${projectId?'，扫码还能连更多':''}`;
 for(const d of choices.filter(d=>d.info.name.toLowerCase().includes(search))){const b=document.createElement('button');b.className='option installed';b.setAttribute('aria-label','连接 '+d.info.name);b.innerHTML=`<b>${esc(d.info.name)}</b><small>已安装 · 直接连接</small>`;b.onclick=()=>void attach(d.provider);container.appendChild(b);}
 const catalog=el('wallet-catalog');catalog.replaceChildren();
 for(const entry of WALLET_CATALOG.filter(e=>(e.name+' '+e.aliases.join(' ')).toLowerCase().includes(search))){
  const row=document.createElement('div');row.className='catalog-row';row.dataset.wallet=entry.id;const found=catalogProvider(entry,choices),button=document.createElement('button');button.className='catalog-connect';button.textContent=entry.name+' · '+(found?'连接':'连接 / 扫码');button.onclick=()=>found?void attach(found.provider):void connectRemote(entry.connectId,entry.name);row.appendChild(button);
  const actions=document.createElement('div');actions.className='catalog-actions';
  const site=document.createElement('a');site.textContent='打开 DApp ↗';
  if(MOBILE&&entry.deepLink){site.href=walletLink(entry.deepLink,mode,amount(),'site');site.onclick=()=>{site.href=walletLink(entry.deepLink!,mode,amount(),'site');showLaunchFallback();};}
  else{site.href=walletPage(mode,amount(),entry.deepLink);site.onclick=e=>{e.preventDefault();if(MOBILE){void copyWalletPage(entry.name);return;}const installed=installedProvider(entry);if(installed){void attach(installed.provider);return;}(el('wallet-dialog') as HTMLDialogElement).close();void showHandoff(entry.name,entry);};}
  const pool=document.createElement('a');pool.textContent='池子兑换 ↗';
  if(MOBILE&&entry.deepLink){pool.href=walletLink(entry.deepLink,mode,amount(),'pool');pool.onclick=()=>{pool.href=walletLink(entry.deepLink!,mode,amount(),'pool');showLaunchFallback();};}
  else{pool.href=poolSwapPage(mode,amount());pool.target='_blank';pool.rel='noopener noreferrer';pool.onclick=()=>{pool.href=poolSwapPage(mode,amount());};}
  const install=document.createElement('a');install.href=entry.website;install.target='_blank';install.rel='noopener noreferrer';install.textContent='下载 / 官网 ↗';for(const link of [site,pool,install])actions.appendChild(link);row.appendChild(actions);catalog.appendChild(row);
 }renderWalletTiles();
}
function showLaunchFallback(){updateLinks();el('launch-fallback').hidden=false;el('wallet-hint').textContent='正在打开 App；没反应的话，下面可以直接连接钱包或打开交易页。';el('launch-hint').textContent='如果 App 没打开，可以点「连接 / 扫码」，不用自己找钱包里的 DApp 入口。';}
let qrModule:Promise<typeof import('qrcode')>|undefined;
async function showHandoff(name:string,entry?:WalletEntry){
 const page=walletPage(mode,amount(),entry?.deepLink),dialog=el('handoff-dialog') as HTMLDialogElement;
 el('handoff-title').textContent=`用手机里的 ${name} 打开`;
 const plugin=entry?.name||name,installedHere=!!installedProvider(entry);
 el('handoff-lead').textContent=`${installedHere?`这台电脑装了 ${plugin} 插件，下面可以直接连接。想在手机上打开的话，`:`这台电脑上没检测到 ${plugin} 插件。`}打开手机上的 ${name}，用「扫一扫」扫下面的码，交易页会直接在钱包里打开。`;
 (el('handoff-link') as HTMLInputElement).value=page;el('handoff-copy').textContent='复制';
 const connectButton=el('handoff-connect') as HTMLButtonElement;connectButton.hidden=!projectId;connectButton.onclick=()=>{dialog.close();void connectRemote(entry?.connectId,name);};el('handoff-connect-note').textContent=`用手机上的 ${name} 扫码签名，不用离开这个页面`;
 const install=el('handoff-install') as HTMLAnchorElement;install.hidden=!entry?.website||installedHere;if(entry?.website){install.href=entry.website;install.textContent=`给电脑装 ${plugin} 插件 ↗`;}
 const installed=el('handoff-installed');installed.replaceChildren();for(const d of walletChoices().slice(0,4)){const b=document.createElement('button');b.className='option installed';b.innerHTML=`<b>改用 ${esc(d.info.name)}</b><small>这台电脑上已安装 · 直接连接</small>`;b.onclick=()=>{dialog.close();void attach(d.provider);};installed.appendChild(b);}
 const qr=el('handoff-qr');qr.replaceChildren();qr.classList.add('loading');if(!dialog.open)dialog.showModal();
 try{qrModule??=import('qrcode');const QR=(await qrModule).default;const svg=await QR.toString(page,{type:'svg',margin:1,errorCorrectionLevel:'M',color:{dark:'#16242e',light:'#ffffff'}});if((el('handoff-link') as HTMLInputElement).value===page)qr.innerHTML=svg;}
 catch{qrModule=undefined;qr.textContent='二维码没生成出来，请复制下面的链接发到手机。';}
 finally{qr.classList.remove('loading');}
}
function openWallet(e:Event,tile:HTMLElement){const entry=WALLET_CATALOG.find(x=>x.id===tile.dataset.catalog),found=installedProvider(entry);if(found){e.preventDefault();void attach(found.provider);return;}if(MOBILE){showLaunchFallback();return;}e.preventDefault();void showHandoff(tile.dataset.name||entry?.name||'钱包',entry);}
let remoteConnecting=false;
async function connectRemote(wallet?:Wallet,name='钱包'){
 if(busy||remoteConnecting)return;
 if(!projectId){renderDiscovered();const dialog=el('wallet-dialog')as HTMLDialogElement;if(!dialog.open)dialog.showModal();el('launch-hint').textContent='扫码连接暂时用不了，可以点「打开 DApp」直接在钱包里打开。';return;}
 remoteConnecting=true;const button=el('walletconnect')as HTMLButtonElement;button.disabled=true;
 try{(el('wallet-dialog')as HTMLDialogElement).close();message('正在打开 '+name+' 连接…');const {openWalletConnect}=await import('./wallet-connect.ts');await openWalletConnect(projectId,p=>void attach(p),wallet);message('');}
 catch{message('连接没完成，可以重新选钱包或打开 DApp。',true);if(MOBILE)showLaunchFallback();}
 finally{remoteConnecting=false;button.disabled=false;}
}
window.addEventListener('eip6963:announceProvider',(e:any)=>{const d=e.detail;if(validAnnouncement(d)&&(discovered.has(d.info.uuid)||discovered.size<100)){discovered.set(d.info.uuid,d);renderDiscovered();}});window.dispatchEvent(new Event('eip6963:requestProvider'));
async function loadRelay(force=false){if(!force&&relay&&Date.now()-relayAt<30000)return relay;try{relay=await api('/api/relay');relayAt=Date.now();}catch{if(force)relay=null;}render();return relay;}
const relayFeeWei=()=>relay?.fees?BigInt(relay.fees[mode]):null;
// Direct trades need BNB for gas. Without enough, the page uses the relay: one signature, gas paid by us, fee taken in USDT.
function bnbShort(){if(!balanceReady)return false;const price=BigInt(quote?.gasPriceWei||relay?.gasPriceWei||'50000000'),units=mode==='buy'?930000n+(allowance===null||allowance<BigInt(quote?.budget||'0')?50000n:0n):720000n;return balances.bnb<units*price*110n/100n;}
function relayActive(){return !!address&&!!relay?.enabled&&!!relay.available&&bnbShort();}
function renderFees(){const summary=el('fee-summary');summary.querySelector('span')!.textContent=mode==='buy'?'预计本次买入总成本':'预计本次卖出总成本';el('roundtrip-summary').hidden=mode!=='buy'||!quote;el('receive').textContent=quote?(mode==='buy'?n(formatEther(quote.shares),6):n(quote.expectedOutputUsdt,6)):quoteBusy?'估算中…':'—';if(!quote){summary.querySelector('strong')!.textContent=quoteBusy?'估算中…':'—';summary.querySelector('small')!.textContent='输入金额就自动估算，这一步不会下单。';summary.classList.remove('cost-high');return;}const relayFee=relayActive()?relayFeeWei():null;
 if(relayFee!==null){const g=tradeFees(quote,false),fee=Number(formatEther(relayFee)),total=Number(g.oneWayUnderlyingCostUsdt??0)+fee,reference=mode==='buy'?Number(formatEther(BigInt(quote.budget))):Number(g.referenceUsdt??0),share=reference>0?total/reference*100:null;
  if(mode==='sell')el('receive').textContent=n(Math.max(0,Number(quote.expectedOutputUsdt)-fee),6);
  summary.querySelector('strong')!.textContent=share===null?'暂无法完整估算':n(share,2)+'%';summary.querySelector('small')!.textContent=`≈ ${n(total,6)} USDT · 含代付网络费 ${n(fee,4)} USDT`+(mode==='sell'?` · 最低到账 ${n(Number(formatEther(quote.minimumStable))-fee,6)} USDT`:'');
  el('roundtrip-summary').hidden=true;summary.classList.toggle('cost-high',share!==null&&share>1);return;}
 const f=tradeFees(quote,allowance===null||allowance<BigInt(quote.budget)),percent=f.oneWayTotalCostPercent;summary.querySelector('strong')!.textContent=percent===null?'暂无法完整估算':n(percent,2)+'%';summary.querySelector('small')!.textContent=(f.oneWayTotalCostUsdt===null?'净值或 gas 换算不可用；可以看费用明细里的网络费。':`≈ ${n(f.oneWayTotalCostUsdt,6)} USDT${f.approvalNeeded?' · 含本次授权':''}`)+(mode==='sell'?` · 最低到账 ${n(formatEther(quote.minimumStable),6)} USDT`:'');el('roundtrip-summary').querySelector('b')!.textContent=f.totalCostPercent===null?'暂不可用':`${n(f.totalCostPercent,2)}% · ≈ ${n(f.totalCostUsdt,6)} USDT`;summary.classList.toggle('cost-high',percent!==null&&percent>1);}
function render(){
 const allocation=portfolioAllocation(state);el('allocation-caption').textContent=allocation.kind==='target'?'目标比例 · 尚未建仓':allocation.kind==='actual'?'实际资产占比':'资产占比暂不可用';
 const labels=LEGS.map(([name])=>name);for(let i=0;i<4;i++){const weight=allocation.weights?.[i];(document.querySelector(`[data-leg="${i}"]`) as HTMLElement).style.width=(weight===undefined?0:weight/100)+'%';document.querySelector(`[data-weight="${i}"]`)!.textContent=weight===undefined?'—':(weight/100).toFixed(2)+'%';}
 el('allocation-track').setAttribute('aria-label',allocation.weights?labels.map((name,i)=>name+' '+(allocation.weights![i]/100).toFixed(2)+'%').join('，'): '资产占比暂不可用');el('allocation-cash').hidden=allocation.cashBps===null||allocation.cashBps<10;el('allocation-cash').textContent=allocation.cashBps===null?'':`另有现金约 ${n(allocation.cashBps/100,2)}%`;
 el('allocation-updated').textContent=state&&Number.isSafeInteger(state.at)?'更新于 '+new Date(state.at).toLocaleTimeString([], {hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'}):'';
 el('share-nav').textContent=state?.valuation?.perShareUsdt?`每份净值 ${n(state.valuation.perShareUsdt,6)} USDT`:'';
 for(const direction of ['buy','sell']){el(direction+'-tab').classList.toggle('active',mode===direction);el(direction+'-tab').setAttribute('aria-pressed',String(mode===direction));}
 el('amount-label').textContent=mode==='buy'?'支付':'卖出';el('amount-unit').textContent=mode==='buy'?'USDT':'TYW';el('receive-unit').textContent=mode==='buy'?'TYW':'USDT';el('sell-options').hidden=mode!=='sell';el('max').hidden=!balanceReady;
 for(const [id,v]of Object.entries(balances))el(id==='tyw'?'balance':id).textContent=balanceReady?n(formatEther(v)):'—';el('balance').classList.toggle('placeholder',!balanceReady);
 el('value').textContent=balanceReady?(state?.valuation?.perShareUsdt?`≈ ${n(Number(formatEther(balances.tyw))*Number(state.valuation.perShareUsdt),4)} USDT`:'估值暂不可用'):'连接钱包后查看';el('account').textContent=address?short(address):'';el('wallet').textContent=address?short(address):'连接钱包';el('wallet').classList.toggle('connected',!!address);
 el('available').textContent=balanceReady?`可用 ${n(formatEther(mode==='buy'?balances.usdt:balances.tyw))} ${mode==='buy'?'USDT':'TYW'}`:'连接钱包查看可用余额';
 const relaying=relayActive();let insufficient=false;try{insufficient=balanceReady&&parseEther(amount())+(relaying&&mode==='buy'?relayFeeWei()??0n:0n)>(mode==='buy'?balances.usdt:balances.tyw);}catch{}
 const b=el('trade') as HTMLButtonElement;b.disabled=busy||(!!address&&(quoteBusy||!!state?.paused||!state||insufficient||!!quote?.indicative));b.textContent=busy?'处理中…':!address?'连接钱包':!state?'读取链上状态…':state.paused?'当前交易暂停':insufficient?'余额不够 · 可以先看报价':quote?.indicative?'测算报价 · 暂无法成交':quote?(mode==='buy'?'确认买入 TYW':'确认卖出 TYW'):(mode==='buy'?'买入 TYW':'卖出 TYW');if(relaying&&!busy&&state&&!state.paused&&!insufficient&&!quote?.indicative)b.textContent=quote?(mode==='buy'?'确认买入 · 网络费代付':'确认卖出 · 网络费代付'):(mode==='buy'?'买入 TYW · 网络费代付':'卖出 TYW · 网络费代付');
 const relayFee=relayFeeWei();el('execution-note').textContent=relaying&&relayFee!==null?`钱包里没有 BNB 也能交易：网络费由我们先垫，约 ${n(formatEther(relayFee),3)} USDT，从这笔里扣。第一次用要授权一次，授权的 gas 也是我们送。`:bnbShort()&&relay?.enabled?'钱包里的 BNB 不够付网络费（一笔约 0.00005 BNB），代付暂时不可用，可以先换一点 BNB。':'确认前会重新核对一次费用，明显变贵会先停下来问你。';
 (el('in-kind') as HTMLButtonElement).disabled=busy||!address;(el('amount') as HTMLInputElement).disabled=busy;el('amount').classList.toggle('long-amount',amount().length>12);for(const id of ['max','buy-tab','sell-tab','wallet'])(el(id) as HTMLButtonElement).disabled=busy;(el('estimate') as HTMLButtonElement).disabled=busy||quoteBusy;el('disconnect').hidden=!address;renderFees();updateLinks();
}
async function walletBalance(){if(!provider||!address)return;const p=provider,a=address,r=revision;try{const stable=new Contract(USDT,TOKEN_ABI,p),[tyw,usdt,bnb,allowed]=await Promise.all([new Contract(VAULT,PERMANENT_ABI,p).balanceOf(a),stable.balanceOf(a),p.getBalance(a),stable.allowance(a,VAULT)]);if(r!==revision||a!==address||p!==provider)return;balances={tyw,usdt,bnb};allowance=allowed;balanceReady=true;render();if(quote)renderQuote();}catch{if(r===revision){balanceReady=false;render();message('余额读取暂时失败，请刷新。',true);}}}
async function directState(){
 const {createPublicClient,http}=await import('viem');const client=createPublicClient({transport:http('https://bsc-dataseed.bnbchain.org',{timeout:15000,retryCount:1})});
 const [paused,supply,held,valuation]=await Promise.all([
  client.readContract({address:VAULT,abi:PERMANENT_ABI,functionName:'paused'}),client.readContract({address:VAULT,abi:PERMANENT_ABI,functionName:'totalSupply'}),
  client.readContract({address:VAULT,abi:PERMANENT_ABI,functionName:'balances'}),client.readContract({address:VAULT,abi:PERMANENT_ABI,functionName:'valuation'}).catch(()=>null)]);
 return{vault:VAULT,chainId:56,at:Date.now(),paused,supply:formatEther(supply),balances:held.map(String),valuation:valuation?{valueUsdt:formatEther(valuation[0]),perShareUsdt:formatEther(valuation[1]),weightsBps:valuation[2].map(Number)}:null};
}
async function loadState(){try{const next=directMode?await directState():await api('/api/state');if(!isAddress(next.vault)||next.vault.toLowerCase()!==VAULT.toLowerCase()||next.chainId!==56)throw Error('金库配置不匹配');state=next;render();await walletBalance();}catch{state=null;quote=null;el('quote-details').hidden=true;render();await walletBalance();message('链上状态暂时读不到。可以打开下面的「直连链上」再试，或者用独立赎回。',true);}}
function invalidate(){quoteSeq++;quoteAbort?.abort();quoteBusy=false;clearTimeout(quoteTimer);quote=null;el('quote-details').hidden=true;el('fee-summary').classList.remove('cost-high');render();}
function resetWallet(){walletCleanup();walletCleanup=()=>{};revision++;address='';provider=null;injected=null;allowance=null;balanceReady=false;balances={tyw:0n,usdt:0n,bnb:0n};invalidate();}
async function attach(p:Injected){if(connecting)return;connecting=true;try{invalidate();await p.request({method:'eth_requestAccounts'});await ensureBsc(p);const next=new BrowserProvider(p);if((await next.getNetwork()).chainId!==56n)throw Error('请切换到 BNB Chain');walletCleanup();revision++;provider=next;injected=p;address=await(await next.getSigner()).getAddress();balanceReady=false;const changed=()=>{if(injected===p)resetWallet();};p.on?.('accountsChanged',changed);p.on?.('chainChanged',changed);p.on?.('disconnect',changed);walletCleanup=()=>{p.removeListener?.('accountsChanged',changed);p.removeListener?.('chainChanged',changed);p.removeListener?.('disconnect',changed);};(el('wallet-dialog') as HTMLDialogElement).close();message('');render();await walletBalance();scheduleQuote();}catch(e:any){message(e?.code===4001?'已取消连接。':e?.shortMessage||e?.message||'钱包连接没完成。',true);}finally{connecting=false;}}
async function connect(){const options=injectedWallets(window);if(options.length===1&&discovered.size<=1)return attach(options[0].provider);renderDiscovered();(el('wallet-dialog') as HTMLDialogElement).showModal();}
async function getQuote(fresh=false){
 const input=parseTradeInput(new URLSearchParams({amount:amount(),mode}));
 if(lastQuoteAt&&Date.now()-lastQuoteAt<6000)throw Error('请等几秒再刷新报价。');
 const before=amount(),direction=mode,seq=++quoteSeq,snapshotProvider=provider,snapshotRevision=revision;quoteAbort?.abort();quoteAbort=new AbortController();quoteBusy=true;lastQuoteAt=Date.now();message('正在预估费用…');quote=null;render();
 try{let q:any;
  if(directMode){const {permanentQuote}=await import('../src/permanent-chain.ts');q=await permanentQuote('https://bsc-dataseed.bnbchain.org',VAULT,input.amount,direction);}
  else{const response=await fetch(`/api/quote?mode=${direction}&amount=${encodeURIComponent(before)}${fresh?'&fresh=1':''}`,{signal:AbortSignal.any([quoteAbort.signal,AbortSignal.timeout(30000)])});q=await readJsonResponse(response);if(!response.ok)throw Error(q.error||'报价暂时不可用');}
  if(seq!==quoteSeq||before!==amount()||direction!==mode)return;
  let priced=validateTradeQuote(q,{vault:VAULT,mode:direction,amount:input.amount});
  if(snapshotProvider)priced=withWalletGasPrice(priced,(await snapshotProvider.getFeeData()).gasPrice);
  if(seq!==quoteSeq||before!==amount()||direction!==mode||snapshotProvider!==provider||snapshotRevision!==revision)return;
  quote=priced;renderQuote();message(q.indicative?'卖出数量超过了 TYW 总发行量，这只是按比例放大的估算，没法成交。':directMode?'已直接从链上取得报价（没走官网接口），核对一下再点确认。':`报价好了，核对一下就点「${direction==='buy'?'确认买入':'确认卖出'}」。`);
 }finally{if(seq===quoteSeq){quoteBusy=false;render();}}
}
async function checkWallet(p:BrowserProvider,a:string,r:number,q?:TradeQuote){if(!injected)throw Error('钱包未连接');if(q&&q.expiresAt<=Date.now())throw Error('报价已过期，请刷新');const wallet=injected;try{await assertWalletSession(wallet,a,()=>revision===r&&provider===p&&injected===wallet);}catch(e){if(provider===p)resetWallet();throw e;}if(q&&q.expiresAt<=Date.now())throw Error('报价已过期，请刷新');}
function operationError(e:any,fallback:string){if(e?.code==='NETWORK_ERROR'&&e?.event==='changed'){resetWallet();return '钱包网络已变化，请切回 BNB Chain 并重新连接。';}return e?.code===4001?'已取消签名。':e?.shortMessage||e?.message||fallback;}
function renderQuote(){const q=quote;if(!q)return;const f=tradeFees(q,allowance===null||allowance<BigInt(q.budget)),row=(name:string,value:string)=>`<div><span>${esc(name)}</span><b>${esc(value)}</b></div>`,money=(v:string|null)=>v===null?'暂不可用':n(v,6)+' USDT';
 el('quote-details').hidden=false;el('quote-details').innerHTML=(mode==='buy'?row('预计获得',n(formatEther(q.shares),8)+' TYW')+row('预计找零',n(q.estimatedRefundUsdt,6)+' USDT'):row('预计到账',n(q.expectedOutputUsdt,8)+' USDT')+row('最低到账',n(formatEther(q.minimumStable),8)+' USDT'))+
 row('平台费','0 USDT · 0%')+row(mode==='buy'?'本次兑换磨损 / 净值偏差':'兑换磨损 / 净值偏差',money(f.oneWayUnderlyingCostUsdt))+(relayActive()&&relayFeeWei()!==null?row('代付网络费（从 USDT 扣）',n(formatEther(relayFeeWei()!),4)+' USDT')+row('你要付的 BNB','0 · 第一次授权的 gas 由我们送'):row('本次网络 gas',money(f.executionGasUsdt))+row('本次网络 gas（BNB）',n(f.executionGasBnb,8)+' BNB')+(mode==='buy'?row('本次 USDT 授权 gas',f.approvalNeeded?money(f.approvalGasUsdt):'已足额授权 · 0 USDT')+row('底层往返兑换磨损',money(f.underlyingCostUsdt))+row('买卖往返网络 gas',money(f.roundTripGasUsdt)):''))+
 '<small>'+(q.indicative?'这是按比例放大的估算，当前发行量不够，没法按这个数量成交。':'')+(mode==='buy'?'买入成本 = 付出的 USDT 减去买到的资产（按净值）和找零，再加 gas；池子手续费、价差和冲击都已算在里面。往返成本是假设买完马上卖掉。':'成本按份额净值算；跟你当初买入价比的盈亏另算。')+'0.5% 滑点只是保护线，不收钱。没连钱包时按需要授权一次来估算。报价 45 秒内有效，gas 以钱包为准。</small>';renderFees();}
function scheduleQuote(){clearTimeout(quoteTimer);try{parseTradeInput(new URLSearchParams({amount:amount(),mode}));}catch{return;}quoteTimer=setTimeout(()=>{if(!busy&&document.visibilityState!=='hidden')void getQuote().catch(e=>{if(e.name!=='AbortError')message(e.message,true);});},Math.max(800,6000-(Date.now()-lastQuoteAt)));}
async function record(promise:Promise<any>,label:string){const sent=await promise,t={hash:sent.hash,mode:label,status:'等待链上确认',at:Date.now()};transactions.push(t);transactions=transactions.slice(-20);renderTransactions();(el('activity') as HTMLDetailsElement).open=true;try{const receipt=await sent.wait(2);if(!receipt||receipt.status!==1)throw Error('交易执行失败');t.status='已完成';renderTransactions();return receipt;}catch(e){t.status='未确认成功，点击查询';renderTransactions();throw e;}}
let forceSnapshot:{revision:number;address:string;mode:'buy'|'sell';amount:string}|null=null;
function offerForce(q:TradeQuote,reason:string){
 if(q.indicative||!address||!provider)return;const f=tradeFees(q,allowance===null||allowance<BigInt(q.budget));
 forceSnapshot={revision,address,mode,amount:amount()};el('force-reason').textContent=reason;
 el('force-fee').textContent=f.oneWayTotalCostUsdt===null?'暂无法完整估算':n(f.oneWayTotalCostUsdt,6)+' USDT';
 el('force-percent').textContent=f.oneWayTotalCostPercent===null?'总费率暂不可用':`约 ${n(f.oneWayTotalCostPercent,2)}% · 含底层兑换损耗和网络费`;
 el('force-gas').textContent=f.executionGasUsdt===null?`网络 gas 约 ${n(f.executionGasBnb,8)} BNB`:`其中本次网络 gas 约 ${n(f.executionGasUsdt,6)} USDT`;
 el('force-continue').textContent=mode==='buy'?'仍然强制买入':'仍然强制卖出';const dialog=el('force-dialog') as HTMLDialogElement;if(!dialog.open)dialog.showModal();
}
async function post(path:string,body:unknown){const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)}),data:any=await readJsonResponse(r);if(!r.ok)throw new Error(data.error||'代付暂时不可用');return data;}
async function relayTrade(){
 const info=await loadRelay(true);if(!info?.available||!info.relay||!info.executor||!info.fees)throw Error('代付暂时不可用，可以先在钱包里换一点 BNB 再交易。');
 const p=provider!,a=address,r=revision,direction=mode,token=direction==='buy'?USDT:VAULT,relayAddress=info.relay as `0x${string}`,executor=info.executor as `0x${string}`;
 const fresh=async()=>{const delay=Math.max(0,6000-(Date.now()-lastQuoteAt));if(delay)await new Promise(res=>setTimeout(res,delay));await getQuote(true);if(r!==revision||direction!==mode||!quote)throw Error('钱包或报价已变化，请重新确认。');return quote;};
 // The page only trusts the published relay: fixed address, and the code there must still be the verified contract.
 if(relayAddress.toLowerCase()!==RELAY_ADDRESS.toLowerCase()||keccak256(await p.getCode(relayAddress))!==RELAY_RUNTIME_HASH)throw Error('代付合约和公开源码对不上，已停止，不会授权也不会签名。');
 const fee=()=>BigInt(relay!.fees![direction]);let q=await fresh();
 const funding=()=>direction==='buy'?BigInt(q.budget)+fee():BigInt(q.shares);
 if((direction==='buy'?balances.usdt:balances.tyw)<funding())throw Error(direction==='buy'?'USDT 不够：代付要在这笔之外再扣一点网络费。':'TYW 余额不够。');
 if(await new Contract(token,TOKEN_ABI,p).allowance(a,relayAddress)<funding()){
  let gasPrice=BigInt(info.gasPriceWei!),gasLimit=BigInt(info.approveGas!);
  if(await p.getBalance(a)<BigInt(info.approvalGasWei!)){
   message('正在给你的钱包送一点授权要用的 gas…');const drip=await post('/api/relay/drip',{owner:a,mode:direction});gasPrice=BigInt(drip.gasPriceWei);gasLimit=BigInt(drip.gasLimit);
   const end=Date.now()+30000;while(await p.getBalance(a)<gasLimit*gasPrice&&Date.now()<end)await new Promise(res=>setTimeout(res,1000));
  }
  await checkWallet(p,a,r);message(`请在钱包里把${direction==='buy'?' USDT':' TYW'}授权给代付合约，只需要这一次。`);
  await record(new Contract(token,TOKEN_ABI,await p.getSigner()).approve(relayAddress,MaxUint256,{gasPrice,gasLimit}),direction==='buy'?'USDT 授权 · 代付':'TYW 授权 · 代付');
  if(r!==revision)throw Error('钱包已变化。');lastQuoteAt=0;await loadRelay(true);q=await fresh();
 }
 const nonce=await new Contract(relayAddress,['function nonces(address) view returns(uint256)'],p).nonces(a) as bigint,deadline=BigInt(Math.floor(Date.now()/1000)+600);
 const limits=q.limits.map(BigInt) as unknown as readonly [bigint,bigint,bigint,bigint],owner=a as `0x${string}`;
 const request:RelayRequest=direction==='buy'?{owner,executor,mode:0,feeAsset:0,budget:BigInt(q.budget),shares:BigInt(q.shares),limits,minNetStable:0n,fee:fee(),nonce,deadline}
  :{owner,executor,mode:1,feeAsset:0,budget:0n,shares:BigInt(q.shares),limits,minNetStable:BigInt(q.minimumStable)-fee(),fee:fee(),nonce,deadline};
 if(direction==='buy'&&request.fee*2n>request.budget)throw Error('金额太小，代付的网络费超过了一半。多买一点，或者自备一点 BNB。');
 if(direction==='sell'&&request.minNetStable<=0n)throw Error('卖出金额太小，扣掉代付的网络费就不剩了。');
 await checkWallet(p,a,r,q);message('请在钱包里签名确认。签名不花 gas，网络费由代付钱包垫付。');
 const signature=await(await p.getSigner()).signTypedData(relayDomain(relayAddress),{TradeRequest:RELAY_TYPES.TradeRequest.map(f=>({...f}))},relayMessage(request));
 if(r!==revision)throw Error('钱包已变化，请重新确认。');message('签名好了，正在由代付钱包发出交易…');
 const sent=await post('/api/relay/submit',{request:relayWire(request),signature});
 await record(Promise.resolve({hash:sent.hash,wait:(confirms:number)=>p.waitForTransaction(sent.hash,confirms,120000)}),direction==='buy'?'代付买入 TYW':'代付卖出 TYW');
 invalidate();await loadState();message('交易完成，余额已更新。网络费是代付钱包垫的，已经从这笔里扣掉。');
}
async function trade(force=false){if(busy)return;if(!address){await connect();return;}if(!state||!provider)return;
 if(relayActive()){busy=true;render();try{await relayTrade();}catch(e:any){message(operationError(e,'代付没完成，请看一下钱包。'),true);}finally{busy=false;render();}return;}
 let submitted=false,reviewedForForce=quote;busy=true;render();try{
 if(!quote||quote.expiresAt<Date.now()){const delay=Math.max(0,6000-(Date.now()-lastQuoteAt));if(delay)await new Promise(resolve=>setTimeout(resolve,delay));await getQuote(true);if(!force)return;}if(!quote)throw Error('未取得有效报价。');if(!balanceReady)throw Error('余额尚未读取，请刷新后重试。');if(parseEther(amount())>(mode==='buy'?balances.usdt:balances.tyw))throw Error('余额不足，仍可使用预估功能。');
 const reviewed=quote,p=provider,a=address,r=revision;if(parseEther(amount()).toString()!==reviewed.budget||mode!==reviewed.mode)throw Error('金额已变化，请重新报价。');
 message('正在重新核对报价和费用…');const delay=Math.max(0,6000-(Date.now()-lastQuoteAt));if(delay)await new Promise(resolve=>setTimeout(resolve,delay));await getQuote(true);if(r!==revision||!quote)throw Error('钱包或报价已变化。');const q=quote,changed=quoteCostChanged(reviewed,q,allowance===null||allowance<BigInt(q.budget));reviewedForForce=q;if(changed&&!force){message(changed,true);offerForce(q,changed);return;}
 const signer=await p.getSigner();if((await signer.getAddress()).toLowerCase()!==a.toLowerCase()||(await p.getNetwork()).chainId!==56n)throw Error('钱包或网络已变化，请重新连接。');
 const priced=withWalletGasPrice(q,(await p.getFeeData()).gasPrice),gasChanged=quoteCostChanged(q,priced,allowance===null||allowance<BigInt(q.budget));
 if(r!==revision)throw Error('钱包已变化，请重新连接。');quote=priced;renderQuote();
 reviewedForForce=priced;if(gasChanged&&!force){message('钱包网络费已更新，请核对新的费用后再确认一次。',true);offerForce(priced,'钱包建议的网络费比刚才预估的高。');return;}
 const feeOptions={gasPrice:BigInt(priced.gasPriceWei)};
 const vault=new Contract(VAULT,PERMANENT_ABI,signer),deadline=Math.floor(Date.now()/1000)+600;
 if(mode==='buy'){const stable=new Contract(USDT,TOKEN_ABI,signer);if(await stable.allowance(a,VAULT)<BigInt(q.budget)){await checkWallet(p,a,r,q);message('请在钱包授权本次 USDT 金额。');submitted=true;await record(stable.approve(VAULT,BigInt(q.budget),feeOptions),'USDT 授权');if(r!==revision)throw Error('钱包已变化。');allowance=await stable.allowance(a,VAULT);lastQuoteAt=0;await getQuote(true);message('授权完成，报价已刷新，请确认买入。');return;}await vault.buy.staticCall(BigInt(q.budget),BigInt(q.shares),q.limits.map(BigInt),deadline);if(r!==revision||q.expiresAt<Date.now())throw Error('钱包已变化或报价过期。');await checkWallet(p,a,r,q);message('请在钱包确认买入。');submitted=true;await record(vault.buy(BigInt(q.budget),BigInt(q.shares),q.limits.map(BigInt),deadline,feeOptions),'买入 TYW');
 }else{await vault.sell.staticCall(BigInt(q.shares),BigInt(q.minimumStable),q.limits.map(BigInt),deadline);if(r!==revision||q.expiresAt<Date.now())throw Error('钱包已变化或报价过期。');await checkWallet(p,a,r,q);message('请在钱包确认卖出。');submitted=true;await record(vault.sell(BigInt(q.shares),BigInt(q.minimumStable),q.limits.map(BigInt),deadline,feeOptions),'卖出 TYW');}invalidate();await loadState();message('交易完成，余额已更新。');
 }catch(e:any){const reason=operationError(e,'操作没完成，请看一下钱包。');message(reason,true);if(!force&&!submitted&&e?.code!==4001&&reviewedForForce)offerForce(quote||reviewedForForce,reason);}finally{busy=false;render();}}
async function inKind(){if(!provider||!address||busy)return;busy=true;render();try{const p=provider,a=address,r=revision,shares=parseEther(amount()),signer=await p.getSigner();if(shares<=0n||shares>balances.tyw||(await p.getNetwork()).chainId!==56n||(await signer.getAddress()).toLowerCase()!==a.toLowerCase())throw Error('请核对份额、钱包和网络。');const vault=new Contract(VAULT,PERMANENT_ABI,signer),[assets,cash]=await vault.previewRedeem(shares);if(r!==revision)throw Error('钱包已变化。');await vault.redeemInKind.staticCall(shares,[...assets],cash);await checkWallet(p,a,r);message('请在钱包确认赎回底层资产。');await record(vault.redeemInKind(shares,[...assets],cash),'赎回底层资产');invalidate();await loadState();message('底层资产赎回完成。');}catch(e:any){message(operationError(e,'赎回没完成。'),true);}finally{busy=false;render();}}
async function addToken(){try{if(!address){await connect();return;}if(!injected)return;await injected.request({method:'wallet_watchAsset',params:{type:'ERC20',options:{address:VAULT,symbol:'TYW',decimals:18,image:'https://xyn.lgbt/token-icon.png'}}});message('已请求钱包添加 TYW。');}catch{message('钱包没添加上，可以点「复制 TYW 合约」手动添加。',true);}}
function setMode(next:'buy'|'sell'){if(busy)return;mode=next;invalidate();message('');scheduleQuote();}
function openWalletDialog(){renderDiscovered();(el('wallet-dialog') as HTMLDialogElement).showModal();}
for(const id of ['wallet-dialog','handoff-dialog'])el(id).onclick=e=>{const d=el(id) as HTMLDialogElement,r=d.getBoundingClientRect();if(e.target===d&&(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom))d.close();};
el('wallet').onclick=openWalletDialog;el('close-wallet').onclick=()=>(el('wallet-dialog') as HTMLDialogElement).close();el('handoff-close').onclick=()=>(el('handoff-dialog') as HTMLDialogElement).close();
el('trade').onclick=()=>void trade();el('estimate').onclick=()=>{clearTimeout(quoteTimer);void getQuote().catch(e=>{if(e.name!=='AbortError')message(e.message,true);});};el('buy-tab').onclick=()=>setMode('buy');el('sell-tab').onclick=()=>setMode('sell');el('amount').oninput=()=>{invalidate();message('');scheduleQuote();};el('max').onclick=()=>{const reserve=relayActive()&&mode==='buy'?relayFeeWei()??0n:0n,held=mode==='buy'?balances.usdt:balances.tyw;(el('amount') as HTMLInputElement).value=formatEther(held>reserve?held-reserve:0n);invalidate();scheduleQuote();};el('in-kind').onclick=inKind;el('add-token').onclick=addToken;
for(const id of['force-close','force-cancel'])el(id).onclick=()=>{forceSnapshot=null;(el('force-dialog') as HTMLDialogElement).close();};
el('force-continue').onclick=async()=>{const snapshot=forceSnapshot;forceSnapshot=null;(el('force-dialog') as HTMLDialogElement).close();if(!snapshot||snapshot.revision!==revision||snapshot.address!==address||snapshot.mode!==mode||snapshot.amount!==amount()){message('钱包或金额已变化，请重新核对报价。',true);return;}await trade(true);};
el('direct-mode').onchange=async()=>{if(busy){(el('direct-mode') as HTMLInputElement).checked=directMode;return;}directMode=(el('direct-mode') as HTMLInputElement).checked;invalidate();lastQuoteAt=0;await loadState();scheduleQuote();};
el('refresh').onclick=async()=>{await loadState();if(provider)for(const t of transactions.filter(t=>t.status!=='已完成')){try{const receipt=await provider.getTransactionReceipt(t.hash);if(receipt)t.status=receipt.status===1?'已完成':'链上失败';}catch{}}renderTransactions();};
document.querySelectorAll<HTMLAnchorElement>('[data-open]').forEach(a=>a.addEventListener('click',e=>openWallet(e,a)));
el('wallet-search').oninput=renderDiscovered;
document.querySelectorAll<HTMLButtonElement>('[data-more-wallets]').forEach(b=>b.onclick=openWalletDialog);
document.querySelectorAll<HTMLButtonElement>('[data-binance]').forEach(b=>b.onclick=()=>{const found=installedProvider(WALLET_CATALOG.find(e=>e.id==='binance'));if(found)void attach(found.provider);else void connectRemote('binance','Binance Wallet');});
el('fallback-connect').onclick=()=>void connectRemote();
document.querySelectorAll<HTMLButtonElement>('[data-copy-contract]').forEach(b=>{const label=b.textContent;b.onclick=async()=>{try{await navigator.clipboard.writeText(VAULT);b.textContent='已复制 ✓';setTimeout(()=>{b.textContent=label;},2000);}catch{message('TYW 合约：'+VAULT);}};});
el('copy-page').onclick=()=>void copyWalletPage();
el('handoff-copy').onclick=async()=>{const field=el('handoff-link') as HTMLInputElement;try{await navigator.clipboard.writeText(field.value);el('handoff-copy').textContent='已复制 ✓';}catch{field.select();}};
el('disconnect').onclick=async()=>{if(busy)return;const previous=injected;resetWallet();try{const {disconnectWalletConnect}=await import('./wallet-connect.ts');if(!await disconnectWalletConnect(previous))await previous?.disconnect?.();}catch{}(el('wallet-dialog') as HTMLDialogElement).close();message('已断开本站连接。');};
el('walletconnect').onclick=()=>void connectRemote();
void api('/api/config').then(c=>{if(/^[a-f0-9]{32}$/i.test(c.walletConnectProjectId||'')){projectId=c.walletConnectProjectId;el('walletconnect').hidden=false;el('wc-status').textContent=MOBILE?'点上面的按钮，选这台手机上的钱包 App 连接。':'电脑上没装插件也没关系：点上面的「手机扫码连接」，用手机钱包扫码就能在这里交易。';}else el('wc-status').textContent='扫码连接暂时用不了，可以连接已安装的钱包，或点「打开 DApp」在钱包里打开。';}).catch(()=>{el('wc-status').textContent='扫码连接暂时用不了，可以连接已安装的钱包，或点「打开 DApp」在钱包里打开。';});
void loadRelay();
renderDiscovered();renderTransactions();render();void loadState().then(()=>scheduleQuote());setInterval(()=>{if(!busy&&quote&&quote.expiresAt<Date.now()){invalidate();message('报价已过期，正在更新预估…');scheduleQuote();}if(!busy&&document.visibilityState!=='hidden'){void loadState();if(address&&Date.now()-relayAt>60000)void loadRelay();}},20000);
// Quotes are skipped while the tab is hidden; fetch one as soon as it comes to the front.
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&!quote&&!quoteBusy&&!busy)scheduleQuote();});
window.dispatchEvent(new Event('nomtf:ready'));
}
const scope=window as any;if(!scope.__tywAppStarted){scope.__tywAppStarted=true;main();}
