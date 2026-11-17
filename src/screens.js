// packages/hartii-cli/src/screens.js
//
// The designed human views (balance, whoami, networks, gas, limits, token, tokens, tx, block, price, config,
// about, init, doctor, wallet help). Each view is a pure function: (result, kit) -> lines. They read the same
// result objects the commands return for --json, never change them, and never show raw wei or base units
// (exact values stay in --json). `renderScreen` picks the view from the result's tag or its shape.
import { makeKit } from './screenKit.js';
import { safeTerminalText, viewOf, visibleLength } from './output.js';
import * as F from './format.js';
import { nftLinesFor } from './galleryHuman.js';

const text = (v) => (v === null || v === undefined || v === '' ? F.DASH : safeTerminalText(String(v)));
const isNum = (v) => v !== null && v !== undefined && v !== '' && /^\d+(\.\d+)?$/.test(String(v));
const bar = (K, pct, width = 20) => {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  const filled = Math.round((p / 100) * width);
  return `${K.t.accent('█'.repeat(filled))}${K.t.dim('░'.repeat(width - filled))}`;
};
const addr = (K, a, labelWidth = 16) => F.addressLines(a, { width: K.W - labelWidth - 2, emph: (g) => K.t.bold(K.t.accentBright(g)) }).join(String.fromCharCode(10));
const link = (K, url) => K.t.accentBright(text(url));
const num = (v) => (isNum(v) ? F.fromDecimal(String(v)) : F.DASH);

// ---------- balance ----------
function balanceView(r, K) {
  const net = text(r.network);
  const headline = r.quaiWei !== undefined ? F.quai(r.quaiWei, { maxFrac: 6 }) : F.quaiDecimal(r.quai, { maxFrac: 6 });
  if (K.terse) {
    const extra = Array.isArray(r.holdings) ? ` · ${r.holdings.length} token${r.holdings.length === 1 ? '' : 's'}` : '';
    return [`${headline} · ${net}${extra}`];
  }
  const out = [...K.heading('Balance', net), ''];
  out.push(K.t.bold(K.t.text(headline)), '');
  out.push(...K.kv([r.walletName ? ['Wallet', text(r.walletName)] : undefined, ['Address', addr(K, r.wallet)]].filter(Boolean)));
  const empty = r.quaiWei !== undefined ? BigInt(r.quaiWei) === 0n : Number(r.quai) === 0;
  if (empty) out.push('', ...K.callout('info', 'This wallet is empty. Run `hartii receive` to get your address and a QR code.'));
  if (r.holdingsError) out.push('', ...K.callout('warn', text(r.holdingsError)));
  else if (Array.isArray(r.holdings)) {
    out.push(...K.section('Tokens'));
    if (!r.holdings.length) out.push(K.t.muted('No token holdings.'));
    else {
      out.push('', ...K.table([
        { title: 'TOKEN', get: (h) => text(h.symbol), style: (s) => K.t.text(s) },
        { title: 'BALANCE', align: 'r', get: (h) => F.amount(h.balance, { decimals: Number.isInteger(h.decimals) ? h.decimals : 18 }) },
        { title: 'VALUE (QUAI)', align: 'r', get: (h) => (/^(0|[1-9][0-9]*)$/.test(String(h.valueQuai)) ? F.fromUnits(h.valueQuai) : F.DASH) },
        { title: 'ADDRESS', priority: 2, bare: true, get: (h) => text(h.tokenAddress ?? h.address), style: (s) => K.t.muted(s) },
        { title: 'SOURCE', priority: 1, get: (h) => text(h.priceSource), style: (s) => K.t.muted(s) },
      ], r.holdings));
    }
  }
  if (r.nftHoldingsError) out.push('', ...K.callout('warn', text(r.nftHoldingsError)));
  else if (r.nftHoldings) out.push(...nftLinesFor(r.nftHoldings, K));
  return out;
}

