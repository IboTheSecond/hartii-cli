import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Interface, getAddress, keccak256, solidityPacked } from 'quais';
import { runAirdrop, parseRecipientsCsv, splitBatches } from '../src/commands/airdrop.js';
import { runOtc, parseExpiry } from '../src/commands/otc.js';
import { runClaim, buildTree, proofFor, leafHash, leavesUrl, parseCampaignId } from '../src/commands/claim.js';
import { runWall } from '../src/commands/wall.js';
import { biomeAddress } from '../src/biomeAddresses.js';
import { ERC20_ABI } from '../src/abi/erc20.js';
import { HARTII_AIRDROP_ABI, HARTII_OTC_ABI, HARTII_CLAIM_ABI, QUAI_WALL_V2_ABI } from '../src/abi/hartiiTools.js';
import { saveConfig } from '../src/config.js';
import { main } from '../src/cli.js';

const addr = (n) => getAddress(`0x001${String(n).padStart(37, '0')}`);
const FROM = addr(1), TOKEN = addr(2), CONTRACT = addr(9), MAKER = addr(5);
const ONE = 10n ** 18n;
const erc = new Interface(ERC20_ABI);
const air = new Interface(HARTII_AIRDROP_ABI), otc = new Interface(HARTII_OTC_ABI), clm = new Interface(HARTII_CLAIM_ABI), wall = new Interface(QUAI_WALL_V2_ABI);
const ifaces = [erc, air, otc, clm, wall];

let home;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hartii-m3-'));
  mkdirSync(join(home, 'keystore'));
  writeFileSync(join(home, 'keystore', 'test.json'), JSON.stringify({ address: FROM.slice(2) }));
  saveConfig(home, { network: 'mainnet', currentWallet: 'test', limits: { perTxQuai: '1000', dailyQuai: '5000' } });
  vi.stubGlobal('fetch', vi.fn(() => { throw Error('No live network in tests'); }));
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); vi.unstubAllGlobals(); });

/** Mock chain: `handlers[fnName](args, parsed)` returns the decoded return values (array). */
function harness(handlers = {}, { leaves = null, liveDoc = null, status = 200 } = {}) {
  const calls = [];
  const provider = {
    call: vi.fn(async (tx) => {
      for (const iface of ifaces) {
        let parsed;
        try { parsed = iface.parseTransaction({ data: tx.data }); } catch { /* next */ }
        if (!parsed) continue;
        calls.push({ name: parsed.name, args: parsed.args, to: tx.to, value: tx.value });
        const h = handlers[parsed.name];
        if (!h) { if (parsed.name === 'paused') return iface.encodeFunctionResult('paused', [false]); return '0x'; }
        return iface.encodeFunctionResult(parsed.name, h(parsed.args, tx));
      }
      return '0x';
    }),
    createAccessList: vi.fn(async () => []),
    estimateGas: vi.fn(async () => 100000n), getNetwork: vi.fn(async () => ({ chainId: 9n })),
    getFeeData: vi.fn(async () => ({ gasPrice: 1n })),
    getTransactionCount: vi.fn(async () => 0),
    getBalance: vi.fn(async () => 1000n * ONE),
    destroy: vi.fn(),
  };
  const fetchFn = vi.fn(async (url, init) => {
    if (init?.method === 'POST') return { status: 200, ok: true, json: async () => ({ result: '0x9' }) };
    if (String(url).includes('live-addresses')) return { status: 200, ok: true, json: async () => liveDoc || { mainnet: { hartiiAirdrop: CONTRACT, hartiiOtcLink: CONTRACT, hartiiClaim: CONTRACT } } };
    if (String(url).includes('/api/claims/leaves/') || String(url).startsWith('https://leaves.example')) {
      if (!leaves) return { status: 404, ok: false, text: async () => '' };
      const body = JSON.stringify(leaves);
      return { status: status, ok: status < 400, headers: { get: () => String(body.length) }, text: async () => body };
    }
    if (String(url).includes('/api/token/')) return { status: 200, ok: true, json: async () => ({ token: { address: TOKEN, symbol: 'TEST', network: 'mainnet' } }) };
    throw new Error(`unexpected fetch ${url}`);
  });
  const sendTransaction = vi.fn(async () => ({ hash: '0x' + 'ab'.repeat(32), wait: async () => ({ status: 1 }) }));
  const deps = {
    trustLiveAddresses: true, // fixtures serve a synthetic contract via live-addresses.json; H1 regression tests below cover the default
    fetchFn, providerFactory: () => provider,
    io: { write: vi.fn(), writeErr: vi.fn(), confirmFn: async () => true },
    passwordDeps: { promptFn: () => { throw Error('Must not decrypt on dry-run'); } },
    walletFactory: () => ({ sendTransaction }),
  };
  return { provider, deps, calls, sendTransaction, fetchFn };
}
const erc20Handlers = (over = {}) => ({
  symbol: () => ['TST'], decimals: () => [18], balanceOf: () => [1000n * ONE], allowance: () => [10n ** 30n], ...over,
});

