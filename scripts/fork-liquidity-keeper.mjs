// Only loopback fork writes, using production deployed helper and actual Worker signing code.
import fs from 'node:fs';import {spawn} from 'node:child_process';import assert from 'node:assert/strict';
import {JsonRpcProvider,Wallet,Contract,parseEther,keccak256} from 'ethers';
import {liquidityTick} from '../src/liquidity-keeper.ts';import {INFINITY as cfg,TOKEN_ABI,POSITION_ABI} from './infinity-config.mjs';
const d=JSON.parse(fs.readFileSync('deployments/bsc-liquidity.json','utf8')),live=new JsonRpcProvider('https://bsc-dataseed.bnbchain.org',56,{staticNetwork:true}),port=18548,report={at:new Date().toISOString(),realTransactionsSent:false,status:'RUNNING'};let child,p;
try{
 const block=await live.getBlockNumber();report.blockNumber=block;
 child=spawn('node_modules/@foundry-rs/anvil-win32-amd64/bin/anvil.exe',['--host','127.0.0.1','--port',String(port),'--fork-url','https://bsc-dataseed.bnbchain.org','--fork-block-number',String(block),'--chain-id','56','--hardfork','cancun','--gas-price','0','--base-fee','50000000','--disable-min-priority-fee','--silent'],{windowsHide:true,stdio:'ignore'});
 p=new JsonRpcProvider('http://127.0.0.1:'+port,56,{staticNetwork:true,cacheTimeout:-1,pollingInterval:20});for(let i=0;i<100;i++){try{await p.getBlockNumber();break;}catch{await new Promise(r=>setTimeout(r,100));}}
 report.gasPriceBefore=String((await p.getFeeData()).gasPrice);
 const keeper=Wallet.createRandom(),whale='0x7aa6d92fc369a8c1edc631a3aac44efb0808ddbf';await p.send('anvil_setBalance',[keeper.address,'0x'+parseEther('0.0002').toString(16)]);await p.send('anvil_impersonateAccount',[whale]);await p.send('anvil_setBalance',[whale,'0x1000000000000000000']);
 report.stage='local-funding';const stable=new Contract(cfg.stable,TOKEN_ABI,await p.getSigner(whale));await(await stable.transfer(cfg.treasury,parseEther('1'),{gasPrice:50000000n,gasLimit:100000})).wait();
 const store=new Map(),storage={get:async k=>store.get(k),put:async(k,v)=>{store.set(k,v);}},env={RPC_URL:'http://127.0.0.1:'+port,LIQUIDITY_CONTROLLER:d.contracts.TreasuryInfinityLiquidity,LIQUIDITY_CONTROLLER_CODE_HASH:keccak256(await p.getCode(d.contracts.TreasuryInfinityLiquidity)),LIQUIDITY_ENABLED:'true',LIQUIDITY_KEEPER_KEY:keeper.privateKey};
 await assert.rejects(liquidityTick({...env,LIQUIDITY_CONTROLLER_CODE_HASH:'0x'+'0'.repeat(64)},storage));
 const positions=new Contract(cfg.positions,POSITION_ABI,p),id=await positions.nextTokenId();
 report.stage='keeper';report.started=await liquidityTick(env,storage);assert.equal(report.started.status,'PENDING',JSON.stringify(report.started));
 report.done=await liquidityTick(env,storage);assert.equal(report.done.status,'ADDED');assert.equal((await positions.ownerOf(id)).toLowerCase(),cfg.treasury.toLowerCase());assert.equal(store.get('liquidity:pending'),null);report.lpOwnedByTreasury=true;report.status='PASSED';
}catch(e){report.status='FAILED';report.error=e.shortMessage||e.reason||e.message;report.rpcError=e.info?.error?.message?.slice(0,300);process.exitCode=1;}
finally{p?.destroy();live.destroy();child?.kill();fs.writeFileSync('reports/liquidity-keeper-fork.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));}
