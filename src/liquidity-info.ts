import {parseAbi,formatEther,type Address} from 'viem';import {chainClient} from './chain.ts';import type {LiquidityEnv} from './liquidity-keeper.ts';
import {AUTO_ABI} from './liquidity-plan.ts';
const ABI=parseAbi(['function poolId() view returns(bytes32)','function manager() view returns(address)','function treasury() view returns(address)','function enabled() view returns(bool)','function preview() view returns(uint128 liquidity,uint128 usdt,uint128 tokens,int24 lower,int24 upper)']);
const MANAGER=parseAbi(['function getSlot0(bytes32) view returns(uint160,int24,uint24,uint24)','function getLiquidity(bytes32) view returns(uint128)']);
export async function liquidityInfo(env:LiquidityEnv){
 if(!/^0x[0-9a-f]{40}$/i.test(env.LIQUIDITY_CONTROLLER||''))return{created:false,directPlatformFeeBps:0};
 const address=env.LIQUIDITY_CONTROLLER as Address,client=chainClient(env.RPC_URL),blockNumber=await client.getBlockNumber();
 const [poolId,manager,treasury,enabled]=await Promise.all([
  client.readContract({address,abi:ABI,functionName:'poolId',blockNumber}),client.readContract({address,abi:ABI,functionName:'manager',blockNumber}),
  client.readContract({address,abi:ABI,functionName:'treasury',blockNumber}),client.readContract({address,abi:ABI,functionName:'enabled',blockNumber})]);
 const [slot,liquidity]=await Promise.all([client.readContract({address:manager as Address,abi:MANAGER,functionName:'getSlot0',args:[poolId as `0x${string}`],blockNumber}),client.readContract({address:manager as Address,abi:MANAGER,functionName:'getLiquidity',args:[poolId as `0x${string}`],blockNumber})]);
 const sqrt=slot[0],navPrice=sqrt?((1n<<192n)*10n**18n/(sqrt*sqrt)):0n;
 let nextAddition=null;try{
  if(env.LIQUIDITY_MODE==='auto'){const v=await client.readContract({address,abi:AUTO_ABI,functionName:'inventory',blockNumber});nextAddition={usdt:formatEther(v[0]),tyw:formatEther(v[1]),nav:formatEther(v[2]),requiredUsdtPerTyw:formatEther(v[3])};}
  else{const v=await client.readContract({address,abi:ABI,functionName:'preview',blockNumber});nextAddition={usdt:formatEther(v[1]),tyw:formatEther(v[2])};}
 }catch{}
 return{at:Date.now(),blockNumber:String(blockNumber),created:sqrt>0n,poolId,controller:address,manager,treasury,enabled,
  poolUrl:'https://pancakeswap.finance/liquidity/pool/bsc/'+poolId,spotUsdtPerTyw:formatEther(navPrice),activeLiquidity:String(liquidity),protocolFee:Number(slot[2]),nextAddition,
  directPlatformFeeBps:0,buyLpFeePpm:47619,sellLpFeePpm:50000,buyMarkupApproxPercent:5,sellDiscountPercent:5,
  externalRoutingConfirmed:false,additionIntervalMinutes:5,unmatchedInventory:env.LIQUIDITY_MODE==='auto'?'excess is minted/redeemed through the original vault, then both sides enter LP; tiny/expensive deposits remain in treasury': 'waits for matching inventory',conversionLossCapBps:env.LIQUIDITY_MODE==='auto'?50:null,lpRecipient:treasury};
}
