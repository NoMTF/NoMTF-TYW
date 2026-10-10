import {parseUnits} from 'viem';
export type LiquidityCostEnv={LIQUIDITY_MIN_VALUE_USDT?:string;LIQUIDITY_MAX_GAS_BPS?:string};
const SCALE=10n**18n;
export function liquidityCostPolicy(env:LiquidityCostEnv){
 const value=env.LIQUIDITY_MIN_VALUE_USDT??'20',bps=env.LIQUIDITY_MAX_GAS_BPS??'50';
 if(!/^[0-9]{1,4}(?:\.[0-9]{1,18})?$/.test(value)||!/^[1-9][0-9]{0,2}$/.test(bps))throw Error('Invalid liquidity cost policy');
 const minimumValue=parseUnits(value,18),maximumGasBps=BigInt(bps);
 if(minimumValue<parseUnits('1.1',18)||minimumValue>parseUnits('1900',18)||maximumGasBps>100n)throw Error('Unsafe liquidity cost policy');
 return{minimumValue,maximumGasBps};
}
export function liquidityGasCost(value:bigint,gasLimit:bigint,gasPrice:bigint,bnbUsdt:bigint,maximumBps:bigint){
 if(value<=0n||gasLimit<=0n||gasPrice<=0n||bnbUsdt<=0n||maximumBps<1n||maximumBps>100n)throw Error('Invalid liquidity gas valuation');
 // Round up: a fraction of a wei must not turn an over-budget transaction into an allowed one.
 const cost=(gasLimit*gasPrice*bnbUsdt+SCALE-1n)/SCALE;
 return{cost,allowed:cost*10000n<=value*maximumBps};
}
