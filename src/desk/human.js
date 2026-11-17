import { safeTerminalText } from '../output.js';
import { makeKit } from '../screenKit.js';
import * as F from '../format.js';

const text = value => value === null || value === undefined ? '—' : safeTerminalText(String(value));
const quai = value => { try { return value === null || value === undefined ? '—' : F.quai(BigInt(value)); } catch { return '—'; } };

/** Constraint Desk human view. Evidence wording is kept exactly; only layout, grouping and colour changed. */
export function formatDeskResult(result, colors, { width = 80, terse = false } = {}) {
  const d = result?.desk; if (!d) return null;
  const K = makeKit({ colors, width, terse });
  const lines = [...K.heading('Constraint Desk · Fill Ledger', 'BETA')];
  lines.push('');
  if (result.demo || d.demo) lines.push(K.t.accentBright('FIXTURE · illustrative data · no signing or network'), '');
  if (result.aborted) lines.push(K.t.warn('Cancelled at the native confirmation.'));
  if (result.ok === false) lines.push(K.t.warn(text(result.error ?? 'The guarded operation did not complete. Inspect any recorded hash.')));
  if (d.view === 'positions') {
    lines.push(...K.kv([['Account', F.address(d.account, { emph: g => K.t.bold(K.t.accentBright(g)) })], ['Native balance', quai(d.nativeBalanceWei)]]));
    if (d.positions === null) lines.push('', 'Token position data unavailable.');
    else if (!d.positions.length) lines.push('', 'No indexed token positions returned; this is not a complete asset inventory.');
    else lines.push('', ...K.table([
      { title: 'TOKEN', get: p => text(p.symbol ?? p.address) },
      { title: 'BALANCE', align: 'r', get: p => F.fromUnits(p.balanceUnits) },
      { title: 'INDEXED MARK (QUAI)', align: 'r', get: p => (p.indexedValueQuai == null ? '—' : F.fromDecimal(String(p.indexedValueQuai))) },
      { title: 'ADDRESS', priority: 1, get: p => text(p.address), style: s => K.t.muted(s) },
    ], d.positions));
    if (d.basis) lines.push('', text(d.basis));
  } else if (d.view === 'preview') {
    const approvalOnly = d.previewScope === 'approval-only', s = result.plannedTrade ?? result.summary ?? {};
    lines.push(K.t.accentBright('Preflight only · nothing signed or sent'), ...K.kv([['Expected output', text(s.expectedOut)], ['Minimum output', text(s.minOut)]]));
    if (approvalOnly) lines.push('Allowance approval is required; only that approval was simulated.', `Approval gas ceiling: ${text(result.summary?.estimatedFeeQuai)} QUAI`, 'Swap gas: unavailable until the allowance exists and a fresh swap preflight completes.');
    else lines.push(`Trade gas ceiling: ${text(result.summary?.estimatedFeeQuai)} QUAI`);
  } else {
    const rows = d.decisions ?? d.records ?? [];
    if (!rows.length) lines.push('No decisions recorded for this selection.');
    for (const r of rows) {
      const q = r.quote ?? {}, o = r.outcome ?? {};
      lines.push('', K.t.muted(text(r.id)), `  ${K.t.bold(text(r.status ?? o.status ?? r.phase))} · ${text(r.kind ?? r.trade?.kind)} · ${text(r.action ?? q.action)}`, `  Hash: ${text(r.txHash)}`, `  Observed gas: ${quai(r.gasFeeWei ?? o.gasFeeWei)}`, `  Reviewed gas ceiling: ${quai(r.gasCeilingWei ?? q.gasCeilingWei)}`);
      const output = r.output ?? o.output;
      if (output) lines.push(`  Event-derived output: ${text(output.eventDerivedUnits)} base units`, '  Balance/P&L proof: unavailable');
    }
  }
  for (const r of d.decisions ?? d.records ?? []) { if (r.outcomeReason) lines.push(`Receipt evidence (${text(r.id)}):`, `  ${text(r.outcomeReason)}`); }
  if (d.output) lines.push(`Saved report: ${text(d.output)}`);
  if (d.nextCursor) lines.push(`Next journal cursor: ${text(d.nextCursor)}`);
  for (const message of d.warnings ?? []) lines.push(K.t.warn(`Careful: ${text(message)}`));
  if (d.recordingError) lines.push(K.t.warn('Local record issue: ' + text(d.recordingError)));
  if (d.coverage) lines.push('', text(d.coverage));
  if (d.note) lines.push(K.t.muted(text(d.note)));
  return K.frame(lines);
}
