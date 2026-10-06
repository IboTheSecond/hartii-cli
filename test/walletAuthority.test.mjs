import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { runWrite, PreBroadcastError } from '../src/writePipeline.js';
import { listSpendReservations, inspectSpendLock } from '../src/spendingGuard.js';

const FROM = '0x0010000000000000000000000000000000000001';
const TO = '0x0010000000000000000000000000000000000002';
const HASH = '0x'+'ab'.repeat(32);
const PIPELINE_MODULE_URL = new URL('../src/writePipeline.js', import.meta.url).href;
let home;
beforeEach(() => { home = mkdtempSync(join(tmpdir(),'hartii-authority-test-')); });
afterEach(() => { expect(dirname(home)).toBe(tmpdir()); rmSync(home,{recursive:true,force:true}); });

function rig({chainId=9,address=FROM,receipt={status:1,hash:HASH,fee:7n}}={}) {
  const provider={getNetwork:vi.fn(async()=>({chainId:BigInt(chainId)})),call:vi.fn(async()=>'0x'),estimateGas:vi.fn(async()=>100n),getFeeData:vi.fn(async()=>({gasPrice:1n})),getTransactionCount:vi.fn(async()=>4)};
  const wallet={getAddress:vi.fn(async()=>address),sendTransaction:vi.fn(async(tx)=>({...tx,hash:HASH,wait:async()=>receipt}))};
  return {provider,wallet,ctx:{provider,wallet,network:{name:chainId===9?'mainnet':'orchard',chainId},home,limits:{perTxQuai:'100',dailyQuai:'500'},to:TO,value:10n,action:'Synthetic write',yes:true,io:{write(){}}}};
}

