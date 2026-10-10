// Real positions and fee accounting on a local fork; no public-chain transaction is sent.
import fs from 'node:fs';import crypto from 'node:crypto';import {spawn} from 'node:child_process';import assert from 'node:assert/strict';
import {JsonRpcProvider,Contract,ContractFactory,keccak256,formatEther,parseEther,AbiCoder,MaxUint256,Wallet} from 'ethers';
import {INFINITY as cfg,TOKEN_ABI,POSITION_ABI,KEY,QUOTER_ABI,PERMIT_ABI,artifact} from './infinity-config.mjs';
import {liquidityTick} from '../src/liquidity-keeper.ts';
const upstream=process.env.FORK_RPC_URL||'https://bsc-dataseed.bnbchain.org',live=new JsonRpcProvider(upstream,56,{staticNetwork:true,batchMaxCount:1}),port=18554,rpc='http://127.0.0.1:'+port;
const a=artifact('TreasuryFeeCollector'),report={at:new Date().toISOString(),realTransactionsSent:false,compilerFingerprint:crypto.createHash('sha256').update(a.bytecode).digest('hex'),checks:[],status:'RUNNING'};let child,p;
try{
 const block=await live.getBlockNumber();report.blockNumber=block;
 child=spawn(process.env.ANVIL_BIN||(process.platform==='win32'?'node_modules/@foundry-rs/anvil-win32-amd64/bin/anvil.exe':'anvil'),['--host','127.0.0.1','--port',String(port),'--fork-url',upstream,'--fork-block-number',String(block),'--chain-id','56','--hardfork','cancun','--gas-price','50000000','--base-fee','0','--disable-min-priority-fee','--silent'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
 let diagnostics='';child.stderr.on('data',b=>diagnostics+=b.toString());
 p=new JsonRpcProvider(rpc,56,{staticNetwork:true,cacheTimeout:-1,pollingInterval:20,batchMaxCount:1});
 for(let i=0;i<300;i++){try{await p.getBlockNumber();break;}catch{if(child.exitCode!==null)throw Error('Fork stopped: '+diagnostics.slice(-200));await new Promise(r=>setTimeout(r,100));}}
 await p.send('anvil_impersonateAccount',[cfg.treasury]);await p.send('anvil_setBalance',[cfg.treasury,'0x1000000000000000000']);
 const owner=await p.getSigner(cfg.treasury),outsider=await p.getSigner(0),gas={gasPrice:50000000n,gasLimit:3000000};
 const collector=await new ContractFactory(a.abi,a.bytecode,owner).deploy(cfg.treasury,cfg.positions,cfg.stable,cfg.tyw,cfg.manager,gas);await collector.waitForDeployment();const address=await collector.getAddress();
 const positions=new Contract(cfg.positions,[...POSITION_ABI,`function getPoolAndPositionInfo(uint256) view returns(${KEY},uint256)`,'function setApprovalForAll(address,bool)','function isApprovedForAll(address,address) view returns(bool)'],owner);
 const stable=new Contract(cfg.stable,TOKEN_ABI,p),tyw=new Contract(cfg.tyw,TOKEN_ABI,p),ids=[1571663n,1571939n];
 const snapshot=async()=>Promise.all(ids.map(async id=>({id:String(id),owner:await positions.ownerOf(id),liquidity:String(await positions.getPositionLiquidity(id)),info:JSON.stringify(await positions.getPoolAndPositionInfo(id),(_,v)=>typeof v==='bigint'?String(v):v)})));
 const before=await snapshot(),cash=await stable.balanceOf(cfg.treasury),tokens=await tyw.balanceOf(cfg.treasury);
 await assert.rejects(collector.connect(outsider).collect.staticCall(ids));report.checks.push('No collection without explicit treasury NFT approval');
 await(await positions.setApprovalForAll(address,true,gas)).wait();
 for(const bad of[[],[ids[0],ids[0]],[ids[1],ids[0]],Array.from({length:33},(_,i)=>BigInt(i+1)),[999999999n]])await assert.rejects(collector.connect(outsider).collect.staticCall(bad));
 const quoted=await collector.connect(outsider).collect.staticCall(ids),receipt=await(await collector.connect(outsider).collect(ids,gas)).wait();
 assert.deepEqual(await snapshot(),before);assert.equal(await stable.balanceOf(cfg.treasury)-cash,quoted[0]);assert.equal(await tyw.balanceOf(cfg.treasury)-tokens,quoted[1]);
 assert.equal(await stable.balanceOf(address),0n);assert.equal(await tyw.balanceOf(address),0n);
 assert.deepEqual(a.abi.filter(x=>x.type==='function'&&x.stateMutability!=='view').map(x=>x.name),['collect']);
 const event=receipt.logs.map(l=>{try{return collector.interface.parseLog(l);}catch{return null;}}).find(e=>e?.name==='Collected');assert.equal(event.args.usdt,quoted[0]);assert.equal(event.args.tyw,quoted[1]);
 const second=await collector.collect.staticCall(ids);assert.deepEqual([...second],[0n,0n]);
 report.fees={usdt:formatEther(quoted[0]),tyw:formatEther(quoted[1]),gasUsed:String(receipt.gasUsed)};report.positionsUnchanged=before;report.runtimeCodeHash=keccak256(await p.getCode(address));
 report.checks.push('Only sorted unique batches of 1–32 treasury-owned positions for the fixed pair are accepted','Zero liquidity delta collects accrued fees to the fixed original treasury','LP liquidity, pool metadata and NFT ownership remain unchanged','No arbitrary recipient, NFT transfer, principal withdrawal, token custody, or upgrade entry point','A second collection returns zero');
 report.stage='worker-wait';
 const auto=JSON.parse(fs.readFileSync('deployments/bsc-auto-liquidity.json','utf8')),helper=auto.contracts.TreasuryAutoLiquidity;
 const keeper=Wallet.createRandom();await p.send('anvil_setBalance',[keeper.address,'0x'+parseEther('0.0002').toString(16)]);
 const values=new Map(),storage={get:async k=>values.get(k),put:async(k,v)=>values.set(k,v)},env={RPC_URL:rpc,LIQUIDITY_CONTROLLER:helper,LIQUIDITY_CONTROLLER_CODE_HASH:keccak256(await p.getCode(helper)),LIQUIDITY_ENABLED:'true',LIQUIDITY_MODE:'auto',LIQUIDITY_KEEPER_KEY:keeper.privateKey,LIQUIDITY_FEE_COLLECTOR:address,LIQUIDITY_FEE_COLLECTOR_CODE_HASH:report.runtimeCodeHash,LIQUIDITY_POSITION_IDS:ids.join(',')};
 report.waiting=await liquidityTick(env,storage);assert.ok(['WAITING_FOR_MINIMUM_VALUE','WAITING_FOR_INVENTORY_PRICE_OR_QUOTES'].includes(report.waiting.status));assert.equal(values.get('liquidity:pending'),undefined);
 report.stage='synthetic-fees';
 const whale='0x7aa6d92fc369a8c1edc631a3aac44efb0808ddbf';await p.send('anvil_impersonateAccount',[whale]);await p.send('anvil_setBalance',[whale,'0x1000000000000000000']);
 const funded=new Contract(cfg.stable,TOKEN_ABI,await p.getSigner(whale));await(await funded.transfer(await outsider.getAddress(),parseEther('40'),gas)).wait();
 const stableTrader=stable.connect(outsider),tywTrader=tyw.connect(outsider),permitAddress=await positions.permit2(),permit=new Contract(permitAddress,PERMIT_ABI,outsider),router=new Contract(cfg.router,['function execute(bytes,bytes[],uint256) payable'],outsider),quoter=new Contract(cfg.quoter,QUOTER_ABI,p),coder=AbiCoder.defaultAbiCoder();
 const key=[...(await positions.getPoolAndPositionInfo(ids[0]))[0]];
 for(const token of[stableTrader,tywTrader]){await(await token.approve(permitAddress,MaxUint256,gas)).wait();await(await permit.approve(await token.getAddress(),cfg.router,(1n<<160n)-1n,(await p.getBlock('latest')).timestamp+3600,gas)).wait();}
 const swap=async(buy,amount)=>{const token=buy?stableTrader:tywTrader,out=buy?tywTrader:stableTrader,[quote]=await quoter.quoteExactInputSingle.staticCall({poolKey:key,zeroForOne:buy,exactAmount:amount,hookData:'0x'}),minimum=quote*995n/1000n;
  const args=[coder.encode([`(${KEY} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)`],[[key,buy,amount,minimum,'0x']]),coder.encode(['address','uint256'],[await token.getAddress(),amount]),coder.encode(['address','uint256'],[await out.getAddress(),minimum])];
  const before=await out.balanceOf(await outsider.getAddress());await(await router.execute('0x10',[coder.encode(['bytes','bytes[]'],['0x060c0f',args])],(await p.getBlock('latest')).timestamp+120,gas)).wait();return await out.balanceOf(await outsider.getAddress())-before;};
 // Real local swaps accrue protocol-accounted fees; no fee accounting storage is forged.
 for(let i=0;i<6;i++)await swap(false,await swap(true,parseEther('5')));
 await(await funded.transfer(cfg.treasury,parseEther('20'),gas)).wait();
 await p.send('anvil_setNextBlockBaseFeePerGas',['0x2faf080']);await p.send('evm_mine',[]);
 report.stage='worker-collect';const principal=await snapshot();report.collectionStarted=await liquidityTick(env,storage);assert.equal(report.collectionStarted.operation,'COLLECT_FEES');assert.equal(report.collectionStarted.status,'PENDING',JSON.stringify(report.collectionStarted));
 await p.waitForTransaction(report.collectionStarted.hash,1,60000);report.collectionDone=await liquidityTick(env,storage);assert.equal(report.collectionDone.status,'FEES_COLLECTED');assert.deepEqual(await snapshot(),principal);
 report.stage='worker-reinvest';const id=await positions.nextTokenId();report.additionStarted=await liquidityTick(env,storage);assert.equal(report.additionStarted.status,'PENDING',JSON.stringify(report.additionStarted));
 await p.waitForTransaction(report.additionStarted.hash,1,60000);report.additionDone=await liquidityTick(env,storage);assert.equal(report.additionDone.status,'ADDED');assert.equal((await positions.ownerOf(id)).toLowerCase(),cfg.treasury.toLowerCase());assert.deepEqual(values.get('liquidity:positions'),[String(id)]);
 await(await positions.setApprovalForAll(address,false,gas)).wait();await assert.rejects(collector.collect.staticCall(ids));
 report.checks.push('Production Worker waits for economic minimum without signing','Synthetic local router swaps accrue real fees; Worker collects with bounded gas and unchanged principal','Next Worker round splits and reinvests idle inventory plus collected fees; new NFT belongs to treasury and is tracked','Treasury can revoke collector approval');report.status='PASSED';
}catch(e){report.status='FAILED';report.error=e.shortMessage||e.reason||e.message;report.rpcError=e.info?.error?.message?.slice(0,350);process.exitCode=1;}
finally{p?.destroy();live.destroy();child?.kill();fs.writeFileSync('reports/fee-collector-fork.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));}
