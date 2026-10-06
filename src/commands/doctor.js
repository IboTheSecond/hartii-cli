import { redactUrls } from '../output.js';
// packages/hartii-cli/src/commands/doctor.js
//
// `hartii doctor` — the health checklist the product spec asks for: RPC reachable, chain id,
// keystore perms, address-ledger check, API reachable, clock skew. Every check is independent and
// best-effort (one failing never stops the others from running) so a single bad check gives a
// precise answer instead of an opaque crash. Built on raw `fetch` + JSON-RPC rather than a quais
// Provider, specifically so every check is testable with one injected `fetchFn` and no quais
// network plumbing — doctor's whole job is "is the real network reachable", so it should not
// itself depend on the heavier machinery it's diagnosing.
import { existsSync } from 'node:fs';
import { getAddress } from 'quais';
import { resolveRuntimeNetwork } from '../network.js';
import { isCyprus1QuaiAddress } from '../address.js';
import { checkKeystorePerms, keystorePath, readKeystoreFile } from '../keystore.js';
import { getHartiiHome, loadConfig } from '../config.js';
import { demoDoctorChecks } from '../demoFixtures.js';

const API_BASE = 'https://hartiilabs.com';
const CLOCK_SKEW_WARN_MS = 120_000;

async function rpcCall(fetchFn, rpcUrl, method, params = []) {
  const res = await fetch_(fetchFn, rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = await res.json();
  if (!body || body.error) throw new Error(body?.error?.message || `${method} failed`);
  return body.result;
}

function fetch_(fetchFn, url, options) {
  const f = fetchFn || fetch;
  return f(url, options);
}

/**
 * @param {{ home?: string, network?: string, rpc?: string, demo?: boolean, apiBase?: string }} opts
 * @param {{ fetchFn?: typeof fetch, now?: Date }} [deps]
 * @returns {Promise<{ ok: boolean, checks: Array<{name:string, ok:boolean, detail:string}> }>}
 */
export async function runDoctor(opts = {}, deps = {}) {
  if (opts.demo) {
    const checks = demoDoctorChecks();
    return { ok: true, checks };
  }

  const home = opts.home || getHartiiHome();
  const cfg = loadConfig(home);
  const net = resolveRuntimeNetwork({ network: opts.network || cfg.network, rpc: opts.rpc, allowInsecureRpc: opts.allowInsecureRpc });
  const apiBase = opts.apiBase || API_BASE;
  const fetchFn = deps.fetchFn;
  const now = deps.now || new Date();
  const checks = [];

  // 1. RPC reachable + 2. chain id.
  let chainIdHex = null;
  try {
    chainIdHex = await rpcCall(fetchFn, net.rpcUrl, 'quai_chainId');
    checks.push({ name: 'rpc', ok: true, detail: `${redactUrls(net.rpcUrl)} reachable` });
  } catch (err) {
    checks.push({ name: 'rpc', ok: false, detail: `${redactUrls(net.rpcUrl)} unreachable: ${redactUrls(err?.message || err)}` });
  }
  if (chainIdHex !== null) {
    const got = Number(chainIdHex);
    const ok = got === net.chainId;
    checks.push({ name: 'chainId', ok, detail: ok ? `chain ${got} matches --network ${net.name}` : `RPC reports chain ${got}, expected ${net.chainId} for --network ${net.name}` });
  } else {
    checks.push({ name: 'chainId', ok: false, detail: 'skipped (RPC unreachable)' });
  }

  // 3. Keystore perms.
  try {
    const perm = checkKeystorePerms(home);
    if (perm.status === 'not-applicable') {
      checks.push({ name: 'keystorePerms', ok: true, status: 'not-applicable', detail: 'no keystore directory exists yet' });
    } else if (!perm.applicable) {
      checks.push({ name: 'keystorePerms', ok: null, status: 'unverified', detail: 'Windows ACL access has not been verified; POSIX modes cannot certify owner-only protection' });
    } else {
      checks.push({ name: 'keystorePerms', ok: perm.issues.length === 0, detail: perm.issues.length === 0 ? 'keystore files are owner-only' : perm.issues.join('; ') });
    }
  } catch (err) {
    checks.push({ name: 'keystorePerms', ok: false, detail: err?.message || String(err) });
  }

  // 4. Address-ledger check (reads the plaintext `address` field of the current wallet's keystore
  // file — never needs the password, keystore v3 stores the address unencrypted by design).
  if (cfg.currentWallet) {
    const p = keystorePath(home, cfg.currentWallet);
    if (!existsSync(p)) {
      checks.push({ name: 'addressLedger', ok: false, detail: `current wallet "${cfg.currentWallet}" has no keystore file` });
    } else {
      try {
        const data = JSON.parse(readKeystoreFile(home, cfg.currentWallet));
        const address = getAddress('0x' + String(data.address || '').replace(/^0x/, ''));
        const ok = isCyprus1QuaiAddress(address);
        checks.push({ name: 'addressLedger', ok, detail: ok ? `${address} is a Cyprus-1 Quai address` : `${address} is NOT a Cyprus-1 Quai address` });
      } catch {
        checks.push({ name: 'addressLedger', ok: false, detail: 'could not read a valid public wallet address' });
      }
    }
  } else {
    checks.push({ name: 'addressLedger', ok: true, detail: 'no current wallet set — run `hartii wallet use <name>`' });
  }

  // 5. API reachable.
  try {
    const res = await fetch_(fetchFn, `${apiBase}/api/health`, { method: 'GET' });
    checks.push({ name: 'api', ok: Boolean(res && res.ok), detail: `${apiBase}/api/health -> ${res?.status ?? 'no response'}` });
  } catch (err) {
    checks.push({ name: 'api', ok: false, detail: `${apiBase}/api/health unreachable: ${err?.message || err}` });
  }

  // 6. Clock skew (local clock vs the chain's own latest-block timestamp).
  if (chainIdHex !== null) {
    try {
      const block = await rpcCall(fetchFn, net.rpcUrl, 'quai_getBlockByNumber', ['latest', false]);
      // Quai's block shape nests the timestamp under woHeader (work-object header); same
      // 3-way fallback as src/utils/externalVenueTrades.js / wallProvenance.js in the main repo.
      const rawTs = block?.woHeader?.timestamp ?? block?.header?.timestamp ?? block?.timestamp ?? 0;
      const blockMs = Number(BigInt(rawTs)) * 1000;
      const skewMs = Math.abs(now.getTime() - blockMs);
      const ok = skewMs <= CLOCK_SKEW_WARN_MS || blockMs === 0;
      checks.push({ name: 'clockSkew', ok, detail: blockMs === 0 ? 'could not read a block timestamp' : `${Math.round(skewMs / 1000)}s between local clock and latest block` });
    } catch (err) {
      checks.push({ name: 'clockSkew', ok: false, detail: `could not read latest block: ${redactUrls(err?.message || err)}` });
    }
  } else {
    checks.push({ name: 'clockSkew', ok: false, detail: 'skipped (RPC unreachable)' });
  }

  return { ok: checks.every((c) => c.ok !== false), verified: checks.every((c) => c.ok === true), checks };
}
