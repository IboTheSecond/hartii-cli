// packages/hartii-cli/src/commands/qi.js
//
// `hartii qi address|balance|receive|send|notes` - Qi, Quai's UTXO cash coin with private payment codes.
// Orchard first. The Qi wallet is derived from the selected wallet's recovery phrase (read from the
// encrypted keystore, never printed); wallets made from a bare private key cannot do Qi.
// The Qi transaction itself is built by qi/port.js; the QUAI payment notice goes through writePipeline (R3-F4).
import { Mnemonic } from 'quais';
import { getHartiiHome, loadConfig } from '../config.js';
import { resolveRuntimeNetwork, assertChainId } from '../network.js';
import { resolveWalletAddress } from './balance.js';
import { readKeystoreFile, decryptAccount, WalletError } from '../keystore.js';
import { resolvePassword, confirm as defaultConfirm } from '../prompt.js';
import { unlockLocalData } from '../localData.js';
import { createProvider } from '../signer.js';
import { createReceiveQr, renderReceiveQr } from '../qr.js';
import { CliError } from '../errors.js';
import { printJson, safeTerminalText, redactUrls } from '../output.js';
import { quaiscanAddressUrl } from '../quaiscan.js';
import { createQiPort } from '../qi/port.js';
import { createMailbox } from '../qi/mailbox.js';
import { openQiLedger } from '../qi/ledger.js';
import { classifyRecipient } from '../qi/recipient.js';
import { parseQi, formatQi } from '../qi/units.js';
import { assertQiWriteAllowed } from '../qi/networkGate.js';
import { resolveQiCaps, checkQiCaps } from '../qi/caps.js';
import { syncWallet, summariseNotes, planSend, executeSend } from '../qi/engine.js';

export class QiError extends CliError {}

export const QI_SUBS = ['address', 'balance', 'receive', 'send', 'notes'];

/** Removes anything secret-shaped we hold from a message before it can be printed. */
function scrubber(secrets) {
  return (text) => {
    let out = redactUrls(String(text ?? ''));
    for (const s of secrets) if (s && out.includes(s)) out = out.split(s).join('[hidden]');
    return out;
  };
}

async function openSession(opts, deps) {
  if (opts.keyEnv) throw new QiError('Qi needs a wallet created from a recovery phrase. A --key-env private key cannot make a Qi wallet.');
  const home = opts.home || getHartiiHome(deps.env);
  const cfg = { ...loadConfig(home), ...(deps.cfgOverride || {}) }; // cfgOverride: test hook only
  const net = resolveRuntimeNetwork({ network: opts.network || cfg.network, rpc: opts.rpc, allowInsecureRpc: opts.allowInsecureRpc });
  return { home, cfg, net };
}

async function unlock({ home, net, cfg }, opts, deps) {
  await assertChainId(net.rpcUrl, net.chainId, { fetchFn: deps.fetchFn });
  const { name, address } = resolveWalletAddress(home, opts.wallet);
  const password = await resolvePassword({ ...deps.passwordDeps, label: `Password for wallet "${name}": ` });
  const account = await decryptAccount(readKeystoreFile(home, name), password);
  if (!account.mnemonic?.entropy) {
    throw new QiError('Qi needs a wallet created from a recovery phrase. This wallet was imported from a private key, so it cannot make a Qi wallet. Create one with `hartii wallet new`, or import a recovery phrase.');
  }
  const mnemonic = Mnemonic.fromEntropy(account.mnemonic.entropy);
  const provider = (deps.providerFactory || createProvider)(net.rpcUrl);
  // The Qi ledger is sealed with the same local vault as the spend ledger, so unlock it with the password just entered.
  const unlockData = () => unlockLocalData({ home, wallet: name, create: true, getPassword: async () => password });
  await unlockData();
  const ledger = openQiLedger(home, net.name, name, { now: () => (deps.now ? new Date(deps.now) : new Date()) });
  const port = (deps.qiPortFactory || createQiPort)({ mnemonic, provider, ledger });
  const mailbox = (deps.mailboxFactory || createMailbox)({ provider, network: net.name, signerKey: account.privateKey, run: { home, chainId: net.chainId, rpcUrl: net.rpcUrl, unlockData, walletFactory: deps.walletFactory, io: deps.io } });
  const scrub = scrubber([mnemonic.phrase, account.mnemonic.entropy, account.privateKey, password]);
  return { name, quaiAddress: address, provider, ledger, port, mailbox, scrub, cfg, cleanup: () => { try { provider.destroy?.(); } catch { /* teardown only */ } } };
}

