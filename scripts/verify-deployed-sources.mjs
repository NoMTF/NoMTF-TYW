// Publish complete Solidity compiler input, then confirm creation AND runtime matches.
import fs from 'node:fs';import path from 'node:path';import solc from 'solc';
const mode=process.argv[2]||'vault',isVault=mode==='vault',d=JSON.parse(fs.readFileSync(isVault?'deployments/bsc-permanent.json':'deployments/bsc-auto-liquidity.json','utf8'));
const input=isVault?{language:'Solidity',sources:Object.fromEntries(['PermanentVault.sol','PermanentOracle.sol'].map(n=>[n,{content:fs.readFileSync('deployments/source/'+n,'utf8')}])),settings:{optimizer:{enabled:true,runs:200},viaIR:true,evmVersion:'shanghai',outputSelection:{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object']}}}}:JSON.parse(fs.readFileSync('build/liquidity-compiler-input.json','utf8'));
function imports(file,content){for(const m of content.matchAll(/import\s+(?:[^;]*?from\s+)?["']([^"']+)["']/g)){const name=m[1].startsWith('.')?path.posix.normalize(path.posix.join(path.posix.dirname(file),m[1])):m[1];if(input.sources[name])continue;const content=fs.readFileSync(path.join('node_modules',name),'utf8');input.sources[name]={content};imports(name,content);}}
for(const [n,s]of Object.entries(input.sources))imports(n,s.content);
const report={at:new Date().toISOString(),compiler:solc.version(),contracts:[]};
for(const name of isVault?['PermanentVault','PermanentOracle']:['TreasuryAutoLiquidity']){
 const address=d.contracts[name],tx=d.transactions.find(t=>t.label==='deploy:'+name)?.hash;
 const r=await fetch('https://sourcify.dev/server/v2/verify/56/'+address,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({stdJsonInput:input,compilerVersion:solc.version().replace('.Emscripten.clang',''),contractIdentifier:name+'.sol:'+name,creationTransactionHash:tx}),signal:AbortSignal.timeout(45000)});const result=await r.json();
 if(!r.ok)throw Error(name+' source submission failed '+r.status);
 const job=result.verificationId;
 let verification=result;for(let i=0;job&&i<25;i++){await new Promise(resolve=>setTimeout(resolve,2000));const poll=await fetch('https://sourcify.dev/server/v2/verify/'+job,{signal:AbortSignal.timeout(15000)});verification=await poll.json();if(verification.isJobCompleted||verification.error)break;}
 const entry={name,address,submission:result,verification,url:'https://repo.sourcify.dev/56/'+address};report.contracts.push(entry);console.log(JSON.stringify({name,address,verification}));
}
fs.writeFileSync('reports/'+mode+'-source-verification.json',JSON.stringify(report,null,2)+'\n');
