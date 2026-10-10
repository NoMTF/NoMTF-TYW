import {parseTradeInput} from './trade-input.ts';
// Exact routing avoids encoded-path/method aliases.
export class HttpError extends Error { constructor(message:string,public status:number,public retryAfter?:number){super(message);} }
export const API_ROUTES:Record<string,{method:string;params:string[];heavy?:boolean;body?:number}>={
 '/api/health':{method:'GET',params:[]},'/api/config':{method:'GET',params:[]},
 '/api/state':{method:'GET',params:[]},'/api/quote':{method:'GET',params:['mode','amount','fresh'],heavy:true},
 '/api/liquidity':{method:'GET',params:[],heavy:true},
 '/api/check':{method:'POST',params:[],body:0},'/api/rebalance':{method:'GET',params:['account'],heavy:true},
 '/api/batch/prepare':{method:'GET',params:['account','amount','mode'],heavy:true},
 '/api/batch/status':{method:'GET',params:['account']},'/api/batch/transaction':{method:'GET',params:['account','mode'],heavy:true},
 '/api/batch/submit':{method:'POST',params:[],heavy:true,body:16384},'/api/batch/confirm':{method:'POST',params:[],heavy:true,body:256},
};
export function requestPolicy(request:Request){
 const url=new URL(request.url);
 if(url.href.length>2048)throw new HttpError('请求地址过长',414);
 if(/%|\\|\/\//.test(url.pathname))throw new HttpError('请求路径无效',400);
 const route=API_ROUTES[url.pathname];if(!route)throw new HttpError('接口不存在',404);
 if(request.method!==route.method)throw new HttpError('请求方法不支持',405);
 if(request.headers.get('Origin')&&request.headers.get('Origin')!==url.origin)throw new HttpError('拒绝跨站请求',403);
 if(request.headers.get('Sec-Fetch-Site')==='cross-site')throw new HttpError('拒绝跨站请求',403);
 const seen=new Set<string>();for(const [key,value]of url.searchParams){if(seen.has(key)||!route.params.includes(key)||value.length>128)throw new HttpError('请求参数无效',422);seen.add(key);}
 if(url.pathname==='/api/quote'||url.pathname==='/api/batch/prepare'){
  try{parseTradeInput(url.searchParams,url.pathname.includes('/batch/')?10:1000);}catch{throw new HttpError('金额或方向无效',422);}
 }
 if(url.searchParams.has('account')&&!/^0x[0-9a-f]{40}$/i.test(url.searchParams.get('account')!))throw new HttpError('钱包地址无效',422);
 if(url.searchParams.has('fresh')&&url.searchParams.get('fresh')!=='1')throw new HttpError('刷新参数无效',422);
 if(route.body&&!(request.headers.get('Content-Type')||'').toLowerCase().startsWith('application/json'))throw new HttpError('请使用 JSON 请求',415);
 return route;
}
type WindowCount={at:number;all:number;heavy:number;burstAt:number;burst:number};
export class RequestBudget {
 private entries=new Map<string,WindowCount>();
 constructor(private maxEntries=2048){}
 take(key:string,heavy:boolean,now=Date.now()){
  let entry=this.entries.get(key);if(!entry||now-entry.at>=60000){entry={at:now,all:0,heavy:0,burstAt:now,burst:0};this.entries.delete(key);}
  if(now-entry.burstAt>=10000){entry.burstAt=now;entry.burst=0;}
  if(entry.all>=90||(heavy&&(entry.heavy>=12||entry.burst>=4)))throw new HttpError('请求过于频繁，请稍后重试',429,Math.max(1,Math.ceil(((heavy&&entry.burst>=4?entry.burstAt+10000:entry.at+60000)-now)/1000)));
  if(!this.entries.has(key)&&this.entries.size>=this.maxEntries){for(const [k,v]of this.entries)if(now-v.at>=60000)this.entries.delete(k);if(this.entries.size>=this.maxEntries)throw new HttpError('服务繁忙，请稍后重试',429,60);}
  entry.all++;if(heavy){entry.heavy++;entry.burst++;}this.entries.set(key,entry);
 }
}
export function securityHeaders(wcEnabled=false){
 const connections=wcEnabled?' https://rpc.walletconnect.com https://rpc.walletconnect.org https://api.web3modal.org https://api.web3modal.com https://pulse.walletconnect.org https://relay.walletconnect.com https://relay.walletconnect.org wss://relay.walletconnect.com wss://relay.walletconnect.org https://verify.walletconnect.org https://verify.walletconnect.com':'';
 return {'X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin','X-Frame-Options':'DENY','Strict-Transport-Security':'max-age=31536000','Cross-Origin-Opener-Policy':'same-origin-allow-popups',
  'Permissions-Policy':'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Content-Security-Policy':`default-src 'self'; script-src 'self'; style-src 'self'${wcEnabled?" 'unsafe-inline'":''}; connect-src 'self' https://bsc-dataseed.bnbchain.org${connections}; img-src 'self' data:${wcEnabled?' https://api.web3modal.org https://api.web3modal.com https://explorer-api.walletconnect.com':''}; frame-src ${wcEnabled?'https://verify.walletconnect.org https://verify.walletconnect.com':"'none'"}; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; upgrade-insecure-requests`};
}
