import type {Discovered} from './wallet-providers.ts';
import type {WalletKind} from './wallet-links.ts';
import type {Wallet} from '@reown/appkit-wallet-button';
export type WalletEntry={id:string;name:string;website:string;deepLink?:WalletKind;connectId?:Wallet;aliases:string[]};
export const WALLET_CATALOG:WalletEntry[]=[
 {id:'okx',name:'OKX Wallet',website:'https://web3.okx.com/download',deepLink:'okxwallet',aliases:['okx']},
 {id:'metamask',name:'MetaMask',website:'https://metamask.io/download/',deepLink:'metamask',aliases:['metamask']},
 {id:'trust',name:'Trust Wallet',website:'https://trustwallet.com/download',deepLink:'trust',aliases:['trust']},
 {id:'bitget',name:'Bitget Wallet',website:'https://web3.bitget.com/',deepLink:'bitget',aliases:['bitget','bitkeep']},
 {id:'tokenpocket',name:'TokenPocket',website:'https://www.tokenpocket.pro/',deepLink:'tokenpocket',aliases:['tokenpocket']},
 {id:'binance',name:'Binance Wallet',website:'https://www.binance.com/en/web3wallet',connectId:'binance',aliases:['binance']},
 {id:'imtoken',name:'imToken',website:'https://token.im/',deepLink:'imtoken',aliases:['imtoken']},
 {id:'math',name:'MathWallet',website:'https://mathwallet.org/',deepLink:'math',aliases:['mathwallet']},
 {id:'onekey',name:'OneKey',website:'https://onekey.so/download/',aliases:['onekey']},
 {id:'rabby',name:'Rabby Wallet',website:'https://rabby.io/',aliases:['rabby']},
 {id:'safepal',name:'SafePal',website:'https://www.safepal.com/download',connectId:'safepal',aliases:['safepal']},
 {id:'coinbase',name:'Coinbase Wallet',website:'https://www.coinbase.com/wallet',connectId:'coinbase',aliases:['coinbase']},
 {id:'brave',name:'Brave Wallet',website:'https://brave.com/wallet/',connectId:'brave',aliases:['brave']},
 {id:'exodus',name:'Exodus',website:'https://www.exodus.com/',connectId:'exodus',aliases:['exodus']},
 {id:'ledger',name:'Ledger Live',website:'https://www.ledger.com/ledger-live',connectId:'ledger',aliases:['ledger']},
 {id:'coin98',name:'Coin98',website:'https://coin98.com/',connectId:'coin98',aliases:['coin98']},
 {id:'zerion',name:'Zerion',website:'https://zerion.io/',connectId:'zerion',aliases:['zerion']},
 {id:'oneinch',name:'1inch Wallet',website:'https://1inch.com/wallet/',connectId:'oneinch',aliases:['1inch','oneinch']},
 {id:'crypto-com',name:'Crypto.com Onchain',website:'https://crypto.com/onchain',connectId:'crypto-com',aliases:['crypto.com']},
 {id:'safe',name:'Safe',website:'https://safe.global/',connectId:'safe',aliases:['safe.global']},
];
// Reown handles each wallet's current mobile links and desktop QR; no guessed app URLs.
for(const entry of WALLET_CATALOG)if(!entry.connectId&&['okx','metamask','trust','bitget','tokenpocket','imtoken'].includes(entry.id))entry.connectId=entry.id as Wallet;
export function catalogProvider(entry:WalletEntry,choices:Discovered[]){return choices.find(d=>d.info.uuid===entry.id||entry.aliases.some(a=>(d.info.name+' '+d.info.rdns).toLowerCase().includes(a)));}
