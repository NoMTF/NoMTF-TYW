import fs from 'node:fs';import path from 'node:path';import solc from 'solc';
const names=['PoolSpreadHook.sol','TreasuryInfinityLiquidity.sol','TreasuryAutoLiquidity.sol'];
const sources=Object.fromEntries(names.map(n=>[n,{content:fs.readFileSync('contracts/'+n,'utf8')}]));
const input={language:'Solidity',sources,settings:{optimizer:{enabled:true,runs:200},viaIR:true,evmVersion:'shanghai',outputSelection:{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object']}}}};
const output=JSON.parse(solc.compile(JSON.stringify(input),{import:p=>{try{return{contents:fs.readFileSync(path.join('node_modules',p),'utf8')}}catch{return{error:'Missing import '+p}}}}));
const errors=output.errors?.filter(e=>e.severity==='error')||[];if(errors.length){for(const e of errors)console.error(e.formattedMessage);process.exit(1);}
fs.mkdirSync('build/contracts',{recursive:true});
for(const file of names)for(const [name,c]of Object.entries(output.contracts[file]))if(c.evm.bytecode.object){fs.writeFileSync('build/contracts/'+name+'.json',JSON.stringify({contractName:name,abi:c.abi,bytecode:'0x'+c.evm.bytecode.object,deployedBytecode:'0x'+c.evm.deployedBytecode.object},null,2));console.log(name,c.evm.deployedBytecode.object.length/2);}
fs.writeFileSync('build/liquidity-compiler-input.json',JSON.stringify(input));
