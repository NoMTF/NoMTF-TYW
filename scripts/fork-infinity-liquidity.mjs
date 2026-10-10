// Mutations exist exclusively in a loopback Anvil fork. No keys or public-chain broadcasts.
import fs from 'node:fs';import {spawn} from 'node:child_process';import assert from 'node:assert/strict';import crypto from 'node:crypto';
import {JsonRpcProvider,Contract,ContractFactory,AbiCoder,parseEther,formatEther,MaxUint256,Wallet,keccak256} from 'ethers';
import {INFINITY as cfg,KEY,TOKEN_ABI,MANAGER_ABI,QUOTER_ABI,POSITION_ABI,PERMIT_ABI,artifact} from './infinity-config.mjs';
const rpc='https://bsc-dataseed.bnbchain.org',port=18547,live=new JsonRpcProvider(rpc,56,{staticNetwork:true,batchMaxCount:1});
const result={at:new Date().toISOString(),compilerFingerprint:crypto.createHash('sha256').update(['PoolSpreadHook','TreasuryInfinityLiquidity'].map(n=>artifact(n).bytecode).join('')).digest('hex'),realTransactionsSent:false,checks:[],transactions:[],status:'RUNNING'};let child,p;
const check=(label)=>result.checks.push(label);
try{
 result.blockNumber=await live.getBlockNumber();
 child=spawn('node_modules/@foundry-rs/anvil-win32-amd64/bin/anvil.exe',['--host','127.0.0.1','--port',String(port),'--fork-url',rpc,'--fork-block-number',String(result.blockNumber),'--chain-id','56','--hardfork','cancun','--gas-price','50000000','--base-fee','0','--silent'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
 let stderr='';child.stderr.on('data',b=>{stderr+=b.toString();});
 p=new JsonRpcProvider('http://127.0.0.1:'+port,56,{staticNetwork:true,cacheTimeout:-1,pollingInterval:20,batchMaxCount:1});
 for(let i=0;i<100;i++){try{await p.getBlockNumber();break;}catch{if(child.exitCode!==null)throw Error('Anvil start failed '+stderr.slice(-300));await new Promise(r=>setTimeout(r,200));}}
 await p.send('anvil_impersonateAccount',[cfg.treasury]);await p.send('anvil_setBalance',[cfg.treasury,'0x1000000000000000000']);
 const signer=await p.getSigner(cfg.treasury),other=await p.getSigner(0),otherAddress=await other.getAddress();
 const send=async(label,tx)=>{const r=await(await tx).wait();assert.equal(r.status,1);result.transactions.push({label,gasUsed:String(r.gasUsed)});return r;};
 const deploy=async name=>{const a=artifact(name);return new ContractFactory(a.abi,a.bytecode,signer);};
 const hook=await(await deploy('PoolSpreadHook')).deploy(cfg.manager,cfg.stable,cfg.tyw,cfg.treasury);await hook.waitForDeployment();
 const helper=await(await deploy('TreasuryInfinityLiquidity')).deploy(cfg.tyw,cfg.stable,cfg.positions,await hook.getAddress(),cfg.treasury);await helper.waitForDeployment();
 const stable=new Contract(cfg.stable,TOKEN_ABI,signer),tyw=new Contract(cfg.tyw,TOKEN_ABI,signer),manager=new Contract(cfg.manager,MANAGER_ABI,p),positions=new Contract(cfg.positions,POSITION_ABI,p);
 const key=await helper.poolKey(),poolId=await helper.poolId();result.poolId=poolId;
 const whale='0x7aa6d92fc369a8c1edc631a3aac44efb0808ddbf';await p.send('anvil_impersonateAccount',[whale]);await p.send('anvil_setBalance',[whale,'0x1000000000000000000']);
 if(await stable.balanceOf(cfg.treasury)<parseEther('0.5'))await send('synthetic-fork-initial-usdt',stable.connect(await p.getSigner(whale)).transfer(cfg.treasury,parseEther('4.976483012813928666')));
 const vault=new Contract(cfg.tyw,['function valuation() view returns(uint256,uint256,uint256[4],uint256[4])'],p),nav=(await vault.valuation())[1];
 const sqrt=n=>{if(n<2n)return n;let x=n,y=(x+1n)/2n;while(y<x){x=y;y=(x+n/x)/2n;}return x;};const sqrtPrice=sqrt((10n**18n)*(1n<<192n)/nav);
 await assert.rejects(manager.connect(other).initialize.staticCall([...key],sqrtPrice));await assert.rejects(helper.connect(other).setEnabled.staticCall(false));check('Only treasury initializes/disables provisioning');
 await send('initialize',manager.connect(signer).initialize([...key],sqrtPrice));await assert.rejects(manager.connect(signer).initialize.staticCall([...key],sqrtPrice));check('Existing pool cannot be reinitialized');
 for(const buy of [true,false]){const payload=hook.interface.encodeFunctionData('beforeSwap',[cfg.treasury,[...key],[buy,-parseEther('0.1'),0],'0x']);const answer=hook.interface.decodeFunctionResult('beforeSwap',await p.call({to:await hook.getAddress(),from:cfg.manager,data:payload}));assert.equal(answer[2],BigInt(0x400000|(buy?47619:50000)));assert.equal(answer[1],0n);}check('Immutable directional LP fees; no hook token custody or delta tax');
 await send('approve-usdt',stable.approve(await helper.getAddress(),MaxUint256));await send('approve-tyw',tyw.approve(await helper.getAddress(),MaxUint256));
 const preview=await helper.preview();result.preview={liquidity:String(preview[0]),usdt:formatEther(preview[1]),tyw:formatEther(preview[2]),tickLower:Number(preview[3]),tickUpper:Number(preview[4])};
 const id=await helper.add.staticCall();await send('permissionless-add',helper.connect(other).add());
 assert.equal((await positions.ownerOf(id)).toLowerCase(),cfg.treasury.toLowerCase());assert.ok(await positions.getPositionLiquidity(id)>0n);check('LP NFT belongs directly to treasury, not keeper/helper');
 const permitAddress=await positions.permit2(),permit=new Contract(permitAddress,PERMIT_ABI,p);
 for(const token of [stable,tyw]){assert.equal(await token.balanceOf(await helper.getAddress()),0n);assert.equal(await token.allowance(await helper.getAddress(),permitAddress),0n);assert.equal((await permit.allowance(await helper.getAddress(),await token.getAddress(),cfg.positions))[0],0n);}check('Exact approvals cleared and no helper residual assets');
 assert.ok(await manager.getLiquidity(poolId)>0n);await assert.rejects(helper.add.staticCall());check('Unmatched leftover inventory waits without spending');
 const quoter=new Contract(cfg.quoter,QUOTER_ABI,p);result.quotes={};
 for(const buy of [true,false]){const [out,gas]=await quoter.quoteExactInputSingle.staticCall({poolKey:[...key],zeroForOne:buy,exactAmount:parseEther('0.1'),hookData:'0x'});assert.ok(out>0n);result.quotes[buy?'buy':'sell']={input:'0.1',output:formatEther(out),estimatedGas:String(gas)};}
 check('Official Infinity quoter accepts both directions and custom hook');
 // Actual swap through the unmodified official universal router, not our custom code.
 const router=new Contract(cfg.router,['function execute(bytes,bytes[],uint256) payable'],signer),permitSigner=permit.connect(signer),coder=AbiCoder.defaultAbiCoder();
 await send('local-swap-funding',stable.connect(await p.getSigner(whale)).transfer(cfg.treasury,parseEther('0.1')));
 const now=(await p.getBlock('latest')).timestamp,amount=parseEther('0.1');
 const swap=async buy=>{const token=buy?stable:tyw,outToken=buy?tyw:stable;await send('approve-router-token',token.approve(permitAddress,amount));await send('permit-router',permitSigner.approve(await token.getAddress(),cfg.router,amount,now+3600));
  const [quoted]=await quoter.quoteExactInputSingle.staticCall({poolKey:[...key],zeroForOne:buy,exactAmount:amount,hookData:'0x'});
  const before=await outToken.balanceOf(cfg.treasury);
  const args=[coder.encode([`(${KEY} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)`],[[[...key],buy,amount,quoted*995n/1000n,'0x']]),coder.encode(['address','uint256'],[await token.getAddress(),amount]),coder.encode(['address','uint256'],[await outToken.getAddress(),quoted*995n/1000n])];
  await send(buy?'router-buy':'router-sell',router.execute('0x10',[coder.encode(['bytes','bytes[]'],['0x060c0f',args])],now+600));assert.equal(await outToken.balanceOf(cfg.treasury)-before,quoted);
 };
 await swap(true);await swap(false);check('Official universal-router buy and sell execute and match quotes');
 // Fund only the local fork with a synthetic USDT whale; prove future receipts mint a second treasury NFT.
 await send('local-future-receipt',stable.connect(await p.getSigner(whale)).transfer(cfg.treasury,parseEther('1')));
 const second=await helper.add.staticCall();await send('automatic-future-add',helper.connect(other).add());assert.ok(second>id);assert.equal((await positions.ownerOf(second)).toLowerCase(),cfg.treasury.toLowerCase());check('Later matched treasury receipts add to the same pool');
 await assert.rejects(hook.beforeSwap.staticCall(cfg.treasury,[...key],[true,-amount,0],'0x'));check('Hook callback cannot be called by arbitrary caller');
 if(process.argv.includes('--keeper')){
  const {liquidityTick}=await import('../src/liquidity-keeper.ts');const keeper=Wallet.createRandom();await p.send('anvil_setBalance',[keeper.address,'0x'+parseEther('0.0002').toString(16)]);
  await send('local-keeper-future-receipt',stable.connect(await p.getSigner(whale)).transfer(cfg.treasury,parseEther('1')));
  const data=new Map(),storage={get:async k=>data.get(k),put:async(k,v)=>{data.set(k,v);}},env={RPC_URL:'http://127.0.0.1:'+port,LIQUIDITY_CONTROLLER:await helper.getAddress(),LIQUIDITY_CONTROLLER_CODE_HASH:keccak256(await p.getCode(await helper.getAddress())),LIQUIDITY_ENABLED:'true',LIQUIDITY_KEEPER_KEY:keeper.privateKey};
  await assert.rejects(liquidityTick({...env,LIQUIDITY_CONTROLLER_CODE_HASH:'0x'+'0'.repeat(64)},storage));
  const third=await positions.nextTokenId(),started=await liquidityTick(env,storage);assert.equal(started.status,'PENDING');const done=await liquidityTick(env,storage);assert.equal(done.status,'ADDED');
  assert.equal((await positions.ownerOf(third)).toLowerCase(),cfg.treasury.toLowerCase());assert.equal(data.get('liquidity:pending'),null);
  result.keeper={started:{status:started.status,matchedUsdt:started.matchedUsdt,matchedTyw:started.matchedTyw},done:{status:done.status,gasSpentWei:done.gasSpentWei},lpOwnedByTreasury:true};
  check('Production Worker keeper code signs only fixed helper addition with an isolated gas-only key');
 }
 await send('disable',helper.setEnabled(false));await assert.rejects(helper.preview());check('Treasury can stop future additions without locking existing LP');
 result.status='PASSED';
}catch(e){result.status='FAILED';result.error=e.shortMessage||e.reason||e.message;result.code=e.code;process.exitCode=1;}
finally{if(p)p.destroy();live.destroy();if(child)child.kill();fs.writeFileSync('reports/infinity-liquidity-fork.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));}
