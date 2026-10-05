// packages/hartii-cli/src/quaiscan.js
//
// quaiscan.io link builders — every successful write prints one of these (the product spec HARD
// RULES: "print the quaiscan.io tx link"). Orchard has its own quaiscan subdomain; mainnet has
// none. Pure string building, no network calls.
export function quaiscanTxUrl(network, hash) {
  const base = network === 'orchard' ? 'https://orchard.quaiscan.io' : 'https://quaiscan.io';
  return `${base}/tx/${hash}`;
}

export function quaiscanAddressUrl(network, address) {
  const base = network === 'orchard' ? 'https://orchard.quaiscan.io' : 'https://quaiscan.io';
  return `${base}/address/${address}`;
}
