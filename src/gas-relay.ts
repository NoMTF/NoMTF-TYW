// Gas relay: users without BNB sign one EIP-712 trade request; our executor broadcasts it through the immutable
// GasRelay contract, pays the BNB gas, and receives only the USDT fee written in the signature.
import {createWalletClient,http,parseAbi,encodeFunctionData,keccak256,isAddress,getAddress,recoverTypedDataAddress,type Address,type Hash,type Hex} from 'viem';
import {privateKeyToAccount,type PrivateKeyAccount} from 'viem/accounts';import {bsc} from 'viem/chains';
import {chainClient} from './chain.ts';
import {HttpError} from './http-security.ts';
import {PERMANENT_QUOTER_ABI} from './permanent-chain.ts';
import {USDT,WBNB} from './permanent-assets.ts';import {PANCAKE} from './assets.ts';

export const RELAY_VAULT='0xaE7eA21fBf3613fFc17fe962EE66bfe03015fBa7' as const;
const TREASURY='0x9979Ba992c6aAf7cDd068A82d14F7Afa6c7f4cD1' as const;
// PancakeSwap V2 router (WETH() = WBNB, factory 0xcA14…5c73), used only to turn collected USDT fees back into BNB.
export const V2_ROUTER='0x10ED43C718714eb63d5aA57B78B54704E256024E' as const;
export const RELAY_ABI=parseAbi([
 'function nonces(address) view returns(uint256)','function vault() view returns(address)',
 'function execute((address owner,address executor,uint8 mode,uint8 feeAsset,uint256 budget,uint256 shares,uint256[4] limits,uint256 minNetStable,uint256 fee,uint256 nonce,uint256 deadline) r,bytes signature)',
 'function cancel(uint256 nextNonce)',
]);
const TOKEN=parseAbi(['function balanceOf(address) view returns(uint256)','function allowance(address,address) view returns(uint256)','function approve(address,uint256) returns(bool)']);
const V2=parseAbi(['function swapExactTokensForETH(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline) returns(uint256[])']);
const E18=10n**18n;

// Executor gas per relayed trade: fork-measured 842,641 (buy) and 767,706 (sell), plus ~18% headroom; see reports/gas-relay-fork.json.
export const RELAY_GAS={buy:1_000_000n,sell:900_000n,approve:70_000n} as const;
export const RELAY_LIMITS={
 minFee:10n**16n,maxFee:E18,              // 0.01–1 USDT
 dailyGasWei:5n*10n**15n,                 // executor spends at most 0.005 BNB a day
 maxGasPrice:1_000_000_000n,maxTxGas:2_000_000n,
 floatWei:3n*10n**14n,                    // below 0.0003 BNB the relay reports itself unavailable
 dripCooldownMs:30*86_400_000,dripsPerDay:50,
 swapAtUsdt:E18,swapMaxUsdt:20n*E18,      // convert fees to BNB once 1 USDT has accumulated, at most 20 USDT a time
 sweepAboveWei:2n*10n**16n,keepWei:10n**16n,
 deadlineWindow:1500n,                    // under the contract's 1800 s so chain/Worker clock skew cannot waste gas
 stuckMs:30*60_000,                       // longer than any signed deadline
} as const;

export type RelayEnv={RPC_URL:string;RELAY_ENABLED?:string;RELAY_ADDRESS?:string;RELAY_CODE_HASH?:string;RELAY_EXECUTOR_KEY?:string;LIQUIDITY_KEEPER_KEY?:string};
export type Store={get<T>(key:string):Promise<T|undefined>;put(key:string,value:unknown):Promise<void>};
type Config={relay:Address;codeHash:Hex;account:PrivateKeyAccount};
type Pending={hash:Hash;raw:Hex;label:string;at:number;nonce:number;from:Address;gasPrice:string};

