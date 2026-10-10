import {DurableObject} from 'cloudflare:workers';
import {isAddress,formatUnits,type Address} from 'viem';
import {chainClient} from './chain.ts';
import {PERMANENT_ABI,permanentQuote} from './permanent-chain.ts';
import {PERMANENT_ASSETS,USDT} from './permanent-assets.ts';
import {parseTradeInput} from './trade-input.ts';
import {permanentRebalanceProposal} from './permanent-rebalance.ts';
import {BatchQueue,boundedBody} from './batch-queue.ts';
import {BatchError} from './batch-orders.ts';
import {HttpError,RequestBudget,requestPolicy,securityHeaders} from './http-security.ts';
import {liquidityTick,type LiquidityEnv} from './liquidity-keeper.ts';import {liquidityInfo} from './liquidity-info.ts';
type Env=LiquidityEnv&{RPC_URL:string;VAULT_ADDRESS:string;WALLETCONNECT_PROJECT_ID?:string;BATCH_ADDRESS?:string;BATCH_QUEUE_ENABLED?:string;ASSETS:Fetcher;COORDINATOR:DurableObjectNamespace<PortfolioCoordinator>};
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
export class PortfolioCoordinator extends DurableObject<Env>{
  quoteCache=new Map<string,any>();
  budget=new RequestBudget();pending=new Map<string,Promise<any>>();starts:number[]=[];
  async work<T>(key:string,fn:()=>Promise<T>):Promise<T>{
    const existing=this.pending.get(key);if(existing)return existing;
    const now=Date.now();this.starts=this.starts.filter(at=>now-at<60000);
    if(this.pending.size>=4||this.starts.length>=90)throw new HttpError('链上报价繁忙，请稍后重试',503,5);
    this.starts.push(now);const promise=fn();this.pending.set(key,promise);try{return await promise;}finally{this.pending.delete(key);}
  }
  async state(){return this.work('state',()=>this.readState());}
  async readState(){
    if(!isAddress(this.env.VAULT_ADDRESS))throw new Error('Missing vault');
    const address=this.env.VAULT_ADDRESS as Address,client=chainClient(this.env.RPC_URL),blockNumber=await client.getBlockNumber();
    const [supply,paused,balances,oracle,nonce,cost]=await Promise.all([
      client.readContract({address,abi:PERMANENT_ABI,functionName:'totalSupply',blockNumber}),client.readContract({address,abi:PERMANENT_ABI,functionName:'paused',blockNumber}),
      client.readContract({address,abi:PERMANENT_ABI,functionName:'balances',blockNumber}),client.readContract({address,abi:PERMANENT_ABI,functionName:'oracle',blockNumber}),
      client.readContract({address,abi:PERMANENT_ABI,functionName:'rebalanceNonce',blockNumber}),client.readContract({address,abi:PERMANENT_ABI,functionName:'cumulativeRebalanceCost',blockNumber}),
    ]);
    let valuation=null,oracleReady=false;
    try{const [total,nav,weights,prices]=await client.readContract({address,abi:PERMANENT_ABI,functionName:'valuation',blockNumber});oracleReady=true;valuation={totalUsdt:formatUnits(total,18),perShareUsdt:supply>0n?formatUnits(nav,18):null,weightsBps:weights.map(Number),pricesUsdt:prices.map(v=>formatUnits(v,18))};}catch{}
    return {at:Date.now(),chainId:56,blockNumber:String(blockNumber),vault:address,oracle,assets:PERMANENT_ASSETS,stable:USDT,supply:formatUnits(supply,18),balances:balances.map(String),paused,oracleReady,valuation,
      status:paused?'PAUSED':!oracleReady?'ORACLE_UNAVAILABLE':supply===0n?'FIRST_BUY_READY':'ACTIVE',nonce:String(nonce),rebalanceCostUsdt:formatUnits(cost,18),executionMode:'monitor-and-user-sign',
      lastCheck:await this.ctx.storage.get('permanent:last-check')||null,task:await this.ctx.storage.get('permanent:task')||null,
      noSeedCapital:true,platformFeeBps:0,okxDexIntegrated:false,experimental:true,
      batchVault:this.env.BATCH_ADDRESS||null,batchQueueEnabled:this.env.BATCH_QUEUE_ENABLED==='true'};
  }
  async check(){
    const recent=await this.ctx.storage.get<any>('permanent:last-check');
    if(recent&&Date.now()-recent.at<60000)return {ok:true,result:recent.result,task:await this.ctx.storage.get('permanent:task')||null};
    const state=await this.state();let result='IN_BAND';let task:null|object=null;
    if(state.paused||!state.oracleReady||state.supply==='0')result='NO_TRADE';
    else if(state.valuation?.weightsBps.some(w=>w<=1500||w>=3500)){result='SIGNATURE_REQUIRED';task={nonce:state.nonce,status:'SIGNATURE_REQUIRED',weightsBps:state.valuation.weightsBps,targetsBps:[2500,2500,2500,2500],at:Date.now()};}
    await this.ctx.storage.put('permanent:last-check',{at:Date.now(),result,blockNumber:state.blockNumber});await this.ctx.storage.put('permanent:task',task);
    return {ok:true,result,task};
  }
  async fetch(request:Request){
    const url=new URL(request.url);
    try{
      if(url.pathname==='/__gate'){
        const {key,heavy}=await request.json() as {key:string;heavy:boolean};if(!/^[a-f0-9]{64}$/.test(key)||typeof heavy!=='boolean')throw new HttpError('无效限流请求',400);
        this.budget.take(key,heavy);return json({ok:true});
      }
      if(url.pathname==='/__liquidity_tick'&&request.method==='POST')return json(await this.work('liquidity-tick',()=>liquidityTick(this.env,this.ctx.storage)));
      if(url.pathname==='/api/liquidity'&&request.method==='GET')return json({...await this.work('liquidity-info',()=>liquidityInfo(this.env)),keeper:await this.ctx.storage.get('liquidity:last')||null});
      if(url.pathname.startsWith('/api/batch/')){
        if(this.env.BATCH_QUEUE_ENABLED!=='true'||!isAddress(this.env.BATCH_ADDRESS||''))return json({error:'合批队列尚未开放'},409);
        return await this.work('batch:'+url.pathname+url.search+(request.method==='POST'?crypto.randomUUID():''),()=>new BatchQueue(this.ctx.storage,this.env).handle(request));
      }
      if(url.pathname==='/api/state'&&request.method==='GET'){
        const cached=await this.ctx.storage.get<any>('permanent:state');if(cached&&Date.now()-cached.at<10000)return json(cached);
        const state=await this.state();await this.ctx.storage.put('permanent:state',state);return json(state);
      }
      if(url.pathname==='/api/quote'&&request.method==='GET'){
        const {amount,mode}=parseTradeInput(url.searchParams);
        const key=`${mode}:${amount}`,cached=this.quoteCache.get(key);if(!url.searchParams.has('fresh')&&cached&&cached.expiresAt>Date.now()+30000)return json(cached);
        const quote=await this.work(key,()=>permanentQuote(this.env.RPC_URL,this.env.VAULT_ADDRESS as Address,amount,mode));
        if(this.quoteCache.size>=32)this.quoteCache.delete(this.quoteCache.keys().next().value!);this.quoteCache.set(key,quote);return json(quote);
      }
      if(url.pathname==='/api/check'&&request.method==='POST')return json(await this.check());
      if(url.pathname==='/api/rebalance'&&request.method==='GET'){
        const account=url.searchParams.get('account');if(!account||!isAddress(account))return json({error:'请提供签名钱包地址'},422);
        const state=await this.state();if(state.paused||state.supply==='0'||!state.oracleReady)return json({error:'金库未建仓、已暂停或估值不可用'},409);
        if(!state.valuation?.weightsBps.some(w=>w<=1500||w>=3500))return json({error:'当前权重在触发区间内，无需调仓'},409);
        const key=`rebalance:${account.toLowerCase()}`,cached=this.quoteCache.get(key);if(cached&&cached.expiresAt>Date.now()+30000)return json(cached);
        const proposal=await this.work(key,()=>permanentRebalanceProposal(this.env.RPC_URL,this.env.VAULT_ADDRESS as Address,account));
        if(this.quoteCache.size>=32)this.quoteCache.delete(this.quoteCache.keys().next().value!);this.quoteCache.set(key,proposal);return json(proposal);
      }
      return json({error:'接口不存在'},404);
    }catch(e){if(e instanceof HttpError){const response=json({error:e.message},e.status);if(e.retryAfter)response.headers.set('Retry-After',String(e.retryAfter));return response;}if(e instanceof BatchError)return json({error:e.message},e.status);console.error('permanent_read_failed',url.pathname,e instanceof Error?e.name:'error');return json({error:'链上读取或交易模拟暂时不可用，请查看钱包与订单状态；本站没有代签交易'},503);}
  }
}
import {EXIT_CSP} from './exit-policy.ts';
import {BOOT_SCRIPT_HASH,BOOT_STYLE_HASH} from './boot-policy.ts';
export default {
 async fetch(request:Request,env:Env):Promise<Response>{
   let response:Response;try{response=await handle(request,env);}catch(e){if(e instanceof HttpError){response=json({error:e.message},e.status);if(e.retryAfter)response.headers.set('Retry-After',String(e.retryAfter));}else if(e instanceof BatchError)response=json({error:e.message},e.status);else response=json({error:'服务暂时不可用，请稍后重试'},503);}
   const headers=new Headers(response.headers),wcEnabled=/^[a-f0-9]{32}$/i.test(env.WALLETCONNECT_PROJECT_ID||'');for(const [k,v]of Object.entries(securityHeaders(wcEnabled)))headers.set(k,v);
   if(new URL(request.url).pathname==='/exit.html')headers.set('Content-Security-Policy',EXIT_CSP);
   if(new URL(request.url).pathname==='/')headers.set('Content-Security-Policy',headers.get('Content-Security-Policy')!.replace("script-src 'self'",`script-src 'self' ${BOOT_SCRIPT_HASH}`).replace("style-src 'self'",`style-src 'self' ${BOOT_STYLE_HASH}`));
   if(new URL(request.url).pathname.startsWith('/api/'))headers.set('X-Robots-Tag','noindex, nofollow');
   if(new URL(request.url).pathname.startsWith('/api/')){headers.set('Cache-Control','no-store');headers.set('Cross-Origin-Resource-Policy','same-origin');}
   return new Response(response.body,{status:response.status,headers});
 },
 async scheduled(c:ScheduledController,env:Env,ctx:ExecutionContext){const path=c.cron==='0 * * * *'?'/api/check':'/__liquidity_tick';ctx.waitUntil(env.COORDINATOR.getByName('permanent-56').fetch('https://internal'+path,{method:'POST'}));},
};
async function handle(request:Request,env:Env):Promise<Response>{
    const url=new URL(request.url);
    if(url.protocol==='http:'&&!['127.0.0.1','localhost'].includes(url.hostname)){url.protocol='https:';return Response.redirect(url.toString(),308);}
    if(['www.xyn.lgbt','nomtf-tyw.guhuao666.workers.dev'].includes(url.hostname)&&!url.pathname.startsWith('/api/')){url.protocol='https:';url.hostname='xyn.lgbt';return Response.redirect(url.toString(),308);}
    if(/%|\\|\/\//.test(url.pathname))throw new HttpError('请求路径无效',400);
    if(url.pathname==='/api'||url.pathname.startsWith('/api/')){
      const route=requestPolicy(request);
      if(url.pathname==='/api/health')return json({ok:true,version:'permanent-v2.1'});
      if(url.pathname==='/api/config')return json({walletConnectProjectId:/^[a-f0-9]{32}$/i.test(env.WALLETCONNECT_PROJECT_ID||'')?env.WALLETCONNECT_PROJECT_ID:null});
      const ip=request.headers.get('CF-Connecting-IP')||'local',key=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(ip)))].map(v=>v.toString(16).padStart(2,'0')).join('');
      const gate=await env.COORDINATOR.getByName('security-'+key.slice(0,1)).fetch('https://internal/__gate',{method:'POST',body:JSON.stringify({key,heavy:!!route.heavy})});
      if(!gate.ok)return gate;
    }
    if(url.pathname.startsWith('/api/')){
      if(request.method==='POST'){
        const origin=request.headers.get('Origin');if(origin&&origin!==url.origin)return json({error:'拒绝跨站操作'},403);
        if(url.pathname==='/api/batch/submit'||url.pathname==='/api/batch/confirm'){
          try{const body=await boundedBody(request,url.pathname.endsWith('/confirm')?256:16384);request=new Request(request.url,{method:'POST',headers:request.headers,body});}catch(e){if(e instanceof BatchError)return json({error:e.message},e.status);throw e;}
        }else{
        if(url.pathname!=='/api/check')return json({error:'接口不存在'},404);
        if(Number(request.headers.get('Content-Length')||0)>0)return json({error:'此接口不接受请求正文'},422);
        // Cloudflare can represent an empty POST as a non-null ReadableStream.
        if(request.body){const reader=request.body.getReader();const chunk=await reader.read();await reader.cancel();if(!chunk.done&&chunk.value.byteLength>0)return json({error:'此接口不接受请求正文'},422);}
        request=new Request(request.url,{method:'POST',headers:request.headers});
        }
      }
      return env.COORDINATOR.getByName('permanent-56').fetch(request);
    }
    if(!['GET','HEAD'].includes(request.method))throw new HttpError('请求方法不支持',405);
    if(url.pathname!=='/'&&(!/^\/(assets\/[a-zA-Z0-9_.-]+|app\.json|boot\.(?:js|css)|exit\.html|token-icon(?:-(?:64|120|200|256))?\.png|favicon\.svg|social-cover(?:-tyw)?\.(?:png|svg)|robots\.txt|sitemap\.xml|site\.webmanifest|tokenlist\.json|implementation\.json|token-profile\.json|market\.json)$/.test(url.pathname)))return new Response('Not found',{status:404});
    // Serve exact file paths; avoid HTML canonicalization redirecting exit.html outside the route allowlist.
    const assetRequest=url.pathname==='/'?new Request(new URL('/index.html',url),request):request;
    const response=await env.ASSETS.fetch(assetRequest),headers=new Headers(response.headers);
    if(headers.get('Content-Type')?.includes('text/html')||url.pathname==='/app.json'||url.pathname.startsWith('/boot.'))headers.set('Cache-Control','no-store, no-transform');
    else if(url.pathname.startsWith('/assets/')&&response.ok)headers.set('Cache-Control','public, max-age=31536000, immutable');
    return new Response(response.body,{status:response.status,headers});
}
