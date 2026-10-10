export type WalletKind='okx'|'okxwallet'|'metamask'|'trust'|'bitget'|'tokenpocket'|'binance'|'imtoken'|'math';
export const SITE_ORIGIN='https://xyn.lgbt';
const TYW='0xaE7eA21fBf3613fFc17fe962EE66bfe03015fBa7',USDT='0x55d398326f99059fF775485246999027B3197955';
export function poolSwapPage(mode:'buy'|'sell',amount:string){
 const url=new URL('https://pancakeswap.finance/swap');url.searchParams.set('chain','bsc');
 url.searchParams.set('inputCurrency',mode==='buy'?USDT:TYW);url.searchParams.set('outputCurrency',mode==='buy'?TYW:USDT);
 if(/^\d{1,4}(\.\d{1,18})?$/.test(amount)){url.searchParams.set('exactAmount',amount);url.searchParams.set('exactField','input');}return url.toString();
}
export function walletPage(mode:'buy'|'sell',amount:string,wallet:WalletKind){
 const url=new URL('/',SITE_ORIGIN);url.searchParams.set('mode',mode);
 if(/^\d{1,4}(\.\d{1,18})?$/.test(amount))url.searchParams.set('amount',amount);
 url.searchParams.set('connect',wallet);return url.toString();
}
export function walletLink(wallet:WalletKind,mode:'buy'|'sell',amount:string,destination:'site'|'pool'='site'){
 const page=destination==='pool'?poolSwapPage(mode,amount):walletPage(mode,amount,wallet);
 if(wallet==='okx')return 'okx://wallet/dapp/url?dappUrl='+encodeURIComponent(page);
 if(wallet==='okxwallet')return 'okxwallet://wallet/dapp/url?dappUrl='+encodeURIComponent(page);
 if(wallet==='metamask')return 'https://link.metamask.io/dapp/'+page.slice('https://'.length);
 if(wallet==='bitget'){const target=new URL(page);target.searchParams.set('_needChain','bnb');return 'https://bkcode.vip?action=dapp&url='+encodeURIComponent(target.toString());}
 if(wallet==='tokenpocket')return 'tpdapp://open?params='+encodeURIComponent(JSON.stringify({url:page,chain:'BSC',source:'NoMTF'}));
 if(wallet==='imtoken')return 'imtokenv2://navigate/DappView?url='+encodeURIComponent(page);
 if(wallet==='math')return 'mathwallet://mathwallet.org?action=link&value='+encodeURIComponent(page);
 // Binance publishes an injected provider; no invented mobile deep link.
 if(wallet==='binance')return page;
 return 'https://link.trustwallet.com/open_url?coin_id=20000714&url='+encodeURIComponent(page);
}
export function initialTrade(search:string){const p=new URLSearchParams(search),raw=p.get('amount')||'1';return{mode:p.get('mode')==='sell'?'sell' as const:'buy' as const,amount:/^\d{1,4}(\.\d{1,18})?$/.test(raw)?raw:'1',wallet:['okx','okxwallet','metamask','trust','bitget','tokenpocket','binance','imtoken','math'].includes(p.get('connect')||'')?p.get('connect') as WalletKind:null};}
