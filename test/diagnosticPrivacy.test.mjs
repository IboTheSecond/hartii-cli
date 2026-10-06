import {test} from 'vitest';
import assert from 'node:assert/strict';
import { main } from '../src/cli.js';
import { redactUrls } from '../src/output.js';
test('unknown-command errors do not echo a raw secret-shaped argument',async()=>{
 const secret='0x'+'1'.repeat(64);let output='';
 const code=await main([secret,'--json'],{writeErr:text=>{output+=text;},write:()=>{}});
 assert.equal(code,1);assert.ok(!output.includes(secret));
});
test('opaque encoded RPC credentials and URL user info stay redacted',()=>{
 const secret='A'.repeat(32);const encoded='%41'.repeat(32);
 const output=redactUrls(`https://user:${secret}@rpc.example/v3/${encoded}?key=${secret}`);
 assert.ok(!output.includes(secret));assert.ok(!output.includes(encoded));assert.ok(!output.includes('user:'));
});
