// ABI for QuaiWallV2 — "Wall of Blocks" (promote your memecoin), mainnet.
//
// TESTING SURFACE: this contract is being built in parallel; the address is not
// known yet (src/data/liveAddresses.json -> mainnet.wall.address is null until the
// owner deploys and wires it). This file encodes the FIXED interface agreed for V2
// (struct Wall/Engraving with an added `token` field on Engraving, engrave() takes
// a `token` param). Reconcile against the compiled ABI once the contract is live —
// diff this file against artifacts/QuaiWallV2.sol/QuaiWallV2.json's abi and update
// in the same commit as the address.
//
// Struct shapes (must match test/quaiWallAbiShape.test.js):
//   Wall      { creator address, createdAt uint64, basePrice uint128, name string }
//   Engraving { author address, timestamp uint64, color uint24, paid uint128,
//               token address, message string }

export const MAX_MESSAGE_LEN = 280;
export const MAX_WALL_NAME = 48;
export const PRICE_SLOPE_DIV = 20n;
export const GLOBAL_WALL_ID = 1;

const WALL_TUPLE = {
  type: 'tuple',
  components: [
    { name: 'creator', type: 'address' },
    { name: 'createdAt', type: 'uint64' },
    { name: 'basePrice', type: 'uint128' },
    { name: 'name', type: 'string' },
  ],
};

const ENGRAVING_TUPLE = {
  type: 'tuple',
  components: [
    { name: 'author', type: 'address' },
    { name: 'timestamp', type: 'uint64' },
    { name: 'color', type: 'uint24' },
    { name: 'paid', type: 'uint128' },
    { name: 'token', type: 'address' },
    { name: 'message', type: 'string' },
  ],
};

export const QUAI_WALL_V2_ABI = [
  // ---- writes ----
  {
    type: 'function',
    name: 'createWall',
    stateMutability: 'payable',
    inputs: [{ name: 'name', type: 'string' }],
    outputs: [{ name: 'id', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'engrave',
    stateMutability: 'payable',
    inputs: [
      { name: 'wallId', type: 'uint256' },
      { name: 'message', type: 'string' },
      { name: 'color', type: 'uint24' },
      { name: 'token', type: 'address' },
    ],
    outputs: [{ name: 'idx', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },

  // ---- views ----
  {
    type: 'function',
    name: 'priceOf',
    stateMutability: 'view',
    inputs: [{ name: 'wallId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getWall',
    stateMutability: 'view',
    inputs: [{ name: 'wallId', type: 'uint256' }],
    outputs: [
      { name: 'wall', ...WALL_TUPLE },
      { name: 'blockCount', type: 'uint256' },
      { name: 'nextPrice', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'getEngraving',
    stateMutability: 'view',
    inputs: [
      { name: 'wallId', type: 'uint256' },
      { name: 'idx', type: 'uint256' },
    ],
    outputs: [
      { name: 'e', ...ENGRAVING_TUPLE },
      { name: 'isMuted', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'engravingsPage',
    stateMutability: 'view',
    inputs: [
      { name: 'wallId', type: 'uint256' },
      { name: 'offset', type: 'uint256' },
      { name: 'limit', type: 'uint256' },
    ],
    outputs: [
      { name: 'page', type: 'tuple[]', components: ENGRAVING_TUPLE.components },
      { name: 'mutedFlags', type: 'bool[]' },
    ],
  },
  {
    type: 'function',
    name: 'wallsPage',
    stateMutability: 'view',
    inputs: [
      { name: 'offset', type: 'uint256' },
      { name: 'limit', type: 'uint256' },
    ],
    outputs: [{ name: 'ids', type: 'uint256[]' }],
  },
  {
    type: 'function',
    name: 'stats',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'wallCount', type: 'uint256' },
      { name: 'totalEngravings', type: 'uint256' },
      { name: 'totalPaidWei', type: 'uint256' },
      { name: 'engraveBase', type: 'uint256' },
      { name: 'wallFee', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'pending',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'owner',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'MAX_MESSAGE_LEN',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'MAX_WALL_NAME',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'PRICE_SLOPE_DIV',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },

  // ---- events ----
  {
    type: 'event',
    name: 'Engraved',
    anonymous: false,
    inputs: [
      { name: 'wallId', type: 'uint256', indexed: true },
      { name: 'idx', type: 'uint256', indexed: true },
      { name: 'author', type: 'address', indexed: true },
      { name: 'paid', type: 'uint256', indexed: false },
      { name: 'color', type: 'uint24', indexed: false },
      { name: 'token', type: 'address', indexed: false },
      { name: 'message', type: 'string', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'WallCreated',
    anonymous: false,
    inputs: [
      { name: 'id', type: 'uint256', indexed: true },
      { name: 'creator', type: 'address', indexed: true },
      { name: 'basePrice', type: 'uint256', indexed: false },
      { name: 'name', type: 'string', indexed: false },
    ],
  },
];
