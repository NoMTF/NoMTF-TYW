// Gas relay end to end on a loopback BSC fork: real vault, USDT and PancakeSwap; the server code in src/gas-relay.ts
// drives the executor. Nothing is broadcast to mainnet.
import fs from 'node:fs';import crypto from 'node:crypto';import {spawn} from 'node:child_process';import assert from 'node:assert/strict';
import {JsonRpcProvider,Wallet,Contract,ContractFactory,MaxUint256,parseEther,formatEther,keccak256} from 'ethers';
import {permanentQuote} from '../src/permanent-chain.ts';
import {relayInfo,relayDrip,relaySubmit,relayTick,relayConfirm,relayDomain,relayMessage,RELAY_TYPES,RELAY_GAS} from '../src/gas-relay.ts';
import {INFINITY as cfg,TOKEN_ABI,artifact} from './infinity-config.mjs';
const upstream='https://bsc-dataseed.bnbchain.org',live=new JsonRpcProvider(upstream,56,{staticNetwork:true,batchMaxCount:1});
const port=18561,rpc='http://127.0.0.1:'+port,a=JSON.parse(fs.readFileSync('build/relay/GasRelay.json','utf8'));
const report={at:new Date().toISOString(),realTransactionsSent:false,vault:cfg.tyw,chainId:56,status:'RUNNING',compilerFingerprint:crypto.createHash('sha256').update(a.bytecode).digest('hex'),checks:[]};
const save=()=>fs.writeFileSync('reports/gas-relay-fork.json',JSON.stringify(report,null,2)+'\n');
// BSC quotes 0.05 gwei; the fork starts at base fee 0, which the relay correctly refuses as an abnormal price.
const stage=async v=>{report.stage=v;save();console.log(v);if(p){await p.send('anvil_setNextBlockBaseFeePerGas',['0x2faf080']);await p.send('evm_mine',[]);}};
let child,p;
const mem=new Map(),store={get:async k=>mem.get(k),put:async(k,v)=>{mem.set(k,v);}};
const ethersTypes={TradeRequest:RELAY_TYPES.TradeRequest.map(f=>({...f}))};
const wireRequest=r=>({...r,budget:String(r.budget),shares:String(r.shares),limits:r.limits.map(String),minNetStable:String(r.minNetStable),fee:String(r.fee),nonce:String(r.nonce),deadline:String(r.deadline)});
async function rejectsWith(promise,status,label){await assert.rejects(promise,e=>{assert.equal(e.status,status,label+': '+e.message);return true;});report.checks.push(label);}
try{
 const block=await live.getBlockNumber();report.block=block;
 child=spawn(process.platform==='win32'?'node_modules/@foundry-rs/anvil-win32-amd64/bin/anvil.exe':'anvil',['--host','127.0.0.1','--port',String(port),'--fork-url',upstream,'--fork-block-number',String(block),'--chain-id','56','--hardfork','cancun','--compute-units-per-second','2000','--gas-price','50000000','--base-fee','0','--disable-min-priority-fee','--silent'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
 let diagnostics='';child.stderr.on('data',b=>diagnostics+=b.toString());p=new JsonRpcProvider(rpc,56,{staticNetwork:true,batchMaxCount:1,cacheTimeout:-1,pollingInterval:40});
 for(let i=0;i<300;i++){try{await p.getBlockNumber();break;}catch{if(child.exitCode!==null)throw Error(diagnostics.slice(-200));await new Promise(r=>setTimeout(r,100));}}
 const deployer=await p.getSigner(0),whaleAddress='0x7aa6d92fc369a8c1edc631a3aac44efb0808ddbf';
 await p.send('anvil_impersonateAccount',[whaleAddress]);await p.send('anvil_setBalance',[whaleAddress,'0x1000000000000000000']);const whale=await p.getSigner(whaleAddress);
 const user=Wallet.createRandom().connect(p),executor=Wallet.createRandom(),gas={gasPrice:50000000n,gasLimit:3000000n};
 const stable=new Contract(cfg.stable,TOKEN_ABI,p),tyw=new Contract(cfg.tyw,TOKEN_ABI,p);

 await stage('deploy');const relayContract=await new ContractFactory(a.abi,a.bytecode,deployer).deploy(cfg.tyw,gas);await relayContract.waitForDeployment();
 const relay=await relayContract.getAddress(),codeHash=keccak256(await p.getCode(relay));report.relay=relay;report.relayRuntimeHash=codeHash;
 const env={RPC_URL:rpc,RELAY_ENABLED:'true',RELAY_ADDRESS:relay,RELAY_CODE_HASH:codeHash,RELAY_EXECUTOR_KEY:executor.privateKey};
 await p.send('anvil_setBalance',[executor.address,'0x'+parseEther('0.01').toString(16)]);
 await(await stable.connect(whale).transfer(user.address,parseEther('20'),gas)).wait();await p.send('anvil_setBalance',[user.address,'0x0']);
 const info=await relayInfo(env,store);assert.equal(info.enabled,true);assert.equal(info.available,true);assert.equal(info.executor,executor.address);
 report.fees={buyUsdt:formatEther(info.fees.buy),sellUsdt:formatEther(info.fees.sell),gasPriceWei:info.gasPriceWei,usdtPerBnb:formatEther(info.usdtPerBnb)};
 report.checks.push('Relay info verifies contract code hash and vault, quotes buy/sell fees from live gas and BNB price');

 await stage('first-approval-gas');assert.equal(await p.getBalance(user.address),0n);
 const drip=await relayDrip(env,store,{owner:user.address,mode:'buy'});assert.equal(await relayConfirm(env,drip.hash),'success');assert.equal(await p.getBalance(user.address),BigInt(drip.amountWei));
 await rejectsWith(relayDrip(env,store,{owner:user.address,mode:'buy'}),409,'A second approval-gas request is refused once the wallet holds enough BNB for the approval');
 const approval=await(await stable.connect(user).approve(relay,MaxUint256,{gasPrice:BigInt(drip.gasPriceWei),gasLimit:BigInt(drip.gasLimit)})).wait();assert.equal(approval.status,1);
 report.approvalGasUsed=String(approval.gasUsed);report.checks.push('A zero-BNB wallet receives exactly enough BNB for one 70k-gas approval and approves the relay');
 await rejectsWith(relayDrip(env,store,{owner:user.address,mode:'buy'}),409,'No approval gas once the relay is already approved');

 const sign=async request=>user.signTypedData(relayDomain(relay),ethersTypes,relayMessage(request));
 const deadline=async()=>BigInt((await p.getBlock('latest')).timestamp+600);

 await stage('relayed-buy');// Like the page: refresh the relay quote right before asking for a signature.
 const fresh=await relayInfo(env,store);console.log('gasPrice',info.gasPriceWei,'->',fresh.gasPriceWei,'usdtPerBnb',info.usdtPerBnb,'->',fresh.usdtPerBnb,'fee',info.fees.buy,'->',fresh.fees.buy);
 const budget=parseEther('10'),q=await permanentQuote(rpc,cfg.tyw,budget,'buy'),fee=BigInt(fresh.fees.buy);
 const buy={owner:user.address,executor:executor.address,mode:0,feeAsset:0,budget,shares:BigInt(q.shares),limits:q.limits.map(BigInt),minNetStable:0n,fee,nonce:0n,deadline:await deadline()};
 const buySignature=await sign(buy),before={usdt:await stable.balanceOf(user.address),fee:await stable.balanceOf(executor.address),bnb:await p.getBalance(executor.address)};
 const tampered={...buy,budget:parseEther('11')};
 await rejectsWith(relaySubmit(env,store,{request:wireRequest(tampered),signature:buySignature}),422,'A request changed after signing is refused before broadcast');
 const bought=await relaySubmit(env,store,{request:wireRequest(buy),signature:buySignature});assert.equal(await relayConfirm(env,bought.hash),'success');
 const buyReceipt=await p.getTransactionReceipt(bought.hash);report.buyGasUsed=String(buyReceipt.gasUsed);
 assert.equal(await tyw.balanceOf(user.address),buy.shares);const paid=before.usdt-await stable.balanceOf(user.address);assert.ok(paid<=budget+fee&&paid>budget*9n/10n);
 assert.equal(await stable.balanceOf(executor.address)-before.fee,fee);assert.equal(await stable.balanceOf(relay),0n);assert.equal(await tyw.balanceOf(relay),0n);
 const buyCost=before.bnb-await p.getBalance(executor.address);assert.ok(buyCost*BigInt(fresh.usdtPerBnb)/10n**18n<fee,'executor gas must be covered by the fee');
 assert.ok(buyReceipt.gasUsed<=RELAY_GAS.buy,'RELAY_GAS.buy must cover measured gas');
 report.buy={paidUsdt:formatEther(paid),sharesTyw:formatEther(buy.shares),feeUsdt:formatEther(fee),executorGasBnb:formatEther(buyCost)};
 report.checks.push('Relayed buy: user receives the signed shares, pays at most budget + signed fee, executor gets exactly the fee, relay keeps nothing, fee covers gas');
 await rejectsWith(relaySubmit(env,store,{request:wireRequest(buy),signature:buySignature}),409,'Replaying a used signature is refused (nonce)');
 const cheap={...buy,nonce:1n,fee:10n**16n,deadline:await deadline()};
 await rejectsWith(relaySubmit(env,store,{request:wireRequest(cheap),signature:await sign(cheap)}),409,'A fee below the current gas quote is refused');

 await stage('relayed-sell');const sellDrip=await relayDrip(env,store,{owner:user.address,mode:'sell'});assert.equal(await relayConfirm(env,sellDrip.hash),'success');
 const sellApproval=await(await tyw.connect(user).approve(relay,MaxUint256,{gasPrice:BigInt(sellDrip.gasPriceWei),gasLimit:BigInt(sellDrip.gasLimit)})).wait();assert.equal(sellApproval.status,1);
 const sellInfo=await relayInfo(env,store),shares=parseEther('5'),s=await permanentQuote(rpc,cfg.tyw,shares,'sell'),sellFee=BigInt(sellInfo.fees.sell),minimum=BigInt(s.minimumStable);
 const sell={owner:user.address,executor:executor.address,mode:1,feeAsset:0,budget:0n,shares,limits:s.limits.map(BigInt),minNetStable:minimum-sellFee,fee:sellFee,nonce:1n,deadline:await deadline()};
 const usdtBefore=await stable.balanceOf(user.address),feeBefore=await stable.balanceOf(executor.address),bnbBefore=await p.getBalance(executor.address);
 const sold=await relaySubmit(env,store,{request:wireRequest(sell),signature:await sign(sell)});assert.equal(await relayConfirm(env,sold.hash),'success');
 const sellReceipt=await p.getTransactionReceipt(sold.hash);report.sellGasUsed=String(sellReceipt.gasUsed);assert.ok(sellReceipt.gasUsed<=RELAY_GAS.sell,'RELAY_GAS.sell must cover measured gas');
 const received=await stable.balanceOf(user.address)-usdtBefore;assert.ok(received>=sell.minNetStable);assert.equal(await stable.balanceOf(executor.address)-feeBefore,sellFee);
 assert.equal(await tyw.balanceOf(user.address),buy.shares-shares);assert.equal(await stable.balanceOf(relay),0n);assert.equal(await tyw.balanceOf(relay),0n);
 const sellCost=bnbBefore-await p.getBalance(executor.address);assert.ok(sellCost*BigInt(sellInfo.usdtPerBnb)/10n**18n<sellFee);
 report.sell={receivedUsdt:formatEther(received),minimumNetUsdt:formatEther(sell.minNetStable),feeUsdt:formatEther(sellFee),executorGasBnb:formatEther(sellCost)};
 report.checks.push('Relayed sell: user gets at least the signed net minimum, executor gets exactly the fee, relay keeps nothing, fee covers gas');
 await rejectsWith(relayDrip(env,store,{owner:Wallet.createRandom().address,mode:'buy'}),422,'Approval gas is refused for wallets without USDT');

 await stage('fees-to-bnb');await(await stable.connect(whale).transfer(executor.address,parseEther('2'),gas)).wait();
 const usdtInExecutor=await stable.balanceOf(executor.address),bnbStart=await p.getBalance(executor.address);
 assert.equal((await relayTick(env,store)).status,'APPROVING_ROUTER');const swap=await relayTick(env,store);assert.equal(swap.status,'SWAPPING_FEES');
 await p.waitForTransaction(swap.hash);assert.equal((await relayTick(env,store)).status,'IDLE');
 assert.equal(await stable.balanceOf(executor.address),0n);const gained=await p.getBalance(executor.address)-bnbStart;assert.ok(gained>0n);
 report.feeConversion={usdt:formatEther(usdtInExecutor),bnbGainedAfterGas:formatEther(gained)};report.checks.push('Collected USDT fees are converted to BNB through PancakeSwap V2 with a V3-priced minimum');

 await stage('sweep');const treasuryBefore=await p.getBalance(cfg.treasury);await p.send('anvil_setBalance',[executor.address,'0x'+parseEther('0.03').toString(16)]);
 const sweep=await relayTick(env,store);assert.equal(sweep.status,'SWEPT');await p.waitForTransaction(sweep.hash);
 assert.equal(await p.getBalance(cfg.treasury)-treasuryBefore,parseEther('0.02'));assert.ok(await p.getBalance(executor.address)<parseEther('0.0101'));
 report.checks.push('BNB above the 0.02 working float is returned to the treasury, keeping 0.01 for gas');

 await stage('self-heal');const used=await p.getTransactionCount(executor.address,'latest');
 await store.put('relay:pending',{hash:'0x'+'ab'.repeat(32),raw:'0x00',label:'lagging-node',at:Date.now(),nonce:used-1,from:executor.address,gasPrice:'50000000'});
 const healed=await relayTick(env,store);assert.notEqual(healed.status,'PENDING');assert.equal(await store.get('relay:pending'),null);
 report.checks.push('A journal entry whose nonce is already used (a lagging RPC node) is dropped instead of blocking the relay');
 await store.put('relay:pending',{hash:'0x'+'cd'.repeat(32),raw:'0x00',label:'stuck',at:Date.now()-31*60000,nonce:await p.getTransactionCount(executor.address,'latest'),from:executor.address,gasPrice:'50000000'});
 await p.send('anvil_setBalance',[executor.address,'0x'+parseEther('0.03').toString(16)]);
 const replaced=await relayTick(env,store);assert.equal(replaced.status,'SWEPT');await p.waitForTransaction(replaced.hash);
 assert.ok((await p.getTransaction(replaced.hash)).gasPrice>=62500000n,'replacement must outbid the stuck transaction by 25%');
 report.checks.push('A transaction stuck past every signed deadline is replaced at the same nonce with a 25% higher gas price');
 report.status='PASSED';await stage('done');
}catch(e){report.status='FAILED';report.error=e?.stack||String(e);save();console.error(e);process.exitCode=1;}
finally{save();child?.kill();live.destroy();p?.destroy();}
