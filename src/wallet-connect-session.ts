import type {Injected} from './wallet-providers.ts';
type Account={isConnected?:boolean;address?:string};
export type ConnectModal={
 getWalletProvider():unknown;getAccount(namespace:'eip155'):Account|undefined;getState():{open?:boolean};
 subscribeProviders(callback:()=>void):()=>void;
 subscribeAccount(callback:()=>void,namespace:'eip155'):()=>void;
 subscribeState(callback:(state:{open?:boolean})=>void):()=>void;
};
// A provider alone is not a connected account. Cancelled attempts cannot attach later.
export function watchWalletConnect(modal:ConnectModal,connected:(provider:Injected)=>void){
 let active=true,opened=!!modal.getState().open;const cleanup:Array<()=>void>=[];
 const stop=()=>{if(!active)return;active=false;for(const unsubscribe of cleanup)unsubscribe();};
 const evaluate=()=>{
  if(!active)return;const provider=modal.getWalletProvider() as Injected|undefined,account=modal.getAccount('eip155');
  if(!provider||typeof provider.request!=='function'||!account?.isConnected||!/^0x[0-9a-f]{40}$/i.test(account.address||''))return;
  stop();connected(provider);
 };
 const notify=()=>queueMicrotask(evaluate);
 cleanup.push(modal.subscribeProviders(notify));cleanup.push(modal.subscribeAccount(notify,'eip155'));
 cleanup.push(modal.subscribeState(state=>{if(state.open)opened=true;else if(opened)queueMicrotask(()=>{evaluate();stop();});}));
 notify();return stop;
}
