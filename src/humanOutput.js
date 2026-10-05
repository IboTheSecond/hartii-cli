import { formatTable, makeColors, safeTerminalText } from './output.js';
import { formatAmount } from './amount.js';

const text = value => value === null || value === undefined ? '—' : safeTerminalText(String(value));
function wei(value) { try { return value == null ? '—' : formatAmount(BigInt(value)); } catch { return '—'; } }
function fields(value, prefix = '') {
  if (!value || typeof value !== 'object') return [prefix + text(value)];
  const lines = [];
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    const label = prefix + text(key);
    if (Array.isArray(item)) {
      lines.push(`${label}: ${item.length ? '' : 'none'}`);
      for (const row of item) lines.push(...fields(row, '  '));
    } else if (item && typeof item === 'object') {
      lines.push(`${label}:`, ...fields(item, '  '));
    } else lines.push(`${label}: ${text(item)}`);
  }
  return lines;
}

/** Human formatting only. JSON stays lossless and machine-readable in output.printJson. */
export function formatHumanResult(result, { colors = makeColors({ enabled: false }) } = {}) {
  const lines = [];
  if (result?.demo) lines.push(colors.purple('DEMO · fixture data · no signing'));
  if (result?.aborted) lines.push(colors.yellow('Aborted'));
  else if (result?.ok === false) lines.push(colors.red('Failed'));
  if (Array.isArray(result?.checks)) {
    lines.push(formatTable(result.checks.map(c => [c.ok ? 'PASS' : 'FAIL', text(c.name), text(c.detail)])));
  } else if (Array.isArray(result?.items) && (result.sort !== undefined || result.items.length > 0) && result.items.every(item => item.address && ('symbol' in item || 'lastPriceWei' in item))) {
    if (!result.items.length) lines.push('No matching tokens.');
    else lines.push(formatTable([
      ['SYMBOL', 'PRICE · QUAI', 'HOLDERS', 'PHASE', 'ADDRESS'],
      ...result.items.map(t => [text(t.symbol), wei(t.lastPriceWei), text(t.holderCount), text(t.status), text(t.address)]),
    ]));
    if (result.nextCursor) lines.push(`Next cursor: ${text(result.nextCursor)}`);
    if (result.partial) lines.push('Partial directory results.');
  } else if (result?.wallet && result.quai !== undefined) {
    lines.push(colors.bold(`${text(result.quai)} QUAI`), `${text(result.network)} · ${text(result.wallet)}`);
    if (result.holdingsError) lines.push(colors.yellow(text(result.holdingsError)));
    else if (Array.isArray(result.holdings)) {
      lines.push(result.holdings.length ? formatTable([
        ['TOKEN', 'BALANCE · BASE UNITS', 'VALUE · QUAI', 'PRICE SOURCE'],
        ...result.holdings.map(h => [text(h.symbol), text(h.balance), text(h.valueQuai), text(h.priceSource)]),
      ]) : 'No token holdings.');
    }
  } else if (result?.summary) {
    lines.push(colors.bold(text(result.summary.action || 'Transaction')));
    if (result.dryRun) lines.push('Simulation only · not sent');
    lines.push(...fields(Object.fromEntries(Object.entries(result.summary).filter(([k]) => k !== 'action'))));
    if (result.quaiscanUrl) lines.push(text(result.quaiscanUrl));
    if (result.note) lines.push(text(result.note));
  } else {
    lines.push(...fields(Object.fromEntries(Object.entries(result || {}).filter(([k]) => !['ok', 'demo', 'aborted'].includes(k)))));
  }
  return lines.join('\n');
}
