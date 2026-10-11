// Submit the exact standalone compiler input of GasRelay to Sourcify.
import fs from 'node:fs';import path from 'node:path';
const d=JSON.parse(fs.readFileSync('deployments/bsc-gas-relay.json','utf8')),input=JSON.parse(fs.readFileSync('build/relay/compiler-input.json','utf8')),a=JSON.parse(fs.readFileSync('build/relay/GasRelay.json','utf8'));
function addImports(file,code){for(const m of code.matchAll(/import\s+(?:[^;]*?from\s+)?["']([^"']+)["']/g)){const name=m[1].startsWith('.')?path.posix.normalize(path.posix.join(path.posix.dirname(file),m[1])):m[1];if(input.sources[name])continue;const content=fs.readFileSync(path.join('node_modules',name),'utf8');input.sources[name]={content};addImports(name,content);}}
for(const file of Object.keys(input.sources))addImports(file,input.sources[file].content);
const address=d.contracts.GasRelay,tx=d.transactions.find(t=>t.label==='deploy:GasRelay')?.hash;
const response=await fetch('https://sourcify.dev/server/v2/verify/56/'+address,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({stdJsonInput:input,compilerVersion:a.compiler.replace('.Emscripten.clang',''),contractIdentifier:'GasRelay.sol:GasRelay',creationTransactionHash:tx}),signal:AbortSignal.timeout(45000)});
const body=await response.json(),out={at:new Date().toISOString(),address,httpStatus:response.status,body,url:'https://repo.sourcify.dev/56/'+address};
fs.writeFileSync('reports/gas-relay-source-verification.json',JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify({address,status:response.status,verificationId:body.verificationId||null}));
