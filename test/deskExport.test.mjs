import {it,expect,vi} from 'vitest';
import {mkdtempSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runDesk} from '../src/commands/desk.js';
import {formatHumanResult} from '../src/humanOutput.js';
it('refuses exports into hidden configuration directories without creating the destination',async()=>{
  const home=mkdtempSync(join(tmpdir(),'hartii-desk-hidden-export-'));
  for(const folder of ['.private-config','.ssh','.config']){
    const out=join(home,folder,'report.html');await expect(runDesk({home,demo:true,flags:{out}})).rejects.toThrow(/protected configuration/);expect(existsSync(out)).toBe(false);
  }
});
it('exports a real standalone demo report without network, a wallet or a trading-journal write',async()=>{const home=mkdtempSync(join(tmpdir(),'hartii-desk-report-')),out=join(home,'report.html'),providerFactory=vi.fn(()=>{throw Error('No network');});const result=await runDesk({home,demo:true,flags:{out}}, {providerFactory});expect(result.desk.output).toBe(out);const html=readFileSync(out,'utf8');expect(html).toContain('Constraint Desk');expect(html).toContain('FIXTURE');expect(providerFactory).not.toHaveBeenCalled();await expect(runDesk({home,demo:true,flags:{out}},{})).rejects.toThrow(/already exists/);});
it('offers a useful human desk view instead of dumping the internal object tree',async()=>{const result=await runDesk({demo:true,flags:{}},{});const text=formatHumanResult(result);expect(text).toContain('Constraint Desk');expect(text).toContain('Observed gas');expect(text).toContain('FIXTURE');});
