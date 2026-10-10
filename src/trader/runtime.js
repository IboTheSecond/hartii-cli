import { setTimeout as delay } from 'node:timers/promises';
import { verifyMessage } from 'quais';
import { TraderRunner, FileJournal, MemoryJournal, ModelBudget, createOpenAIProvider, createAnthropicProvider, createPolicy, validatePolicy, canonicalPolicyMessage } from '../../vendor/packages/hartii-trader/src/index.mjs';
import { profilePaths, requireProfile, readPrivateJson, writePrivateJson, pauseRequested,readPauseControl,requestPause,decryptCredentials,TraderCliError } from './storage.js';
import { publicSnapshot, publicEvent } from './readers.js';
import { createRealMarket } from './market.js';
import { createLiveExecutor } from './executor.js';
import { createRelay } from './relay.js';
import { resolvePassword } from '../prompt.js';
import { securePath } from '../secureFiles.js';
import { resolveWalletAddress } from '../commands/balance.js';
import { createHostedServices } from './services.js';
import { TRADER_RELEASE_ID } from './release.js';
import { readFundingTransaction } from './funding.js';
import { createTelemetryPump } from './telemetry.js';

export function verifyOwnerPolicy({policy,signature,message=canonicalPolicyMessage(policy)}) {
  let owner;
  try { owner=verifyMessage(message,signature); }catch {throw new TraderCliError('Owner policy signature is invalid.');}
  if(owner.toLowerCase()!==policy.owner.toLowerCase())throw new TraderCliError('Owner policy signature does not match the ownership wallet.');
  return {valid:true,owner,policyMessage:message};
}
export function localPolicy(profile,now) {
  return createPolicy({owner:profile.owner,tradingWallet:profile.tradingWallet,runnerId:profile.runnerId,nonce:String(now),issuedAt:now,expiresAt:now+86400000,...profile.budgets});
}
export const demoProfile=()=>({schemaVersion:1,profile:'demo',chainId:9,runnerId:'offline-demo',owner:'0x0010000000000000000000000000000000000001',tradingWallet:'0x0010000000000000000000000000000000000002',
  budgets:{capitalWei:'100000000000000000000',maxPerTxWei:'10000000000000000000',maxPerDayWei:'30000000000000000000',maxFeeWei:'1000000000000000000'}});
export function relayEventBatch(events) {
  const batch=[];
  for(const event of events.slice(0,100)){
    if(Buffer.byteLength(JSON.stringify({events:[...batch,event],releaseId:TRADER_RELEASE_ID}),'utf8')>60000)break;
    batch.push(event);
  }
  if(events.length && !batch.length)throw new TraderCliError('A public event exceeds the hosted request limit; durable history is retained.');
  return batch;
}

