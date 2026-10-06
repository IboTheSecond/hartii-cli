// Shared EOA runtime. Dry runs use the public keystore address, never its password/key.
import { Wallet } from 'quais';
import { getHartiiHome, loadConfig } from './config.js';
import { resolveRuntimeNetwork, assertChainId } from './network.js';
import { resolveWalletAddress } from './commands/balance.js';
import { readKeystoreFile, decryptAccount, WalletError } from './keystore.js';
import { resolvePassword } from './prompt.js';
import { assertCyprus1QuaiAddress } from './address.js';
import { createProvider } from './signer.js';
import { assertMarketNetwork } from './marketApi.js';
import { assertToolsNetwork } from './biomeAddresses.js';
import { runWrite, WriteError, PreBroadcastError, transactionIntentDigest } from './writePipeline.js';
import { rethrowAs } from './errors.js';

export async function withProviderCleanup(deps, operation) {
  const providers = new Set();
  const providerFactory = deps.providerFactory || createProvider;
  try { return await operation({ ...deps, providerFactory: (url) => { const p = providerFactory(url); providers.add(p); return p; } }); }
  finally { for (const p of providers) { try { p.destroy?.(); } catch { /* teardown cannot mask the command outcome */ } } }
}

export function readRuntime(opts = {}, deps = {}) {
  const home = opts.home || getHartiiHome(deps.env || deps.io?.env);
  const cfg = loadConfig(home);
  const net = resolveRuntimeNetwork({ network: opts.network || cfg.network, rpc: opts.rpc });
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

export async function writeRuntime(opts = {}, deps = {}) {
  const runtime = readRuntime(opts, deps);
  await assertChainId(runtime.net.rpcUrl, runtime.net.chainId, { fetchFn: deps.fetchFn });
  const provider = (deps.providerFactory || createProvider)(runtime.net.rpcUrl);
  let name, address, envWallet;
  if (opts.keyEnv && !opts.dryRun) {
    const env = deps.env || deps.io?.env || process.env;
    const key = env[opts.keyEnv];
    if (!key || !/^(0x)?[0-9a-fA-F]{64}$/.test(key)) throw new WalletError('--key-env must name an environment variable containing a private key.');
    (deps.io?.writeErr || console.error)('WARNING: --key-env uses a raw environment key; prefer an encrypted keystore.');
    try { envWallet = new Wallet(key.startsWith('0x') ? key : `0x${key}`); address = envWallet.address; }
    catch { throw new WalletError('Invalid --key-env private key.'); }
  } else ({ name, address } = resolveWalletAddress(runtime.home, opts.wallet));
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
      try {
        if (request.chainId === undefined || BigInt(request.chainId) !== BigInt(runtime.net.chainId)) throw new WalletError('Refusing to sign: transaction chain id does not match the selected network.');
        if (!['from','to','data','value','gasLimit','gasPrice','nonce'].every(field => request[field] !== undefined)) throw new WalletError('Refusing to sign: complete reviewed transaction authority is required.');
        if (assertCyprus1QuaiAddress(request.from).toLowerCase() !== from.toLowerCase()) throw new WalletError('Refusing to sign: sender does not match the reviewed account.');
        assertCyprus1QuaiAddress(request.to);
        await prepareSigner();
        if (typeof provider.getNetwork !== 'function') throw new WalletError('Refusing to sign: RPC chain cannot be verified.');
        const live = BigInt((await provider.getNetwork()).chainId);
        if (live !== BigInt(runtime.net.chainId)) throw new WalletError(`Refusing to sign: RPC reports chain ${live}, expected ${runtime.net.chainId}.`);
        const pendingNonce = await provider.getTransactionCount(from, 'pending');
        if (!Number.isSafeInteger(pendingNonce) || pendingNonce !== request.nonce) throw new WalletError('Refusing to sign: wallet nonce changed; review fresh transaction terms.');
        if (intent !== transactionIntentDigest(request)) throw new WalletError('Refusing to sign: reviewed transaction authority changed.');
        controls.validateBeforeSubmit?.();
      } catch (error) {
        throw new PreBroadcastError(error instanceof WalletError ? error.message : 'Local authority verification failed before sending.');
      }
      // Never label an SDK send/broadcast error as locally not submitted.
      return signer.sendTransaction(request);
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

/** runWrite with the runtime's wallet/provider/limits/flags; a WriteError is rethrown as `ErrorClass` (message prefixed) when given. */
export function writeVia(ctx, params, ErrorClass, prefix) {
  const run = () => runWrite({ wallet: ctx.wallet, provider: ctx.provider, network: ctx.net, home: ctx.home, limits: ctx.limits, json: ctx.json, yes: ctx.yes, dryRun: ctx.dryRun, io: ctx.io, ...params });
  return ErrorClass ? rethrowAs(WriteError, ErrorClass, run, prefix) : run();
}