// ---------- who am I ----------
function whoamiView(r, K) {
  if (K.terse) return [r.address ? `${text(r.wallet)} · ${F.shortAddress(r.address)} · ${text(r.network)}` : `no wallet · ${text(r.network)}`];
  const out = [...K.heading('Your wallet', text(r.network)), ''];
  if (!r.address) {
    out.push('You do not have a wallet yet.', '', `Create one: ${K.command('hartii wallet new')}`, `Or take the guided tour: ${K.command('hartii init')}`);
    return out;
  }
  out.push(...K.kv([['Name', text(r.wallet)], ['Address', addr(K, r.address)], ['Copy', K.t.muted(text(r.address))], ['Home', K.t.muted(text(r.home))]]));
  return out;
}

// ---------- networks ----------
function networksView(r, K) {
  if (K.terse) return [`${text(r.active)} (active) · ${r.networks.map((n) => `${n.name}:${n.chainId}`).join(' ')}`];
  return [...K.heading('Networks'), '', ...K.table([
    { title: 'NETWORK', get: (n) => `${n.active ? '● ' : '  '}${text(n.name)}`, style: (s, n) => (n.active ? K.t.bold(K.t.accentBright(s)) : K.t.text(s)) },
    { title: 'STATUS', get: (n) => (n.active ? 'active' : 'available'), style: (s, n) => (n.active ? K.t.accentBright(s) : K.t.muted(s)) },
    { title: 'CHAIN', align: 'r', get: (n) => text(n.chainId) },
    { title: 'TRADING & TOOLS', priority: 2, get: (n) => (n.marketAndTools ? 'yes' : 'no') },
    { title: 'NODE', priority: 1, get: (n) => text(n.rpc), style: (s) => K.t.muted(s) },
  ], r.networks), '', K.t.muted('Switch with `hartii config set network <name>` or `--network <name>` on any command.')];
}

// ---------- gas ----------
function gasView(r, K) {
  const gwei = r.gasPriceGwei !== undefined ? `${F.fromDecimal(String(r.gasPriceGwei))} gwei` : F.DASH;
  if (K.terse) return [`${gwei} · send ${F.quaiDecimal(r.transferCostQuai)} · ${text(r.network)}`];
  const out = [...K.heading('Network fees', text(r.network)), ''];
  out.push(...K.kv([
    ['Gas price', gwei],
    ['Send QUAI', r.transferCostQuai === undefined ? undefined : `${F.quaiDecimal(r.transferCostQuai)}   ${K.t.muted('about 39,000 gas')}`],
    ['Trade or tool call', r.contractCallCostQuai === undefined ? undefined : `${F.quaiDecimal(r.contractCallCostQuai)}   ${K.t.muted('about 250,000 gas')}`],
  ], { labelWidth: 18 }));
  out.push('', K.t.muted('Every write is simulated first, so you see the real fee before you confirm.'));
  return out;
}

// ---------- limits ----------
const capText = (v) => (isNum(v) ? F.quaiDecimal(String(v), { exact: true }) : null);
function limitsView(r, K) {
  const per = capText(r.perTxQuai); const day = capText(r.dailyQuai);
  const left = isNum(r.dailyQuai) && isNum(r.spentTodayQuai) ? Math.max(0, Number(r.dailyQuai) - Number(r.spentTodayQuai) - (isNum(r.reservedQuai) ? Number(r.reservedQuai) : 0)) : null;
  if (K.terse) return [`per tx ${per ?? 'no limit'} · per day ${day ?? 'no limit'} · spent today ${F.quaiDecimal(r.spentTodayQuai)}`];
  const out = [...K.heading('Spending limits', text(r.network)), ''];
  out.push(...K.kv([
    ['Wallet', r.wallet ? addr(K, r.wallet) : K.t.muted('no wallet selected')],
    ['Per transaction', per ?? K.t.muted('no limit set')],
    ['Per day', day ?? K.t.muted('no limit set')],
    ['Spent today', F.quaiDecimal(r.spentTodayQuai)],
    isNum(r.reservedQuai) && Number(r.reservedQuai) > 0 ? ['Waiting to settle', F.quaiDecimal(r.reservedQuai)] : undefined,
    left === null ? undefined : ['Left today', F.quaiDecimal(String(left))],
  ].filter(Boolean)));
  if (per === null || day === null) {
    out.push('', 'Limits are optional. They only apply once you set them, and then they work on every send and trade.');
  }
  out.push('', K.t.muted('Change them:'), `  ${K.command('hartii config set limits.perTxQuai <quai>')}`, `  ${K.command('hartii config set limits.dailyQuai <quai>')}`);
  return out;
}

