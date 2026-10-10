import {parseAbi,encodeFunctionData,formatUnits,type Address} from 'viem';
import {chainClient} from './chain.ts';
import {PERMANENT_QUOTER_ABI} from './permanent-chain.ts';
import {PANCAKE} from './assets.ts';
import {USDT,WBNB} from './permanent-assets.ts';
export const NATIVE_TEST_ROUTER_ABI=parseAbi([
 'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) p) payable returns(uint256 amountOut)',
 'function refundETH() payable',
 'function multicall(uint256 deadline,bytes[] data) payable returns(bytes[] results)',
]);
// Builds an unsigned wallet transaction. It cannot sign or broadcast anything.
export async function nativeTestQuote(rpc:string,recipient:Address,amount:bigint){
  if(amount<10n**14n||amount>25n*10n**14n)throw new Error('测试兑换范围 0.0001–0.0025 BNB');
  const client=chainClient(rpc),blockNumber=await client.getBlockNumber();
  const q=await client.simulateContract({address:PANCAKE.quoter,abi:PERMANENT_QUOTER_ABI,functionName:'quoteExactInputSingle',args:[{tokenIn:WBNB,tokenOut:USDT,amountIn:amount,fee:500,sqrtPriceLimitX96:0n}],blockNumber});
  const minimum=q.result[0]*995n/1000n,deadline=BigInt(Math.floor(Date.now()/1000)+600);
  const swap={tokenIn:WBNB,tokenOut:USDT,fee:500,recipient,amountIn:amount,amountOutMinimum:minimum,sqrtPriceLimitX96:0n};
  const calls=[encodeFunctionData({abi:NATIVE_TEST_ROUTER_ABI,functionName:'exactInputSingle',args:[swap]}),encodeFunctionData({abi:NATIVE_TEST_ROUTER_ABI,functionName:'refundETH'})];
  const data=encodeFunctionData({abi:NATIVE_TEST_ROUTER_ABI,functionName:'multicall',args:[deadline,calls]});
  // eth_call checks the native-token payment path with this recipient. It changes no BSC state.
  await client.simulateContract({address:PANCAKE.router,abi:NATIVE_TEST_ROUTER_ABI,functionName:'multicall',args:[deadline,calls],account:recipient,value:amount});
  return {chainId:56,to:PANCAKE.router,data,value:String(amount),recipient,expectedUsdt:formatUnits(q.result[0],18),minimumUsdt:formatUnits(minimum,18),deadline:String(deadline),expiresAt:Date.now()+45000,blockNumber:String(blockNumber),simulatedOnly:true,submitted:false};
}
