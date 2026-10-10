import { it,expect,vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFundingTransaction } from '../src/trader/funding.js';
import { main } from '../src/cli.js';
import { Wallet } from 'quais';
import { generateMnemonicAccount } from '../src/keystore.js';
import { profilePaths,writePrivateJson } from '../src/trader/storage.js';
import { createPolicy,canonicalPolicyMessage,FileJournal,TraderLedger } from '../vendor/packages/hartii-trader/src/index.mjs';
import { TRADER_RELEASE_ID } from '../src/trader/release.js';
const WALLET='0x0010000000000000000000000000000000000001',OTHER='0x0010000000000000000000000000000000000002',HASH='0x'+'ab'.repeat(32),BLOCK='0x'+'cd'.repeat(32),NOW=Date.now();
function fixture(incoming=false) {
  const tx={hash:HASH,from:incoming?OTHER:WALLET,to:incoming?WALLET:OTHER,value:10n,data:'0x',chainId:9n,nonce:0,blockHash:BLOCK,blockNumber:100};
  const receipt={hash:HASH,from:tx.from,to:tx.to,status:1,blockHash:BLOCK,blockNumber:100,fee:2n};
  const block={hash:BLOCK,woHeader:{number:100,timestamp:String(Math.floor(NOW/1000)-60)},transactions:[HASH]};
  const provider={getNetwork:async()=>({chainId:9n}),getTransaction:async()=>tx,getTransactionReceipt:async()=>receipt,getBlockNumber:async()=>120,getBlock:async()=>block,getBalance:async()=>incoming?110n:88n,destroy:vi.fn()};
  return {tx,receipt,block,provider,opts:{home:mkdtempSync(join(tmpdir(),'hartii-funding-proof-')),txHash:HASH,tradingWallet:WALLET},deps:{clock:()=>NOW,providerFactory:vi.fn(()=>provider)}};
}
it('derives canonical withdrawal principal and owner-paid gas separately after twenty confirmations',async()=>{
  const f=fixture(),result=await readFundingTransaction(f.opts,f.deps);
  expect(result).toEqual({flow:{id:`funding-${HASH.slice(2)}`,direction:'withdrawal',amountWei:'10',gasWei:'2',at:Number(f.block.woHeader.timestamp)*1000},observedCashWei:'88',checkedAt:NOW});
  expect(f.provider.destroy).toHaveBeenCalledTimes(1);
});
it('a deposit does not charge the external sender gas to this trading wallet',async()=>{
  const f=fixture(true),result=await readFundingTransaction(f.opts,f.deps);
  expect(result.flow).toMatchObject({direction:'deposit',amountWei:'10',gasWei:'0'});expect(result.observedCashWei).toBe('110');
});
it('rejects managed transaction hashes before accessing a provider',async()=>{
  const f=fixture();await expect(readFundingTransaction({...f.opts,managedHashes:[HASH]},f.deps)).rejects.toThrow(/managed-transaction/);
  expect(f.deps.providerFactory).not.toHaveBeenCalled();
});
it.each(['immature','reorg','wrong-chain','wrong-wallet','contract-call','unknown-fee'])('refuses %s evidence without inventing a funding delta',async failure=>{
  const f=fixture();
  if(failure==='immature')f.provider.getBlockNumber=async()=>119;
  if(failure==='reorg')f.block.hash='0x'+'ef'.repeat(32);
  if(failure==='wrong-chain')f.provider.getNetwork=async()=>({chainId:15000n});
  if(failure==='wrong-wallet'){f.tx.from=OTHER;f.tx.to=OTHER;f.receipt.from=OTHER;f.receipt.to=OTHER;}
  if(failure==='contract-call')f.tx.data='0x1234';
  if(failure==='unknown-fee')delete f.receipt.fee;
  await expect(readFundingTransaction(f.opts,f.deps)).rejects.toThrow();
});
it('CLI funding reconciliation explains an already observed withdrawal once without unlocking a trading key',async()=>{
  const f=fixture(),owner=generateMnemonicAccount(),paths=profilePaths({home:f.opts.home});
  const profile={schemaVersion:1,chainId:9,profile:'default',owner:owner.address,tradingWallet:WALLET,runnerId:'funding-runner',budgets:{capitalWei:'1000',maxPerTxWei:'100',maxPerDayWei:'300',maxFeeWei:'5'}};
  writePrivateJson(paths.profile,profile);
  const policy=createPolicy({...profile.budgets,owner:profile.owner,tradingWallet:WALLET,runnerId:profile.runnerId,nonce:'1',issuedAt:NOW-100000,expiresAt:NOW+100000});
  writePrivateJson(paths.policy,{policy,signature:await new Wallet(owner.privateKey).signMessage(canonicalPolicyMessage(policy))});
  const journal=await FileJournal.open(paths.journal('live'));await journal.append({type:'host.release',at:NOW,data:{releaseId:TRADER_RELEASE_ID}});
  let ledgerNow=NOW-100000;
  const ledger=await TraderLedger.open({journal,policy,mode:'live',clock:()=>ledgerNow,now:ledgerNow});
  await ledger.mark({cashWei:'100',positions:[],at:ledgerNow});ledgerNow=NOW;await ledger.mark({cashWei:'88',positions:[],at:NOW});
  expect(ledger.state.accountingUnknown).toBe(true);await journal.close();
  const deps={...f.deps,env:{HARTII_HOME:f.opts.home},write:vi.fn(),writeErr:vi.fn(),walletFactory:vi.fn(()=>{throw Error('No wallet');})};
  expect(await main(['trader','reconcile','--funding-tx',HASH,'--json'],deps)).toBe(0);
  expect(JSON.parse(deps.write.mock.calls.at(-1)[0])).toMatchObject({funding:{txHash:HASH,applied:true},snapshot:{finances:{equityWei:'88',gasWei:'2'}}});
  expect(await main(['trader','reconcile','--funding-tx',HASH,'--json'],deps)).toBe(0);
  expect(JSON.parse(deps.write.mock.calls.at(-1)[0])).toMatchObject({funding:{applied:false},snapshot:{finances:{equityWei:'88',gasWei:'2'}}});
  expect(deps.walletFactory).not.toHaveBeenCalled();
},120000);