// ---------- token detail ----------
function tokenView(r, K) {
  const tk = r.token || {};
  const sym = text(tk.symbol);
  if (K.terse) return [`${sym} · ${tk.lastPriceWei ? `${F.price(tk.lastPriceWei)} QUAI` : F.DASH} · ${text(tk.status)} · ${F.count(tk.holderCount)} holders`];
  const cs = r.curveState;
  const out = [...K.heading(sym, tk.name ? text(tk.name) : undefined), ''];
  const pct = r.graduationProgress?.progressPct;
  out.push(...K.kv([
    ['Contract', addr(K, tk.address)],
    tk.curveAddress ? ['Curve', addr(K, tk.curveAddress)] : undefined,
    ['Phase', r.graduationProgress?.graduated || tk.status === 'graduated' ? K.t.accentBright('graduated') : text(tk.status)],
    ['Price', tk.lastPriceWei ? `${F.price(tk.lastPriceWei)} QUAI` : F.DASH],
    ['Volume 24h', tk.volume24hWei ? F.quai(tk.volume24hWei) : F.DASH],
    ['Holders', F.count(tk.holderCount)],
    pct !== undefined && pct !== null ? ['Curve progress', `${bar(K, pct)}  ${F.percent(pct)}`] : undefined,
    cs?.feeBps !== undefined ? ['Trading fee', F.percentFromBps(cs.feeBps)] : undefined,
    cs?.tokensSold !== undefined ? ['Sold on curve', `${F.compact(F.fromUnits(cs.tokensSold, { exact: true }).replace(/,/g, ''))} ${sym}`] : undefined,
    cs?.tokensRemaining !== undefined ? ['Left on curve', `${F.compact(F.fromUnits(cs.tokensRemaining, { exact: true }).replace(/,/g, ''))} ${sym}`] : undefined,
  ].filter(Boolean)));
  if (r.curveStateError) out.push('', ...K.callout('warn', text(r.curveStateError)));
  if (r.reference?.error) out.push('', K.t.muted(`Price reference unavailable: ${text(r.reference.error)}`));
  out.push(...K.section('Links'));
  out.push(...K.kv([['Explorer', link(K, r.links?.quaiscanToken)], ['Hartii', link(K, r.links?.hartiilabs)]].filter((x) => x[1] !== F.DASH)));
  out.push('', K.t.muted('Always check the contract address above before you trade a token you do not know.'));
  return out;
}

// ---------- token lists ----------
function tokensView(r, K) {
  const title = r.sort === 'search' ? `Search${r.query ? `: ${safeTerminalText(String(r.query))}` : ''}` : r.sort === 'new' ? 'Newest tokens' : 'Trending tokens';
  if (!r.items.length) return [...(K.terse ? [] : [...K.heading(title), '']), r.query ? `No tokens match "${text(r.query)}". Try a shorter name, or paste the 0x address.` : 'No matching tokens.'];
  if (K.terse) return r.items.map((t) => `${text(t.symbol)}  ${t.lastPriceWei ? F.price(t.lastPriceWei) : F.DASH} QUAI  ${text(t.status)}  ${text(t.address)}`);
  const out = [...K.heading(title), '', ...K.table([
    { title: 'TOKEN', get: (t) => text(t.symbol), style: (s) => K.t.bold(K.t.text(s)) },
    { title: 'PRICE (QUAI)', align: 'r', get: (t) => (t.lastPriceWei ? F.price(t.lastPriceWei) : F.DASH) },
    { title: 'HOLDERS', align: 'r', get: (t) => F.count(t.holderCount) },
    { title: '24H VOLUME', align: 'r', priority: 1, get: (t) => (t.volume24hWei ? F.quai(t.volume24hWei, { sig: 3 }).replace(' QUAI', '') : F.DASH) },
    { title: 'PHASE', get: (t) => text(t.status), style: (s) => (/graduated/.test(s) ? K.t.accentBright(s) : K.t.muted(s)) },
    { title: 'ADDRESS', priority: 2, bare: true, get: (t) => text(t.address), style: (s) => K.t.muted(s) },
  ], r.items)];
  if (r.scope) out.push('', K.t.muted(`Searched: ${text(r.scope)}.`));
  if (r.nextCursor) out.push('', K.t.muted(`More results: --cursor ${text(r.nextCursor)}`));
  if (r.partial) out.push('', ...K.callout('warn', 'Partial directory results.'));
  out.push('', K.t.muted('Details: ') + K.command('hartii token <symbol or address>'));
  return out;
}

