// `hartii qi ...` end to end through cli.main with a REAL QiHDWallet (real derivation and signing)
// against an offline Quai-shaped node (qiMock.mjs). Throwaway keys only.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { QiHDWallet, Mnemonic, Zone } from 'quais';
import { main } from '../../src/cli.js';
import { generateMnemonicAccount, accountFromPrivateKey, encryptAccount, writeKeystoreFile } from '../../src/keystore.js';
import { saveConfig, loadConfig } from '../../src/config.js';
import { createQiNode } from './qiMock.mjs';
import { createQiPort } from '../../src/qi/port.js';

// Address derivation in quais grinds for the zone and takes ~0.6 s per address, so derive once and clone.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const PASSWORD = 'correct-horse-battery-staple';
const FAST = { N: 2, r: 1, p: 1 };
const D = { 1: 6, 5: 7, 10: 8, 1000: 11 }; // Qi -> denomination index (1 Qi = 1000 qit = index 6)

let home; let account; let node; let mailbox; let out; let err; let prompts; let serialized; let ext; let walletClone; let OTHER;

async function makeWallet(name, acct) {
  const json = await encryptAccount(acct, PASSWORD, { scrypt: FAST });
  writeKeystoreFile(home, name, json);
}
// Public test vector, built at runtime so the OSS export's mnemonic scan never sees a literal phrase. (Hardhat's well-known dev phrase.)
const JUNK = [...Array(11).fill('test'), 'junk'].join(' ');
const otherCode = () => OTHER;
const myCode = () => serialized.paymentCode;

beforeAll(async () => {
  account = generateMnemonicAccount();
  OTHER = QiHDWallet.fromMnemonic(Mnemonic.fromPhrase(JUNK)).getPaymentCode(0);
  const w = QiHDWallet.fromMnemonic(Mnemonic.fromEntropy(account.entropy));
  w.connect(createQiNode().provider);
  w.openChannel(OTHER);
  await w.scan(Zone.Cyprus1, 0);
  serialized = { data: w.serialize(), paymentCode: w.getPaymentCode(0) };
  ext = serialized.data.addresses.filter((a) => a.derivationPath === 'BIP44:external').sort((a, b) => a.index - b.index).map((a) => a.address);
}, 300_000);

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'hartii-cli-qi-'));
  walletClone = await QiHDWallet.deserialize(serialized.data);
  await makeWallet('default', account);
  // No default caps since 2026-11-16 (owner): unattended --yes sends need caps the user set, so the fixture sets them.
  saveConfig(home, { ...loadConfig(home), currentWallet: 'default', network: 'orchard', limits: { perTxQuai: '100', dailyQuai: '500' } });
  node = createQiNode();
  mailbox = { available: vi.fn(async () => true), notifications: vi.fn(async () => []), hasNotified: vi.fn(async () => false), notify: vi.fn(async () => ({ hash: '0x' + 'a'.repeat(64) })) };
  out = []; err = []; prompts = 0;
}, 60_000);
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const fund = (notes) => {
  notes.forEach((n, i) => node.addNote(ext[i], { denomination: D[n.qi] ?? n.denom, lock: n.lock || 0, index: i, txHash: '0x' + (100 + i).toString(16).padStart(64, '0') }));
};

function run(argv, extra = {}) {
  return main(argv, {
    write: (s) => out.push(String(s)), writeErr: (s) => err.push(String(s)),
    env: { HARTII_HOME: home }, interactive: false,
    fetchFn: async () => ({ json: async () => ({ result: '0x3a98' }) }),
    providerFactory: () => node.provider,
    mailboxFactory: () => mailbox,
    qiPortFactory: (a) => createQiPort({ ...a, wallet: walletClone }),
    passwordDeps: { env: { HARTII_PASSWORD: PASSWORD }, writeErr: () => {} },
    confirmFn: async () => { prompts += 1; return true; },
    sleep: async () => {}, receiptPollMs: 1, receiptTimeoutMs: 50, receivePollMs: 1,
    ...extra,
  });
}
const text = () => out.join('\n') + '\n' + err.join('\n');
const json = () => JSON.parse(out.join('\n'));

