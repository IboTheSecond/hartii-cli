import {safeTerminalText,formatTable} from '../output.js';
import {formatAmount} from '../amount.js';
const text=value=>value===null||value===undefined?'—':safeTerminalText(String(value));
const quai=value=>{try{return value===null||value===undefined?'—':formatAmount(BigInt(value));}catch{return '—';}};
export function formatDeskResult(result,colors){
  const d=result?.desk;if(!d)return null;const lines=[colors.bold('Constraint Desk · Fill Ledger (BETA)')];
  if(result.demo||d.demo)lines.push('FIXTURE · illustrative data · no signing or network');
  if(result.aborted)lines.push('Cancelled at the native confirmation.');
  if(result.ok===false)lines.push(colors.yellow(text(result.error??'The guarded operation did not complete. Inspect any recorded hash.')));
  if(d.view==='positions'){
    lines.push(`Account: ${text(d.account)}`,`Native balance: ${quai(d.nativeBalanceWei)} QUAI`);
    if(d.positions===null)lines.push('Token position data unavailable.');
    else if(!d.positions.length)lines.push('No indexed token positions returned; this is not a complete asset inventory.');
    else lines.push(formatTable([['TOKEN','BALANCE · BASE UNITS','INDEXED MARK · QUAI'],...d.positions.map(p=>[text(p.symbol??p.address),text(p.balanceUnits),text(p.indexedValueQuai)])]));
    if(d.basis)lines.push(text(d.basis));
  }else if(d.view==='preview'){
    const approvalOnly=d.previewScope==='approval-only',s=result.plannedTrade??result.summary??{};lines.push('Preflight only · nothing signed or sent',`Expected output: ${text(s.expectedOut)}`,`Minimum output: ${text(s.minOut)}`);
    if(approvalOnly)lines.push('Allowance approval is required; only that approval was simulated.',`Approval gas ceiling: ${text(result.summary?.estimatedFeeQuai)} QUAI`,'Swap gas: unavailable until the allowance exists and a fresh swap preflight completes.');
    else lines.push(`Trade gas ceiling: ${text(result.summary?.estimatedFeeQuai)} QUAI`);
  }else{
    const rows=d.decisions??d.records??[];
    if(!rows.length)lines.push('No decisions recorded for this selection.');
    for(const r of rows){const q=r.quote??{},o=r.outcome??{};lines.push('',`${text(r.id)}`,`  ${text(r.status??o.status??r.phase)} · ${text(r.kind??r.trade?.kind)} · ${text(r.action??q.action)}`,`  Hash: ${text(r.txHash)}`,`  Observed gas: ${quai(r.gasFeeWei??o.gasFeeWei)} QUAI`, `  Reviewed gas ceiling: ${quai(r.gasCeilingWei??q.gasCeilingWei)} QUAI`);const output=r.output??o.output;if(output)lines.push(`  Event-derived output: ${text(output.eventDerivedUnits)} base units`, `  Balance/P&L proof: unavailable`);}
  }
  for(const r of d.decisions??d.records??[]){if(r.outcomeReason)lines.push(`Receipt evidence (${text(r.id)}): ${text(r.outcomeReason)}`);}
  if(d.output)lines.push(`Saved report: ${text(d.output)}`);
  if(d.nextCursor)lines.push(`Next journal cursor: ${text(d.nextCursor)}`);
  for(const message of d.warnings??[])lines.push(colors.yellow(text(message)));
  if(d.recordingError)lines.push(colors.yellow('Local record issue: '+text(d.recordingError)));
  if(d.coverage)lines.push('',text(d.coverage));if(d.note)lines.push(text(d.note));
  return lines;
}