// ---------- tx ----------
const TX_STATUS = {
  success: ['Confirmed', 'ok'], reverted: ['Failed (reverted on chain)', 'danger'], pending: ['Pending', 'warn'], 'not found': ['Not found', 'warn'], unknown: ['Unknown', 'warn'],
};
function txView(r, K) {
  const [label, tone] = TX_STATUS[r.status] || [text(r.status), 'warn'];
  if (K.terse) return [`${label} · ${F.shortAddress(r.hash, 10, 6)} · ${text(r.network)}`];
  const out = [...K.heading('Transaction', text(r.network)), ''];
  out.push(...K.kv([
    ['Status', K.t[tone](K.t.bold(label)), undefined],
    ['Hash', text(r.hash)],
    r.blockNumber != null ? ['Block', F.count(r.blockNumber)] : undefined,
    r.from ? ['From', addr(K, r.from)] : undefined,
    r.to ? ['To', addr(K, r.to)] : undefined,
    r.valueQuai !== undefined ? ['Value', F.quaiDecimal(r.valueQuai, { exact: true })] : undefined,
    r.gasUsed != null ? ['Gas used', F.count(r.gasUsed)] : undefined,
    r.quaiscanUrl ? ['Explorer', link(K, r.quaiscanUrl)] : undefined,
  ].filter(Boolean)));
  if (r.status === 'not found') out.push('', K.t.muted('The node has not seen this hash. It may still be on its way, or belong to another network.'));
  if (r.status === 'reverted') out.push('', ...K.callout('danger', 'The transaction was mined but failed, so it did nothing except cost its fee.'));
  return out;
}

// ---------- block / price / list reads ----------
function blockView(r, K) {
  if (K.terse) return [`block ${F.count(r.height)} · ${text(r.network)}`];
  return [...K.heading('Latest block', text(r.network)), '', K.t.bold(K.t.text(F.count(r.height)))];
}
function priceView(r, K) {
  const change = r.change24hPct === null || r.change24hPct === undefined ? null : F.percent(r.change24hPct, { sign: true });
  const price = r.priceWei ? F.price(r.priceWei) : r.priceQuai ?? F.DASH;
  if (K.terse) return [`${text(r.symbol)} ${price} QUAI${change ? ` ${change}` : ''}`];
  return [...K.heading(text(r.symbol), 'price'), '', ...K.kv([
    ['Price', `${K.t.bold(K.t.text(price))} QUAI`],
    change ? ['24h change', change.startsWith('-') ? K.t.danger(`${change} (down)`) : change === '0%' ? change : K.t.ok(`${change} (up)`)] : undefined,
    ['Phase', text(r.phase)],
    ['Holders', F.count(r.holders)],
    r.volume24hQuai ? ['Volume 24h', F.quaiDecimal(r.volume24hQuai)] : undefined,
    r.token ? ['Contract', addr(K, r.token)] : undefined,
    r.note ? ['Note', K.t.muted(text(r.note))] : undefined,
  ].filter(Boolean))];
}
function listView(r, K) {
  const holders = r.items?.[0] && 'holder' in r.items[0];
  const title = `${holders ? 'Top holders' : 'Recent trades'} · ${text(r.token)}`;
  if (!r.items?.length) return [...(K.terse ? [] : [...K.heading(title), '']), 'Nothing to show yet.'];
  if (K.terse) return r.items.map((it) => (holders ? `${text(it.holder)}  ${text(it.balance)}` : `${text(it.side)} ${text(it.quai)} QUAI  ${text(it.trader)}`));
  return [...K.heading(title), '', ...K.table(holders ? [
    { title: 'HOLDER', get: (it) => text(it.holder) },
    { title: 'SHARE', align: 'r', get: (it) => (it.pct == null ? F.DASH : F.percent(it.pct)) },
  ] : [
    { title: 'SIDE', get: (it) => text(it.side), style: (s) => (/^buy/i.test(s) ? K.t.ok(s) : K.t.muted(s)) },
    { title: 'QUAI', align: 'r', get: (it) => (it.quai ? F.fromDecimal(it.quai) : F.DASH) },
    { title: 'TRADER', get: (it) => text(it.trader) },
    { title: 'TX', priority: 1, get: (it) => text(it.tx), style: (s) => K.t.muted(s) },
  ], r.items)];
}

