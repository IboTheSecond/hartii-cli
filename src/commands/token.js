import { withProviderCleanup } from '../commandContext.js';
// packages/hartii-cli/src/commands/token.js
//
// `hartii token <addr|ticker>` — one token's detail: price reference, live curve state,
// graduation progress, holder count, links. Read-only, never needs a wallet/keystore.
import { createProvider } from '../signer.js';
import { fetchToken, fetchTokenReference, MarketError } from '../marketApi.js';
import { readCurveMeta } from '../curveState.js';
import { quaiscanAddressUrl } from '../quaiscan.js';
import { DEMO_TOKEN, DEMO_CURVE_META, DEMO_NETWORK } from '../demoFixtures.js';
import { readRuntime } from '../commandContext.js';
import { assertMarketNetwork } from '../marketApi.js';
import { CliError } from '../errors.js';

export class TokenError extends CliError {}

function jsonSafeCurveState(state) {
  if (!state) return null;
  const out = {};
  for (const [k, v] of Object.entries(state)) out[k] = typeof v === 'bigint' ? v.toString() : v;
  return out;
}

/**
 * @param {{ id: string, home?: string, network?: string, rpc?: string, demo?: boolean }} opts
 * @param {{ apiBase?: string, fetchFn?: typeof fetch, providerFactory?: Function }} [deps]
 */
async function runTokenCore(opts = {}, deps = {}) {
  if (!opts.id) throw new TokenError('Usage: hartii token <addr|ticker>');

  if (opts.demo) {
    return {
      token: DEMO_TOKEN,
      network: DEMO_NETWORK,
      graduationProgress: { graduated: false, progressPct: 7.83 },
      reference: null,
      curveState: jsonSafeCurveState(DEMO_CURVE_META),
      links: { quaiscanToken: quaiscanAddressUrl(DEMO_NETWORK, DEMO_TOKEN.address), hartiilabs: `https://hartiilabs.com/${DEMO_TOKEN.symbol}` },
    };
  }

  const { net } = readRuntime(opts, deps);
  assertMarketNetwork(net.name);
  deps = { ...deps, network: net.name };
  const detail = await fetchToken(opts.id, deps);

  let reference = null;
  try {
    reference = await fetchTokenReference(detail.token.address, deps);
  } catch (err) {
    if (!(err instanceof MarketError)) throw err;
    reference = { error: err.message };
  }

  let curveState = null;
  let curveStateError = null;
  if (detail.token.curveAddress) {
    try {
      const providerFactory = deps.providerFactory || createProvider;
      const provider = providerFactory(net.rpcUrl);
      curveState = jsonSafeCurveState(await readCurveMeta(provider, detail.token.curveAddress));
    } catch (err) {
      curveStateError = `Could not read live curve state: ${err?.message || err}`;
    }
  }

  return {
    token: detail.token,
    network: net.name,
    graduationProgress: detail.graduationProgress,
    reference,
    curveState,
    curveStateError,
    links: {
      quaiscanToken: quaiscanAddressUrl(net.name, detail.token.address),
      quaiscanCurve: detail.token.curveAddress ? quaiscanAddressUrl(net.name, detail.token.curveAddress) : null,
      hartiilabs: `https://hartiilabs.com/${detail.token.symbol || detail.token.address}`,
    },
  };
}

export function runToken(opts = {}, deps = {}) { return withProviderCleanup(deps, (runtimeDeps) => runTokenCore(opts, runtimeDeps)); }