describe('biome addresses', () => {
  it('H1: bundled address is authoritative; a different live address is refused', async () => {
    const bundled = await biomeAddress('airdrop', { fetchFn: async () => { throw new Error('offline'); } });
    expect(bundled.source).toBe('bundled');
    const same = await biomeAddress('airdrop', { fetchFn: async () => ({ status: 200, json: async () => ({ mainnet: { hartiiAirdrop: bundled.address } }) }) });
    expect(same).toEqual({ address: bundled.address, source: 'live' });
    const differing = { fetchFn: async () => ({ status: 200, json: async () => ({ mainnet: { hartiiAirdrop: CONTRACT } }) }) };
    await expect(biomeAddress('airdrop', differing)).rejects.toThrow(/update the Hartii CLI/);
    const trusted = await biomeAddress('airdrop', { ...differing, trustLiveAddresses: true });
    expect(trusted.address).toBe(CONTRACT);
    expect(trusted.source).toMatch(/UNVERIFIED/);
    const bad = await biomeAddress('claim', { fetchFn: async () => ({ status: 200, json: async () => ({ mainnet: { hartiiClaim: '0x0080000000000000000000000000000000000001' } }) }) });
    expect(bad.source).toBe('bundled'); // a Qi-ledger answer is never trusted
  });
  it('H1: --trust-live-addresses is a human-CLI flag only (MCP deps never carry it)', async () => {
    const { buildTools } = await import('../src/mcp/tools.js');
    expect(buildTools.toString()).not.toMatch(/trustLive/);
  });
  it('is mainnet-only', async () => {
    await expect(biomeAddress('airdrop', { network: 'orchard', fetchFn: async () => { throw new Error('no'); } })).rejects.toThrow(/mainnet-only/);
  });
});

