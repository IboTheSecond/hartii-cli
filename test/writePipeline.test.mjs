// packages/hartii-cli/test/writePipeline.test.mjs
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getAddress } from 'quais';
import { runWrite, WriteError } from '../src/writePipeline.js';
import { SpendGuardError } from '../src/spendingGuard.js';
import { AddressError } from '../src/address.js';

const mkAddr = (label) => getAddress('0x00' + Buffer.from(label, 'utf8').toString('hex').padEnd(38, '0').slice(0, 38));
const FROM = mkAddr('sender');
const TO = mkAddr('dest');
const NETWORK = { name: 'mainnet', chainId: 9 };
const LIMITS = { perTxQuai: '100', dailyQuai: '500' };

function makeWalletAndProvider({ callFails = false, estimate = 50_000n, gasPrice = 3_000_000_000n, nonce = 4, receiptStatus = 1, waitError = null, sendError = null, hasAccessList = false } = {}) {
  const calls = [];
  const sends = [];
  const provider = {
    call: vi.fn(async (tx) => {
      calls.push(tx);
      if (callFails) throw new Error('execution reverted: Slippage');
      return '0x';
    }),
    createAccessList: vi.fn(async () => (hasAccessList ? [{ address: TO, storageKeys: [] }] : [])),
    estimateGas: vi.fn(async () => estimate),
    getFeeData: vi.fn(async () => ({ gasPrice })),
    getTransactionCount: vi.fn(async () => nonce),
  };
  const wallet = {
    getAddress: vi.fn(async () => FROM),
    sendTransaction: vi.fn(async (tx) => {
      sends.push(tx);
      if (sendError) throw sendError;
      return {
        hash: '0xabc123',
        wait: vi.fn(async () => {
          if (waitError) throw waitError;
          return { status: receiptStatus };
        }),
      };
    }),
  };
  return { wallet, provider, calls, sends };
}

