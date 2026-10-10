import {parseAbi,type Address} from 'viem';
import {chainClient} from './chain.ts';
import {PERMANENT_ABI,PERMANENT_QUOTER_ABI} from './permanent-chain.ts';
import {PERMANENT_ASSETS,USDT} from './permanent-assets.ts';
import {PANCAKE} from './assets.ts';
export const AUTO_ABI=parseAbi(['function inventory() view returns(uint256 cash,uint256 tokens,uint256 nav,uint256 ratio)','function provide(uint256 buyBudget,uint256 shares,uint256[4] limits,uint256 deadline) returns(uint256)','function poolId() view returns(bytes32)','function treasury() view returns(address)','function manager() view returns(address)','function enabled() view returns(bool)']);
const VAULT='0xaE7eA21fBf3613fFc17fe962EE66bfe03015fBa7' as Address,SCALE=10n**18n;
export function imbalance(cash:bigint,tokens:bigint,ratio:bigint){const other=tokens*ratio/SCALE,sum=cash+other;return sum?(cash>other?cash-other:other-cash)*10000n/sum:0n;}
export class LiquidityMinimumError extends Error{
 constructor(readonly value:bigint){super('Inventory below economic minimum');}
}
export async function autoLiquidityPlan(rpc:string,controller:Address,minimumValue=0n){
 const client=chainClient(rpc),blockNumber=await client.getBlockNumber(),block=await client.getBlock({blockNumber});
 const [cash,tokens,nav,ratio]=await client.readContract({address:controller,abi:AUTO_ABI,functionName:'inventory',blockNumber});
 const value=cash+tokens*nav/SCALE;if(value<minimumValue)throw new LiquidityMinimumError(value);
 const deadline=block.timestamp+110n;
 if(imbalance(cash,tokens,ratio)<=50n)return{args:[0n,0n,[0n,0n,0n,0n],deadline] as const,cash,tokens,value,operation:'MATCHED'};
 const buying=cash>tokens*ratio/SCALE;
 let shares=buying?(cash*SCALE-tokens*ratio)/(nav+ratio):(tokens*ratio-cash*SCALE)/(ratio+nav);
 // Exact quotes at one block; solve again using real execution costs rather than assuming NAV=swap price.
 for(let attempt=0;attempt<5;attempt++){
  if(shares<=0n)throw Error('Too little inventory');
  const [parts,stablePart]=await client.readContract({address:VAULT,abi:PERMANENT_ABI,functionName:buying?'previewMint':'previewRedeem',args:[shares],blockNumber});
  const quoted=await Promise.all(parts.map(async(amount,i)=>{
   if(amount===0n)return 0n;const asset=PERMANENT_ASSETS[i];
   if(buying){const {result}=await client.simulateContract({address:PANCAKE.quoter,abi:PERMANENT_QUOTER_ABI,functionName:'quoteExactOutputSingle',args:[{tokenIn:USDT,tokenOut:asset.address,amount,fee:asset.fee,sqrtPriceLimitX96:0n}],blockNumber});return result[0];}
   const {result}=await client.simulateContract({address:PANCAKE.quoter,abi:PERMANENT_QUOTER_ABI,functionName:'quoteExactInputSingle',args:[{tokenIn:asset.address,tokenOut:USDT,amountIn:amount,fee:asset.fee,sqrtPriceLimitX96:0n}],blockNumber});return result[0];
  }));
  const stableChange=quoted.reduce((a,b)=>a+b,stablePart),nextCash=buying?cash-stableChange:cash+stableChange,nextTokens=buying?tokens+shares:tokens-shares;
  if(nextCash<0n||nextTokens<0n)throw Error('Inventory exceeded');
  const value=cash+tokens*nav/SCALE,nextValue=nextCash+nextTokens*nav/SCALE;
  if(nextValue*10000n<value*9950n)throw Error('Conversion loss exceeds cap');
  if(imbalance(nextCash,nextTokens,ratio)<=25n){
   const limits=quoted.map(v=>buying?v*1002n/1000n+1n:v*998n/1000n) as [bigint,bigint,bigint,bigint];
   const budget=buying?limits.reduce((a,b)=>a+b,stablePart):0n;if(budget>cash)throw Error('Budget exceeds inventory');
   return{args:[budget,shares,limits,deadline] as const,cash,tokens,value,operation:buying?'MINT_EXCESS_USDT':'REDEEM_EXCESS_TYW'};
  }
  const error=nextCash*SCALE-nextTokens*ratio;
  const correction=error/(ratio+stableChange*SCALE/shares);
  shares=buying?shares+correction:shares-correction;
 }
 throw Error('Could not balance inventory');
}
