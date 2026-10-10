// Renounce only on a loopback BSC fork, then exercise the actual deployed contracts.
import fs from 'node:fs';import {spawn} from 'node:child_process';import assert from 'node:assert/strict';
import {JsonRpcProvider,Contract,ZeroAddress,parseEther,MaxUint256,keccak256,AbiCoder,formatEther} from 'ethers';
import {permanentQuote} from '../src/permanent-chain.ts';
import {permanentRebalanceProposal} from '../src/permanent-rebalance.ts';
import {autoLiquidityPlan} from '../src/liquidity-plan.ts';
import {INFINITY as cfg,TOKEN_ABI,POSITION_ABI,KEY,QUOTER_ABI,PERMIT_ABI,artifact} from './infinity-config.mjs';
const upstream='https://bsc-dataseed.bnbchain.org',live=new JsonRpcProvider(upstream,56,{staticNetwork:true,batchMaxCount:1});
const port=18557,rpc='http://127.0.0.1:'+port,report={at:new Date().toISOString(),realTransactionsSent:false,vault:cfg.tyw,chainId:56,status:'RUNNING',checks:[]};let child,p;
const save=()=>fs.writeFileSync('reports/renounce-fork.json',JSON.stringify(report,null,2)+'\n');
const stage=value=>{report.stage=value;save();console.log(value);};
try{
 const block=await live.getBlockNumber();report.block=block;
 child=spawn(process.platform==='win32'?'node_modules/@foundry-rs/anvil-win32-amd64/bin/anvil.exe':'anvil',['--host','127.0.0.1','--port',String(port),'--fork-url',upstream,'--fork-block-number',String(block),'--chain-id','56','--hardfork','cancun','--compute-units-per-second','2000','--gas-price','50000000','--base-fee','0','--disable-min-priority-fee','--silent'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
 let diagnostics='';child.stderr.on('data',b=>diagnostics+=b.toString());p=new JsonRpcProvider(rpc,56,{staticNetwork:true,batchMaxCount:1,cacheTimeout:-1,pollingInterval:40});
 for(let i=0;i<300;i++){try{await p.getBlockNumber();break;}catch{if(child.exitCode!==null)throw Error(diagnostics.slice(-200));await new Promise(r=>setTimeout(r,100));}}
 const whaleAddress='0x7aa6d92fc369a8c1edc631a3aac44efb0808ddbf';for(const address of[cfg.treasury,whaleAddress]){await p.send('anvil_impersonateAccount',[address]);await p.send('anvil_setBalance',[address,'0x1000000000000000000']);}
 const owner=await p.getSigner(cfg.treasury),other=await p.getSigner(0),otherAddress=await other.getAddress(),whale=await p.getSigner(whaleAddress),gas={gasPrice:50000000n,gasLimit:5000000n};
 const vault=new Contract(cfg.tyw,artifact('PermanentVault').abi,owner),stable=new Contract(cfg.stable,TOKEN_ABI,owner),positions=new Contract(cfg.positions,[...POSITION_ABI,`function getPoolAndPositionInfo(uint256) view returns(${KEY},uint256)`],p);
 const initialOwner=await vault.owner();assert.ok(initialOwner===ZeroAddress||initialOwner.toLowerCase()===cfg.treasury.toLowerCase());assert.equal(await vault.pendingOwner(),ZeroAddress);assert.equal(await vault.paused(),false);
 report.vaultRuntimeHash=keccak256(await p.getCode(cfg.tyw));report.ownerBefore=await vault.owner();report.pausedBefore=await vault.paused();
 const ids=[1571663n,1571939n],lpBefore=await Promise.all(ids.map(async id=>({id:String(id),owner:await positions.ownerOf(id),liquidity:String(await positions.getPositionLiquidity(id))})));
 stage('renounce');if(initialOwner!==ZeroAddress){const receipt=await(await vault.renounceOwnership(gas)).wait();assert.equal(receipt.status,1);}assert.equal(await vault.owner(),ZeroAddress);assert.equal(await vault.pendingOwner(),ZeroAddress);assert.equal(await vault.paused(),false);
 await assert.rejects(vault.pause.staticCall());await assert.rejects(vault.unpause.staticCall());await assert.rejects(vault.transferOwnership.staticCall(cfg.treasury));await assert.rejects(vault.acceptOwnership.staticCall());
 report.checks.push('Ownership is zero; pending transfer cleared; vault stays unpaused; former owner cannot regain or pause it');
 await(await stable.connect(whale).transfer(cfg.treasury,parseEther('100'),gas)).wait();await(await stable.approve(cfg.tyw,MaxUint256,gas)).wait();
 stage('website-buy-sell-transfer');const buy=await permanentQuote(rpc,cfg.tyw,parseEther('10'),'buy'),deadline=async()=>BigInt((await p.getBlock('latest')).timestamp+1200),held=await vault.balanceOf(cfg.treasury);
 await(await vault.buy(parseEther('10'),BigInt(buy.shares),buy.limits.map(BigInt),await deadline(),gas)).wait();assert.equal(await vault.balanceOf(cfg.treasury)-held,BigInt(buy.shares));
 const sell=await permanentQuote(rpc,cfg.tyw,parseEther('1'),'sell'),cash=await stable.balanceOf(cfg.treasury);await(await vault.sell(parseEther('1'),BigInt(sell.minimumStable),sell.limits.map(BigInt),await deadline(),gas)).wait();assert.ok(await stable.balanceOf(cfg.treasury)>cash);
 await(await vault.transfer(otherAddress,parseEther('0.5'),gas)).wait();assert.equal(await vault.balanceOf(otherAddress),parseEther('0.5'));report.checks.push('Actual website quote, backed mint, stablecoin sale and ERC20 transfer succeed after renunciation');
 stage('automatic-liquidity');const auto=JSON.parse(fs.readFileSync('deployments/bsc-auto-liquidity.json','utf8')).contracts.TreasuryAutoLiquidity,helper=new Contract(auto,artifact('TreasuryAutoLiquidity').abi,other);
 await(await stable.approve(auto,parseEther('20'),gas)).wait();await(await vault.approve(auto,0,gas)).wait();const plan=await autoLiquidityPlan(rpc,auto),tokenId=await positions.nextTokenId();
 await(await helper.provide(...plan.args,gas)).wait();assert.equal((await positions.ownerOf(tokenId)).toLowerCase(),cfg.treasury.toLowerCase());assert.ok(await positions.getPositionLiquidity(tokenId)>0n);
 report.newPositionId=String(tokenId);report.checks.push('Existing automatic controller converts single-sided treasury USDT and adds LP to the original treasury');
 stage('external-pool-swap');const traderCash=stable.connect(other),traderToken=vault.connect(other);await(await stable.connect(whale).transfer(otherAddress,parseEther('2'),gas)).wait();
 const permitAddress=await positions.permit2(),permit=new Contract(permitAddress,PERMIT_ABI,other),router=new Contract(cfg.router,['function execute(bytes,bytes[],uint256) payable'],other),quoter=new Contract(cfg.quoter,QUOTER_ABI,p),coder=AbiCoder.defaultAbiCoder(),key=[...(await positions.getPoolAndPositionInfo(ids[0]))[0]];
 for(const token of[traderCash,traderToken]){await(await token.approve(permitAddress,MaxUint256,gas)).wait();await(await permit.approve(await token.getAddress(),cfg.router,(1n<<160n)-1n,(await p.getBlock('latest')).timestamp+3600,gas)).wait();}
 const swap=async(buy,amount)=>{const input=buy?traderCash:traderToken,output=buy?traderToken:traderCash,[quote]=await quoter.quoteExactInputSingle.staticCall({poolKey:key,zeroForOne:buy,exactAmount:amount,hookData:'0x'}),minimum=quote*995n/1000n,before=await output.balanceOf(otherAddress);
  const args=[coder.encode([`(${KEY} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)`],[[key,buy,amount,minimum,'0x']]),coder.encode(['address','uint256'],[await input.getAddress(),amount]),coder.encode(['address','uint256'],[await output.getAddress(),minimum])];
  await(await router.execute('0x10',[coder.encode(['bytes','bytes[]'],['0x060c0f',args])],(await p.getBlock('latest')).timestamp+120,gas)).wait();return await output.balanceOf(otherAddress)-before;};
 const tokensBought=await swap(true,parseEther('1')),cashBack=await swap(false,tokensBought);assert.ok(tokensBought>0n&&cashBack>0n);report.poolRoundTrip={tyw:formatEther(tokensBought),usdtBack:formatEther(cashBack)};
 report.checks.push('Existing official Infinity router buys and sells through the unchanged external pool');
 stage('fee-collection');const feeAddress=JSON.parse(fs.readFileSync('deployments/bsc-fee-collector.json','utf8')).contracts.TreasuryFeeCollector,collector=new Contract(feeAddress,artifact('TreasuryFeeCollector').abi,other),fees=await collector.collect.staticCall(ids);
 await(await collector.collect(ids,gas)).wait();report.collectedFees={usdt:formatEther(fees[0]),tyw:formatEther(fees[1])};assert.deepEqual(await Promise.all(ids.map(async id=>({id:String(id),owner:await positions.ownerOf(id),liquidity:String(await positions.getPositionLiquidity(id))}))),lpBefore);
 report.checks.push('Fee-only collection still pays treasury and preserves both original LP principals and NFT owners');
 // Trigger restoration last: donating test cash changes NAV and must not precede pool/NAV guards.
 stage('rebalance');await(await stable.transfer(cfg.tyw,parseEther('30'),gas)).wait();const nonce=await vault.rebalanceNonce(),proposal=await permanentRebalanceProposal(rpc,cfg.tyw,otherAddress);
 assert.ok(proposal.transaction.data);const rebalanced=await(await other.sendTransaction({to:cfg.tyw,data:proposal.transaction.data,...gas})).wait();assert.equal(rebalanced.status,1);assert.equal(await vault.rebalanceNonce(),nonce+1n);
 report.rebalanceWeights=[...(await vault.valuation())[2]].map(Number);assert.ok(report.rebalanceWeights.every(w=>w>=2485&&w<=2515));report.checks.push('Production restoration planner and a non-owner execute a genuinely triggered bounded rebalance');
 stage('independent-redemption');const shares=parseEther('0.5'),holder=vault.connect(other),[parts,stablePart]=await vault.previewRedeem(shares),assets=await Promise.all([0,1,2,3].map(i=>vault.assets(i))),tokens=assets.map(a=>new Contract(a,TOKEN_ABI,p)),balances=await Promise.all(tokens.map(t=>t.balanceOf(otherAddress)));
 await p.send('anvil_setCode',[await vault.oracle(),'0x']);for(let i=0;i<4;i++)await p.send('anvil_setCode',[await vault.pools(i),'0x']);await(await holder.redeemInKind(shares,[...parts],stablePart,gas)).wait();
 for(let i=0;i<4;i++)assert.equal(await tokens[i].balanceOf(otherAddress)-balances[i],parts[i]);assert.equal(await vault.owner(),ZeroAddress);report.checks.push('Independent in-kind redemption survives renunciation plus unavailable oracle and underlying exchange pools');
 report.onlyLostCapabilities=['pause','unpause','ownership transfer'];report.lpPrincipalAndOwnershipUnchanged=true;report.status='PASSED';
}catch(e){report.status='FAILED';report.error=e.shortMessage||e.reason||e.message;report.rpcError=e.info?.error?.message?.slice(0,300);process.exitCode=1;}
finally{p?.destroy();live.destroy();child?.kill();save();console.log(JSON.stringify(report));}