// ---------- config ----------
function flatten(obj, prefix = '') {
  return Object.entries(obj || {}).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? flatten(v, `${prefix}${k}.`) : [[`${prefix}${k}`, v]]));
}
function configView(r, K, kind) {
  const rows = flatten(r);
  // Caps are optional (owner 2026-11-16): a full settings view always names both, saying when none is set.
  if (kind !== 'config.set' && r && typeof r === 'object' && 'network' in r) {
    for (const key of ['limits.perTxQuai', 'limits.dailyQuai']) if (!rows.some(([k]) => k === key)) rows.push([key, null]);
  }
  if (kind === 'config.set') {
    const [k, v] = rows[0] || ['', ''];
    return K.terse ? [`${k} = ${text(v)}`] : [`${K.t.ok('Saved')}  ${K.t.text(k)} = ${K.t.bold(text(v))}`];
  }
  if (K.terse) return rows.map(([k, v]) => `${k} = ${text(v)}`);
  const single = rows.length === 1 && !('network' in r && 'limits' in r);
  if (single) return [`${K.t.muted(rows[0][0])}  ${K.t.bold(text(rows[0][1]))}`];
  const unset = (k) => (k.startsWith('limits.') ? K.t.muted('no cap (optional)') : K.t.muted('not set'));
  return [...K.heading('Settings'), '', ...K.kv(rows.map(([k, v]) => [k, v === null || v === undefined ? unset(k) : text(v)])), '', K.t.muted('Change: ') + K.command('hartii config set <key> <value>')];
}

// ---------- about / init ----------
function aboutView(r, K) {
  if (K.terse) return [`${text(r.name)} ${text(r.version)} ${text(r.status)}`];
  return [...K.heading('Hartii CLI', `${text(r.version)}  ${r.status ? K.t.warn(text(r.status)) : ''}`.trimEnd()), '', ...K.kv([
    ['Node', text(r.node)], ['Home', K.t.muted(text(r.home))], ['Website', link(K, r.site)], ['Docs', link(K, r.docs)], ['Download', link(K, r.download)],
  ]), '', K.t.muted('BETA software: start with small amounts.')];
}
function initView(r, K) {
  const step = (s) => { const m = /^(.+?)\s{2,}(.*)$/.exec(String(s)); return m ? [m[1], m[2]] : [String(s), '']; };
  if (K.terse) return [`${r.wallets} wallet${r.wallets === 1 ? '' : 's'} · ${text(r.network)} · next: ${step(r.nextSteps?.[0] ?? '')[0]}`];
  const mark = (ok) => (ok ? K.t.ok('✓ done ') : K.t.warn('○ to do'));
  const out = [...K.heading('Welcome to Hartii'), ''];
  out.push(...K.wrap(`${K.t.warn(K.t.bold('BETA'))}  The Hartii terminal wallet is beta software; start with small amounts.`, { hang: '      ' }), '');
  out.push(`${mark(r.nodeOk)}  Node ${text(r.node)}${r.nodeOk ? '' : ' (needs 22 or newer)'}`);
  out.push(`${mark(r.wallets > 0)}  Wallet: ${r.wallets > 0 ? `${r.wallets} found${r.currentWallet ? `, using ${text(r.currentWallet)}` : ''}` : 'none yet'}`);
  out.push(`${mark(true)}  Network: ${text(r.network)}`);
  if (r.address) out.push('', ...K.kv([['Address', addr(K, r.address)]]));
  out.push(...K.section('Next steps'));
  (r.nextSteps || []).forEach((s, i) => { const [cmd, why] = step(s); out.push(`${K.t.muted(`${i + 1}.`)} ${K.command(cmd)}`); if (why) out.push(`   ${K.t.muted(why)}`); });
  return out;
}

