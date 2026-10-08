// packages/hartii-cli/src/curveState.js
//
// Node-safe, read-only access to a BondingCurve's live state and on-chain quotes — the CLI's own
// equivalent of the main repo's src/utils/curveReads.js, which cannot be imported directly here
// (browser/Vite-only transitive imports — see curveQuote.js's header for the proof). No caching:
// each CLI invocation is a single short-lived process, so every call here reads fresh, exactly
// once, which is also the money-safety property the main repo's `force: true`/`fresh: true` reads
// insist on for anything that becomes minTokensOut/minQuaiOut on a real send.
import { Interface } from 'quais';
import { resilientRead } from '../vendor/packages/agent-mcp/src/rpcClient.js';
import { launchFactories } from './liveAddresses.js';
import { BONDING_CURVE_ABI, BONDING_CURVE_V3_ABI, BONDING_CURVE_V3_TRADE_ABI } from './abi/bondingCurve.js';
import { isEmptyCurveSelectorRevert } from '../vendor/src/utils/curveProbe.js';

const CURVE_IFACE = new Interface([...BONDING_CURVE_ABI, ...BONDING_CURVE_V3_ABI]);
const TRADE_V1_IFACE = new Interface(BONDING_CURVE_ABI);
const TRADE_V3_IFACE = new Interface(BONDING_CURVE_V3_TRADE_ABI);

export async function assertCurveToken(provider, curveAddress, tokenAddress) {
  const token = await call(provider, curveAddress, 'token');
  if (String(token).toLowerCase() !== tokenAddress.toLowerCase()) throw new Error('Curve token binding does not match the requested token.');
}

function call(provider, curveAddress, fn, args = []) {
  const data = CURVE_IFACE.encodeFunctionData(fn, args);
  return resilientRead(() => provider.call({ to: curveAddress, data }), { primaryAttempts: 2 }).then((hex) => CURVE_IFACE.decodeFunctionResult(fn, hex)[0]);
}

/**
 * One batched read of everything curveQuote.js's rawBuyOut/rawSellOut/localQuote need, plus the
 * fields buy.js/sell.js need to build the right tx (isV3 gates which trade ABI/deadline to use).
 * `isV3` is probed via `creatorPayout()` — reverts outright on a V1/V2 curve, same probe the main
 * repo's readCurveMeta uses (see that file's own comment on why this, not totalLpShares, is the
 * chosen V3 tell for trade-ABI purposes: creatorPayout exists on every V3+ curve exactly like
 * totalLpShares does, and either reverts identically on V1/V2).
 * @param {import('quais').JsonRpcProvider} provider
 * @param {string} curveAddress
 */
export async function readCurveMeta(provider, curveAddress) {
  const [feeBps, graduated, tokensRemaining, tokensSold, virtualQuaiReserve, virtualTokenReserve, realQuaiReserve, isV3] = await Promise.all([
    call(provider, curveAddress, 'feeBps'),
    call(provider, curveAddress, 'graduated'),
    call(provider, curveAddress, 'tokensRemaining'),
    call(provider, curveAddress, 'tokensSold'),
    call(provider, curveAddress, 'virtualQuaiReserve'),
    call(provider, curveAddress, 'virtualTokenReserve'),
    call(provider, curveAddress, 'realQuaiReserve'),
    call(provider, curveAddress, 'creatorPayout').then(() => true).catch((err) => {
      if (isEmptyCurveSelectorRevert(err)) return false;
      throw err;
    }),
  ]);
  // poolQuaiReserve/poolTokenReserve are real, always-readable public vars on every generation
  // (never revert, per the main repo's own comment) — read unconditionally, defensively tolerant
  // of a genuine RPC hiccup on just these two (curveQuote.js's rawBuyOut/rawSellOut gate the
  // ceilDiv formula on `isV3`, not on these being non-null, same as the real app).
  const [poolQuaiReserve, poolTokenReserve] = await Promise.all([
    call(provider, curveAddress, 'poolQuaiReserve').catch(() => null),
    call(provider, curveAddress, 'poolTokenReserve').catch(() => null),
  ]);
  return {
    feeBps: BigInt(feeBps),
    graduated: Boolean(graduated),
    tokensRemaining: BigInt(tokensRemaining),
    tokensSold: BigInt(tokensSold),
    isV3: Boolean(isV3),
    virtualQuaiReserve: BigInt(virtualQuaiReserve),
    virtualTokenReserve: BigInt(virtualTokenReserve),
    realQuaiReserve: BigInt(realQuaiReserve),
    poolQuaiReserve: poolQuaiReserve != null ? BigInt(poolQuaiReserve) : null,
    poolTokenReserve: poolTokenReserve != null ? BigInt(poolTokenReserve) : null,
  };
}

/** Authoritative on-chain quoteBuy(netInput) — the real contract's own math, not a local guess. */
export async function quoteBuyOnChain(provider, curveAddress, netInput) {
  return BigInt(await call(provider, curveAddress, 'quoteBuy', [netInput]));
}

/** Authoritative on-chain quoteSell(tokensIn) — gross QUAI out, ignoring fees, per the contract. */
export async function quoteSellOnChain(provider, curveAddress, tokensIn) {
  return BigInt(await call(provider, curveAddress, 'quoteSell', [tokensIn]));
}

/** Encodes `buy(minTokensOut[, deadline])` — the deadline overload once `isV3` is true. */
export function encodeBuy(minTokensOut, { isV3, deadline } = {}) {
  return isV3 ? TRADE_V3_IFACE.encodeFunctionData('buy', [minTokensOut, deadline]) : TRADE_V1_IFACE.encodeFunctionData('buy', [minTokensOut]);
}

/** Encodes `sell(tokensIn, minQuaiOut[, deadline])` — the deadline overload once `isV3` is true. */
export function encodeSell(tokensIn, minQuaiOut, { isV3, deadline } = {}) {
  return isV3 ? TRADE_V3_IFACE.encodeFunctionData('sell', [tokensIn, minQuaiOut, deadline]) : TRADE_V1_IFACE.encodeFunctionData('sell', [tokensIn, minQuaiOut]);
}

const FACTORY_IFACE = new Interface(['function curveOf(address) view returns (address)']);

/**
 * Refuses unless one of the BUNDLED launch factories (src/data/liveAddresses.json) maps
 * token -> curve via TokenFactory.curveOf. The market API's curveAddress is never trusted alone.
 */
export async function assertFactoryCurve(provider, curveAddress, tokenAddress, network = 'mainnet') {
  const factories = launchFactories(network);
  for (const factory of factories) {
    try {
      const data = FACTORY_IFACE.encodeFunctionData('curveOf', [tokenAddress]);
      const hex = await resilientRead(() => provider.call({ to: factory, data }), { primaryAttempts: 2 });
      const found = String(FACTORY_IFACE.decodeFunctionResult('curveOf', hex)[0]);
      if (found.toLowerCase() === curveAddress.toLowerCase()) return factory;
    } catch { /* try the next bundled factory */ }
  }
  throw new Error(`Refusing: curve ${curveAddress} is not registered for token ${tokenAddress} by any bundled Hartii launch factory (the market API's curve address was not trusted).`);
}

/** Factory check plus the curve's own token() binding. */
export async function assertVerifiedCurve(provider, curveAddress, tokenAddress, network = 'mainnet') {
  await assertFactoryCurve(provider, curveAddress, tokenAddress, network);
  await assertCurveToken(provider, curveAddress, tokenAddress);
}