const base = (net, s) => ({ network: net.name, chainId: net.chainId, wallet: s.name, paymentCode: s.port.paymentCode });

function qrOf(payload) {
  const qr = createReceiveQr(payload);
  return qr;
}

export async function runQi(opts = {}, deps = {}) {
  const sub = opts.sub;
  if (!QI_SUBS.includes(sub)) throw new QiError(`Usage: hartii qi ${QI_SUBS.join('|')}. Run \`hartii qi ?\` for details.`);
  const warnings = [];
  const warn = (text) => warnings.push(text);

  // Everything that can be refused without a password is refused first.
  let recipient; let amountQit; let gate = { beta: false };
  const ctx0 = await openSession(opts, deps);
  if (sub === 'send') {
    const [to, amount] = opts.args || [];
    if (!to || !amount) throw new QiError('Usage: hartii qi send <payment-code|qi-address> <amount>');
    recipient = classifyRecipient(to);
    amountQit = parseQi(amount);
    gate = assertQiWriteAllowed({ net: ctx0.net, flags: opts.flags || {}, globals: { network: opts.network } });
  }

  const s = await unlock(ctx0, opts, deps);
  try {
    if (sub === 'address') {
      await syncWallet(s.port, s.mailbox, { warn });
      const address = await s.port.receiveAddress();
      return { ok: true, readOnly: true, ...base(ctx0.net, s), address, addressUrl: quaiscanAddressUrl(ctx0.net.name, address), qr: qrOf(s.port.paymentCode), warnings, note: 'Share the payment code: it stays private and works many times. The address is a one-off.' };
    }
    if (sub === 'balance' || sub === 'notes') {
      const { blockNumber, notes } = await syncWallet(s.port, s.mailbox, { warn });
      const sum = summariseNotes(notes);
      const out = { ok: true, readOnly: true, ...base(ctx0.net, s), blockNumber, spendable: formatQi(sum.spendableQit), locked: formatQi(sum.lockedQit), total: formatQi(sum.totalQit), bySize: sum.bySize.map((r) => ({ size: formatQi(r.sizeQit), spendable: r.spendable, locked: r.locked })), warnings };
      if (ctx0.net.name === 'mainnet') out.warnings.push('Qi on mainnet is BETA.');
      if (sub === 'notes') out.notes = notes.map((n) => ({ txHash: n.txHash, index: n.index, size: formatQi(n.valueQit), address: n.address, lockedUntilBlock: n.lock || null, locked: n.locked }));
      return out;
    }
    if (sub === 'receive') {
      const first = await syncWallet(s.port, s.mailbox, { warn });
      const address = await s.port.receiveAddress();
      const known = new Set(first.notes.map((n) => `${n.txHash}:${n.index}`));
      const result = { ok: true, readOnly: true, ...base(ctx0.net, s), address, qr: qrOf(s.port.paymentCode), waiting: opts.wait !== false, warnings, received: [] };
      if (opts.wait === false) return result;
      deps.onReceiveReady?.(result);
      const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
      const pollMs = deps.receivePollMs ?? 8000;
      const limit = Math.max(1, Math.ceil((opts.timeoutSec ?? 300) * 1000 / pollMs));
      for (let i = 0; i < limit; i += 1) {
        await sleep(pollMs);
        let cur;
        try { cur = await syncWallet(s.port, s.mailbox, {}); } catch { continue; }
        const fresh = cur.notes.filter((n) => !known.has(`${n.txHash}:${n.index}`));
        if (fresh.length) {
          result.received = fresh.map((n) => ({ txHash: n.txHash, index: n.index, size: formatQi(n.valueQit), locked: n.locked }));
          result.waiting = false;
          result.receivedTotal = formatQi(fresh.reduce((t, n) => t + n.valueQit, 0n));
          return result;
        }
      }
      result.waiting = false;
      result.timedOut = true;
      return result;
    }

    // ---- send ----
    const { notes } = await syncWallet(s.port, s.mailbox, { warn });
    const quaiBalance = recipient.kind === 'payment-code' ? await s.provider.getBalance(s.quaiAddress) : 0n;
    const { summary, plan } = await planSend({
      port: s.port, mailbox: s.mailbox, quai: { address: s.quaiAddress, balanceWei: quaiBalance }, recipient, amountQit,
      net: ctx0.net, fromCode: s.port.paymentCode, notes, beta: gate.warning,
    });
    const caps = resolveQiCaps(s.cfg);
    checkQiCaps(caps, { spendQit: plan.spendQit, spentTodayQit: s.ledger.sentToday() });
    deps.onReview?.(summary);
    if (opts.dryRun) return { ok: true, dryRun: true, ...base(ctx0.net, s), summary, status: 'not-sent' };
    if (opts.yes && !caps.set) {
      throw new QiError('--yes skips the question only when you have set spending limits. Set them first (`hartii config set limits.perTxQuai <n>` and `limits.dailyQuai <n>`, counted in Qi for Qi sends), or leave out --yes and confirm by hand. Nothing was sent.');
    }
    if (!opts.yes) {
      const ok = await (deps.confirmFn || defaultConfirm)('Send this Qi?', deps.io || {});
      if (!ok) return { ok: false, aborted: true, ...base(ctx0.net, s), summary, status: 'not-sent' };
    }
    const result = await executeSend({
      port: s.port, mailbox: s.mailbox, ledger: s.ledger, recipient, plan, fromCode: s.port.paymentCode, net: ctx0.net, chainId: ctx0.net.chainId,
      sleep: deps.sleep, pollMs: deps.receiptPollMs, timeoutMs: deps.receiptTimeoutMs,
    });
    return { ...base(ctx0.net, s), summary, ...result };
  } catch (err) {
    if (err instanceof CliError) { err.message = s.scrub(err.message); throw err; }
    throw new QiError(s.scrub(err?.shortMessage || err?.message || 'Qi command failed.').split('\n')[0]);
  } finally {
    s.cleanup();
  }
}

