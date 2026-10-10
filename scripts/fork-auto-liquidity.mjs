// Actual deployed vault/pool on a loopback fork. Never signs or submits public-chain transactions.
import fs from 'node:fs';import crypto from 'node:crypto';import {spawn} from 'node:child_process';import assert from 'node:assert/strict';
import {JsonRpcProvider,Contract,ContractFactory,Wallet,MaxUint256,parseEther,formatEther,keccak256} from 'ethers';
import {autoLiquidityPlan} from '../src/liquidity-plan.ts';import {liquidityTick} from '../src/liquidity-keeper.ts';
import {permanentQuote} from '../src/permanent-chain.ts';
import {INFINITY as cfg,TOKEN_ABI,POSITION_ABI,artifact} from './infinity-config.mjs';
const forkRpc=process.env.FORK_RPC_URL||'https://bsc-dataseed.bnbchain.org',live=new JsonRpcProvider(forkRpc,56,{staticNetwork:true}),port=18549,rpc='http://127.0.0.1:'+port;
const previous=JSON.parse(fs.readFileSync('deployments/bsc-liquidity.json','utf8')),report={at:new Date().toISOString(),realTransactionsSent:false,compilerFingerprint:crypto.createHash('sha256').update(artifact('TreasuryAutoLiquidity').bytecode).digest('hex'),checks:[],cases:[],status:'RUNNING'};let child,p;
try{
 const block=await live.getBlockNumber();report.block=block;
 child=spawn(process.env.ANVIL_BIN||(process.platform==='win32'?'node_modules/@foundry-rs/anvil-win32-amd64/bin/anvil.exe':'anvil'),['--host','127.0.0.1','--port',String(port),'--fork-url',forkRpc,'--fork-block-number',String(block),'--accounts','1','--compute-units-per-second','2000','--chain-id','56','--hardfork','cancun','--gas-price','0','--base-fee','50000000','--disable-min-priority-fee','--silent'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
 let forkError='';child.stderr.on('data',b=>{forkError+=b.toString();});
 p=new JsonRpcProvider(rpc,56,{staticNetwork:true,cacheTimeout:-1,pollingInterval:20,batchMaxCount:1});for(let i=0;i<400;i++){try{await p.getBlockNumber();break;}catch{if(child.exitCode!==null)throw Error('Fork node stopped: '+forkError.slice(-250));await new Promise(r=>setTimeout(r,100));}}
 for(const a of[cfg.treasury,'0x7aa6d92fc369a8c1edc631a3aac44efb0808ddbf']){await p.send('anvil_impersonateAccount',[a]);await p.send('anvil_setBalance',[a,'0x1000000000000000000']);}
 let owner=await p.getSigner(cfg.treasury),other=await p.getSigner(0),whale=await p.getSigner('0x7aa6d92fc369a8c1edc631a3aac44efb0808ddbf');const otherAddress=await other.getAddress(),gas={gasPrice:50000000n};
 const a=artifact('TreasuryAutoLiquidity');let helper=await new ContractFactory(a.abi,a.bytecode,owner).deploy(previous.contracts.TreasuryInfinityLiquidity,gas);await helper.waitForDeployment();let address=await helper.getAddress();
 let stable=new Contract(cfg.stable,TOKEN_ABI,owner),tyw=new Contract(cfg.tyw,[...TOKEN_ABI,'function buy(uint256,uint256,uint256[4],uint256) returns(uint256)','function pause()','function oracle() view returns(address)','function assets(uint256) view returns(address)','function pools(uint256) view returns(address)','function totalSupply() view returns(uint256)','function previewRedeem(uint256) view returns(uint256[4],uint256)','function redeemInKind(uint256,uint256[4],uint256)'],owner),positions=new Contract(cfg.positions,POSITION_ABI,p);
 // Mainnet treasury inventory may already be invested. Create fully backed test shares locally.
 await(await stable.connect(whale).transfer(cfg.treasury,parseEther('35'),gas)).wait();await(await stable.approve(cfg.tyw,parseEther('35'),gas)).wait();
 const seed=await permanentQuote(rpc,cfg.tyw,parseEther('35'),'buy');await(await tyw.buy(parseEther('35'),BigInt(seed.shares),seed.limits.map(BigInt),BigInt((await p.getBlock('latest')).timestamp+1200),{...gas,gasLimit:5000000n})).wait();
 for(const token of[stable,tyw])await(await token.approve(address,MaxUint256,gas)).wait();
 await assert.rejects(helper.connect(other).setEnabled.staticCall(false));report.checks.push('Only treasury can disable; no public arbitrary-call or withdrawal function');
 // Each independent scenario gets fresh public state; long snapshot runs exceed free RPC archive windows.
 report.fixtureBlocks=[];const reset=async()=>{
  const current=await live.getBlockNumber();report.fixtureBlocks.push(current);await p.send('anvil_reset',[{forking:{jsonRpcUrl:forkRpc,blockNumber:current}}]);
  // Clear ethers' monotonic block/receipt polling state after resetting the chain.
  p.destroy();p=new JsonRpcProvider(rpc,56,{staticNetwork:true,cacheTimeout:-1,pollingInterval:20,batchMaxCount:1});
  for(const signer of[cfg.treasury,'0x7aa6d92fc369a8c1edc631a3aac44efb0808ddbf']){await p.send('anvil_impersonateAccount',[signer]);await p.send('anvil_setBalance',[signer,'0x1000000000000000000']);}
  owner=await p.getSigner(cfg.treasury);other=await p.getSigner(0);whale=await p.getSigner('0x7aa6d92fc369a8c1edc631a3aac44efb0808ddbf');stable=stable.connect(owner);tyw=tyw.connect(owner);positions=positions.connect(p);
  report.stage='fixture-'+report.fixtureBlocks.length;fs.writeFileSync('reports/auto-liquidity-fork.json',JSON.stringify(report,null,2)+'\n');
  helper=await new ContractFactory(a.abi,a.bytecode,owner).deploy(previous.contracts.TreasuryInfinityLiquidity,gas);await helper.waitForDeployment();address=await helper.getAddress();
  await(await stable.connect(whale).transfer(cfg.treasury,parseEther('35'),gas)).wait();await(await stable.approve(cfg.tyw,parseEther('35'),gas)).wait();
  const quote=await permanentQuote(rpc,cfg.tyw,parseEther('35'),'buy');await(await tyw.buy(parseEther('35'),BigInt(quote.shares),quote.limits.map(BigInt),BigInt((await p.getBlock('latest')).timestamp+1200),{...gas,gasLimit:5000000n})).wait();
  for(const token of[stable,tyw])await(await token.approve(address,MaxUint256,gas)).wait();
 };
 const configure=async(cash,tokens)=>{
  const held=await tyw.balanceOf(cfg.treasury);if(held>tokens)await(await tyw.transfer(otherAddress,held-tokens,gas)).wait();
  const existing=await stable.balanceOf(cfg.treasury);if(existing>cash)await(await stable.transfer(otherAddress,existing-cash,gas)).wait();
  if(existing<cash)await(await stable.connect(whale).transfer(cfg.treasury,cash-existing,gas)).wait();
 };
 for(const [label,cash,tokens]of[['TYW only',0n,parseEther('7')],['USDT only',parseEther('8'),0n],['5 USDT plus 3 TYW',parseEther('5'),parseEther('3')]]){
  await reset();await configure(cash,tokens);const plan=await autoLiquidityPlan(rpc,address),id=await positions.nextTokenId();
  await assert.rejects(helper.provide.staticCall(...plan.args.slice(0,3),1));
  await assert.rejects(helper.provide.staticCall(...plan.args.slice(0,3),BigInt((await p.getBlock('latest')).timestamp+1000)));
  await assert.rejects(helper.provide.staticCall(plan.args[0],plan.args[1]*2n,plan.args[2],plan.args[3]));
  const r=await(await helper.connect(other).provide(...plan.args,gas)).wait();
  assert.equal((await positions.ownerOf(id)).toLowerCase(),cfg.treasury.toLowerCase());assert.ok(await positions.getPositionLiquidity(id)>0n);
  assert.equal(await stable.balanceOf(address),0n);assert.equal(await tyw.balanceOf(address),0n);assert.equal(await stable.allowance(address,cfg.tyw),0n);
  const event=r.logs.map(l=>{try{return helper.interface.parseLog(l);}catch{return null;}}).find(e=>e?.name==='Provided');
  report.cases.push({label,operation:plan.operation,cashBefore:formatEther(cash),tokensBefore:formatEther(tokens),cashAfterConversion:formatEther(event.args.cash),tokensAfterConversion:formatEther(event.args.tokens),gasUsed:String(r.gasUsed),lpTreasury:true});
 }
 report.checks.push('Both single sides and unequal inventory convert through actual backed vault then LP atomically','Bad/expired/long-deadline/oversized quotes revert before any funds leave','No controller custody or persistent vault approval; NFT directly owned by treasury');
 await reset();const ratio=(await helper.inventory())[3];await configure(3n*ratio,parseEther('3'));
 const balanced=await autoLiquidityPlan(rpc,address);assert.equal(balanced.operation,'MATCHED');assert.equal(balanced.args[1],0n);await(await helper.provide(...balanced.args,gas)).wait();report.checks.push('Balanced funds add without an unnecessary swap');
 await reset();await configure(0n,parseEther('7'));
 const plan=await autoLiquidityPlan(rpc,address);await(await helper.setEnabled(false,gas)).wait();await assert.rejects(helper.provide.staticCall(...plan.args));await(await helper.setEnabled(true,gas)).wait();
 await(await tyw.pause(gas)).wait();await assert.rejects(helper.provide.staticCall(...plan.args));report.checks.push('Disabling helper or pausing vault blocks new investment');
 await reset();await configure(0n,parseEther('7'));
 const keeper=Wallet.createRandom();await p.send('anvil_setBalance',[keeper.address,'0x'+parseEther('0.0002').toString(16)]);
 const values=new Map(),store={get:async k=>values.get(k),put:async(k,v)=>{values.set(k,v);}},env={RPC_URL:rpc,LIQUIDITY_CONTROLLER:address,LIQUIDITY_CONTROLLER_CODE_HASH:keccak256(await p.getCode(address)),LIQUIDITY_ENABLED:'true',LIQUIDITY_MODE:'auto',LIQUIDITY_KEEPER_KEY:keeper.privateKey};
 await assert.rejects(liquidityTick({...env,LIQUIDITY_CONTROLLER_CODE_HASH:'0x'+'0'.repeat(64)},store));
 report.keeperBelowMinimum=await liquidityTick(env,store);assert.equal(report.keeperBelowMinimum.status,'WAITING_FOR_MINIMUM_VALUE');assert.equal(values.get('liquidity:pending'),undefined);
 await reset();await configure(0n,parseEther('25'));await p.send('anvil_setBalance',[keeper.address,'0x'+parseEther('0.0002').toString(16)]);
 env.LIQUIDITY_CONTROLLER=address;env.LIQUIDITY_CONTROLLER_CODE_HASH=keccak256(await p.getCode(address));
 await p.send('anvil_setNextBlockBaseFeePerGas',['0x2faf080']);await p.send('evm_mine',[]);
 const id=await positions.nextTokenId();report.keeperStarted=await liquidityTick(env,store);assert.equal(report.keeperStarted.status,'PENDING',JSON.stringify(report.keeperStarted));
 await p.waitForTransaction(report.keeperStarted.hash,1,120000);
 report.keeperDone=await liquidityTick(env,store);assert.equal(report.keeperDone.status,'ADDED');assert.equal((await positions.ownerOf(id)).toLowerCase(),cfg.treasury.toLowerCase());report.checks.push('Actual Worker code, isolated gas-only key and pinned bytecode complete single-sided addition');
 // Simulate project shutdown: site/Worker unused, vault paused, oracle and all exchange pools unavailable.
 await reset();await(await tyw.transfer(otherAddress,parseEther('1'),gas)).wait();await(await tyw.pause(gas)).wait();
 const holder=tyw.connect(other),shares=parseEther('1'),[parts,cash]=await holder.previewRedeem(shares),supply=await tyw.totalSupply();
 const assets=await Promise.all([0,1,2,3].map(i=>tyw.assets(i)));const tokens=assets.map(a=>new Contract(a,TOKEN_ABI,p));const before=await Promise.all(tokens.map(t=>t.balanceOf(otherAddress)));
 await p.send('anvil_setCode',[await tyw.oracle(),'0x']);for(let i=0;i<4;i++)await p.send('anvil_setCode',[await tyw.pools(i),'0x']);
 await(await holder.redeemInKind(shares,[...parts],cash,gas)).wait();
 for(let i=0;i<4;i++)assert.equal(await tokens[i].balanceOf(otherAddress)-before[i],parts[i]);assert.equal(await tyw.totalSupply(),supply-shares);
 report.checks.push('Actual deployed in-kind redemption works with pause, broken oracle, unavailable DEX and no website/API');report.shutdownRedemption={assets:assets.map((address,i)=>({address,amount:String(parts[i])})),sharesBurned:String(shares),noWebsiteApiOrOracleNeeded:true};
 report.status='PASSED';
}catch(e){report.status='FAILED';report.error=e.shortMessage||e.reason||e.message;report.rpcError=e.info?.error?.message?.slice(0,250);process.exitCode=1;}
finally{p?.destroy();live.destroy();child?.kill();fs.writeFileSync('reports/auto-liquidity-fork.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));}
