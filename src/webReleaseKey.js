// packages/hartii-cli/src/webReleaseKey.js
//
// The ONLY key `hartii verify-site` trusts for the hartiilabs.com build manifest (ed25519, public half). It is pinned
// here, not fetched, because a key that lives only in the website's own source cannot protect anyone from a full takeover
// of the host. The CLI itself ships as an ed25519-signed release (src/releaseKey.js). Same values as src/data/webReleaseKey.json
// (a root test keeps the two in sync). Key rotation = ship a CLI release that embeds the new key.
export const WEB_RELEASE_KEY = Object.freeze({
  keyId: 'a17f68595150dac6',
  publicKey: 'MCowBQYDK2VwAyEAhVBH41JQlbE/n9LgoZ42BMMYv+KaP2vUs78x3iClTG0=', // spki DER, base64
  algorithm: 'ed25519',
  statement: 'hartii-web-build/v1',
});
