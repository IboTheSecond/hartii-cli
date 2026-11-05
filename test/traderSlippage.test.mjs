import { it, expect, vi, beforeAll } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Interface } from 'quais';
import { createPolicy } from '../vendor/packages/hartii-trader/src/index.mjs';
import { resolvePreset } from '../src/presets.js';
import { main } from '../src/cli.js';
import { createTraderReader } from '../src/trader/readers.js';
import { traderSlippageBps, recordSlippageSkip } from '../src/trader/slippage.js';
import { validateTraderTransaction, createLiveExecutor } from '../src/trader/executor.js';
import { generateMnemonicAccount, encryptAccount, writeKeystoreFile } from '../src/keystore.js';
import { saveConfig } from '../src/config.js';
import { BONDING_CURVE_ABI, BONDING_CURVE_V3_ABI, BONDING_CURVE_V3_TRADE_ABI } from '../src/abi/bondingCurve.js';
import { DEMO_CURVE_META } from '../src/demoFixtures.js';
import { rawBuyOut } from '../src/curveQuote.js';

const TOKEN='0x0010000000000000000000000000000000000002',CURVE='0x0010000000000000000000000000000000000003',OWNER='0x0010000000000000000000000000000000000001';
const NOW=Date.now(),ONE=10n**18n,PASSWORD='synthetic-password-only';
const curve=new Interface([...BONDING_CURVE_ABI,...BONDING_CURVE_V3_ABI]),trade=new Interface(BONDING_CURVE_V3_TRADE_ABI),factory=new Interface(['function curveOf(address) view returns(address)']);

