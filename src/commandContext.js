// Shared EOA runtime. Dry runs use the public keystore address, never its password/key.
import { Wallet, QuaiTransaction, getZoneForAddress } from 'quais';
import { getHartiiHome, loadConfig } from './config.js';
import { resolveRuntimeNetwork, assertChainId } from './network.js';
import { resolveWalletAddress } from './commands/balance.js';
import { readKeystoreFile, decryptAccount, WalletError } from './keystore.js';
import { resolvePassword } from './prompt.js';
import { assertCyprus1QuaiAddress } from './address.js';
import { createProvider } from './signer.js';
import { assertMarketNetwork } from './marketApi.js';
import { assertToolsNetwork } from './biomeAddresses.js';
import { runWrite, WriteError, PreBroadcastError, BroadcastError, transactionIntentDigest } from './writePipeline.js';

export async function withProviderCleanup(deps, operation) {
  const providers = new Set();
  const providerFactory = deps.providerFactory || createProvider;
  try { return await operation({ ...deps, providerFactory: (url) => { const p = providerFactory(url); providers.add(p); return p; } }); }
  finally { for (const p of providers) { try { p.destroy?.(); } catch { /* teardown cannot mask the command outcome */ } } }
}

export function readRuntime(opts = {}, deps = {}) {
  const home = opts.home || getHartiiHome(deps.env || deps.io?.env);
  const cfg = loadConfig(home);
  const net = resolveRuntimeNetwork({ network: opts.network || cfg.network, rpc: opts.rpc, allowInsecureRpc: opts.allowInsecureRpc });
  // Callers (MCP) may tighten caps; they cannot raise the owner's configured limits.
  const limits = { ...cfg.limits };
  for (const k of ['perTxQuai', 'dailyQuai']) {
    if (deps.limits?.[k] !== undefined) {
      const parse = (s) => { if (!/^\d+(\.\d{1,18})?$/.test(String(s))) throw new WalletError('Invalid spending limit'); const [a,b='']=String(s).split('.'); return BigInt(a)*10n**18n+BigInt(b.padEnd(18,'0')); };
      if (parse(deps.limits[k]) < parse(limits[k])) limits[k] = String(deps.limits[k]);
    }
  }
  return { home, cfg, net, limits };
}

/**
 * The sender for this invocation, resolved IDENTICALLY for dry runs and real runs: a --key-env key
 * wins (its address is derived from the env key, never the keystore default), else the named/current
 * keystore wallet. A dry run that resolved a different sender than the real run would review the
 * wrong transaction.
 */
export function resolveSender(home, opts = {}, deps = {}) {
  if (opts.keyEnv) {
    const env = deps.env || deps.io?.env || process.env;
    const key = env[opts.keyEnv];
    if (!key || !/^(0x)?[0-9a-fA-F]{64}$/.test(key)) throw new WalletError('--key-env must name an environment variable containing a private key.');
    (deps.io?.writeErr || ((s) => process.stderr.write(s + '\n')))('WARNING: --key-env uses a raw environment key; prefer an encrypted keystore.');
    try { const envWallet = new Wallet(key.startsWith('0x') ? key : `0x${key}`); return { name: undefined, address: envWallet.address, envWallet }; }
    catch { throw new WalletError('Invalid --key-env private key.'); }
  }
  const { name, address } = resolveWalletAddress(home, opts.wallet);
  return { name, address, envWallet: undefined };
}

