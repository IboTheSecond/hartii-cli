import {describe,it,expect,vi,beforeAll} from 'vitest';
import {mkdtempSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Wallet,QuaiTransaction,keccak256,toUtf8Bytes,Interface,getAddress} from 'quais';
import * as commands from '../src/commands/desk.js';
import {main} from '../src/cli.js';
import {saveConfig} from '../src/config.js';
import {DeskStore} from '../src/desk/store.js';
import {hartiiSwapAddresses} from '../src/liveAddresses.js';
import {HARTIISWAP_ROUTER_ABI} from '../src/abi/hartiiSwapRouter.js';
import {ERC20_ABI} from '../src/abi/erc20.js';
import {formatHumanResult} from '../src/humanOutput.js';
const token=getAddress('0x002233445566778899aabbccddeeff0011223344'),pair=getAddress('0x0033445566778899aabbccddeeff001122334455'),bh='0x'+'ab'.repeat(32),route=new Interface(HARTIISWAP_ROUTER_ABI),erc=new Interface(ERC20_ABI),factory=new Interface(['function getPair(address,address) view returns (address)']),events=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
let wallet;
beforeAll(()=>{for(let i=0;i<20000;i++){const w=new Wallet(keccak256(toUtf8Bytes('public disposable Constraint Desk test '+i)));if(/^0x00[0-7]/i.test(w.address)){wallet=w;break;}}expect(wallet).toBeTruthy();});
function fixture({mode='success',denyConfirm=false}={}){
  expect(typeof commands.runDesk).toBe('function');const home=mkdtempSync(join(tmpdir(),'hartii-desk-command-'));saveConfig(home,{network:'mainnet',limits:{perTxQuai:'100',dailyQuai:'500'}});let nonce=0,allowance=0n;const txs=new Map(),receipts=new Map(),broadcasts=[];
  const p={destroy:vi.fn(),getNetwork:async()=>({chainId:9n}),getBalance:async()=>100n*10n**18n,getTransactionCount:async()=>nonce,createAccessList:async()=>[],estimateGas:async()=>100000n,getFeeData:async zone=>{expect(zone).toBe('0x00');return {gasPrice:1000000000n};},
    call:async tx=>{expect(tx.to).toBe(getAddress(tx.to));for(const iface of[erc,route,factory]){let parsed;try{parsed=iface.parseTransaction(tx);}catch{}if(!parsed)continue;const n=parsed.name;if(n==='symbol')return erc.encodeFunctionResult(n,['TOK']);if(n==='decimals')return erc.encodeFunctionResult(n,[18]);if(n==='balanceOf')return erc.encodeFunctionResult(n,[1000n*10n**18n]);if(n==='allowance')return erc.encodeFunctionResult(n,[allowance]);if(n==='approve')return erc.encodeFunctionResult(n,[true]);if(n==='getAmountsOut')return route.encodeFunctionResult(n,[[parsed.args[0],100n*10n**18n]]);if(n==='factory')return route.encodeFunctionResult(n,[getAddress(hartiiSwapAddresses().factory)]);if(n==='getPair')return factory.encodeFunctionResult(n,[pair]);}return '0x';},
    getTransaction:async h=>txs.get(h)??null,getTransactionReceipt:async h=>receipts.get(h)??null,getBlock:async(zone,n)=>{expect(zone).toBe('0x00');expect(Number.isSafeInteger(n)).toBe(true);return {hash:bh,woHeader:{number:n,timestamp:1700000000}};}};
  p.broadcastTransaction=vi.fn(async(_zone,raw)=>{
    const signed=QuaiTransaction.from(raw),hash=signed.hash;
    const saved=new DeskStore(home).list().records.find(r=>r.txHash===hash);expect(saved?.phase).toBe('broadcast-possible');expect(saved?.broadcastMayHaveStarted).toBe(true);
    let approved;try{approved=erc.parseTransaction({data:signed.data});}catch{}if(approved?.name==='approve')allowance=approved.args[1];
    broadcasts.push(hash);nonce++;
    const tx={from:signed.from,to:signed.to,data:signed.data,value:signed.value,nonce:signed.nonce,chainId:signed.chainId,gasLimit:signed.gasLimit,gasPrice:signed.gasPrice,accessList:signed.accessList,hash,blockNumber:100,blockHash:bh};txs.set(hash,tx);
    const ev=events.encodeEventLog(events.getEvent('Transfer'),[pair,wallet.address,100n*10n**18n]);const receipt={hash,transactionHash:hash,from:tx.from,to:tx.to,status:mode==='revert'?0:1,blockNumber:100,blockHash:bh,gasUsed:80000n,gasPrice:1000000000n,logs:mode==='revert'?[]:[{address:token,...ev,index:0,transactionHash:hash,blockHash:bh,removed:false}]};
    if(mode!=='unknown')receipts.set(hash,receipt);
    if(mode==='broadcast-error')throw new Error('fixture transport lost');
    return {...tx,wait:async()=>{if(mode==='unknown')throw new Error('fixture receipt timeout');if(mode==='revert')throw Object.assign(new Error('fixture reverted'),{code:'CALL_EXCEPTION',receipt});return receipt;}};
  });
  const fetchFn=vi.fn(async(url,init)=>({ok:true,status:200,json:async()=>init?.method==='POST'?{result:'0x9'}:String(url).includes('/api/portfolio/')?{holdings:[{tokenAddress:token,symbol:'TOK',balance:'12',valueQuai:'3'}]}:{holdings:[]}}));
  const deps={env:{SYNTHETIC:wallet.privateKey},providerFactory:()=>p,walletFactory:()=>wallet,fetchFn,io:{write:vi.fn(),writeErr:vi.fn(),confirmFn:vi.fn(async()=>!denyConfirm)},now:new Date(),clock:()=>Date.now()};
  return {home,p,deps,broadcasts,txs,receipts,opts:{home,network:'mainnet',keyEnv:'SYNTHETIC',sub:'swap',args:['QUAI',token,'1'],json:true,flags:{}}};
}
describe('Constraint Desk commands',()=>{
  it.each([['0','0.0',false],[null,null,true],['bad',null,true],['-1',null,true],['1.2',null,true]])('distinguishes an API zero mark from unavailable or malformed wei (%s)',async(value,decimal,partial)=>{
    const f=fixture();f.deps.fetchFn=async(url,init)=>({ok:true,json:async()=>init?.method==='POST'?{result:'0x9'}:{holdings:String(url).includes('/api/portfolio/')?[{tokenAddress:token,symbol:'TOK',balance:'12000000000000000000',valueQuai:value,priceSource:'curve'}]:[]}});
    const result=await commands.runDesk({...f.opts,sub:'positions',args:[],address:wallet.address},f.deps);
    expect(result.desk.positions[0].indexedValueQuai).toBe(decimal);expect(result.desk.positions[0].indexedValueWei).toBe(decimal===null?null:value);expect(result.desk.partial).toBe(partial);expect(f.broadcasts).toHaveLength(0);
  });
  it('retains the durable broadcast marker and known hash when transport fails during dispatch',async()=>{
    const f=fixture({mode:'broadcast-error'});const result=await commands.runDesk(f.opts,f.deps);
    expect(result.ok).toBe(false);expect(f.broadcasts).toHaveLength(1);
    const saved=new DeskStore(f.home).get(result.desk.decisions[0].id);
    expect(saved.txHash).toBe(f.broadcasts[0]);expect(saved.broadcastMayHaveStarted).toBe(true);
    expect(saved.outcome.status).toBe('confirmed');expect(f.p.broadcastTransaction).toHaveBeenCalledTimes(1);
  });
  it('refuses a changed gas estimate after review without marking a possible broadcast',async()=>{
    const f=fixture();f.deps.io.confirmFn=async()=>{f.p.estimateGas=async()=>300000n;return true;};
    const result=await commands.runDesk(f.opts,f.deps);expect(result.ok).toBe(false);expect(f.broadcasts).toHaveLength(0);
    expect(result.desk.decisions[0].broadcastMayHaveStarted).toBe(false);expect(result.desk.decisions[0].phase).toBe('signed');
  });
  it('prints the receipt-evidence reason in human output rather than hiding it behind an unresolved label',()=>{
    const lines=formatHumanResult({ok:true,desk:{view:'decisions',decisions:[{id:'synthetic',status:'unresolved',outcomeReason:'On-chain authority differs from the captured review.'}]}});
    expect(lines).toContain('On-chain authority differs from the captured review.');
  });
  it('registers a real demo command with structured output and no chain/wallet access',async()=>{const write=vi.fn(),writeErr=vi.fn(),providerFactory=vi.fn(()=>{throw Error('No network');});const code=await main(['desk','--demo','--json'],{write,writeErr,providerFactory});expect(code).toBe(0);expect(JSON.parse(write.mock.calls[0][0]).desk.demo).toBe(true);expect(providerFactory).not.toHaveBeenCalled();});
  it('runs preview through the existing swap simulation without a signature or durable decision',async()=>{const f=fixture();const result=await commands.runDesk({...f.opts,sub:'preview'},f.deps);expect(result.dryRun).toBe(true);expect(f.p.broadcastTransaction).not.toHaveBeenCalled();expect(existsSync(join(f.home,'desk'))).toBe(false);});
  it('records reviewed terms and signed hash before one manually confirmed native-input swap',async()=>{const f=fixture();const result=await commands.runDesk(f.opts,f.deps);expect(result.ok).toBe(true);expect(f.deps.io.confirmFn).toHaveBeenCalledTimes(1);expect(f.broadcasts).toHaveLength(1);const saved=new DeskStore(f.home).get(result.desk.decisions[0].id);expect(saved.broadcastMayHaveStarted).toBe(true);expect(saved.txHash).toBe(f.broadcasts[0]);expect(saved.outcome.status).toBe('confirmed');expect(saved.outcome.gasFeeWei).toBe('80000000000000');expect(saved.outcome.output.eventDerivedUnits).toBe('100000000000000000000');});
  it('keeps an unresolved transaction hash without starting another transaction',async()=>{const f=fixture({mode:'unknown'});const result=await commands.runDesk(f.opts,f.deps);expect(result.ok).toBe(false);expect(result.desk.decisions[0].status).toBe('unresolved');expect(result.desk.decisions[0].txHash).toBe(f.broadcasts[0]);expect(f.broadcasts).toHaveLength(1);});
  it('records a final revert and its actual gas without reporting received output',async()=>{const f=fixture({mode:'revert'});const result=await commands.runDesk(f.opts,f.deps);expect(result.ok).toBe(false);expect(result.desk.decisions[0].status).toBe('reverted');expect(result.desk.decisions[0].output.eventDerivedUnits).toBe('0');});
  it('honors cancellation and refuses blanket --yes execution',async()=>{const f=fixture({denyConfirm:true});const result=await commands.runDesk(f.opts,f.deps);expect(result.aborted).toBe(true);expect(f.broadcasts).toHaveLength(0);expect(existsSync(join(f.home,'desk'))).toBe(false);await expect(commands.runDesk({...f.opts,yes:true},f.deps)).rejects.toThrow(/--yes/);});
  it('provides watch-only indexed position context and leaves unknown cost basis/PnL null',async()=>{const f=fixture();const result=await commands.runDesk({...f.opts,sub:'positions',args:[],address:wallet.address},f.deps);expect(result.desk.view).toBe('positions');expect(result.desk.positions[0].address).toBe(token);expect(result.desk.positions[0].costBasisWei).toBeNull();expect(result.desk.positions[0].realizedPnlWei).toBeNull();expect(f.broadcasts).toHaveLength(0);});
  it('refuses gas-price drift after manual review before broadcast',async()=>{const f=fixture();f.deps.io.confirmFn=async()=>{f.p.getFeeData=async()=>({gasPrice:2000000000n});return true;};const result=await commands.runDesk(f.opts,f.deps);expect(result.ok).toBe(false);expect(f.broadcasts).toHaveLength(0);});
  it('keeps an exact-amount allowance and its subsequent swap as separate reviewed decisions',async()=>{const f=fixture();const result=await commands.runDesk({...f.opts,args:['WQUAI',token,'1']},f.deps);expect(result.ok).toBe(true);expect(f.broadcasts).toHaveLength(2);expect(f.deps.io.confirmFn).toHaveBeenCalledTimes(2);expect(result.desk.decisions.map(r=>r.kind)).toEqual(['approval','swap']);const approval=new DeskStore(f.home).get(result.desk.decisions[0].id);expect(approval.trade.approvedUnits).toBe('1000000000000000000');expect(approval.outcome.output.eventDerivedUnits).toBeNull();},60000);
  it('refuses a fresh quote below the reviewed minimum before broadcast',async()=>{const f=fixture(),original=f.p.call;let reviewed=false;f.deps.io.confirmFn=async()=>{reviewed=true;return true;};f.p.call=async tx=>{let parsed;try{parsed=route.parseTransaction(tx);}catch{}if(reviewed&&parsed?.name==='getAmountsOut')return route.encodeFunctionResult('getAmountsOut',[[parsed.args[0],1n]]);return original(tx);};const result=await commands.runDesk(f.opts,f.deps);expect(result.ok).toBe(false);expect(f.broadcasts).toHaveLength(0);});
  it('expires a slow manual operation instead of signing old terms',async()=>{const f=fixture();let clock=Date.now();f.deps.clock=()=>clock;f.deps.io.confirmFn=async()=>{clock+=300001;return true;};const result=await commands.runDesk(f.opts,f.deps);expect(result.ok).toBe(false);expect(f.broadcasts).toHaveLength(0);});
  it('labels an allowance-only preview without presenting approval gas as the full swap cost',async()=>{const f=fixture();const result=await commands.runDesk({...f.opts,sub:'preview',args:['WQUAI',token,'1']},f.deps);expect(result.tradeSimulated).toBe(false);expect(result.desk.previewScope).toBe('approval-only');const text=formatHumanResult(result);expect(text).toContain('Approval gas ceiling');expect(text).toContain('Swap gas: unavailable');expect(f.broadcasts).toHaveLength(0);});
});