export function relayConfig(env:RelayEnv):Config|null{
 if(env.RELAY_ENABLED!=='true'||!isAddress(env.RELAY_ADDRESS||'')||!/^0x[0-9a-f]{64}$/i.test(env.RELAY_CODE_HASH||'')||!/^0x[0-9a-f]{64}$/i.test(env.RELAY_EXECUTOR_KEY||''))return null;
 const account=privateKeyToAccount(env.RELAY_EXECUTOR_KEY as Hex);
 if(account.address.toLowerCase()===TREASURY.toLowerCase())throw Error('Treasury must not sign in Worker');
 // Two journals on one key would race the same nonce sequence.
 if(/^0x[0-9a-f]{64}$/i.test(env.LIQUIDITY_KEEPER_KEY||'')&&privateKeyToAccount(env.LIQUIDITY_KEEPER_KEY as Hex).address===account.address)throw Error('Relay executor must differ from the liquidity keeper');
 return {relay:getAddress(env.RELAY_ADDRESS!),codeHash:env.RELAY_CODE_HASH as Hex,account};
}

// fee = executor gas priced in USDT, +20% for gas-price moves and the USDT→BNB conversion,
// +0.003 USDT towards the one-time approval gas we hand out. Rounded up to 0.001 USDT.
export function relayFee(mode:'buy'|'sell',gasPrice:bigint,usdtPerBnb:bigint){
 const cost=RELAY_GAS[mode]*gasPrice*usdtPerBnb/E18,step=10n**15n;
 const fee=(cost*120n/100n+3n*step+step-1n)/step*step;
 return fee<RELAY_LIMITS.minFee?RELAY_LIMITS.minFee:fee;
}
// BNB the user needs for a 70k-gas approval at the given price, with 30% headroom.
export function approvalGasWei(gasPrice:bigint){return RELAY_GAS.approve*gasPrice*130n/100n;}

export {RELAY_TYPES,relayDomain,relayLimitsHash,relayMessage,type RelayRequest} from './relay-typed-data.ts';
import {RELAY_TYPES,relayDomain,relayMessage,type RelayRequest} from './relay-typed-data.ts';

const bad=(message:string)=>new HttpError(message,422);
function uint(value:unknown,max=(1n<<128n)-1n){if(typeof value!=='string'||!/^\d{1,40}$/.test(value))throw bad('签名内容格式不对');const n=BigInt(value);if(n>max)throw bad('签名内容超出范围');return n;}
// Everything the executor will broadcast is checked here first; the contract re-checks signature, nonce and amounts.
export function parseRelayRequest(body:any,executor:Address,nowSeconds:bigint):{request:RelayRequest;signature:Hex}{
 const r=body?.request,signature=body?.signature;
 if(!r||typeof r!=='object'||typeof signature!=='string'||!/^0x[0-9a-fA-F]{130}$/.test(signature))throw bad('缺少签名');
 if(!isAddress(r.owner)||!isAddress(r.executor)||getAddress(r.executor)!==getAddress(executor))throw bad('代付地址不对，请刷新页面');
 if(r.mode!==0&&r.mode!==1)throw bad('买卖方向不对');if(r.feeAsset!==0)throw bad('只接受用 USDT 付网络费');
 if(!Array.isArray(r.limits)||r.limits.length!==4)throw bad('报价参数不对');
 const request:RelayRequest={owner:getAddress(r.owner),executor:getAddress(r.executor),mode:r.mode,feeAsset:0,budget:uint(r.budget),shares:uint(r.shares),
  limits:[uint(r.limits[0]),uint(r.limits[1]),uint(r.limits[2]),uint(r.limits[3])],minNetStable:uint(r.minNetStable),fee:uint(r.fee),nonce:uint(r.nonce),deadline:uint(r.deadline,1n<<64n)};
 if(request.shares===0n)throw bad('数量不能为 0');
 if(request.fee<RELAY_LIMITS.minFee||request.fee>RELAY_LIMITS.maxFee)throw bad('网络费超出范围');
 if(request.mode===0&&(request.budget===0n||request.minNetStable!==0n||request.fee*2n>request.budget))throw bad('金额太小，代付的网络费超过了一半');
 if(request.mode===1&&(request.budget!==0n||request.minNetStable===0n))throw bad('卖出金额太小，扣掉网络费就不剩了');
 if(request.deadline<=nowSeconds+15n||request.deadline>nowSeconds+RELAY_LIMITS.deadlineWindow)throw bad('签名已过期，请重新确认');
 return {request,signature:signature as Hex};
}

