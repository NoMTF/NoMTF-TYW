import {DurableObject}from'cloudflare:workers';
import {isAddress,decodeEventLog}from'viem';
import {ASSETS,STABLES}from'./assets.ts';
import {chainClient,VAULT_ABI,TOKEN_ABI}from'./chain.ts';
import {basketQuote}from'./quotes.ts';
import {decimalRaw,breached,portfolioValues,targetTrades,formatRaw}from'./portfolio.ts';
import {makeBatchProposal}from'./planner.ts';
import {makeRebalanceProposal}from'./rebalance.ts';
type Env={RPC_URL:string;VAULT_ADDRESS:string;CHAIN_ID:string;EXECUTION_MODE:string;COST_TARGET_BPS:string;ASSETS:Fetcher;COORDINATOR:DurableObjectNamespace<PortfolioCoordinator>};
type PriceReport={p0:string;p1:string;p2:string;validUntil:number;nonce:string;signature:`0x${string}`};
type Order={id:string;user:string;redeem:boolean;amount:string;minimum:string;deadline:number;status:string;requestTx:string;updatedAt:number;payoutUsdc?:boolean;reason?:string};
function json(data:unknown,status=200){return Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}
const validVault=(env:Env)=>isAddress(env.VAULT_ADDRESS)&&!/^0x0{40}$/i.test(env.VAULT_ADDRESS);
const priceTuple=(r:PriceReport)=>({p0:BigInt(r.p0),p1:BigInt(r.p1),p2:BigInt(r.p2),validUntil:BigInt(r.validUntil),nonce:BigInt(r.nonce)});
export class PortfolioCoordinator extends DurableObject<Env>{
  async state(){
    const timestamp=Date.now();
    const base={timestamp,chainId:56,name:'NoMTF',symbol:'TYW',assets:ASSETS,stables:STABLES,platformFeeBps:0,costTargetBps:100,executionMode:this.env.EXECUTION_MODE,checkInterval:'每小时，仅触线后创建调仓任务',vault:this.env.VAULT_ADDRESS||null};
    if(!validVault(this.env))return{...base,status:'NOT_DEPLOYED',paused:true,initialized:false,supply:'0',valuation:null,balances:['0','0','0'],blockers:['尚未配置链上金库']};
    const client=chainClient(this.env.RPC_URL),address=this.env.VAULT_ADDRESS as `0x${string}`;
    const [initialized,paused,supply,pendingStable,adapter,rebalanceCost,rebalanceGas,balances]=await Promise.all([
      client.readContract({address,abi:VAULT_ABI,functionName:'initialized'}),client.readContract({address,abi:VAULT_ABI,functionName:'paused'}),client.readContract({address,abi:VAULT_ABI,functionName:'totalSupply'}),
      client.readContract({address,abi:VAULT_ABI,functionName:'pendingStable'}),client.readContract({address,abi:VAULT_ABI,functionName:'adapter'}),
      client.readContract({address,abi:VAULT_ABI,functionName:'cumulativeRebalanceCostUsd'}),client.readContract({address,abi:VAULT_ABI,functionName:'cumulativeRebalanceGasUsd'}),
      Promise.all(ASSETS.map(a=>client.readContract({address:a.address,abi:TOKEN_ABI,functionName:'balanceOf',args:[address]}))),
    ]);
    const r=await this.ctx.storage.get<PriceReport>('prices');let valuation:any=null;
    if(r&&r.validUntil>=Math.floor(Date.now()/1000)){
      try{const nav=await client.readContract({address,abi:VAULT_ABI,functionName:'netAssetValue',args:[priceTuple(r),r.signature]});valuation={totalUsd:formatRaw(nav[0]),perShareUsd:formatRaw(nav[1]),weightsBps:nav[2].map(Number),validUntil:r.validUntil};}catch{/* No stale or unverified price is promoted to an executable NAV. */}
    }
    const blockers:string[]=[];
    if(!initialized)blockers.push('金库尚未取得三资产种子储备，未发行流通份额');
    if(paused)blockers.push('申购与稳定币赎回当前暂停');
    if(!valuation&&initialized)blockers.push('没有有效、已核验的净值报告');
    return{...base,status:initialized&&!paused&&valuation?'LIVE':'PRELAUNCH',paused,initialized,supply:formatRaw(supply),pendingStable:formatRaw(pendingStable),adapter,balances:balances.map(String),rebalanceCostUsd:formatRaw(rebalanceCost),rebalanceGasUsd:formatRaw(rebalanceGas),valuation,blockers,lastCheck:await this.ctx.storage.get('lastCheck'),task:await this.ctx.storage.get('task')};
  }
  async check(){
    const state=await this.state(),at=Date.now();
    const r=await this.ctx.storage.get<PriceReport>('prices');
    if(!state.initialized||state.paused||!state.valuation||!r){await this.ctx.storage.put('lastCheck',{at,result:'NO_TRADE',reason:state.blockers.join('；')});return;}
    const prices=[r.p0,r.p1,r.p2].map(p=>({usdPerToken:BigInt(p),observedAt:Math.floor(at/1000),trusted:true}));
    const values=portfolioValues(state.balances!.map(BigInt),prices,Math.floor(at/1000));
    if(!breached(values)){await this.ctx.storage.put('lastCheck',{at,result:'IN_BAND'});return;}
    const client=chainClient(this.env.RPC_URL);
    const nonce=await client.readContract({address:this.env.VAULT_ADDRESS as `0x${string}`,abi:VAULT_ABI,functionName:'rebalanceNonce'});
    const existing=await this.ctx.storage.get<any>('task');
    if(existing&&existing.status==='READY_TO_SIGN'&&existing.nonce===String(nonce)&&existing.validUntil>at/1000+20){await this.ctx.storage.put('lastCheck',{at,result:'TASK_EXISTS',taskId:existing.id});return;}
    let proposal:any;try{proposal=await makeRebalanceProposal(this.env.RPC_URL,this.env.VAULT_ADDRESS as `0x${string}`,r);}catch(e){proposal={status:'WAITING_QUOTE',reason:e instanceof Error?e.message:'等待可成交报价'};}
    const task={id:`56:${this.env.VAULT_ADDRESS}:${nonce}`,nonce:nonce.toString(),createdAt:at,weights:state.valuation.weightsBps,trades:targetTrades(values,prices.map(p=>p.usdPerToken)).map(t=>({...t,amountRaw:t.amountRaw.toString(),deltaUsd:t.deltaUsd.toString()})),...proposal};
    await this.ctx.storage.put('task',task);await this.ctx.storage.put('lastCheck',{at,result:'TRIGGERED',taskId:task.id});
  }
  async fetch(request:Request):Promise<Response>{
    const url=new URL(request.url);const path=url.pathname;
    try{
      if(request.method==='GET'&&path==='/api/state')return json(await this.state());
      if(request.method==='GET'&&path==='/api/quotes'){
        const raw=decimalRaw(url.searchParams.get('amount')||'1',18);if(raw<=0n||raw>1000n*10n**18n)return json({error:'金额需介于0和1000美元之间'},422);
        const key='latestQuote';const cached=await this.ctx.storage.get<{at:number;amount:string;body:any}>(key);
        if(cached&&cached.amount===String(raw)&&Date.now()-cached.at<15000)return json(cached.body);
        const throttle=await this.ctx.storage.get<number>('quoteAt');
        if(throttle&&Date.now()-throttle<3000)return json({error:'报价请求较频繁，请稍后重试'},429);
        await this.ctx.storage.put('quoteAt',Date.now());
        const body=await basketQuote(raw,this.env.RPC_URL);await this.ctx.storage.put(key,{at:Date.now(),amount:String(raw),body});return json(body);
      }
      if(request.method==='POST'&&path==='/api/check'){await this.check();return json({ok:true});}
      if(request.method==='GET'&&path==='/api/proposals')return json({proposals:await this.ctx.storage.get('proposals')||[],task:await this.ctx.storage.get('task')||null});
      if(request.method==='POST'&&path==='/api/prices'){
        if(!validVault(this.env))return json({error:'金库尚未部署'},409);
        const r=await request.json() as PriceReport;
        if(!/^0x[0-9a-f]{130}$/i.test(r.signature)||![r.p0,r.p1,r.p2,r.nonce].every(v=>typeof v==='string'&&/^\d{1,78}$/.test(v))||!Number.isSafeInteger(r.validUntil))return json({error:'报告格式无效'},422);
        const client=chainClient(this.env.RPC_URL);
        await client.readContract({address:this.env.VAULT_ADDRESS as `0x${string}`,abi:VAULT_ABI,functionName:'netAssetValue',args:[priceTuple(r),r.signature]});
        await this.ctx.storage.put('prices',r);return json({ok:true,validUntil:r.validUntil});
      }
      if(request.method==='POST'&&path==='/api/orders'){
        if(!validVault(this.env))return json({error:'尚未开放链上订单'},409);
        const {txHash}=await request.json() as {txHash:string};if(!/^0x[0-9a-f]{64}$/i.test(txHash))return json({error:'无效交易哈希'},422);
        const client=chainClient(this.env.RPC_URL);const receipt=await client.getTransactionReceipt({hash:txHash as `0x${string}`});
        if(receipt.status!=='success')return json({error:'链上交易没有成功'},422);
        const final=await client.getBlock({blockTag:'finalized'});if(final.number<receipt.blockNumber)return json({status:'SUBMITTED',message:'等待链上最终确认'},202);
        const orders:Order[]=[];
        for(const log of receipt.logs){
          if(log.address.toLowerCase()!==this.env.VAULT_ADDRESS.toLowerCase())continue;
          try{const event=decodeEventLog({abi:VAULT_ABI,data:log.data,topics:log.topics});if(event.eventName!=='Requested')continue;
            const a=event.args;const order:Order={id:a.id.toString(),user:a.user,redeem:a.redeem,amount:a.amount.toString(),minimum:a.minimum.toString(),deadline:Number(a.deadline),status:'QUEUED',requestTx:txHash,updatedAt:Date.now()};
            order.payoutUsdc=a.redeem?await client.readContract({address:this.env.VAULT_ADDRESS as `0x${string}`,abi:VAULT_ABI,functionName:'paysUsdc',args:[a.id]}):false;
            if(!await this.ctx.storage.get(`order:${order.id}`)){await this.ctx.storage.put(`order:${order.id}`,order);await this.ctx.storage.put(`wallet:${a.user.toLowerCase()}:${order.id.padStart(20,'0')}`,order.id);await this.ctx.storage.put(`active:${order.id.padStart(20,'0')}`,order.id);}orders.push(order);
          }catch{/* Ignore unrelated logs. */}
        }
        if(!orders.length)return json({error:'交易没有本项目的真实订单事件'},422);
        await this.ctx.storage.setAlarm(Date.now()+60000);return json({orders});
      }
      if(request.method==='GET'&&path==='/api/orders'){
        const address=url.searchParams.get('address');if(!address||!isAddress(address))return json({error:'有效钱包地址不能为空'},422);
        const index=await this.ctx.storage.list<string>({prefix:`wallet:${address.toLowerCase()}:`,limit:100,reverse:true});
        const mine=(await Promise.all([...index.values()].map(id=>this.ctx.storage.get<Order>(`order:${id}`)))).filter((o):o is Order=>!!o);
        const client=chainClient(this.env.RPC_URL);
        const results=await Promise.all(mine.map(async o=>{
          const r=await client.readContract({address:this.env.VAULT_ADDRESS as `0x${string}`,abi:VAULT_ABI,functionName:'requests',args:[BigInt(o.id)],blockTag:'finalized'});
          o.status=r[5]===2?'CONFIRMED':r[5]===3?'CANCELLED':o.deadline<Math.floor(Date.now()/1000)?'EXPIRED':o.status==='READY'?'READY':'WAITING_QUOTE';o.updatedAt=Date.now();return o;
        }));return json({orders:results});
      }
      return json({error:'接口不存在'},404);
    }catch(e){console.error('request_failed',path,e instanceof Error?e.name:'error');return json({error:'链上或报价服务暂时不可用，请稍后重试'},503);}
  }
  async alarm(){
    const index=await this.ctx.storage.list<string>({prefix:'active:',limit:128});
    const orders=(await Promise.all([...index.values()].map(id=>this.ctx.storage.get<Order>(`order:${id}`)))).filter((o):o is Order=>!!o);
    const client=chainClient(this.env.RPC_URL);const open:Order[]=[];
    for(const o of orders){
      const r=await client.readContract({address:this.env.VAULT_ADDRESS as `0x${string}`,abi:VAULT_ABI,functionName:'requests',args:[BigInt(o.id)],blockTag:'finalized'});
      if(r[5]===2||r[5]===3){o.status=r[5]===2?'CONFIRMED':'CANCELLED';await this.ctx.storage.put(`order:${o.id}`,o);await this.ctx.storage.delete(`active:${o.id.padStart(20,'0')}`);continue;}
      if(o.deadline<=Date.now()/1000){o.status='EXPIRED';await this.ctx.storage.put(`order:${o.id}`,o);await this.ctx.storage.delete(`active:${o.id.padStart(20,'0')}`);continue;}open.push(o);
    }
    const report=await this.ctx.storage.get<PriceReport>('prices'),proposals=[];
    for(const kind of ['deposit','redeemUSDT','redeemUSDC']){
      const batch=open.filter(o=>kind==='deposit'?!o.redeem:o.redeem&&Boolean(o.payoutUsdc)===(kind==='redeemUSDC')).slice(0,64);
      if(!batch.length)continue;
      try{if(!report)throw new Error('等待有效净值报告');const proposal=await makeBatchProposal(this.env.RPC_URL,this.env.VAULT_ADDRESS as `0x${string}`,batch,report);proposals.push(proposal);for(const o of batch){o.status='READY';o.reason='已通过模拟与成本检查，等待钱包签名执行';}}
      catch(e){for(const o of batch){o.status='WAITING_QUOTE';o.reason=e instanceof Error?e.message.slice(0,180):'等待报价与库存核验';}}
      for(const o of batch)await this.ctx.storage.put(`order:${o.id}`,o);
    }
    await this.ctx.storage.put('proposals',proposals);if(open.length||index.size===128)await this.ctx.storage.setAlarm(Date.now()+60000);
  }
}
export default{
 async fetch(request:Request,env:Env):Promise<Response>{
   const url=new URL(request.url);
   if(url.pathname==='/api/health')return json({ok:true});
   if(url.pathname.startsWith('/api/')){
     if(request.method==='POST'){
       const origin=request.headers.get('Origin');if(origin&&origin!==url.origin)return json({error:'拒绝跨站操作'},403);
       if(Number(request.headers.get('Content-Length')||0)>16384)return json({error:'请求过大'},413);
       const reader=request.body?.getReader();if(reader){const chunks:Uint8Array[]=[];let size=0;while(true){const c=await reader.read();if(c.done)break;size+=c.value.byteLength;if(size>16384){await reader.cancel();return json({error:'请求过大'},413);}chunks.push(c.value);}const data=new Uint8Array(size);let at=0;for(const c of chunks){data.set(c,at);at+=c.length;}request=new Request(request.url,{method:request.method,headers:request.headers,body:data});}
     }
     return env.COORDINATOR.getByName('portfolio-56').fetch(request);
   }
   const r=await env.ASSETS.fetch(request);const headers=new Headers(r.headers);
   headers.set('X-Content-Type-Options','nosniff');headers.set('Referrer-Policy','strict-origin-when-cross-origin');
   headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' https://bsc-dataseed.bnbchain.org; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
   return new Response(r.body,{status:r.status,headers});
 },
 async scheduled(_controller:ScheduledController,env:Env,ctx:ExecutionContext){ctx.waitUntil(env.COORDINATOR.getByName('portfolio-56').fetch('https://internal/api/check',{method:'POST'}));},
};
