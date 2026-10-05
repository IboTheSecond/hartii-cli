// packages/hartii-cli/src/abi/hartiiTools.js
//
// Minimal ABI fragments (ethers human-readable) for the Hartii tool contracts the CLI writes to.
// Sources, verified signature-by-signature (the Biome tool contracts at hartiibiome.com):
//   HartiiAirdrop  — contracts/contracts/HartiiAirdrop.sol (quoteFee, airdropQuai, airdropToken)
//   HartiiOTCLink  — contracts/contracts/HartiiOTCLink.sol (createOffer, fillOffer, cancelOffer,
//                    quoteFill, offers, offerCount, offersByMaker, minOfferNotional, feeBps, paused)
//   HartiiClaim    — contracts/contracts/HartiiClaim.sol (campaigns, claim, isClaimed, claimFee,
//                    campaignsByCreator, paused)
//   QuaiWallV2     — this repo's src/abi/quaiWallV2.js + contracts/contracts/wall/QuaiWallV2.sol
export const HARTII_AIRDROP_ABI = [
  'function quoteFee(uint256 n) view returns (uint256)',
  'function paused() view returns (bool)',
  'function airdropQuai(address[] recipients, uint256[] amounts) payable',
  'function airdropToken(address token, address[] recipients, uint256[] amounts) payable',
];

export const HARTII_OTC_ABI = [
  'function createOffer(address tokenOffered, uint256 amountOffered, uint256 amountWanted, address takerOnly, uint64 expiry) returns (uint256 id)',
  'function fillOffer(uint256 id) payable',
  'function cancelOffer(uint256 id)',
  'function quoteFill(uint256 id) view returns (uint256 totalDue, uint256 fee, bool likelyFillable)',
  'function offers(uint256 id) view returns (address maker, address tokenOffered, uint256 amountOffered, uint256 amountWanted, address takerOnly, uint64 expiry, bool active, bool filled)',
  'function offerCount() view returns (uint256)',
  'function offersByMaker(address maker, uint256 offset, uint256 limit) view returns (uint256[] ids)',
  'function minOfferNotional() view returns (uint256)',
  'function feeBps() view returns (uint256)',
  'function paused() view returns (bool)',
];

export const HARTII_CLAIM_ABI = [
  'function campaigns(uint256 id) view returns (address creator, address token, uint256 totalAmount, uint256 remaining, bytes32 merkleRoot, uint256 leafCount, uint256 expiry, bool closed, string metadataURI)',
  'function claim(uint256 id, uint256 index, address account, uint256 amount, bytes32[] proof) payable',
  'function isClaimed(uint256 id, uint256 index) view returns (bool)',
  'function claimFee() view returns (uint256)',
  'function campaignsByCreator(address creator, uint256 offset, uint256 limit) view returns (uint256[] ids)',
  'function paused() view returns (bool)',
];

export const QUAI_WALL_V2_ABI = [
  'function engrave(uint256 wallId, string message, uint24 color, address token) payable returns (uint256 idx)',
  'function priceOf(uint256 wallId) view returns (uint256)',
  'function getWall(uint256 wallId) view returns (tuple(address creator, uint64 createdAt, uint128 basePrice, string name) wall, uint256 blockCount, uint256 nextPrice)',
  'function engravingsPage(uint256 wallId, uint256 offset, uint256 limit) view returns (tuple(address author, uint64 timestamp, uint24 color, uint128 paid, address token, string message)[] page, bool[] mutedFlags)',
  'function stats() view returns (uint256 wallCount, uint256 totalEngravings, uint256 totalPaidWei, uint256 engraveBase, uint256 wallFee)',
];
