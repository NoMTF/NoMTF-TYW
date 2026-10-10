import {isAddress,parseUnits,decodeEventLog,type Address,type Hex} from 'viem';
import {chainClient} from './chain.ts';
import {BATCH_ABI,BatchError,parseOrder,wireOrder,orderId,requireUniqueNonce,chooseEntries,prepareBatchOrder,validateFundedOrder,batchTransaction,type Entry} from './batch-orders.ts';
export type BatchEnv={RPC_URL:string;BATCH_ADDRESS?:string;BATCH_QUEUE_ENABLED?:string};
const prefix='batch-v3:order:';
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
export async function boundedBody(request:Request,max=16384){
 if(Number(request.headers.get('Content-Length')||0)>max)throw new BatchError('请求过大',413);
 if(!request.body)return '';const reader=request.body.getReader();let size=0;const chunks:Uint8Array[]=[];
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>max)throw new BatchError('请求过大',413);chunks.push(value);}}finally{await reader.cancel();}
 const joined=new Uint8Array(size);let offset=0;for(const chunk of chunks){joined.set(chunk,offset);offset+=chunk.byteLength;}return new TextDecoder().decode(joined);
}
export class BatchQueue {
 constructor(private storage:DurableObjectStorage,private env:BatchEnv){}
 address(){if(!isAddress(this.env.BATCH_ADDRESS||'')||this.env.BATCH_QUEUE_ENABLED!=='true')throw new BatchError('合批队列尚未开放',409);return this.env.BATCH_ADDRESS as Address;}
 async entries(){return [...(await this.storage.list<Entry>({prefix})).values()];}
 async refresh(force=false){
  const vault=this.address(),entries=await this.entries(),client=chainClient(this.env.RPC_URL),blockNumber=await client.getBlockNumber(),block=await client.getBlock({blockNumber}),now=Number(block.timestamp);
  const last=await this.storage.get<number>('batch-v3:last-refresh');if(!force&&last&&Date.now()-last<10000)return entries;
  for(const e of entries){if(e.status==='QUEUED'&&BigInt(e.order.deadline)<=BigInt(now)){e.status='EXPIRED';await this.storage.put(prefix+e.id,e);}}
  const queued=entries.filter(e=>e.status==='QUEUED');
  // Bound parallel RPC calls and revalidate authoritative nonce; server removal is not signature revocation.
  for(let start=0;start<queued.length;start+=8){await Promise.all(queued.slice(start,start+8).map(async e=>{
   const nonce=await client.readContract({address:vault,abi:BATCH_ABI,functionName:'orderNonces',args:[e.order.user],blockNumber});
   if(nonce!==BigInt(e.order.nonce)){e.status='NONCE_ADVANCED';await this.storage.put(prefix+e.id,e);}
  }));}
  await this.storage.put('batch-v3:last-refresh',Date.now());return entries;
 }
 async submit(body:any){
  const vault=this.address();if(!body||typeof body!=='object'||Object.keys(body).sort().join(',')!=='order,signature')throw new BatchError('提交格式无效');
  const order=parseOrder(body.order),id=orderId(vault,order);await validateFundedOrder(this.env.RPC_URL,vault,order,body.signature);
  const entry:Entry={id,order:wireOrder(order),signature:body.signature,at:Date.now(),status:'QUEUED'};
  await this.storage.transaction(async tx=>{
   const current=[...(await tx.list<Entry>({prefix})).values()],same=requireUniqueNonce(current,order,id);if(same)return;
   const now=Date.now();const active=current.filter(e=>e.status==='QUEUED'&&BigInt(e.order.deadline)>BigInt(Math.floor(now/1000)));
   if(active.length>=256)throw new BatchError('当前合批队列已满，请稍后再试',429);
   if(current.some(e=>e.order.user.toLowerCase()===order.user.toLowerCase()&&now-e.at<10000))throw new BatchError('请稍后再提交新订单',429);
   for(const old of current.filter(e=>e.at<now-86400000&&e.status!=='QUEUED'))await tx.delete(prefix+old.id);
   await tx.put(prefix+id,entry);
  });
  return {ok:true,id,status:'QUEUED',notice:'仅签名订单已排队，资金未转移；该状态不代表申购或赎回已成交。'};
 }
 async confirm(hash:Hex){
  const vault=this.address();if(!/^0x[0-9a-f]{64}$/i.test(hash))throw new BatchError('交易哈希无效');
  const client=chainClient(this.env.RPC_URL),receipt=await client.getTransactionReceipt({hash}),head=await client.getBlockNumber();
  if(receipt.status!=='success'||head<receipt.blockNumber+1n)throw new BatchError('交易未成功或确认数不足',409);
  const entries=await this.entries();let confirmed=0;
  for(const log of receipt.logs){if(log.address.toLowerCase()!==vault.toLowerCase())continue;
   try{const decoded=decodeEventLog({abi:BATCH_ABI,data:log.data,topics:log.topics});if(decoded.eventName!=='OrderSettled')continue;const a=decoded.args;
    const e=entries.find(e=>e.order.user.toLowerCase()===a.user.toLowerCase()&&BigInt(e.order.nonce)===a.nonce&&e.order.redeem===a.redeem&&BigInt(e.order.amount)===a.input);
    if(e){e.status='CONFIRMED';e.transaction=hash;e.output=String(a.output);e.fee=String(a.fee);e.refund=String(a.refund);await this.storage.put(prefix+e.id,e);confirmed++;}
   }catch{/* Unknown log is never execution evidence. */}
  }
  if(!confirmed)throw new BatchError('回执中没有此队列的成功结算记录',409);return {ok:true,confirmed,transaction:hash};
 }
 async handle(request:Request){
  const url=new URL(request.url),vault=this.address();
  if(url.pathname==='/api/batch/prepare'&&request.method==='GET'){
   const user=url.searchParams.get('account'),raw=url.searchParams.get('amount')||'1',mode=url.searchParams.get('mode')||'buy';
   if(!user||!isAddress(user)||!/^\d{1,2}(\.\d{1,18})?$/.test(raw)||(mode!=='buy'&&mode!=='sell'))throw new BatchError('钱包、金额或方向无效');
   return json(await prepareBatchOrder(this.env.RPC_URL,vault,user,parseUnits(raw,18),mode==='sell'));
  }
  if(url.pathname==='/api/batch/submit'&&request.method==='POST'){
   let body;try{body=JSON.parse(await boundedBody(request));}catch(e){if(e instanceof BatchError)throw e;throw new BatchError('请求必须为 JSON');}return json(await this.submit(body));
  }
  if(url.pathname==='/api/batch/status'&&request.method==='GET'){
   const account=url.searchParams.get('account');if(account&&!isAddress(account))throw new BatchError('钱包地址无效');const entries=await this.refresh();
   const buys=chooseEntries(entries,false,Date.now()),sells=chooseEntries(entries,true,Date.now());
   return json({vault,chainId:56,quorum:64,queuedBuys:buys.length,queuedSells:sells.length,
    orders:account?entries.filter(e=>e.order.user.toLowerCase()===account.toLowerCase()).map(({signature,...publicEntry})=>publicEntry):[],
    notice:'每个方向需 64 笔可执行签名订单。排队数量仅表示签名与序号；余额、授权、费用及最低到账仍须在结算时检查。'});
  }
  if(url.pathname==='/api/batch/transaction'&&request.method==='GET'){
   const executor=url.searchParams.get('account'),mode=url.searchParams.get('mode')||'buy';if(!executor||!isAddress(executor)||(mode!=='buy'&&mode!=='sell'))throw new BatchError('执行钱包或方向无效');
   const last=await this.storage.get<number>('batch-v3:last-proposal');if(last&&Date.now()-last<30000)throw new BatchError('结算报价正在冷却，请 30 秒后重试',429);
   const all=await this.refresh(true),selected=chooseEntries(all,mode==='sell',Date.now(),256);if(selected.length<64)throw new BatchError(`签名订单 ${selected.length}/64，继续等待凑单`,409);
   await this.storage.put('batch-v3:last-proposal',Date.now());return json(await batchTransaction(this.env.RPC_URL,vault,selected,executor,mode==='sell'));
  }
  if(url.pathname==='/api/batch/confirm'&&request.method==='POST'){
   let body;try{body=JSON.parse(await boundedBody(request,256));}catch(e){if(e instanceof BatchError)throw e;throw new BatchError('请求必须为 JSON');}
   if(!body||Object.keys(body).join(',')!=='hash')throw new BatchError('回执提交格式无效');return json(await this.confirm(body.hash));
  }
  throw new BatchError('接口不存在',404);
 }
}