let home;
let io;
let written;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hartii-cli-writepipeline-test-'));
  written = [];
  io = { write: (s) => written.push(s), confirmFn: vi.fn(async () => true) };
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('runWrite — happy path', () => {
  it('simulates, estimates, sends, waits, and returns success with a quaiscan link', async () => {
    const { wallet, provider, calls, sends } = makeWalletAndProvider();
    const result = await runWrite({ wallet, provider, network: NETWORK, home, limits: LIMITS, to: TO, value: 1_000000000000000000n, action: 'Send QUAI', yes: true, io });

    expect(result.ok).toBe(true);
    expect(result.txHash).toBe('0xabc123');
    expect(result.status).toBe('success');
    expect(result.quaiscanUrl).toBe('https://quaiscan.io/tx/0xabc123');
    expect(calls).toHaveLength(1);
    expect(sends).toHaveLength(1);
    expect(sends[0].gasLimit).toBe((50_000n * 1200n) / 1000n); // estimate * 1.2
    expect(sends[0].from).toBe(FROM);
    expect(sends[0].to).toBe(TO);
    expect(sends[0].nonce).toBe(4);
    expect(wallet.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it('omits the access list for a plain value transfer (no data)', async () => {
    const { wallet, provider, sends } = makeWalletAndProvider();
    await runWrite({ wallet, provider, network: NETWORK, home, limits: LIMITS, to: TO, value: 1n, action: 'Send QUAI', yes: true, io });
    expect(provider.createAccessList).not.toHaveBeenCalled();
    expect(sends[0].accessList).toBeUndefined();
  });

  it('computes an access list for a contract call (data present)', async () => {
    const { wallet, provider, sends } = makeWalletAndProvider({ hasAccessList: true });
    await runWrite({ wallet, provider, network: NETWORK, home, limits: LIMITS, to: TO, data: '0xabcdef', value: 0n, action: 'Send TOKEN', yes: true, io });
    expect(provider.createAccessList).toHaveBeenCalledTimes(1);
    expect(sends[0].accessList).toEqual([{ address: TO, storageKeys: [] }]);
  });

  it('records the spend only after a confirmed success', async () => {
    const { wallet, provider } = makeWalletAndProvider();
    const { getSpentToday } = await import('../src/spendingGuard.js');
    await runWrite({ wallet, provider, network: NETWORK, home, limits: LIMITS, to: TO, value: 10_000000000000000000n, action: 'Send QUAI', yes: true, io });
    { const spent = getSpentToday(home, FROM).spentWei; expect(spent >= 10_000000000000000000n && spent < 10_000000000000000000n + 10n ** 15n).toBe(true); /* value + estimated fee counts toward the guard (M3) */ }
  });
});

describe('runWrite — dry run', () => {
  it('simulates and prints the summary, never signs', async () => {
    const { wallet, provider } = makeWalletAndProvider();
    const result = await runWrite({ wallet, provider, network: NETWORK, home, limits: LIMITS, to: TO, value: 1_000000000000000000n, action: 'Send QUAI', dryRun: true, io });
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(wallet.sendTransaction).not.toHaveBeenCalled();
    expect(written.join('\n')).toContain('Send QUAI');
  });

  it('a dry run never consumes spending-guard headroom', async () => {
    const { wallet, provider } = makeWalletAndProvider();
    const { getSpentToday } = await import('../src/spendingGuard.js');
    await runWrite({ wallet, provider, network: NETWORK, home, limits: LIMITS, to: TO, value: 10_000000000000000000n, action: 'Send QUAI', dryRun: true, io });
    expect(getSpentToday(home, FROM).spentWei).toBe(0n);
  });
});

describe('runWrite — confirmation gate', () => {
  it('skips the prompt when yes:true', async () => {
    const { wallet, provider } = makeWalletAndProvider();
    const confirmFn = vi.fn();
    await runWrite({ wallet, provider, network: NETWORK, home, limits: LIMITS, to: TO, value: 1n, action: 'Send QUAI', yes: true, io: { ...io, confirmFn } });
    expect(confirmFn).not.toHaveBeenCalled();
  });

  it('prompts and aborts on a decline, never sending', async () => {
    const { wallet, provider } = makeWalletAndProvider();
    const confirmFn = vi.fn(async () => false);
    const result = await runWrite({ wallet, provider, network: NETWORK, home, limits: LIMITS, to: TO, value: 1n, action: 'Send QUAI', io: { ...io, confirmFn } });
    expect(result.ok).toBe(false);
    expect(result.aborted).toBe(true);
    expect(wallet.sendTransaction).not.toHaveBeenCalled();
  });

  it('a declined confirmation never consumes spending-guard headroom', async () => {
    const { wallet, provider } = makeWalletAndProvider();
    const confirmFn = vi.fn(async () => false);
    const { getSpentToday } = await import('../src/spendingGuard.js');
    await runWrite({ wallet, provider, network: NETWORK, home, limits: LIMITS, to: TO, value: 10_000000000000000000n, action: 'Send QUAI', io: { ...io, confirmFn } });
    expect(getSpentToday(home, FROM).spentWei).toBe(0n);
  });

  it('proceeds to send on a confirmation', async () => {
    const { wallet, provider } = makeWalletAndProvider();
    const confirmFn = vi.fn(async () => true);
    const result = await runWrite({ wallet, provider, network: NETWORK, home, limits: LIMITS, to: TO, value: 1n, action: 'Send QUAI', io: { ...io, confirmFn } });
    expect(result.ok).toBe(true);
    expect(wallet.sendTransaction).toHaveBeenCalledTimes(1);
  });
});

describe('runWrite — address validation', () => {
  it('rejects a malformed destination before touching the network', async () => {
    const { wallet, provider, calls } = makeWalletAndProvider();
    await expect(runWrite({ wallet, provider, network: NETWORK, home, limits: LIMITS, to: 'not-an-address', value: 1n, action: 'x', yes: true, io })).rejects.toThrow(AddressError);
    expect(calls).toHaveLength(0);
  });

  it('rejects a Qi-ledger destination', async () => {
    const { wallet, provider } = makeWalletAndProvider();
    const qi = '0x0080000000000000000000000000000000000001';
    await expect(runWrite({ wallet, provider, network: NETWORK, home, limits: LIMITS, to: qi, value: 1n, action: 'x', yes: true, io })).rejects.toThrow(/Qi-ledger/);
  });
});

describe('runWrite — spending guard', () => {
  it('rejects over the per-tx cap before simulating', async () => {
    const { wallet, provider, calls } = makeWalletAndProvider();
    await expect(runWrite({ wallet, provider, network: NETWORK, home, limits: LIMITS, to: TO, value: 101_000000000000000000n, action: 'x', yes: true, io })).rejects.toThrow(SpendGuardError);
    expect(calls).toHaveLength(0);
    expect(wallet.sendTransaction).not.toHaveBeenCalled();
  });
});

describe('runWrite — simulate/send/receipt failures', () => {
  it('stops before sending if simulation reverts', async () => {
    const { wallet, provider, sends } = makeWalletAndProvider({ callFails: true });
    await expect(runWrite({ wallet, provider, network: NETWORK, home, limits: LIMITS, to: TO, value: 1n, action: 'x', yes: true, io })).rejects.toThrow(WriteError);
    expect(sends).toHaveLength(0);
  });

  it('throws WriteError when the send itself throws', async () => {
    const { wallet, provider } = makeWalletAndProvider({ sendError: new Error('insufficient funds') });
    await expect(runWrite({ wallet, provider, network: NETWORK, home, limits: LIMITS, to: TO, value: 1n, action: 'x', yes: true, io })).rejects.toThrow(/insufficient/i);
  });

  it('throws WriteError with the tx hash when the receipt reverts', async () => {
    const { wallet, provider } = makeWalletAndProvider({ receiptStatus: 0 });
    let caught;
    try {
      await runWrite({ wallet, provider, network: NETWORK, home, limits: LIMITS, to: TO, value: 1n, action: 'x', yes: true, io });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WriteError);
    expect(caught.txHash).toBe('0xabc123');
    expect(caught.status).toBe('reverted');
  });

  it('throws WriteError carrying the hash when the receipt wait times out', async () => {
    const { wallet, provider } = makeWalletAndProvider({ waitError: new Error('timeout') });
    let caught;
    try {
      await runWrite({ wallet, provider, network: NETWORK, home, limits: LIMITS, to: TO, value: 1n, action: 'x', yes: true, io });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WriteError);
    expect(caught.txHash).toBe('0xabc123');
  });

  it('never records spend when the receipt reverts', async () => {
    const { wallet, provider } = makeWalletAndProvider({ receiptStatus: 0 });
    const { getSpentToday } = await import('../src/spendingGuard.js');
    await runWrite({ wallet, provider, network: NETWORK, home, limits: LIMITS, to: TO, value: 10_000000000000000000n, action: 'x', yes: true, io }).catch(() => {});
    expect(getSpentToday(home, FROM).spentWei).toBe(0n);
  });
});

describe('runWrite — JSON output', () => {
  it('prints the summary as JSON to stderr when json:true', async () => {
    io.writeErr = (s) => written.push(s);
    io.write = vi.fn();
    const { wallet, provider } = makeWalletAndProvider();
    await runWrite({ wallet, provider, network: NETWORK, home, limits: LIMITS, to: TO, value: 1_000000000000000000n, action: 'Send QUAI', yes: true, json: true, io });
    const parsed = JSON.parse(written[0]);
    expect(parsed.summary.action).toBe('Send QUAI');
    expect(parsed.summary.valueQuai).toBe('1.0');
  });
});

describe('M2 pipeline safety', () => {
  it('treats a missing receipt as unconfirmed and retains the reservation', async () => {
    const {wallet,provider}=makeWalletAndProvider();
    wallet.sendTransaction.mockResolvedValue({hash:'0xabc123',wait:async()=>null});
    await expect(runWrite({wallet,provider,network:NETWORK,home,limits:LIMITS,to:TO,value:10n,action:'x',yes:true,io})).rejects.toThrow(/unconfirmed/i);
    const {getSpentToday}=await import('../src/spendingGuard.js');
    expect(getSpentToday(home,FROM).reservedWei).toBeGreaterThanOrEqual(10n); // value + fee
  });
  it('returns a JSON-safe receipt snapshot on success',async()=>{
    const {wallet,provider}=makeWalletAndProvider();
    wallet.sendTransaction.mockResolvedValue({hash:'0xabc123',wait:async()=>({status:1,blockNumber:20,gasUsed:100n})});
    const r=await runWrite({wallet,provider,network:NETWORK,home,limits:LIMITS,to:TO,value:1n,action:'x',yes:true,io});
    expect(r.receipt).toMatchObject({status:1,blockNumber:20,gasUsed:'100',transactionHash:'0xabc123'});
  });
  it.each([{estimate:0n},{estimate:-1n},{gasPrice:0n},{gasPrice:-1n},{nonce:-1},{nonce:1.5},{nonce:Number.MAX_SAFE_INTEGER+1}])('rejects malformed gas terms %#',async(terms)=>{
    const {wallet,provider}=makeWalletAndProvider(terms);
    await expect(runWrite({wallet,provider,network:NETWORK,home,limits:LIMITS,to:TO,value:1n,action:'x',yes:true,io})).rejects.toThrow(/gas terms/i);
    expect(wallet.sendTransaction).not.toHaveBeenCalled();
  });
  it('releases a reservation after a proven local signer failure',async()=>{
    const {wallet,provider}=makeWalletAndProvider({sendError:Object.assign(Error('wrong password'),{notSubmitted:true})});
    await expect(runWrite({wallet,provider,network:NETWORK,home,limits:LIMITS,to:TO,value:10n,action:'x',yes:true,io})).rejects.toThrow();
    const {getSpentToday}=await import('../src/spendingGuard.js');
    expect(getSpentToday(home,FROM).reservedWei).toBe(0n);
  });
  it.each(['INSUFFICIENT_FUNDS','NONCE_EXPIRED','REPLACEMENT_UNDERPRICED'])('releases the reservation when the node rejects the send before broadcast (%s)',async(code)=>{
    const {wallet,provider}=makeWalletAndProvider({sendError:Object.assign(Error('node said no'),{code})});
    await expect(runWrite({wallet,provider,network:NETWORK,home,limits:LIMITS,to:TO,value:10n,action:'x',yes:true,io})).rejects.toThrow(/rejected before broadcast/);
    const {getSpentToday}=await import('../src/spendingGuard.js');
    expect(getSpentToday(home,FROM)).toMatchObject({spentWei:0n,reservedWei:0n});
  });
  it('keeps the reservation when the send outcome is unknown (timeout / server error)',async()=>{
    const {wallet,provider}=makeWalletAndProvider({sendError:Object.assign(Error('socket hang up'),{code:'SERVER_ERROR'})});
    await expect(runWrite({wallet,provider,network:NETWORK,home,limits:LIMITS,to:TO,value:10n,action:'x',yes:true,io})).rejects.toThrow(/stays reserved/);
    const {getSpentToday}=await import('../src/spendingGuard.js');
    expect(getSpentToday(home,FROM).reservedWei).toBeGreaterThanOrEqual(10n);
  });
  it('a revert surfaced the way quais really does it (wait() throws CALL_EXCEPTION + receipt) is final: reported as reverted, reservation released',async()=>{
    const quaisRevert=Object.assign(Error('transaction execution reverted'),{code:'CALL_EXCEPTION',receipt:{status:0,hash:'0xabc123'}});
    const {wallet,provider}=makeWalletAndProvider({waitError:quaisRevert});
    let caught; try { await runWrite({wallet,provider,network:NETWORK,home,limits:LIMITS,to:TO,value:10n,action:'x',yes:true,io}); } catch (err) { caught=err; }
    expect(caught).toBeInstanceOf(WriteError);
    expect(caught.status).toBe('reverted');
    expect(caught.txHash).toBe('0xabc123');
    expect(caught.message).not.toMatch(/did not confirm/);
    const {getSpentToday}=await import('../src/spendingGuard.js');
    expect(getSpentToday(home,FROM)).toMatchObject({spentWei:0n,reservedWei:0n});
  });
});