describe('wallet write authority',()=>{
  it.each([{code:4001},{code:'ACTION_REJECTED'},{notSubmitted:true},{name:'PreBroadcastError'}])('RPC error fields cannot release spending authority %#',async(fields)=>{
    const {ctx,wallet}=rig();wallet.sendTransaction.mockRejectedValue(Object.assign(Error('remote error'),fields));
    await expect(runWrite(ctx)).rejects.toThrow(/outcome unknown/);
    expect(listSpendReservations(home,FROM)).toHaveLength(1);
    expect(inspectSpendLock(home).exists).toBe(false);
    const next=rig();await expect(runWrite(next.ctx)).rejects.toThrow(/unconfirmed/i);expect(next.provider.call).not.toHaveBeenCalled();
  });
  it('a forged native-error prototype is not a native phase capability',async()=>{
    const {ctx,wallet}=rig();const error=Object.setPrototypeOf(Error('remote fake class'),PreBroadcastError.prototype);wallet.sendTransaction.mockRejectedValue(error);
    await expect(runWrite(ctx)).rejects.toThrow(/outcome unknown/);expect(listSpendReservations(home)).toHaveLength(1);
  });
  it('native cancellation before invocation creates no reservation or signer preparation',async()=>{
    const {ctx,wallet}=rig();wallet.prepareSigner=vi.fn(async()=>FROM);
    await expect(runWrite({...ctx,yes:false,io:{write(){},confirmFn:async()=>false}})).resolves.toMatchObject({aborted:true});
    expect(wallet.prepareSigner).not.toHaveBeenCalled();expect(wallet.sendTransaction).not.toHaveBeenCalled();expect(listSpendReservations(home)).toEqual([]);
  });
  it('pending reservations retain explicit chain/nonce/intent public metadata across UTC days',async()=>{
    const {ctx}=rig({receipt:null});await expect(runWrite({...ctx,io:{write(){},now:new Date('2026-01-01T23:59:00Z')}})).rejects.toThrow(/unconfirmed/i);
    const [pending]=listSpendReservations(home,FROM);
    expect(pending).toMatchObject({chainId:'9',nonce:4,to:TO.toLowerCase(),valueWei:'10',guardedValueWei:'10',gasTotalWei:'120',amountWei:'130',txHash:HASH,status:'unconfirmed',legacy:false});
    expect(pending.intentDigest).toMatch(/^0x[0-9a-f]{64}$/);expect(pending.dataDigest).toMatch(/^0x[0-9a-f]{64}$/);
    const next=rig();await expect(runWrite({...next.ctx,io:{write(){},now:new Date('2026-01-02T00:00:00Z')}})).rejects.toThrow(/unconfirmed/i);expect(next.wallet.sendTransaction).not.toHaveBeenCalled();
  });
  it('new scoped pending authority permits a different chain but legacy authority blocks all chains',async()=>{
    await expect(runWrite(rig({receipt:null}).ctx)).rejects.toThrow();
    const orchard=rig({chainId:15000});expect((await runWrite(orchard.ctx)).status).toBe('success');
    const data=JSON.parse(readFileSync(join(home,'spend.json'),'utf8'));const row=Object.values(data[FROM.toLowerCase()].reservations)[0];
    for(const field of ['chainId','nonce','to','valueWei','dataDigest','intentDigest','spendWei','maxFeeWei','createdAt'])delete row[field];
    writeFileSync(join(home,'spend.json'),JSON.stringify(data));
    await expect(runWrite(rig({chainId:15000}).ctx)).rejects.toThrow(/unconfirmed/i);expect(listSpendReservations(home)[0].legacy).toBe(true);
  });
  it('confirmation metadata cannot override reviewed authority and late context mutation cannot alter the request',async()=>{
    const {ctx,wallet}=rig();ctx.extraSummary={from:TO,to:FROM,chainId:15000,nonce:99,valueQuai:'999',action:'forged action'};
    const result=await runWrite({...ctx,yes:false,io:{write(){},confirmFn:async()=>{ctx.to=FROM;ctx.value=999n;ctx.network.chainId=15000;return true;}}});
    expect(result.summary).toMatchObject({from:FROM,to:TO,chainId:9,nonce:4,action:'Synthetic write'});
    expect(wallet.sendTransaction.mock.calls[0][0]).toMatchObject({from:FROM,to:TO,value:10n,chainId:9n,nonce:4});
  });
  it('the prepared actual signer and provider must still match after unlock',async()=>{
    for(const change of ['signer','chain']){
      const {ctx,wallet,provider}=rig();wallet.prepareSigner=async()=>{if(change==='chain')provider.getNetwork.mockResolvedValue({chainId:15000n});return change==='signer'?TO:FROM;};
      await expect(runWrite(ctx)).rejects.toThrow(/authority|chain/);expect(wallet.sendTransaction).not.toHaveBeenCalled();expect(listSpendReservations(home)).toEqual([]);
    }
  });
  it('expiry after asynchronous signer preparation rejects before reservation or SDK invocation',async()=>{
    const {ctx,wallet}=rig();let expired=false;wallet.prepareSigner=async()=>{await Promise.resolve();expired=true;return FROM;};
    const validateBeforeSubmit=()=>{if(expired)throw Error('Payment link expired during approval');};
    await expect(runWrite({...ctx,validateBeforeSubmit})).rejects.toThrow(/expired/);expect(wallet.sendTransaction).not.toHaveBeenCalled();expect(listSpendReservations(home)).toEqual([]);
  });
  it('a final synchronous expiry rejection after reservation uses native prebroadcast evidence',async()=>{
    const {ctx,wallet}=rig();let checks=0;
    await expect(runWrite({...ctx,validateBeforeSubmit:()=>{if(++checks===2)throw Error('Payment link expired immediately before submit');}})).rejects.toThrow(/rejected before broadcast/);
    expect(checks).toBe(2);expect(wallet.sendTransaction).not.toHaveBeenCalled();expect(listSpendReservations(home)).toEqual([]);
  });
  it('remote submission receipts cannot substitute for a locally returned signed hash',async()=>{
    const {ctx,wallet}=rig();wallet.sendTransaction.mockImplementation(async(tx)=>{throw Object.assign(Error('RPC manufactured receipt'),{code:'CALL_EXCEPTION',transaction:{...tx,hash:HASH},transactionHash:HASH,receipt:{status:1,hash:HASH,fee:0n}});});
    await expect(runWrite(ctx)).rejects.toThrow(/outcome unknown/);expect(listSpendReservations(home)).toHaveLength(1);
  });
  it('pending and lock readers reveal only selected public scalar fields and fail closed on damage',()=>{
    writeFileSync(join(home,'spend.json'),JSON.stringify({[FROM.toLowerCase()]:{date:'2026-01-01',spentWei:'0',reservations:{old:{amountWei:'1',date:'2026-01-01',txHash:null,privateKey:'SYNTHETIC_NOT_A_KEY'}}}}));
    expect(JSON.stringify(listSpendReservations(home))).not.toContain('SYNTHETIC_NOT_A_KEY');
    writeFileSync(join(home,'spend.lock'),'SYNTHETIC_UNREADABLE_LOCK');expect(inspectSpendLock(home)).toEqual({exists:true,pid:null,startedAt:null,unverified:true,unreadable:true});
    writeFileSync(join(home,'spend.json'),'{damaged');expect(()=>listSpendReservations(home)).toThrow(/unreadable|damaged/);
  });
});