// ---------- human text (plain sentences; the screens lane restyles later) ----------

function reviewLines(sm) {
  const lines = [`You send ${sm.amount} Qi to ${sm.recipientKind === 'payment-code' ? 'the payment code' : 'the Qi address'} ${sm.to}.`];
  lines.push(`Network fee: ${sm.fee} Qi. Total leaving your wallet: ${sm.total} Qi (${sm.network}).`);
  lines.push(`Notes spent: ${sm.notesSpent.map((n) => `${n.size} Qi`).join(', ')}.`);
  lines.push(sm.changeOutputs.length ? `Change back to you: ${sm.changeOutputs.map((c) => `${c.count} x ${c.size} Qi`).join(', ')}.` : 'No change.');
  if (sm.notice?.needed) lines.push('The first send to this payment code also posts a small on-chain notice, paid in QUAI.');
  for (const w of sm.warnings) lines.push(`${w.level === 'danger' ? 'DANGER' : w.level === 'warn' ? 'Warning' : 'Note'}: ${w.text}`);
  return lines;
}

export function qiHumanLines(r, { color = false } = {}) {
  const t = safeTerminalText;
  const lines = [];
  if (r.aborted) return ['Cancelled. Nothing was sent.'];
  if (r.summary && r.status !== undefined && !r.dryRun) {
    // send outcome
    if (r.status === 'confirmed') lines.push(`Sent ${r.summary.amount} Qi. The network confirmed it.`);
    else if (r.status === 'failed') lines.push('The send failed on the network.');
    else if (r.status === 'unknown') lines.push('UNKNOWN: this send may or may not have gone through.');
    if (r.message) lines.push(t(r.message));
    if (r.txHash) lines.push(`Transaction: ${r.txHash}`, `Explorer: ${r.explorer}`);
    return lines;
  }
  // The review itself was already printed through onReview just before; the preview result only closes it.
  if (r.dryRun) return ['Preview only. Nothing was sent.'];
  if (r.qr) {
    lines.push(`Qi on ${r.network}`, `Payment code (share this): ${r.paymentCode}`, `First free address: ${r.address}`);
    const qr = renderReceiveQr(r.qr.matrix, { color });
    const cols = process.stdout.columns || 80;
    if (qr.width <= cols) lines.push('', qr.text); else lines.push('Widen the terminal to see the QR code.');
    if (r.received?.length) lines.push('', `Received ${r.receivedTotal} Qi.`);
    else if (r.waiting) lines.push('', 'Waiting for Qi...');
    else if (r.timedOut) lines.push('', 'Nothing arrived yet. Run `hartii qi receive` again, or check `hartii qi balance`.');
    if (r.note) lines.push('', r.note);
  } else if (r.bySize) {
    lines.push(`Qi on ${r.network} (block ${r.blockNumber})`, `Spendable: ${r.spendable} Qi`, `Locked: ${r.locked} Qi (unlocks after a few blocks)`, `Total: ${r.total} Qi`);
    if (r.notes) { lines.push('', 'Notes:'); for (const n of r.notes) lines.push(`  ${n.size} Qi  ${n.locked ? `locked until block ${n.lockedUntilBlock}` : 'spendable'}  ${n.txHash}:${n.index}`); }
    else if (r.bySize.length) { lines.push('', 'By note size:'); for (const b of r.bySize) lines.push(`  ${b.size} Qi x ${b.spendable} spendable${b.locked ? `, ${b.locked} locked` : ''}`); }
  }
  for (const w of r.warnings || []) lines.push(`Note: ${t(w)}`);
  return lines;
}

