import { test } from 'vitest';
import assert from 'node:assert/strict';
import { runTx } from '../src/commands/tx.js';
import { mkdtempSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const hash='0x'+'1'.repeat(64);
for(const status of [null,false,true,'',2,undefined])test(`read-only transaction status never finalizes ${String(status)}`,async()=>{
 const home=mkdtempSync(join(tmpdir(),'hartii-status-proof-'));
 const provider={getTransaction:async()=>({hash,from:'0x0011111111111111111111111111111111111111',to:'0x0022222222222222222222222222222222222222',value:1n}),getTransactionReceipt:async()=>({hash,status})};
 const result=await runTx({hash,home},{providerFactory:()=>provider});assert.equal(result.status,'unknown');
});
test('pending view is read-only and shows a legacy reservation without a wallet or provider',async()=>{
 const home=mkdtempSync(join(tmpdir(),'hartii-pending-proof-'));
 const address='0x0011111111111111111111111111111111111111';
 writeFileSync(join(home,'spend.json'),JSON.stringify({[address]:{date:'2026-10-06',spentWei:'0',reservations:{pending:{amountWei:'100',date:'2026-10-06',txHash:null}}}}));
 let providerCalls=0;const result=await runTx({hash:'pending',home},{providerFactory:()=>{providerCalls++;throw Error('must not use provider');}});
 assert.equal(providerCalls,0);assert.equal(result.pending.length,1);assert.equal(result.pending[0].legacy,true);assert.equal(result.readOnly,true);
});
