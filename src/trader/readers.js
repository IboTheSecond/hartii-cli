import { profilePaths,loadProfile,requireProfile,readPrivateJson,requestPause,pauseRequested,withStoppedTraderJournals,privateStreamExport,TraderCliError } from './storage.js';
import { validatePolicy,validateModelFeatures,canonicalJson,canonicalPolicyMessage } from '../../vendor/packages/hartii-trader/src/index.mjs';
import { open } from 'node:fs/promises';
import { createHash,randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { TRADER_RELEASE_ID } from './release.js';

const snapshotFields=['schemaVersion','runnerId','owner','tradingWallet','chainId','mode','state','updatedAt','heartbeatAt','policy','membership','finances','positions','latestDecision','blockers','qualification'];
const pick=(value,keys)=>Object.fromEntries(keys.map(key=>[key,['string','number','boolean'].includes(typeof value?.[key])?value[key]:null]));
const financeFields=['equityWei','availableQuaiWei','exposureWei','realizedPnlWei','unrealizedPnlWei','gasWei','modelCostMicrousd'];
const positionFields=['id','token','symbol','units','costBasisWei','exitValueWei','pnlWei','status','updatedAt'];
const decisionFields=['id','at','action','token','rationale','outcome'];
const scalarList=value=>Array.isArray(value)?value.filter(v=>typeof v==='string').map(v=>v.slice(0,300)).slice(0,30):[];
const decisionEvidence=value=>(Array.isArray(value)?value:[]).slice(0,3).flatMap(v=>{if(typeof v==='string')return [v.slice(0,300)];try {if(typeof v?.candidateId!=='string')return [];return [{candidateId:v.candidateId.slice(0,96),features:validateModelFeatures(v.features)}];}catch{return [];}});
const decisionGuards=value=>(Array.isArray(value)?value:[]).slice(0,20).filter(v=>typeof v?.guard==='string' && typeof v?.passed==='boolean').map(v=>({guard:v.guard.slice(0,100),passed:v.passed}));
export function publicEvent(value) {
  if(!value || value.schemaVersion!==1)return null;
  const event=pick(value,['schemaVersion','id','runnerId','seq','at','mode','type']);
  const fields={heartbeat:['state'],'cycle.started':[],'analysis.started':['candidateCount'],'analysis.completed':['action','candidateCount'],proposal:['id','action','token','amountWei'],
    'guard.result':['code','passed','reason'],decision:decisionFields,'transaction.prepared':['id','action','token','amountWei'],
    'transaction.pending':['id','txHash'],'transaction.confirmed':['id','txHash','simulated'],'transaction.reverted':['id','txHash','simulated'],
    'transaction.unknown':['id','txHash','retryable'],'runner.paused':['reason'],'runner.stopped':['state'],'feed.stale':['reason']}[value.type];
  if(!fields)return null;
  event.data=Object.fromEntries(fields.filter(k=>['string','number','boolean'].includes(typeof value.data?.[k]) || value.data?.[k]===null).map(k=>[k,value.data[k]]));
  if(value.type==='decision') {event.data.evidence=decisionEvidence(value.data.evidence);event.data.guardResults=decisionGuards(value.data.guardResults);}
  return event;
}
export function publicSnapshot(value) {
  if (!value || value.schemaVersion !== 1 || value.chainId !== 9 || !['observe','paper','live'].includes(value.mode)) return null;
  const out=Object.fromEntries(snapshotFields.map(key=>[key,value[key] ?? null]));
  if (out.policy) out.policy=validatePolicy(out.policy,{now:out.policy.issuedAt});
  out.finances=pick(out.finances,financeFields);
  out.positions=(Array.isArray(out.positions)?out.positions:[]).slice(0,20).map(p=>pick(p,positionFields));
  if(out.latestDecision)out.latestDecision={...pick(out.latestDecision,decisionFields),evidence:decisionEvidence(out.latestDecision.evidence),guardResults:decisionGuards(out.latestDecision.guardResults)};
  if(out.membership){const membership=out.membership;out.membership=pick(membership,['configured','active','eligible','owner','chainId','token','registry','tier','minimumWei','balanceWei','checkedAt','blockNumber','reason']);out.membership.pending=membership.pending?pick(membership.pending,['minimumWei','effectiveAt']):null;}
  out.qualification=pick(out.qualification,['days','requiredDays','liveEnabled']);out.blockers=scalarList(out.blockers);
  return out;
}
export function readTraderStatus(opts = {}, deps = {}) {
  const paths=profilePaths(opts,deps), profile=loadProfile(paths);
  if (!profile) return {ok:true,configured:false,snapshot:null};
  const snapshot=publicSnapshot(readPrivateJson(paths.snapshot,{optional:true}));
  if(snapshot && pauseRequested(paths)) { snapshot.state='paused'; snapshot.qualification={...snapshot.qualification,liveEnabled:false}; }
  const now=deps.clock?.() ?? Date.now(),stale=!!snapshot && (!Number.isSafeInteger(snapshot.heartbeatAt) || now-snapshot.heartbeatAt>120000);
  if(snapshot && stale){snapshot.qualification.liveEnabled=false;snapshot.blockers=[...new Set([...snapshot.blockers,'heartbeat-stale'])];if(!['paused','pending'].includes(snapshot.state))snapshot.state='disconnected';}
  if(snapshot?.mode==='live' && snapshot.policy?.expiresAt<=now){snapshot.qualification.liveEnabled=false;snapshot.blockers=[...new Set([...snapshot.blockers,'policy-expired'])];}
  return {ok:true,configured:true,profile:paths.name,snapshot,identity:{owner:profile.owner,tradingWallet:profile.tradingWallet,runnerId:profile.runnerId,chainId:9},
    paused:pauseRequested(paths),stale,note:snapshot ? undefined : 'No cycle has run for this profile.'};
}
export function readTraderLimits(opts = {}, deps = {}) {
  const paths=profilePaths(opts,deps), profile=loadProfile(paths);
  if(!profile) return {ok:true,configured:false,limits:null};
  const envelope=readPrivateJson(paths.policy,{optional:true});
  const policy=envelope?.policy ? validatePolicy(envelope.policy,{now:envelope.policy.issuedAt}) : null;
  return {ok:true,configured:true,limits:pick(profile.budgets,['capitalWei','maxPerTxWei','maxPerDayWei','maxFeeWei']),policy,armed:!!policy && policy.expiresAt>(deps.clock?.() ?? Date.now()),paused:pauseRequested(paths)};
}
export function readTraderActivity(opts = {}, deps = {}) {
  const paths=profilePaths(opts,deps), profile=loadProfile(paths);
  const limit=Math.min(100,Math.max(1,Number.isSafeInteger(opts.limit)?opts.limit:50));
  const after=Number.isSafeInteger(opts.after)?opts.after:0;
  const events=profile ? readPrivateJson(paths.events,{optional:true}) || [] : [];
  const items=events.filter(e=>e.schemaVersion===1 && e.runnerId===profile?.runnerId && e.seq>after).slice(-limit).map(publicEvent).filter(Boolean);
  return {ok:true,configured:!!profile,events:items,nextCursor:items.at(-1)?.seq ?? after};
}
/** In-process seam used by MCP. It has no arm, credential, or spending method. */
export function createTraderReader(opts = {}, deps = {}) {
  return {status:()=>readTraderStatus(opts,deps),limits:()=>readTraderLimits(opts,deps),
    activity:input=>readTraderActivity({...opts,limit:input?.limit,after:input?.after},deps),pause:()=>requestPause(profilePaths(opts,deps),deps.clock?.() ?? Date.now())};
}

const uint=value=>typeof value==='string' && /^(0|[1-9][0-9]{0,95})$/.test(value);
const signed=value=>typeof value==='string' && /^-?(0|[1-9][0-9]{0,95})$/.test(value);
const integer=value=>Number.isSafeInteger(value) && value>=0;
const boolean=value=>typeof value==='boolean';
const identifier=value=>typeof value==='string' && /^[A-Za-z0-9_-]{1,96}$/.test(value);
const address=value=>typeof value==='string' && /^0x[0-9a-fA-F]{40}$/.test(value);
const txHash=value=>typeof value==='string' && /^0x[0-9a-fA-F]{64}$/.test(value);
const nullable=check=>value=>value===null || check(value);
const array=check=>value=>Array.isArray(value) && value.every(check);
const oneOf=(...values)=>value=>values.includes(value);
const safeText=value=>typeof value==='string' && value.length<=1000 &&
  !/(?:^|[\s"'(=])[a-z]:[\\/]|\\\\|file:\/\/|\/(?:Users|home|private|tmp|mnt)\/|-----BEGIN .*PRIVATE KEY|sk-[a-z0-9_-]{8,}|^0x[0-9a-f]{130}$/i.test(value);
const object=(fields,required=[])=>value=>!!value && typeof value==='object' && !Array.isArray(value) &&
  required.every(key=>Object.hasOwn(value,key)) && Object.keys(value).every(key=>Object.hasOwn(fields,key) && fields[key](value[key]));
const policyMessage=value=>{
  if(typeof value!=='string' || value.length>16000 || !value.startsWith('hartii-trader-policy:v1\n'))return false;
  try{return canonicalPolicyMessage(JSON.parse(value.slice('hartii-trader-policy:v1\n'.length)))===value;}catch{return false;}
};
const pauseShape=object({id:identifier,at:integer,reason:oneOf('local-pause','remote-pause'),policyNonce:nullable(uint)});
const identityShape=object({owner:address,tradingWallet:address,runnerId:identifier,chainId:oneOf(9),mode:oneOf('observe','paper','live')},['owner','tradingWallet','runnerId','chainId','mode']);
const positionShape=object({id:identifier,token:address,symbol:nullable(safeText),units:uint,costBasisWei:uint,exitValueWei:nullable(uint),pnlWei:nullable(signed),status:safeText,updatedAt:integer,
  venue:safeText,peakExitValueWei:uint,exitGasWei:nullable(uint)});
const intentShape=object({id:identifier,action:oneOf('buy','sell','approve'),token:address,venue:safeText,amountWei:uint,units:uint,gasWei:uint,exitGasWei:uint,at:integer,
  txHash:nullable(txHash),status:safeText,spender:address,positionId:identifier});
const ledgerShape=object({
  schemaVersion:oneOf(1),identity:identityShape,policyNonce:uint,policyMessage,cashWei:nullable(uint),accountedCashWei:nullable(uint),accountingUnknown:boolean,accountingFault:boolean,cashUncertainty:boolean,
  lastCashObservedAt:nullable(integer),cashObservations:array(object({at:integer,cashWei:uint,expectedCashWei:signed})),lastProcessedAt:integer,lastMarkedAt:nullable(integer),
  positions:array(positionShape),quarantined:array(object({token:address,units:uint,at:integer})),pending:nullable(intentShape),
  settled:array(object({id:identifier,txHash,status:oneOf(0,1),eventAt:integer,processedAt:integer,accountingDay:safeText})),
  cancelled:array(object({id:identifier,kind:safeText,txHash:nullable(txHash),eventAt:integer,processedAt:integer})),fundingIds:array(identifier),
  flows:array(object({id:identifier,direction:oneOf('deposit','withdrawal'),amountWei:uint,gasWei:uint,source:oneOf('external-funding'),eventAt:integer,processedAt:integer,accountingDay:safeText})),
  approvals:array(object({id:identifier,positionId:identifier,token:address,spender:address,units:uint,txHash,at:integer,simulated:boolean})),
  incomingWei:uint,withdrawalsWei:uint,gasWei:uint,realizedPnlWei:signed,
  lossLatch:nullable(object({reason:oneOf('daily-loss'),at:integer,day:safeText,lossWei:uint,openingEquityWei:uint})),pauseLatch:nullable(pauseShape),pauseHistory:array(pauseShape),
  resumeHistory:array(object({pause:pauseShape,policyNonce:uint,policyMessage,at:integer,controlPauseId:identifier})),
  day:nullable(object({date:safeText,openingEquityWei:nullable(uint),incomingWei:uint,withdrawalsWei:uint,spentWei:uint})),lastAnalysisAt:nullable(integer),lastCycleAt:nullable(integer),
},['schemaVersion','identity','policyNonce','policyMessage']);
const features=value=>{try{validateModelFeatures(value);return true;}catch{return false;}};
const decisionShape=object({id:identifier,at:integer,action:oneOf('hold','buy','sell'),token:nullable(address),rationale:safeText,outcome:safeText,
  evidence:array(value=>safeText(value) || object({candidateId:identifier,features},['candidateId','features'])(value)),
  guardResults:array(value=>safeText(value) || object({guard:safeText,passed:boolean},['guard','passed'])(value))});
const eventData={
  heartbeat:object({state:safeText}),'cycle.started':object({}),'analysis.started':object({candidateCount:integer}),'analysis.completed':object({action:safeText,candidateCount:integer}),
  proposal:object({id:identifier,action:oneOf('buy','sell','approve'),token:address,amountWei:uint}),'guard.result':object({code:safeText,passed:boolean,reason:safeText}),decision:decisionShape,
  'transaction.prepared':object({id:identifier,action:oneOf('buy','sell','approve'),token:address,amountWei:uint}),'transaction.pending':object({id:identifier,txHash}),
  'transaction.confirmed':object({id:identifier,txHash,simulated:boolean}),'transaction.reverted':object({id:identifier,txHash,simulated:boolean}),
  'transaction.unknown':object({id:identifier,txHash:nullable(txHash),retryable:oneOf(false)}),'runner.paused':object({reason:safeText}),'runner.stopped':object({state:safeText}),'feed.stale':object({reason:safeText}),
};
const eventShape=value=>object({schemaVersion:oneOf(1),id:identifier,runnerId:identifier,seq:integer,at:integer,mode:oneOf('observe','paper','live'),type:safeText,data:data=>eventData[value.type]?.(data)===true},
  ['schemaVersion','id','runnerId','seq','at','mode','type','data'])(value);
const usageShape=object({inputTokens:integer,outputTokens:integer,cacheReadInputTokens:integer,cacheWriteInputTokens:integer,totalMicrousd:uint});
const modelShape=object({requests:array(object({id:identifier,cycleId:identifier,day:safeText,reservedMicrousd:uint,usage:nullable(usageShape)})),overrun:boolean},['requests','overrun']);
const releaseShape=object({releaseId:value=>typeof value==='string' && /^[A-Za-z0-9._-]{1,128}$/.test(value)},['releaseId']);
const journalShapes={'host.release':releaseShape,'ledger.state':ledgerShape,'model.state':modelShape,'runner.event':eventShape};
const MAX_EXPORT_RECORD_BYTES=16*1024*1024;

/** One bounded JSON record at a time; incomplete tails and invalid UTF-8 never become valid exports. */
async function* journalLines(handle) {
  let pending=Buffer.alloc(0);
  for await(const chunk of handle.createReadStream({highWaterMark:65536,autoClose:false})) {
    pending=Buffer.concat([pending,chunk]);let newline;
    while((newline=pending.indexOf(10))!==-1) {
      if(newline===0 || newline>MAX_EXPORT_RECORD_BYTES)throw new TraderCliError('Journal contains an empty or oversized record; export refused.');
      const line=pending.subarray(0,newline);pending=pending.subarray(newline+1);
      try {yield new TextDecoder('utf-8',{fatal:true}).decode(line);}catch {throw new TraderCliError('Journal encoding is invalid; export refused.');}
    }
    if(pending.length>MAX_EXPORT_RECORD_BYTES)throw new TraderCliError('Journal record exceeds the 16 MiB export limit; no history was truncated.');
  }
  if(pending.length)throw new TraderCliError('Journal has an incomplete final record; export refused.');
}

export async function exportTraderJournals(opts={},deps={}) {
  const paths=profilePaths(opts,deps),profile=requireProfile(paths),selected=opts.mode || opts.flags?.mode || 'all';
  if(!['all','observe','paper','live'].includes(selected))throw new TraderCliError('Export --mode must be all, observe, paper or live.');
  const modes=selected==='all'?['observe','paper','live']:[selected],createdAt=deps.clock?.() ?? Date.now();
  const out=opts.out || join(paths.root,'exports',`history-${createdAt}-${randomUUID()}.jsonl`);
  return withStoppedTraderJournals(paths,modes,journals=>privateStreamExport(out,async write=>{
    const content=createHash('sha256'),summaries=[];let total=0;
    const emit=async value=>{const line=canonicalJson(value)+'\n';content.update(line);await write(line);};
    await emit({kind:'export.start',schemaVersion:1,format:'hartii-trader-journal-jsonl-v1',createdAt,exporterReleaseId:TRADER_RELEASE_ID,chainId:9,
      identity:{owner:profile.owner,tradingWallet:profile.tradingWallet,runnerId:profile.runnerId},modes});
    for(const source of journals) {
      await emit({kind:'journal.start',mode:source.mode,present:!!source.stat,hashAlgorithm:'sha256-canonical-json'});
      let count=0,previous=null,firstHash=null,releaseId=null;
      if(source.stat) {
        const handle=await open(source.path,'r');
        try {
          const before=await handle.stat();
          if(before.dev!==source.stat.dev || before.ino!==source.stat.ino || before.nlink!==1)throw new TraderCliError('Journal identity changed before export.');
          for await(const line of journalLines(handle)) {
            let record;
            try {record=JSON.parse(line);}catch {throw new TraderCliError('Journal contains invalid JSON; export refused.');}
            const valid=object({schemaVersion:oneOf(1),seq:integer,previousHash:nullable(value=>typeof value==='string' && /^[a-f0-9]{64}$/.test(value)),type:safeText,at:integer,data:()=>true,hash:value=>typeof value==='string' && /^[a-f0-9]{64}$/.test(value)},
              ['schemaVersion','seq','previousHash','type','at','data','hash'])(record);
            if(!valid || record.seq!==count+1 || record.previousHash!==previous)throw new TraderCliError('Journal hash chain is corrupt; export refused.');
            const {hash,...body}=record;
            if(createHash('sha256').update(canonicalJson(body)).digest('hex')!==hash)throw new TraderCliError('Journal hash chain is corrupt; export refused.');
            if(!journalShapes[record.type]?.(record.data))throw new TraderCliError('Journal contains unsupported or unsafe fields; no artifact was published.');
            if(record.type==='ledger.state' && (record.data.identity.mode!==source.mode || record.data.identity.runnerId!==profile.runnerId ||
              record.data.identity.owner.toLowerCase()!==profile.owner.toLowerCase() || record.data.identity.tradingWallet.toLowerCase()!==profile.tradingWallet.toLowerCase()))throw new TraderCliError('Journal identity does not match the selected profile.');
            if(record.type==='runner.event' && (record.data.mode!==source.mode || record.data.runnerId!==profile.runnerId))throw new TraderCliError('Journal event identity does not match its mode.');
            if(record.type==='host.release'){if(releaseId!==null && releaseId!==record.data.releaseId)throw new TraderCliError('Journal has conflicting release provenance.');releaseId=record.data.releaseId;}
            firstHash ??= hash;previous=hash;count++;await emit({kind:'journal.record',mode:source.mode,record});
          }
          const after=await handle.stat();
          if(after.size!==before.size || after.mtimeMs!==before.mtimeMs || after.ctimeMs!==before.ctimeMs)throw new TraderCliError('Journal changed during export; no artifact was published.');
        } finally {await handle.close();}
      }
      const summary={kind:'journal.end',mode:source.mode,releaseId,recordCount:count,firstHash,headHash:previous,verified:true};
      summaries.push(summary);total+=count;await emit(summary);
    }
    await emit({kind:'export.end',schemaVersion:1,complete:true,recordCount:total,contentSha256:content.copy().digest('hex')});
    return {ok:true,format:'hartii-trader-journal-jsonl-v1',recordCount:total,journals:summaries,sha256:content.digest('hex')};
  }));
}
