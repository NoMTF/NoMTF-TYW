async (page) => {
 const base='http://127.0.0.1:4175',results=[],errors=[];
 page.on('pageerror',error=>errors.push(String(error)));
 await page.route('**/api/**',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(new URL(route.request().url()).pathname==='/api/config'?{walletConnectProjectId:null}:{at:Date.now(),vault:'0xaE7eA21fBf3613fFc17fe962EE66bfe03015fBa7',chainId:56,paused:false,supply:'100',balances:['1','1','1','1'],valuation:{perShareUsdt:'1',weightsBps:[2500,2500,2500,2500]}})}));
 const ready=()=>page.waitForFunction(()=>window.__TYW_STARTUP?.ready,{},{timeout:25000});
 await page.setViewportSize({width:1440,height:950});await page.goto(base);await ready();
 results.push({case:'desktop',...(await page.evaluate(()=>({attempts:window.__TYW_STARTUP.attempts,overflow:document.documentElement.scrollWidth>innerWidth,background:getComputedStyle(document.body).backgroundColor}))) });
 await page.screenshot({path:'output/playwright/startup-desktop.png'});
 await page.setViewportSize({width:390,height:844});await page.goto(base);await ready();
 results.push({case:'mobile',overflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)});
 await page.screenshot({path:'output/playwright/startup-mobile.png'});
 let manifestFailures=0;const manifest=route=>manifestFailures++===0?route.fulfill({status:503,body:'temporary'}):route.continue();
 await page.route('**/app.json*',manifest);await page.goto(base);await ready();
 results.push({case:'manifest-first-failure',requests:manifestFailures,attempts:await page.evaluate(()=>window.__TYW_STARTUP.attempts)});await page.unroute('**/app.json*',manifest);
 let cssFailures=0;const css=route=>cssFailures++===0?route.fulfill({status:503,body:'temporary'}):route.continue();
 await page.route('**/assets/*.css*',css);await page.goto(base);await ready();
 results.push({case:'css-first-failure',requests:cssFailures,attempts:await page.evaluate(()=>window.__TYW_STARTUP.attempts)});await page.unroute('**/assets/*.css*',css);
 let entryFailures=0;const entry=route=>entryFailures++===0?route.fulfill({status:503,body:'temporary'}):route.continue();
 await page.route('**/assets/trade-*.js*',entry);await page.goto(base);await ready();
 results.push({case:'entry-first-failure',requests:entryFailures,attempts:await page.evaluate(()=>window.__TYW_STARTUP.attempts)});await page.unroute('**/assets/trade-*.js*',entry);
 let blocked=0;const block=route=>{blocked++;return route.abort();};await page.route('**/assets/**',block);await page.goto(base);
 await page.waitForFunction(()=>window.__TYW_STARTUP?.attempts===3&&!document.getElementById('boot-retry').disabled,{},{timeout:18000});
 results.push({case:'all-assets-blocked',requests:blocked,...await page.evaluate(()=>({attempts:window.__TYW_STARTUP.attempts,ready:window.__TYW_STARTUP.ready,background:getComputedStyle(document.body).backgroundColor,exitLink:!!document.querySelector('a[href="/exit.html"]'),message:document.getElementById('boot-status').textContent}))});
 await page.screenshot({path:'output/playwright/startup-fallback.png'});await page.unroute('**/assets/**',block);
 await page.getByRole('button',{name:'重新加载',exact:true}).click();await ready();results.push({case:'manual-recovery',ready:true});
 if(errors.length)throw Error('Uncaught startup errors: '+errors.join('; '));
 if(results.some(x=>x.overflow))throw Error('Horizontal overflow');
 return {results,uncaughtErrors:errors.length};
}
