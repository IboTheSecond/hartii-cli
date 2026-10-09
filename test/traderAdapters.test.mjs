import { it, expect, vi, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicKey, verify, createHash } from 'node:crypto';
import { Interface, QuaiTransaction } from 'quais';
import { createPolicy, canonicalJson, TraderRunner, MemoryJournal } from '../vendor/packages/hartii-trader/src/index.mjs';
import { createDevice, signRelayRequest } from '../src/trader/relay.js';
import { encryptCredentials, decryptCredentials } from '../src/trader/storage.js';
import { decodeCandles,readVerifiedRoute,createRealMarket } from '../src/trader/market.js';
import { loadLiveAddresses,hartiiSwapAddresses } from '../src/liveAddresses.js';
import { ERC20_ABI } from '../src/abi/erc20.js';
import { createLiveExecutor } from '../src/trader/executor.js';
import { runSell } from '../src/commands/sell.js';
import { generateMnemonicAccount, encryptAccount, writeKeystoreFile } from '../src/keystore.js';
import { saveConfig } from '../src/config.js';
import { listSpendReservations } from '../src/spendingGuard.js';
import { BONDING_CURVE_ABI,BONDING_CURVE_V3_ABI,BONDING_CURVE_V3_TRADE_ABI } from '../src/abi/bondingCurve.js';
import { DEMO_CURVE_META } from '../src/demoFixtures.js';
import { rawBuyOut,rawSellOut } from '../src/curveQuote.js';
const TOKEN='0x0010000000000000000000000000000000000002',CURVE='0x0010000000000000000000000000000000000003',OWNER='0x0010000000000000000000000000000000000001';
const NOW=Date.now(),ONE=10n**18n,PASSWORD='synthetic-password-only';
const curve=new Interface([...BONDING_CURVE_ABI,...BONDING_CURVE_V3_ABI]),trade=new Interface(BONDING_CURVE_V3_TRADE_ABI),factory=new Interface(['function curveOf(address) view returns(address)']);
let account,encrypted;
beforeAll(async()=>{account=generateMnemonicAccount();encrypted=await encryptAccount(account,PASSWORD,{scrypt:{N:1024,r:8,p:1}});},120000);
function signingFixture() {
  const home=mkdtempSync(join(tmpdir(),'hartii-trader-executor-'));writeKeystoreFile(home,'synthetic',encrypted);
  saveConfig(home,{network:'mainnet',currentWallet:'synthetic',limits:{perTxQuai:'100',dailyQuai:'500'}});
  const provider={getNetwork:async()=>({chainId:9n}),getBalance:async()=>100n*ONE,getTransactionCount:async()=>0,getFeeData:async()=>({gasPrice:1n}),estimateGas:async()=>100000n,createAccessList:async()=>[],destroy:()=>{},
    call:async tx=>{
      if(tx.data.startsWith(factory.getFunction('curveOf').selector))return factory.encodeFunctionResult('curveOf',[CURVE]);
      if(tx.data.startsWith(trade.getFunction('buy').selector))return trade.encodeFunctionResult('buy',[1n]);
      const p=curve.parseTransaction({data:tx.data});
      if(p.name==='token')return curve.encodeFunctionResult(p.name,[TOKEN]);
      if(p.name==='creatorPayout')return curve.encodeFunctionResult(p.name,[account.address]);
      if(p.name==='quoteBuy')return curve.encodeFunctionResult(p.name,[rawBuyOut(DEMO_CURVE_META,p.args[0])]);
      return curve.encodeFunctionResult(p.name,[DEMO_CURVE_META[p.name] ?? 0n]);
    },broadcastTransaction:vi.fn(async(_zone,raw)=>{const t=QuaiTransaction.from(raw);return {hash:t.hash,wait:async()=>({status:1,hash:t.hash,fee:7n})};})};
  const deps={clock:()=>NOW,env:{},providerFactory:()=>provider,passwordDeps:{env:{HARTII_PASSWORD:PASSWORD}},io:{write:()=>{},writeErr:()=>{}},fetchFn:async(_u,init)=>({status:200,json:async()=>init?.method==='POST'?{result:'0x9'}:{token:{address:TOKEN,curveAddress:CURVE,symbol:'TEST'}}})};
  const policy=createPolicy({owner:OWNER,tradingWallet:account.address,runnerId:'synthetic',nonce:'0',issuedAt:NOW,expiresAt:NOW+600000,capitalWei:String(100n*ONE),maxPerTxWei:String(10n*ONE),maxPerDayWei:String(30n*ONE),maxFeeWei:String(ONE)});
  const intent={id:'entry1',action:'buy',token:TOKEN,venue:'curve-v3',amountWei:String(ONE),units:'1',gasWei:'120000',exitGasWei:'120000',at:NOW};
  const quote={at:NOW,gasWei:'120000',exitGasWei:'120000',minOutputWei:'1',tokenDecimals:18,authority:{to:CURVE,token:TOKEN,venue:'curve-v3'}};
  return {home,provider,deps,policy,intent,quote,executor:createLiveExecutor({home,wallet:'synthetic',tradingWallet:account.address},deps)};
}
it('device proof binds exact canonical request body, path, runner, time and nonce',()=>{
  const device=createDevice(),payload={snapshot:{a:1,b:2}},time=NOW,nonce='A'.repeat(32),runnerId='runner-test-123456';
  const request=signRelayRequest({device,payload,path:'/api/trader/heartbeat',time,nonce,runnerId});
  const bodyHash=createHash('sha256').update(request.body).digest('hex');
  const message='hartii-trader-request:v1\n'+canonicalJson({method:'POST',path:'/api/trader/heartbeat',bodyHash,time,nonce,runnerId});
  const key=createPublicKey({key:Buffer.from(device.publicKey,'base64url'),format:'der',type:'spki'});
  expect(verify(null,Buffer.from(message),key,Buffer.from(request.headers['x-trader-signature'],'base64url'))).toBe(true);
  expect(verify(null,Buffer.from(message.replace('heartbeat','pause')),key,Buffer.from(request.headers['x-trader-signature'],'base64url'))).toBe(false);
  expect(request.body).not.toContain(device.privateKey);
});
it('encrypts local credentials and refuses incorrect passwords and tampering',()=>{
  const secret='synthetic-model-key',envelope=encryptCredentials({modelKey:secret},PASSWORD);
  expect(JSON.stringify(envelope)).not.toContain(secret);
  expect(decryptCredentials(envelope,PASSWORD)).toEqual({modelKey:secret});
  expect(()=>decryptCredentials(envelope,'wrong')).toThrow(/unlock/);
  expect(()=>decryptCredentials({...envelope,ciphertext:'AA=='},PASSWORD)).toThrow(/unlock/);
});
it('requires genuine closed contiguous one-minute candles and exact integer prices',()=>{
  const end=Math.floor(NOW/60000)*60000;
  const body={address:TOKEN,at:new Date(NOW).toISOString(),items:Array.from({length:35},(_,i)=>({tf:'1m',bucketStart:(end-(35-i)*60000)/1000,close:'123000000000000000000',volumeQuai:'1000000000000000000'}))};
  expect(decodeCandles(body,TOKEN,NOW)).toHaveLength(35);
  expect(()=>decodeCandles({...body,items:body.items.filter((_,i)=>i!==10)},TOKEN,NOW)).toThrow();
  expect(()=>decodeCandles({...body,items:body.items.map(c=>({...c,close:1e25}))},TOKEN,NOW)).toThrow();
});
it('prepare signs through actual CLI safeguards without broadcast, and discard proves exact cancellation',async()=>{
  const f=signingFixture();
  const prepared=await f.executor.prepare(f);
  expect(prepared.txHash).toMatch(/^0x[0-9a-f]{64}$/i);expect(f.provider.broadcastTransaction).not.toHaveBeenCalled();
  expect(listSpendReservations(f.home)).toHaveLength(1);
  expect(listSpendReservations(f.home)[0].txHash).toBe(prepared.txHash);
  expect(await f.executor.discard(prepared.prepared)).toEqual({cancelled:true,broadcastStarted:false,completed:true,intentId:f.intent.id,txHash:prepared.txHash});
  expect(f.provider.broadcastTransaction).not.toHaveBeenCalled();expect(listSpendReservations(f.home)).toEqual([]);
  await expect(f.executor.broadcast({...prepared,intent:f.intent})).rejects.toThrow(/invalid-prepared/);
});
it('managed entry budget keeps approved principal and reserved gas while retaining the owner global cap',async()=>{
  const f=signingFixture(),intent={...f.intent,amountWei:f.policy.maxPerTxWei};
  const prepared=await f.executor.prepare({...f,intent});
  expect(listSpendReservations(f.home)[0]).toMatchObject({guardedValueWei:intent.amountWei,amountWei:String(BigInt(intent.amountWei)+BigInt(intent.gasWei)),txHash:prepared.txHash});
  await f.executor.discard(prepared.prepared);expect(f.provider.broadcastTransaction).not.toHaveBeenCalled();
});
it('ambiguous broadcast keeps the exact signed hash and spending reservation, and cannot be discarded',async()=>{
  const f=signingFixture();f.provider.broadcastTransaction.mockRejectedValue(Error('Synthetic disconnect'));
  const prepared=await f.executor.prepare(f);
  await expect(f.executor.broadcast({...prepared,intent:f.intent})).rejects.toThrow(/outcome unknown/);
  expect(listSpendReservations(f.home)[0].txHash).toBe(prepared.txHash);
  await expect(f.executor.discard(prepared.prepared)).rejects.toThrow(/cancellation-not-proven/);
});
it('only its exact completed pre-sign failure can prove an unhashed intent unsent',async()=>{
  const f=signingFixture();saveConfig(f.home,{network:'mainnet',currentWallet:'synthetic',limits:{perTxQuai:'0.5',dailyQuai:'500'}});
  let failure;try {await f.executor.prepare(f);}catch(error){failure=error;}
  expect(failure).toBeInstanceOf(Error);
  expect(await f.executor.discardFailedPrepare({error:failure,intentId:f.intent.id})).toEqual({cancelled:true,broadcastStarted:false,completed:true,intentId:f.intent.id,txHash:null});
  await expect(f.executor.discardFailedPrepare({error:Object.assign(Error(failure.message),{cancelled:true}),intentId:f.intent.id})).rejects.toThrow(/not-proven/);
  expect(f.provider.broadcastTransaction).not.toHaveBeenCalled();
});
it('a final nonce failure after permit release proves native dispatch never began',async()=>{
  const f=signingFixture(),prepared=await f.executor.prepare(f);f.provider.getTransactionCount=async()=>1;
  await expect(f.executor.broadcast({...prepared,intent:f.intent})).rejects.toThrow(/rejected before broadcast/);
  expect(await f.executor.discard(prepared.prepared)).toEqual({cancelled:true,broadcastStarted:false,completed:true,intentId:f.intent.id,txHash:prepared.txHash});
  expect(f.provider.broadcastTransaction).not.toHaveBeenCalled();expect(listSpendReservations(f.home)).toEqual([]);
});
it('hosted hash binding runs only after prepare returns the already durable native hash',async()=>{
  const f=signingFixture();f.deps.onPrepared=vi.fn(async({txHash})=>{expect(listSpendReservations(f.home)[0].txHash).toBe(txHash);throw Error('Synthetic hosted timeout');});
  const prepared=await f.executor.prepare(f);
  expect(f.deps.onPrepared).not.toHaveBeenCalled();expect(listSpendReservations(f.home)[0].txHash).toBe(prepared.txHash);
  await expect(f.executor.broadcast({...prepared,intent:f.intent})).rejects.toThrow(/hosted timeout/);
  expect((await f.executor.discard(prepared.prepared)).txHash).toBe(prepared.txHash);
  expect(f.provider.broadcastTransaction).not.toHaveBeenCalled();
});
it('a confirmed staged buy reconciles exact public event amounts and actual receipt gas',async()=>{
  const f=signingFixture(),tradeEvents=new Interface(['event Buy(address indexed buyer,uint256 quaiIn,uint256 tokensOut,uint256 fee)']);
  let transaction;
  f.provider.broadcastTransaction.mockImplementation(async(_zone,raw)=>{
    transaction=QuaiTransaction.from(raw);
    expect(listSpendReservations(f.home)[0].txHash).toBe(transaction.hash);
    return {hash:transaction.hash,wait:async()=>({status:1,hash:transaction.hash,fee:7n})};
  });
  f.provider.getTransactionReceipt=async()=>({status:1,hash:transaction.hash,from:account.address,to:CURVE,fee:7n,
    logs:[{address:CURVE,...tradeEvents.encodeEventLog(tradeEvents.getEvent('Buy'),[account.address,ONE,10n,1n])}]});
  const prepared=await f.executor.prepare(f),receipt=await f.executor.broadcast({...prepared,intent:f.intent});
  expect(receipt).toEqual({id:f.intent.id,txHash:prepared.txHash,status:1,gasWei:'7',amountWei:String(ONE),units:'10',at:NOW});
  expect(f.provider.broadcastTransaction).toHaveBeenCalledTimes(1);expect(listSpendReservations(f.home)).toEqual([]);
});
it('a profitable managed exit spends gas-only while ordinary sell turnover limits remain enforced',async()=>{
  const f=signingFixture(),erc=new Interface(ERC20_ABI),original=f.provider.call,units=100n*ONE;
  f.provider.call=async tx=>{
    for(const [method,value] of [['symbol','TEST'],['decimals',18],['balanceOf',units],['allowance',units]])if(tx.data.startsWith(erc.getFunction(method).selector))return erc.encodeFunctionResult(method,[value]);
    if(tx.data.startsWith(curve.getFunction('quoteSell').selector))return curve.encodeFunctionResult('quoteSell',[11n*ONE]);
    if(tx.data.startsWith(trade.getFunction('sell').selector))return trade.encodeFunctionResult('sell',[11n*ONE]);
    return original(tx);
  };
  const intent={...f.intent,action:'sell',amountWei:String(11n*ONE),units:String(units)},quote={...f.quote,minOutputWei:String(10n*ONE)};
  const prepared=await f.executor.prepare({intent,quote,policy:f.policy});
  expect(listSpendReservations(f.home)[0]).toMatchObject({guardedValueWei:'0',amountWei:'120000',txHash:prepared.txHash});
  await f.executor.discard(prepared.prepared);
  await expect(runSell({home:f.home,wallet:'synthetic',token:TOKEN,amount:'100',yes:true},{...f.deps,limits:{perTxQuai:'10',dailyQuai:'30'}})).rejects.toThrow(/limit/);
  expect(f.provider.broadcastTransaction).not.toHaveBeenCalled();
});
it('stages one exact approval independently, validates its event, and accounts only actual gas',async()=>{
  const f=signingFixture(),erc=new Interface([...ERC20_ABI,'event Approval(address indexed owner,address indexed spender,uint256 value)']),original=f.provider.call;
  f.provider.call=async tx=>tx.data.startsWith(erc.getFunction('approve').selector)?erc.encodeFunctionResult('approve',[true]):original(tx);
  const intent={...f.intent,action:'approve',amountWei:'0',units:'10',spender:CURVE,positionId:'managed-position'};
  const quote={...f.quote,executionTarget:CURVE,approval:{required:true,token:TOKEN,spender:CURVE,units:'10',gasWei:'120000'}};
  let transaction;
  f.provider.broadcastTransaction.mockImplementation(async(_zone,raw)=>{transaction=QuaiTransaction.from(raw);return {hash:transaction.hash,wait:async()=>({status:1,hash:transaction.hash,fee:7n})};});
  f.provider.getTransactionReceipt=async()=>({status:1,hash:transaction.hash,from:account.address,to:TOKEN,fee:7n,
    logs:[{address:TOKEN,...erc.encodeEventLog(erc.getEvent('Approval'),[account.address,CURVE,10n])}]});
  const prepared=await f.executor.prepare({intent,quote,policy:f.policy});
  expect(f.provider.broadcastTransaction).not.toHaveBeenCalled();
  const receipt=await f.executor.broadcast({...prepared,intent});
  expect(transaction.to).toBe(TOKEN);expect(transaction.value).toBe(0n);
  expect(erc.parseTransaction({data:transaction.data}).args[1]).toBe(10n);
  expect(receipt).toEqual({id:intent.id,txHash:prepared.txHash,status:1,gasWei:'7',amountWei:'0',units:'0',at:NOW});
  expect(f.provider.broadcastTransaction).toHaveBeenCalledTimes(1);
});
function marketFixture() {
  const f=signingFixture(),original=f.provider.call,snipe=new Interface(['function launchBlock() view returns(uint256)','function snipeWindowBlocks() view returns(uint256)']),erc=new Interface(ERC20_ABI);
  const v3=loadLiveAddresses().data.mainnet.launchFactoryV3;
  f.provider.getCode=async()=> '0x1234';f.provider.getBlockNumber=async()=>1000;
  f.provider.call=async tx=>{
    if(tx.data.startsWith(factory.getFunction('curveOf').selector))return factory.encodeFunctionResult('curveOf',[tx.to.toLowerCase()===v3.toLowerCase()?CURVE:'0x0000000000000000000000000000000000000000']);
    if(tx.data.startsWith(snipe.getFunction('launchBlock').selector))return snipe.encodeFunctionResult('launchBlock',[100n]);
    if(tx.data.startsWith(snipe.getFunction('snipeWindowBlocks').selector))return snipe.encodeFunctionResult('snipeWindowBlocks',[20n]);
    if(tx.data.startsWith(erc.getFunction('decimals').selector))return erc.encodeFunctionResult('decimals',[18]);
    if(tx.data.startsWith(erc.getFunction('allowance').selector))return erc.encodeFunctionResult('allowance',[f.allowance ?? ((1n<<256n)-1n)]);
    if(tx.data.startsWith(erc.getFunction('balanceOf').selector))return erc.encodeFunctionResult('balanceOf',[0]);
    if(tx.data.startsWith(curve.getFunction('quoteSell').selector))return curve.encodeFunctionResult('quoteSell',[rawSellOut(DEMO_CURVE_META,curve.decodeFunctionData('quoteSell',tx.data)[0])]);
    return original(tx);
  };
  return f;
}
it('binds a curve candidate to the bundled factory and rejects unfinished snipe windows',async()=>{
  const f=marketFixture(),info={address:TOKEN,curveAddress:CURVE};
  expect(await readVerifiedRoute(f.provider,info,NOW)).toMatchObject({venue:'curve-v3',token:TOKEN,target:CURVE,snipeEndsAt:NOW});
  f.provider.getBlockNumber=async()=>110;
  expect((await readVerifiedRoute(f.provider,info,NOW)).snipeEndsAt).toBeGreaterThan(NOW);
  f.provider.getCode=async()=> '0x';
  await expect(readVerifiedRoute(f.provider,info,NOW)).rejects.toThrow(/token-code/);
});
it('a verified future-exit reserve can price a first entry while actual sell still uses the real estimator',async()=>{
  const f=marketFixture();
  f.provider.estimateGas=vi.fn(async tx=>{
    if(tx.data.startsWith(trade.getFunction('sell').selector))throw Error('No token balance yet');
    return 100000n;
  });
  const estimateFutureExit=vi.fn(async()=>({basis:'verified-generation-bound',evidence:'synthetic-reviewed-benchmark',checkedAt:NOW,gasWei:'250000'}));
  const market=createRealMarket({home:f.home,profile:{tradingWallet:account.address},policy:f.policy},{...f.deps,estimateFutureExit});
  const quote=await market.quote({action:'buy',candidate:{token:TOKEN,venue:'curve-v3'},position:null,amountWei:String(ONE),units:null,now:NOW});
  expect(quote.exitGasWei).toBe('250000');expect(estimateFutureExit).toHaveBeenCalledTimes(1);
  await expect(market.quote({action:'sell',candidate:{token:TOKEN,venue:'curve-v3'},position:{units:'10'},amountWei:String(ONE),units:'10',now:NOW})).rejects.toThrow(/complete-gas-estimate/);
});
it('quotes required approval separately and honors simulated permission only in Paper',async()=>{
  const f=marketFixture();f.allowance=0n;
  const estimateFutureExit=async()=>({basis:'verified-generation-bound',evidence:'synthetic-reviewed-benchmark',checkedAt:NOW,gasWei:'250000'});
  const market=createRealMarket({home:f.home,profile:{tradingWallet:account.address},policy:f.policy},{...f.deps,estimateFutureExit});
  const position={id:'held1',token:TOKEN,venue:'curve-v3',units:'100000000000000000000'};
  const input={action:'sell',candidate:{token:TOKEN,venue:'curve-v3'},position,amountWei:String(ONE),units:position.units,now:NOW};
  const first=await market.quote({...input,mode:'live'});
  expect(first).toMatchObject({executionTarget:CURVE,gasWei:'250000',exitGasWei:'250000',approval:{required:true,token:TOKEN,spender:CURVE,units:position.units,gasWei:'120000'}});
  const approvals=[{positionId:position.id,token:TOKEN,spender:CURVE,units:position.units,simulated:true,at:NOW,txHash:'0x'+'ab'.repeat(32)}];
  expect((await market.quote({...input,mode:'paper',approvals})).approval.required).toBe(false);
  expect((await market.quote({...input,mode:'live',approvals})).approval.required).toBe(true);
});
it('a completely unfunded Paper wallet can enter using explicit conservative fee ceilings, without inventing gas estimates',async()=>{
  const f=marketFixture();f.allowance=0n;f.provider.getBalance=async()=>0n;
  f.provider.estimateGas=vi.fn(async()=>{throw Error('Synthetic account has no gas funds');});
  const policy=createPolicy({...f.policy,capitalWei:String(1000n*ONE),maxPerTxWei:String(100n*ONE),maxPerDayWei:String(300n*ONE),maxFeeWei:String(ONE/10n)});
  const end=Math.floor(NOW/60000)*60000;
  const candles={address:TOKEN,at:new Date(NOW).toISOString(),items:Array.from({length:35},(_,i)=>({tf:'1m',bucketStart:(end-(35-i)*60000)/1000,close:String(BigInt(100+i)*ONE),volumeQuai:String((i>=30?2n:1n)*ONE)}))};
  const fetchFn=async url=>({status:200,json:async()=>url.includes('/api/tokens?')?{items:[{address:TOKEN}],nextCursor:null}:url.includes('/candles?')?candles:{token:{address:TOKEN,curveAddress:CURVE,symbol:'TEST'}}});
  const market=createRealMarket({home:f.home,profile:{tradingWallet:account.address},policy},{...f.deps,fetchFn});
  const quote=await market.quote({action:'buy',candidate:{token:TOKEN,venue:'curve-v3'},position:null,amountWei:String(100n*ONE),units:null,now:NOW,mode:'paper'});
  expect(quote).toMatchObject({gasBasis:'policy-fee-ceiling',exitGasBasis:'policy-fee-ceiling',approvalGasBasis:'policy-fee-ceiling',gasWei:String(ONE/10n),exitGasWei:String(ONE/5n)});
  expect(quote.roundTripCostBps).toBeLessThanOrEqual(500);
  const runner=new TraderRunner({mode:'paper',policy,market,journal:new MemoryJournal(),clock:()=>NOW,initialBalanceWei:policy.capitalWei,
    decisionProvider:{analyze:async({candidates})=>({action:'rank',rankedIds:[candidates[0].id],rationale:'Synthetic fixture ranks qualified public metrics.',veto:false})}});
  await runner.initialize();const result=await runner.cycle();
  expect(result.latestDecision.outcome).toBe('paper-filled');expect(result.positions).toHaveLength(1);expect(result.qualification.liveEnabled).toBe(false);
  const originalCall=f.provider.call;
  f.provider.call=async tx=>{
    const raw=await originalCall(tx);
    return tx.data.startsWith(curve.getFunction('quoteSell').selector)?curve.encodeFunctionResult('quoteSell',[BigInt(curve.decodeFunctionResult('quoteSell',raw)[0])*8n/10n]):raw;
  };
  const approved=await runner.cycle();
  expect(approved.latestDecision.outcome).toBe('approval-confirmed');expect(approved.positions).toHaveLength(1);
  expect(runner.ledger.state.approvals[0]).toMatchObject({simulated:true,token:TOKEN,spender:CURVE,units:result.positions[0].units});
  const exited=await runner.cycle();
  expect(exited.latestDecision.outcome).toBe('paper-filled');expect(exited.positions).toHaveLength(0);
  expect(f.provider.broadcastTransaction).not.toHaveBeenCalled();
  await expect(market.quote({action:'buy',candidate:{token:TOKEN,venue:'curve-v3'},position:null,amountWei:String(100n*ONE),units:null,now:NOW,mode:'live'})).rejects.toThrow(/complete-gas-estimate/);
  f.provider.getNetwork=async()=>({chainId:15000n});
  await expect(market.quote({action:'buy',candidate:{token:TOKEN,venue:'curve-v3'},position:null,amountWei:String(100n*ONE),units:null,now:NOW,mode:'paper'})).rejects.toThrow(/invalid-market-network/);
});
it('validates newly received candles against the current clock after slow discovery',async()=>{
  const f=marketFixture();let clock=NOW;
  const end=Math.floor(NOW/60000)*60000;
  const body=()=>({address:TOKEN,at:new Date(clock).toISOString(),items:Array.from({length:35},(_,i)=>({tf:'1m',bucketStart:(end-(35-i)*60000)/1000,close:String(BigInt(100+i)*ONE),volumeQuai:String((i>=30?2n:1n)*ONE)}))});
  const fetchFn=async url=>({status:200,json:async()=>{
    if(url.includes('/api/tokens?'))return {items:[{address:TOKEN}],nextCursor:null};
    if(url.includes('/candles?')){clock+=2000;return body();}
    return {token:{address:TOKEN,curveAddress:CURVE,symbol:'TEST'}};
  }});
  const market=createRealMarket({home:f.home,profile:{tradingWallet:account.address},policy:f.policy},{...f.deps,clock:()=>clock,fetchFn});
  const result=await market.snapshot({now:NOW,positions:[],mode:'paper'});
  expect(result.candidates.length).toBeGreaterThan(0);expect(result.at).toBe(clock);expect(result.candidates[0].candles).toHaveLength(35);
});
