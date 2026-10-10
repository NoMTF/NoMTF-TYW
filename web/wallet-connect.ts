import type {Injected} from '../src/wallet-providers.ts';
import {bsc} from 'viem/chains';
let current:Promise<any>|undefined;
// Load only after an explicit click and only when a real, owned Project ID is configured.
export async function openWalletConnect(projectId:string,connected:(p:Injected)=>void){
 if(!/^[a-f0-9]{32}$/i.test(projectId))throw Error('钱包扫码连接尚未开放。');
 if(!current)current=Promise.all([import('@reown/appkit'),import('@reown/appkit-adapter-ethers')]).then(([{createAppKit},{EthersAdapter}])=>createAppKit({adapters:[new EthersAdapter()],networks:[bsc],projectId,metadata:{name:'唐毓文币 · NoMTF · TYW',description:'老唐的个人 meme 币，BSC 真实资产永久组合；实际申购铸币、赎回销毁。',url:'https://xyn.lgbt',icons:['https://xyn.lgbt/token-icon.png']},enableWallets:true,enableCoinbase:false,enableInjected:false,features:{analytics:false,email:false,socials:[],swaps:false,onramp:false,send:false},themeMode:'dark'})).catch(e=>{current=undefined;throw e;});
 const modal=await current;
 const existing=modal.getProviders().eip155 as Injected|undefined;if(existing){connected(existing);return modal;}
 let attached:Injected|undefined,unsubscribe:(()=>void)|undefined;unsubscribe=modal.subscribeProviders((s:any)=>{const p=s.eip155 as Injected|undefined;if(p&&p!==attached){attached=p;unsubscribe?.();connected(p);}});
 await modal.open({view:'AllWallets',namespace:'eip155'});return modal;
}
