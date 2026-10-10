async (page) => {
 const errors=[],requests=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(r.url()));
 await page.addInitScript(()=>{const account='0x1111111111111111111111111111111111111111';window.__sent=[];window.ethereum={request:async({method,params})=>{
  if(method==='eth_requestAccounts'||method==='eth_accounts')return[account];if(method==='eth_chainId')return'0x38';
  if(method==='eth_call'){const data=params[0].data;const word=n=>BigInt(n).toString(16).padStart(64,'0');if(data.startsWith('0x70a08231'))return'0x'+word(2n*10n**18n);if(data.length===74)return'0x'+[1n,2n,3n,4n,0n].map(v=>word(v*10n**18n)).join('');return'0x';}
  if(method==='eth_estimateGas')return'0x30d40';if(method==='eth_sendTransaction'){window.__sent.push(params[0]);return'0x'+'1'.repeat(64);}throw Error('Unexpected RPC '+method);
 },on:()=>{}};});
 await page.goto('http://127.0.0.1:4174/exit.html');await page.getByRole('button',{name:'连接钱包 · BNB Chain'}).click();await page.getByRole('button',{name:'读取合约并预览'}).click();
 if(!(await page.locator('#preview').innerText()).includes('SGOVon  4'))throw Error('Missing direct-chain preview');
 await page.getByRole('button',{name:'签名赎回底层资产'}).click();await page.waitForFunction(()=>window.__sent.length===1);
 const sent=await page.evaluate(()=>window.__sent[0]);if(sent.to.toLowerCase()!=='0xae7ea21fbf3613ffc17fe962ee66bfe03015fba7'||sent.data.length!==394)throw Error('Wrong independent exit transaction');
 await page.setViewportSize({width:390,height:844});if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Mobile overflow');await page.screenshot({path:'.qa/exit-mobile.png'});
 await page.setViewportSize({width:1440,height:1000});if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Desktop overflow');
 if(errors.length||requests.some(u=>u.includes('/api/')))throw Error('Exit uses website API or has browser errors');
 console.log(JSON.stringify({mockWalletOnly:true,realTransactionsSent:false,directContractPrepared:true,noWebsiteApi:true,mobileAndDesktop:true,browserErrors:errors}));
}
