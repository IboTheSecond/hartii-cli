import { it,expect,vi } from 'vitest';
import { mkdtempSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { FileJournal } from '../vendor/packages/hartii-trader/src/index.mjs';
import { TRADER_RELEASE_ID } from '../src/trader/release.js';
import { relayEventBatch } from '../src/trader/runtime.js';
it('limits telemetry by UTF-8 request bytes as well as event count',()=>{
  const events=Array.from({length:100},(_,i)=>({seq:i+1,data:{rationale:'界'.repeat(1000)}}));
  const batch=relayEventBatch(events);expect(batch.length).toBeGreaterThan(0);expect(batch.length).toBeLessThan(100);
  expect(Buffer.byteLength(JSON.stringify({events:batch,releaseId:TRADER_RELEASE_ID}),'utf8')).toBeLessThanOrEqual(60000);
  expect(batch.map(e=>e.seq)).toEqual(Array.from({length:batch.length},(_,i)=>i+1));
});
it('replays every durable unsent event beyond the 1000-event activity cache without release substitution',async()=>{
  const home=mkdtempSync(join(tmpdir(),'hartii-trader-outbox-')),now=Date.now(),runnerId='12345678-1234-1234-1234-123456789012',published=[];
  const deps={env:{HARTII_HOME:home},write:vi.fn(),writeErr:vi.fn(),clock:()=>now,passwordDeps:{env:{HARTII_PASSWORD:'synthetic-credential-password'}},secretPromptFn:async()=>'a'.repeat(64),
    walletFactory:vi.fn(()=>{throw Error('No transaction wallet');}),market:{snapshot:async()=>({at:now,cashWei:null,positions:[],candidates:[]})},
    fetchFn:async(url,request)=>{const body=JSON.parse(request.body);let result;
      if(url.endsWith('/pair/redeem'))result={runnerId,confirmationRequired:true};
      else if(url.endsWith('/events')){expect(body.releaseId).toBe(TRADER_RELEASE_ID);expect(body.events.length).toBeLessThanOrEqual(100);published.push(...body.events);result={accepted:body.events.length,lastSeq:body.events.at(-1).seq};}
      else if(url.endsWith('/qualification/read'))result={consecutiveDays:0};
      else if(url.endsWith('/qualification/observe'))result={accepted:true};
      else result={ok:true,controls:{paused:false}};
      return {ok:true,status:200,json:async()=>result};
    }};
  expect(await main(['trader','init','--pair','--owner','0x0010000000000000000000000000000000000001','--trading-address','0x0010000000000000000000000000000000000002','--capital','100','--max-per-tx','10','--max-per-day','30','--max-fee','1','--json'],deps)).toBe(0);
  const outbox=await FileJournal.open(join(home,'trader/default/telemetry.journal.jsonl'));
  await outbox.append({type:'relay.release',at:now,data:{releaseId:TRADER_RELEASE_ID}});
  for(let seq=1;seq<=1050;seq++)await outbox.append({type:'relay.event',at:now,data:{schemaVersion:1,id:`offline-${seq}`,runnerId,seq,at:now,mode:'paper',type:'heartbeat',data:{state:'holding'}}});
  await outbox.close();
  expect(await main(['trader','paper','--once','--json'],deps)).toBe(0);
  expect(published.map(e=>e.seq)).toEqual(Array.from({length:1053},(_,i)=>i+1));
  expect(JSON.parse(readFileSync(join(home,'trader/default/activity.json'),'utf8'))).toHaveLength(1000);
  expect(JSON.parse(readFileSync(join(home,'trader/default/relay-cursor.json'),'utf8')).lastSeq).toBe(1053);
  expect(deps.walletFactory).not.toHaveBeenCalled();
},120000);
