import { it, expect, vi } from 'vitest';
import { mkdtempSync, existsSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { main } from '../src/cli.js';
import { Wallet } from 'quais';
import { generateMnemonicAccount } from '../src/keystore.js';
import { createPolicy,canonicalPolicyMessage,FileJournal } from '../vendor/packages/hartii-trader/src/index.mjs';
import { createTraderReader,publicSnapshot } from '../src/trader/readers.js';
function fixture() {
  const home=mkdtempSync(join(tmpdir(),'hartii-trader-commands-'));
  const deps={env:{HARTII_HOME:home},write:vi.fn(),writeErr:vi.fn(),walletFactory:vi.fn(()=>{throw Error('NO KEY');}),
    fetchFn:vi.fn(()=>{throw Error('NO NETWORK');}),providerFactory:vi.fn(()=>{throw Error('NO RPC');})};
  return {home,deps};
}
it('runs a complete keyless offline paper cycle with honest demo and qualification labels',async()=>{
  const {home,deps}=fixture();
  expect(await main(['trader','paper','--demo','--once','--json'],deps)).toBe(0);
  const result=JSON.parse(deps.write.mock.calls.at(-1)[0]);
  expect(result).toMatchObject({ok:true,demo:true,snapshot:{mode:'paper',qualification:{days:0,liveEnabled:false}}});
  expect(result.snapshot.latestDecision.rationale).toBe('no-qualified-candidates');
  expect(deps.walletFactory).not.toHaveBeenCalled(); expect(deps.fetchFn).not.toHaveBeenCalled();
  expect(deps.providerFactory).not.toHaveBeenCalled(); expect(readdirSync(home)).toEqual([]);
});
it('uninitialized status is honest and does not construct a wallet',async()=>{
  const {home,deps}=fixture();
  expect(await main(['trader','status','--json'],deps)).toBe(0);
  expect(JSON.parse(deps.write.mock.calls.at(-1)[0])).toMatchObject({configured:false,snapshot:null});
  expect(existsSync(join(home,'trader'))).toBe(false);
  expect(deps.walletFactory).not.toHaveBeenCalled();
});
it('initializes public metadata only and requires explicit absolute paper budgets',async()=>{
  const {home,deps}=fixture();
  const init=['trader','init','--owner','0x0010000000000000000000000000000000000001','--trading-address','0x0010000000000000000000000000000000000002','--capital','100','--max-per-tx','10','--max-per-day','30','--max-fee','1','--json'];
  expect(await main(init,deps)).toBe(0);
  expect(existsSync(join(home,'trader','default','profile.json'))).toBe(true);
  expect(existsSync(join(home,'keystore'))).toBe(false);
  expect(deps.walletFactory).not.toHaveBeenCalled();
  expect(await main(['trader','run','--once','--json'],deps)).toBe(1);
  expect(deps.writeErr.mock.calls.at(-1)[0]).toMatch(/arm|policy/i);
});
it('the real command adapter preserves its profile object and needs no key for public Paper reads',async()=>{
  const {deps}=fixture();
  expect(await main(['trader','init','--owner','0x0010000000000000000000000000000000000001','--trading-address','0x0010000000000000000000000000000000000002','--capital','100','--max-per-tx','10','--max-per-day','30','--max-fee','1','--json'],deps)).toBe(0);
  const provider={getNetwork:async()=>({chainId:9n}),getBalance:vi.fn(async()=>0n),destroy:vi.fn()};
  const providerFactory=vi.fn(()=>provider),fetchFn=vi.fn(async()=>({status:200,json:async()=>({items:[],nextCursor:null})}));
  expect(await main(['trader','paper','--profile','default','--once','--json'],{...deps,providerFactory,fetchFn})).toBe(0);
  expect(providerFactory).toHaveBeenCalledTimes(1);expect(provider.getBalance).toHaveBeenCalledWith('0x0010000000000000000000000000000000000002');
  expect(deps.walletFactory).not.toHaveBeenCalled();expect(provider.destroy).toHaveBeenCalledTimes(1);
});
it('rejects secret argument flags and path traversal before creating state',async()=>{
  const {home,deps}=fixture();
  expect(await main(['trader','init','--api-key','SENSITIVE','--json'],deps)).toBe(1);
  expect(deps.writeErr.mock.calls.at(-1)[0]).not.toContain('SENSITIVE');
  expect(await main(['trader','status','--profile','../bad','--json'],deps)).toBe(1);
  expect(await main(['trader','paper','--demo','--once','--network','orchard','--json'],deps)).toBe(1);
  expect(readdirSync(home)).toEqual([]);
});
it('requires typed local ARM and the ownership wallet signature, without importing its key',async()=>{
  const {home,deps}=fixture(),owner=generateMnemonicAccount(),now=Date.now();
  const init=['trader','init','--owner',owner.address,'--trading-address','0x0010000000000000000000000000000000000002','--capital','100','--max-per-tx','10','--max-per-day','30','--max-fee','1','--json'];
  expect(await main(init,deps)).toBe(0);
  const profile=JSON.parse(readFileSync(join(home,'trader/default/profile.json'),'utf8'));
  const policy=createPolicy({...profile.budgets,owner:profile.owner,tradingWallet:profile.tradingWallet,runnerId:profile.runnerId,nonce:'1',issuedAt:now,expiresAt:now+60000});
  const signature=await new Wallet(owner.privateKey).signMessage(canonicalPolicyMessage(policy));
  const file=join(home,'reviewed.json');writeFileSync(file,JSON.stringify({policy,signature}));
  expect(await main(['trader','arm','--policy-file',file,'--yes','--json'],{...deps,confirmTypedFn:async()=>''})).toBe(1);
  expect(existsSync(join(home,'trader/default/armed-policy.json'))).toBe(false);
  expect(await main(['trader','arm','--policy-file',file,'--json'],{...deps,confirmTypedFn:async()=>'ARM'})).toBe(0);
  const armed=JSON.parse(deps.write.mock.calls.at(-1)[0]);expect(armed).toMatchObject({armed:true,liveEnabled:false});
  expect(deps.walletFactory).not.toHaveBeenCalled();expect(deps.fetchFn).not.toHaveBeenCalled();
  const journal=await FileJournal.open(join(home,'trader/default/live.journal.jsonl'));
  try {expect(await main(['trader','arm','--policy-file',file,'--json'],{...deps,confirmTypedFn:async()=>'ARM'})).toBe(1);}
  finally {await journal.close();}
  expect(await main(['trader','reconcile','--json'],{...deps,clock:()=>now+3600000})).toBe(0);
  expect(deps.walletFactory).not.toHaveBeenCalled();expect(deps.fetchFn).not.toHaveBeenCalled();
  writeFileSync(file,JSON.stringify({policy:{...policy,maxPerTxWei:'11000000000000000000'},signature}));
  expect(await main(['trader','arm','--policy-file',file,'--json'],{...deps,confirmTypedFn:async()=>'ARM'})).toBe(1);
},120000);
it('persists keyless paper results, reads them through the MCP seam, and latches pause across restart',async()=>{
  const {home,deps}=fixture(),now=Date.now();
  expect(await main(['trader','init','--owner','0x0010000000000000000000000000000000000001','--trading-address','0x0010000000000000000000000000000000000002','--capital','100','--max-per-tx','10','--max-per-day','30','--max-fee','1','--json'],deps)).toBe(0);
  const market={snapshot:async()=>({at:now,cashWei:'0',positions:[],candidates:[]})};
  expect(await main(['trader','paper','--once','--json'],{...deps,market,clock:()=>now})).toBe(0);
  const reader=createTraderReader({home},{clock:()=>now});
  expect(reader.status().snapshot).toMatchObject({mode:'paper',finances:{equityWei:'100000000000000000000'}});
  expect(reader.activity({limit:3}).events.length).toBeGreaterThan(0);
  expect(reader.pause().latched).toBe(true);
  expect(await main(['trader','paper','--once','--json'],{...deps,market,clock:()=>now+1000})).toBe(0);
  expect(reader.status().snapshot.state).toBe('paused');expect(deps.walletFactory).not.toHaveBeenCalled();
  expect(Object.keys(reader)).toEqual(['status','limits','activity','pause']);
});
it('public snapshot projection strips secret bags and arbitrary nested payloads',()=>{
  const snapshot=publicSnapshot({schemaVersion:1,chainId:9,mode:'paper',finances:{equityWei:'1',apiKey:'SECRET'},positions:[{id:'a',units:'1',privateKey:'SECRET'}],latestDecision:{rationale:{rawPrompt:'SECRET'},evidence:[{apiKey:'SECRET'}],guardResults:[]},blockers:[],qualification:{days:0,requiredDays:7,liveEnabled:false},credentials:{key:'SECRET'}});
  expect(JSON.stringify(snapshot)).not.toContain('SECRET');
});
it('pairs through a hidden prompt, signs telemetry, and persists remote pause locally',async()=>{
  const {home,deps}=fixture(),calls=[],now=Date.now();
  const fetchFn=async(url,request)=>{
    const body=JSON.parse(request.body);calls.push({url,request,body});
    return {ok:true,status:200,json:async()=>url.endsWith('/pair/redeem')?{runnerId:'12345678-1234-1234-1234-123456789012',confirmationRequired:true}:url.endsWith('/events')?{accepted:body.events.length,lastSeq:body.events.at(-1).seq}:url.endsWith('/qualification/read')?{consecutiveDays:0}:url.endsWith('/qualification/observe')?{accepted:true}:{ok:true,controls:{paused:true}}};
  };
  const local={...deps,fetchFn,secretPromptFn:async()=> 'a'.repeat(64),passwordDeps:{env:{HARTII_PASSWORD:'synthetic-credential-password'},writeErr:()=>{}},clock:()=>now};
  expect(await main(['trader','init','--pair','--owner','0x0010000000000000000000000000000000000001','--trading-address','0x0010000000000000000000000000000000000002','--capital','100','--max-per-tx','10','--max-per-day','30','--max-fee','1','--json'],local)).toBe(0);
  expect(readFileSync(join(home,'trader/default/credentials.json'),'utf8')).not.toContain('privateKey');
  const market={snapshot:async()=>({at:now,cashWei:null,positions:[],candidates:[]})};
  expect(await main(['trader','paper','--once','--json'],{...local,market})).toBe(0);
  expect(calls[0].url).toBe('https://hartiilabs.com/api/trader/pair/redeem');
  expect(calls.some(c=>c.url.endsWith('/heartbeat'))).toBe(true);
  expect(calls.some(c=>c.url.endsWith('/events'))).toBe(true);
  expect(calls.filter(c=>!c.url.endsWith('/pair/redeem')).every(c=>c.request.headers['x-trader-signature'])).toBe(true);
  expect(calls[1].request.headers['x-trader-signature']).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(createTraderReader({home},{clock:()=>now}).status().snapshot.state).toBe('paused');
  expect(deps.walletFactory).not.toHaveBeenCalled();
});
it('refuses to take the local ARM confirmation from a pipe or any non-terminal stdin',async()=>{
  const {home,deps}=fixture(),owner=generateMnemonicAccount(),now=Date.now();
  expect(await main(['trader','init','--owner',owner.address,'--trading-address','0x0010000000000000000000000000000000000002','--capital','100','--max-per-tx','10','--max-per-day','30','--max-fee','1','--json'],deps)).toBe(0);
  const profile=JSON.parse(readFileSync(join(home,'trader/default/profile.json'),'utf8'));
  const policy=createPolicy({...profile.budgets,owner:profile.owner,tradingWallet:profile.tradingWallet,runnerId:profile.runnerId,nonce:'1',issuedAt:now,expiresAt:now+60000});
  const signature=await new Wallet(owner.privateKey).signMessage(canonicalPolicyMessage(policy));
  const file=join(home,'reviewed.json');writeFileSync(file,JSON.stringify({policy,signature}));
  const piped=new PassThrough();piped.write('ARM\n');
  expect(await main(['trader','arm','--policy-file',file,'--json'],{...deps,stdin:piped,stdout:new PassThrough()})).toBe(1);
  expect(existsSync(join(home,'trader/default/armed-policy.json'))).toBe(false);
  expect(deps.write.mock.calls.map(c=>c[0]).join('')+deps.writeErr.mock.calls.map(c=>c[0]).join('')).toMatch(/interactive terminal/);
  const terminal=Object.assign(new PassThrough(),{isTTY:true});terminal.write('ARM\n');
  expect(await main(['trader','arm','--policy-file',file,'--json'],{...deps,stdin:terminal,stdout:new PassThrough()})).toBe(0);
  expect(existsSync(join(home,'trader/default/armed-policy.json'))).toBe(true);
},120000);
