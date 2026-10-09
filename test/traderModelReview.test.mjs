import { it,expect,vi } from 'vitest';
import { mkdtempSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NOW,OWNER,WALLET,candidate } from '../vendor/packages/hartii-trader/test/fixtures.mjs';
import { runLocalTrader } from '../src/trader/runtime.js';
import { profilePaths,writePrivateJson } from '../src/trader/storage.js';
import { exportTraderJournals } from '../src/trader/readers.js';
it.each([true,false])('runs a separately prompted critique with one budget and exports real model/financial history (veto=%s)',async veto=>{
  const home=mkdtempSync(join(tmpdir(),'hartii-two-pass-')),paths=profilePaths({home}),bodies=[];
  writePrivateJson(paths.profile,{schemaVersion:1,profile:'default',chainId:9,runnerId:'model-proof',owner:OWNER,tradingWallet:WALLET,
    budgets:{capitalWei:'100000',maxPerTxWei:'10000',maxPerDayWei:'30000',maxFeeWei:'100'},
    model:{provider:'openai',model:'fixture-model',keyEnv:'SYNTHETIC_KEY',pricing:{inputMicrousdPerMillion:'1000',outputMicrousdPerMillion:'1000',cacheReadMicrousdPerMillion:'1000',cacheWriteMicrousdPerMillion:'1000'},maxInputTokens:5000,maxOutputTokens:1000}});
  const deps={env:{HARTII_HOME:home,SYNTHETIC_KEY:'synthetic-model-key'},clock:()=>NOW,walletFactory:vi.fn(()=>{throw Error('No native wallet');}),
    market:{snapshot:async()=>({at:NOW,cashWei:null,positions:[],candidates:[candidate()]}),quote:async()=>({at:NOW,impactBps:25,roundTripCostBps:200,gasWei:'10',exitGasWei:'20',minOutputWei:'900',unitPriceWei:'10',tokenDecimals:0,feeBps:100})},
    fetchFn:async(url,request)=>{expect(url).toBe('https://api.openai.com/v1/responses');bodies.push(JSON.parse(request.body));
      const reject=veto && bodies.length===2;
      return {ok:true,json:async()=>({status:'completed',usage:{input_tokens:100,output_tokens:50},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({action:reject?'hold':'rank',rankedIds:reject?[]:['fixture-token'],rationale:reject?'Critique rejected risk.':'Qualified numeric facts.',veto:reject})}]}]})};
    }};
  const result=await runLocalTrader({sub:'paper',mode:'paper',once:true},deps);
  expect(bodies).toHaveLength(2);expect(bodies[1].instructions).toMatch(/independent.*critique/i);
  expect(result.snapshot.positions).toHaveLength(veto?0:1);
  if(veto)expect(result.snapshot.latestDecision.outcome).toBe('held');
  expect(deps.walletFactory).not.toHaveBeenCalled();
  const exported=await exportTraderJournals({home,mode:'paper'},deps),raw=readFileSync(exported.savedTo,'utf8');
  expect(raw).toContain('model.state');expect(raw).toContain('ledger.state');expect(raw).not.toContain('synthetic-model-key');
});
