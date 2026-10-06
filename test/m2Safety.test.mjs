import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Interface, getAddress } from 'quais';
import { runBuy } from '../src/commands/buy.js';
import { runSell } from '../src/commands/sell.js';
import { runSwap } from '../src/commands/swap.js';
import { runSend } from '../src/commands/send.js';
import { fetchTokens, fetchToken } from '../src/marketApi.js';
import { runWrite } from '../src/writePipeline.js';
import { parseSlippageBps } from '../src/trade.js';
import { ERC20_ABI } from '../src/abi/erc20.js';
import { BONDING_CURVE_ABI, BONDING_CURVE_V3_ABI } from '../src/abi/bondingCurve.js';
import { HARTIISWAP_ROUTER_ABI } from '../src/abi/hartiiSwapRouter.js';
import { DEMO_CURVE_META } from '../src/demoFixtures.js';
import { rawBuyOut } from '../src/curveQuote.js';
import { saveConfig } from '../src/config.js';
import { generateMnemonicAccount, encryptAccount, writeKeystoreFile } from '../src/keystore.js';
import { main } from '../src/cli.js';
import { getSpentToday } from '../src/spendingGuard.js';

export const addr = (n) => getAddress(`0x001${String(n).padStart(37, '0')}`);
const FROM = addr(1), TOKEN = addr(2), CURVE = addr(3);
const erc = new Interface(ERC20_ABI), curve = new Interface([...BONDING_CURVE_ABI, ...BONDING_CURVE_V3_ABI]), router = new Interface(HARTIISWAP_ROUTER_ABI);
const factoryI = new Interface(['function curveOf(address) view returns (address)']);
let home;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'hartii-m2-')); mkdirSync(join(home,'keystore')); writeFileSync(join(home,'keystore','test.json'), JSON.stringify({address: FROM.slice(2)})); saveConfig(home,{network:'mainnet',currentWallet:'test',limits:{perTxQuai:'100',dailyQuai:'500'}}); vi.stubGlobal('fetch', vi.fn(() => { throw Error('No live network in tests'); })); });
afterEach(() => { rmSync(home,{recursive:true,force:true}); vi.unstubAllGlobals(); });
function harness({ allowance=0n, gross=10n**18n, chain='0x9', approvalOk=true, boundToken=TOKEN, factoryCurve=CURVE }={}) {
 const fetchFn = vi.fn(async (url, init) => ({status:200,json: async()=> init?.method==='POST' ? {result:chain} : {token:{address:TOKEN,curveAddress:CURVE,symbol:'TEST',network:'mainnet'}}}));
 const provider = {call:vi.fn(async(tx)=>{
   for (const iface of [erc,curve,router,factoryI]) { let parsed; try { parsed=iface.parseTransaction({data:tx.data}); } catch {} if(!parsed) continue;
    const n=parsed.name;
    if(n==='curveOf') return factoryI.encodeFunctionResult(n,[factoryCurve]);
    if(n==='approve') return erc.encodeFunctionResult(n,[approvalOk]);
    if(n==='transfer') return erc.encodeFunctionResult(n,[true]);
    if(n==='decimals') return erc.encodeFunctionResult(n,[18]);
    if(n==='symbol') return erc.encodeFunctionResult(n,['TEST']);
    if(n==='balanceOf') return erc.encodeFunctionResult(n,[1000n*10n**18n]);
    if(n==='allowance') return erc.encodeFunctionResult(n,[allowance]);
    if(n==='creatorPayout') return curve.encodeFunctionResult(n,[FROM]);
    if(n==='token') return curve.encodeFunctionResult(n,[boundToken]);
    if(n==='quoteSell') return curve.encodeFunctionResult(n,[gross]);
    if(n==='quoteBuy') return curve.encodeFunctionResult(n,[rawBuyOut(DEMO_CURVE_META,parsed.args[0])]);
    if(n in DEMO_CURVE_META) return curve.encodeFunctionResult(n,[DEMO_CURVE_META[n]]);
    if(n==='getAmountsOut') return router.encodeFunctionResult(n,[[parsed.args[0],gross]]);
   }
   return '0x';
 }), createAccessList:vi.fn(async()=>[]),estimateGas:vi.fn(async()=>100000n),getFeeData:vi.fn(async()=>({gasPrice:1n})),getTransactionCount:vi.fn(async()=>0),getNetwork:vi.fn(async()=>({chainId:9n}))};
 return { provider, deps:{fetchFn,providerFactory:()=>provider,io:{write:vi.fn(),writeErr:vi.fn()},passwordDeps:{promptFn:()=>{throw Error('Must not decrypt on dry-run');}}} };
}
describe('M2 money boundaries',()=>{
 it.each(['buy','sell'])('rejects a mismatched on-chain token binding before %s',async side=>{const {provider,deps}=harness({boundToken:FROM});await expect(side==='buy'?runBuy({home,token:TOKEN,quai:'1',dryRun:true},deps):runSell({home,token:TOKEN,amount:'1',dryRun:true},deps)).rejects.toThrow(/binding|match/i);expect(provider.createAccessList).not.toHaveBeenCalled();});
 it('token sends call the token contract with the recipient encoded',async()=>{const {provider,deps}=harness();const r=await runSend({home,to:CURVE,token:TOKEN,amount:'5',dryRun:true},deps);expect(r.summary.to).toBe(TOKEN);const call=provider.call.mock.calls.find(([t])=>t.data?.startsWith(erc.getFunction('transfer').selector))[0];expect(call.to).toBe(TOKEN);expect(erc.parseTransaction(call).args[0]).toBe(CURVE);});
 it('blocks over-cap token sends',async()=>{const {deps}=harness({gross:101n*10n**18n});await expect(runSend({home,to:CURVE,token:TOKEN,amount:'5',dryRun:true},deps)).rejects.toThrow(/limit/);});
 it('refuses ERC20 false approval simulation',async()=>{const {deps}=harness({approvalOk:false});await expect(runSell({home,token:TOKEN,amount:'5',dryRun:true},deps)).rejects.toThrow(/false|approval/i);});
 it('CLI key-env buy signs only after approval and closes provider',async()=>{const account=generateMnemonicAccount();const {provider,deps}=harness();provider.destroy=vi.fn();const sendTransaction=vi.fn(async()=>({hash:'0x' + 'ab'.repeat(32),wait:async()=>({status:1,hash:'0x'+'ab'.repeat(32)})}));const write=vi.fn(), writeErr=vi.fn();const code=await main(['buy',TOKEN,'1','--key-env','THROWAWAY','--yes','--json'],{...deps,env:{HARTII_HOME:home,THROWAWAY:account.privateKey},walletFactory:()=>({getAddress:async()=>account.address,sendTransaction}),write,writeErr});expect(code).toBe(0);expect(sendTransaction).toHaveBeenCalledTimes(1);expect(provider.destroy).toHaveBeenCalledTimes(1);expect(write).toHaveBeenCalledTimes(1);expect(JSON.parse(write.mock.calls[0][0]).status).toBe('success');});
 it('refreshes the sell quote after confirmed approval and records only trade notional',async()=>{const account=generateMnemonicAccount();const {provider,deps}=harness();let approved=false;const original=provider.call;provider.call=vi.fn(async tx=>{if(tx.data?.startsWith(erc.getFunction('allowance').selector)&&approved)return erc.encodeFunctionResult('allowance',[5n*10n**18n]);return original(tx);});const sendTransaction=vi.fn(async _tx=>{approved=true;return {hash:'0x' + 'ab'.repeat(32),wait:async()=>({status:1,hash:'0x'+'ab'.repeat(32)})};});const r=await runSell({home,token:TOKEN,amount:'5',keyEnv:'THROWAWAY',yes:true},{...deps,env:{THROWAWAY:account.privateKey},walletFactory:()=>({getAddress:async()=>account.address,sendTransaction})});expect(r.status).toBe('success');expect(sendTransaction).toHaveBeenCalledTimes(2);expect(provider.call.mock.calls.filter(([tx])=>tx.data.startsWith(curve.getFunction('quoteSell').selector)).length).toBe(2);{ const spent = getSpentToday(home,account.address).spentWei; expect(spent >= 10n**18n && spent < 10n**18n + 10n ** 15n).toBe(true); /* value + estimated fee counts toward the guard (M3) */ }});

 it('swap asks for the keystore password ONCE even when it must approve first', async () => {
  const account = generateMnemonicAccount();
  writeKeystoreFile(home, 'real', await encryptAccount({ address: account.address, privateKey: account.privateKey }, 'pw', { scrypt: { N: 2, r: 1, p: 1 } }));
  const { provider, deps } = harness();
  let approved = false;
  const original = provider.call;
  provider.call = vi.fn(async (tx) => (tx.data?.startsWith(erc.getFunction('allowance').selector) && approved ? erc.encodeFunctionResult('allowance', [5n * 10n ** 18n]) : original(tx)));
  const sendTransaction = vi.fn(async () => { approved = true; return { hash: '0x' + 'ab'.repeat(32), wait: async () => ({ status: 1, hash: '0x'+'ab'.repeat(32) }) }; });
  const promptFn = vi.fn(async () => 'pw');
  const r = await runSwap({ home, wallet: 'real', tokenIn: TOKEN, tokenOut: 'QUAI', amount: '5', yes: true }, { ...deps, passwordDeps: { env: {}, promptFn }, walletFactory: () => ({ getAddress: async () => account.address, sendTransaction }) });
  expect(r.status).toBe('success');
  expect(sendTransaction).toHaveBeenCalledTimes(2); // approve, then swap
  expect(promptFn).toHaveBeenCalledTimes(1);
 }, 60_000);
 it('dry-run buy never decrypts or constructs a signer',async()=> { const {deps}=harness(); const walletFactory=vi.fn(); const result=await runBuy({home,token:'TEST',quai:'1',dryRun:true},{...deps,walletFactory}); expect(result.dryRun).toBe(true); expect(walletFactory).not.toHaveBeenCalled(); });
 it('sell approval uses exactly the requested tokens and reports the unsimulated trade',async()=> {const {provider,deps}=harness(); const r=await runSell({home,token:'TEST',amount:'5',dryRun:true},deps); const approval=provider.call.mock.calls.map(([tx])=>{try{return erc.parseTransaction(tx);}catch{return null;}}).find(p=>p?.name==='approve'); expect(approval.args[1]).toBe(5n*10n**18n); expect(r.tradeSimulated).toBe(false); expect(r.plannedTrade.expectedQuaiOut).toBe('0.99'); });
 it('blocks over-cap sells before approving anything',async()=>{const {provider,deps}=harness({gross:101n*10n**18n}); await expect(runSell({home,token:'TEST',amount:'5',dryRun:true},deps)).rejects.toThrow(/limit/); expect(provider.createAccessList).not.toHaveBeenCalled();});
 it('blocks over-cap token swaps before approval',async()=>{const {provider,deps}=harness({gross:101n*10n**18n}); await expect(runSwap({home,tokenIn:TOKEN,tokenOut:'QUAI',amount:'5',dryRun:true},deps)).rejects.toThrow(/limit/); expect(provider.createAccessList).not.toHaveBeenCalled();});
 it('rejects same-asset router swaps',async()=>{const {deps}=harness(); await expect(runSwap({home,tokenIn:TOKEN,tokenOut:TOKEN,amount:'5',dryRun:true},deps)).rejects.toThrow(/same|identical/i);});
 it('wraps native QUAI directly into WQUAI',async()=>{const {deps}=harness();const r=await runSwap({home,tokenIn:'QUAI',tokenOut:'WQUAI',amount:'5',dryRun:true},deps);expect(r.summary.action).toBe('Wrap QUAI');expect(r.summary.valueQuai).toBe('5.0');expect(r.summary.feeBps).toBe('0');});
 it('checks selected chain before market or signer access',async()=>{const {deps}=harness({chain:'0x3a98'}); await expect(runBuy({home,token:'TEST',quai:'1'},deps)).rejects.toThrow(/chain id/); expect(deps.fetchFn).toHaveBeenCalledTimes(1);});
 it('counts explicit token valuations despite zero native value',async()=> {const {provider,deps}=harness(); const wallet={getAddress:async()=>FROM,sendTransaction:vi.fn(async()=>({hash:'0x' + 'ab'.repeat(32),wait:async()=>({status:1,hash:'0x'+'ab'.repeat(32)})}))}; await runWrite({wallet,provider,network:{name:'mainnet',chainId:9},home,limits:{perTxQuai:'100',dailyQuai:'500'},to:TOKEN,value:0n,spendWei:5n*10n**18n,action:'Token trade',yes:true,io:deps.io}); { const spent = getSpentToday(home,FROM).spentWei; expect(spent >= 5n*10n**18n && spent < 5n*10n**18n + 10n ** 15n).toBe(true); /* value + estimated fee counts toward the guard (M3) */ } });
 it('keeps intermediate JSON summaries off stdout',async()=> {const {provider,deps}=harness(); await runWrite({wallet:{getAddress:async()=>FROM},provider,network:{name:'mainnet',chainId:9},home,limits:{perTxQuai:'100',dailyQuai:'500'},to:TOKEN,value:0n,action:'Test',dryRun:true,json:true,io:deps.io}); expect(deps.io.write).not.toHaveBeenCalled(); });
});
describe('H2: curve must be factory-registered', () => {
 it.each(['buy','sell'])('refuses a %s on an API-supplied curve no bundled factory registered, before any approval/send', async side => {
  const {provider,deps}=harness({factoryCurve:addr(77)});
  const walletFactory=vi.fn();
  const run=side==='buy'?runBuy({home,token:TOKEN,quai:'1',dryRun:true},{...deps,walletFactory}):runSell({home,token:TOKEN,amount:'5',dryRun:true},{...deps,walletFactory});
  await expect(run).rejects.toThrow(/not registered .* bundled Hartii launch factory/);
  expect(walletFactory).not.toHaveBeenCalled();
  expect(provider.createAccessList).not.toHaveBeenCalled();
 });
 it('tokenValueQuai refuses an unverified curve instead of quoting it', async () => {
  const {provider,deps}=harness({factoryCurve:addr(77)});
  const { tokenValueQuai } = await import('../src/tokenValue.js');
  await expect(tokenValueQuai(provider, TOKEN, 10n**18n, 'mainnet', deps)).rejects.toThrow(/not registered/);
 });
 it('accepts a curve when any bundled factory maps the token to it', async () => {
  const {deps}=harness();
  const r=await runBuy({home,token:TOKEN,quai:'1',dryRun:true},deps);
  expect(r.ok).toBe(true);
 });
});
describe('market input integrity',()=>{
 it('refuses Orchard before querying a mainnet-only API',async()=>{const fetchFn=vi.fn(); await expect(fetchTokens({}, {network:'orchard',fetchFn})).rejects.toThrow(/mainnet/i); expect(fetchFn).not.toHaveBeenCalled();});
 it.each([400,401,404,429,503])('rejects HTTP %s directory failures',async(status)=>{await expect(fetchTokens({}, {fetchFn:async()=>({status,json:async()=>({items:[]})})})).rejects.toThrow();});
 it('rejects malformed directory responses',async()=>{await expect(fetchTokens({}, {fetchFn:async()=>({status:200,json:async()=>({})})})).rejects.toThrow();});
 it('refuses unavailable partial directory data',async()=>{await expect(fetchTokens({}, {fetchFn:async()=>({status:200,json:async()=>({items:[],partial:true,note:'DB offline'})})})).rejects.toThrow(/partial|unavailable/i);});
 it('rejects a mismatched address from token lookup',async()=>{await expect(fetchToken(TOKEN,{fetchFn:async()=>({status:200,json:async()=>({token:{address:CURVE}})})})).rejects.toThrow(/match/i);});
 it.each(['100','-1','abc','1.001','1e1',' ','3%%'])('rejects unsafe slippage %s',s=>{expect(()=>parseSlippageBps(s)).toThrow();});
});
