import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { COMMANDS, ALIASES, fullHelp, commandHelp, suggest, completionScript, lookup } from '../src/help.js';
import { readGasPrice } from '../src/gasPrice.js';
import { readCurveMeta } from '../src/curveState.js';
import { formatHumanResult } from '../src/humanOutput.js';

const FROM = '0x0003b264Bc457BF2dc6F4De80c6C714079febB64';
let home;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hartii-everyday-'));
  mkdirSync(join(home, 'keystore'));
  writeFileSync(join(home, 'keystore', 'main.json'), JSON.stringify({ address: FROM.slice(2) }));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ network: 'mainnet', currentWallet: 'main', limits: { perTxQuai: '100', dailyQuai: '500' } }));
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const run = async (argv, deps = {}) => {
  const out = []; const err = [];
  const code = await main(argv, { env: { HARTII_HOME: home }, write: (s) => out.push(s), writeErr: (s) => err.push(s), interactive: false, ...deps });
  return { code, out: out.join('\n'), err: err.join('\n') };
};

describe('help everywhere', () => {
  it('`hartii ?`, `help`, `h` and `--help` all print the full grouped help', async () => {
    for (const a of [['?'], ['help'], ['h'], ['--help'], []]) {
      const r = await run(a);
      expect(r.code).toBe(0);
      expect(r.out).toContain('Start here:');
      expect(r.out).toContain('hartii ?');
    }
  });
  it('every registered command has per-command help via `<cmd> ?`, `help <cmd>` and `<cmd> --help`', async () => {
    for (const c of COMMANDS) {
      const text = commandHelp(c.name);
      expect(text, c.name).toContain(`hartii ${c.name}`);
      expect((await run(['help', c.name])).out).toBe(text);
      expect((await run([c.name, '?'])).out).toBe(text);
      expect((await run([c.name, '--help'])).out).toBe(text);
    }
  });
  it('the full help lists every command name and a "did you mean" fires on typos', async () => {
    const help = fullHelp();
    for (const c of COMMANDS) expect(help).toContain(c.name);
    expect(suggest('balence')).toContain('balance');
    expect(suggest('sel')[0]).toBe('sell');
    const r = await run(['bux']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/Did you mean: buy/);
    const h = await run(['help', 'nonsense']);
    expect(h.code).toBe(1);
  });
  it('`commands --json` is a stable list and aliases never collide with real commands', async () => {
    const r = await run(['commands', '--json']);
    const list = JSON.parse(r.out).commands;
    expect(list.length).toBe(COMMANDS.length);
    expect(list.find((c) => c.name === 'trending').aliases).toContain('top');
    for (const [alias] of ALIASES) expect(COMMANDS.some((c) => c.name === alias), alias).toBe(false);
    expect(lookup('pf').name).toBe('portfolio');
  });
  it('prints shell completion for bash, zsh, fish and powershell', async () => {
    for (const sh of ['bash', 'zsh', 'fish', 'powershell']) {
      const script = completionScript(sh);
      expect(script).toContain('balance');
      expect((await run(['completion', sh])).out).toContain('hartii');
    }
    expect((await run(['completion', 'tcsh'])).code).toBe(1);
  });
});

