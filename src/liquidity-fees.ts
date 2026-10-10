import {parseAbi,keccak256,encodeFunctionData,type Address,type Hash} from 'viem';
import {chainClient} from './chain.ts';
import {PERMANENT_ABI} from './permanent-chain.ts';
import {USDT} from './permanent-assets.ts';

export const LP_POSITIONS='0x55f4c8abA71A1e923edC303eb4fEfF14608cC226' as Address;
export const LP_TREASURY='0x9979ba992c6aaf7cdd068a82d14f7afa6c7f4cd1' as Address;
const VAULT='0xaE7eA21fBf3613fFc17fe962EE66bfe03015fBa7' as Address;
const ABI=parseAbi(['function treasury() view returns(address)','function positions() view returns(address)','function collect(uint256[] ids) returns(uint256 cash,uint256 tokens)']);
const TOKEN_ABI=parseAbi(['function balanceOf(address) view returns(uint256)']);
const NFT_ABI=parseAbi(['function ownerOf(uint256) view returns(address)']);
const TRANSFER=keccak256(new TextEncoder().encode('Transfer(address,address,uint256)'));
const ZERO='0x'+'0'.repeat(64),TREASURY_TOPIC='0x'+LP_TREASURY.slice(2).padStart(64,'0');
export type FeeEnv={LIQUIDITY_FEE_COLLECTOR?:string;LIQUIDITY_FEE_COLLECTOR_CODE_HASH?:string;LIQUIDITY_POSITION_IDS?:string};

export function positionIds(config:string|undefined,learned:string[]=[]):bigint[]{
 const input=[...(config?config.split(','):[]),...learned];
 if(input.length>512||input.some(id=>!/^\d{1,20}$/.test(id)||BigInt(id)<=0n))throw Error('Invalid LP positions');
 const ids=[...new Set(input.map(BigInt))].sort((a,b)=>a<b?-1:a>b?1:0);
 if(ids.length>256)throw Error('LP position tracking limit');return ids;
}
export function mintedPositionIds(logs:{address:Address;topics:readonly Hash[]}[]):string[]{
 return logs.filter(l=>l.address.toLowerCase()===LP_POSITIONS.toLowerCase()&&l.topics.length===4&&l.topics[0]===TRANSFER&&l.topics[1]===ZERO&&l.topics[2]?.toLowerCase()===TREASURY_TOPIC)
  .map(l=>String(BigInt(l.topics[3]!)));
}
export function feeHarvestWorthwhile(feeValue:bigint,inventoryValue:bigint,minimumValue:bigint){
 return feeValue>0n&&inventoryValue>=0n&&feeValue+inventoryValue>=minimumValue;
}
export async function feeCollectionPlan(rpc:string,env:FeeEnv,learned:string[],cursor:number,minimumValue:bigint){
 if(!env.LIQUIDITY_FEE_COLLECTOR)return null;
 if(!/^0x[0-9a-f]{40}$/i.test(env.LIQUIDITY_FEE_COLLECTOR)||!/^0x[0-9a-f]{64}$/i.test(env.LIQUIDITY_FEE_COLLECTOR_CODE_HASH||''))throw Error('Invalid fee collector');
 const client=chainClient(rpc),address=env.LIQUIDITY_FEE_COLLECTOR as Address;
 const code=await client.getCode({address});if(!code||keccak256(code)!==env.LIQUIDITY_FEE_COLLECTOR_CODE_HASH)throw Error('Fee collector code mismatch');
 const [treasury,positions]=await Promise.all([client.readContract({address,abi:ABI,functionName:'treasury'}),client.readContract({address,abi:ABI,functionName:'positions'})]);
 if(treasury.toLowerCase()!==LP_TREASURY||positions.toLowerCase()!==LP_POSITIONS.toLowerCase())throw Error('Fee collector recipient mismatch');
 const ids=positionIds(env.LIQUIDITY_POSITION_IDS,learned);if(!ids.length)return null;
 const start=Number.isSafeInteger(cursor)&&cursor>=0&&cursor<ids.length?cursor:0,batch=ids.slice(start,start+32),nextCursor=start+32>=ids.length?0:start+32;
 const ownership=await Promise.allSettled(batch.map(id=>client.readContract({address:LP_POSITIONS,abi:NFT_ABI,functionName:'ownerOf',args:[id]})));
 const owned=batch.filter((_,i)=>ownership[i].status==='fulfilled'&&ownership[i].value.toLowerCase()===LP_TREASURY);
 if(!owned.length)return {waiting:true as const,nextCursor};
 const blockNumber=await client.getBlockNumber();
 const [{result:[cash,tokens]},[heldCash,heldTokens],[,nav]]=await Promise.all([
  client.simulateContract({address,abi:ABI,functionName:'collect',args:[owned],blockNumber}),
  Promise.all([client.readContract({address:USDT,abi:TOKEN_ABI,functionName:'balanceOf',args:[LP_TREASURY],blockNumber}),client.readContract({address:VAULT,abi:TOKEN_ABI,functionName:'balanceOf',args:[LP_TREASURY],blockNumber})]),
  client.readContract({address:VAULT,abi:PERMANENT_ABI,functionName:'valuation',blockNumber})]);
 const value=cash+tokens*nav/10n**18n,inventoryValue=heldCash+heldTokens*nav/10n**18n;
 if(!feeHarvestWorthwhile(value,inventoryValue,minimumValue))return {waiting:true as const,nextCursor};
 return{waiting:false as const,to:address,data:encodeFunctionData({abi:ABI,functionName:'collect',args:[owned]}),cash,tokens,value,inventoryValue,nextCursor,ids:owned.map(String)};
}
