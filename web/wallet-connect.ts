import type {Injected} from '../src/wallet-providers.ts';
import {bsc} from 'viem/chains';
import {watchWalletConnect} from '../src/wallet-connect-session.ts';
import type {AppKit} from '@reown/appkit';
import type {Wallet,createAppKitWalletButton} from '@reown/appkit-wallet-button';
let current:Promise<AppKit>|undefined;
let walletButtons:ReturnType<typeof createAppKitWalletButton>|undefined;
let cancelPending:()=>void=()=>{},activeProvider:Injected|undefined;
// Load only after an explicit click and only when a real, owned Project ID is configured.
export async function openWalletConnect(projectId:string,connected:(p:Injected)=>void,wallet?:Wallet){
 if(!/^[a-f0-9]{32}$/i.test(projectId))throw Error('钱包扫码连接尚未开放。');
 if(!current)current=Promise.all([import('@reown/appkit'),import('@reown/appkit-adapter-ethers')]).then(([{createAppKit},{EthersAdapter}])=>createAppKit({adapters:[new EthersAdapter()],networks:[bsc],projectId,metadata:{name:'唐毓文币 · NoMTF · TYW',description:'老唐的个人 meme 币，BSC 真实资产永久组合；实际申购铸币、赎回销毁。',url:'https://xyn.lgbt',icons:['https://xyn.lgbt/token-icon.png']},enableWallets:true,enableCoinbase:false,enableInjected:false,features:{analytics:false,email:false,socials:[],swaps:false,onramp:false,send:false},themeMode:'light',themeVariables:{'--w3m-accent':'#086a96','--w3m-border-radius-master':'2px'}})).catch(e=>{current=undefined;throw e;});
 const modal=await current;cancelPending();
 const existing=modal.getWalletProvider() as Injected|undefined;
 if(existing&&modal.getAccount('eip155')?.isConnected){activeProvider=existing;connected(existing);return modal;}
 cancelPending=watchWalletConnect(modal,p=>{activeProvider=p;connected(p);});
 try{
  if(wallet){
   if(!walletButtons){const {createAppKitWalletButton}=await import('@reown/appkit-wallet-button');walletButtons=createAppKitWalletButton({namespace:'eip155'});}
   const end=Date.now()+8000;while(!walletButtons.isReady()&&Date.now()<end)await new Promise(r=>setTimeout(r,100));
   if(walletButtons.isReady())await walletButtons.connect(wallet);else await modal.open({view:'Connect',namespace:'eip155'});
  }else await modal.open({view:'Connect',namespace:'eip155'});
 }catch(e){cancelPending();throw e;}return modal;
}
export async function disconnectWalletConnect(provider:Injected|null){
 if(!current||!provider||provider!==activeProvider)return false;
 cancelPending();activeProvider=undefined;await(await current).disconnect('eip155');return true;
}