export async function writeRuntime(opts = {}, deps = {}) {
  const runtime = readRuntime(opts, deps);
  await assertChainId(runtime.net.rpcUrl, runtime.net.chainId, { fetchFn: deps.fetchFn });
  const provider = (deps.providerFactory || createProvider)(runtime.net.rpcUrl);
  const { name, address, envWallet } = resolveSender(runtime.home, opts, deps);
  const from = assertCyprus1QuaiAddress(address);
  let signer;
  async function prepareSigner() {
    if (opts.dryRun) { const error = new WalletError('A dry run cannot unlock or sign.'); error.notSubmitted = true; throw error; }
    try {
      if (!signer) {
        let privateKey;
        if (envWallet) privateKey = envWallet.privateKey;
        else {
          const password = await resolvePassword({ ...deps.passwordDeps, label: `Password for wallet "${name}": ` });
          const account = await decryptAccount(readKeystoreFile(runtime.home, name), password);
          if (assertCyprus1QuaiAddress(account.address) !== from) throw new WalletError('Keystore address mismatch.');
          privateKey = account.privateKey;
        }
        signer = deps.walletFactory ? deps.walletFactory(privateKey, provider) : new Wallet(privateKey, provider);
      }
      const actual = assertCyprus1QuaiAddress(typeof signer.getAddress === 'function' ? await signer.getAddress() : signer.address);
      if (actual.toLowerCase() !== from.toLowerCase()) throw new WalletError('Signing account does not match the reviewed wallet metadata.');
      return actual;
    } catch (error) {
      signer = undefined;
      const safe = error instanceof WalletError ? error : new WalletError('Could not prepare the selected signing account safely; nothing was sent.');
      safe.notSubmitted = true; throw safe;
    }
  }
  const wallet = {
    getAddress: async () => from,
    prepareSigner,
    sendTransaction: async (tx, controls = {}) => {
      if (opts.dryRun) throw new WalletError('A dry run cannot sign.');
      const request = structuredClone(tx);
      const intent = transactionIntentDigest(request);
      let signed, signedHash;
      try {
        if (request.chainId === undefined || BigInt(request.chainId) !== BigInt(runtime.net.chainId)) throw new WalletError('Refusing to sign: transaction chain id does not match the selected network.');
        if (!['from','to','data','value','gasLimit','gasPrice','nonce'].every(field => request[field] !== undefined)) throw new WalletError('Refusing to sign: complete reviewed transaction authority is required.');
        if (assertCyprus1QuaiAddress(request.from).toLowerCase() !== from.toLowerCase()) throw new WalletError('Refusing to sign: sender does not match the reviewed account.');
        assertCyprus1QuaiAddress(request.to);
        await prepareSigner();
        if (typeof signer.signTransaction !== 'function' || typeof provider.broadcastTransaction !== 'function') throw new WalletError('Refusing to sign: offline signing and explicit broadcast are required.');
        // SDK sendTransaction repopulates an explicit nonce of zero and performs hidden RPC reads.
        // Sign the fully reviewed authority offline, then verify the exact canonical bytes before dispatch.
        const reviewed = QuaiTransaction.from({ ...request, type: 0 });
        signed = await signer.signTransaction(structuredClone(request));
        const decoded = QuaiTransaction.from(signed);
        if (!decoded.isSigned() || decoded.type !== 0 || decoded.from?.toLowerCase() !== from.toLowerCase()
          || decoded.unsignedSerialized !== reviewed.unsignedSerialized) throw new WalletError('Refusing to broadcast: signed transaction differs from reviewed authority.');
        signedHash = decoded.hash;
        // The native pipeline owns this synchronous durable reservation hook. A process
        // crash after dispatch must still leave the exact locally verified signed hash.
        if(controls.onSignedTransaction!==undefined) {
          if(typeof controls.onSignedTransaction!=='function')throw new WalletError('Invalid native signed-hash persistence hook.');
          const result=controls.onSignedTransaction({txHash:signedHash});
          if(result && typeof result.then==='function')throw new WalletError('Native signed-hash persistence must be synchronous.');
        }
        // Trusted in-process hosts may persist the public hash before permitting dispatch.
        // Never supply signed bytes or keys. CLI argv and MCP input cannot install this hook.
        if (deps.io?.onSignedTransaction !== undefined) {
          if (typeof deps.io.onSignedTransaction !== 'function') throw new WalletError('Invalid local signing continuation.');
          await deps.io.onSignedTransaction({ txHash: signedHash, transaction: structuredClone(request) });
        }
        if (typeof provider.getNetwork !== 'function') throw new WalletError('Refusing to sign: RPC chain cannot be verified.');
        const live = BigInt((await provider.getNetwork()).chainId);
        if (live !== BigInt(runtime.net.chainId)) throw new WalletError(`Refusing to sign: RPC reports chain ${live}, expected ${runtime.net.chainId}.`);
        const pendingNonce = await provider.getTransactionCount(from, 'pending');
        if (!Number.isSafeInteger(pendingNonce) || pendingNonce !== request.nonce) throw new WalletError('Refusing to sign: wallet nonce changed; review fresh transaction terms.');
        if (intent !== transactionIntentDigest(request)) throw new WalletError('Refusing to sign: reviewed transaction authority changed.');
        controls.validateBeforeSubmit?.();
        if(deps.io?.onBroadcastStarted!==undefined) {
          if(typeof deps.io.onBroadcastStarted!=='function')throw new WalletError('Invalid local broadcast marker.');
          const result=deps.io.onBroadcastStarted({txHash:signedHash});
          if(result && typeof result.then==='function')throw new WalletError('Local broadcast marker must be synchronous.');
        }
      } catch (error) {
        throw new PreBroadcastError(error instanceof WalletError ? error.message : 'Local authority verification failed before sending.');
      }
      // broadcastTransaction may submit before its own network/head reads finish. Every error here is
      // ambiguous unless the write pipeline recognizes a node admission rejection; never retry it.
      try {
        const sent = await provider.broadcastTransaction(getZoneForAddress(from), signed);
        if (typeof sent?.hash !== 'string' || sent.hash.toLowerCase() !== signedHash.toLowerCase()) throw new Error('Broadcast response does not match the locally signed transaction hash.');
        return sent;
      } catch (error) { throw new BroadcastError(error, signedHash, signed); }
    },
  };
  return { ...runtime, provider, from, wallet, json: opts.json, yes: opts.yes, dryRun: opts.dryRun, io: deps.io };
}