const verified=new Map<string,boolean>();
async function checkedConfig(env:RelayEnv){
 const cfg=relayConfig(env);if(!cfg)throw new HttpError('代付暂未开放',409);
 const client=chainClient(env.RPC_URL),key=cfg.relay+cfg.codeHash;
 if(!verified.get(key)){
  const [code,vault]=await Promise.all([client.getCode({address:cfg.relay}),client.readContract({address:cfg.relay,abi:RELAY_ABI,functionName:'vault'})]);
  if(!code||keccak256(code)!==cfg.codeHash||getAddress(vault)!==getAddress(RELAY_VAULT))throw new HttpError('代付合约校验失败，已暂停代付',503);
  verified.set(key,true);
 }
 return {cfg,client};
}
type Client=ReturnType<typeof chainClient>;
async function usdtPerBnb(client:Client){
 const {result}=await client.simulateContract({address:PANCAKE.quoter,abi:PERMANENT_QUOTER_ABI,functionName:'quoteExactInputSingle',args:[{tokenIn:WBNB,tokenOut:USDT,amountIn:10n**16n,fee:500,sqrtPriceLimitX96:0n}]});
 const price=result[0]*100n;if(price<100n*E18||price>20_000n*E18)throw new HttpError('BNB 价格读取异常，代付暂停',503,30);return price;
}
async function gasPrice(client:Client){const price=await client.getGasPrice();if(price<=0n||price>RELAY_LIMITS.maxGasPrice)throw new HttpError('网络 gas 价格异常，代付暂停',503,30);return price;}
const today=(at=Date.now())=>new Date(at).toISOString().slice(0,10);
async function spentToday(storage:Store){const d=await storage.get<{day:string;wei:string}>('relay:gas');return d?.day===today()?BigInt(d.wei):0n;}
async function advanceNonce(storage:Store,next:number){const stored=await storage.get<number>('relay:nextNonce')??0;if(next>stored)await storage.put('relay:nextNonce',next);}

