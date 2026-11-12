import {readFileSync,readdirSync,openSync,writeFileSync,fsyncSync,closeSync,unlinkSync,fstatSync,lstatSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {securePath,secureDirectory,atomicPrivateWrite} from '../secureFiles.js';
import {transactionIntentDigest} from '../writePipeline.js';
import {DeskError,hash,normalizeAuthority} from './model.js';

function canonical(value){if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';return JSON.stringify(value);}
const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
const requireThat=(condition,message)=>{if(!condition)throw new DeskError(message);};
function dayKey(day){const d=String(day??new Date().toISOString().slice(0,10)).replaceAll('-','');requireThat(/^\d{8}$/.test(d),'Use a UTC day as YYYY-MM-DD.');const iso=d.slice(0,4)+'-'+d.slice(4,6)+'-'+d.slice(6,8);requireThat(new Date(iso+'T00:00:00Z').toISOString().startsWith(iso),'Invalid UTC day.');return d;}
function identity(id){requireThat(typeof id==='string'&&/^\d{8}-[a-f0-9]{64}$/.test(id),'Invalid decision ID. Copy the ID from hartii desk journal.');dayKey(id.slice(0,8));return id;}
const immutable=r=>({schemaVersion:r.schemaVersion,id:r.id,intentDigest:r.intentDigest,chainId:r.chainId,venue:r.venue,transaction:r.transaction,trade:r.trade,quote:r.quote});
export function summarizeDecision(r){return {id:r.id,createdAt:r.createdAt,kind:r.trade.kind,action:r.quote.action,phase:r.phase,txHash:r.txHash,broadcastMayHaveStarted:r.broadcastMayHaveStarted,status:['reviewed','signed'].includes(r.phase)?r.phase:r.outcome?.status??(r.broadcastMayHaveStarted?'unresolved':r.phase),outcomeReason:r.outcome?.reason??null,gasCeilingWei:r.quote.gasCeilingWei,gasFeeWei:r.outcome?.gasFeeWei??null,output:r.outcome?.output??null,observations:r.observations.length};}
export class DeskStore{
  constructor(home){requireThat(typeof home==='string'&&home.length>0,'A local CLI home is required.');this.root=join(resolve(home),'desk','mainnet');}
  directory(day){const root=secureDirectory(this.root);return secureDirectory(join(root,dayKey(day)));}
  path(id){identity(id);return join(this.directory(id.slice(0,8)),id+'.json');}
  get(id){
    const file=this.path(id),checked=securePath(file,{regularFile:true});requireThat(checked.stat&&checked.stat.size<=2*1024*1024,'Decision is missing or exceeds the local record limit.');
    let doc;try{doc=JSON.parse(readFileSync(file,'utf8'));}catch{throw new DeskError('Decision file is not readable JSON.');}
    requireThat(doc?.format==='hartii-desk-decision/v1'&&doc.record?.id===id&&doc.sha256===digest(doc.record),'Decision integrity check failed; no evidence was accepted.');
    const r=doc.record;requireThat(r.schemaVersion===1&&r.chainId===9&&r.intentDigest==='0x'+id.slice(9),'Decision identity is invalid.');normalizeAuthority(r.transaction);requireThat(['reviewed','signed','broadcast-possible','observed'].includes(r.phase)&&Array.isArray(r.observations)&&r.observations.length<=100,'Decision lifecycle is invalid.');if(r.txHash!==null)hash(r.txHash);
    return r;
  }
  write(record,replace=false){
    const text=JSON.stringify({format:'hartii-desk-decision/v1',sha256:digest(record),record},null,2)+'\n';requireThat(Buffer.byteLength(text)<=2*1024*1024,'Decision exceeds the 2 MiB record limit.');atomicPrivateWrite(this.path(record.id),text,{replace});return record;
  }
  locked(id,fn){
    const file=this.path(id)+'.lock';let fd;
    try{securePath(file,{regularFile:true});fd=openSync(file,'wx',0o600);}catch{throw new DeskError('Decision has an active or stale writer lock. Inspect it; locks are never cleared automatically.');}
    const original=fstatSync(fd);
    try{writeFileSync(fd,JSON.stringify({pid:process.pid,id}));fsyncSync(fd);return fn();}
    finally{closeSync(fd);const current=lstatSync(file);requireThat(current.ino===original.ino&&current.dev===original.dev&&!current.isSymbolicLink(),'Decision lock changed; it was not removed.');unlinkSync(file);}
  }
  capture(record){
    return this.locked(record.id,()=>{
      const path=this.path(record.id),existing=securePath(path,{regularFile:true}).stat;
      if(existing){const r=this.get(record.id);requireThat(digest(immutable(r))===digest(immutable(record)),'Reviewed decision terms changed under the same identifier.');return r;}
      const dir=this.directory(record.id.slice(0,8));requireThat(readdirSync(dir).filter(n=>n.endsWith('.json')).length<10000,'Daily journal limit reached; archive the day before recording more decisions.');return this.write(record);
    });
  }
  mutate(id,fn){return this.locked(id,()=>{const r=this.get(id);fn(r);return this.write(r,true);});}
  signed(id,txHash,transaction){
    txHash=hash(txHash);return this.mutate(id,r=>{requireThat(transactionIntentDigest(transaction)===r.intentDigest,'Signed authority differs from the recorded review.');requireThat(r.txHash===null||r.txHash===txHash,'A different signed hash is already bound to this decision.');r.txHash=txHash;r.hashSource='locally-verified-signed-bytes';if(!r.broadcastMayHaveStarted)r.phase='signed';});
  }
  broadcast(id,txHash){return this.mutate(id,r=>{requireThat(r.txHash===hash(txHash),'Broadcast hash differs from the captured signature.');r.broadcastMayHaveStarted=true;r.phase='broadcast-possible';});}
  observe(id,outcome){return this.mutate(id,r=>{requireThat(outcome&&['confirmed','reverted','unresolved'].includes(outcome.status)&&Number.isSafeInteger(outcome.observedAt),'Invalid receipt observation.');const previous=r.outcome?{...r.outcome,observedAt:0}:null,current={...outcome,observedAt:0};if(!previous||digest(previous)!==digest(current)){requireThat(r.observations.length<100,'Observation limit reached; history was preserved.');r.observations.push(structuredClone(outcome));}r.outcome=structuredClone(outcome);if(r.broadcastMayHaveStarted||outcome.status!=='unresolved')r.phase='observed';});}
  list({day,limit=25,before}={}){
    requireThat(Number.isSafeInteger(limit)&&limit>=1&&limit<=100,'Journal limit must be 1–100.');const key=dayKey(day),dir=this.directory(key);
    const names=readdirSync(dir).filter(n=>/^\d{8}-[a-f0-9]{64}\.json$/.test(n));requireThat(names.length<=10000,'Daily journal exceeds the bounded scan limit.');
    const ranked=names.map(name=>({id:name.slice(0,-5),mtime:securePath(join(dir,name),{regularFile:true}).stat?.mtimeMs??0})).sort((a,b)=>b.mtime-a.mtime||a.id.localeCompare(b.id));
    let start=0;if(before!==undefined){identity(before);const index=ranked.findIndex(r=>r.id===before);requireThat(index>=0,'Journal cursor is not in the selected day.');start=index+1;}
    const page=ranked.slice(start,start+limit),records=page.map(({id})=>summarizeDecision(this.get(id)));return {day:key,records,nextCursor:start+page.length<ranked.length?page.at(-1)?.id??null:null,coverage:'Only decisions recorded through this CLI home; not complete wallet trading history.'};
  }
}
