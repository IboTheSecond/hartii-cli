import { beforeAll, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuaiTransaction, Wallet } from 'quais';
import { generateMnemonicAccount } from '../src/keystore.js';
import { writeRuntime } from '../src/commandContext.js';
let account;
beforeAll(() => { account = generateMnemonicAccount(); }, 120000);
function fixture(hook) {
  const provider = { getNetwork: vi.fn(async()=>({chainId:9n})), getTransactionCount: vi.fn(async()=>0),
    broadcastTransaction: vi.fn(async (_zone,raw)=>({ hash:QuaiTransaction.from(raw).hash })) };
  const deps={env:{SYNTHETIC:account.privateKey},fetchFn:async()=>({json:async()=>({result:'0x9'})}),providerFactory:()=>provider,
    walletFactory:key=>new Wallet(key),io:{writeErr:()=>{},onSignedTransaction:hook}};
  const opts={home:mkdtempSync(join(tmpdir(),'hartii-trader-sign-')),keyEnv:'SYNTHETIC'};
  const tx={from:account.address,to:'0x0010000000000000000000000000000000000002',data:'0x',value:1n,gasLimit:30000n,gasPrice:1n,nonce:0,chainId:9n};
  return {provider,deps,opts,tx};
}
it('awaits the trusted signed hook before broadcast and gives it only public authority',async()=>{
  let release,seen; const permit=new Promise(r=>{release=r;});
  const f=fixture(async data=>{seen=data; await permit;});
  const rt=await writeRuntime(f.opts,f.deps); const send=rt.wallet.sendTransaction(f.tx);
  await vi.waitFor(()=>expect(seen?.txHash).toMatch(/^0x[0-9a-f]{64}$/i));
  expect(Object.keys(seen).sort()).toEqual(['transaction','txHash']);
  expect(f.provider.broadcastTransaction).not.toHaveBeenCalled(); release(); await send;
  expect(f.provider.broadcastTransaction).toHaveBeenCalledTimes(1);
});
it('rechecks nonce after the asynchronous persistence permit',async()=>{
  const f=fixture(async()=>{f.provider.getTransactionCount.mockResolvedValue(1);});
  const rt=await writeRuntime(f.opts,f.deps);
  await expect(rt.wallet.sendTransaction(f.tx)).rejects.toThrow(/nonce changed/);
  expect(f.provider.broadcastTransaction).not.toHaveBeenCalled();
});
it('a rejected persistence permit proves no broadcast began',async()=>{
  const f=fixture(async()=>{throw Error('cancelled');});
  const rt=await writeRuntime(f.opts,f.deps);
  await expect(rt.wallet.sendTransaction(f.tx)).rejects.toThrow(/before sending/);
  expect(f.provider.broadcastTransaction).not.toHaveBeenCalled();
});