// Resolve the one in-flight executor transaction. Retries reuse the identical signed bytes, never a second nonce.
async function settle(client:Client,storage:Store):Promise<'clear'|'busy'>{
 const pending=await storage.get<Pending|null>('relay:pending');if(!pending)return 'clear';
 let receipt;try{receipt=await client.getTransactionReceipt({hash:pending.hash});}catch{
  try{await client.sendRawTransaction({serializedTransaction:pending.raw});}catch{}
  // Self-heal: a lagging node behind the public RPC can hand out an already-used nonce; that transaction never mines.
  const confirmed=await client.getTransactionCount({address:pending.from,blockTag:'latest'}).catch(()=>-1);
  if(confirmed>pending.nonce){await advanceNonce(storage,confirmed);await storage.put('relay:pending',null);return 'clear';}
  // Stuck past any signed deadline: free the slot; the next send replaces this nonce at a higher price.
  if(Date.now()-pending.at>RELAY_LIMITS.stuckMs){await storage.put('relay:bump',pending.gasPrice);await storage.put('relay:pending',null);return 'clear';}
  return 'busy';
 }
 const wei=(await spentToday(storage))+receipt.gasUsed*receipt.effectiveGasPrice;
 await storage.put('relay:gas',{day:today(),wei:String(wei)});await advanceNonce(storage,pending.nonce+1);await storage.put('relay:bump',null);await storage.put('relay:pending',null);
 await storage.put('relay:history:'+pending.hash,{label:pending.label,status:receipt.status,gasWei:String(receipt.gasUsed*receipt.effectiveGasPrice),block:String(receipt.blockNumber),at:pending.at});
 return 'clear';
}
// Turn the contract's revert reason into something a user can act on.
export function simulationMessage(detail:string){
 if(/exit minimum|minimum net|minimum|limits|entry cost/i.test(detail))return '价格刚好变了，按现在的价格成交会低于你签名里的保护线，请重新确认一次。';
 if(/nonce\/deadline|deadline/i.test(detail))return '签名已经过期或用过了，请重新确认。';
 if(/signature/i.test(detail))return '签名校验没通过，请重新确认。';
 if(/transfer amount exceeds|insufficient|allowance|funding/i.test(detail))return '钱包里的余额或授权不够这一笔，请刷新后再试。';
 if(/base fee|fee cap|gas/i.test(detail))return '网络 gas 价格刚变了，请重新确认。';
 return '交易模拟没通过，报价可能已经变了，请重新确认。';
}
async function send(env:RelayEnv,storage:Store,client:Client,account:PrivateKeyAccount,tx:{to:Address;data?:Hex;value?:bigint;label:string;maxCostWei?:bigint}){
 // One executor transaction at a time; a queued request waits up to ~15 s for the previous one to land.
 let clear=false;for(let i=0;i<15&&!clear;i++){clear=await settle(client,storage)==='clear';if(!clear)await new Promise(r=>setTimeout(r,1000));}
 if(!clear)throw new HttpError('代付通道正在处理上一笔，请几秒后再试',503,5);
 let price=await gasPrice(client);const bump=await storage.get<string|null>('relay:bump');
 if(bump){const replacement=BigInt(bump)*125n/100n;if(replacement>price)price=replacement;}
 const value=tx.value??0n,data=tx.data??'0x';
 // Legacy pricing like the keeper: viem's EIP-1559 default tip (1 gwei) exceeds BSC's whole 0.05 gwei price.
 const estimate=await client.estimateGas({account,to:tx.to,data,value,type:'legacy',gasPrice:price}).catch(e=>{const detail=String(e?.shortMessage||e?.message||e).slice(0,300);console.error('relay_estimate_failed',tx.label,detail);throw new HttpError(simulationMessage(detail),409);});
 const gas=estimate*120n/100n,cost=gas*price;
 if(gas>RELAY_LIMITS.maxTxGas)throw new HttpError('这笔交易的 gas 异常，已拒绝代付',409);
 if(tx.maxCostWei!==undefined&&estimate*price>tx.maxCostWei)throw new HttpError('网络费比签名里的高，请重新确认',409);
 if(cost+(await spentToday(storage))>RELAY_LIMITS.dailyGasWei)throw new HttpError('今天的代付额度用完了，明天再来，或者自备一点 BNB',503,3600);
 const balance=await client.getBalance({address:account.address});
 if(balance<cost+value+RELAY_LIMITS.floatWei/3n)throw new HttpError('代付钱包余额不足，暂时只能自备 BNB',503,600);
 // Never trust a single load-balanced node for the nonce: take the larger of the chain's count and our own record.
 const [latest,stored]=await Promise.all([client.getTransactionCount({address:account.address,blockTag:'latest'}),storage.get<number>('relay:nextNonce')]);
 const nonce=Math.max(latest,stored??0);
 const wallet=createWalletClient({account,chain:bsc,transport:http(env.RPC_URL,{timeout:15000,retryCount:0})});
 const prepared=await wallet.prepareTransactionRequest({account,chain:bsc,to:tx.to,data,value,gas,gasPrice:price,nonce,type:'legacy'});
 const raw=await wallet.signTransaction(prepared),hash=keccak256(raw);
 await storage.put('relay:pending',{hash,raw,label:tx.label,at:Date.now(),nonce,from:account.address,gasPrice:String(price)} satisfies Pending);
 try{await wallet.sendRawTransaction({serializedTransaction:raw});}catch{}
 return {hash,gas,gasPrice:price};
}
// Read-only wait used outside the executor lock; settlement happens on the next send or cron tick.
export async function relayConfirm(env:RelayEnv,hash:Hash,timeoutMs=12000){
 const client=chainClient(env.RPC_URL),end=Date.now()+timeoutMs;
 while(Date.now()<end){try{return (await client.getTransactionReceipt({hash})).status;}catch{}await new Promise(r=>setTimeout(r,800));}
 return 'pending' as const;
}

