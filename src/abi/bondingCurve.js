// packages/hartii-cli/src/abi/bondingCurve.js
//
// Minimal BondingCurve ABI this CLI needs for `buy`/`sell`/`token` — copied (not imported, since
// src/ is a separate app package) from the main repo's src/abi/bondingCurve.js (BONDING_CURVE_ABI)
// and src/abi/bondingCurveV3.js (BONDING_CURVE_V3_TRADE_ABI, poolQuaiReserve/poolTokenReserve,
// creatorPayout). One merged ABI, same convention as the main repo's getCurveContract: every V1
// signature is also a V2 signature; V3-only selectors (creatorPayout, poolQuaiReserve/
// poolTokenReserve, the deadline-carrying buy/sell overloads) simply revert on an older curve —
// callers probe for that (see curveState.js's isV3 probe) rather than assuming.
export const BONDING_CURVE_ABI = [
  { type: 'function', name: 'token', stateMutability: 'view', inputs: [], outputs: [{name:'',type:'address'}] },
  // V1/V2 use these selectors; V3/V4 require the deadline selectors below.
  { type: 'function', name: 'buy', stateMutability: 'payable', inputs: [{ name: 'minTokensOut', type: 'uint256' }], outputs: [{ name: 'tokensOut', type: 'uint256' }] },
  { type: 'function', name: 'sell', stateMutability: 'nonpayable', inputs: [{ name: 'tokensIn', type: 'uint256' }, { name: 'minQuaiOut', type: 'uint256' }], outputs: [{ name: 'quaiOut', type: 'uint256' }] },
  { type: 'function', name: 'quoteBuy', stateMutability: 'view', inputs: [{ name: 'quaiIn', type: 'uint256' }], outputs: [{ name: 'tokensOut', type: 'uint256' }] },
  { type: 'function', name: 'quoteSell', stateMutability: 'view', inputs: [{ name: 'tokensIn', type: 'uint256' }], outputs: [{ name: 'quaiOut', type: 'uint256' }] },
  { type: 'function', name: 'tokensRemaining', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'tokensSold', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'graduated', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'feeBps', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'curveSupply', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  // Universal reserve reads (PR1 latency programme, present on every generation).
  { type: 'function', name: 'virtualQuaiReserve', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'virtualTokenReserve', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'realQuaiReserve', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
];

const u = (name, type = 'uint256') => ({ name, type });

// Kept separate (same convention as the main repo) because V3/V4's buy/sell overload the V1/V2
// names with an extra deadline parameter — callers pick this ABI only once isV3 is confirmed.
export const BONDING_CURVE_V3_TRADE_ABI = [
  { type: 'function', name: 'buy', stateMutability: 'payable', inputs: [u('minTokensOut'), u('deadline')], outputs: [u('tokensOut')] },
  { type: 'function', name: 'sell', stateMutability: 'nonpayable', inputs: [u('tokensIn'), u('minQuaiOut'), u('deadline')], outputs: [u('quaiOut')] },
];

// V3+-only reads: poolQuaiReserve/poolTokenReserve (post-graduation pool state — ALWAYS readable,
// real values pre-graduation too, never revert) and creatorPayout (used purely as an isV3 PROBE —
// it reverts outright on a V1/V2 curve, which is how curveState.js tells the generations apart).
export const BONDING_CURVE_V3_ABI = [
  { type: 'function', name: 'poolQuaiReserve', stateMutability: 'view', inputs: [], outputs: [u('', 'uint128')] },
  { type: 'function', name: 'poolTokenReserve', stateMutability: 'view', inputs: [], outputs: [u('', 'uint128')] },
  { type: 'function', name: 'creatorPayout', stateMutability: 'view', inputs: [], outputs: [u('', 'address')] },
];
