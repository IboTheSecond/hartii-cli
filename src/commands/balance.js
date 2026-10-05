import { redactUrls } from '../output.js';
// packages/hartii-cli/src/commands/balance.js
//
// `hartii balance [--tokens]` — QUAI balance, plus HartiiLabs-indexed token holdings via
// GET /api/portfolio/:wallet when --tokens is passed (see the product spec COMMANDS). Reading the
// wallet's ADDRESS never needs the keystore password — a keystore v3 file stores `address` in
// plaintext by design (see keystore.js) — so this is a read-only command that never prompts.
import { existsSync, readFileSync } from 'node:fs';
import { getAddress } from 'quais';
import { resolveRuntimeNetwork } from '../network.js';
import { keystorePath } from '../keystore.js';
import { getHartiiHome, loadConfig } from '../config.js';
import { createProvider } from '../signer.js';
import { formatAmount } from '../amount.js';
import { assertCyprus1QuaiAddress } from '../address.js';
import { resilientRead } from '../../vendor/packages/agent-mcp/src/rpcClient.js';
import { DEMO_ADDRESS, DEMO_NETWORK, DEMO_BALANCE_WEI, DEMO_TOKEN_HOLDINGS } from '../demoFixtures.js';
import { CliError } from '../errors.js';

const API_BASE = 'https://hartiilabs.com';

export class BalanceError extends CliError {}

/** Resolves the address to check: an explicit wallet name, else the configured current wallet. */
export function resolveWalletAddress(home, walletName) {
  const cfg = loadConfig(home);
  const name = walletName || cfg.currentWallet;
  if (!name) throw new BalanceError('No wallet selected. Run `hartii wallet new` or `hartii wallet use <name>`, or pass --wallet <name>.');
  const p = keystorePath(home, name);
  if (!existsSync(p)) throw new BalanceError(`No wallet named "${name}". Run \`hartii wallet list\`.`);
  const data = JSON.parse(readFileSync(p, 'utf8'));
  return { name, address: getAddress('0x' + String(data.address || '').replace(/^0x/, '')) };
}

/**
 * @param {{ home?: string, network?: string, rpc?: string, wallet?: string, tokens?: boolean, demo?: boolean, apiBase?: string }} opts
 * @param {{ fetchFn?: typeof fetch, providerFactory?: (rpcUrl:string) => any }} [deps]
 */
export async function runBalance(opts = {}, deps = {}) {
  if (opts.demo) {
    const result = { wallet: DEMO_ADDRESS, network: DEMO_NETWORK, quai: formatAmount(DEMO_BALANCE_WEI), quaiWei: DEMO_BALANCE_WEI.toString() };
    if (opts.tokens) result.holdings = DEMO_TOKEN_HOLDINGS;
    return result;
  }

  const home = opts.home || getHartiiHome();
  // `address` reads ANY Cyprus-1 Quai address (no keystore needed) — used by `balance --address` and the MCP server.
  const { name, address } = opts.address ? { name: null, address: assertCyprus1QuaiAddress(opts.address) } : resolveWalletAddress(home, opts.wallet);
  const cfg = loadConfig(home);
  const net = resolveRuntimeNetwork({ network: opts.network || cfg.network, rpc: opts.rpc });
  const providerFactory = deps.providerFactory || createProvider;
  const provider = providerFactory(net.rpcUrl);

  let quaiWei;
  try {
    quaiWei = await resilientRead(() => provider.getBalance(address), { primaryAttempts: 2, proxyUrl: null });
  } catch (err) {
    throw new BalanceError(`Could not read balance from ${redactUrls(net.rpcUrl)}: ${redactUrls(err?.message || err)}`);
  } finally {
    provider.destroy?.();
  }

  const result = { wallet: address, walletName: name, network: net.name, quai: formatAmount(BigInt(quaiWei)), quaiWei: BigInt(quaiWei).toString() };

  if (opts.tokens) {
    if (net.name !== 'mainnet') {
      return { ...result, holdings: null, totals: null, holdingsError: 'HartiiLabs portfolio indexing is mainnet-only; Orchard token holdings are unavailable.' };
    }
    const apiBase = opts.apiBase || API_BASE;
    const fetchFn = deps.fetchFn || fetch;
    try {
      const res = await fetchFn(`${apiBase}/api/portfolio/${address}`, { method: 'GET', signal: AbortSignal.timeout(12000), redirect: 'error' });
      if (!res.ok) throw new Error(`Portfolio HTTP ${res.status}.`);
      const body = await res.json();
      if (!Array.isArray(body?.holdings) || body.error) throw new Error('Portfolio response unavailable or malformed.');
      result.holdings = body.holdings;
      result.totals = body?.totals || null;
    } catch (err) {
      result.holdings = null;
      result.totals = null;
      result.holdingsError = `Could not reach ${apiBase}/api/portfolio: ${err?.message || err}`;
    }
  }

  return result;
}
