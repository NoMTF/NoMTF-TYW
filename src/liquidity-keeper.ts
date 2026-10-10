import {createPublicClient,createWalletClient,http,parseAbi,keccak256,formatEther,encodeFunctionData,type Address,type Hash} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';import {bsc} from 'viem/chains';
import {AUTO_ABI,autoLiquidityPlan,LiquidityMinimumError} from './liquidity-plan.ts';
import {liquidityCostPolicy,liquidityGasCost,type LiquidityCostEnv} from './liquidity-cost-policy.ts';
import {PERMANENT_ABI,PERMANENT_QUOTER_ABI} from './permanent-chain.ts';import {WBNB,USDT} from './permanent-assets.ts';import {PANCAKE} from './assets.ts';
import {feeCollectionPlan,mintedPositionIds,positionIds,type FeeEnv} from './liquidity-fees.ts';
export type LiquidityEnv=LiquidityCostEnv&FeeEnv&{RPC_URL:string;LIQUIDITY_CONTROLLER?:string;LIQUIDITY_CONTROLLER_CODE_HASH?:string;LIQUIDITY_KEEPER_KEY?:string;LIQUIDITY_ENABLED?:string;LIQUIDITY_MODE?:string};
const ABI=parseAbi(['function preview() view returns(uint128 liquidity,uint128 usdt,uint128 tokens,int24 lower,int24 upper)','function add() returns(uint256)','function poolId() view returns(bytes32)','function treasury() view returns(address)','function enabled() view returns(bool)']);
const TREASURY='0x9979ba992c6aaf7cdd068a82d14f7afa6c7f4cd1';
export type KeeperRecord={at:number;status:string;operation?:string;hash?:Hash;blockNumber?:string;gasSpentWei?:string;matchedUsdt?:string;matchedTyw?:string;estimatedGas?:string;gasPriceWei?:string;gasBalanceBnb?:string;inventoryValueUsdt?:string;minimumValueUsdt?:string;maximumGasBps?:number;maximumGasCostUsdt?:string};
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
 const pending=await storage.get<{hash:Hash;raw:Hash;operation?:string}>('liquidity:pending');
 if(pending){
  let receipt;try{receipt=await client.getTransactionReceipt({hash:pending.hash});}catch{
   // Retry the identical signed transaction only: same nonce, hash and bounded gas.
   try{await client.sendRawTransaction({serializedTransaction:pending.raw});}catch{}
   return save({at,status:'PENDING',hash:pending.hash,operation:pending.operation});
  }
  if(receipt.status==='success'&&pending.operation!=='COLLECT_FEES'){
   const ids=mintedPositionIds(receipt.logs);if(ids.length){const learned=await storage.get<string[]>('liquidity:positions')||[];await storage.put('liquidity:positions',positionIds(undefined,[...learned,...ids]).map(String));}
  }
  spent+=receipt.gasUsed*receipt.effectiveGasPrice;await storage.put('liquidity:gas',{day,spent:String(spent)});
  await storage.put('liquidity:pending',null);return save({at,status:receipt.status==='success'?(pending.operation==='COLLECT_FEES'?'FEES_COLLECTED':'ADDED'):'REVERTED',operation:pending.operation,hash:pending.hash,blockNumber:String(receipt.blockNumber),gasSpentWei:String(receipt.gasUsed*receipt.effectiveGasPrice)});
 }
 let policy;try{policy=liquidityCostPolicy(env);}catch{return save({at,status:'INVALID_COST_POLICY'});}
 const policyRecord={minimumValueUsdt:formatEther(policy.minimumValue),maximumGasBps:Number(policy.maximumGasBps)};
 const code=await client.getCode({address});if(!code||keccak256(code)!==env.LIQUIDITY_CONTROLLER_CODE_HASH)throw Error('Controller code mismatch');
 const [owner,enabled]=await Promise.all([client.readContract({address,abi:ABI,functionName:'treasury'}),client.readContract({address,abi:ABI,functionName:'enabled'})]);
 if(owner.toLowerCase()!==TREASURY)throw Error('Treasury mismatch');if(!enabled)return save({at,status:'DISABLED_BY_TREASURY'});
 const send=async(to:Address,data:`0x${string}`,value:bigint,usdt:bigint,tokens:bigint,operation:string):Promise<KeeperRecord>=>{
  const price=await client.getGasPrice();if(price<=0n||price>150000000n)return {at,status:'WAITING_FOR_GAS_BUDGET',gasPriceWei:String(price),operation};
  const transaction={account,to,data,value:0n,type:'legacy' as const,gasPrice:price};
  const [estimate,balance]=await Promise.all([client.estimateGas(transaction),client.getBalance({address:account.address})]);
  let gas:bigint;try{gas=keeperGasLimit(estimate,price,balance,spent);}catch{return {at,status:'WAITING_FOR_GAS_BUDGET',matchedUsdt:formatEther(usdt),matchedTyw:formatEther(tokens),estimatedGas:String(estimate),gasPriceWei:String(price),gasBalanceBnb:formatEther(balance),operation};}
  let economics;try{
   const blockNumber=await client.getBlockNumber();const {result}=await client.simulateContract({address:PANCAKE.quoter,abi:PERMANENT_QUOTER_ABI,functionName:'quoteExactInputSingle',args:[{tokenIn:WBNB,tokenOut:USDT,amountIn:10000000000000000n,fee:500,sqrtPriceLimitX96:0n}],blockNumber});
   economics=liquidityGasCost(value,gas,price,result[0]*100n,policy.maximumGasBps);
  }catch{return {at,status:'WAITING_FOR_GAS_VALUATION',inventoryValueUsdt:formatEther(value),operation,...policyRecord};}
  const costRecord={inventoryValueUsdt:formatEther(value),maximumGasCostUsdt:formatEther(economics.cost),operation,...policyRecord};
  if(!economics.allowed)return {at,status:'WAITING_FOR_ECONOMIC_GAS',...costRecord};
  await client.call({...transaction,gas});
  const signer=createWalletClient({account,chain:bsc,transport:http(env.RPC_URL,{timeout:15000,retryCount:0})});
  // Save the exact raw transaction BEFORE broadcast. Retries cannot use a second nonce.
  const nonce=await client.getTransactionCount({address:account.address,blockTag:'pending'});
  const prepared=await signer.prepareTransactionRequest({...transaction,nonce,gas});
  const raw=await signer.signTransaction(prepared),hash=keccak256(raw);await storage.put('liquidity:pending',{hash,raw,operation});
  try{await signer.sendRawTransaction({serializedTransaction:raw});}catch{return {at,status:'BROADCAST_UNCERTAIN',hash,...costRecord};}
  return {at,status:'PENDING',hash,matchedUsdt:formatEther(usdt),matchedTyw:formatEther(tokens),...costRecord};
 };
 if(env.LIQUIDITY_FEE_COLLECTOR){
  let fee;
  try{fee=await feeCollectionPlan(env.RPC_URL,env,await storage.get<string[]>('liquidity:positions')||[],await storage.get<number>('liquidity:fee-cursor')||0,policy.minimumValue);}
  catch{await storage.put('liquidity:fees',{at,status:'WAITING_FOR_COLLECTOR_APPROVAL_OR_QUOTES'});}
  if(fee){await storage.put('liquidity:fee-cursor',fee.nextCursor);
   if(!fee.waiting){
    // The fee claim must pay for its own gas; large idle inventory cannot hide a costly claim.
    const result=await send(fee.to,fee.data,fee.value,fee.cash,fee.tokens,'COLLECT_FEES');await storage.put('liquidity:fees',result);
    if(result.status==='PENDING'||result.status==='BROADCAST_UNCERTAIN')return save(result);
   }else await storage.put('liquidity:fees',{at,status:'WAITING_FOR_FEE_VALUE',...policyRecord});
  }
 }
 let usdt:bigint,tokens:bigint,value:bigint,data:`0x${string}`,operation='MATCHED';
 try{
  if(env.LIQUIDITY_MODE==='auto'){
   const plan=await autoLiquidityPlan(env.RPC_URL,address,policy.minimumValue);usdt=plan.cash;tokens=plan.tokens;value=plan.value;operation=plan.operation;
   data=encodeFunctionData({abi:AUTO_ABI,functionName:'provide',args:plan.args});
  }else{
   const [liquidity,cash,held]=await client.readContract({address,abi:ABI,functionName:'preview'});
   if(liquidity<=0n||cash<500000000000000000n)return save({at,status:'WAITING_FOR_INVENTORY'});
   usdt=cash;tokens=held;const [,nav]=await client.readContract({address:'0xaE7eA21fBf3613fFc17fe962EE66bfe03015fBa7',abi:PERMANENT_ABI,functionName:'valuation'});
   value=usdt+tokens*nav/10n**18n;if(value<policy.minimumValue)throw new LiquidityMinimumError(value);
   data=encodeFunctionData({abi:ABI,functionName:'add'});
  }
 }catch(error){if(error instanceof LiquidityMinimumError)return save({at,status:'WAITING_FOR_MINIMUM_VALUE',inventoryValueUsdt:formatEther(error.value),...policyRecord});return save({at,status:'WAITING_FOR_INVENTORY_PRICE_OR_QUOTES',...policyRecord});}
 return save(await send(address,data,value,usdt,tokens,operation));
}
