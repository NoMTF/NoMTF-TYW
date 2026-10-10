import {parseUnits} from 'viem';
export type TradeQuote={chainId:56;vault:string;mode:'buy'|'sell';budget:string;shares:string;limits:string[];required:string[];blockNumber:string;at:number;expiresAt:number;first:boolean;indicative:boolean;executionConstraint:null|'EXCEEDS_TOTAL_SUPPLY';expectedOutputUsdt:string;minimumStable:string;estimatedRefundUsdt:string;gasPriceWei:string;bnbUsdt:string|null;feeReferenceUsdt:string|null;acquiredValueUsdt?:string};
const maxUint=(1n<<256n)-1n;
const uint=(v:unknown,positive=false)=>{if(typeof v!=='string'||!/^\d{1,78}$/.test(v))throw Error('报价数值格式无效');const n=BigInt(v);if(n>maxUint||positive&&n===0n)throw Error('报价数值范围无效');return n;};
const decimal=(v:unknown)=>{if(typeof v!=='string'||!/^\d{1,30}(\.\d{1,18})?$/.test(v))throw Error('报价金额格式无效');return parseUnits(v,18);};
export function validateTradeQuote(value:unknown,expected:{vault:string;mode:'buy'|'sell';amount:bigint},now=Date.now()):TradeQuote{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('报价格式无效');const q=value as TradeQuote;
 if(q.chainId!==56||typeof q.vault!=='string'||q.vault.toLowerCase()!==expected.vault.toLowerCase())throw Error('报价合约或网络不匹配');
 if(q.mode!==expected.mode||uint(q.budget,true)!==expected.amount)throw Error('报价与输入不匹配');
 if(!Number.isSafeInteger(q.at)||!Number.isSafeInteger(q.expiresAt)||q.at<now-120000||q.at>now+30000||q.expiresAt<=now||q.expiresAt>now+60000||q.expiresAt<=q.at)throw Error('报价已过期或链上数据过旧，请刷新');
 uint(q.blockNumber,true);uint(q.shares,true);uint(q.gasPriceWei,true);
 if(typeof q.first!=='boolean'||typeof q.indicative!=='boolean'||q.indicative!==(q.executionConstraint==='EXCEEDS_TOTAL_SUPPLY')||!q.indicative&&q.executionConstraint!==null||q.indicative&&q.mode!=='sell')throw Error('报价执行状态无效');
 for(const key of ['limits','required'] as const){if(!Array.isArray(q[key])||q[key].length!==4)throw Error('报价资产数量无效');for(const v of q[key])uint(v,q.mode==='buy');}
 const output=decimal(q.expectedOutputUsdt),minimum=uint(q.minimumStable),refund=decimal(q.estimatedRefundUsdt);if(output<=0n||minimum!==output*995n/1000n||refund>expected.amount)throw Error('报价最低到账或找零无效');
 if(q.mode==='sell'&&(uint(q.shares)!==expected.amount||refund!==0n))throw Error('卖出份额与输入不匹配');
 if(q.mode==='buy'&&q.first&&uint(q.shares)!==expected.amount)throw Error('首次建仓份额与预算不匹配');
 if(q.mode==='buy'&&!q.first&&q.limits.reduce((sum,v)=>sum+uint(v),0n)>expected.amount)throw Error('四项兑换上限超过预算');
 if(q.bnbUsdt!==null&&decimal(q.bnbUsdt)<=0n)throw Error('gas 换算无效');
 if(q.feeReferenceUsdt!==null)decimal(q.feeReferenceUsdt);if(q.acquiredValueUsdt!==undefined)decimal(q.acquiredValueUsdt);
 return q;
}
export async function readJsonResponse(response:Response,max=65536):Promise<unknown>{
 if(!(response.headers.get('Content-Type')||'').toLowerCase().startsWith('application/json')||Number(response.headers.get('Content-Length')||0)>max)throw Error('服务返回格式或大小异常');
 if(!response.body)throw Error('服务返回为空');const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>max)throw Error('服务返回过大');chunks.push(value);}}finally{await reader.cancel();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}