export async function relayInfo(env:RelayEnv,storage:Store){
 const cfg=relayConfig(env);if(!cfg)return {enabled:false};
 const {client}=await checkedConfig(env),[price,bnbPrice,balance,spent]=await Promise.all([gasPrice(client),usdtPerBnb(client),client.getBalance({address:cfg.account.address}),spentToday(storage)]);
 return {enabled:true,available:balance>=RELAY_LIMITS.floatWei&&spent+RELAY_GAS.buy*price*2n<=RELAY_LIMITS.dailyGasWei,chainId:56,relay:cfg.relay,executor:cfg.account.address,vault:RELAY_VAULT,
  fees:{buy:String(relayFee('buy',price,bnbPrice)),sell:String(relayFee('sell',price,bnbPrice))},gasPriceWei:String(price),usdtPerBnb:String(bnbPrice),
  approveGas:String(RELAY_GAS.approve),approvalGasWei:String(approvalGasWei(price)),expiresAt:Date.now()+60000};
}

export async function relaySubmit(env:RelayEnv,storage:Store,body:unknown,now=Date.now()){
 const {cfg,client}=await checkedConfig(env);
 const {request,signature}=parseRelayRequest(body,cfg.account.address,BigInt(Math.floor(now/1000)));
 const [price,bnbPrice]=await Promise.all([gasPrice(client),usdtPerBnb(client)]);
 if(request.fee*100n<relayFee(request.mode===0?'buy':'sell',price,bnbPrice)*90n)throw new HttpError('网络费报价变了，请重新确认',409);
 const signer=await recoverTypedDataAddress({domain:relayDomain(cfg.relay),types:RELAY_TYPES,primaryType:'TradeRequest',message:relayMessage(request),signature}).catch(()=>null);
 // Contract wallets (ERC-1271) cannot be recovered offline; the on-chain simulation below decides for them.
 if(signer!==request.owner&&!(await client.getCode({address:request.owner})))throw bad('签名和钱包地址对不上');
 const nonce=await client.readContract({address:cfg.relay,abi:RELAY_ABI,functionName:'nonces',args:[request.owner]});
 if(nonce!==request.nonce)throw new HttpError('这张签名已经用过或作废了，请重新确认',409);
 const data=encodeFunctionData({abi:RELAY_ABI,functionName:'execute',args:[request,signature]});
 // Never subsidise: the executor's BNB gas must fit inside the USDT fee the user signed.
 const sent=await send(env,storage,client,cfg.account,{to:cfg.relay,data,label:request.mode===0?'buy':'sell',maxCostWei:request.fee*E18/bnbPrice});
 return {hash:sent.hash};
}

