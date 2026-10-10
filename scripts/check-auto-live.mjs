import fs from 'node:fs';import assert from 'node:assert/strict';import {JsonRpcProvider,Contract,formatEther} from 'ethers';import {INFINITY as cfg,POSITION_ABI,TOKEN_ABI,artifact} from './infinity-config.mjs';
const d=JSON.parse(fs.readFileSync('deployments/bsc-auto-liquidity.json','utf8')),api=await(await fetch('https://xyn.lgbt/api/liquidity')).json();
assert.equal(api.controller.toLowerCase(),d.contracts.TreasuryAutoLiquidity.toLowerCase());if(!api.keeper?.hash)throw Error('No scheduled transaction yet');
const p=new JsonRpcProvider('https://bsc-dataseed.bnbchain.org',56,{staticNetwork:true});
try{const receipt=await p.getTransactionReceipt(api.keeper.hash);if(!receipt)throw Error('Scheduled transaction not yet mined');assert.equal(receipt.status,1);
 const controller=new Contract(d.contracts.TreasuryAutoLiquidity,artifact('TreasuryAutoLiquidity').abi,p),event=receipt.logs.map(l=>{try{return controller.interface.parseLog(l);}catch{return null;}}).find(e=>e?.name==='Provided');assert(event);
 const positions=new Contract(cfg.positions,POSITION_ABI,p);assert.equal((await positions.ownerOf(event.args.tokenId)).toLowerCase(),cfg.treasury.toLowerCase());
 const tokens=new Contract(cfg.tyw,TOKEN_ABI,p),cash=new Contract(cfg.stable,TOKEN_ABI,p);assert.equal(await tokens.balanceOf(d.contracts.TreasuryAutoLiquidity),0n);assert.equal(await cash.balanceOf(d.contracts.TreasuryAutoLiquidity),0n);
 const report={at:new Date().toISOString(),scheduledKeeper:true,hash:receipt.hash,blockNumber:receipt.blockNumber,status:'SUCCESS',positionTokenId:String(event.args.tokenId),cashAfterConversion:formatEther(event.args.cash),tywAfterConversion:formatEther(event.args.tokens),gasBnb:formatEther(receipt.gasUsed*receipt.gasPrice),lpRecipient:cfg.treasury,noControllerResidual:true,remainingTreasury:{usdt:formatEther(await cash.balanceOf(cfg.treasury)),tyw:formatEther(await tokens.balanceOf(cfg.treasury))}};
 fs.writeFileSync('reports/auto-liquidity-mainnet.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{p.destroy();}
