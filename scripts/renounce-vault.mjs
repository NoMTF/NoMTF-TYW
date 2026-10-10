// User-authorized one-way renunciation of the deployed TYW vault, never treasury/LP ownership.
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import assert from 'node:assert/strict';
import {JsonRpcProvider,Contract,Wallet,ZeroAddress,keccak256,parseEther,formatEther,Interface} from 'ethers';
import {INFINITY as cfg,POSITION_ABI} from './infinity-config.mjs';
const file='deployments/bsc-renounce.json',privateDir=path.join(os.homedir(),'.mtf-private','nomtf-tyw'),pendingFile=path.join(privateDir,'renounce-pending.json');
const abi=['function owner() view returns(address)','function pendingOwner() view returns(address)','function paused() view returns(bool)','function totalSupply() view returns(uint256)','function oracle() view returns(address)','function renounceOwnership()','event OwnershipTransferred(address indexed previousOwner,address indexed newOwner)'];
const p=new JsonRpcProvider('https://bsc-dataseed.bnbchain.org',56,{staticNetwork:true,batchMaxCount:1}),mirror=new JsonRpcProvider('https://bsc-rpc.publicnode.com',56,{staticNetwork:true,batchMaxCount:1});
const report=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{startedAt:new Date().toISOString(),chainId:56,vault:cfg.tyw,previousOwner:cfg.treasury,status:'CHECKING',irreversible:true,onlyAction:'renounceOwnership',lpOwnershipRetained:true};
const save=()=>fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n');
try{
 const fork=JSON.parse(fs.readFileSync('reports/renounce-fork.json','utf8'));assert.equal(fork.status,'PASSED');assert.equal(fork.realTransactionsSent,false);assert.equal(fork.vault.toLowerCase(),cfg.tyw.toLowerCase());
 assert.equal(await p.send('eth_chainId',[]),'0x38');assert.equal(await mirror.send('eth_chainId',[]),'0x38');
 const vault=new Contract(cfg.tyw,abi,p),beforeBlock=await p.getBlockNumber(),codeHash=keccak256(await p.getCode(cfg.tyw,beforeBlock));assert.equal(codeHash,fork.vaultRuntimeHash);
 if(!report.hash){
  assert.equal((await vault.owner({blockTag:beforeBlock})).toLowerCase(),cfg.treasury.toLowerCase());assert.equal(await vault.pendingOwner({blockTag:beforeBlock}),ZeroAddress);assert.equal(await vault.paused({blockTag:beforeBlock}),false);
  let wallet;try{wallet=new Wallet(fs.readFileSync(path.join(privateDir,'deployer-key.txt'),'utf8').trim(),p);}catch{throw Error('Local signing key unavailable or invalid');}assert.equal(wallet.address.toLowerCase(),cfg.treasury.toLowerCase());
  const positions=new Contract(cfg.positions,POSITION_ABI,p);report.lpBefore=await Promise.all([1571663,1571939].map(async id=>({id:String(id),owner:await positions.ownerOf(id,{blockTag:beforeBlock}),liquidity:String(await positions.getPositionLiquidity(id,{blockTag:beforeBlock}))})));assert.ok(report.lpBefore.every(x=>x.owner.toLowerCase()===cfg.treasury.toLowerCase()));
  const gasPrice=(await p.getFeeData()).gasPrice;assert.ok(gasPrice&&gasPrice<=150000000n,'Gas price exceeds cap');const data=new Interface(abi).encodeFunctionData('renounceOwnership');
  await vault.connect(wallet).renounceOwnership.staticCall();const estimate=await p.estimateGas({from:wallet.address,to:cfg.tyw,data}),gasLimit=(estimate*120n+99n)/100n;assert.ok(gasLimit<=100000n&&gasLimit*gasPrice<=parseEther('0.00002'),'Gas cost exceeds cap');assert.ok(await p.getBalance(wallet.address)>gasLimit*gasPrice+parseEther('0.002'),'Gas reserve too low');
  const nonce=await p.getTransactionCount(wallet.address,'pending');assert.equal(nonce,await p.getTransactionCount(wallet.address,'latest'),'Unresolved treasury transaction');
  const raw=await wallet.signTransaction({to:cfg.tyw,data,value:0n,chainId:56,nonce,type:0,gasPrice,gasLimit}),hash=keccak256(raw);
  fs.writeFileSync(pendingFile,JSON.stringify({hash,raw}),{mode:0o600});Object.assign(report,{hash,nonce,status:'SIGNED',beforeBlock,vaultRuntimeHash:codeHash,pausedBefore:false,supplyBefore:String(await vault.totalSupply({blockTag:beforeBlock})),forkReport:'reports/renounce-fork.json'});save();
 }
 let receipt=await p.getTransactionReceipt(report.hash);
 if(!receipt){const pending=JSON.parse(fs.readFileSync(pendingFile,'utf8'));assert.equal(pending.hash,report.hash);assert.equal(keccak256(pending.raw),report.hash);try{await p.broadcastTransaction(pending.raw);}catch{/* Query the same hash; never replace or re-sign. */}report.status='SUBMITTED';save();
  for(let n=0;n<40&&!receipt;n++){receipt=await p.getTransactionReceipt(report.hash);if(!receipt)await new Promise(r=>setTimeout(r,1000));}
 }
 assert.ok(receipt,'Transaction not confirmed; retry this script without replacing transaction');assert.equal(receipt.status,1,'Renunciation reverted');
 while(await p.getBlockNumber()<receipt.blockNumber+2)await new Promise(r=>setTimeout(r,500));
 const event=receipt.logs.filter(l=>l.address.toLowerCase()===cfg.tyw.toLowerCase()).map(l=>{try{return vault.interface.parseLog(l);}catch{return null;}}).find(e=>e?.name==='OwnershipTransferred');assert.ok(event);assert.equal(event.args.previousOwner.toLowerCase(),cfg.treasury.toLowerCase());assert.equal(event.args.newOwner,ZeroAddress);
 const verify=async provider=>{const v=new Contract(cfg.tyw,abi,provider),block=await provider.getBlockNumber();assert.ok(block>=receipt.blockNumber);const [owner,pendingOwner,paused]=await Promise.all([v.owner({blockTag:block}),v.pendingOwner({blockTag:block}),v.paused({blockTag:block})]);assert.equal(owner,ZeroAddress);assert.equal(pendingOwner,ZeroAddress);assert.equal(paused,false);return {block,owner,pendingOwner,paused};};
 report.verification=[await verify(p),await verify(mirror)];const positions=new Contract(cfg.positions,POSITION_ABI,p);report.lpAfter=await Promise.all(report.lpBefore.map(async x=>({id:x.id,owner:await positions.ownerOf(x.id),liquidity:String(await positions.getPositionLiquidity(x.id))})));assert.deepEqual(report.lpAfter,report.lpBefore);
 Object.assign(report,{status:'CONFIRMED',confirmedAt:new Date().toISOString(),blockNumber:receipt.blockNumber,gasUsed:String(receipt.gasUsed),gasPriceWei:String(receipt.gasPrice),gasBnb:formatEther(receipt.gasUsed*receipt.gasPrice),owner:ZeroAddress,pendingOwner:ZeroAddress,paused:false,lpPrincipalUnchanged:true,rateChange:false});save();console.log(JSON.stringify(report));
}catch(e){report.failure={at:new Date().toISOString(),reason:e.shortMessage||e.reason||e.message};save();console.error('Renunciation stopped:',report.failure.reason);process.exitCode=1;}finally{p.destroy();mirror.destroy();}