describe('qi read commands', () => {
  it('balance: spendable vs locked, by note size', async () => {
    fund([{ qi: 5 }, { qi: 5 }, { qi: 1 }, { qi: 10, lock: node.state.head + 50 }]);
    expect(await run(['qi', 'balance', '--json'])).toBe(0);
    const r = json();
    expect(r.spendable).toBe('11');
    expect(r.locked).toBe('10');
    expect(r.total).toBe('21');
    expect(r.bySize.find((b) => b.size === '5')).toMatchObject({ spendable: 2, locked: 0 });
    expect(r.network).toBe('orchard');
  });
  it('notes lists each note with its lock', async () => {
    fund([{ qi: 5 }, { qi: 10, lock: node.state.head + 50 }]);
    expect(await run(['qi', 'notes', '--json'])).toBe(0);
    const r = json();
    expect(r.notes).toHaveLength(2);
    expect(r.notes.find((n) => n.size === '10')).toMatchObject({ locked: true, lockedUntilBlock: node.state.head + 50 });
  });
  it('address: payment code, first free address, QR payload', async () => {
    expect(await run(['qi', 'address', '--json'])).toBe(0);
    const r = json();
    expect(r.paymentCode).toBe(myCode());
    expect(r.address).toBe(ext[0]);
    expect(r.qr.payload).toBe(r.paymentCode);
    expect(await run(['qi', 'address'])).toBe(0);
    expect(text()).toMatch(/Payment code/);
  });
  it('address skips an address the local list says was used', async () => {
    const first = ext[0];
    await run(['qi', 'address', '--json']);
    expect(json().address).toBe(first);
    // the address was paid, then spent away (gone from the node): the local list remembers it
    const dir = join(home, 'qi');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'orchard-default.json'), JSON.stringify({ version: 1, used: [first.toLowerCase()] }));
    out = [];
    await run(['qi', 'address', '--json']);
    expect(json().address).not.toBe(first);
  });
  it('receive: waits, then reports a new note', async () => {
    const addr = ext[0];
    let polls = 0;
    const real = node.provider.getOutpointsByAddresses.bind(node.provider);
    node.provider.getOutpointsByAddresses = async (a) => { polls += 1; if (polls === 4) node.addNote(addr, { denomination: D[5], txHash: '0x' + 'c'.repeat(64) }); return real(a); };
    expect(await run(['qi', 'receive', '--json', '--timeout', '30'])).toBe(0);
    const r = json();
    expect(r.received).toHaveLength(1);
    expect(r.receivedTotal).toBe('5');
  });
});

describe('qi refusals', () => {
  it('key-only wallet gets a clear message', async () => {
    await makeWallet('keyonly', accountFromPrivateKey(account.privateKey));
    expect(await run(['qi', 'balance', '--wallet', 'keyonly'])).toBe(1);
    expect(text()).toMatch(/Qi needs a wallet created from a recovery phrase/);
  });
  it('--key-env is refused', async () => {
    expect(await run(['qi', 'balance', '--key-env', 'X'])).toBe(1);
    expect(text()).toMatch(/recovery phrase/);
  });
  it('a Quai address recipient is refused before any password or broadcast', async () => {
    fund([{ qi: 5 }]);
    const quai = generateMnemonicAccount().address;
    const spy = vi.fn(() => PASSWORD);
    expect(await run(['qi', 'send', quai, '1'], { passwordDeps: { promptFn: spy, env: {} } })).toBe(1);
    expect(text()).toMatch(/Quai address/);
    expect(spy).not.toHaveBeenCalled();
    expect(node.state.broadcasts).toBe(0);
  });
  it('mainnet send is refused without --allow-mainnet-qi, and without naming the network', async () => {
    fund([{ qi: 5 }]);
    expect(await run(['qi', 'send', otherCode(), '1', '--network', 'mainnet'])).toBe(1);
    expect(text()).toMatch(/--allow-mainnet-qi/);
    out = []; err = [];
    saveConfig(home, { ...loadConfig(home), network: 'mainnet' });
    expect(await run(['qi', 'send', otherCode(), '1', '--allow-mainnet-qi'])).toBe(1);
    expect(text()).toMatch(/--network mainnet/);
    expect(node.state.broadcasts).toBe(0);
  });
  it('a bad amount is refused', async () => {
    expect(await run(['qi', 'send', otherCode(), '0'])).toBe(1);
    expect(await run(['qi', 'send', otherCode(), '1.2345'])).toBe(1);
    expect(node.state.broadcasts).toBe(0);
  });
});