describe('aliases expand to the core commands', () => {
  const provider = { getBalance: vi.fn(async () => 5n * 10n ** 18n), destroy: vi.fn() };
  const fetchFn = vi.fn(async (url) => {
    if (String(url).includes('/api/portfolio/')) return { ok: true, status: 200, json: async () => ({ holdings: [], totals: { valueQuai: '0' } }) };
    if (String(url).includes('/api/tokens')) return { ok: true, status: 200, json: async () => ({ items: [], nextCursor: null }) };
    return { ok: true, status: 200, json: async () => ({}) };
  });
  const deps = { fetchFn, providerFactory: () => provider };
  it('bal / pf / portfolio / holdings -> balance (pf adds --tokens)', async () => {
    expect(JSON.parse((await run(['bal', '--json'], deps)).out).quai).toBe('5.0');
    const pf = JSON.parse((await run(['pf', '--json'], deps)).out);
    expect(pf.holdings).toEqual([]);
    expect(fetchFn.mock.calls.some(([u]) => String(u).includes('/api/portfolio/'))).toBe(true);
  });
  it('wallets / ls / use / address / addr / whoami', async () => {
    expect(JSON.parse((await run(['ls', '--json'])).out).wallets[0].name).toBe('main');
    expect(JSON.parse((await run(['addr', '--json'])).out).address).toBe(FROM);
    const who = JSON.parse((await run(['whoami', '--json'])).out);
    expect(who).toMatchObject({ wallet: 'main', address: FROM, network: 'mainnet' });
    expect((await run(['use', 'main', '--json'])).code).toBe(0);
  });
  it('top / trending / new / search route to tokens', async () => {
    for (const a of [['top'], ['trending'], ['new'], ['search', 'qaxe']]) expect((await run([...a, '--json'], deps)).code).toBe(0);
    const urls = fetchFn.mock.calls.map(([u]) => String(u));
    expect(urls.some((u) => u.includes('sort=trending'))).toBe(true);
    expect(urls.some((u) => u.includes('sort=new'))).toBe(true);
  });
});

describe('everyday commands', () => {
  it('gas and block read the RPC; gas never needs getFeeData to work', async () => {
    const provider = { getFeeData: vi.fn(async () => ({ gasPrice: 55_000_000_000_000n })), getBlockNumber: vi.fn(async () => 10_460_000), destroy: vi.fn() };
    const g = JSON.parse((await run(['gas', '--json'], { providerFactory: () => provider })).out);
    expect(g.gasPriceGwei).toBe('55000.0');
    expect(g.transferCostQuai).toBe('2.145');
    expect(JSON.parse((await run(['block', '--json'], { providerFactory: () => provider })).out).height).toBe(10_460_000);
  });
  it('limits, networks, init, about, update, open', async () => {
    expect(JSON.parse((await run(['limits', '--json'])).out)).toMatchObject({ perTxQuai: '100', dailyQuai: '500', spentTodayQuai: '0.0' });
    expect(JSON.parse((await run(['networks', '--json'])).out).networks.map((n) => n.name)).toEqual(['mainnet', 'orchard']);
    const init = JSON.parse((await run(['init', '--json'])).out);
    expect(init).toMatchObject({ wallets: 1, currentWallet: 'main', nodeOk: true });
    expect(init.nextSteps.join('\n')).toContain('hartii doctor');
    expect(JSON.parse((await run(['about', '--json'])).out).status).toMatch(/BETA/);
    const hash = '0x' + 'ab'.repeat(32);
    expect(JSON.parse((await run(['open', hash, '--json'])).out).url).toContain(hash);
    expect(JSON.parse((await run(['open', FROM, '--json'])).out).url).toContain(FROM);
    expect((await run(['open', 'nope'])).code).toBe(1);
    const sha = 'f'.repeat(64);
    const upd = JSON.parse((await run(['update', '--json'], { fetchFn: async () => ({ text: async () => `${sha}  hartii-cli.tgz\n` }) })).out);
    expect(upd.latestSha256).toBe(sha);
    expect(upd.upgrade).toMatch(/npm install -g https:\/\/hartiilabs\.com/);
  });
  it('price and holders use the public API; unknown extras errors are clean (no stack)', async () => {
    const TOKEN = '0x0035187a7660f595d93cd53a4d16c635d6cffc8f';
    const fetchFn = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('/holders')) return { ok: true, status: 200, json: async () => ({ items: [{ holder: '0xabc', balance: '5' }] }) };
      return { ok: true, status: 200, json: async () => ({ token: { address: TOKEN, symbol: 'QAXE', lastPriceWei: '3281652994514106', change24h: 4.5, status: 'graduated', network: 'mainnet' }, graduation_progress: { graduated: true } }) };
    });
    const p = JSON.parse((await run(['price', 'QAXE', '--json'], { fetchFn })).out);
    expect(p).toMatchObject({ symbol: 'QAXE', priceQuai: '0.003281', change24hPct: 4.5 });
    const h = JSON.parse((await run(['holders', 'QAXE', '--limit', '1', '--json'], { fetchFn })).out);
    expect(h.items).toEqual([{ holder: '0xabc', balance: '5', pct: null }]);
    const bad = await run(['price', 'QAXE'], { fetchFn: async () => { throw new Error('offline'); } });
    expect(bad.code).toBe(1);
    expect(bad.err).not.toMatch(/\n\s+at /);
  });
  it('--demo variants never touch the network', async () => {
    const boom = () => { throw new Error('network!'); };
    for (const a of [['price', 'DEMO'], ['gas'], ['block'], ['quote', 'buy', 'DEMO', '5']]) {
      const r = await run([...a, '--demo', '--json'], { fetchFn: boom, providerFactory: boom });
      expect(r.code, a.join(' ')).toBe(0);
      expect(JSON.parse(r.out).demo).toBe(true);
    }
  });
  it('an empty list prints a neutral line, not "No matching tokens"', () => {
    expect(formatHumanResult({ items: [], scanned: 3 })).not.toMatch(/No matching tokens/);
  });
});

