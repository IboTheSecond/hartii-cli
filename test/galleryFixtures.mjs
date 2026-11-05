// Response shapes captured from the live https://hartiigallery.com public API on 2026-11-05 (trimmed).
// Used by the Gallery/Studio tests: nothing here touches a network.
export const YOUKAI = '0x0060e0eb00491dfc54cf4149aaf574fac9ebfbb7';
export const MINERS = '0x004d92fd198c21af21016f4b119b8b851b5aeaa4';
export const FOXE = '0x000270230fc676509c6153f649cef1b73cdcf170';
export const NOROOM = '0x000b37b2f7eac95224b81cc10f55de5db7d016d6';
export const OWNER = '0x0032e81482dc268ba316c194acf9549d7bffff84';
export const WALLET = '0x00606ee2ff3a26b20213906a41aa8cafcb251237';

const META = {
  network: 'mainnet', asOfBlock: 10980962, asOfTime: '2026-11-05T10:06:08.710Z', lagBlocks: 20,
  history: { complete: true, readToBlock: 10722157, targetBlock: 10722157, percent: 100 },
  indexing: { state: 'live', scope: null, reason: null, retryAt: null },
};

export const DIRECTORY = {
  collections: [
    { address: '0x004d92fd198c21af21016f4b119b8b851b5aeaa4', name: 'Quai Miners', items: 4007, itemsUpperBound: false, firstKey: '0x004d92fd198c21af21016f4b119b8b851b5aeaa4:' },
    { address: YOUKAI, name: 'Fanged Youkai', items: 960, itemsUpperBound: false, firstKey: `${YOUKAI}:` },
    { address: '0x0062d0bc8dacf6efcb87948181c88b26c31f1d90', name: 'Quai Club Membership NFT', items: 7843, itemsUpperBound: false, firstKey: '0x0062d0bc8dacf6efcb87948181c88b26c31f1d90:' },
    { address: FOXE, name: 'Foxe', items: 10, itemsUpperBound: false, firstKey: `${FOXE}:` },
  ],
  total: 4,
};

export const WORLD_YOUKAI = {
  schema: 'hartii-studio-world', schemaVersion: 1,
  collection: {
    address: YOUKAI, presenceRoom: `col:${YOUKAI}`, studioUrl: `/studio?collection=${YOUKAI}`, url: `https://hartiigallery.com/studio?collection=${YOUKAI}`,
    piecesApi: `/api/studio/hall-art?scope=collection&address=${YOUKAI}`,
    directory: { address: YOUKAI, name: 'Fanged Youkai', items: 960, itemsUpperBound: false, firstKey: `${YOUKAI}:` },
    inDirectory: true, directoryState: 'ok', note: 'This collection has a room.',
  },
};
export const WORLD_NOROOM = {
  schema: 'hartii-studio-world', schemaVersion: 1,
  collection: {
    address: NOROOM, presenceRoom: `col:${NOROOM}`, studioUrl: `/studio?collection=${NOROOM}`, url: `https://hartiigallery.com/studio?collection=${NOROOM}`,
    piecesApi: `/api/studio/hall-art?scope=collection&address=${NOROOM}`, directory: null, inDirectory: false, directoryState: 'ok',
    note: 'No directory row: the collection is unknown to the index or has no hall-eligible art, so its room would be empty.',
  },
};

export const SEARCH_YOUKAI = {
  ...META,
  collections: [{ contract: YOUKAI, name: 'Fanged Youkai', symbol: 'FGYK', image: 'ipfs://Qme4J9/7806.png' }],
  tokens: [{ contract: YOUKAI, tokenId: '5', name: 'Fanged Youkai 5', image: 'ipfs://Qme4J9/57e4.png' }],
};
export const SEARCH_EMPTY = { ...META, collections: [], tokens: [] };

export const COLLECTION_YOUKAI = {
  ...META,
  collection: {
    contract: YOUKAI, name: 'Fanged Youkai', symbol: 'FGYK', standard: '721', items: 1471, owners: 1329,
    floorWei: '2500000000000000000', vol24Wei: '0', volTotalWei: '4000000000000000000', image: 'ipfs://Qme4J9/7806.png', sampleImages: [], deployBlock: null, transfers: 1537,
  },
  recent: [
    { kind: 'sale', contract: YOUKAI, collectionName: 'Fanged Youkai', standard: '721', tokenId: '7', from: OWNER, to: WALLET, amount: '1', priceWei: '1500000000000000000', txHash: `0x${'11'.repeat(32)}`, logIndex: 1, block: 10000000, blockTime: '2026-10-01T10:00:00.000Z', image: null },
    { kind: 'mint', contract: YOUKAI, collectionName: 'Fanged Youkai', standard: '721', tokenId: '1470', from: '0x0000000000000000000000000000000000000000', to: OWNER, amount: '1', priceWei: null, txHash: `0x${'22'.repeat(32)}`, logIndex: 0, block: 9721510, blockTime: '2026-08-23T19:26:19.000Z', image: null },
  ],
};

