// packages/hartii-cli/src/releaseKey.js
//
// The ONLY key this CLI trusts to sign releases (ed25519, public half). The private half lives off the website, in the
// owner's secrets, and is injected only into the release build (scripts/build-hartii-cli-tarball.mjs). `hartii update`
// refuses any tarball whose signature does not verify against this key; there is no override flag.
// Key rotation = ship a CLI release signed with the old key that embeds the new one.
import { createPublicKey, verify, createHash } from 'node:crypto';

export const RELEASE_KEY = Object.freeze({
  algorithm: 'ed25519',
  keyId: '3f0f68fc9ba1a619',
  publicKey: 'MCowBQYDK2VwAyEAozbF0QzMUGRXP8PsHR9mis0+fQMcg7C2E7fQBg+22O0=', // spki DER, base64
});

/** What is actually signed: a domain-separated statement binding the tarball's sha256 and version. */
export const releaseMessage = ({ sha256, version }) => Buffer.from(`hartii-cli-release/v1\n${sha256}\n${version}\n`, 'utf8');
export const keyIdOf = (spkiDerBase64) => createHash('sha256').update(Buffer.from(spkiDerBase64, 'base64')).digest('hex').slice(0, 16);

/** @returns {boolean} true only for a valid ed25519 signature by `key` over the release statement. Never throws. */
export function verifyRelease({ sha256, version, signature, keyId }, key = RELEASE_KEY) {
  try {
    if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature.trim())) return false;
    if (keyId !== undefined && keyId !== key.keyId) return false;
    const publicKey = createPublicKey({ key: Buffer.from(key.publicKey, 'base64'), format: 'der', type: 'spki' });
    return verify(null, releaseMessage({ sha256, version }), publicKey, Buffer.from(signature.trim(), 'base64'));
  } catch { return false; }
}