function child(mode) {
  const code=`
    (async()=>{
      const {runWrite}=await import(process.argv[1]);let sends=0,calls=0;
      const hash='0x'+'ab'.repeat(32), from='${FROM}',to='${TO}';
      const provider={getNetwork:async()=>({chainId:9n}),call:async()=>{calls++;return '0x';},estimateGas:async()=>100n,getFeeData:async()=>({gasPrice:1n}),getTransactionCount:async()=>4};
      const wallet={getAddress:async()=>from,sendTransaction:async(tx)=>{sends++;process.send({kind:'sent'});return {...tx,hash,wait:async()=>{
        if(process.argv[2]==='hold')await new Promise(resolve=>process.once('message',resolve));
        return process.argv[2]==='unknown'?null:{status:1,hash,fee:7n};
      }};}};
      let error=null;try{await runWrite({wallet,provider,network:{name:'mainnet',chainId:9},home:process.env.HARTII_HOME,limits:{perTxQuai:'100',dailyQuai:'500'},to,value:10n,action:process.argv[2],yes:true,io:{write(){}}});}catch(e){error=e.message;}
      process.send({kind:'done',sends,calls,error});
    })().catch(e=>process.send({kind:'failure',error:e.stack})).finally(()=>process.disconnect());
  `;
  const processRef=spawn(process.execPath,['-e',code,PIPELINE_MODULE_URL,mode],{windowsHide:true,stdio:['ignore','pipe','pipe','ipc'],env:{SystemRoot:process.env.SystemRoot||'',HARTII_HOME:home}});
  let resolveSent;
  const sent=new Promise(resolve=>{resolveSent=resolve;});
  const done=new Promise((resolve,reject)=>{processRef.on('message',message=>{if(message.kind==='sent')resolveSent();if(message.kind==='done')resolve(message);if(message.kind==='failure')reject(Error(message.error));});processRef.on('error',reject);});
  const closed=new Promise(resolve=>processRef.once('close',resolve));
  return {processRef,sent,done,closed};
}

describe('native process serialization',()=>{
  it('the home lock covers the entire send and receipt wait, not just a ledger write',async()=>{
    const first=child('hold');await first.sent;expect(inspectSpendLock(home).exists).toBe(true);
    const second=child('success');const rejected=await second.done;await second.closed;
    expect(rejected.sends).toBe(0);expect(rejected.error).toMatch(/in progress|lock/);
    first.processRef.send({release:true});expect((await first.done).sends).toBe(1);await first.closed;
    expect(inspectSpendLock(home).exists).toBe(false);
  });
  it('a new native process cannot start another command through an unknown receipt',async()=>{
    const first=child('unknown');expect((await first.done).sends).toBe(1);await first.closed;expect(existsSync(join(home,'spend.lock'))).toBe(false);
    const second=child('different-command');const blocked=await second.done;await second.closed;
    expect(blocked.sends).toBe(0);expect(blocked.calls).toBe(0);expect(blocked.error).toMatch(/unconfirmed|reconcile/i);
    expect(listSpendReservations(home)).toHaveLength(1);
  });
});