/** writeRuntime for the mainnet-only market commands (buy/sell/swap); `deps` comes back pinned to the resolved network. */
export async function marketRuntime(opts, deps) {
  const ctx = await writeRuntime(opts, deps);
  assertMarketNetwork(ctx.net.name);
  return { ...ctx, deps: { ...deps, network: ctx.net.name } };
}

/** writeRuntime for the Hartii tool commands (airdrop/otc/claim/wall): refuses non-mainnet before any signer work. */
export function toolsRuntime(opts, deps) {
  assertToolsNetwork(readRuntime(opts, deps).net.name);
  return writeRuntime(opts, deps);
}

/** Trusted managed-exit hosts may account native outflow instead of sale proceeds.
 * No CLI flag or MCP input installs this callback; all ordinary turnover guards remain. */
export function managedExitSpend(ctx, details) {
  const callback=ctx.io?.managedExitBudget;
  if(callback===undefined)return null;
  if(typeof callback!=='function' || callback({...details,from:ctx.from,chainId:ctx.net.chainId})!==0n)throw new WalletError('Managed exit budget authority did not verify.');
  return 0n;
}

/** runWrite with the runtime's wallet/provider/limits/flags; a WriteError is rethrown as `ErrorClass` (message prefixed) when given. */
export function writeVia(ctx, params, ErrorClass, prefix) {
  const run = () => runWrite({ wallet: ctx.wallet, provider: ctx.provider, network: ctx.net, home: ctx.home, limits: ctx.limits, json: ctx.json, yes: ctx.yes, dryRun: ctx.dryRun, io: ctx.io, ...params });
  return ErrorClass ? run().catch(error => {
    if (!(error instanceof WriteError)) throw error;
    // Preserve only public transaction outcome fields, so callers can inspect an ambiguous send.
    const extra = {};
    if (typeof error.txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(error.txHash)) extra.txHash = error.txHash;
    if (['unconfirmed','reverted'].includes(error.status)) extra.status = error.status;
    throw new ErrorClass((prefix || '') + error.message, extra);
  }) : run();
}
