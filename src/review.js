// packages/hartii-cli/src/review.js
//
// The pre-confirm review of a write: one plain sentence first ("You send 2.5 QUAI to ..."), then fee and
// total, then the warnings the safety lane attached (summary.warnings), then a short line saying nothing
// is sent until you confirm. With `details`, the technical fields follow as an aligned block.
//
// Pure: `renderReview(summary, { details, color, width }) -> string`. The summary object itself is the
// machine contract (JSON and MCP use it unchanged); this module only reads it.
import { makeTheme, wrapText, safeTerminalText, visibleLength } from './output.js';
import * as F from './format.js';

const ADDR_IN_LABEL = /^(.*?)\s*\((0x[0-9a-fA-F]{40})\)$/;
const SENTENCE_LABEL = /^(Send|Buy|Sell|Swap|Approve|Airdrop|OTC|Claim|Wall|Wrap|Unwrap)\b/;

/** "TOK (0x...)" -> { symbol: 'TOK', address: '0x...' }; plain text stays a symbol. */
function splitToken(label) {
  const s = String(label ?? '').trim();
  const m = ADDR_IN_LABEL.exec(s);
  return m ? { symbol: safeTerminalText(m[1]) || 'token', address: m[2] } : { symbol: safeTerminalText(s), address: null };
}

const dec = (v) => (v === undefined || v === null || v === '' ? null : String(v));
const decToWei = (v) => {
  const m = /^(\d+)(?:\.(\d{1,18}))?$/.exec(String(v ?? ''));
  return m ? BigInt(m[1]) * 10n ** 18n + BigInt((m[2] || '').padEnd(18, '0')) : null;
};
const exactQuai = (v) => F.quaiDecimal(v, { exact: true });
const exactAmount = (v, symbol) => F.amountDecimal(v, { symbol, exact: true });
const LABELS = {
  chainId: 'Chain', gasLimit: 'Gas limit', gasPriceWei: 'Gas price', estimatedFeeQuai: 'Fee estimate', valueQuai: 'QUAI sent',
  guardedQuai: 'Counts toward limits', guardedWithFeeQuai: 'Limits use, with fee', dataDigest: 'Data digest', dataSelector: 'Call selector',
  dataBytes: 'Data size (bytes)', feeBps: 'Fee', slippageBps: 'Price slack',
};
const humanise = (key) => LABELS[key] ?? key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/ (Quai|Bps)$/, '').replace(/^./, (c) => c.toUpperCase()).replace(/ ([A-Z])(?=[a-z])/g, (m) => m.toLowerCase());

/** The action kind, from the summary's own action text. */
export function reviewKind(summary) {
  const a = String(summary?.action ?? '');
  if (/^(Wrap|Unwrap)/.test(a)) return 'wrap';
  if (/^Approve\b/.test(a)) return 'approve';
  if (/^OTC cancel/.test(a)) return 'otc-cancel';
  if (/^OTC fill/.test(a)) return 'otc-fill';
  if (/^OTC/.test(a)) return 'otc-offer';
  const m = SENTENCE_LABEL.exec(a);
  return m ? m[1].toLowerCase() : 'other';
}

