// Deploy the immutable GasRelay. One contract creation, no owner, no approvals, no vault or pool changes.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {JsonRpcProvider,Wallet,ContractFactory,Contract,parseEther,formatEther,keccak256,getCreateAddress} from 'ethers';
const VAULT='0xaE7eA21fBf3613fFc17fe962EE66bfe03015fBa7',USDT='0x55d398326f99059fF775485246999027B3197955',TREASURY='0x9979Ba992c6aAf7cDd068A82d14F7Afa6c7f4cD1';
const a=JSON.parse(fs.readFileSync('build/relay/GasRelay.json','utf8')),fingerprint=crypto.createHash('sha256').update(a.bytecode).digest('hex');
const fork=JSON.parse(fs.readFileSync('reports/gas-relay-fork.json','utf8')),page=JSON.parse(fs.readFileSync('reports/gas-relay-browser-check.json','utf8'));
if(fork.status!=='PASSED'||fork.realTransactionsSent!==false||fork.compilerFingerprint!==fingerprint)throw Error('A passing fork run of this exact bytecode is required');
if(page.status!=='PASSED'||page.compilerFingerprint!==fingerprint)throw Error('A passing browser run of this exact bytecode is required');
const privateDir=path.join(os.homedir(),'.mtf-private','nomtf-tyw'),pendingFile=path.join(privateDir,'relay-deploy-pending.json'),file='deployments/bsc-gas-relay.json';
const p=new JsonRpcProvider('https://bsc-dataseed.bnbchain.org',56,{staticNetwork:true,batchMaxCount:1}),wallet=new Wallet(fs.readFileSync(path.join(privateDir,'deployer-key.txt'),'utf8').trim(),p);
if(wallet.address.toLowerCase()!==TREASURY.toLowerCase())throw Error('Wrong deployer');
const d=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{chainId:56,startedAt:new Date().toISOString(),vault:VAULT,compilerFingerprint:fingerprint,compiler:a.compiler,contracts:{},transactions:[],spentGasWei:'0',status:'DEPLOYING'};
if(d.compilerFingerprint!==fingerprint)throw Error('Artifact changed since this deployment started');const save=()=>fs.writeFileSync(file,JSON.stringify(d,null,2)+'\n');
async function settle(entry){
 let receipt=await p.getTransactionReceipt(entry.hash);
 if(!receipt){const tx=JSON.parse(fs.readFileSync(pendingFile,'utf8'));if(tx.hash!==entry.hash)throw Error('Unresolved transaction journal');try{await p.broadcastTransaction(tx.raw);}catch{}receipt=await p.waitForTransaction(entry.hash,2,90000);}
 if(!receipt||receipt.status!==1)throw Error('Unconfirmed or reverted transaction; no replacement');
 Object.assign(entry,{status:'CONFIRMED',gasUsed:String(receipt.gasUsed),gasPrice:String(receipt.gasPrice),blockNumber:receipt.blockNumber});
 d.spentGasWei=String(d.transactions.filter(x=>x.status==='CONFIRMED').reduce((sum,x)=>sum+BigInt(x.gasUsed)*BigInt(x.gasPrice),0n));save();
}
async function send(label,request){
 const existing=d.transactions.find(x=>x.label===label);if(existing){if(existing.status!=='CONFIRMED')await settle(existing);return;}
 const gasPrice=(await p.getFeeData()).gasPrice;if(!gasPrice||gasPrice>150000000n)throw Error('Gas price cap');
 const gasLimit=(await p.estimateGas({...request,from:wallet.address}))*120n/100n,cost=gasLimit*gasPrice;
 if(cost>parseEther('0.0002')||await p.getBalance(wallet.address)<cost+parseEther('0.002'))throw Error('Gas budget/reserve');
 const nonce=await p.getTransactionCount(wallet.address,'pending'),raw=await wallet.signTransaction({...request,chainId:56,nonce,type:0,gasPrice,gasLimit,value:0n}),hash=keccak256(raw);
 fs.writeFileSync(pendingFile,JSON.stringify({hash,raw}));const entry={label,hash,nonce,status:'SUBMITTED'};d.transactions.push(entry);save();
 try{await p.broadcastTransaction(raw);}catch{}await settle(entry);console.log(JSON.stringify({label,hash,status:entry.status}));
}
try{
 if((await p.getNetwork()).chainId!==56n)throw Error('Wrong chain');for(const tx of d.transactions.filter(x=>x.status==='SUBMITTED'))await settle(tx);
 if(!d.contracts.GasRelay){const nonce=await p.getTransactionCount(wallet.address,'pending');d.contracts.GasRelay=getCreateAddress({from:wallet.address,nonce});save();}
 const address=d.contracts.GasRelay;await send('deploy:GasRelay',await new ContractFactory(a.abi,a.bytecode,wallet).getDeployTransaction(VAULT));
 const relay=new Contract(address,a.abi,p),[vault,stable]=await Promise.all([relay.vault(),relay.stable()]);
 if(vault.toLowerCase()!==VAULT.toLowerCase()||stable.toLowerCase()!==USDT.toLowerCase())throw Error('Relay configuration mismatch');
 // Runtime code embeds immutables (vault, USDT and, via EIP712, the relay's own address); compare everything else byte for byte.
 const code=await p.getCode(address),mask=hex=>{let b=hex.slice(2);for(const refs of Object.values(a.immutableReferences||{}))for(const {start,length}of refs)b=b.slice(0,start*2)+'0'.repeat(length*2)+b.slice((start+length)*2);return b;};
 if(!a.immutableReferences||mask(code)!==mask(a.deployedBytecode))throw Error('Runtime code differs from the tested artifact');d.runtimeHash=keccak256(code);
 Object.assign(d,{status:'ACTIVE',updatedAt:new Date().toISOString(),owner:null,holdsFundsBetweenTransactions:false});save();
 let config=fs.readFileSync('wrangler.toml','utf8');for(const [name,value]of Object.entries({RELAY_ENABLED:'true',RELAY_ADDRESS:address,RELAY_CODE_HASH:d.runtimeHash})){const re=new RegExp('^'+name+'\\s*=.*$','m'),line=name+' = '+JSON.stringify(value);config=re.test(config)?config.replace(re,line):config.replace('[vars]','[vars]\n'+line);}
 fs.writeFileSync('wrangler.toml',config);
 console.log(JSON.stringify({address,status:d.status,spentBnb:formatEther(d.spentGasWei),treasuryBnbLeft:formatEther(await p.getBalance(TREASURY))}));
}catch(e){d.failure={at:new Date().toISOString(),reason:e.shortMessage||e.reason||e.message};save();console.error('Relay deployment stopped',d.failure.reason);process.exitCode=1;}finally{p.destroy();}
