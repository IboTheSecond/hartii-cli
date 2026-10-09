import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { saveConfig } from '../src/config.js';
import { buildMcpServer, resolveMcpContext } from '../src/mcp/server.js';
const address = '0x0010000000000000000000000000000000000001';
let home;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(),'hartii-mcp-profile-'));
  mkdirSync(join(home,'keystore'));
  writeFileSync(join(home,'keystore','test.json'),JSON.stringify({address:address.slice(2)}));
  saveConfig(home,{network:'mainnet',currentWallet:'test',limits:{perTxQuai:'100',dailyQuai:'500'}});
});
afterEach(() => rmSync(home,{recursive:true,force:true}));
async function connect(over={}) {
  const {server}=buildMcpServer({home,env:{},...over});
  const [a,b]=InMemoryTransport.createLinkedPair();
  const client=new Client({name:'offline-test',version:'1'});
  await server.connect(a); await client.connect(b); return client;
}

describe('wallet MCP capability contract',()=>{
  it('never reads an environment key in read mode, even with keyEnv configured',async()=>{
    const env=Object.defineProperty({},'TEST_SECRET',{get(){throw Error('Read-only accessed a key');}});
    const client=await connect({keyEnv:'TEST_SECRET',env});
    try {
      const result=await client.callTool({name:'hartii_wallet',arguments:{}});
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent.address.toLowerCase()).toBe(address);
      expect(result.structuredContent).toEqual(JSON.parse(result.content[0].text));
      expect(result.structuredContent._hartii).toMatchObject({schemaVersion:1,capabilityVersion:1,authority:'read-only',mode:'read-only',chainId:9,chainVerified:false});
    } finally {await client.close();}
  });
  it('publishes output schemas and conservative annotations for reviewed writes',async()=>{
    const client=await connect({allowWrites:true});
    try {
      const tools=(await client.listTools()).tools;
      for(const t of tools) expect(t.outputSchema.required).toContain('_hartii');
      expect(tools.find(t=>t.name==='hartii_wallet').annotations).toMatchObject({readOnlyHint:true,destructiveHint:false,openWorldHint:false});
      expect(tools.find(t=>t.name==='hartii_send').annotations).toMatchObject({readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:true});
      const wallet=await client.callTool({name:'hartii_wallet',arguments:{}});
      expect(wallet.structuredContent._hartii).toMatchObject({authority:'reviewed-wallet',mode:'read-only'});
    } finally {await client.close();}
  });
  it('identifies Orchard from config without claiming a verified RPC connection',async()=>{
    saveConfig(home,{network:'orchard',currentWallet:'test',limits:{perTxQuai:'100',dailyQuai:'500'}});
    const client=await connect();
    try {
      const r=await client.callTool({name:'hartii_wallet',arguments:{}});
      expect(r.structuredContent._hartii).toMatchObject({chainId:15000,network:'orchard',chainVerified:false});
    } finally {await client.close();}
  });
  it('keeps the startup network and reported chain aligned if local config changes later',async()=>{
    const client=await connect();
    try {
      saveConfig(home,{network:'orchard',currentWallet:'test',limits:{perTxQuai:'100',dailyQuai:'500'}});
      const r=await client.callTool({name:'hartii_wallet',arguments:{}});
      expect(r.structuredContent.network).toBe('mainnet');
      expect(r.structuredContent._hartii).toMatchObject({chainId:9,network:'mainnet'});
    } finally {await client.close();}
  });
});

describe('local trader read tools',()=>{
  for (const mode of ['success', 'error']) {
    it(`sanitizes punctuated URL credentials before legacy cleaning in ${mode} responses`, async () => {
      const unsafe = 'https://user:prefix)fixture-wallet-password@rpc.invalid/v3/fixture.path.secret.long';
      const publicUrl = `https://quaiscan.io/tx/0x${'ab'.repeat(32)}`;
      const traderReader = { status: async () => {
        if (mode === 'error') throw new Error(`RPC failed: ${unsafe}`);
        return { configured: true, detail: { url: unsafe, [unsafe]: unsafe }, publicUrl };
      } };
      const client = await connect({ traderReader });
      try {
        const result = await client.callTool({ name: 'hartii_trader_status', arguments: {} });
        expect(result.isError === true).toBe(mode === 'error');
        expect(JSON.stringify(result.structuredContent)).not.toContain('fixture-wallet-password');
        expect(JSON.stringify(result.structuredContent)).not.toContain('fixture.path.secret.long');
        expect(result.content[0].text).not.toContain('fixture-wallet-password');
        expect(result.structuredContent).toEqual(JSON.parse(result.content[0].text));
        if (mode === 'success') expect(result.structuredContent.publicUrl).toBe(publicUrl);
      } finally { await client.close(); }
    });
  }
  it('exposes only status, limits and activity with closed-world read annotations',async()=>{
    const status={configured:true,schemaVersion:1,chainId:9,mode:'paper',state:'paused',finances:{equityWei:'9007199254740993000'},positions:[{token:address,symbol:'TEST'}]};
    const traderReader={status:vi.fn(async()=>status),limits:vi.fn(async()=>({configured:true,policy:null})),activity:vi.fn(async({after,limit})=>({events:[],nextCursor:after??null,limit}))};
    const client=await connect({traderReader});
    try {
      const tools=(await client.listTools()).tools.filter(t=>t.name.startsWith('hartii_trader_'));
      expect(tools.map(t=>t.name).sort()).toEqual(['hartii_trader_activity','hartii_trader_limits','hartii_trader_status']);
      for(const t of tools) expect(t.annotations).toMatchObject({readOnlyHint:true,destructiveHint:false,openWorldHint:false});
      const result=await client.callTool({name:'hartii_trader_status',arguments:{}});
      expect(result.structuredContent).toMatchObject(status);
      expect(result.structuredContent._hartii).toMatchObject({authority:'read-only',mode:'read-only'});
      await client.callTool({name:'hartii_trader_limits',arguments:{}});
      await client.callTool({name:'hartii_trader_activity',arguments:{after:4,limit:10}});
      expect(traderReader.activity).toHaveBeenCalledWith({after:4,limit:10});
      expect((await client.callTool({name:'hartii_trader_status',arguments:{arm:true}})).isError).toBe(true);
    } finally {await client.close();}
  });
  it('returns not configured instead of fabricated empty financial history',async()=>{
    const client=await connect();
    try {
      for(const name of ['hartii_trader_status','hartii_trader_limits','hartii_trader_activity']) {
        const result=await client.callTool({name,arguments:{}});
        expect(result.structuredContent).toMatchObject({configured:false,reason:'trader-reader-not-configured'});
        expect(result.structuredContent).not.toHaveProperty('events');
      }
    } finally {await client.close();}
  });
  it('passes the injected reader through context resolution',()=>{
    const traderReader={status:()=>({})};
    expect(resolveMcpContext({home,traderReader}).traderReader).toBe(traderReader);
  });
});
