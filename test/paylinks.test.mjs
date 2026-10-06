import {test} from 'vitest';
import assert from 'node:assert/strict';
import {buildReceiveLink,parseNativePaylink} from '../src/paylinks.js';
test('generated links target the established payer page and reject out-of-range amounts',()=>{
 const url=buildReceiveLink({address,amount:'1'});assert.equal(new URL(url).pathname,'/pay.html');
 assert.throws(()=>buildReceiveLink({address,amount:'9'.repeat(62)}),/uint256/);
});
const address='0x0011111111111111111111111111111111111111';
test('HPAY request round-trips exact amount and Unicode memo',()=>{
 const url=buildReceiveLink({address,amount:'0.000000000000000001',memo:'Coffee ☕'});const value=parseNativePaylink(url);assert.equal(value.amountWei,1n);assert.equal(value.to.toLowerCase(),address);assert.equal(value.memo,'Coffee ☕');
});
test('untrusted origins, duplicates, wrong chain and stale requests fail closed',()=>{
 const good=buildReceiveLink({address,amount:'2'});
 for(const bad of [good.replace('hartiibiome.com','untrusted.example'),good+'&to='+address,good.replace('chain=9','chain=15000'),good+'&exp=1',good.replace('https://','http://')])assert.throws(()=>parseNativePaylink(bad));
});
