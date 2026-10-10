import {createPublicClient,createWalletClient,http,parseAbi,keccak256,formatEther,encodeFunctionData,type Address,type Hash} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';import {bsc} from 'viem/chains';
import {AUTO_ABI,autoLiquidityPlan} from './liquidity-plan.ts';
export type LiquidityEnv={RPC_URL:string;LIQUIDITY_CONTROLLER?:string;LIQUIDITY_CONTROLLER_CODE_HASH?:string;LIQUIDITY_KEEPER_KEY?:string;LIQUIDITY_ENABLED?:string;LIQUIDITY_MODE?:string};
const ABI=parseAbi(['function preview() view returns(uint128 liquidity,uint128 usdt,uint128 tokens,int24 lower,int24 upper)','function add() returns(uint256)','function poolId() view returns(bytes32)','function treasury() view returns(address)','function enabled() view returns(bool)']);
const TREASURY='0x9979ba992c6aaf7cdd068a82d14f7afa6c7f4cd1';
export type KeeperRecord={at:number;status:string;operation?:string;hash?:Hash;blockNumber?:string;gasSpentWei?:string;matchedUsdt?:string;matchedTyw?:string;estimatedGas?:string;gasPriceWei?:string;gasBalanceBnb?:string};
type Store={get<T>(key:string):Promise<T|undefined>;put(key:string,value:unknown):Promise<void>};
export function keeperGasLimit(estimate:bigint,price:bigint,balance:bigint,spentToday:bigint){
 if(estimate<=0n||estimate>2200000n||price<=0n||price>150000000n)throw Error('Gas cap');
 const limit=estimate*120n/100n,cost=limit*price;
 if(cost>150000000000000n||cost+spentToday>200000000000000n||balance<cost+20000000000000n)throw Error('Keeper gas budget');
 return limit;
}
export async function liquidityTick(env:LiquidityEnv,storage:Store):Promise<KeeperRecord>{
 const at=Date.now(),save=async(record:KeeperRecord)=>{await storage.put('liquidity:last',record);return record;};
 if(env.LIQUIDITY_ENABLED!=='true'||!/^0x[0-9a-f]{40}$/i.test(env.LIQUIDITY_CONTROLLER||'')||!/^0x[0-9a-f]{64}$/i.test(env.LIQUIDITY_CONTROLLER_CODE_HASH||'')||!/^0x[0-9a-f]{64}$/i.test(env.LIQUIDITY_KEEPER_KEY||''))return save({at,status:'DISABLED'});
 const client=createPublicClient({chain:bsc,transport:http(env.RPC_URL,{timeout:15000,retryCount:1})}),address=env.LIQUIDITY_CONTROLLER as Address;
 const account=privateKeyToAccount(env.LIQUIDITY_KEEPER_KEY as Hash);
 if(account.address.toLowerCase()===TREASURY)throw Error('Treasury must not sign in Worker');
 const day=new Date(at).toISOString().slice(0,10),daily=await storage.get<{day:string;spent:string}>('liquidity:gas');let spent=daily?.day===day?BigInt(daily.spent):0n;
 const pending=await storage.get<{hash:Hash;raw:Hash}>('liquidity:pending');
 if(pending){
  let receipt;try{receipt=await client.getTransactionReceipt({hash:pending.hash});}catch{
   // Retry the identical signed transaction only: same nonce, hash and bounded gas.
   try{await client.sendRawTransaction({serializedTransaction:pending.raw});}catch{}
   return save({at,status:'PENDING',hash:pending.hash});
  }
  spent+=receipt.gasUsed*receipt.effectiveGasPrice;await storage.put('liquidity:gas',{day,spent:String(spent)});
  await storage.put('liquidity:pending',null);return save({at,status:receipt.status==='success'?'ADDED':'REVERTED',hash:pending.hash,blockNumber:String(receipt.blockNumber),gasSpentWei:String(receipt.gasUsed*receipt.effectiveGasPrice)});
 }
 const code=await client.getCode({address});if(!code||keccak256(code)!==env.LIQUIDITY_CONTROLLER_CODE_HASH)throw Error('Controller code mismatch');
 const [owner,enabled]=await Promise.all([client.readContract({address,abi:ABI,functionName:'treasury'}),client.readContract({address,abi:ABI,functionName:'enabled'})]);
 if(owner.toLowerCase()!==TREASURY)throw Error('Treasury mismatch');if(!enabled)return save({at,status:'DISABLED_BY_TREASURY'});
 let usdt:bigint,tokens:bigint,data:`0x${string}`,operation='MATCHED';
 try{
  if(env.LIQUIDITY_MODE==='auto'){
   const plan=await autoLiquidityPlan(env.RPC_URL,address);usdt=plan.cash;tokens=plan.tokens;operation=plan.operation;
   data=encodeFunctionData({abi:AUTO_ABI,functionName:'provide',args:plan.args});
  }else{
   const [liquidity,cash,held]=await client.readContract({address,abi:ABI,functionName:'preview'});
   if(liquidity<=0n||cash<500000000000000000n)return save({at,status:'WAITING_FOR_INVENTORY'});
   usdt=cash;tokens=held;data=encodeFunctionData({abi:ABI,functionName:'add'});
  }
 }catch{return save({at,status:'WAITING_FOR_INVENTORY_PRICE_OR_QUOTES'});}
 const price=await client.getGasPrice();if(price<=0n||price>150000000n)return save({at,status:'WAITING_FOR_GAS_BUDGET',gasPriceWei:String(price)});
 const transaction={account,to:address,data,value:0n,type:'legacy' as const,gasPrice:price};
 const [estimate,balance]=await Promise.all([client.estimateGas(transaction),client.getBalance({address:account.address})]);
 let gas:bigint;try{gas=keeperGasLimit(estimate,price,balance,spent);}catch{return save({at,status:'WAITING_FOR_GAS_BUDGET',matchedUsdt:formatEther(usdt),matchedTyw:formatEther(tokens),estimatedGas:String(estimate),gasPriceWei:String(price),gasBalanceBnb:formatEther(balance)});}
 await client.call({...transaction,gas});
 const signer=createWalletClient({account,chain:bsc,transport:http(env.RPC_URL,{timeout:15000,retryCount:0})});
 // Deterministic nonce/raw transaction persisted BEFORE broadcast, so RPC timeouts cannot cause duplicate sends.
 const nonce=await client.getTransactionCount({address:account.address,blockTag:'pending'});
 const prepared=await signer.prepareTransactionRequest({...transaction,nonce,gas});
 const raw=await signer.signTransaction(prepared),hash=keccak256(raw);await storage.put('liquidity:pending',{hash,raw});
 try{await signer.sendRawTransaction({serializedTransaction:raw});}catch{return save({at,status:'BROADCAST_UNCERTAIN',hash});}
 return save({at,status:'PENDING',operation,hash,matchedUsdt:formatEther(usdt),matchedTyw:formatEther(tokens)});
}