// ---------- verify-site ----------
function verifySiteView(r, K) {
  const n = (r.failures || []).length;
  const verdict = r.ok
    ? `hartiilabs.com matches the signed build ${text(r.version)} (commit ${text(String(r.commit || '').slice(0, 12))}): ${r.checked} files checked.`
    : `hartiilabs.com does NOT match a build Hartii signed: ${n} problem${n === 1 ? '' : 's'}.`;
  if (K.terse) return [verdict];
  const out = [...K.heading('Verify hartiilabs.com'), '', r.ok ? K.t.ok(K.t.bold(verdict)) : K.t.danger(K.t.bold(verdict)), ''];
  for (const f of (r.failures || []).slice(0, 20)) out.push(...K.wrap(`${K.t.danger('FAIL')}  ${text(f)}`, { hang: '      ' }));
  if (n > 20) out.push(K.t.muted(`...and ${n - 20} more (use --json for all)`));
  if (n) out.push('');
  out.push(...K.kv([['Signing key', K.t.muted(text(r.keyId))], ['Version', text(r.version)]]), '', K.t.muted(r.ok ? 'Checked against the key built into this CLI, not one the website supplies.' : 'Do not trust the site until this is resolved. Nothing was changed on your computer.'));
  return out;
}

// ---------- doctor ----------
const CHECK_LABELS = { rpc: 'Quai node', chainId: 'Network match', keystorePerms: 'Wallet files', addressLedger: 'Current wallet', api: 'Hartii service', clockSkew: 'Clock' };
const FIXES = {
  rpc: () => 'Check your internet connection, then run `hartii doctor` again. To use another node: `hartii doctor --rpc <url>`.',
  chainId: (c) => (/expected 15000/.test(c.detail) ? 'hartii config set network orchard' : 'hartii config set network mainnet'),
  keystorePerms: () => 'hartii wallet lock-check',
  addressLedger: () => 'hartii wallet list   then   hartii wallet use <name>',
  api: () => 'Check your internet connection and run `hartii doctor` again. Sending still works; token lists and portfolio need this service.',
  clockSkew: () => 'Sync your computer clock (Windows: Settings > Time & language > Date & time > Sync now), then run `hartii doctor` again.',
};
function doctorView(r, K) {
  const checks = r.checks || [];
  const failing = checks.filter((c) => c.ok === false);
  const unverified = checks.filter((c) => c.ok === null);
  const verdict = failing.length ? `${failing.length} thing${failing.length === 1 ? '' : 's'} to fix` : 'Ready';
  if (K.terse) return [`${verdict}${unverified.length ? ` (${unverified.length} unverified)` : ''}`];
  const word = (c) => (c.ok === false ? K.t.danger(K.t.bold('FAIL ')) : c.ok === null ? K.t.warn('CHECK') : K.t.ok('OK   '));
  const out = [...K.heading('Health check'), ''];
  for (const c of checks) {
    const lead = `${word(c)}  ${K.t.text(K.pad(CHECK_LABELS[c.name] || text(c.name), 15))} `;
    const room = Math.max(16, K.W - 24);
    if (visibleLength(text(c.detail)) <= room) out.push(`${lead}${K.t.muted(text(c.detail))}`.trimEnd());
    else {
      // A long detail gets its own indented lines under the check, so URLs and hashes are never cut.
      out.push(lead.trimEnd(), ...K.wrapTo(text(c.detail), K.W - 7).map((d) => `       ${K.t.muted(d)}`));
    }
    if (c.ok === false) {
      const fix = (FIXES[c.name] || (() => 'Run `hartii doctor` again.'))(c);
      const cmd = /^hartii /.test(fix) && !/`/.test(fix);
      out.push(...K.wrap(`${K.t.danger('Fix:')} ${cmd ? K.command(fix) : fix}`, { indent: '       ', hang: '       ' }));
    }
  }
  out.push('');
  out.push(failing.length ? K.t.danger(K.t.bold(verdict)) : K.t.ok(K.t.bold(verdict)));
  if (unverified.length) out.push(K.t.muted(`${unverified.length} check${unverified.length === 1 ? '' : 's'} could not be verified on this system.`));
  return out;
}

// ---------- wallet with no subcommand ----------
export const WALLET_SUBCOMMANDS = [
  ['new', 'create an encrypted wallet (you choose the password)'],
  ['import', 'bring in a wallet from a recovery phrase or key'],
  ['list', 'show your wallets'],
  ['use', 'switch the wallet other commands use'],
  ['address', 'show your receive address (add --qr for a code)'],
  ['export', 'show your recovery phrase on a screen that clears'],
  ['rename', 'give a wallet a new name'],
  ['remove', 'delete a wallet from this computer'],
  ['lock-check', 'check that your wallet files are private'],
];
function walletHelpView(r, K) {
  if (K.terse) return [`hartii wallet ${WALLET_SUBCOMMANDS.map((s) => s[0]).join('|')}`];
  return [...K.heading('Wallet'), '', 'Pick what you want to do:', '', ...K.kv(WALLET_SUBCOMMANDS.map(([c, d]) => [K.t.accentBright(`hartii wallet ${c}`), d]), { labelWidth: 23 }), '', K.t.muted('New here? Start with ') + K.command('hartii wallet new')];
}

const VIEWS = {
  balance: balanceView, whoami: whoamiView, networks: networksView, gas: gasView, limits: limitsView, token: tokenView, tokens: tokensView,
  tx: txView, block: blockView, price: priceView, list: listView, about: aboutView, init: initView, doctor: doctorView, 'verify-site': verifySiteView, 'wallet.help': walletHelpView,
  'config.get': (r, K) => configView(r, K, 'config.get'), 'config.set': (r, K) => configView(r, K, 'config.set'),
  open: (r, K) => [K.t.accentBright(text(r.url))],
};

/** The view name for a result: an explicit tag first, then the shape of the established results. */
export function viewName(r) {
  const tag = viewOf(r);
  if (tag) return tag;
  if (!r || typeof r !== 'object') return null;
  if (Array.isArray(r.checks)) return 'doctor';
  if (r.wallet && r.quai !== undefined) return 'balance';
  if (Array.isArray(r.items) && (r.sort !== undefined || r.items.length > 0) && r.items.every((i) => i.address && ('symbol' in i || 'lastPriceWei' in i))) return 'tokens';
  return null;
}

/** Returns the rendered screen (string) or null when the result has no designed view. */
export function renderScreen(result, { colors, width = 80, terse = false } = {}) {
  const name = viewName(result);
  const view = name && VIEWS[name];
  if (!view) return null;
  const K = makeKit({ colors, width, terse });
  const lines = view(result, K);
  const demo = result?.demo ? [K.t.accentBright('DEMO · fixture data · no signing'), ''] : [];
  return terse ? lines.join('\n') : K.frame([...demo, ...lines]).join('\n');
}

export { visibleLength };