describe('airdrop', () => {
  it('parses CSV rows: header, same-amount, duplicates, Qi rejection', () => {
    const a = addr(11), b = addr(12);
    const ok = parseRecipientsCsv(`address,amount\n${a},1.5\n${b},2\n${a},1.5\n`, 18);
    expect(ok.errors).toEqual([]);
    expect(ok.rows.length).toBe(2);
    expect(ok.duplicates).toBe(1);
    expect(ok.total).toBe(3n * ONE + ONE / 2n);
    expect(parseRecipientsCsv(`${a}\n${b}\n`, 18, '2').total).toBe(4n * ONE);
    expect(parseRecipientsCsv(`${a},1\n${a},2\n`, 18).errors[0].reason).toMatch(/conflicting/);
    expect(parseRecipientsCsv('0x0080000000000000000000000000000000000001,1\n', 18).errors[0].reason).toMatch(/Qi/);
    expect(parseRecipientsCsv(`${a},0\n`, 18).errors.length).toBe(1);
    expect(splitBatches(Array.from({ length: 1001 }, () => ({}))).map((x) => x.length)).toEqual([500, 500, 1]);
  });

  it('dry-run QUAI plan: value = total + live fee, batches of 500, never signs', async () => {
    const rows = Array.from({ length: 501 }, (_, i) => `${addr(100 + i)},1`).join('\n');
    writeFileSync(join(home, 'l.csv'), rows);
    const { provider, deps, sendTransaction } = harness({ quoteFee: ([n]) => [ONE + (5n * ONE / 100n) * n] });
    const r = await runAirdrop({ home, csv: join(home, 'l.csv'), wallet: 'test', dryRun: true, json: true }, deps);
    expect(r.ok).toBe(true);
    expect(r.plan.batches).toBe(2);
    expect(r.batches.length).toBe(2);
    expect(r.batches[0].summary.valueQuai).toBe(formatE(500n * ONE + ONE + 25n * ONE));
    expect(r.batches[1].summary.valueQuai).toBe(formatE(1n * ONE + ONE + (5n * ONE) / 100n));
    expect(sendTransaction).not.toHaveBeenCalled();
    expect(provider.destroy).toHaveBeenCalled();
  });

  it('token airdrop with short allowance simulates only the exact approval', async () => {
    writeFileSync(join(home, 'l.csv'), `${addr(11)},5\n${addr(12)},5\n`);
    const { deps, calls } = harness({ ...erc20Handlers({ allowance: () => [0n] }), quoteFee: () => [ONE], approve: () => [true] });
    const r = await runAirdrop({ home, csv: join(home, 'l.csv'), token: TOKEN, wallet: 'test', dryRun: true }, deps);
    expect(r.tradeSimulated).toBe(false);
    expect(r.summary.action).toMatch(/Approve/);
    expect(r.summary.allowance).toBe('10.0');
    expect(calls.some((c) => c.name === 'airdropToken')).toBe(false);
  });

  it('refuses an invalid CSV and an insufficient balance', async () => {
    writeFileSync(join(home, 'bad.csv'), 'not-an-address,1\n');
    const h = harness({ quoteFee: () => [ONE] });
    await expect(runAirdrop({ home, csv: join(home, 'bad.csv'), wallet: 'test', dryRun: true }, h.deps)).rejects.toThrow(/invalid row/);
    writeFileSync(join(home, 'big.csv'), `${addr(11)},5000\n`);
    await expect(runAirdrop({ home, csv: join(home, 'big.csv'), wallet: 'test', dryRun: true }, h.deps)).rejects.toThrow(/Insufficient QUAI/);
  });

  it('refuses orchard', async () => {
    writeFileSync(join(home, 'l.csv'), `${addr(11)},1\n`);
    const h = harness();
    await expect(runAirdrop({ home, csv: join(home, 'l.csv'), wallet: 'test', network: 'orchard', dryRun: true }, h.deps)).rejects.toThrow(/mainnet-only/);
  });
});

function formatE(wei) { const s = wei.toString().padStart(19, '0'); const w = s.slice(0, -18); const f = s.slice(-18).replace(/0+$/, ''); return `${w}.${f || '0'}`; }

