// Fail closed if a token cannot be valued from a fresh on-chain QUAI quote.
import { Interface } from 'quais';
import { resolveToken, assertMarketNetwork } from './marketApi.js';
import { quoteSellOnChain, assertVerifiedCurve } from './curveState.js';
import { hartiiSwapAddresses } from './liveAddresses.js';
import { HARTIISWAP_ROUTER_ABI } from './abi/hartiiSwapRouter.js';
import { assertCyprus1QuaiAddress } from './address.js';
import { WriteError } from './writePipeline.js';
const router = new Interface(HARTIISWAP_ROUTER_ABI);
export async function tokenValueQuai(provider, token, amount, network, deps = {}) {
  if (network !== 'mainnet') throw new WriteError(`Token-denominated writes are mainnet-only: a token can only be valued in QUAI (for the spending guard) through the Hartii market and HartiiSwap, which do not exist on ${network}. Refusing the write.`);
  assertMarketNetwork(network);
  const swap = hartiiSwapAddresses(network);
  if (token.toLowerCase() === swap?.wquai?.toLowerCase()) return amount;
  let info;
  try { info = await resolveToken(token, { ...deps, network }); } catch { /* a pasted token may not be indexed */ }
  let value;
  if (info?.curveAddress) {
    await assertVerifiedCurve(provider, assertCyprus1QuaiAddress(info.curveAddress), token, network);
    value = await quoteSellOnChain(provider, assertCyprus1QuaiAddress(info.curveAddress), amount);
  } else if (swap?.router) {
    const data = router.encodeFunctionData('getAmountsOut', [amount, [token, swap.wquai]]);
    try { const amounts = router.decodeFunctionResult('getAmountsOut', await provider.call({to:swap.router,data}))[0]; value = BigInt(amounts[amounts.length-1]); }
    catch { /* no usable QUAI route */ }
  }
  if (typeof value !== 'bigint' || value <= 0n) throw new WriteError('Cannot value this token in QUAI for spending limits; refusing the write.');
  return value;
}