/** [sentence, extra rows] for each action. Falls back to a neutral sentence when fields are missing. */
function describe(summary, kind, k) {
  const s = summary;
  const tok = (label) => splitToken(label);
  const rows = []; // [label, value, tone]
  const withTokenRow = (label, t) => { if (t.address) rows.push([label, `${t.symbol}  ${F.address(t.address, { emph: k.emph })}`]); };
  switch (kind) {
    case 'send': {
      if (s.tokenAmount !== undefined) {
        const t = tok(s.token);
        withTokenRow('Token', t);
        rows.push(['To', F.address(s.recipient ?? s.to, { emph: k.emph })]);
        return [`You send ${exactAmount(s.tokenAmount, t.symbol)} to ${F.shortAddress(s.recipient ?? s.to)}.`, rows, { toRow: true }];
      }
      return [`You send ${exactQuai(s.valueQuai)} to ${F.shortAddress(s.to)}.`, [['To', F.address(s.to, { emph: k.emph })]], { toRow: true }];
    }
    case 'buy': {
      const t = tok(s.token);
      withTokenRow('Token', t);
      if (s.minTokensOut) rows.push(['You get at least', exactAmount(s.minTokensOut, t.symbol)]);
      if (s.slippageBps) rows.push(['Price slack', F.percentFromBps(s.slippageBps)]);
      return [`You buy about ${exactAmount(s.expectedTokensOut, t.symbol)} for ${exactQuai(s.quaiIn ?? s.valueQuai)}.`, rows];
    }
    case 'sell': {
      const t = tok(s.token);
      withTokenRow('Token', t);
      if (s.minQuaiOut) rows.push(['You get at least', exactQuai(s.minQuaiOut)]);
      if (s.slippageBps) rows.push(['Price slack', F.percentFromBps(s.slippageBps)]);
      return [`You sell ${exactAmount(s.tokensIn, t.symbol)} for about ${exactQuai(s.expectedQuaiOut)}.`, rows];
    }
    case 'swap': {
      const a = tok(s.tokenIn ?? ''); const b = tok(s.tokenOut ?? '');
      withTokenRow('You give', a); withTokenRow('You get', b);
      if (s.minOut) rows.push(['You get at least', exactAmount(s.minOut, b.symbol)]);
      if (s.slippageBps) rows.push(['Price slack', F.percentFromBps(s.slippageBps)]);
      return [`You swap ${exactAmount(s.amountIn, a.symbol)} for about ${exactAmount(s.expectedOut, b.symbol)}.`, rows];
    }
    case 'approve': {
      const m = /^Approve (.+?) for (.+)$/.exec(String(s.action));
      const t = tok(m ? m[1] : s.token ?? '');
      withTokenRow('Token', t);
      return [`You let ${safeTerminalText(m ? m[2] : 'this contract')} use your ${t.symbol || 'tokens'}. This step moves no funds by itself.`, rows];
    }
    case 'airdrop':
      return [`You send ${exactAmount(s.total, tok(s.asset ?? '').symbol)} to ${F.count(s.recipients)} people.`, rows];
    case 'otc-offer':
      return [`You offer ${safeTerminalText(s.offering ?? 'tokens')} for ${exactQuai(s.wantedQuai)}. Your tokens stay in your wallet until someone fills it.`, rows];
    case 'otc-fill':
      return [`You pay ${exactQuai(s.totalDueQuai)} and receive ${safeTerminalText(s.receiving ?? 'the offered tokens')}.`, rows];
    case 'otc-cancel':
      return [`You cancel your offer${s.offer ? ` of ${safeTerminalText(s.offer)}` : ''}.`, rows];
    case 'claim':
      return [`You claim ${safeTerminalText(s.claiming ?? 'your allocation')}.`, rows];
    case 'wall':
      return [`You engrave "${safeTerminalText(s.message ?? '')}" on the Hartii wall${s.maxSentQuai ? ` for up to ${exactQuai(s.maxSentQuai)}` : ''}.`, rows];
    case 'wrap':
      return [`${/^Wrap/.test(String(s.action)) ? `You wrap ${exactQuai(s.amountIn)} into WQUAI` : `You unwrap ${exactAmount(s.amountIn, 'WQUAI')} into QUAI`}.`, rows];
    default:
      return [`You are about to: ${safeTerminalText(s.action ?? 'send a transaction')}.`, rows];
  }
}

