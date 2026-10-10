import fs from 'node:fs';import path from 'node:path';import solc from 'solc';
const d=JSON.parse(fs.readFileSync('deployments/bsc-liquidity.json','utf8')),input=JSON.parse(fs.readFileSync('build/liquidity-compiler-input.json','utf8'));
for(const file of Object.keys(input.sources))addImports(file,input.sources[file].content);
function addImports(file,content){for(const m of content.matchAll(/import\s+(?:[^;]*?from\s+)?["']([^"']+)["']/g)){const name=m[1].startsWith('.')?path.posix.normalize(path.posix.join(path.posix.dirname(file),m[1])):m[1];if(input.sources[name])continue;const code=fs.readFileSync(path.join('node_modules',name),'utf8');input.sources[name]={content:code};addImports(name,code);}}
const out={at:new Date().toISOString(),contracts:[]};
for(const name of ['PoolSpreadHook','TreasuryInfinityLiquidity']){
 const address=d.contracts[name],tx=d.transactions.find(t=>t.label==='deploy:'+name)?.hash;
 const response=await fetch('https://sourcify.dev/server/v2/verify/56/'+address,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({stdJsonInput:input,compilerVersion:solc.version().replace('.Emscripten.clang',''),contractIdentifier:name+'.sol:'+name,creationTransactionHash:tx}),signal:AbortSignal.timeout(45000)});
 const body=await response.json();out.contracts.push({name,address,httpStatus:response.status,body,url:'https://repo.sourcify.dev/56/'+address});console.log(JSON.stringify({name,address,status:response.status,verificationId:body.verificationId||null}));
}
fs.writeFileSync('reports/liquidity-source-verification.json',JSON.stringify(out,null,2)+'\n');
