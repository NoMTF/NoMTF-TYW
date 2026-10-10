import fs from 'node:fs';
import path from 'node:path';
import solc from 'solc';
const sources = Object.fromEntries(fs.readdirSync('contracts').filter(n=>n.endsWith('.sol')).map(n=>[n,{content:fs.readFileSync(path.join('contracts',n),'utf8')}]));
const input={language:'Solidity',sources,settings:{optimizer:{enabled:true,runs:200},viaIR:true,evmVersion:'shanghai',outputSelection:{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object']}}}};
const output=JSON.parse(solc.compile(JSON.stringify(input),{import:p=>{try{return{contents:fs.readFileSync(path.join('node_modules',p),'utf8')}}catch{return{error:`Import missing: ${p}`}}}}));
for(const e of output.errors??[]){if(e.severity==='error'){console.error(e.formattedMessage);process.exitCode=1;}}
if(process.exitCode)process.exit(process.exitCode);
fs.mkdirSync('build/contracts',{recursive:true});
for(const [file,contracts]of Object.entries(output.contracts))for(const[name,data]of Object.entries(contracts)){
 if(!sources[file]||!data.evm.bytecode.object)continue;
 fs.writeFileSync(`build/contracts/${name}.json`,JSON.stringify({contractName:name,abi:data.abi,bytecode:'0x'+data.evm.bytecode.object,deployedBytecode:'0x'+data.evm.deployedBytecode.object},null,2));
 console.log(`${name}: ${data.evm.deployedBytecode.object.length/2} runtime bytes`);
}
fs.writeFileSync('build/compiler-input.json',JSON.stringify(input));