function detailRows(summary, k) {
  const skip = new Set(['action', 'warnings']);
  const rows = [];
  for (const [key, raw] of Object.entries(summary)) {
    if (skip.has(key) || raw === undefined || raw === null) continue;
    const label = humanise(key);
    let value;
    if (key === 'gasPriceWei') value = `${F.fromUnits(raw, { decimals: 9, exact: true })} gwei`;
    else if (/Bps$/.test(key)) value = F.percentFromBps(raw);
    else if (/Quai$/.test(key)) value = exactQuai(raw);
    else if (['from', 'to', 'recipient', 'contract', 'curveAddress', 'tokenAddress', 'maker'].includes(key) && F.checksummed(raw)) value = F.address(raw, { emph: k.emph });
    else if (typeof raw === 'object') value = safeTerminalText(JSON.stringify(raw, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
    else value = safeTerminalText(String(raw));
    rows.push([label, value]);
  }
  return rows;
}

/**
 * @param {object} summary the write pipeline's summary (unchanged)
 * @param {{ details?: boolean, color?: boolean, width?: number, dryRun?: boolean, depth?: number, terse?: boolean }} [opts]
 * @returns {string}
 */
export function renderReview(summary, { details = false, color = true, width = 80, dryRun = false, depth, terse = false } = {}) {
  const s = summary && typeof summary === 'object' ? summary : {};
  const t = makeTheme({ depth: color ? (depth ?? 24) : 0 });
  const W = Math.max(40, Math.min(Number(width) || 80, 110)) - 4;
  const k = { emph: (g) => t.bold(t.accentBright(g)) };
  const kind = reviewKind(s);
  const [sentence, rows, meta = {}] = describe(s, kind, k);

  if (terse && !details) {
    const fee = decToWei(s.estimatedFeeQuai);
    const warn = (Array.isArray(s.warnings) ? s.warnings : []).filter((w) => w && w.level === 'danger').length;
    return `${sentence.replace(/\.$/, '')} · fee ${fee === null ? F.DASH : F.quai(fee, { exact: true })}${warn ? ` · ${t.danger(`${warn} warning${warn === 1 ? '' : 's'}`)}` : ''} · ${dryRun ? 'preview only' : 'not sent until you confirm'}`;
  }
  const out = [];
  out.push(`${t.accent('▍')} ${t.bold(t.text(safeTerminalText(String(s.action ?? 'Transaction'))))}${s.network && s.network !== 'mainnet' ? `  ${t.warn(`on ${safeTerminalText(String(s.network))}`)}` : `  ${t.muted(safeTerminalText(String(s.network ?? '')))}`}`.trimEnd());
  out.push(t.dim('─'.repeat(Math.min(W, 44))));
  out.push('');
  out.push(...wrapText(t.text(sentence), W));

  const labelW = Math.max(14, ...rows.map((r) => Array.from(r[0]).length), 'Total'.length);
  const row = (label, value, tone) => {
    const style = tone ? t[tone] : (x) => x;
    const room = Math.max(12, W - labelW - 2);
    const lines = visibleLength(value) <= room ? [value] : wrapText(value, room);
    return lines.map((l, i) => `${i === 0 ? t.muted(label.padEnd(labelW)) : ' '.repeat(labelW)}  ${style(l)}`);
  };
  if (rows.length) { out.push(''); for (const r of rows) out.push(...row(r[0], r[1], r[2])); }

  // Fee and total. Total is the most QUAI that can leave the wallet: native value plus the network fee.
  const feeWei = decToWei(s.estimatedFeeQuai);
  const valueWei = decToWei(s.valueQuai) ?? 0n;
  out.push('');
  if (feeWei !== null) {
    const seconds = Number.isFinite(Number(s.etaSeconds)) ? Number(s.etaSeconds) : undefined;
    out.push(...row('Network fee', `up to ${F.fee(feeWei, { seconds, up: true })}`));
    out.push(...row('Total in QUAI', t.bold(`up to ${F.quai(valueWei + feeWei, { up: true, maxFrac: 4 })}`)));
  } else {
    out.push(...row('Network fee', F.DASH));
  }

  // Warnings: danger first. Every level carries a word, never colour alone.
  const warnings = Array.isArray(s.warnings) ? s.warnings.filter((w) => w && typeof w.text === 'string') : [];
  const order = { danger: 0, warn: 1, info: 2 };
  warnings.sort((a, b) => (order[a.level] ?? 3) - (order[b.level] ?? 3));
  if (warnings.length) {
    out.push('');
    for (const w of warnings) {
      const word = w.level === 'danger' ? 'Warning' : w.level === 'warn' ? 'Careful' : 'Note';
      const tone = w.level === 'danger' ? t.danger : w.level === 'warn' ? t.warn : t.accentBright;
      out.push(...wrapText(`${tone(t.bold(`${word}:`))} ${safeTerminalText(w.text)}`, W, { hang: ' '.repeat(word.length + 2) }));
    }
  }

  if (details) {
    const dr = detailRows(s, k);
    const dl = Math.min(20, Math.max(...dr.map((r) => Array.from(r[0]).length), 4));
    out.push('', t.bold(t.text('Details')), t.dim('─'.repeat(Math.min(W, 44))));
    for (const [label, value] of dr) {
      const room = Math.max(12, W - dl - 2);
      const lines = visibleLength(value) <= room ? [value] : wrapText(value, room);
      lines.forEach((l, i) => out.push(`${i === 0 ? t.muted(label.padEnd(dl)) : ' '.repeat(dl)}  ${l}`));
    }
  }

  out.push('', ...wrapText(t.muted(dryRun ? 'This is a preview. Nothing is sent.' : 'Nothing is sent until you confirm.'), W));
  return out.map((l) => (l === '' ? '' : `  ${l}`)).join('\n');
}
