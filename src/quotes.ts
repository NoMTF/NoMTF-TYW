import {createPublicClient,http,parseAbi} from 'viem';
import {bsc} from 'viem/chains';
import {ASSETS,PANCAKE,STABLES} from './assets.ts';
export type Quote = {symbol:string;ok:boolean;route:'PCSX'|'V3'|'NONE';inputRaw:string;outputRaw?:string;pool?:string;fee?:number;minimumUsd?:string;reason?:string;receivedAt:number;gasUnits?:string};
const factoryAbi=parseAbi(['function getPool(address,address,uint24) view returns(address)']);
const quoterAbi=parseAbi(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns(uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)']);
export async function xQuote(index:number,inputRaw:bigint,swapper='0x1111111111111111111111111111111111111111',reverse=false,fetcher:typeof fetch=fetch):Promise<Quote>{
  const asset=ASSETS[index]; const now=Math.floor(Date.now()/1000);
  const body={tokenInChainId:56,tokenIn:reverse?asset.address:STABLES.USDT.address,tokenOutChainId:56,tokenOut:reverse?STABLES.USDT.address:asset.address,amount:inputRaw.toString(),type:'EXACT_INPUT',slippageTolerance:'0.1',configs:[{routingType:'DUTCH_LIMIT',swapper}]};
  try{
    const r=await fetcher(`${PANCAKE.xBase}/order-price/get-price`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
    const d=await r.json() as any;
    if(!r.ok||d.messageType!=='PRICE_RESPONSE'){
      const reason=String(d.message?.error||d.errorCode||'无法获取可成交报价').slice(0,600);
      return{symbol:asset.symbol,ok:false,route:'NONE',inputRaw:inputRaw.toString(),reason,minimumUsd:reason.match(/Min amount:\s*([\d.]+)/)?.[1],receivedAt:now};
    }
    const o=d.message.bestOrder?.order; const witness=o?.permitData?.values?.witness??o?.permitData?.message?.witness;
    const outputs=o?.orderInfo?.outputs??o?.orderInfo?.baseOutputs??witness?.baseOutputs??witness?.outputs??o?.outputs;
    const expected=(reverse?STABLES.USDT.address:asset.address).toLowerCase();
    const domain=o?.permitData?.domain;
    if(domain?.chainId!==56)throw new Error('报价签名域的链编号不匹配');
    const output=outputs?.filter((x:any)=>String(x.token).toLowerCase()===expected&&String(x.recipient).toLowerCase()===swapper.toLowerCase()).reduce((s:bigint,x:any)=>{
      const start=BigInt(x.startAmount??x.amount??0),end=BigInt(x.endAmount??x.amount??start);
      return s+(start<end?start:end);
    },0n);
    if(!output||output<=0n) return{symbol:asset.symbol,ok:false,route:'NONE',inputRaw:inputRaw.toString(),reason:'返回了订单，但未能核验实际输出；不能据此发交易',receivedAt:now};
    return{symbol:asset.symbol,ok:true,route:'PCSX',inputRaw:inputRaw.toString(),outputRaw:output.toString(),receivedAt:now};
  }catch(e){return{symbol:asset.symbol,ok:false,route:'NONE',inputRaw:inputRaw.toString(),reason:e instanceof Error?e.message:'报价请求失败',receivedAt:now};}
}
export async function v3Pools(index:number,rpc:string){
  const client=createPublicClient({chain:bsc,transport:http(rpc,{timeout:15000,retryCount:1})});
  const result=await Promise.all([100,500,2500,10000].map(async fee=>{
    const pool=await client.readContract({address:PANCAKE.factory,abi:factoryAbi,functionName:'getPool',args:[STABLES.USDT.address,ASSETS[index].address,fee]});
    return {fee,pool};
  }));
  return result.filter(x=>x.pool!=='0x0000000000000000000000000000000000000000');
}
export async function v3Quote(index:number,inputRaw:bigint,rpc:string,reverse=false):Promise<Quote>{
  const asset=ASSETS[index],now=Math.floor(Date.now()/1000);
  try{
    const pools=await v3Pools(index,rpc);
    const client=createPublicClient({chain:bsc,transport:http(rpc,{timeout:15000,retryCount:0})});
    const results=await Promise.allSettled(pools.map(async p=>{
      const result=await client.simulateContract({address:PANCAKE.quoter,abi:quoterAbi,functionName:'quoteExactInputSingle',args:[{tokenIn:reverse?asset.address:STABLES.USDT.address,tokenOut:reverse?STABLES.USDT.address:asset.address,amountIn:inputRaw,fee:p.fee,sqrtPriceLimitX96:0n}]});
      return {p,output:result.result[0],gas:result.result[3]};
    }));
    const successful=results.flatMap(r=>r.status==='fulfilled'?[r.value]:[]).filter(r=>r.output>0n).sort((a,b)=>a.output>b.output?-1:1);
    const best=successful[0];
    if(!best)return{symbol:asset.symbol,ok:false,route:'NONE',inputRaw:inputRaw.toString(),reason:pools.length?'有池地址，但没有得到可执行的模拟报价':'未找到直接 USDT / 资产 V3 池',receivedAt:now};
    return{symbol:asset.symbol,ok:true,route:'V3',inputRaw:inputRaw.toString(),outputRaw:best.output.toString(),pool:best.p.pool,fee:best.p.fee,receivedAt:now,gasUnits:best.gas.toString()};
  }catch(e){return{symbol:asset.symbol,ok:false,route:'NONE',inputRaw:inputRaw.toString(),reason:e instanceof Error?e.message.slice(0,300):'链上报价失败',receivedAt:now};}
}
export async function basketQuote(totalRaw:bigint,rpc:string){
  const legs=await Promise.all(ASSETS.map(async(a,i)=>{
    const amount=totalRaw*BigInt(a.targetBps)/10000n;
    const x=await xQuote(i,amount);
    const v3=await v3Quote(i,amount,rpc);
    const choices=[x,v3].filter(q=>q.ok&&q.outputRaw);
    const best=choices.sort((a,b)=>BigInt(a.outputRaw!)>BigInt(b.outputRaw!)?-1:1)[0];
    return{symbol:a.symbol,weightBps:a.targetBps,inputRaw:amount.toString(),quotes:[x,v3],best:best??null};
  }));
  return {amountRaw:totalRaw.toString(),legs,allQuoted:legs.every(l=>l.best!==null),atomicAvailable:legs.every(l=>l.quotes.some(q=>q.ok&&q.route==='V3')),timestamp:Math.floor(Date.now()/1000),note:'报价不是成交证明。PCSX 是异步订单，不能作为三腿原子申购的成交回执。'};
}
