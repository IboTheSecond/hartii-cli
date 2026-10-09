import { randomUUID } from 'node:crypto';
import { existsSync,statSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { createPolicy, validatePolicy, canonicalPolicyMessage, parseUnits, FileJournal,TraderLedger } from '../../vendor/packages/hartii-trader/src/index.mjs';
import { assertCyprus1QuaiAddress } from '../address.js';
import { readVisibleInput, readHiddenInput, resolvePassword } from '../prompt.js';
import { generateMnemonicAccount, encryptAccount, writeKeystoreFile } from '../keystore.js';
import { resolveWalletAddress } from './balance.js';
import { profilePaths, loadProfile, requireProfile, readPrivateJson, writePrivateJson, encryptCredentials, decryptCredentials, requestPause, pauseRequested,readPauseControl,TraderCliError } from '../trader/storage.js';
import { readTraderStatus, exportTraderJournals } from '../trader/readers.js';
import { runLocalTrader, verifyOwnerPolicy } from '../trader/runtime.js';
import { createDevice, redeemDevice } from '../trader/relay.js';
import { unlockDevice,signTradingPolicy,createHostedServices,policyHash } from '../trader/services.js';
import { TRADER_RELEASE_ID } from '../trader/release.js';
import { safeTerminalText } from '../output.js';

const allowedFlags=new Set(['profile','once','observe','policy-file','funding-tx','owner','trading-address','create-wallet','capital','max-per-tx','max-per-day','max-fee','provider','model','model-key-env','pricing-file','pair','out','limit','after','stdin','mode','allow-insecure-rpc']);
function inputPolicy(profile,now) {return createPolicy({...profile.budgets,owner:profile.owner,tradingWallet:profile.tradingWallet,runnerId:profile.runnerId,nonce:String(now),issuedAt:now,expiresAt:now+86400000});}
function checkedFlags(flags={}) {
  if(Object.keys(flags).some(k=>!allowedFlags.has(k)))throw new TraderCliError('Unsupported trader option. Secrets must use a hidden prompt or an environment-variable name, never arguments.');
}
async function ask(value,label,deps) {
  if(value!==undefined && value!==null && value!=='')return value;
  if(!(deps.interactive ?? process.stdin.isTTY))throw new TraderCliError(`${label} is required; supply its named option or use an interactive terminal.`);
  return (deps.promptFn || readVisibleInput)(`${label}: `,deps.io || {});
}
async function initialize(opts,deps) {
  const paths=profilePaths(opts,deps),old=loadProfile(paths),clock=deps.clock || Date.now;
  if(old && !opts.pair)throw new TraderCliError('Trader profile already exists; it was not overwritten.');
  if(old && ['observe','paper','live'].some(mode=>existsSync(paths.journal(mode)) && statSync(paths.journal(mode)).size>0))throw new TraderCliError('Pair before starting the first cycle; an existing financial journal cannot change runner identity.');
  let profile=old;
  if(!profile) {
    const owner=assertCyprus1QuaiAddress(await ask(opts.owner,'Ownership wallet address (--owner)',deps));
    let tradingWallet=opts.tradingAddress,wallet=opts.wallet;
    if(opts.createWallet) {
      if(tradingWallet || wallet)throw new TraderCliError('Use either --create-wallet or an existing trading address/wallet.');
      wallet=`trader-${paths.name}`;
      const password=await resolvePassword({...deps.passwordDeps,...deps.io?.passwordDeps,env:deps.passwordDeps?.env || deps.io?.passwordDeps?.env || deps.env || deps.io?.env,label:'New dedicated wallet password: ',writeErr:deps.io?.writeErr});
      const account=generateMnemonicAccount();
      writeKeystoreFile(paths.home,wallet,await encryptAccount(account,password));tradingWallet=account.address;
    } else if(wallet) tradingWallet=resolveWalletAddress(paths.home,wallet).address;
    tradingWallet=assertCyprus1QuaiAddress(await ask(tradingWallet,'Dedicated trading wallet address (--trading-address)',deps));
    const budgets={};
    for(const [key,flag,value] of [['capitalWei','capital',opts.capital],['maxPerTxWei','max-per-tx',opts.maxPerTx],['maxPerDayWei','max-per-day',opts.maxPerDay],['maxFeeWei','max-fee',opts.maxFee]])budgets[key]=parseUnits(String(await ask(value,`Absolute QUAI budget (--${flag})`,deps)),18).toString();
    profile={schemaVersion:1,profile:paths.name,chainId:9,runnerId:randomUUID(),owner,tradingWallet,budgets,...(wallet?{wallet}:{})};
    inputPolicy(profile,clock());
  }
  let password;
  const credentialPassword=async()=>password ??= await resolvePassword({...deps.passwordDeps,...deps.io?.passwordDeps,env:deps.passwordDeps?.env || deps.io?.passwordDeps?.env || deps.env || deps.io?.env,label:'Local trader credential password (12+ characters): ',writeErr:deps.io?.writeErr});
  const oldCredentials=readPrivateJson(paths.credentials,{optional:true});
  const credentials=oldCredentials?decryptCredentials(oldCredentials,await credentialPassword()):{};
  if(opts.provider || opts.model || opts.pricingFile || opts.modelKeyEnv) {
    if(!['openai','anthropic'].includes(opts.provider) || typeof opts.model!=='string' || !opts.model.trim() || !opts.pricingFile)throw new TraderCliError('Model setup requires --provider openai|anthropic, --model and --pricing-file with explicit pricing and token ceilings.');
    const pricing=readPrivateJson(opts.pricingFile,{maximum:10000});
    const priceKeys=['inputMicrousdPerMillion','outputMicrousdPerMillion','cacheReadMicrousdPerMillion','cacheWriteMicrousdPerMillion'];
    if(Object.keys(pricing).some(k=>![...priceKeys,'maxInputTokens','maxOutputTokens'].includes(k)) || !priceKeys.every(k=>typeof pricing[k]==='string' && /^(0|[1-9][0-9]*)$/.test(pricing[k])) || !['maxInputTokens','maxOutputTokens'].every(k=>Number.isSafeInteger(pricing[k]) && pricing[k]>0))throw new TraderCliError('Pricing file requires all four integer microusd-per-million rates and positive maxInputTokens/maxOutputTokens.');
    if(opts.modelKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(opts.modelKeyEnv))throw new TraderCliError('--model-key-env must be an environment variable name.');
    profile.model={provider:opts.provider,model:opts.model,pricing:Object.fromEntries(priceKeys.map(k=>[k,pricing[k]])),maxInputTokens:pricing.maxInputTokens,maxOutputTokens:pricing.maxOutputTokens,...(opts.modelKeyEnv?{keyEnv:opts.modelKeyEnv}:{})};
    if(!opts.modelKeyEnv)credentials.modelKey=await (deps.secretPromptFn || readHiddenInput)('Model API key (stored encrypted): ',deps.io || {});
  }
  let pairing;
  if(opts.pair) {
    credentials.device ??= createDevice();
    const code=await (deps.secretPromptFn || readHiddenInput)('Dashboard pairing code: ',deps.io || {});
    // Persist possession before redeeming the one-use code. Failed network or interrupted
    // owner confirmation cannot discard the only credential for a pending pairing.
    writePrivateJson(paths.credentials,encryptCredentials(credentials,await credentialPassword()),{replace:!!oldCredentials});
    pairing=await redeemDevice(code,credentials.device,deps);profile.runnerId=pairing.runnerId;profile.pairing={devicePublicKey:credentials.device.publicKey,deviceFingerprint:pairing.deviceFingerprint,confirmationRequired:true};
  }
  if(Object.keys(credentials).length && !opts.pair) {
    writePrivateJson(paths.credentials,encryptCredentials(credentials,await credentialPassword()),{replace:!!oldCredentials});
  }
  writePrivateJson(paths.profile,profile,{replace:!!old});
  return {ok:true,configured:true,profile:paths.name,owner:profile.owner,tradingWallet:profile.tradingWallet,runnerId:profile.runnerId,chainId:9,budgets:profile.budgets,
    ...(pairing?{pairing}:{}),note:pairing?'Confirm this device fingerprint in your dashboard before telemetry is accepted.':'Ready for keyless Observe/Paper. Live stays blocked until local arm and verified release qualification.'};
}
async function armPolicy(opts,deps,journal) {
  const paths=profilePaths(opts,deps),profile=requireProfile(paths),now=deps.clock?.() ?? Date.now();
  const control=pauseRequested(paths)?readPauseControl(paths):null;
  const prior=(await journal.read()).filter(r=>r.type==='ledger.state').at(-1)?.data;
  const pauseThreshold=Math.max(control?.at ?? -1,prior?.pauseLatch?.at ?? -1),needsResume=pauseThreshold>=0;
  let envelope,relay;
  if(opts.policyFile)envelope=readPrivateJson(opts.policyFile,{maximum:20000});
  else {
    relay=await unlockDevice(paths,profile,deps);
    const services=createHostedServices({relay},deps),current=await services.currentPolicy();
    if(current.releaseId!==TRADER_RELEASE_ID)throw new TraderCliError('Dashboard release differs from this installed CLI; no policy was armed.');
    const proposal=readPrivateJson(paths.proposal,{optional:true});
    if(!current.envelope || current.envelope.policy?.expiresAt<=now || current.envelope.policy?.issuedAt<=pauseThreshold) {
      const policy=proposal?.policy?.expiresAt>now && proposal.policy.issuedAt>pauseThreshold?proposal.policy:inputPolicy(profile,now);
      validatePolicy(policy,{now,owner:profile.owner,tradingWallet:profile.tradingWallet,runnerId:profile.runnerId});
      if(policy.issuedAt<=pauseThreshold)throw new TraderCliError('A fresh policy must be issued strictly after this pause.');
      for(const field of ['capitalWei','maxPerTxWei','maxPerDayWei','maxFeeWei'])if(policy[field]!==profile.budgets[field])throw new TraderCliError('Saved proposal differs from current explicit budgets. Review a replacement policy file.');
      (deps.io?.writeErr || (()=>{}))(JSON.stringify({proposal:policy,releaseId:TRADER_RELEASE_ID},null,2));
      const tradingWalletSignature=await signTradingPolicy(policy,{home:paths.home,wallet:opts.wallet || profile.wallet},deps);
      writePrivateJson(paths.proposal,{policy,policyHash:policyHash(policy),releaseId:TRADER_RELEASE_ID});
      const result=await services.propose({policy,tradingWalletSignature});
      if(result.policyHash!==policyHash(policy))throw new TraderCliError('Dashboard did not acknowledge the exact reviewed policy.');
      return {ok:true,armed:false,state:'awaiting-owner-signature',policyHash:result.policyHash,expiresAt:policy.expiresAt,
        next:'Review and sign this policy with your ownership wallet in the dashboard, then repeat hartii trader arm. The browser cannot arm the runner.'};
    }
    if(!proposal || current.envelope.releaseId!==TRADER_RELEASE_ID || current.envelope.policyHash!==proposal.policyHash || policyHash(current.envelope.policy)!==proposal.policyHash)throw new TraderCliError('Dashboard policy differs from the locally reviewed proposal. No policy was armed.');
    for(const field of ['capitalWei','maxPerTxWei','maxPerDayWei','maxFeeWei'])if(current.envelope.policy[field]!==profile.budgets[field])throw new TraderCliError('Approved policy differs from the current explicit local budgets.');
    envelope={policy:current.envelope.policy,signature:current.envelope.signature};
  }
  if(!envelope || Object.keys(envelope).some(k=>!['policy','signature'].includes(k)))throw new TraderCliError('Policy file must contain only policy and owner signature.');
  const policy=validatePolicy(envelope.policy,{now,owner:profile.owner,tradingWallet:profile.tradingWallet,runnerId:profile.runnerId});
  if(policy.issuedAt<=pauseThreshold)throw new TraderCliError('Resume requires a newly signed policy issued after the active pause.');
  verifyOwnerPolicy({...envelope,message:canonicalPolicyMessage(policy)});
  (deps.io?.writeErr || (()=>{}))(JSON.stringify({review:policy},null,2));
  let services;
  if(profile.pairing) {
    relay ||= await unlockDevice(paths,profile,deps);services=createHostedServices({relay,policy},deps);
    const tradingWalletSignature=await signTradingPolicy(policy,{home:paths.home,wallet:opts.wallet || profile.wallet},deps);
    if(opts.policyFile) {
      const result=await services.propose({policy,tradingWalletSignature,ownerSignature:envelope.signature});
      if(result.policyHash!==policyHash(policy) || result.approvalRequired!==false)throw new TraderCliError('Hosted service has not approved the exact imported policy.');
    }
  }
  const confirmation=await (deps.confirmTypedFn || deps.io?.confirmTypedFn || readVisibleInput)('Type ARM to approve this policy locally: ',deps.io || {});
  if(confirmation!=='ARM')throw new TraderCliError('Local ARM confirmation was not provided.');
  if(needsResume && !services)throw new TraderCliError('Resuming requires the paired hosted authority claim as well as a fresh signed policy and local ARM.');
  if(services){const authority=await services.claim();if(authority.exclusive!==true)throw new TraderCliError('Exclusive trading-wallet authority was not granted.');}
  writePrivateJson(paths.policy,{policy,signature:envelope.signature});
  if(needsResume) {
    const clock=deps.clock || Date.now,ledger=await TraderLedger.open({journal,policy,mode:'live',clock,now:clock()});
    let latch=ledger.state.pauseLatch;
    const completed=control?(ledger.state.resumeHistory || []).find(r=>r.policyNonce===policy.nonce && r.controlPauseId===control.id):null;
    if(!latch && !completed && control){await ledger.pause(control.at,control.reason);latch=ledger.state.pauseLatch;}
    const paused=latch || completed?.pause;
    if(!paused)throw new TraderCliError('The exact paused state is unavailable; no resume acknowledgement was written.');
    await ledger.resumeAfterLocalApproval({policyNonce:policy.nonce,policyMessage:canonicalPolicyMessage(policy),pauseId:paused.id,pauseAt:paused.at,...(control?{controlPauseId:control.id}:{})});
    if(control){
      const current=readPauseControl(paths);
      if(!current || current.id!==control.id || current.at!==control.at || current.reason!==control.reason)throw new TraderCliError('A newer pause arrived during approval and remains active.');
      writePrivateJson(paths.resumeAck,{schemaVersion:1,controlPauseId:control.id,pauseAt:control.at,pauseReason:control.reason,ledgerPauseId:paused.id,policyNonce:policy.nonce,at:clock()});
    }
  }
  if(pauseRequested(paths))throw new TraderCliError('A new pause remains active. A fresh signed policy and local ARM are required.');
  if(opts.wallet){profile.wallet=opts.wallet;writePrivateJson(paths.profile,profile);}
  return {ok:true,armed:true,expiresAt:policy.expiresAt,liveEnabled:false,note:'Local policy stored. Live still requires seven actual paper days, replay/rehearsal evidence, membership and exclusive execution authority.'};
}
async function arm(opts,deps) {
  const paths=profilePaths(opts,deps);requireProfile(paths);
  // Policy replacement and a Live runner share the same non-expiring writer lock.
  // A running process cannot silently keep signing an older policy after a local change.
  const journal=await FileJournal.open(paths.journal('live'));
  try{return await armPolicy(opts,deps,journal);}finally{await journal.close();}
}
async function watch(opts,deps) {
  if(opts.demo)return runLocalTrader({...opts,sub:'paper',mode:'paper',once:true},deps);
  const signal=deps.signal,read=()=>readTraderStatus(opts,deps);
  if(opts.once)return read();
  const controller=new AbortController(),stop=()=>controller.abort();process.once('SIGINT',stop);
  try {do {
    const status=read(),s=status.snapshot;
    const output=opts.json?JSON.stringify(status):s?`Hartii Trader BETA | ${s.mode.toUpperCase()} | ${s.state}\nWallet ${s.tradingWallet}\nEquity ${s.finances.equityWei ?? 'unknown'} wei | Exposure ${s.finances.exposureWei ?? 'unknown'} wei\n${s.latestDecision?.rationale || 'Waiting for a cycle'}\n${s.blockers.join(', ')}`:'Trader profile has no recorded cycle.';
    (deps.write || deps.io?.write || (line=>process.stdout.write(line+'\n')))(safeTerminalText(output));
    if(signal?.aborted || controller.signal.aborted)break;
    try {await delay(deps.intervalMs || 2000,undefined,{signal:signal || controller.signal});}catch(error){if(error.name!=='AbortError')throw error;}
  }while(!controller.signal.aborted && !signal?.aborted);return {...read(),streamed:true};
  }finally{process.removeListener('SIGINT',stop);}
}
export async function runTrader(opts={},deps={}) {
  checkedFlags(opts.flags);
  if(opts.network && opts.network!=='mainnet')throw new TraderCliError('Holder trader supports Cyprus-1 mainnet, chain 9. Select --network mainnet.');
  if(opts.fundingTx && opts.sub!=='reconcile')throw new TraderCliError('--funding-tx is available only with trader reconcile.');
  if(opts.fundingTx && !/^0x[0-9a-fA-F]{64}$/.test(opts.fundingTx))throw new TraderCliError('--funding-tx requires a public 32-byte transaction hash.');
  if(opts.keyEnv)throw new TraderCliError('Trader Live requires an encrypted dedicated wallet; raw transaction key arguments are unavailable.');
  if(opts.demo && !['paper','run','watch','status','export'].includes(opts.sub || 'status'))throw new TraderCliError('Demo supports paper, observe, watch, status and export only.');
  if(opts.demo && ['status','export'].includes(opts.sub))return runLocalTrader({...opts,sub:'paper',mode:'paper',once:true},deps);
  switch(opts.sub || 'status') {
    case 'init':return initialize(opts,deps);
    case 'paper':return runLocalTrader({...opts,mode:opts.observe?'observe':'paper'},deps);
    case 'run':return runLocalTrader({...opts,mode:opts.observe?'observe':'live'},deps);
    case 'arm':return arm(opts,deps);
    case 'watch':return watch(opts,deps);
    case 'status':return readTraderStatus(opts,deps);
    case 'pause':return requestPause(profilePaths(opts,deps),deps.clock?.() ?? Date.now());
    case 'reconcile':return runLocalTrader({...opts,mode:'live',once:true},deps);
    case 'export':return exportTraderJournals(opts,deps);
    default:throw new TraderCliError('Usage: hartii trader init|paper|arm|run|watch|status|pause|reconcile|export');
  }
}
