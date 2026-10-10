async (page) => {
 await page.addInitScript(()=>{
  const account='0x1111111111111111111111111111111111111111';window.__mockGas='0x2faf080';window.__mockSent=[];
  window.ethereum={isMetaMask:true,on:()=>{},removeListener:()=>{},request:async({method,params})=>{
   if(method==='eth_requestAccounts'||method==='eth_accounts')return[account];if(method==='eth_chainId')return'0x38';
   if(method==='eth_gasPrice')return window.__mockGas;if(method==='eth_maxPriorityFeePerGas')return'0x0';if(method==='eth_blockNumber')return'0x1234';
   if(method==='eth_getBlockByNumber')return{number:'0x1234',hash:'0x'+'a'.repeat(64),parentHash:'0x'+'b'.repeat(64),timestamp:'0x'+Math.floor(Date.now()/1000).toString(16),nonce:'0x0000000000000000',difficulty:'0x0',gasLimit:'0x1c9c380',gasUsed:'0x0',miner:account,transactions:[],extraData:'0x',baseFeePerGas:null};
   if(method==='eth_getBalance')return'0x'+(100n*10n**18n).toString(16);if(method==='eth_getTransactionCount')return'0x0';
   if(method==='eth_call')return'0x'+(100n*10n**18n).toString(16).padStart(64,'0');if(method==='eth_estimateGas')return'0x186a0';
   if(method==='eth_sendTransaction'){window.__mockSent.push(params[0]);return'0x'+'c'.repeat(64);}if(method==='eth_getTransactionByHash')return null;
   throw Error('Unexpected mock method '+method);
  }};
 });
 await page.route('**/api/**',route=>{
  const url=new URL(route.request().url()),now=Date.now();let body={};
  if(url.pathname==='/api/config')body={walletConnectProjectId:null};
  if(url.pathname==='/api/state')body={at:now,vault:'0xaE7eA21fBf3613fFc17fe962EE66bfe03015fBa7',chainId:56,paused:false,supply:'100',balances:['1','1','1','1'],valuation:{perShareUsdt:'1',weightsBps:[2500,2500,2500,2500]}};
  if(url.pathname==='/api/quote'){const mode=url.searchParams.get('mode')||'buy';body={at:now-1000,expiresAt:now+45000,chainId:56,vault:'0xaE7eA21fBf3613fFc17fe962EE66bfe03015fBa7',mode,budget:'1000000000000000000',shares:mode==='buy'?'990000000000000000':'1000000000000000000',limits:Array(4).fill('249000000000000000'),required:Array(4).fill('100000000000000000'),blockNumber:'100',first:false,indicative:false,executionConstraint:null,expectedOutputUsdt:'0.99',minimumStable:'985050000000000000',estimatedRefundUsdt:mode==='buy'?'0.004':'0',gasPriceWei:'50000000',bnbUsdt:'700',feeReferenceUsdt:mode==='buy'?null:'1',acquiredValueUsdt:'0.99'};}
  return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
 });
 await page.goto('http://127.0.0.1:4174/');await page.locator('#wallet').click();await page.getByRole('button',{name:'连接 MetaMask',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#quote-details').textContent.includes('预计获得'));
 await page.evaluate(()=>{window.__mockGas='0x1dcd6500';});
 await page.getByRole('button',{name:'确认买入 TYW',exact:true}).click();await page.waitForFunction(()=>document.getElementById('force-dialog').open);
 if(!(await page.locator('#force-fee').innerText()).includes('USDT'))throw Error('Fee not shown');
 if(await page.evaluate(()=>window.__mockSent.length)!==0)throw Error('Sent without explicit consent');
 await page.getByRole('button',{name:'取消，暂不交易'}).click();if(await page.evaluate(()=>window.__mockSent.length)!==0)throw Error('Cancel sent transaction');
 await page.evaluate(()=>{window.__mockGas='0x3b9aca00';});await page.getByRole('button',{name:'确认买入 TYW',exact:true}).click();await page.waitForFunction(()=>document.getElementById('force-dialog').open);
 await page.getByRole('button',{name:'仍然强制买入',exact:true}).click();await page.waitForFunction(()=>window.__mockSent.length===1,{},{timeout:30000});
 const sent=await page.evaluate(()=>window.__mockSent[0]);if(sent.to.toLowerCase()!=='0xae7ea21fbf3613ffc17fe962ee66bfe03015fba7'||!sent.data||BigInt(sent.gasPrice)!==1000000000n)throw Error('Wrong explicit fee/contract');
 if(await page.evaluate(()=>document.getElementById('force-dialog').open))throw Error('Reopened after pending submission');
 await page.goto('http://127.0.0.1:4174/');await page.locator('#wallet').click();await page.getByRole('button',{name:'连接 MetaMask',exact:true}).click();await page.locator('#sell-tab').click();
 await page.waitForFunction(()=>document.querySelector('#quote-details').textContent.includes('最低到账'));
 await page.evaluate(()=>{window.__mockGas='0x1dcd6500';});await page.getByRole('button',{name:'确认卖出 TYW',exact:true}).click();await page.waitForFunction(()=>document.getElementById('force-dialog').open);
 if(await page.evaluate(()=>window.__mockSent.length)!==0)throw Error('Sale sent before consent');
 await page.getByRole('button',{name:'仍然强制卖出',exact:true}).click();await page.waitForFunction(()=>window.__mockSent.length===1,{},{timeout:30000});
 console.log(JSON.stringify({mockWalletOnly:true,realTransactionsSent:false,highFeePopup:true,estimatedFeesShown:true,cancelDoesNotSend:true,forceBypassesFeeAdvisory:true,oneSubmission:true}));
}
