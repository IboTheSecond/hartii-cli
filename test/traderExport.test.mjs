import { it,expect,vi } from 'vitest';
import { mkdtempSync,readFileSync,writeFileSync,existsSync,appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { FileJournal } from '../vendor/packages/hartii-trader/src/index.mjs';
import { main } from '../src/cli.js';
import { profilePaths,writePrivateJson } from '../src/trader/storage.js';
async function fixture(count=0) {
  const home=mkdtempSync(join(tmpdir(),'hartii-journal-export-')),paths=profilePaths({home}),out=join(home,'history.jsonl');
  writePrivateJson(paths.profile,{schemaVersion:1,profile:'default',chainId:9,runnerId:'export-runner',owner:'0x0010000000000000000000000000000000000001',tradingWallet:'0x0010000000000000000000000000000000000002',budgets:{capitalWei:'100',maxPerTxWei:'10',maxPerDayWei:'30',maxFeeWei:'1'}});
  const journal=await FileJournal.open(paths.journal('paper'));
  await journal.append({type:'host.release',at:1,data:{releaseId:'historic-release-1'}});
  for(let i=0;i<count;i++)await journal.append({type:'model.state',at:i+2,data:{requests:[],overrun:false}});
  await journal.close();
  return {home,paths,out,deps:{env:{HARTII_HOME:home},write:vi.fn(),writeErr:vi.fn(),walletFactory:vi.fn(()=>{throw Error('No wallet');}),fetchFn:vi.fn(()=>{throw Error('No network');})}};
}
it('exports all financial records beyond 1000 with mode boundaries and independently verifiable integrity metadata',async()=>{
  const f=await fixture(1205);
  writeFileSync(f.paths.credentials,'not JSON: sk-secret-do-not-export');
  writeFileSync(f.paths.policy,'not JSON: owner-signature-do-not-export');
  expect(await main(['trader','export','--out',f.out,'--json'],f.deps)).toBe(0);
  const raw=readFileSync(f.out,'utf8'),lines=raw.trimEnd().split('\n'),records=lines.map(line=>JSON.parse(line));
  expect(records.filter(r=>r.kind==='journal.record')).toHaveLength(1206);
  expect(records.filter(r=>r.kind==='journal.start').map(r=>r.mode)).toEqual(['observe','paper','live']);
  expect(records.find(r=>r.kind==='journal.end' && r.mode==='paper')).toMatchObject({recordCount:1206,releaseId:'historic-release-1',verified:true});
  const footer=records.at(-1);expect(footer).toMatchObject({kind:'export.end',recordCount:1206,complete:true});
  expect(footer.contentSha256).toBe(createHash('sha256').update(lines.slice(0,-1).join('\n')+'\n').digest('hex'));
  expect(raw).not.toMatch(/sk-secret|owner-signature-do-not-export|credentials\.json|armed-policy\.json/);
  expect(raw).not.toContain(f.home);expect(raw).not.toContain(f.home.replace(/\\/g,'\\\\'));
  expect(f.deps.walletFactory).not.toHaveBeenCalled();expect(f.deps.fetchFn).not.toHaveBeenCalled();
},120000);
it.each(['corrupt','partial-tail','secret-field','private-path','signature'])('refuses %s without publishing a partial export',async kind=>{
  const f=await fixture(1),path=f.paths.journal('paper');
  if(kind==='corrupt')writeFileSync(path,readFileSync(path,'utf8').replace('"overrun":false','"overrun":true'));
  if(kind==='partial-tail')appendFileSync(path,'{"schemaVersion":1');
  if(['secret-field','private-path','signature'].includes(kind)) {
    const journal=await FileJournal.open(path);
    const data=kind==='secret-field'?{requests:[],overrun:false,apiKey:'sk-secret'}:kind==='private-path'?{releaseId:'C:\\private\\credential.json'}:{releaseId:'0x'+'ab'.repeat(65)};
    await journal.append({type:kind==='secret-field'?'model.state':'host.release',at:4,data});await journal.close();
  }
  expect(await main(['trader','export','--out',f.out,'--json'],f.deps)).toBe(1);
  expect(existsSync(f.out)).toBe(false);
  expect(f.deps.writeErr.mock.calls.join('')).not.toMatch(/sk-secret|credential\.json/);
});
it('requires a stopped writer and preserves its lock',async()=>{
  const f=await fixture(),journal=await FileJournal.open(f.paths.journal('paper'));
  try {expect(await main(['trader','export','--out',f.out,'--json'],f.deps)).toBe(1);expect(existsSync(f.paths.journal('paper')+'.lock')).toBe(true);expect(existsSync(f.out)).toBe(false);}
  finally {await journal.close();}
});
it('can select one mode and creates a protected default artifact when --out is omitted',async()=>{
  const f=await fixture(2);
  expect(await main(['trader','export','--mode','paper','--json'],f.deps)).toBe(0);
  const result=JSON.parse(f.deps.write.mock.calls.at(-1)[0]);expect(result.format).toBe('hartii-trader-journal-jsonl-v1');
  const records=readFileSync(result.savedTo,'utf8').trimEnd().split('\n').map(JSON.parse);
  expect(records.filter(r=>r.kind==='journal.start').map(r=>r.mode)).toEqual(['paper']);
  expect(records.at(-1).recordCount).toBe(3);
});