async function localCredentials(paths,deps) {
  const encrypted=readPrivateJson(paths.credentials,{optional:true});
  if(!encrypted)return {};
  const password=await resolvePassword({...deps.passwordDeps,...deps.io?.passwordDeps,env:deps.passwordDeps?.env || deps.io?.passwordDeps?.env || deps.env || deps.io?.env,label:'Trader credential password: ',writeErr:deps.io?.writeErr});
  return decryptCredentials(encrypted,password);
}
export async function runLocalTrader(opts={},deps={}) {
  const clock=deps.clock || (()=>deps.now ? new Date(deps.now).getTime():Date.now()),now=clock(),demo=opts.demo===true;
  const paths=demo?null:profilePaths(opts,deps),profile=demo?demoProfile():requireProfile(paths);
  const mode=opts.mode || (opts.sub==='paper'?'paper':'live');
  if(demo && mode==='live')throw new TraderCliError('Demo cannot arm or run Live. Use trader paper --demo --once.');
  const envelope=mode==='live'?readPrivateJson(paths.policy,{optional:true}):null;
  if(mode==='live' && !envelope)throw new TraderCliError('Live requires trader arm with a locally reviewed owner-signed 24-hour policy file.');
  const recovery=opts.sub==='reconcile';
  const wallet=opts.wallet || profile.wallet;
  if(mode==='live' && !recovery) {
    if(!wallet)throw new TraderCliError('Select the dedicated encrypted wallet with --wallet <name>; its public address must match this trader profile.');
    if(resolveWalletAddress(paths.home,wallet).address.toLowerCase()!==profile.tradingWallet.toLowerCase())throw new TraderCliError('Selected wallet does not match the approved dedicated trading address.');
  }
  const policy=mode==='live'?validatePolicy(envelope.policy,{now:recovery?envelope.policy?.issuedAt:now,owner:profile.owner,tradingWallet:profile.tradingWallet,runnerId:profile.runnerId}):localPolicy(profile,now);
  if(mode==='live')verifyOwnerPolicy({...envelope,message:canonicalPolicyMessage(policy)});
  // Observe and Paper never call writeRuntime, resolveSender, or a transaction wallet factory.
  if(paths)securePath(paths.journal(mode),{regularFile:true});
  const journal=demo?new MemoryJournal():await FileJournal.open(paths.journal(mode));
  let outbox;
  try{if(paths){securePath(paths.outbox,{regularFile:true});outbox=await FileJournal.open(paths.outbox);}}
  catch(error){await journal.close();throw error;}
  let market,runner,telemetry,legacyRecovery=false,fundingResult=null; const controller=new AbortController();
  const stop=()=>{controller.abort();if(mode==='live' && paths)requestPause(paths,clock(),'local-pause');};
  deps.signal?.addEventListener('abort',stop,{once:true});
  if(deps.signal?.aborted)stop();
  if(!opts.once && !deps.signal)process.once('SIGINT',stop);
  try {
    if(paths)for(const [store,type] of [[journal,'host.release'],[outbox,'relay.release']]) {
      const records=await store.read(),record=records.find(r=>r.type===type);
      if(record && record.data?.releaseId!==TRADER_RELEASE_ID){if(!recovery)throw new TraderCliError('Stored trader history belongs to another release. Reconcile and sync with its original build; historical decisions cannot be relabeled for qualification.');legacyRecovery=true;}
      if(!record){if(records.some(r=>r.type==='runner.event' || r.type==='relay.event')){if(!recovery)throw new TraderCliError('Stored trader event history has no verified release provenance; explicit recovery is required.');legacyRecovery=true;}else await store.append({type,at:now,data:{releaseId:TRADER_RELEASE_ID}});}
    }
    if(mode==='live') {
      const lockedEnvelope=readPrivateJson(paths.policy);
      if(lockedEnvelope.signature!==envelope.signature || canonicalPolicyMessage(lockedEnvelope.policy)!==canonicalPolicyMessage(policy))throw new TraderCliError('Policy changed during startup. Restart with the newly approved policy.');
    }
    const credentials=demo?{}:await localCredentials(paths,deps);
    const relay=!demo && profile.pairing && credentials.device?createRelay({runnerId:profile.runnerId,device:credentials.device},{...deps,clock}):null;
    let decisionProvider,critiqueProvider;
    if(!demo && !recovery && profile.model) {
      const budget=await ModelBudget.open({journal,cycleCapMicrousd:policy.modelCycleMicrousd,dailyCapMicrousd:policy.modelDailyMicrousd});
      const config=profile.model;
      const key=credentials.modelKey || (config.keyEnv ? (deps.env || deps.io?.env || process.env)[config.keyEnv]:null);
      if(!key)throw new TraderCliError('Selected model key is unavailable; configure the named environment variable or encrypted local credential.');
      const factory=config.provider==='openai'?createOpenAIProvider:config.provider==='anthropic'?createAnthropicProvider:null;
      if(!factory)throw new TraderCliError('Select OpenAI or Anthropic explicitly.');
      const providerOptions={model:config.model,apiKey:key,pricing:config.pricing,maxInputTokens:config.maxInputTokens,maxOutputTokens:config.maxOutputTokens,budget,fetch:deps.fetchFn};
      decisionProvider=factory({...providerOptions,role:'rank'});critiqueProvider=factory({...providerOptions,role:'critique'});
    }
    market=demo || recovery?{snapshot:async({now})=>({at:now,cashWei:demo?profile.budgets.capitalWei:null,positions:[],candidates:[]})}:
      (deps.market || createRealMarket({...opts,profile,policy},{...deps,clock}));
    let durableEvents=outbox?(await outbox.read()).map(r=>publicEvent(r.data)).filter(Boolean):[];
    // Repair a crash between the engine's fsynced event and the outbox append without
    // inventing an event, dropping old history, or changing an already assigned cursor.
    const recorded=new Set(durableEvents.map(event=>event.id));
    for(const record of (legacyRecovery?[]:await journal.read()).filter(r=>r.type==='runner.event' && !recorded.has(r.data?.id))) {
      const event=publicEvent({...record.data,seq:(durableEvents.at(-1)?.seq || 0)+1});
      if(!event)continue;if(outbox)await outbox.append({type:'relay.event',at:event.at,data:event});durableEvents.push(event);recorded.add(event.id);
    }
    let localEvents=durableEvents.slice(-1000);
    const cursor=paths?readPrivateJson(paths.relayCursor,{optional:true})?.lastSeq || 0:0;
    let queued=durableEvents.filter(event=>event.seq>cursor),relayUnavailable=false,observedDays=null;
    const services=deps.traderServices || (relay?createHostedServices({relay,policy,paths},{...deps,clock}):{});
    const executor=mode==='live'?createLiveExecutor({...opts,tradingWallet:profile.tradingWallet,wallet},{...deps,clock,isPaused:()=>controller.signal.aborted || deps.signal?.aborted || pauseRequested(paths),
      onPrepared:services.onPrepared || deps.onPrepared,onReconciled:services.onReconciled || deps.onReconciled}):undefined;
    runner=new TraderRunner({mode,policy,journal,market,clock,initialBalanceWei:mode==='paper'?profile.budgets.capitalWei:undefined,decisionProvider,critiqueProvider,executor,
      signature:envelope?.signature,verifyPolicy:verifyOwnerPolicy,
      qualification:services.qualification,authority:services.authority,membership:services.membership,
      emit:async event=>{
        if(legacyRecovery)return; // Public recovery never relabels an older release's outbox.
        // Each mode has a distinct financial journal; telemetry uses a profile-wide cursor.
        const safeEvent=publicEvent({...event,seq:(localEvents.at(-1)?.seq || 0)+1});
        if(!safeEvent)return;
        if(outbox)await outbox.append({type:'relay.event',at:safeEvent.at,data:safeEvent});
        localEvents=[...localEvents,safeEvent].slice(-1000);queued.push(safeEvent);
        if(paths)writePrivateJson(paths.events,localEvents);
        telemetry?.notify();
      }});
    await runner.initialize();
    const applyPause=async()=>{
      if(!paths || !pauseRequested(paths))return;
      const control=readPauseControl(paths),state=runner.ledger.state;
      if(!state.pauseLatch && (state.resumeHistory || []).some(r=>r.controlPauseId===control.id))throw new TraderCliError('A durable local resume needs its final acknowledgement. Repeat trader arm; signing remains blocked.');
      if(state.pauseLatch)return;
      await runner.ledger.pause(control.at,control.reason);await runner.pause(control.reason);
    };
    function currentSnapshot() {
      const snapshot=publicSnapshot(runner.snapshot());
      snapshot.heartbeatAt=clock(); // Process heartbeat, not a refreshed financial mark.
      if(observedDays!==null)snapshot.qualification.days=observedDays;
      if(services.hasHostedPending?.()){snapshot.blockers=[...new Set([...snapshot.blockers,'hosted-reconciliation-pending'])];if(!['paused','pending'].includes(snapshot.state))snapshot.state='blocked';snapshot.qualification.liveEnabled=false;}
      if(mode==='live' && !services.qualification){if(!['paused','pending'].includes(snapshot.state))snapshot.state='blocked';snapshot.blockers=[...new Set([...snapshot.blockers,'release-not-qualified'])];snapshot.qualification.liveEnabled=false;}
      return snapshot;
    }
    async function flushTelemetry({drain=false}={}) {
      let failed=false;
      // A blocked event queue must not hide a remote pause or process heartbeat.
      if(relay) {
        try {
          const snapshot=currentSnapshot();
          const response=await relay.heartbeat({...snapshot,owner:snapshot.owner.toLowerCase(),tradingWallet:snapshot.tradingWallet.toLowerCase()});
          if(response.controls?.paused===true){if(!pauseRequested(paths))requestPause(paths,clock(),'remote-pause');await applyPause();}
        }catch{failed=true;}
        try {
          let batches=0;
          while(queued.length && (drain || batches++<4)) {
            const chunk=relayEventBatch(queued),ack=await relay.events(chunk);
            if(!Number.isSafeInteger(ack.lastSeq) || ack.lastSeq<chunk.at(-1).seq)throw new TraderCliError('Dashboard event acknowledgement is incomplete.');
            writePrivateJson(paths.relayCursor,{schemaVersion:1,lastSeq:ack.lastSeq});queued=queued.filter(event=>event.seq>ack.lastSeq);
            if(services.observe)for(const event of chunk.filter(e=>e.mode==='paper' && e.type==='decision'))await services.observe(event.seq);
          }
          if(mode==='paper' && services.qualification){const evidence=await services.qualification();if(!Number.isSafeInteger(evidence.consecutiveDays) || evidence.consecutiveDays<0)throw new TraderCliError('Qualification evidence is unavailable.');observedDays=evidence.consecutiveDays;}
        }catch{failed=true;}
        relayUnavailable=failed;
      }
      const snapshot=currentSnapshot();
      if(relayUnavailable)snapshot.blockers=[...new Set([...snapshot.blockers,'dashboard-unavailable'])];
      if(paths)writePrivateJson(paths.snapshot,snapshot);deps.onSnapshot?.(snapshot);
    }
    if(!recovery) {
      await applyPause();
      if(!demo){telemetry=createTelemetryPump({flush:flushTelemetry,intervalMs:deps.telemetryIntervalMs || 15000,onError:()=>{relayUnavailable=true;}});telemetry.start();}
    }
    if(opts.sub==='reconcile'){
      await runner.reconcile();
      if(opts.fundingTx) {
        const state=runner.ledger.state;
        const managedHashes=[state.pending?.txHash,...state.settled.map(r=>r.txHash),...(state.approvals || []).map(r=>r.txHash),...(state.cancelled || []).map(r=>r.txHash)].filter(Boolean);
        const evidence=await readFundingTransaction({...opts,txHash:opts.fundingTx,tradingWallet:profile.tradingWallet,managedHashes},{...deps,clock});
        fundingResult={txHash:opts.fundingTx,applied:await runner.ledger.reconcileFunding(evidence.flow,{observedCashWei:evidence.observedCashWei,checkedAt:evidence.checkedAt})};
      }
      if(services.reconcileHosted){try {await services.reconcileHosted();}catch { /* reported as a durable blocker below */ }}
    }
    else {
      const signal=deps.signal || controller.signal,intervalMs=deps.intervalMs || 60000;
      do {
        await applyPause();
        if(mode==='live' && services.reconcileHosted){try {await services.reconcileHosted();}catch { /* authority gate keeps signing blocked until canonical hosted settlement */ }}
        await runner.cycle();
        if(telemetry)telemetry.notify();
        else deps.onSnapshot?.(currentSnapshot());
        if(opts.once || signal.aborted)break;
        try {await delay(intervalMs,undefined,{signal});}catch(error){if(error.name!=='AbortError')throw error;}
      }while(!signal.aborted);
    }
    await telemetry?.stop();
    if(!demo && !recovery)await flushTelemetry({drain:true});
    const snapshot=publicSnapshot(runner.snapshot());
    if(observedDays!==null)snapshot.qualification.days=observedDays;
    if(recovery && runner.ledger.state.accountingUnknown){snapshot.blockers=[...new Set([...snapshot.blockers,'unexplained-accounting'])];if(!['paused','pending'].includes(snapshot.state))snapshot.state='blocked';}
    if(services.hasHostedPending?.()){snapshot.blockers=[...new Set([...snapshot.blockers,'hosted-reconciliation-pending'])];if(!['paused','pending'].includes(snapshot.state))snapshot.state='blocked';snapshot.qualification.liveEnabled=false;}
    if(relayUnavailable)snapshot.blockers=[...new Set([...snapshot.blockers,'dashboard-unavailable'])];
    if(mode==='live' && !services.qualification){if(!['paused','pending'].includes(snapshot.state))snapshot.state='blocked';snapshot.blockers=[...new Set([...snapshot.blockers,'release-not-qualified'])];}
    if(controller.signal.aborted || deps.signal?.aborted){snapshot.state='paused';snapshot.qualification.liveEnabled=false;snapshot.blockers=[...new Set([...snapshot.blockers,'process-stopped'])];}
    if(paths)writePrivateJson(paths.snapshot,snapshot);
    return {ok:recovery?!services.hasHostedPending?.() && (!opts.fundingTx || !runner.ledger.state.accountingUnknown):true,...(demo?{demo:true}:{}),...(fundingResult?{funding:fundingResult}:{}),snapshot,events:localEvents.slice(-100)};
  } finally {await telemetry?.stop();deps.signal?.removeEventListener('abort',stop);process.removeListener('SIGINT',stop);market?.close?.();await journal.close();await outbox?.close();}
}