describe('otc', () => {
  const offer = (over = {}) => ({ maker: MAKER, tokenOffered: TOKEN, amountOffered: 100n * ONE, amountWanted: 10n * ONE, takerOnly: '0x' + '0'.repeat(40), expiry: 0n, active: true, filled: false, ...over });
  const base = (over = {}) => ({
    ...erc20Handlers(),
    offers: () => { const o = offer(over); return [o.maker, o.tokenOffered, o.amountOffered, o.amountWanted, o.takerOnly, o.expiry, o.active, o.filled]; },
    quoteFill: () => [10n * ONE + ONE / 20n, ONE / 20n, true],
    offerCount: () => [3n], offersByMaker: (a) => [[1n, 2n].slice(Number(a[1]))], minOfferNotional: () => [ONE], feeBps: () => [50n],
  });

  it('parses expiry strings within the contract cap', () => {
    expect(parseExpiry('7d')).toBe(7 * 86400);
    expect(parseExpiry('12h')).toBe(12 * 3600);
    expect(parseExpiry('none')).toBe(0);
    expect(() => parseExpiry('45d')).toThrow(/30 days/);
    expect(() => parseExpiry('soon')).toThrow();
  });

  it('list --mine pages through every offer, not just the first 500 (contract may clamp the page size)', async () => {
    const all = Array.from({ length: 1200 }, (_, i) => BigInt(i + 1));
    const page = (a, clamp) => [all.slice(Number(a[1]), Number(a[1]) + Math.min(Number(a[2]), clamp))];
    for (const clamp of [500, 100, 37]) {
      const { deps } = harness({ ...base(), offersByMaker: (a) => page(a, clamp) });
      const r = await runOtc({ home, sub: 'list', mine: true, wallet: 'test', limit: '3', status: 'all' }, deps);
      expect(r.items.map((i) => i.id)).toEqual(['1200', '1199', '1198']);
      expect(r.truncated).toBeUndefined();
    }
  });

  it('list --mine flags truncation at the 5000-id cap instead of silently dropping the rest', async () => {
    const endless = (a) => [Array.from({ length: Number(a[2]) }, (_, i) => BigInt(Number(a[1]) + i + 1))];
    const { deps } = harness({ ...base(), offersByMaker: endless });
    const r = await runOtc({ home, sub: 'list', mine: true, wallet: 'test', limit: '1', status: 'all' }, deps);
    expect(r.truncated).toBe(true);
    expect(r.note).toMatch(/newest are missing/);
    expect(r.items[0].id).toBe('5000');
  });

  it('fill dry-run sends exactly amountWanted + live fee as value', async () => {
    const { deps, sendTransaction } = harness(base());
    const r = await runOtc({ home, sub: 'fill', id: '1', wallet: 'test', dryRun: true }, deps);
    expect(r.ok).toBe(true);
    expect(r.summary.valueQuai).toBe('10.05');
    expect(r.summary.serviceFeeQuai).toBe('0.05');
    expect(r.summary.receiving).toBe(`100.0 TST (${TOKEN})`); // M6: address next to the symbol
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it('refuses to fill your own, a restricted, an expired or a filled offer', async () => {
    await expect(runOtc({ home, sub: 'fill', id: '1', wallet: 'test', dryRun: true }, harness(base({ maker: FROM })).deps)).rejects.toThrow(/own offer/);
    await expect(runOtc({ home, sub: 'fill', id: '1', wallet: 'test', dryRun: true }, harness(base({ takerOnly: addr(7) })).deps)).rejects.toThrow(/restricted/);
    await expect(runOtc({ home, sub: 'fill', id: '1', wallet: 'test', dryRun: true, }, harness(base({ expiry: 5n })).deps)).rejects.toThrow(/expired/);
    await expect(runOtc({ home, sub: 'fill', id: '1', wallet: 'test', dryRun: true }, harness(base({ filled: true, active: false })).deps)).rejects.toThrow(/filled/);
  });

  it('cancel is maker-only', async () => {
    await expect(runOtc({ home, sub: 'cancel', id: '1', wallet: 'test', dryRun: true }, harness(base()).deps)).rejects.toThrow(/only the maker/);
    const r = await runOtc({ home, sub: 'cancel', id: '1', wallet: 'test', dryRun: true }, harness(base({ maker: FROM })).deps);
    expect(r.ok).toBe(true);
    expect(r.summary.valueQuai).toBe('0.0');
  });

  it('create enforces the min notional and an exact approval first', async () => {
    const h = harness({ ...base(), allowance: () => [0n], approve: () => [true] });
    await expect(runOtc({ home, sub: 'create', token: TOKEN, amount: '10', quai: '0.5', wallet: 'test', dryRun: true }, h.deps)).rejects.toThrow(/Minimum offer/);
    const r = await runOtc({ home, sub: 'create', token: TOKEN, amount: '10', quai: '5', wallet: 'test', dryRun: true }, h.deps);
    expect(r.tradeSimulated).toBe(false);
    expect(r.summary.allowance).toBe('10.0');
    const ok = await runOtc({ home, sub: 'create', token: TOKEN, amount: '10', quai: '5', expiry: '3d', wallet: 'test', dryRun: true }, harness({ ...base(), createOffer: () => [4n] }).deps);
    expect(ok.summary.action).toMatch(/OTC offer/);
    expect(ok.summary.expiresAt).toBeTruthy();
  });

  it('list returns decoded offers newest first, filtered to open', async () => {
    const r = await runOtc({ home, sub: 'list', wallet: 'test' }, harness(base()).deps);
    expect(r.items.map((x) => x.id)).toEqual(['3', '2', '1']);
    expect(r.items[0].priceQuaiPerToken).toBe('0.1');
    expect(r.items[0].totalDueQuai).toBe('10.05');
    const mine = await runOtc({ home, sub: 'list', mine: true, wallet: 'test' }, harness(base()).deps);
    expect(mine.items.map((x) => x.id)).toEqual(['2', '1']);
  });
});

describe('claim', () => {
  const rows = [{ address: addr(21), amount: 5n * ONE }, { address: FROM.toLowerCase(), amount: 3n * ONE }, { address: addr(23), amount: 2n * ONE }];
  const id = 12345678901234567890n;
  const tree = buildTree(id, rows.map((r) => ({ address: getAddress(r.address), amount: r.amount })));
  const file = { version: 1, campaignId: id.toString(), root: tree.root, leaves: rows.map((r) => [r.address.toLowerCase(), r.amount.toString()]) };
  const camp = (over = {}) => [MAKER, '0x' + '0'.repeat(40), 10n * ONE, 10n * ONE, tree.root, 3n, BigInt(Math.floor(Date.now() / 1000) + 86400), false, '', ...[]].slice(0, 9).map((v, i) => (over[i] !== undefined ? over[i] : v));
  const handlers = (over = {}, claimed = false) => ({ campaigns: () => camp(over), isClaimed: () => [claimed], claimFee: () => [ONE / 20n] });

  it('hashes leaves and proofs exactly like HartiiClaim._claim', () => {
    const leaf = leafHash(id, 1n, getAddress(FROM), 3n * ONE);
    expect(leaf).toBe(keccak256(solidityPacked(['uint256', 'uint256', 'address', 'uint256'], [id, 1n, FROM.toLowerCase(), 3n * ONE])));
    let node = leaf;
    for (const sib of proofFor(tree, 1)) node = node.toLowerCase() < sib.toLowerCase() ? keccak256(solidityPacked(['bytes32', 'bytes32'], [node, sib])) : keccak256(solidityPacked(['bytes32', 'bytes32'], [sib, node]));
    expect(node).toBe(tree.root);
    expect(parseCampaignId('0x10')).toBe(16n);
    expect(() => parseCampaignId('abc')).toThrow();
  });

  it('only fetches https, non-local, credential-free leaves URLs', () => {
    expect(leavesUrl('', '0xroot')).toMatch(/hartiibiome\.com\/api\/claims\/leaves\/0xroot$/);
    expect(leavesUrl('https://leaves.example/x.json', '0x')).toBe('https://leaves.example/x.json');
    for (const bad of ['http://leaves.example/x', 'https://127.0.0.1/x', 'https://localhost/x', 'https://u:p@leaves.example/x']) expect(() => leavesUrl(bad, '0x')).toThrow();
  });

  it('--check reports eligibility from verified leaves (no signer needed)', async () => {
    const h = harness(handlers(), { leaves: file });
    const r = await runClaim({ home, sub: 'claim', id: id.toString(), check: true, wallet: 'test' }, h.deps);
    expect(r.eligibility).toBe('eligible');
    expect(r.allocations).toEqual([{ index: 1, amount: '3.0', claimed: false }]);
    expect(r.claimFeeQuai).toBe('0.05');
  });

  it('refuses leaves whose root does not match the campaign', async () => {
    const tampered = { ...file, leaves: [[addr(21).toLowerCase(), '9000000000000000000'], ...file.leaves.slice(1)] };
    await expect(runClaim({ home, sub: 'claim', id: id.toString(), check: true, wallet: 'test' }, harness(handlers(), { leaves: tampered }).deps)).rejects.toThrow(/do not match/);
  });

  it('dry-run claim sends the next unclaimed leaf with its proof and the live claim fee', async () => {
    const h = harness(handlers(), { leaves: file });
    const r = await runClaim({ home, sub: 'claim', id: id.toString(), wallet: 'test', dryRun: true }, h.deps);
    expect(r.ok).toBe(true);
    expect(r.summary.claiming).toBe('3.0 QUAI');
    expect(r.summary.valueQuai).toBe('0.05');
    expect(r.summary.leafIndex).toBe('1');
    expect(h.sendTransaction).not.toHaveBeenCalled();
  });

  it('refuses already-claimed and expired campaigns', async () => {
    await expect(runClaim({ home, sub: 'claim', id: id.toString(), wallet: 'test', dryRun: true }, harness(handlers({}, true), { leaves: file }).deps)).rejects.toThrow(/already claimed/);
    await expect(runClaim({ home, sub: 'claim', id: id.toString(), wallet: 'test', dryRun: true }, harness(handlers({ 6: 5n }), { leaves: file }).deps)).rejects.toThrow(/expired/);
  });

  it('list --mine pages past 500 campaigns and flags the cap', async () => {
    const many = Array.from({ length: 700 }, (_, i) => BigInt(i + 1));
    const h = harness({ ...handlers(), campaignsByCreator: (a) => [many.slice(Number(a[1]), Number(a[1]) + Number(a[2]))] });
    const r = await runClaim({ home, sub: 'list', mine: true, wallet: 'test', limit: '2' }, h.deps);
    expect(r.items.map((i) => i.id)).toEqual(['700', '699']);
    expect(r.truncated).toBeUndefined();
    const endless = harness({ ...handlers(), campaignsByCreator: (a) => [Array.from({ length: Number(a[2]) }, (_, i) => BigInt(Number(a[1]) + i + 1))] });
    const t = await runClaim({ home, sub: 'list', mine: true, wallet: 'test', limit: '1' }, endless.deps);
    expect(t.truncated).toBe(true);
  });

  it('list --mine decodes the creator campaigns', async () => {
    const h = harness({ ...handlers(), campaignsByCreator: (a) => [[id].slice(Number(a[1]))] });
    const r = await runClaim({ home, sub: 'list', mine: true, wallet: 'test' }, h.deps);
    expect(r.items[0]).toMatchObject({ id: id.toString(), status: 'open', symbol: 'QUAI', total: '10.0' });
  });
});

describe('wall', () => {
  const wallHandlers = (price = 21n * ONE) => ({
    priceOf: () => [price],
    getWall: () => [[MAKER, 1n, ONE, 'Global Wall'], 412n, price],
    stats: () => [1n, 412n, 900n * ONE, ONE, 10n * ONE],
    engravingsPage: () => [[[MAKER, 1700000000n, 0x7c3aed, ONE, '0x' + '0'.repeat(40), 'hello']], [false]],
  });

  it('engrave dry-run sends live price + 5% headroom and validates message/colour', async () => {
    const { deps, sendTransaction } = harness(wallHandlers());
    const r = await runWall({ home, sub: 'engrave', message: 'gm quai', color: '#E5243B', wallet: 'test', dryRun: true }, deps);
    expect(r.ok).toBe(true);
    expect(r.summary.livePriceQuai).toBe('21.0');
    expect(r.summary.maxSentQuai).toBe('22.05');
    expect(r.summary.color).toBe('#e5243b');
    expect(sendTransaction).not.toHaveBeenCalled();
    await expect(runWall({ home, sub: 'engrave', message: 'x'.repeat(281), wallet: 'test', dryRun: true }, deps)).rejects.toThrow(/280/);
    await expect(runWall({ home, sub: 'engrave', message: 'hi', color: 'red', wallet: 'test', dryRun: true }, deps)).rejects.toThrow(/Color/);
  });

  it('stats and recent are read-only', async () => {
    const { deps } = harness(wallHandlers());
    const s = await runWall({ home, sub: 'stats', wallet: 'test' }, deps);
    expect(s).toMatchObject({ blockCount: '412', nextPriceQuai: '21.0', wallFeeQuai: '10.0' });
    const r = await runWall({ home, sub: 'recent', n: '1', wallet: 'test' }, deps);
    expect(r.recent[0]).toMatchObject({ message: 'hello', color: '#7c3aed', token: null });
  });
});

describe('cli wiring', () => {
  it('routes demo commands through main with --json', async () => {
    const write = vi.fn();
    expect(await main(['wall', 'engrave', 'gm', '--demo', '--json'], { write, writeErr: vi.fn(), env: { HARTII_HOME: home } })).toBe(0);
    expect(JSON.parse(write.mock.calls[0][0]).summary.action).toMatch(/Wall engrave/);
    const w2 = vi.fn();
    expect(await main(['otc', 'list', '--demo', '--json'], { write: w2, writeErr: vi.fn(), env: { HARTII_HOME: home } })).toBe(0);
    expect(JSON.parse(w2.mock.calls[0][0]).items[0].status).toBe('open');
    const w3 = vi.fn();
    const err = vi.fn();
    expect(await main(['otc', 'bogus', '--demo'], { write: w3, writeErr: err, env: { HARTII_HOME: home } })).toBe(1);
    expect(err.mock.calls[0][0]).toMatch(/Usage/);
  });
});