/** Handler used by commandTable: owns stdout (RAW command) and returns the exit code. */
export async function runQiCli(c) {
  const { flags, g } = c;
  const sub = c.args[0];
  const json = g.json;
  const opts = {
    sub, args: c.args.slice(1), home: c.home, network: g.network, rpc: g.rpc, wallet: g.wallet, keyEnv: g.keyEnv,
    yes: g.yes, dryRun: g.dryRun, flags, allowInsecureRpc: flags['allow-insecure-rpc'] === true,
    wait: flags['no-wait'] === true ? false : undefined,
    timeoutSec: flags.timeout === undefined ? undefined : Number(flags.timeout),
  };
  const deps = { ...c.deps, env: c.env, passwordDeps: c.io.passwordDeps, io: c.io, confirmFn: c.deps.confirmFn || c.io.confirmFn, now: c.deps.now };
  if (!json) {
    const mainnet = (g.network || '') === 'mainnet' && sub === 'send';
    if (mainnet) c.write('BETA: Qi on mainnet is new. Use very small amounts.');
    deps.onProgress = (m) => c.io.writeErr(m);
    deps.onReview = (summary) => { for (const l of reviewLines(summary)) c.write(l); };
    deps.onReceiveReady = (r) => {
      for (const l of qiHumanLines(r, { color: c.io.colors?.enabled })) c.write(l);
    };
  }
  const result = await runQi(opts, deps);
  if (json) {
    printJson(jsonSafe(result), { write: c.write });
  } else if (sub === 'receive' && opts.wait !== false) {
    // the QR and "Waiting for Qi..." were already printed; print only the outcome
    if (result.received?.length) c.write(`Received ${result.receivedTotal} Qi.`);
    else c.write('Nothing arrived yet. Run `hartii qi receive` again, or check `hartii qi balance`.');
  } else {
    for (const l of qiHumanLines(result, { color: c.io.colors?.enabled })) c.write(l);
  }
  return result.ok === false ? 1 : 0;
}

/** JSON: drop the QR matrix/svg (keep the payload) so output stays small and lossless. */
function jsonSafe(result) {
  if (!result.qr) return result;
  const { payload } = result.qr;
  return { ...result, qr: { payload } };
}

// Keeps WalletError referenced for callers that import it from here.
export { WalletError };
