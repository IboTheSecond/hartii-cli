import {test} from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReceive } from '../src/commands/receive.js';
const address='0x0011111111111111111111111111111111111111';
function fixture(){const home=mkdtempSync(join(tmpdir(),'hartii-receive-proof-'));mkdirSync(join(home,'keystore'));writeFileSync(join(home,'keystore','main.json'),JSON.stringify({address:address.slice(2)}),{mode:0o600});writeFileSync(join(home,'config.json'),JSON.stringify({network:'mainnet',currentWallet:'main',limits:{perTxQuai:'100',dailyQuai:'500'}}));return home;}
test('receive uses only public metadata and exact QUAI amount in HPAY link',async()=>{
 const oldFetch=globalThis.fetch;globalThis.fetch=()=>{throw Error('receive must stay offline');};
 try{const result=await runReceive({home:fixture(),amount:'1.000000000000000001',memo:'Coffee'});assert.equal(result.address.toLowerCase(),address);assert.equal(result.readOnly,true);assert.equal(new URL(result.paylink).searchParams.get('amt'),'1000000000000000001');assert.equal(result.qr.payload,result.paylink);assert.ok(result.qr.matrix.length>20);}
 finally{globalThis.fetch=oldFetch;}
});
test('raw address QR retains the exact selected public receive address',async()=>{const result=await runReceive({home:fixture(),addressQr:true});assert.equal(result.qr.payload,result.address);});
test('Orchard cannot silently produce a mainnet HPAY request',async()=>{await assert.rejects(runReceive({home:fixture(),network:'orchard'}),/mainnet|Orchard/i);});
test('receive amount rejects exponent and excess decimals',async()=>{for(const amount of ['1e3','0','-1','0.0000000000000000001'])await assert.rejects(runReceive({home:fixture(),amount}),/amount|decimal|positive/i);});
