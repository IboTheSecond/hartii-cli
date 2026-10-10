import { it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { runLocalTrader } from '../src/trader/runtime.js';
async function fixture({blockedEvents=false,remotePause=false}={}) {
  const home=mkdtempSync(join(tmpdir(),'hartii-phase-proof-')),calls=[];let entered,finish,isEntered=false;
  const started=new Promise(resolve=>{entered=resolve;}),held=new Promise(resolve=>{finish=resolve;});
  const deps={env:{HARTII_HOME:home},write:vi.fn(),writeErr:vi.fn(),telemetryIntervalMs:20,
    passwordDeps:{env:{HARTII_PASSWORD:'synthetic-trader-password'}},secretPromptFn:async()=>'a'.repeat(64),
    walletFactory:vi.fn(()=>{throw Error('No transaction wallet');}),
    market:{snapshot:async({now})=>{isEntered=true;entered();await held;return {at:Date.now(),cashWei:null,positions:[],candidates:[]};},close:vi.fn()},
    fetchFn:async(url,request)=>{const body=JSON.parse(request.body);calls.push({url,body});
      if(url.endsWith('/events') && blockedEvents)throw Error('Receipt awaiting hosted finality');
      const result=url.endsWith('/pair/redeem')?{runnerId:'12345678-1234-1234-1234-123456789012',confirmationRequired:true}:url.endsWith('/events')?{accepted:body.events.length,lastSeq:body.events.at(-1).seq}:url.endsWith('/qualification/read')?{consecutiveDays:0}:{ok:true,controls:{paused:remotePause && isEntered}};
      return {ok:true,status:200,json:async()=>result};
    }};
  expect(await main(['trader','init','--pair','--owner','0x0010000000000000000000000000000000000001','--trading-address','0x0010000000000000000000000000000000000002','--capital','100','--max-per-tx','10','--max-per-day','30','--max-fee','1','--json'],deps)).toBe(0);
  calls.length=0;return {home,deps,calls,started,finish};
}
it('sends phases and periodic heartbeats before a slow cycle completes, and stops after return',async()=>{
  const f=await fixture(),running=runLocalTrader({sub:'paper',mode:'paper',once:true},f.deps);
  await f.started;
  try {
    await expect.poll(()=>f.calls.filter(c=>c.url.endsWith('/heartbeat')).length,{timeout:3000}).toBeGreaterThanOrEqual(2);
    // Heartbeats precede event delivery in each serialized flush. Wait for both independently.
    await expect.poll(()=>f.calls.filter(c=>c.url.endsWith('/events')).flatMap(c=>c.body.events).some(e=>e.type==='cycle.started'),{timeout:3000}).toBe(true);
    expect(f.calls.some(c=>c.body.snapshot?.state==='observing')).toBe(true);
  }finally{f.finish();}
  await running;const count=f.calls.length;await new Promise(resolve=>setTimeout(resolve,80));expect(f.calls).toHaveLength(count);
  expect(f.deps.walletFactory).not.toHaveBeenCalled();expect(f.deps.market.close).toHaveBeenCalledOnce();
});
it('receives a remote pause while events are blocked and the current market read is still awaiting',async()=>{
  const f=await fixture({blockedEvents:true,remotePause:true}),snapshots=[];
  const running=runLocalTrader({sub:'paper',mode:'paper',once:true},{...f.deps,onSnapshot:s=>snapshots.push(s)});
  await f.started;
  try {await expect.poll(()=>snapshots.some(s=>s.state==='paused'),{timeout:3000}).toBe(true);}
  finally {f.finish();}
  const result=await running;expect(result.snapshot.state).toBe('paused');expect(f.deps.walletFactory).not.toHaveBeenCalled();
});
it('an abort request latches local pause before a slow cycle can resume',async()=>{
  const f=await fixture(),controller=new AbortController();
  const running=runLocalTrader({sub:'paper',mode:'paper',once:true},{...f.deps,signal:controller.signal});
  await f.started;controller.abort();f.finish();
  const result=await running;expect(result.snapshot.state).toBe('paused');
  expect(f.deps.walletFactory).not.toHaveBeenCalled();
});
