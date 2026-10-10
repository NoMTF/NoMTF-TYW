import type {Discovered} from './wallet-providers.ts';
import type {WalletKind} from './wallet-links.ts';
export type WalletEntry={id:string;name:string;website:string;deepLink?:WalletKind;aliases:string[]};
export const WALLET_CATALOG:WalletEntry[]=[
 {id:'okx',name:'OKX Wallet',website:'https://web3.okx.com/download',deepLink:'okxwallet',aliases:['okx']},
 {id:'metamask',name:'MetaMask',website:'https://metamask.io/download/',deepLink:'metamask',aliases:['metamask']},
 {id:'trust',name:'Trust Wallet',website:'https://trustwallet.com/download',deepLink:'trust',aliases:['trust']},
 {id:'bitget',name:'Bitget Wallet',website:'https://web3.bitget.com/',deepLink:'bitget',aliases:['bitget','bitkeep']},
 {id:'tokenpocket',name:'TokenPocket',website:'https://www.tokenpocket.pro/',deepLink:'tokenpocket',aliases:['tokenpocket']},
 {id:'binance',name:'Binance Wallet',website:'https://www.binance.com/en/web3wallet',aliases:['binance']},
 {id:'imtoken',name:'imToken',website:'https://token.im/',deepLink:'imtoken',aliases:['imtoken']},
 {id:'math',name:'MathWallet',website:'https://mathwallet.org/',deepLink:'math',aliases:['mathwallet']},
 {id:'onekey',name:'OneKey',website:'https://onekey.so/download/',aliases:['onekey']},
 {id:'rabby',name:'Rabby Wallet',website:'https://rabby.io/',aliases:['rabby']},
 {id:'safepal',name:'SafePal',website:'https://www.safepal.com/download',aliases:['safepal']},
 {id:'coinbase',name:'Coinbase Wallet',website:'https://www.coinbase.com/wallet',aliases:['coinbase']},
 {id:'brave',name:'Brave Wallet',website:'https://brave.com/wallet/',aliases:['brave']},
];
export function catalogProvider(entry:WalletEntry,choices:Discovered[]){return choices.find(d=>d.info.uuid===entry.id||entry.aliases.some(a=>(d.info.name+' '+d.info.rdns).toLowerCase().includes(a)));}
