// Browser end to end for the gas relay: anvil BSC fork + the real Worker (wrangler dev) + a scripted EIP-1193 wallet
// with 0 BNB. Clicks through a relayed buy and sell exactly like a user. Nothing touches mainnet.
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import crypto from 'node:crypto';import {spawn} from 'node:child_process';import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';
import {JsonRpcProvider,Wallet,Contract,ContractFactory,parseEther,formatEther,keccak256} from 'ethers';
import {INFINITY as cfg,TOKEN_ABI,artifact} from './infinity-config.mjs';
import {RELAY_ADDRESS,RELAY_RUNTIME_HASH} from '../src/relay-typed-data.ts';
const playwrightPath=process.env.PLAYWRIGHT_PATH||path.join(os.homedir(),'AppData/Local/npm-cache/_npx/31e32ef8478fbf80/node_modules/playwright/index.mjs');
const {chromium}=await import(pathToFileURL(playwrightPath).href);
const upstream=process.env.FORK_URL||'https://bsc-dataseed.bnbchain.org',chainPort=18562,sitePort=8788,rpc='http://127.0.0.1:'+chainPort,site='http://127.0.0.1:'+sitePort;
const report={at:new Date().toISOString(),realTransactionsSent:false,status:'RUNNING',checks:[],shots:[]};const out='reports/gas-relay-browser-check.json';
const save=()=>fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n');const log=v=>{report.stage=v;save();console.log(v);};
let chain,worker,browser,p,page,ticker;
const children=[];const start=(cmd,args,label)=>{const c=spawn(cmd,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let text='';c.stdout.on('data',b=>text+=b);c.stderr.on('data',b=>text+=b);c.tail=()=>text.slice(-1500);children.push(c);c.label=label;return c;};
const waitFor=async(fn,ms,label)=>{const end=Date.now()+ms;while(Date.now()<end){try{if(await fn())return;}catch{}await new Promise(r=>setTimeout(r,300));}throw Error('timeout: '+label);};
try{
 log('chain');const block=await new JsonRpcProvider(upstream,56,{staticNetwork:true}).getBlockNumber();
 chain=start(process.platform==='win32'?'node_modules/@foundry-rs/anvil-win32-amd64/bin/anvil.exe':'anvil',['--host','127.0.0.1','--port',String(chainPort),'--fork-url',upstream,'--fork-block-number',String(block),'--chain-id','56','--hardfork','cancun','--compute-units-per-second','2000','--base-fee','0','--silent'],'anvil');
 p=new JsonRpcProvider(rpc,56,{staticNetwork:true,batchMaxCount:1,cacheTimeout:-1,pollingInterval:50});await waitFor(()=>p.getBlockNumber(),30000,'anvil');
 // Base fee stays 0 like BSC; anvil then quotes a constant 1 gwei, so every price the page and Worker read stays valid.
 const deployer=await p.getSigner(0),whaleAddress='0x7aa6d92fc369a8c1edc631a3aac44efb0808ddbf';await p.send('anvil_impersonateAccount',[whaleAddress]);await p.send('anvil_setBalance',[whaleAddress,'0x1000000000000000000']);
 const a=JSON.parse(fs.readFileSync('build/relay/GasRelay.json','utf8'));report.compilerFingerprint=crypto.createHash('sha256').update(a.bytecode).digest('hex');// The fork contains the published relay; test exactly the contract users will approve.
 const relay=RELAY_ADDRESS,codeHash=keccak256(await p.getCode(relay));assert.equal(codeHash,RELAY_RUNTIME_HASH,'fork must contain the published relay');const executor=Wallet.createRandom(),user=Wallet.createRandom().connect(p);
 await p.send('anvil_setBalance',[executor.address,'0x'+parseEther('0.01').toString(16)]);
 const stable=new Contract(cfg.stable,TOKEN_ABI,p),tyw=new Contract(cfg.tyw,TOKEN_ABI,p);
 await(await stable.connect(await p.getSigner(whaleAddress)).transfer(user.address,parseEther('20'),{gasPrice:50000000n})).wait();await p.send('anvil_setBalance',[user.address,'0x0']);
 report.relay=relay;report.user=user.address;

 log('worker');worker=start('node',['node_modules/wrangler/bin/wrangler.js','dev','--port',String(sitePort),'--ip','127.0.0.1','--var','RPC_URL:'+rpc,'--var','RELAY_ENABLED:true','--var','RELAY_ADDRESS:'+relay,'--var','RELAY_CODE_HASH:'+codeHash,'--var','RELAY_EXECUTOR_KEY:'+executor.privateKey,'--var','LIQUIDITY_ENABLED:false','--persist-to','.qa/wrangler-relay-state'],'wrangler');
 await waitFor(async()=>(await fetch(site+'/api/health')).ok,90000,'wrangler dev');
 const info=await(await fetch(site+'/api/relay')).json();assert.equal(info.enabled,true,JSON.stringify(info));assert.equal(info.available,true);report.fees=info.fees;report.checks.push('Worker /api/relay reports the relay available with live fees');

 // Real BSC keeps producing 0.05 gwei blocks; the page waits for 2 confirmations, so keep the fork ticking.
 // Real BSC keeps producing blocks and the page waits for 2 confirmations, so keep the fork ticking.
 ticker=setInterval(()=>{p.send('evm_mine',[]).catch(()=>{});},1000);
 log('browser');const chromePath=process.env.CHROME_PATH||path.join(os.homedir(),'AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe');browser=await chromium.launch(fs.existsSync(chromePath)?{executablePath:chromePath}:{});const context=await browser.newContext({viewport:{width:1280,height:900}});page=await context.newPage();
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.exposeFunction('__rpc',async(method,params)=>JSON.stringify(await p.send(method,JSON.parse(params))));
 await page.exposeFunction('__sendTx',async raw=>{const tx=JSON.parse(raw);const sent=await user.sendTransaction({to:tx.to,data:tx.data,value:tx.value?BigInt(tx.value):0n,gasLimit:tx.gas?BigInt(tx.gas):undefined,gasPrice:tx.gasPrice?BigInt(tx.gasPrice):undefined,type:0});return sent.hash;});
 await page.exposeFunction('__signTyped',async raw=>{const d=JSON.parse(raw),types={...d.types};delete types.EIP712Domain;return user.signTypedData(d.domain,types,d.message);});
 await page.addInitScript(account=>{window.ethereum={isMetaMask:true,on(){},removeListener(){},request:async({method,params})=>{
  if(method==='eth_requestAccounts'||method==='eth_accounts')return [account];if(method==='eth_chainId')return '0x38';
  if(method==='wallet_switchEthereumChain'||method==='wallet_addEthereumChain')return null;
  if(method==='eth_sendTransaction')return window.__sendTx(JSON.stringify(params[0]));
  if(method==='eth_signTypedData_v4')return window.__signTyped(params[1]);
  return JSON.parse(await window.__rpc(method,JSON.stringify(params||[])));}};},user.address);
 await page.goto(site+'/');await page.waitForFunction(()=>window.__TYW_STARTUP?.ready,null,{timeout:60000});
 await page.locator('#trade').click();await page.waitForFunction(()=>document.getElementById('usdt').textContent.startsWith('20'),null,{timeout:60000});
 await page.waitForFunction(()=>document.getElementById('trade').textContent.includes('网络费代付'),null,{timeout:60000});
 report.checks.push('A 0-BNB wallet connects and the trade button switches to the relay ("网络费代付")');

 log('relayed-buy');await page.locator('#amount').fill('10');await page.waitForFunction(()=>document.getElementById('trade').textContent.includes('确认买入 · 网络费代付'),null,{timeout:60000});
 const note=await page.locator('#execution-note').textContent();assert.match(note,/代付|先垫/);await page.locator('.fee-details>summary').click();
 const details=await page.locator('#quote-details').innerText();assert.match(details,/代付网络费/);assert.doesNotMatch(details,/本次网络 gas（BNB）/);
 await page.screenshot({path:'.qa/final-shots/relay-buy-ready.png'});report.shots.push('.qa/final-shots/relay-buy-ready.png');
 await page.locator('#trade').click();
 await page.waitForFunction(()=>/交易完成/.test(document.getElementById('message').textContent)||document.getElementById('message').classList.contains('bad'),null,{timeout:180000});
 const buyMessage=await page.locator('#message').textContent();assert.match(buyMessage,/交易完成/,buyMessage);
 const shares=await tyw.balanceOf(user.address);assert.ok(shares>parseEther('9'));assert.ok(await stable.balanceOf(executor.address)>0n);assert.equal(await stable.balanceOf(relay),0n);
 report.buy={userTyw:formatEther(shares),userUsdtLeft:formatEther(await stable.balanceOf(user.address)),executorUsdtFees:formatEther(await stable.balanceOf(executor.address))};
 await page.screenshot({path:'.qa/final-shots/relay-buy-done.png'});report.shots.push('.qa/final-shots/relay-buy-done.png');
 report.checks.push('Relayed buy from the page: approval gas sent, USDT approved, typed data signed by the wallet, Worker broadcast, shares arrived');

 log('relayed-sell');await page.locator('#sell-tab').click();await page.locator('#amount').fill('5');
 await page.waitForFunction(()=>document.getElementById('trade').textContent.includes('确认卖出 · 网络费代付'),null,{timeout:60000});
 const usdtBefore=await stable.balanceOf(user.address);await page.locator('#trade').click();
 await page.waitForFunction(()=>/交易完成/.test(document.getElementById('message').textContent)||document.getElementById('message').classList.contains('bad'),null,{timeout:180000});
 const sellMessage=await page.locator('#message').textContent();assert.match(sellMessage,/交易完成/,sellMessage);
 // Proceeds of 5 TYW (~4.95 USDT) minus the relay fee, which this fork inflates (1 gwei instead of BSC's 0.05).
 assert.ok(await stable.balanceOf(user.address)-usdtBefore>parseEther('4.8')-BigInt(info.fees.sell));assert.equal(await tyw.balanceOf(relay),0n);
 report.sell={usdtReceived:formatEther(await stable.balanceOf(user.address)-usdtBefore),userTywLeft:formatEther(await tyw.balanceOf(user.address))};
 report.checks.push('Relayed sell from the page: TYW approval gas, approval, signature, broadcast, USDT arrived');
 const userBnb=await p.getBalance(user.address);report.userBnbLeft=formatEther(userBnb);
 assert.deepEqual(errors,[]);report.status='PASSED';log('done');
}catch(e){report.status='FAILED';report.error=e?.stack||String(e);await new Promise(r=>setTimeout(r,2000));try{report.pageMessage=await page?.locator('#message').textContent();report.pageTransactions=await page?.locator('#transactions').innerText();await page?.screenshot({path:'.qa/final-shots/relay-failure.png'});}catch{}for(const c of children)report[c.label+'Tail']=c.tail?.();save();console.error(e);process.exitCode=1;}
finally{clearInterval(ticker);save();await browser?.close();for(const c of children)c.kill();p?.destroy();}
