import {describe,it,expect} from 'vitest';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync,symlinkSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {getAddress,Interface} from 'quais';
import * as storage from '../src/desk/store.js';
import {captureDecision} from '../src/desk/model.js';
import {HARTIISWAP_ROUTER_ABI} from '../src/abi/hartiiSwapRouter.js';
const addr=n=>getAddress('0x00'+n.toString(16).padStart(38,'0')),from=addr(1),router=addr(2),wquai=addr(3),token=addr(4),iface=new Interface(HARTIISWAP_ROUTER_ABI),txHash='0x'+'ab'.repeat(32);
function setup(){expect(typeof storage.DeskStore).toBe('function');const home=mkdtempSync(join(tmpdir(),'hartii-desk-store-'));const store=new storage.DeskStore(home);const tx={from,to:router,value:100n,data:iface.encodeFunctionData('swapExactETHForTokens',[90n,[wquai,token],from,2000000000]),nonce:0,chainId:9n,gasLimit:50000n,gasPrice:10n,accessList:[]};const record=captureDecision({action:'Swap',chainId:9,from,to:router,nonce:0},tx,{router,wquai,at:1800000000000});return {store,home,tx,record};}
describe('private Fill Ledger store',()=>{
  it('keeps a refused signed record distinct from a possible broadcast after an unresolved read',()=>{
    const {store,record,tx}=setup();store.capture(record);store.signed(record.id,txHash,tx);
    store.observe(record.id,{status:'unresolved',observedAt:5,reason:'Transaction or receipt unavailable.'});
    const saved=store.get(record.id);expect(saved.phase).toBe('signed');expect(storage.summarizeDecision(saved).status).toBe('signed');
    expect(storage.summarizeDecision(saved).outcomeReason).toBe('Transaction or receipt unavailable.');
  });
  it('retains past mined evidence while reporting a failed current canonical recheck as unresolved',()=>{
    const {store,record,tx}=setup();store.capture(record);store.signed(record.id,txHash,tx);store.broadcast(record.id,txHash);
    store.observe(record.id,{status:'confirmed',observedAt:1,reason:'canonical',gasFeeWei:'5'});
    store.observe(record.id,{status:'unresolved',observedAt:2,reason:'current canonical evidence unavailable',gasFeeWei:null});
    const saved=store.get(record.id);expect(saved.outcome.status).toBe('unresolved');expect(saved.outcome.gasFeeWei).toBeNull();
    expect(saved.observations[0]).toMatchObject({status:'confirmed',gasFeeWei:'5'});expect(saved.observations).toHaveLength(2);
  });
  it('publishes a private decision once and keeps repeated validation idempotent',()=>{const {store,record}=setup();expect(store.capture(record).id).toBe(record.id);store.capture({...record,createdAt:record.createdAt+1});expect(store.list({day:record.id.slice(0,8)}).records).toHaveLength(1);expect(store.get(record.id).createdAt).toBe(record.createdAt);});
  it('binds signed authority once and marks only a possible broadcast',()=>{const {store,record,tx}=setup();store.capture(record);store.signed(record.id,txHash,tx);store.signed(record.id,txHash,tx);expect(store.get(record.id).phase).toBe('signed');expect(()=>store.signed(record.id,'0x'+'cd'.repeat(32),tx)).toThrow();store.broadcast(record.id,txHash);const r=store.get(record.id);expect(r.broadcastMayHaveStarted).toBe(true);expect(r.phase).toBe('broadcast-possible');expect(r.outcome).toBeNull();});
  it('refuses modified stored bytes and refuses a path or stale writer lock',()=>{const {store,record}=setup();store.capture(record);expect(()=>store.get('../other')).toThrow();const path=store.path(record.id);const doc=JSON.parse(readFileSync(path,'utf8'));doc.record.transaction.value='101';writeFileSync(path,JSON.stringify(doc));expect(()=>store.get(record.id)).toThrow(/integrity/);});
  it('preserves distinct observations while deduplicating repeated checks',()=>{const {store,record}=setup();store.capture(record);store.observe(record.id,{status:'unresolved',observedAt:1,reason:'pending'});store.observe(record.id,{status:'unresolved',observedAt:2,reason:'pending'});expect(store.get(record.id).observations).toHaveLength(1);store.observe(record.id,{status:'confirmed',observedAt:3,reason:'canonical'});expect(store.get(record.id).observations).toHaveLength(2);expect(store.get(record.id).phase).toBe('observed');});
  it('does not follow a linked desk directory or write outside the home',()=>{const {home}=setup();const elsewhere=mkdtempSync(join(tmpdir(),'hartii-desk-outside-'));symlinkSync(elsewhere,join(home,'desk'),process.platform==='win32'?'junction':'dir');expect(()=>new storage.DeskStore(home).list({day:'20261112'})).toThrow();expect(existsSync(join(elsewhere,'mainnet'))).toBe(false);});
});