// One-time approval gas: just enough BNB for a 70k-gas token approval to the relay, once per address and token.
export async function relayDrip(env:RelayEnv,storage:Store,body:any,now=Date.now()){
 const {cfg,client}=await checkedConfig(env);
 if(!isAddress(body?.owner)||(body?.mode!=='buy'&&body?.mode!=='sell'))throw bad('请先连接钱包');
 const owner=getAddress(body.owner),token=body.mode==='buy'?USDT:RELAY_VAULT;
 const [price,bnb,held,allowed]=await Promise.all([gasPrice(client),client.getBalance({address:owner}),
  client.readContract({address:token,abi:TOKEN,functionName:'balanceOf',args:[owner]}),client.readContract({address:token,abi:TOKEN,functionName:'allowance',args:[owner,cfg.relay]})]);
 if(allowed>=1n<<255n)throw new HttpError('已经授权过了，直接签名就行',409);
 const need=approvalGasWei(price);if(bnb>=need)throw new HttpError('钱包里的 BNB 已经够付授权的 gas',409);
 if(body.mode==='buy'?held<5n*10n**17n:held===0n)throw bad(body.mode==='buy'?'钱包里至少要有 0.5 USDT':'钱包里没有 TYW');
 const dripKey='relay:drip:'+owner.toLowerCase()+':'+body.mode,last=await storage.get<number>(dripKey);if(last&&now-last<RELAY_LIMITS.dripCooldownMs)throw new HttpError('这个地址已经领过一次授权 gas',429,86400);
 const counter=await storage.get<{day:string;count:number}>('relay:drips'),count=counter?.day===today(now)?counter.count:0;
 if(count>=RELAY_LIMITS.dripsPerDay)throw new HttpError('今天送出的授权 gas 已经到上限，明天再来，或者自备一点 BNB',503,3600);
 const amount=need-bnb,sent=await send(env,storage,client,cfg.account,{to:owner,value:amount,label:'drip'});
 await storage.put(dripKey,now);await storage.put('relay:drips',{day:today(now),count:count+1});
 return {hash:sent.hash,amountWei:String(amount),gasPriceWei:String(price),gasLimit:String(RELAY_GAS.approve)};
}

// Cron: turn collected USDT fees into BNB for the executor; send BNB above the working float back to the treasury.
export async function relayTick(env:RelayEnv,storage:Store,now=Date.now()){
 const cfg=relayConfig(env);if(!cfg)return {at:now,status:'DISABLED'};
 const save=async(record:Record<string,unknown>)=>{const full={at:now,...record};await storage.put('relay:last',full);return full;};
 try{
  const {client}=await checkedConfig(env),self=cfg.account.address;
  if(await settle(client,storage)==='busy')return save({status:'PENDING'});
  const [usdt,bnb]=await Promise.all([client.readContract({address:USDT,abi:TOKEN,functionName:'balanceOf',args:[self]}),client.getBalance({address:self})]);
  if(usdt>=RELAY_LIMITS.swapAtUsdt){
   const amount=usdt>RELAY_LIMITS.swapMaxUsdt?RELAY_LIMITS.swapMaxUsdt:usdt;
   const allowed=await client.readContract({address:USDT,abi:TOKEN,functionName:'allowance',args:[self,V2_ROUTER]});
   if(allowed<amount){const sent=await send(env,storage,client,cfg.account,{to:USDT,data:encodeFunctionData({abi:TOKEN,functionName:'approve',args:[V2_ROUTER,(1n<<256n)-1n]}),label:'approve-router'});return save({status:'APPROVING_ROUTER',hash:sent.hash});}
   // Minimum output from the deep V3 WBNB/USDT pool; a manipulated V2 price makes the swap revert instead of losing value.
   const minimum=amount*E18/(await usdtPerBnb(client))*97n/100n;
   const data=encodeFunctionData({abi:V2,functionName:'swapExactTokensForETH',args:[amount,minimum,[USDT,WBNB],self,BigInt(Math.floor(now/1000)+600)]});
   const sent=await send(env,storage,client,cfg.account,{to:V2_ROUTER,data,label:'fees-to-bnb'});return save({status:'SWAPPING_FEES',hash:sent.hash,usdt:String(amount),minimumBnb:String(minimum)});
  }
  if(bnb>RELAY_LIMITS.sweepAboveWei){const sent=await send(env,storage,client,cfg.account,{to:TREASURY,value:bnb-RELAY_LIMITS.keepWei,label:'sweep-to-treasury'});return save({status:'SWEPT',hash:sent.hash,bnb:String(bnb-RELAY_LIMITS.keepWei)});}
  return save({status:'IDLE',usdt:String(usdt),bnb:String(bnb)});
 }catch(e){return save({status:'ERROR',error:e instanceof HttpError?e.message:'tick failed'});}
}