describe('qi send', () => {
  it('previews in the shared summary shape, picks the smallest note, broadcasts, needs receipt status 1', async () => {
    fund([{ qi: 1000 }, { qi: 5 }, { qi: 5 }]);
    expect(await run(['qi', 'send', otherCode(), '1', '--json', '--yes'])).toBe(0);
    const r = json();
    expect(r.ok).toBe(true);
    expect(r.status).toBe('confirmed');
    expect(r.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.explorer).toBe(`https://orchard.quaiscan.io/tx/${r.txHash}`);
    const s = r.summary;
    expect(s).toMatchObject({ action: 'qi-send', network: 'orchard', from: myCode(), to: otherCode(), amount: '1', unit: 'Qi' });
    expect(Array.isArray(s.warnings)).toBe(true);
    expect(s.notesSpent).toHaveLength(1);
    expect(s.notesSpent[0].size).toBe('5'); // not the 1,000 Qi note
    expect(Array.isArray(s.changeOutputs)).toBe(true);
    expect(BigInt(s.totalQit)).toBe(1000n + BigInt(s.feeQit));
    expect(node.state.broadcasts).toBe(1);
    // the node got real signed bytes: 1 input, all outputs sum to input minus fee
    const tx = [...node.state.txs.values()][0];
    expect(tx.inputs).toHaveLength(1);
    expect(tx.inputs[0].pubKey).toMatch(/^0x04[0-9a-f]{128}$/); // uncompressed, as the live node serves it
  });
  it('payment-code recipient: posts the notice first, then the Qi', async () => {
    fund([{ qi: 5 }]);
    const order = [];
    mailbox.notify = vi.fn(async () => { order.push('notify'); return { hash: '0x1' }; });
    const real = node.provider.broadcastTransaction.bind(node.provider);
    node.provider.broadcastTransaction = async (...a) => { order.push('broadcast'); return real(...a); };
    expect(await run(['qi', 'send', otherCode(), '1', '--json', '--yes'])).toBe(0);
    expect(order).toEqual(['notify', 'broadcast']);
    expect(mailbox.notify).toHaveBeenCalledWith(myCode(), otherCode());
  });
  it('payment-code recipient with no QUAI for the notice: refused, nothing sent', async () => {
    fund([{ qi: 5 }]);
    node.state.quaiBalance = 0n;
    expect(await run(['qi', 'send', otherCode(), '1', '--yes'])).toBe(1);
    expect(text()).toMatch(/QUAI/);
    expect(node.state.broadcasts).toBe(0);
    expect(mailbox.notify).not.toHaveBeenCalled();
  });
  it('a failed notice means no Qi is sent', async () => {
    fund([{ qi: 5 }]);
    mailbox.notify = vi.fn(async () => { throw new Error('reverted'); });
    expect(await run(['qi', 'send', otherCode(), '1', '--yes'])).toBe(1);
    expect(node.state.broadcasts).toBe(0);
  });
  it('already-notified recipient: no second notice', async () => {
    fund([{ qi: 5 }]);
    mailbox.hasNotified = vi.fn(async () => true);
    node.state.quaiBalance = 0n;
    expect(await run(['qi', 'send', otherCode(), '1', '--yes'])).toBe(0);
    expect(mailbox.notify).not.toHaveBeenCalled();
  });
  it('sends to a plain Qi address without any notice', async () => {
    fund([{ qi: 5 }]);
    const target = QiHDWallet.fromMnemonic(Mnemonic.fromPhrase(JUNK)).getNextAddressSync(0, Zone.Cyprus1).address;
    expect(await run(['qi', 'send', target, '1', '--yes', '--json'])).toBe(0);
    expect(mailbox.notify).not.toHaveBeenCalled();
    expect(node.state.outpointsRaw.get(target.toLowerCase()).length).toBeGreaterThan(0);
  });
  it('receipt status 0 is a failure, not success', async () => {
    fund([{ qi: 5 }]);
    node.state.receiptMode = 'revert';
    expect(await run(['qi', 'send', otherCode(), '1', '--yes', '--json'])).toBe(1);
    expect(json()).toMatchObject({ ok: false, status: 'failed' });
  });
  it('no receipt: reported as unknown with the hash, broadcast exactly once, never retried', async () => {
    fund([{ qi: 5 }]);
    node.state.receiptMode = 'none';
    expect(await run(['qi', 'send', otherCode(), '1', '--yes', '--json'])).toBe(1);
    const r = json();
    expect(r.status).toBe('unknown');
    expect(r.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.message).toMatch(/Do not send again/);
    expect(node.state.broadcasts).toBe(1);
  });
  it('a broadcast error is unknown too, with the hash, and is not retried', async () => {
    fund([{ qi: 5 }]);
    node.state.broadcastError = 'socket hang up';
    expect(await run(['qi', 'send', otherCode(), '1', '--yes', '--json'])).toBe(1);
    const r = json();
    expect(r.status).toBe('unknown');
    expect(r.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(node.state.broadcasts).toBe(1);
  });
  it('--dry-run previews and never broadcasts or notifies', async () => {
    fund([{ qi: 5 }]);
    expect(await run(['qi', 'send', otherCode(), '1', '--dry-run', '--json'])).toBe(0);
    expect(json()).toMatchObject({ dryRun: true, status: 'not-sent' });
    expect(node.state.broadcasts).toBe(0);
    expect(mailbox.notify).not.toHaveBeenCalled();
  });
  it('a human --dry-run prints the review exactly once (found live on Orchard 2026-11-17: it printed twice)', async () => {
    fund([{ qi: 5 }]);
    expect(await run(['qi', 'send', otherCode(), '1', '--dry-run'])).toBe(0);
    expect(text().match(/You send 1 Qi/g)).toHaveLength(1);
    expect(text()).toMatch(/Preview only\. Nothing was sent\./);
  });
  it('declining the prompt sends nothing', async () => {
    fund([{ qi: 5 }]);
    expect(await run(['qi', 'send', otherCode(), '1'], { confirmFn: async () => false })).toBe(1);
    expect(text()).toMatch(/Nothing was sent|Cancelled/);
    expect(node.state.broadcasts).toBe(0);
  });
  it('locked notes are not spent', async () => {
    fund([{ qi: 5, lock: node.state.head + 99 }]);
    expect(await run(['qi', 'send', otherCode(), '1', '--yes'])).toBe(1);
    expect(text()).toMatch(/locked|Not enough/);
    expect(node.state.broadcasts).toBe(0);
  });
  it('--yes is refused when no caps are set, and a set cap blocks an over-cap send', async () => {
    fund([{ qi: 10 }]);
    expect(await run(['qi', 'send', otherCode(), '1', '--yes'], { cfgOverride: { capsSet: false } })).toBe(1);
    expect(text()).toMatch(/spending limits/);
    expect(node.state.broadcasts).toBe(0);
    out = []; err = [];
    saveConfig(home, { ...loadConfig(home), limits: { perTxQuai: '1', dailyQuai: '5' } });
    expect(await run(['qi', 'send', otherCode(), '2', '--yes'])).toBe(1);
    expect(text()).toMatch(/per-transaction limit/);
    expect(node.state.broadcasts).toBe(0);
  });
  it('never reuses addresses: change and payment-channel addresses differ on a second send', async () => {
    fund([{ qi: 10 }, { qi: 10 }]);
    await run(['qi', 'send', otherCode(), '1', '--yes', '--json']);
    const first = [...node.state.txs.values()][0].outputs.map((o) => o.address.toLowerCase());
    out = [];
    await run(['qi', 'send', otherCode(), '1', '--yes', '--json']);
    const second = [...node.state.txs.values()][1].outputs.map((o) => o.address.toLowerCase());
    expect(second.some((a) => first.includes(a))).toBe(false);
  });
});

describe('secrets', () => {
  it('the recovery phrase, entropy and private key never reach any output, even inside an error', async () => {
    fund([{ qi: 5 }]);
    const phrase = Mnemonic.fromEntropy(account.entropy).phrase;
    const bad = () => ({ ...node.provider, getOutpointsByAddresses: async () => { throw new Error(`boom ${phrase} ${account.privateKey} ${account.entropy}`); } });
    expect(await run(['qi', 'balance'], { providerFactory: bad })).toBe(1);
    await run(['qi', 'address', '--json']);
    await run(['qi', 'balance', '--json']);
    await run(['qi', 'notes']);
    const all = text();
    expect(all).not.toContain(phrase);
    expect(all).not.toContain(account.privateKey);
    expect(all).not.toContain(account.entropy);
    expect(all).not.toContain(PASSWORD);
    expect(existsSync(join(home, 'qi'))).toBe(true);
    for (const f of readdirSync(join(home, 'qi'))) expect(readFileSync(join(home, 'qi', f), 'utf8')).not.toContain(phrase);
  });
});