describe('live-RPC regressions (zone-pinned URL)', () => {
  it('gas price: falls back to a raw quai_gasPrice read when quais getFeeData fails, silently', async () => {
    const orig = global.fetch;
    const seen = [];
    global.fetch = vi.fn(async (url, init) => { seen.push(JSON.parse(init.body).method); return { json: async () => ({ result: '0x355408ac63fb' }) }; });
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const provider = { getFeeData: vi.fn(async () => { console.error(new Error('Invalid shard')); throw new Error('could not determine gasPrice'); }) };
      expect(await readGasPrice(provider, 'https://rpc.example/cyprus1')).toBe(0x355408ac63fbn);
      expect(seen).toEqual(['quai_gasPrice']);
      expect(logs).not.toHaveBeenCalled(); // quais' own error logging is muted during the probe
      await expect(readGasPrice({ getFeeData: async () => { throw new Error('boom'); } }, null)).rejects.toThrow(/boom/);
    } finally { global.fetch = orig; logs.mockRestore(); }
  });
  it('a V1 curve (no creatorPayout) answers CALL_EXCEPTION with null data and is read as legacy, not an error', async () => {
    const { Interface } = await import('quais');
    const { BONDING_CURVE_ABI, BONDING_CURVE_V3_ABI } = await import('../src/abi/bondingCurve.js');
    const iface = new Interface([...BONDING_CURVE_ABI, ...BONDING_CURVE_V3_ABI]);
    const provider = {
      call: async (tx) => {
        const p = iface.parseTransaction({ data: tx.data });
        if (p.name === 'creatorPayout') throw Object.assign(new Error('missing revert data'), { code: 'CALL_EXCEPTION', data: null });
        const v = { feeBps: 100n, graduated: true, tokensRemaining: 0n, tokensSold: 1n, virtualQuaiReserve: 1n, virtualTokenReserve: 2n, realQuaiReserve: 3n, poolQuaiReserve: 4n, poolTokenReserve: 5n }[p.name];
        return iface.encodeFunctionResult(p.name, [v]);
      },
    };
    const meta = await readCurveMeta(provider, '0x004Bc407903A51506bcF0b1aB423958c5991c237');
    expect(meta.isV3).toBe(false);
    const net = { call: async () => { throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' }); } };
    await expect(readCurveMeta(net, '0x004Bc407903A51506bcF0b1aB423958c5991c237')).rejects.toThrow();
  });
});
