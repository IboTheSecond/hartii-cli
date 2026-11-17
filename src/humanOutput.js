import { makeColors, safeTerminalText } from './output.js';
import { formatAmount } from './amount.js';
import { renderReceiveQr } from './qr.js';
import { formatGalleryView } from './galleryHuman.js';
import { formatDeskResult } from './desk/human.js';
import { renderScreen } from './screens.js';
import { renderReview } from './review.js';
import { makeKit } from './screenKit.js';
import * as F from './format.js';

const text = value => value === null || value === undefined ? '—' : safeTerminalText(String(value));
function wei(value) {
  try {
    if (typeof value === 'string') { if (!/^(0|[1-9][0-9]*)$/.test(value) || value.length > 78) return '—'; }
    else if (typeof value !== 'bigint') return '—';
    const amount = BigInt(value);
    return amount < 0n || amount >= 2n ** 256n ? '—' : formatAmount(amount);
  } catch { return '—'; }
}

const labelOf = key => text(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/ (Quai|Bps|Pct)$/, '').replace(/^./, c => c.toUpperCase()).replace(/ ([A-Z])(?=[a-z])/g, m => m.toLowerCase());
function valueOf(key, item) {
  if (typeof item === 'boolean') return item ? 'yes' : 'no';
  if (/Bps$/.test(key) && item !== null && item !== '') return F.percentFromBps(item);
  if (/Pct$/.test(key) && item !== null && item !== '') return F.percent(item);
  if (/Quai$/.test(key) && /^-?\d+(\.\d+)?$/.test(String(item))) return F.quaiDecimal(String(item));
  return text(item);
}
/** Plain readable fallback for results without a designed view. Nested objects become indented groups. */
function fields(value, K, depth = 0) {
  const pad = '  '.repeat(depth);
  if (!value || typeof value !== 'object') return [pad + text(value)];
  const lines = [];
  const scalars = [];
  const flush = () => { if (scalars.length) { lines.push(...K.kv(scalars).map(l => pad + l)); scalars.length = 0; } };
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    const label = labelOf(key);
    if (Array.isArray(item)) {
      flush();
      lines.push(pad + K.t.bold(label) + (item.length ? '' : K.t.muted('  none')));
      for (const row of item) { lines.push(...fields(row, K, depth + 1)); if (row && typeof row === 'object') lines.push(''); }
      if (lines[lines.length - 1] === '') lines.pop();
    } else if (item && typeof item === 'object') {
      flush();
      lines.push(pad + K.t.bold(label), ...fields(item, K, depth + 1));
    } else scalars.push([label, valueOf(key, item)]);
  }
  flush();
  return lines;
}

/** The line a finished (or cancelled, or previewed) write prints after the review. */
function writeOutcome(result, K, colors) {
  const s = result.summary;
  const action = text(s.action || 'Transaction');
  const lines = [];
  if (result.demo) {
    // Demo results never ran the pipeline, so nobody printed the review yet.
    lines.push(colors.purple('DEMO · fixture data · no signing'), '', ...renderReview(s, { color: colors.enabled, depth: colors.depth, width: K.W + 4, dryRun: true, terse: K.terse }).split('\n'));
    return { lines, framed: true };
  }
  if (result.aborted) lines.push(`${K.t.warn(K.t.bold('Aborted'))}  ${action}. Nothing was sent.`);
  else if (result.dryRun) lines.push(`${K.t.accentBright(K.t.bold('Preview only'))}  ${action}. Nothing was sent.`);
  else if (result.ok === false) lines.push(`${K.t.danger(K.t.bold('Failed'))}  ${action}.`);
  else {
    lines.push(`${K.t.ok(K.t.bold('Done'))}  ${action} is confirmed on chain.`);
    if (result.txHash || result.quaiscanUrl) lines.push('', ...K.kv([result.txHash ? ['Transaction', text(result.txHash)] : undefined, result.quaiscanUrl ? ['Explorer', K.t.accentBright(text(result.quaiscanUrl))] : undefined].filter(Boolean)));
  }
  if (result.note) lines.push('', text(result.note));
  return { lines, framed: false };
}

/**
 * Human formatting only. JSON stays lossless and machine-readable in output.printJson.
 * `width` is the terminal width (default 80); `terse` keeps one line per result.
 */
export function formatHumanResult(result, { colors = makeColors({ enabled: false }), width = process.stdout?.columns || 80, terse = false } = {}) {
  const deskView = formatDeskResult(result, colors, { width, terse });
  if (deskView) return deskView.join('\n');
  const galleryView = formatGalleryView(result, colors, { width, terse });
  if (galleryView) return galleryView.join('\n');
  const screen = renderScreen(result, { colors, width, terse });
  if (screen !== null) return screen;

  const K = makeKit({ colors, width, terse });
  const lines = [];
  if (result?.demo) lines.push(colors.purple('DEMO · fixture data · no signing'));
  if (result?.qr?.matrix) {
    if (result?.aborted) lines.push(colors.yellow('Aborted'));
    lines.push(colors.bold(`Receive QUAI · ${text(result.network || 'selected wallet')}`), `Address: ${text(result.address)}`);
    if (result.paylink) lines.push(`HPAY: ${text(result.paylink)}`);
    const qr = renderReceiveQr(result.qr.matrix, { color: colors.enabled });
    const columns = process.stdout.columns || 80;
    if (qr.width <= columns) lines.push('', qr.text); else lines.push(`QR needs ${qr.width} terminal columns. Export it with --out payment.svg or widen the terminal.`);
    if (result.savedTo) lines.push(`QR saved: ${text(result.savedTo)}`);
    if (result.note) lines.push('', text(result.note));
  } else if (Array.isArray(result?.pending)) {
    lines.push(colors.bold(`${result.pending.length} locally unresolved reservation${result.pending.length === 1 ? '' : 's'}`));
    if (result.lock?.exists) lines.push('A local spending lock is present. Its owner and submission outcome require review; this command does not unlock it.');
    for (const row of result.pending) {
      lines.push('', `Reservation ${text(row.id)}`, `  Sender: ${text(row.address)}`, `  Chain: ${row.chainId == null ? 'unknown (legacy record)' : text(row.chainId)} · First seen: ${text(row.createdAt || row.date)}`, `  Reserved QUAI exposure and fee: ${wei(row.amountWei)}`, `  Hash: ${row.txHash ? text(row.txHash) : 'not recorded — outcome requires review'}`);
      if (row.txHash) lines.push(`  Inspect: hartii tx ${text(row.txHash)}`);
    }
    if (result.note) lines.push('', text(result.note));
  } else if (result?.summary) {
    const outcome = writeOutcome(result, K, colors);
    if (outcome.framed) return outcome.lines.join('\n');
    lines.push(...outcome.lines);
    return K.frame(lines).join('\n');
  } else {
    if (result?.aborted) lines.push(colors.yellow('Aborted'));
    else if (result?.ok === false) lines.push(colors.red('Failed'));
    lines.push(...fields(Object.fromEntries(Object.entries(result || {}).filter(([k]) => !['ok', 'demo', 'aborted'].includes(k))), K));
    return K.frame(lines).join('\n');
  }
  return lines.join('\n');
}

