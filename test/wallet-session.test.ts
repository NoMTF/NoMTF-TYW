import {test} from 'node:test';import assert from 'node:assert/strict';
import {assertWalletSession} from '../src/wallet-session.ts';
const account='0x9979Ba992c6aAf7cDd068A82d14F7Afa6c7f4cD1';
const wallet=(chain='0x38',accounts:unknown=[account])=>({request:async({method}:{method:string})=>method==='eth_chainId'?chain:accounts});
test('signature preflight checks actual wallet network and account without signing or switching',async()=>{const calls:string[]=[];await assertWalletSession({request:async({method})=>{calls.push(method);return wallet().request({method});}},account,()=>true);assert.deepEqual(calls.sort(),['eth_accounts','eth_chainId']);});
test('silent account/network changes and malformed provider responses fail closed',async()=>{for(const provider of [wallet('0x1'),wallet('0x38',[]),wallet('0x38',['0x'+'1'.repeat(40)]),wallet('not-a-chain'),wallet('0x38',[{}])])await assert.rejects(assertWalletSession(provider,account,()=>true));});
test('session changes during asynchronous wallet reads abort the eventual financial request',async()=>{let current=true;const provider={request:async({method}:{method:string})=>{await Promise.resolve();current=false;return wallet().request({method});}};await assert.rejects(assertWalletSession(provider,account,()=>current));});
