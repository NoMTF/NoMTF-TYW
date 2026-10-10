/** Keep connected-wallet fee previews and the submitted transaction on the same gas-price source. */
export function withWalletGasPrice<T extends {gasPriceWei:string}>(quote:T,gasPrice:bigint|null):T{
 if(gasPrice===null||gasPrice<=0n||gasPrice>=(1n<<256n))throw Error('钱包暂未返回有效网络费，请稍后重新预估。');
 return {...quote,gasPriceWei:String(gasPrice)};
}
