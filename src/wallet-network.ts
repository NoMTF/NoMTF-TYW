import type {Injected} from './wallet-providers.ts';
export async function ensureBsc(p:Injected){
 const chain=()=>p.request({method:'eth_chainId'});
 if(BigInt(await chain())===56n)return;
 try{await p.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x38'}]});}
 catch(e:any){
  if(e?.code===4001)throw e;
  if(e?.code!==4902&&e?.data?.originalError?.code!==4902)throw Error('请在钱包中手动切换到 BNB Chain 后重新连接。');
  await p.request({method:'wallet_addEthereumChain',params:[{chainId:'0x38',chainName:'BNB Smart Chain',nativeCurrency:{name:'BNB',symbol:'BNB',decimals:18},rpcUrls:['https://bsc-dataseed.bnbchain.org'],blockExplorerUrls:['https://bscscan.com']}]});
  if(BigInt(await chain())!==56n)await p.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x38'}]});
 }
 if(BigInt(await chain())!==56n)throw Error('钱包尚未切换到 BNB Chain。');
}
