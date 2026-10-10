import { ASSETS } from './assets.ts';
export const USD_UNIT = 10n ** 18n;
export type PortfolioPrice = { usdPerToken: bigint; observedAt: number; trusted: boolean };
export function portfolioValues(balances: readonly bigint[], prices: readonly PortfolioPrice[], now: number, maxAge = 120) {
  if (balances.length !== 3 || prices.length !== 3) throw new Error('需要完整的三资产数据');
  if (prices.some(p => p.usdPerToken <= 0n || !p.trusted || p.observedAt > now + 5 || now - p.observedAt > maxAge)) throw new Error('价格不可用于调仓');
  return balances.map((b, i) => { if (b < 0n) throw new Error('余额异常'); return b * prices[i].usdPerToken / (10n ** BigInt(ASSETS[i].decimals)); });
}
export function weights(values: readonly bigint[]) {
  const total = values.reduce((a,b)=>a+b, 0n);
  return values.map(v=>total === 0n ? 0n : v * 10000n / total);
}
export function breached(values: readonly bigint[]) {
  if (values.length !== 3 || values.some(v=>v < 0n)) throw new Error('持仓数据异常');
  const total = values.reduce((a,b)=>a+b,0n);
  if (total === 0n) return false;
  return values.some((v,i)=>v * 10000n <= total * BigInt(ASSETS[i].lowerBps) || v * 10000n >= total * BigInt(ASSETS[i].upperBps));
}
export function targetTrades(values: readonly bigint[], prices: readonly bigint[]) {
  const total = values.reduce((a,b)=>a+b,0n);
  return values.map((value,i)=>{
    if (prices[i] <= 0n) throw new Error('价格异常');
    const target = total * BigInt(ASSETS[i].targetBps) / 10000n;
    const delta = target - value;
    return { symbol:ASSETS[i].symbol, side:delta >= 0n ? 'buy' : 'sell', amountRaw:(delta < 0n ? -delta : delta) * 10n ** BigInt(ASSETS[i].decimals) / prices[i], deltaUsd:delta };
  });
}
export function decimalRaw(value: string, decimals: number) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) throw new Error('请输入有效金额');
  const [whole,frac='']=value.split('.');
  if (frac.length > decimals) throw new Error('金额精度超限');
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals,'0') || '0');
}
export function formatRaw(value: bigint, decimals = 18, digits = 6) {
  const negative = value < 0n; if(negative)value=-value;
  const u=10n**BigInt(decimals), frac=(value % u).toString().padStart(decimals,'0').slice(0,digits).replace(/0+$/,'');
  return `${negative?'-':''}${value/u}${frac?'.'+frac:''}`;
}
export function costBudget(principalUsd: bigint, entryUsd: bigint, exitUsd: bigint, allocatedRebalanceUsd: bigint, gasUsd: bigint, targetBps = 100) {
  const cost=entryUsd+exitUsd+allocatedRebalanceUsd+gasUsd;
  return { cost, budget:principalUsd*BigInt(targetBps)/10000n, withinBudget:cost <= principalUsd*BigInt(targetBps)/10000n };
}
export const ORDER_STATES = ['QUEUED','WAITING_QUOTE','READY','SUBMITTED','CONFIRMED','CANCELLED','EXPIRED','FAILED'] as const;
export type OrderState = typeof ORDER_STATES[number];
const allowed: Record<OrderState, readonly OrderState[]> = {
  QUEUED:['WAITING_QUOTE','READY','CANCELLED','EXPIRED'], WAITING_QUOTE:['READY','CANCELLED','EXPIRED'],
  READY:['WAITING_QUOTE','SUBMITTED','CANCELLED','EXPIRED'], SUBMITTED:['CONFIRMED','FAILED'],
  CONFIRMED:[], CANCELLED:[], EXPIRED:[], FAILED:['WAITING_QUOTE','CANCELLED','EXPIRED'],
};
export function transition(from:OrderState,to:OrderState){if(!allowed[from].includes(to))throw new Error(`无效订单状态：${from} → ${to}`);return to;}
