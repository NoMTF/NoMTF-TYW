import fs from 'node:fs';import path from 'node:path';import solc from 'solc';
const d=JSON.parse(fs.readFileSync('deployments/bsc-fee-collector.json','utf8')),input=JSON.parse(fs.readFileSync('build/liquidity-compiler-input.json','utf8'));
function addImports(file,code){for(const m of code.matchAll(/import\s+(?:[^;]*?from\s+)?["']([^"']+)["']/g)){const name=m[1].startsWith('.')?path.posix.normalize(path.posix.join(path.posix.dirname(file),m[1])):m[1];if(input.sources[name])continue;const content=fs.readFileSync(path.join('node_modules',name),'utf8');input.sources[name]={content};addImports(name,content);}}
for(const file of Object.keys(input.sources))addImports(file,input.sources[file].content);
const address=d.contracts.TreasuryFeeCollector,tx=d.transactions.find(t=>t.label==='deploy:TreasuryFeeCollector')?.hash;
const response=await fetch('https://sourcify.dev/server/v2/verify/56/'+address,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({stdJsonInput:input,compilerVersion:solc.version().replace('.Emscripten.clang',''),contractIdentifier:'TreasuryFeeCollector.sol:TreasuryFeeCollector',creationTransactionHash:tx}),signal:AbortSignal.timeout(45000)});
const body=await response.json(),out={at:new Date().toISOString(),address,httpStatus:response.status,body,url:'https://repo.sourcify.dev/56/'+address};
fs.writeFileSync('reports/fee-collector-source-verification.json',JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify({address,status:response.status,verificationId:body.verificationId||null}));
