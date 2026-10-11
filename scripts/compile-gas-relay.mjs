// Standalone compile of the deployable GasRelay (its own source set, so Sourcify can reproduce an exact match).
import fs from 'node:fs';import path from 'node:path';import solc from 'solc';
const name='GasRelay.sol',sources={[name]:{content:fs.readFileSync('contracts/'+name,'utf8')}};
const input={language:'Solidity',sources,settings:{optimizer:{enabled:true,runs:200},viaIR:true,evmVersion:'shanghai',outputSelection:{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object','evm.deployedBytecode.immutableReferences']}}}};
const output=JSON.parse(solc.compile(JSON.stringify(input),{import:p=>{try{return{contents:fs.readFileSync(path.join('node_modules',p),'utf8')}}catch{return{error:'Missing import '+p}}}}));
const errors=output.errors?.filter(e=>e.severity==='error')||[];if(errors.length){for(const e of errors)console.error(e.formattedMessage);process.exit(1);}
const c=output.contracts[name].GasRelay;fs.mkdirSync('build/relay',{recursive:true});
fs.writeFileSync('build/relay/GasRelay.json',JSON.stringify({contractName:'GasRelay',compiler:solc.version(),abi:c.abi,bytecode:'0x'+c.evm.bytecode.object,deployedBytecode:'0x'+c.evm.deployedBytecode.object,immutableReferences:c.evm.deployedBytecode.immutableReferences},null,2));
fs.writeFileSync('build/relay/compiler-input.json',JSON.stringify(input));
console.log('GasRelay',c.evm.deployedBytecode.object.length/2,'runtime bytes',solc.version());
