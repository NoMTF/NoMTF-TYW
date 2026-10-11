// EIP-712 layout of GasRelay.TradeRequest, shared by the page (signing) and the Worker (checking).
import {encodeAbiParameters,keccak256,type Address} from 'viem';
// The published GasRelay on BSC (deployments/bsc-gas-relay.json, Sourcify exact match). The page refuses to approve or
// sign for any other relay address, or if the code at this address ever differs.
export const RELAY_ADDRESS='0x44D13A0E6a4534540dE627b220d60562e534EC48';
export const RELAY_RUNTIME_HASH='0x89200739d5b8f0c177aea27f0858bf04549e02b43a3a2791303de6a57c536ab8';
export const RELAY_TYPES={TradeRequest:[
 {name:'owner',type:'address'},{name:'executor',type:'address'},{name:'mode',type:'uint8'},{name:'feeAsset',type:'uint8'},
 {name:'budget',type:'uint256'},{name:'shares',type:'uint256'},{name:'limitsHash',type:'bytes32'},{name:'minNetStable',type:'uint256'},
 {name:'fee',type:'uint256'},{name:'nonce',type:'uint256'},{name:'deadline',type:'uint256'}]} as const;
export const relayDomain=(relay:Address)=>({name:'NoMTF Gas Relay',version:'1',chainId:56,verifyingContract:relay} as const);
export type RelayRequest={owner:Address;executor:Address;mode:0|1;feeAsset:0;budget:bigint;shares:bigint;limits:readonly [bigint,bigint,bigint,bigint];minNetStable:bigint;fee:bigint;nonce:bigint;deadline:bigint};
// The contract hashes limits as keccak256(abi.encode(uint256[4])).
export const relayLimitsHash=(limits:readonly [bigint,bigint,bigint,bigint])=>keccak256(encodeAbiParameters([{type:'uint256[4]'}],[limits]));
export const relayMessage=(r:RelayRequest)=>({owner:r.owner,executor:r.executor,mode:r.mode,feeAsset:r.feeAsset,budget:r.budget,shares:r.shares,limitsHash:relayLimitsHash(r.limits),minNetStable:r.minNetStable,fee:r.fee,nonce:r.nonce,deadline:r.deadline});
export const relayWire=(r:RelayRequest)=>({...r,budget:String(r.budget),shares:String(r.shares),limits:r.limits.map(String),minNetStable:String(r.minNetStable),fee:String(r.fee),nonce:String(r.nonce),deadline:String(r.deadline)});