it('presets carry slippage; explicit slippage may only lower it',()=>{
  expect(resolvePreset({preset:'conservative'}).slippageBps).toBe(100);
  expect(resolvePreset({preset:'normal'}).slippageBps).toBe(200);
  expect(resolvePreset({preset:'degen'}).slippageBps).toBe(500);
  expect(resolvePreset({preset:'degen',slippageBps:'150'}).slippageBps).toBe(150);
  expect(()=>resolvePreset({preset:'conservative',slippageBps:'101'})).toThrow(/only lower/);
  expect(()=>resolvePreset({preset:'normal',slippageBps:'0'})).toThrow(/--slippage-bps/);
  expect(()=>resolvePreset({preset:'normal',slippageBps:'1.5'})).toThrow(/--slippage-bps/);
});
it('effective trader slippage: profile value, legacy default 100, never above the signed policy ceiling',()=>{
  const policy=createPolicy({owner:OWNER,tradingWallet:'0x0010000000000000000000000000000000000009',runnerId:'r',nonce:'0',issuedAt:NOW,expiresAt:NOW+1000,capitalWei:'1000',maxPerTxWei:'10',maxPerDayWei:'100',maxFeeWei:'1'});
  expect(traderSlippageBps({},policy)).toBe(100);
  expect(traderSlippageBps({preset:'normal'},policy)).toBe(100);
  expect(traderSlippageBps({slippageBps:50},policy)).toBe(50);
  expect(traderSlippageBps({slippageBps:500},policy)).toBe(policy.maxSlippageBps);
});
function fixture() {
  const home=mkdtempSync(join(tmpdir(),'hartii-slip-')),write=vi.fn(),writeErr=vi.fn();
  return {home,write,deps:{env:{HARTII_HOME:home},write,writeErr,walletFactory:vi.fn(()=>{throw Error('NO KEY');}),
    fetchFn:vi.fn(()=>{throw Error('NO NETWORK');}),providerFactory:vi.fn(()=>{throw Error('NO RPC');})}};
}
const base=['trader','init','--owner',OWNER,'--trading-address','0x0010000000000000000000000000000000000002','--capital','1000','--max-fee','1','--json'];
const profileOf=home=>JSON.parse(readFileSync(join(home,'trader/default/profile.json'),'utf8'));
it('init without --preset defaults to conservative and says so; slippage stored',async()=>{
  const {home,deps,write}=fixture();
  expect(await main(base,deps)).toBe(0);
  const out=JSON.parse(write.mock.calls.at(-1)[0]);
  expect(out).toMatchObject({preset:'conservative',slippageBps:100});
  expect(out.presetNote).toMatch(/defaulted to conservative/i);
  expect(profileOf(home)).toMatchObject({preset:'conservative',slippageBps:100,budgets:{maxPerTxWei:String(10n*ONE),maxPerDayWei:String(50n*ONE)}});
});
it('init stores preset slippage, accepts a lower override, rejects a higher one',async()=>{
  let f=fixture();
  expect(await main([...base,'--preset','degen'],f.deps)).toBe(0);
  expect(profileOf(f.home).slippageBps).toBe(500);
  f=fixture();
  expect(await main([...base,'--preset','degen','--slippage-bps','120'],f.deps)).toBe(0);
  expect(profileOf(f.home).slippageBps).toBe(120);
  f=fixture();
  expect(await main([...base,'--preset','conservative','--slippage-bps','101'],f.deps)).not.toBe(0);
});
it('status shows effective slippage and recent slippage skips; activity lists them',async()=>{
  const {home,deps}=fixture();
  expect(await main([...base,'--preset','normal'],deps)).toBe(0);
  const reader=createTraderReader({home,profile:'default'},{clock:()=>NOW});
  expect(reader.status().slippage).toMatchObject({bps:200});
  recordSlippageSkip({home,profile:'default'},{at:NOW,token:TOKEN,side:'buy',quoted:'1000',minOut:'990',attempted:'900'},{});
  expect(reader.status().slippage.recentSkips).toEqual([{type:'slippage_skip',at:NOW,token:TOKEN,side:'buy',quoted:'1000',minOut:'990',attempted:'900'}]);
  expect(reader.activity({}).slippageSkips).toHaveLength(1);
});
const tx=(data,value=ONE)=>({from:'0x0010000000000000000000000000000000000004',to:CURVE,data,value:String(value),chainId:9,gasLimit:'100000',gasPrice:'1'});
it('validate: a transaction floor below the quoted minOut is a slippage-exceeded skip, equal passes (BigInt)',()=>{
  const policy=createPolicy({owner:OWNER,tradingWallet:'0x0010000000000000000000000000000000000004',runnerId:'r',nonce:'0',issuedAt:NOW,expiresAt:NOW+600000,capitalWei:String(100n*ONE),maxPerTxWei:String(10n*ONE),maxPerDayWei:String(30n*ONE),maxFeeWei:String(ONE)});
  const intent={id:'i',action:'buy',token:TOKEN,venue:'curve-v3',amountWei:String(ONE),units:'1',gasWei:'100000',exitGasWei:'1',at:NOW};
  const expected=1000000000000000001n,minOut=expected*9900n/10000n;
  const quote={at:NOW,minOutputWei:minOut.toString(),expectedOutputWei:expected.toString(),authority:{to:CURVE,token:TOKEN,venue:'curve-v3'}};
  const data=floor=>trade.encodeFunctionData('buy',[floor,BigInt(Math.floor(NOW/1000)+300)]);
  const run=floor=>validateTraderTransaction({transaction:tx(data(floor)),intent,quote,policy,now:NOW,slippageBps:100});
  expect(()=>run(minOut)).not.toThrow();
  expect(()=>run(minOut+5n)).not.toThrow();
  expect(()=>run(minOut-1n)).toThrow(/slippage-exceeded/);
  // The quote's own floor must respect the effective slippage cap: a loose quote is refused.
  const loose={...quote,minOutputWei:(expected*9000n/10000n).toString()};
  expect(()=>validateTraderTransaction({transaction:tx(data(expected*9000n/10000n)),intent,quote:loose,policy,now:NOW,slippageBps:100})).toThrow(/slippage-exceeded/);
});
let account,encrypted;
beforeAll(async()=>{account=generateMnemonicAccount();encrypted=await encryptAccount(account,PASSWORD,{scrypt:{N:1024,r:8,p:1}});},120000);
it('executor: price moved beyond the cap before send -> nothing broadcast, structured slippage_skip',async()=>{
  const home=mkdtempSync(join(tmpdir(),'hartii-slip-exec-'));writeKeystoreFile(home,'synthetic',encrypted);
  saveConfig(home,{network:'mainnet',currentWallet:'synthetic',limits:{perTxQuai:'100',dailyQuai:'500'}});
  const provider={getNetwork:async()=>({chainId:9n}),getBalance:async()=>100n*ONE,getTransactionCount:async()=>0,getFeeData:async()=>({gasPrice:1n}),estimateGas:async()=>100000n,createAccessList:async()=>[],destroy:()=>{},
    call:async t=>{
      if(t.data.startsWith(factory.getFunction('curveOf').selector))return factory.encodeFunctionResult('curveOf',[CURVE]);
      if(t.data.startsWith(trade.getFunction('buy').selector))return trade.encodeFunctionResult('buy',[1n]);
      const p=curve.parseTransaction({data:t.data});
      if(p.name==='token')return curve.encodeFunctionResult(p.name,[TOKEN]);
      if(p.name==='creatorPayout')return curve.encodeFunctionResult(p.name,[account.address]);
      if(p.name==='quoteBuy')return curve.encodeFunctionResult(p.name,[rawBuyOut(DEMO_CURVE_META,p.args[0])]);
      return curve.encodeFunctionResult(p.name,[DEMO_CURVE_META[p.name] ?? 0n]);
    },broadcastTransaction:vi.fn()};
  const skips=[];
  const deps={clock:()=>NOW,env:{},providerFactory:()=>provider,passwordDeps:{env:{HARTII_PASSWORD:PASSWORD}},io:{write:()=>{},writeErr:()=>{}},onSlippageSkip:e=>skips.push(e),
    fetchFn:async(_u,init)=>({status:200,json:async()=>init?.method==='POST'?{result:'0x9'}:{token:{address:TOKEN,curveAddress:CURVE,symbol:'TEST'}}})};
  const policy=createPolicy({owner:OWNER,tradingWallet:account.address,runnerId:'synthetic',nonce:'0',issuedAt:NOW,expiresAt:NOW+600000,capitalWei:String(100n*ONE),maxPerTxWei:String(10n*ONE),maxPerDayWei:String(30n*ONE),maxFeeWei:String(ONE)});
  const intent={id:'entry1',action:'buy',token:TOKEN,venue:'curve-v3',amountWei:String(ONE),units:'1',gasWei:'120000',exitGasWei:'120000',at:NOW};
  const quoted=String(10n**30n),quote={at:NOW,gasWei:'120000',exitGasWei:'120000',minOutputWei:quoted,expectedOutputWei:quoted,tokenDecimals:18,authority:{to:CURVE,token:TOKEN,venue:'curve-v3'}};
  const executor=createLiveExecutor({home,wallet:'synthetic',tradingWallet:account.address,slippageBps:100},deps);
  await expect(executor.prepare({intent,quote,policy})).rejects.toThrow(/slippage-exceeded/);
  expect(provider.broadcastTransaction).not.toHaveBeenCalled();
  expect(skips).toHaveLength(1);
  expect(skips[0]).toMatchObject({type:'slippage_skip',token:TOKEN,side:'buy',quoted,minOut:quoted});
  expect(BigInt(skips[0].attempted)).toBeLessThan(BigInt(quoted));
});
