// Deploy and approve a fee-only collector. No pool migration, LP removal, or vault modification.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {JsonRpcProvider,Wallet,ContractFactory,Contract,parseEther,formatEther,keccak256,getCreateAddress} from 'ethers';
import {INFINITY as cfg,artifact} from './infinity-config.mjs';
const a=artifact('TreasuryFeeCollector'),fingerprint=crypto.createHash('sha256').update(a.bytecode).digest('hex'),fork=JSON.parse(fs.readFileSync('reports/fee-collector-fork.json','utf8'));
if(fork.status!=='PASSED'||fork.realTransactionsSent!==false||fork.compilerFingerprint!==fingerprint||fork.collectionDone?.status!=='FEES_COLLECTED'||fork.additionDone?.status!=='ADDED')throw Error('Matching collector and Worker fork required');
const privateDir=path.join(os.homedir(),'.mtf-private','nomtf-tyw'),pendingFile=path.join(privateDir,'fee-deploy-pending.json'),file='deployments/bsc-fee-collector.json';
const p=new JsonRpcProvider('https://bsc-dataseed.bnbchain.org',56,{staticNetwork:true,batchMaxCount:1}),wallet=new Wallet(fs.readFileSync(path.join(privateDir,'deployer-key.txt'),'utf8').trim(),p);
if(wallet.address.toLowerCase()!==cfg.treasury.toLowerCase())throw Error('Wrong treasury');
const d=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{chainId:56,startedAt:new Date().toISOString(),treasury:cfg.treasury,positions:cfg.positions,compilerFingerprint:fingerprint,contracts:{},transactions:[],spentGasWei:'0',status:'DEPLOYING'};
if(d.compilerFingerprint!==fingerprint)throw Error('Artifact changed');const save=()=>fs.writeFileSync(file,JSON.stringify(d,null,2)+'\n');
async function settle(entry){
 let receipt=await p.getTransactionReceipt(entry.hash);
 if(!receipt){const tx=JSON.parse(fs.readFileSync(pendingFile,'utf8'));if(tx.hash!==entry.hash)throw Error('Unresolved transaction journal');try{await p.broadcastTransaction(tx.raw);}catch{}receipt=await p.waitForTransaction(entry.hash,2,60000);}
 if(!receipt||receipt.status!==1)throw Error('Unconfirmed or reverted transaction; no replacement');
 Object.assign(entry,{status:'CONFIRMED',gasUsed:String(receipt.gasUsed),gasPrice:String(receipt.gasPrice),blockNumber:receipt.blockNumber});
 d.spentGasWei=String(d.transactions.filter(x=>x.status==='CONFIRMED').reduce((sum,x)=>sum+BigInt(x.gasUsed)*BigInt(x.gasPrice),0n));save();
}
async function send(label,request){
 const existing=d.transactions.find(x=>x.label===label);if(existing){if(existing.status!=='CONFIRMED')await settle(existing);return;}
 const gasPrice=(await p.getFeeData()).gasPrice;if(!gasPrice||gasPrice>150000000n)throw Error('Gas price cap');
 const gasLimit=(await p.estimateGas({...request,from:wallet.address}))*120n/100n,cost=gasLimit*gasPrice;
 if(cost+BigInt(d.spentGasWei)>parseEther('0.00012')||await p.getBalance(wallet.address)<cost+parseEther('0.002'))throw Error('Gas budget/reserve');
 const nonce=await p.getTransactionCount(wallet.address,'pending'),raw=await wallet.signTransaction({...request,chainId:56,nonce,type:0,gasPrice,gasLimit,value:0n}),hash=keccak256(raw);
 fs.writeFileSync(pendingFile,JSON.stringify({hash,raw}));const entry={label,hash,nonce,status:'SUBMITTED'};d.transactions.push(entry);save();
 try{await p.broadcastTransaction(raw);}catch{}await settle(entry);console.log(JSON.stringify({label,hash,status:entry.status}));
}
try{
 if((await p.getNetwork()).chainId!==56n)throw Error('Wrong chain');for(const tx of d.transactions.filter(x=>x.status==='SUBMITTED'))await settle(tx);
 const positions=new Contract(cfg.positions,['function ownerOf(uint256) view returns(address)','function setApprovalForAll(address,bool)','function isApprovedForAll(address,address) view returns(bool)'],p);
 for(const id of[1571663,1571939])if((await positions.ownerOf(id)).toLowerCase()!==cfg.treasury.toLowerCase())throw Error('LP owner changed');
 if(!d.contracts.TreasuryFeeCollector){const nonce=await p.getTransactionCount(wallet.address,'pending');d.contracts.TreasuryFeeCollector=getCreateAddress({from:wallet.address,nonce});save();}
 const address=d.contracts.TreasuryFeeCollector,factory=new ContractFactory(a.abi,a.bytecode,wallet);
 await send('deploy:TreasuryFeeCollector',await factory.getDeployTransaction(cfg.treasury,cfg.positions,cfg.stable,cfg.tyw,cfg.manager));
 const collector=new Contract(address,a.abi,p);
 const config=await Promise.all([collector.treasury(),collector.positions(),collector.stable(),collector.tyw(),collector.manager()]);
 if(config.some((x,i)=>x.toLowerCase()!==[cfg.treasury,cfg.positions,cfg.stable,cfg.tyw,cfg.manager][i].toLowerCase()))throw Error('Collector configuration mismatch');
 if(!await positions.isApprovedForAll(cfg.treasury,address))await send('approve-fee-collector',await positions.setApprovalForAll.populateTransaction(address,true));
 d.controllerCodeHash=keccak256(await p.getCode(address));d.positionIds=['1571663','1571939'];d.status='ACTIVE';d.updatedAt=new Date().toISOString();d.onlyCollectsFees=true;d.poolUnchanged=true;save();
 let configText=fs.readFileSync('wrangler.toml','utf8');for(const [name,value]of Object.entries({LIQUIDITY_FEE_COLLECTOR:address,LIQUIDITY_FEE_COLLECTOR_CODE_HASH:d.controllerCodeHash,LIQUIDITY_POSITION_IDS:d.positionIds.join(',')})){const re=new RegExp('^'+name+'\\s*=.*$','m'),line=name+' = '+JSON.stringify(value);configText=re.test(configText)?configText.replace(re,line):configText.replace('[vars]','[vars]\n'+line);}fs.writeFileSync('wrangler.toml',configText);
 console.log(JSON.stringify({address,status:d.status,spentBnb:formatEther(d.spentGasWei),treasuryGasReserve:formatEther(await p.getBalance(cfg.treasury)),poolUnchanged:true}));
}catch(e){d.failure={at:new Date().toISOString(),reason:e.shortMessage||e.reason||e.message};save();console.error('Collector deployment stopped',d.failure.reason);process.exitCode=1;}finally{p.destroy();}
