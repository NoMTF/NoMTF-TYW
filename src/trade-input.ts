import {parseUnits} from 'viem';
export const MIN_TRADE=10n**17n;
export function parseTradeInput(params:URLSearchParams,maximum=1000):{raw:string;amount:bigint;mode:'buy'|'sell'}{
 const raw=params.get('amount')??'1',mode=params.get('mode')??'buy';
 if(!/^\d{1,4}(\.\d{1,18})?$/.test(raw)||(mode!=='buy'&&mode!=='sell'))throw Error('金额或方向无效');
 const amount=parseUnits(raw,18);
 if(amount<MIN_TRADE||amount>BigInt(maximum)*10n**18n)throw Error(`报价范围为 0.1–${maximum}`);
 return{raw,amount,mode};
}
