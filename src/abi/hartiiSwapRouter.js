// packages/hartii-cli/src/abi/hartiiSwapRouter.js
//
// Minimal HartiiSwapRouter ABI for `hartii swap` — copied (not imported) from the main repo's
// src/abi/hartiiSwapRouter.js (HARTIISWAP_ROUTER_ABI), same fragments this CLI actually calls.
// Function names keep the Uniswap V2 "ETH" spelling on purpose: on Quai "ETH" means native QUAI,
// and router.WETH() returns the WQUAI address (see contracts/contracts/swap/HartiiSwapRouter.sol).
export const HARTIISWAP_ROUTER_ABI = [
  { type: 'function', name: 'factory', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'WETH', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  {
    type: 'function', name: 'getAmountsOut', stateMutability: 'view',
    inputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'path', type: 'address[]' }],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
  {
    type: 'function', name: 'swapExactETHForTokens', stateMutability: 'payable',
    inputs: [{ name: 'amountOutMin', type: 'uint256' }, { name: 'path', type: 'address[]' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
  {
    type: 'function', name: 'swapExactTokensForETH', stateMutability: 'nonpayable',
    inputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'amountOutMin', type: 'uint256' }, { name: 'path', type: 'address[]' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
  {
    type: 'function', name: 'swapExactTokensForTokens', stateMutability: 'nonpayable',
    inputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'amountOutMin', type: 'uint256' }, { name: 'path', type: 'address[]' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
];
