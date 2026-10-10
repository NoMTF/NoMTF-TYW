import {parseAbi,hashTypedData,verifyTypedData,encodeFunctionData,isAddress,formatUnits,parseUnits,type Address,type Hex} from 'viem';
import {chainClient,TOKEN_ABI} from './chain.ts';
import {PERMANENT_ABI,PERMANENT_QUOTER_ABI,permanentQuote} from './permanent-chain.ts';
import {PANCAKE} from './assets.ts';import {USDT,WBNB} from './permanent-assets.ts';
export const BATCH_TYPES={Order:[{name:'user',type:'address'},{name:'redeem',type:'bool'},{name:'amount',type:'uint256'},{name:'minimum',type:'uint256'},{name:'maxFee',type:'uint256'},{name:'nonce',type:'uint256'},{name:'deadline',type:'uint256'},{name:'executor',type:'address'}]} as const;
export const BATCH_ABI=parseAbi([
 'function orderNonces(address) view returns(uint256)',
 'function invalidateNonce(uint256)',
 'function settleBuys((address user,bool redeem,uint256 amount,uint256 minimum,uint256 maxFee,uint256 nonce,uint256 deadline,address executor)[] orders,bytes[] signatures,uint256[] fees,uint256 shares,uint256[4] limits,uint256 deadline)',
 'function settleSells((address user,bool redeem,uint256 amount,uint256 minimum,uint256 maxFee,uint256 nonce,uint256 deadline,address executor)[] orders,bytes[] signatures,uint256[] fees,uint256[4] minimumLegs,uint256 deadline)',
 'event OrderSettled(address indexed user,uint256 indexed nonce,bool redeem,uint256 input,uint256 output,uint256 fee,uint256 refund)',
]);
const zero='0x0000000000000000000000000000000000000000' as Address,unit=10n**18n;
export const batchDomain=(vault:Address)=>({name:'NoMTF Batch',version:'1',chainId:56,verifyingContract:vault});
export type Order={user:Address;redeem:boolean;amount:bigint;minimum:bigint;maxFee:bigint;nonce:bigint;deadline:bigint;executor:Address};
export type WireOrder={user:Address;redeem:boolean;amount:string;minimum:string;maxFee:string;nonce:string;deadline:string;executor:Address};
export type Entry={id:Hex;order:WireOrder;signature:Hex;at:number;status:'QUEUED'|'EXPIRED'|'NONCE_ADVANCED'|'CONFIRMED';transaction?:Hex;output?:string;fee?:string;refund?:string};
export class BatchError extends Error {constructor(message:string,public status=422){super(message);}}
export function parseOrder(value:unknown):Order{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new BatchError('订单格式无效');const v=value as any;
 const fields=['user','redeem','amount','minimum','maxFee','nonce','deadline','executor'];
 if(Object.keys(v).sort().join(',')!==fields.sort().join(','))throw new BatchError('订单字段无效');
 if(!isAddress(v.user)||v.user.toLowerCase()===zero||!isAddress(v.executor)||typeof v.redeem!=='boolean')throw new BatchError('订单地址或方向无效');
 const n=(key:string)=>{if(typeof v[key]!=='string'||!/^\d{1,78}$/.test(v[key])||BigInt(v[key])>=2n**256n)throw new BatchError('订单数值无效');return BigInt(v[key]);};
 const o={user:v.user,redeem:v.redeem,amount:n('amount'),minimum:n('minimum'),maxFee:n('maxFee'),nonce:n('nonce'),deadline:n('deadline'),executor:v.executor};
 if(o.amount<unit/10n||o.amount>10n*unit||o.minimum===0n||o.minimum>1000n*unit||o.maxFee>unit)throw new BatchError('合批范围为 0.1–10，执行费上限 1 USDT');
 if(!o.redeem&&o.amount<=o.maxFee)throw new BatchError('费用不能超过申购金额');return o;
}
export const wireOrder=(o:Order):WireOrder=>({...o,amount:String(o.amount),minimum:String(o.minimum),maxFee:String(o.maxFee),nonce:String(o.nonce),deadline:String(o.deadline)});
export const orderId=(vault:Address,order:Order)=>hashTypedData({domain:batchDomain(vault),types:BATCH_TYPES,primaryType:'Order',message:order});
export function validateLifetime(order:Order,now:bigint){if(order.deadline<=now||order.deadline>now+86400n)throw new BatchError('订单已过期或超过 24 小时');}
export function validateSignatureShape(signature:unknown,contractWallet=false):asserts signature is Hex{
 if(typeof signature!=='string'||!/^0x(?:[0-9a-f]{2}){1,1024}$/i.test(signature))throw new BatchError('签名格式无效');
 if(!contractWallet){
  if(signature.length!==132||!['1b','1c'].includes(signature.slice(-2).toLowerCase()))throw new BatchError('账户签名格式无效');
  const s=BigInt('0x'+signature.slice(66,130));if(s===0n||s>0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n)throw new BatchError('账户签名无效');
 }
}
export function chooseEntries(entries:Entry[],redeem:boolean,now:number,limit=64){
 return entries.filter(e=>e.status==='QUEUED'&&e.order.redeem===redeem&&BigInt(e.order.deadline)>BigInt(Math.floor(now/1000))).sort((a,b)=>a.at-b.at||a.id.localeCompare(b.id)).slice(0,limit);
}
export function requireUniqueNonce(entries:Entry[],order:Order,id:Hex){
 const existing=entries.find(e=>e.order.user.toLowerCase()===order.user.toLowerCase()&&BigInt(e.order.nonce)===order.nonce);
 if(existing&&existing.id!==id)throw new BatchError('该序号已有签名订单。须链上取消后重新签名，替换服务器记录不能撤销旧签名。',409);
 return existing;
}
/** Current gas-price quote, fixed 64-order benchmark. This is an estimate, never a cost guarantee. */
export async function batchFeeQuote(rpc:string,redeem:boolean){
 const client=chainClient(rpc),blockNumber=await client.getBlockNumber();const gasPrice=await client.getGasPrice();
 const {result}=await client.simulateContract({address:PANCAKE.quoter,abi:PERMANENT_QUOTER_ABI,functionName:'quoteExactInputSingle',args:[{tokenIn:WBNB,tokenOut:USDT,amountIn:unit/100n,fee:500,sqrtPriceLimitX96:0n}],blockNumber});
 const bnbUsdt=result[0]*100n,gasUnits=redeem?2800000n:5800000n;
 const fee=(gasUnits*gasPrice*bnbUsdt*105n+64n*100n*unit-1n)/(64n*100n*unit);
 return{fee,gasPrice,bnbUsdt,blockNumber,benchmarkOrders:64};
}
export async function prepareBatchOrder(rpc:string,vault:Address,user:Address,amount:bigint,redeem:boolean){
 const client=chainClient(rpc),f=await batchFeeQuote(rpc,redeem),block=await client.getBlock({blockNumber:f.blockNumber});
 const [nonce,paused,supply,balance]=await Promise.all([
  client.readContract({address:vault,abi:BATCH_ABI,functionName:'orderNonces',args:[user],blockNumber:f.blockNumber}),client.readContract({address:vault,abi:PERMANENT_ABI,functionName:'paused',blockNumber:f.blockNumber}),
  client.readContract({address:vault,abi:PERMANENT_ABI,functionName:'totalSupply',blockNumber:f.blockNumber}),client.readContract({address:redeem?vault:USDT,abi:TOKEN_ABI,functionName:'balanceOf',args:[user],blockNumber:f.blockNumber}),
 ]);
 if(paused)throw new BatchError('合批金库尚未开放或已暂停',409);if(balance<amount)throw new BatchError('钱包余额不足',409);
 if(amount<unit/10n||amount>10n*unit||!redeem&&amount<=f.fee)throw new BatchError('金额过小或超出合批范围');
 let minimum:bigint;
 if(!redeem&&supply===0n)minimum=amount-f.fee;
 else{const q=await permanentQuote(rpc,vault,redeem?amount:amount-f.fee,redeem?'sell':'buy');minimum=redeem?BigInt(q.minimumStable)-f.fee:BigInt(q.shares)*995n/1000n;}
 if(minimum<=0n)throw new BatchError('无法取得正数最低到账');
 const order:Order={user,redeem,amount,minimum,maxFee:f.fee,nonce,deadline:block.timestamp+7200n,executor:zero};
 return{vault,chainId:56,domain:batchDomain(vault),types:BATCH_TYPES,order:wireOrder(order),id:orderId(vault,order),expiresAt:Date.now()+45000,
  feeUsdt:formatUnits(f.fee,18),minimum:formatUnits(minimum,18),minimumUnit:redeem?'USDT':'TYW',quorum:64,
  notice:'签名有效 2 小时；资金留在钱包，64 笔可执行订单共同结算。可链上取消签名；等待时间和未来全费用不保证。执行费包括 gas 报价余量。'};
}
export async function validateFundedOrder(rpc:string,vault:Address,order:Order,signature:Hex,verify=true){
 const client=chainClient(rpc),blockNumber=await client.getBlockNumber(),block=await client.getBlock({blockNumber});validateLifetime(order,block.timestamp);
 const [nonce,paused,balance,code]=await Promise.all([
  client.readContract({address:vault,abi:BATCH_ABI,functionName:'orderNonces',args:[order.user],blockNumber}),client.readContract({address:vault,abi:PERMANENT_ABI,functionName:'paused',blockNumber}),
  client.readContract({address:order.redeem?vault:USDT,abi:TOKEN_ABI,functionName:'balanceOf',args:[order.user],blockNumber}),verify?client.getCode({address:order.user,blockNumber}):'0x',
 ]);
 if(paused)throw new BatchError('合批金库已暂停',409);if(nonce!==order.nonce)throw new BatchError('订单序号已失效',409);if(balance<order.amount)throw new BatchError('钱包余额不足',409);
 if(!order.redeem){const allowance=await client.readContract({address:USDT,abi:TOKEN_ABI,functionName:'allowance',args:[order.user,vault],blockNumber});if(allowance<order.amount)throw new BatchError('请先完成指定金额的 USDT 授权',409);}
 if(verify){
  const contract=!!code&&code!=='0x';validateSignatureShape(signature,contract);let valid=false;
  if(contract){try{valid=(await client.readContract({address:order.user,abi:parseAbi(['function isValidSignature(bytes32,bytes) view returns(bytes4)']),functionName:'isValidSignature',args:[orderId(vault,order),signature],blockNumber}))==='0x1626ba7e';}catch{}}
  else valid=await verifyTypedData({address:order.user,domain:batchDomain(vault),types:BATCH_TYPES,primaryType:'Order',message:order,signature});
  if(!valid)throw new BatchError('签名核验失败');
 }
 return{blockNumber};
}
/** Prepare and simulate only. No wallet key, automatic execution, funding or broadcast. */
export function insufficientMinimumIndexes(orders:Order[],fees:bigint[],output:bigint,redeem:boolean){
 const weights=orders.map((o,i)=>o.amount-(redeem?0n:fees[i])),total=weights.reduce((a,b)=>a+b,0n);if(total<=0n)throw new BatchError('合批净金额无效');
 let prefix=0n,allocated=0n;const invalid:number[]=[];
 for(let i=0;i<orders.length;i++){prefix+=weights[i];const next=output*prefix/total,userOutput=next-allocated-(redeem?fees[i]:0n);allocated=next;if(userOutput<orders[i].minimum)invalid.push(i);}return invalid;
}
export function executorGasBudget(totalFees:bigint,gasPrice:bigint,bnbUsdt:bigint){if(totalFees<=0n||gasPrice<=0n||bnbUsdt<=0n)throw new BatchError('执行费或 gas 报价无效',409);return totalFees*unit/(gasPrice*bnbUsdt);}
export async function batchTransaction(rpc:string,vault:Address,entries:Entry[],executor:Address,redeem:boolean){
 const f=await batchFeeQuote(rpc,redeem),eligible:Entry[]=[];
 for(let start=0;start<entries.length;start+=8){const candidates=await Promise.all(entries.slice(start,start+8).map(async e=>{
  const o=parseOrder(e.order);if(o.redeem!==redeem||o.executor.toLowerCase()!==zero&&o.executor.toLowerCase()!==executor.toLowerCase()||o.maxFee<f.fee)return null;
  try{await validateFundedOrder(rpc,vault,o,e.signature);return e;}catch(e){if(e instanceof BatchError)return null;throw e;}
 }));eligible.push(...candidates.filter((e):e is Entry=>!!e));}
 let selected:Entry[]=[],q:Awaited<ReturnType<typeof permanentQuote>>|null=null;
 for(let tries=0;tries<8;tries++){
  selected=eligible.slice(0,64);if(selected.length<64)throw new BatchError(`当前可执行订单 ${selected.length}/64；余额、授权、费用或最低到账未满足的订单继续等待`,409);
  const os=selected.map(e=>parseOrder(e.order)),fs=os.map(()=>f.fee),amount=os.reduce((a,o)=>a+o.amount-(redeem?0n:f.fee),0n);
  q=await permanentQuote(rpc,vault,amount,redeem?'sell':'buy');const totalOutput=redeem?parseUnits(q.expectedOutputUsdt,18):BigInt(q.shares),invalid=insufficientMinimumIndexes(os,fs,totalOutput,redeem);
  if(!invalid.length)break;const ids=new Set(invalid.map(i=>selected[i].id));for(let i=eligible.length-1;i>=0;i--)if(ids.has(eligible[i].id))eligible.splice(i,1);q=null;
 }
 if(!q)throw new BatchError('尚未凑齐满足最低到账的订单，继续等待',409);
 const orders=selected.map(e=>parseOrder(e.order));
 // Each signature is revalidated on chain during actual settlement; the full call must simulate.
 const signatures=selected.map(e=>e.signature),fees=orders.map(()=>f.fee),block=await chainClient(rpc).getBlock({blockNumber:BigInt(q.blockNumber)}),deadline=block.timestamp+300n;
 const args=redeem?[orders,signatures,fees,q.limits.map(BigInt),deadline] as const:[orders,signatures,fees,BigInt(q.shares),q.limits.map(BigInt),deadline] as const;
 const functionName=redeem?'settleSells':'settleBuys';
 // ABI discriminated union uses fixed-length 4-element arrays; quoted limits are validated by the vault.
 const data=encodeFunctionData({abi:BATCH_ABI,functionName,args} as any),client=chainClient(rpc);
 const totalFees=f.fee*64n,gas=executorGasBudget(totalFees,f.gasPrice,f.bnbUsdt),gasCost=gas*f.gasPrice*f.bnbUsdt/unit;
 // Simulate with the exact affordable gas cap. Some RPC estimators return an unnecessarily
 // high limit; a successful bounded call proves this call can complete within the signed fee budget.
 await client.call({account:executor,to:vault,data,gas,gasPrice:f.gasPrice,blockNumber:BigInt(q.blockNumber)});
 return{status:'AWAITING_WALLET_SIGNATURE',vault,account:executor,chainId:56,mode:redeem?'sell':'buy',orderIds:selected.map(e=>e.id),transaction:{to:vault,data,value:'0',gasLimit:String(gas),gasPrice:String(f.gasPrice)},expiresAt:Date.now()+45000,
  feePerOrderUsdt:formatUnits(f.fee,18),totalFeeUsdt:formatUnits(totalFees,18),gasBnb:formatUnits(gas*f.gasPrice,18),gasUsdt:formatUnits(gasCost,18),gasUnits:String(gas),gasPriceWei:String(f.gasPrice),
  notice:'交易在执行费允许的 gas 上限内模拟，尚未发送。执行者支付 BNB gas；成功后收到公开 USDT 执行费。上限按捕获的 gas 和 BNB 报价计算，改高 gas 价格需要重新准备。'};
}
