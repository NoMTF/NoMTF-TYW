import type {Injected} from './wallet-providers.ts';
export async function assertWalletSession(wallet:Injected,account:string,isCurrent:()=>boolean){
 if(!isCurrent())throw Error('钱包已变化，请重新连接');
 const [chain,accounts]=await Promise.all([wallet.request({method:'eth_chainId'}),wallet.request({method:'eth_accounts'})]);
 if(!isCurrent()||typeof chain!=='string'||!/^0x[0-9a-f]{1,16}$/i.test(chain)||BigInt(chain)!==56n||!Array.isArray(accounts)||typeof accounts[0]!=='string'||accounts[0].toLowerCase()!==account.toLowerCase())throw Error('钱包账号或网络已变化，请重新连接');
}
