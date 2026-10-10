import {test} from 'node:test';import assert from 'node:assert/strict';
import {watchWalletConnect,type ConnectModal} from '../src/wallet-connect-session.ts';
function fixture(){
 const listeners={providers:new Set<()=>void>(),account:new Set<()=>void>(),state:new Set<(s:{open:boolean})=>void>()};
 let provider:any,account:any={isConnected:false},open=false;
 const subscribe=(set:Set<any>,f:any)=>{set.add(f);return()=>set.delete(f);};
 const modal:ConnectModal={getWalletProvider:()=>provider,getAccount:()=>account,getState:()=>({open}),subscribeProviders:f=>subscribe(listeners.providers,f),subscribeAccount:f=>subscribe(listeners.account,f),subscribeState:f=>subscribe(listeners.state,f)};
 const wallet={request:async()=>[]};
 return{modal,wallet,listeners,provider:()=>{provider=wallet;listeners.providers.forEach(f=>f());},account:(value:any={isConnected:true,address:'0x1111111111111111111111111111111111111111'})=>{account=value;listeners.account.forEach(f=>f());},open:(value:boolean)=>{open=value;listeners.state.forEach(f=>f({open}));}};
}
const tick=()=>new Promise<void>(resolve=>queueMicrotask(resolve));
test('wallet provider is ignored until an authenticated EVM account exists; delivery is once',async()=>{const f=fixture(),got:any[]=[];watchWalletConnect(f.modal,p=>got.push(p));f.open(true);f.provider();await tick();assert.equal(got.length,0);f.account();f.account();await tick();assert.deepEqual(got,[f.wallet]);assert.equal(Object.values(f.listeners).reduce((n,s)=>n+s.size,0),0);});
test('closing or replacing a pending QR attempt removes every subscription and prevents late attachment',async()=>{for(const cancel of [false,true]){const f=fixture(),got:any[]=[];const stop=watchWalletConnect(f.modal,p=>got.push(p));f.open(true);if(cancel)stop();else f.open(false);await tick();f.provider();f.account();await tick();assert.equal(got.length,0);assert.equal(Object.values(f.listeners).reduce((n,s)=>n+s.size,0),0);}});
test('successful account events followed by modal closure still deliver once; invalid addresses do not attach',async()=>{const f=fixture(),got:any[]=[];watchWalletConnect(f.modal,p=>got.push(p));f.open(true);f.provider();f.account({isConnected:true,address:'not-an-address'});await tick();assert.equal(got.length,0);f.account();f.open(false);await tick();assert.equal(got.length,1);});
