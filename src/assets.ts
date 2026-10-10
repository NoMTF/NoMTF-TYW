export const CHAIN_ID = 56;
export const ASSETS = [
  { symbol: 'SPYB', address: '0x7138b48df7d98d7e3cc221bfe7192d0a178182d8', decimals: 18, targetBps: 2500, lowerBps: 1500, upperBps: 3500, source: 'https://www.binance.com/en-NZ/support/announcement/detail/6a55706a042c4a7ebedc2a0899744088' },
  { symbol: 'IEFon', address: '0xa486a0a05250e8621ba3b26c3bbc517145eba619', decimals: 18, targetBps: 5000, lowerBps: 3000, upperBps: 7000, source: 'https://app.ondo.finance/assets/iefon' },
  { symbol: 'XAUt', address: '0x21caef8a43163eea865baee23b9c2e327696a3bf', decimals: 6, targetBps: 2500, lowerBps: 1500, upperBps: 3500, source: 'https://tether.to/en/supported-protocols/' },
] as const;
export const STABLES = {
  USDT: { address: '0x55d398326f99059ff775485246999027b3197955', decimals: 18, note: 'Binance-Peg BSC representation' },
  USDC: { address: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', decimals: 18, note: 'Binance-Peg BSC representation' },
} as const;
export const PANCAKE = {
  factory: '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865',
  quoter: '0xb048bbc1ee6b733fffcfb9e9cef7375518e25997',
  router: '0x13f4ea83d0bd40e75c8222255bc855a974568dd4',
  xBase: 'https://x.pancakeswap.com',
} as const;
