import {createPublicClient,http,parseAbi}from'viem';
import {bsc}from'viem/chains';
export const VAULT_ABI=parseAbi([
 'function initialized() view returns(bool)','function paused() view returns(bool)',
 'function owner() view returns(address)','function executor() view returns(address)','function priceSigner() view returns(address)',
 'function adapter() view returns(address)','function totalSupply() view returns(uint256)','function pendingStable() view returns(uint256)',
 'function balanceOf(address) view returns(uint256)','function rebalanceNonce() view returns(uint256)',
 'function cumulativeRebalanceCostUsd() view returns(uint256)','function cumulativeRebalanceGasUsd() view returns(uint256)',
 'function requests(uint256) view returns(address user,uint256 amount,uint256 minimum,uint64 deadline,bool redeem,uint8 status)',
 'function requestDeposit(uint256 amount,uint256 minimumShares,uint64 deadline) returns(uint256)',
 'function requestRedeem(uint256 shares,uint256 minimumStable,uint64 deadline) returns(uint256)',
 'function cancelRequest(uint256 id)',
 'function requestDepositUsdc(uint256 amount,uint256 minimumStable,uint256 minimumShares,uint64 deadline) returns(uint256)',
 'function requestRedeemUsdc(uint256 shares,uint256 minimumUsdc,uint64 deadline) returns(uint256)',
 'function paysUsdc(uint256 id) view returns(bool)',
 'function nextRequestId() view returns(uint256)',
 'function stableConverter() view returns(address)',
 'function priceNonce() view returns(uint256)',
 'function netAssetValue((uint256 p0,uint256 p1,uint256 p2,uint256 validUntil,uint256 nonce) p,bytes signature) view returns(uint256 totalUsd,uint256 perShareUsd,uint256[3] weightsBps)',
 'event Requested(uint256 indexed id,address indexed user,bool redeem,uint256 amount,uint256 minimum,uint64 deadline)',
 'event Settled(uint256 indexed id,uint256 received,uint256 refund)',
 'event Cancelled(uint256 indexed id)',
]);
export const TOKEN_ABI=parseAbi(['function balanceOf(address) view returns(uint256)','function allowance(address,address) view returns(uint256)','function approve(address,uint256) returns(bool)','function decimals() view returns(uint8)']);
export function chainClient(rpc:string){return createPublicClient({chain:bsc,transport:http(rpc,{timeout:/^http:\/\/(127\.0\.0\.1|localhost):/.test(rpc)?120000:15000,retryCount:1})});}
