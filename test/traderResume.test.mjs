import { it,expect,vi,beforeAll } from 'vitest';
import { mkdtempSync,existsSync,mkdirSync,rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'quais';
import { main } from '../src/cli.js';
import { generateMnemonicAccount,encryptAccount,writeKeystoreFile } from '../src/keystore.js';
import { profilePaths,writePrivateJson,encryptCredentials,requestPause,pauseRequested,readPauseControl } from '../src/trader/storage.js';
import { createDevice } from '../src/trader/relay.js';
import { policyHash } from '../src/trader/services.js';
import { createPolicy,canonicalPolicyMessage,FileJournal,TraderLedger } from '../vendor/packages/hartii-trader/src/index.mjs';
import { TRADER_RELEASE_ID } from '../src/trader/release.js';
let owner,trading,encrypted;const PASSWORD='synthetic-resume-password';
beforeAll(async()=>{owner=generateMnemonicAccount();trading=generateMnemonicAccount();encrypted=await encryptAccount(trading,PASSWORD,{scrypt:{N:1024,r:8,p:1}});},120000);
async function fixture() {
  const home=mkdtempSync(join(tmpdir(),'hartii-trader-resume-')),paths=profilePaths({home}),at=Date.now();
  const profile={schemaVersion:1,chainId:9,profile:'default',owner:owner.address,tradingWallet:trading.address,wallet:'trading',runnerId:'12345678-1234-1234-1234-123456789012',pairing:{confirmed:true},budgets:{capitalWei:'1000',maxPerTxWei:'100',maxPerDayWei:'300',maxFeeWei:'5'}};
  writePrivateJson(paths.profile,profile);writeKeystoreFile(home,'trading',encrypted);writePrivateJson(paths.credentials,encryptCredentials({device:createDevice()},PASSWORD));
  const old=createPolicy({...profile.budgets,owner:owner.address,tradingWallet:trading.address,runnerId:profile.runnerId,nonce:'1',issuedAt:at-1000,expiresAt:at+100000});
  writePrivateJson(paths.policy,{policy:old,signature:await new Wallet(owner.privateKey).signMessage(canonicalPolicyMessage(old))});
  const journal=await FileJournal.open(paths.journal('live'));await journal.append({type:'host.release',at,data:{releaseId:TRADER_RELEASE_ID}});
  const ledger=await TraderLedger.open({journal,policy:old,mode:'live',now:at,clock:()=>at});await ledger.mark({cashWei:'1000',positions:[],at});
  requestPause(paths,at,'remote-pause');const control=readPauseControl(paths);await ledger.pause(at,'remote-pause');await journal.close();
  const fresh=createPolicy({...old,nonce:'2',issuedAt:at+1,expiresAt:at+100001}),file=join(home,'reviewed.json');
  writePrivateJson(file,{policy:fresh,signature:await new Wallet(owner.privateKey).signMessage(canonicalPolicyMessage(fresh))});
  const f={home,paths,control,policy:fresh,file,at,onClaim:null};
  f.deps={env:{HARTII_HOME:home},clock:()=>at+1,passwordDeps:{env:{HARTII_PASSWORD:PASSWORD}},confirmTypedFn:async()=>'ARM',write:vi.fn(),writeErr:vi.fn(),walletFactory:vi.fn(()=>{throw Error('No transaction signer');}),
    fetchFn:async(url,request)=>{const body=JSON.parse(request.body);if(url.endsWith('/authority/claim')){await f.onClaim?.();return {ok:true,status:200,json:async()=>({exclusive:true})};}return {ok:true,status:200,json:async()=>({policyHash:policyHash(body.policy),approvalRequired:false})};}};
  return f;
}
async function state(f){const j=await FileJournal.open(f.paths.journal('live'));try{return (await j.read()).filter(r=>r.type==='ledger.state').at(-1).data;}finally{await j.close();}}
it('fresh signed local ARM acknowledges only the exact durable pause and leaves finances unchanged',async()=>{
  const f=await fixture();
  expect(await main(['trader','arm','--policy-file',f.file,'--json'],f.deps)).toBe(0);
  expect(pauseRequested(f.paths)).toBe(false);expect(existsSync(f.paths.pause)).toBe(true);
  const saved=await state(f);expect(saved.pauseLatch).toBeNull();expect(saved.cashWei).toBe('1000');expect(saved.resumeHistory[0].controlPauseId).toBe(f.control.id);
  requestPause(f.paths,f.at+2);expect(pauseRequested(f.paths)).toBe(true);expect(readPauseControl(f.paths).id).not.toBe(f.control.id);
  expect(f.deps.walletFactory).not.toHaveBeenCalled();
});
it('a new pause racing the hosted claim is preserved and never acknowledged by the old approval',async()=>{
  const f=await fixture();f.onClaim=()=>requestPause(f.paths,f.at+2);
  expect(await main(['trader','arm','--policy-file',f.file,'--json'],f.deps)).toBe(1);
  expect(pauseRequested(f.paths)).toBe(true);expect(readPauseControl(f.paths).id).not.toBe(f.control.id);
});
it('a crash after durable resume can retry its exact proof without inventing a second pause or resetting history',async()=>{
  const f=await fixture();f.onClaim=()=>mkdirSync(f.paths.resumeAck);
  expect(await main(['trader','arm','--policy-file',f.file,'--json'],f.deps)).toBe(1);
  expect((await state(f)).resumeHistory).toHaveLength(1);
  rmdirSync(f.paths.resumeAck);f.onClaim=null;
  expect(await main(['trader','arm','--policy-file',f.file,'--json'],f.deps)).toBe(0);
  expect((await state(f)).resumeHistory).toHaveLength(1);expect(pauseRequested(f.paths)).toBe(false);
});
