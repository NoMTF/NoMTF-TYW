// Public-chain reads only. Decode each NFT's actual tick range; never assume the ranges match.
import fs from 'node:fs';import {Contract,JsonRpcProvider,formatEther,zeroPadValue,toBeHex} from 'ethers';
import {INFINITY as c,KEY,TOKEN_ABI} from './infinity-config.mjs';
const p=new JsonRpcProvider('https://bsc-dataseed.bnbchain.org',56,{staticNetwork:true});
try{
 const block=await p.getBlockNumber(),options={blockTag:block};
 const pm=new Contract(c.positions,[`function getPoolAndPositionInfo(uint256) view returns(${KEY},uint256)`,'function ownerOf(uint256) view returns(address)','function getPositionLiquidity(uint256) view returns(uint128)'],p);
 const manager=new Contract(c.manager,['function getSlot0(bytes32) view returns(uint160,int24,uint24,uint24)','function getPosition(bytes32,address,int24,int24,bytes32) view returns(uint128,uint256,uint256)','function getFeeGrowthGlobals(bytes32) view returns(uint256,uint256)','function getPoolTickInfo(bytes32,int24) view returns(uint128,int128,uint256,uint256)'],p);
 const vault=new Contract(c.tyw,[...TOKEN_ABI,'function valuation() view returns(uint256,uint256,uint256[4],uint256[4])','function owner() view returns(address)','function paused() view returns(bool)','function totalSupply() view returns(uint256)'],p),stable=new Contract(c.stable,TOKEN_ABI,p);
 const [valuation,bnb,cash,tokens,owner,paused,supply]=await Promise.all([vault.valuation(options),p.getBalance(c.treasury,block),stable.balanceOf(c.treasury,options),vault.balanceOf(c.treasury,options),vault.owner(options),vault.paused(options),vault.totalSupply(options)]);
 const positions=[];let totalCash=0n,totalTokens=0n;
 const ids=[1571663,1571939];
 for(const id of ids){
  const [account,L,info]=await Promise.all([pm.ownerOf(id,options),pm.getPositionLiquidity(id,options),pm.getPoolAndPositionInfo(id,options)]);
  const key=info[0],packed=info[1],poolId=(await import('ethers')).keccak256((await import('ethers')).AbiCoder.defaultAbiCoder().encode([KEY],[key]));
  const signed24=v=>Number(v>=1n<<23n?v-(1n<<24n):v),lower=signed24(packed>>8n&0xffffffn),upper=signed24(packed>>32n&0xffffffn);
  const [slot,pos]=await Promise.all([manager.getSlot0(poolId,options),manager.getPosition(poolId,c.positions,lower,upper,zeroPadValue(toBeHex(id),32),options)]);
  // Q96 tick conversion for display; report is an estimate, not an exit guarantee.
  const Q=2**96,s=Number(slot[0])/Q,a=1.0001**(lower/2),b=1.0001**(upper/2),liquidity=Number(L)/1e18;
  const amount0=s<=a?liquidity*(b-a)/(a*b):s>=b?0:liquidity*(b-s)/(s*b);
  const amount1=s<=a?0:s>=b?liquidity*(b-a):liquidity*(s-a);
  const estimatedUsdt=amount0,estimatedTyw=amount1,value=amount0+amount1*Number(formatEther(valuation[1]));
  positions.push({tokenId:id,owner:account,poolId,lower,upper,liquidity:String(L),managerLiquidity:String(pos[0]),usdt:estimatedUsdt,tyw:estimatedTyw,estimatedValueUsdt:value});
  if(account.toLowerCase()===c.treasury.toLowerCase()){totalCash+=BigInt(Math.floor(amount0*1e18));totalTokens+=BigInt(Math.floor(amount1*1e18));}
 }
 const result={at:new Date().toISOString(),block,readOnly:true,treasury:c.treasury,owner,paused,supply:formatEther(supply),navUsdt:formatEther(valuation[1]),wallet:{bnb:formatEther(bnb),usdt:formatEther(cash),tyw:formatEther(tokens)},positions,lpPrincipalValueUsdt:formatEther(totalCash+totalTokens*valuation[1]/10n**18n),walletAndLpExcludingBnbAndUnclaimedFeesUsdt:formatEther(cash+totalCash+(tokens+totalTokens)*valuation[1]/10n**18n),valuationMethod:'LP principal at current pool spot and each actual tick range; converted TYW at vault NAV. Excludes gas coin and pending fees.'};
 fs.writeFileSync('reports/treasury-assets-2026-10-11.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{p.destroy();}