export const TOKEN_YOUKAI_5 = {
  ...META,
  token: {
    contract: YOUKAI, tokenId: '5', standard: '721', owner: OWNER, supply: '1', name: 'Fanged Youkai 5',
    image: 'ipfs://Qme4J9/57e4.png', uri: 'ipfs://QmStAKhvNQAAU19g6KMwkHAvQKk9gKrwbcMcRmLAszBCzY/5.json', mediaStatus: 'ok',
  },
  history: [
    { kind: 'sale', contract: YOUKAI, collectionName: 'Fanged Youkai', standard: '721', tokenId: '5', from: WALLET, to: OWNER, amount: '1', priceWei: '1500000000000000000', txHash: `0x${'33'.repeat(32)}`, logIndex: 1, block: 10000001, blockTime: '2026-10-02T10:00:00.000Z', image: null },
    { kind: 'mint', contract: YOUKAI, collectionName: 'Fanged Youkai', standard: '721', tokenId: '5', from: '0x0000000000000000000000000000000000000000', to: WALLET, amount: '1', priceWei: null, txHash: `0x${'44'.repeat(32)}`, logIndex: 0, block: 260389, blockTime: '2025-02-19T22:24:51.000Z', image: null },
  ],
};

export const META_YOUKAI_5 = {
  description: 'Fanged Youkai', image: 'ipfs://Qme4J9/57e4.png', name: 'Fanged Youkai 5', uid: '5',
  attributes: [{ trait_type: 'Background', value: 'PurpleTooth' }, { trait_type: 'Skull', value: 'Cracked' }, { trait_type: 'Level', value: 7 }],
};

export const COLLECTIONS_FULL = {
  network: 'mainnet', collections: [{ address: FOXE, name: 'Foxe', symbol: 'FOXE', slug: 'foxe' }], marketStats: {}, partial: false,
  listings: [
    { listingId: 2, seller: WALLET, collection: YOUKAI, tokenId: 5, price: '3000000000000000000', priceNum: 3, expiry: 0, marketplace: '0x003fEB578c595563e8790Ef0240B248e4D2C1Ae5', marketplaceAddress: '0x003fEB578c595563e8790Ef0240B248e4D2C1Ae5' },
    { listingId: 3, seller: WALLET, collection: YOUKAI, tokenId: 9, price: '1000000000000000000', priceNum: 1, expiry: 1, marketplace: '0x003fEB578c595563e8790Ef0240B248e4D2C1Ae5', marketplaceAddress: '0x003fEB578c595563e8790Ef0240B248e4D2C1Ae5' },
  ],
};

const sale = (collection, name, priceWei, blockTime, n) => ({ kind: 'sale', contract: collection, collectionName: name, standard: '721', tokenId: String(n), from: OWNER, to: WALLET, amount: '1', priceWei, marketplace: '0x003feb578c595563e8790ef0240b248e4d2c1ae5', txHash: `0x${String(n).padStart(2, '0').repeat(32)}`, logIndex: 1, block: 1000 + n, blockTime, image: null });
export const SALES = {
  ...META,
  items: [
    sale(YOUKAI, 'Fanged Youkai', '2000000000000000000', '2026-11-03T10:00:00.000Z', 11),
    sale(MINERS, 'Quai Miners', '9000000000000000000', '2026-11-02T10:00:00.000Z', 12),
    sale(YOUKAI, 'Fanged Youkai', '1000000000000000000', '2026-11-01T10:00:00.000Z', 13),
    sale(FOXE, 'Foxe', '1000000000000000000', '2026-05-18T10:00:00.000Z', 14),
  ],
  nextCursor: null,
};

export const OWNERS_PAGE = {
  ...META, owner: WALLET,
  holdings: [
    { contract: FOXE, tokenId: '0', amount: '1', name: 'Foxe', image: null },
    { contract: FOXE, tokenId: '3', amount: '1', name: 'Foxe', image: null },
    { contract: YOUKAI, tokenId: '5', amount: '1', name: 'Fanged Youkai 5', image: null },
  ],
  nextCursor: null,
};
