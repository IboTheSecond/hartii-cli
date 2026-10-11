import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = vi.hoisted(() => ({ current: 'A', network: 'mainnet', balanceCalls: [], receiveCalls: [], delayedA: null }));
const wallets = {
  A: '0x0011111111111111111111111111111111111111',
  B: '0x0022222222222222222222222222222222222222',
};
vi.mock('../src/config.js', async original => ({
  ...(await original()),
  loadConfig: () => ({ network: fixture.network, currentWallet: fixture.current, limits: { perTxQuai: '100', dailyQuai: '500' } }),
  saveConfig: (_home, config) => { fixture.network = config.network; },
}));
vi.mock('../src/commands/walletCmd.js', async original => ({
  ...(await original()),
  walletList: () => Object.entries(wallets).map(([name, address]) => ({ name, address, current: name === fixture.current })),
  walletUse: (_home, name) => { fixture.current = name; },
}));
vi.mock('../src/commands/receive.js', () => ({ runReceive: async options => {
  fixture.receiveCalls.push(options);
  const name = options.wallet || fixture.current;
  return { readOnly: true, wallet: name, address: wallets[name] };
} }));
vi.mock('../src/commands/balance.js', () => ({ runBalance: async options => {
  fixture.balanceCalls.push(options);
  const name = options.wallet || fixture.current;
  if (name === 'A' && fixture.delayedA) return fixture.delayedA;
  return { network: options.network || fixture.network, address: wallets[name], quaiWei: name === 'A' ? 1000n : 2000n, holdings: [] };
} }));

import { createDataSource } from '../src/tui/data.js';
import { TuiApp } from '../src/tui/app.js';
const active = [];
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
class OfflineSocket { addEventListener() {} close() {} send() {} }
beforeEach(() => { fixture.current = 'A'; fixture.network = 'mainnet'; fixture.balanceCalls = []; fixture.receiveCalls = []; fixture.delayedA = null; });
afterEach(() => { for (const source of active.splice(0)) source.stop(); });
function create(wallet = 'A', extra = {}) {
  const source = createDataSource({
    home: mkdtempSync(join(tmpdir(), 'hartii-wallet-selection-')),
    wallet, network: 'mainnet', WebSocketImpl: OfflineSocket,
    fetchFn: () => { throw new Error('No network in this proof'); },
    providerFactory: () => { throw new Error('No RPC in this proof'); },
    ...extra,
  });
  active.push(source);
  const app = new TuiApp({ data: source.initial, size: { cols: 120, rows: 40 }, deps: source.deps });
  source.start(app);
  return { source, app };
}
it('an explicit startup wallet is only the initial selection; choosing B updates display and commands', async () => {
  const { source, app } = create('A'); await tick();
  expect(app.data.wallet.name).toBe('A');
  source.deps.useWallet('B'); await tick();
  expect(fixture.current).toBe('B');
  expect(app.data.wallet).toEqual({ name: 'B', address: wallets.B });
  const receive = await source.deps.runCommand('receive', {});
  expect(receive.wallet).toBe('B');
  expect(fixture.receiveCalls.at(-1).wallet).toBe('B');
  source.deps.refresh(); await tick();
  expect(fixture.balanceCalls.at(-1).wallet).toBe('B');
  expect(app.data.quaiWei).toBe(2000n);
});
it('late balances for A cannot appear under the newly selected B wallet', async () => {
  let release;
  fixture.delayedA = new Promise(resolve => { release = resolve; });
  const { source, app } = create('A');
  source.deps.useWallet('B'); source.deps.refresh(); await tick();
  expect(app.data.wallet.name).toBe('B');
  release({ network: 'mainnet', address: wallets.A, quaiWei: 999999n, holdings: [] }); await tick();
  expect(app.data.wallet.name).toBe('B');
  expect(app.data.quaiWei).toBe(2000n);
});
it('a newer refresh for the same wallet wins over an earlier response', async () => {
  let release;
  fixture.delayedA = new Promise(resolve => { release = resolve; });
  const { source, app } = create('A');
  fixture.delayedA = null;
  source.deps.refresh(); await tick();
  expect(app.data.quaiWei).toBe(1000n);
  release({ network: 'mainnet', address: wallets.A, quaiWei: 999999n, holdings: [] }); await tick();
  expect(app.data.quaiWei).toBe(1000n);
});
it('a stopped source cannot publish a late balance response or start another refresh', async () => {
  let release;
  fixture.delayedA = new Promise(resolve => { release = resolve; });
  const { source, app } = create('A');
  source.stop();
  const before = structuredClone(app.data);
  const calls = fixture.balanceCalls.length;
  release({ network: 'mainnet', address: wallets.A, quaiWei: 999999n, holdings: [] }); await tick();
  expect(app.data).toEqual(before);
  source.deps.refresh(); await tick();
  expect(fixture.balanceCalls).toHaveLength(calls);
});
it('an obsolete balance error does not replace the current wallet status', async () => {
  let reject;
  fixture.delayedA = new Promise((_resolve, rejectPromise) => { reject = rejectPromise; });
  const { source, app } = create('A');
  fixture.delayedA = null;
  source.deps.refresh(); await tick();
  app.status('Current wallet ready');
  reject(new Error('old refresh failed')); await tick();
  expect(app.ui.status.text).toBe('Current wallet ready');
});
it('settings show the active startup network and switching changes subsequent command context', async () => {
  fixture.network = 'orchard'; const { source, app } = create(); await tick();
  expect(source.deps.loadSettings().network).toBe('mainnet');
  await source.deps.saveSettings({network:'orchard',perTxQuai:'100',dailyQuai:'500'});
  await source.deps.runCommand('receive',{});
  expect(fixture.receiveCalls.at(-1).network).toBe('orchard');
  source.deps.refresh(); await tick(); expect(app.data.network).toBe('orchard');
});
it('a network change invalidates an earlier balance response', async () => {
  let release; fixture.delayedA = new Promise(resolve=>{release=resolve;}); const {source,app}=create();
  await source.deps.saveSettings({network:'orchard',perTxQuai:'100',dailyQuai:'500'});
  fixture.delayedA=null;source.deps.refresh();await tick();
  release({network:'mainnet',address:wallets.A,quaiWei:999999n,holdings:[]});await tick();
  expect(app.data.network).toBe('orchard');expect(app.data.quaiWei).toBe(1000n);
});
it('a custom startup RPC cannot silently be reused on a different network', async () => {
  const {source,app}=create('A',{rpc:'https://synthetic.invalid'});await tick();
  await expect(source.deps.saveSettings({network:'orchard',perTxQuai:'100',dailyQuai:'500'})).rejects.toThrow(/--rpc/);
  expect(fixture.network).toBe('mainnet');expect(app.data.network).toBe('mainnet');
});
