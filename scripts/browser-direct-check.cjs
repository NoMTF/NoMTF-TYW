async (page) => {
 const errors=[],apiRequests=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/**',route=>{apiRequests.push(route.request().url());return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Synthetic website outage'})});});
 await page.goto('http://127.0.0.1:4174/');await page.locator('.direct-trade summary').click();await page.locator('#direct-mode').check();
 await page.waitForFunction(()=>document.getElementById('message').textContent.includes('已直接读取链上报价'),{},{timeout:90000});
 const details=await page.locator('#quote-details').innerText();if(!details.includes('0 USDT · 0%')||!details.includes('预计获得'))throw Error('Direct quote is missing backing/fee information');
 if(errors.length)throw Error('Browser execution error '+errors[0]);
 console.log(JSON.stringify({websiteApiDisabled:true,directChainQuote:true,realTransactionsSent:false,platformFeeZero:true}));
}
