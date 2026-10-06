// packages/hartii-cli/src/address.js
//
// Address validation shared by every write path. Quai Network shards addresses by their first two
// bytes into one of nine zones (Cyprus1/2/3, Paxos1/2/3, Hydra1/2/3), and separately marks whether
// an address belongs to the Quai ledger (EVM-style, what this wallet sends) or the Qi ledger (UTXO-
// style — a different asset/ledger entirely). See memory note "Quai vs Qi address bit": ground/
// derived addresses must pass isQuaiAddress (second byte MSB clear); a Qi address must be rejected
// outright, never silently coerced. Hartii's whole stack (AgentVault, this CLI, the bonding
// curves) only ever operates in Cyprus-1 — see packages/agent-mcp/src/config.js's own
// isCyprus1QuaiAddress, mirrored here so both packages reject the exact same set of addresses.
import { getAddress, isQuaiAddress, isQiAddress, getZoneForAddress, Zone } from 'quais';
import { CliError } from './errors.js';

export class AddressError extends CliError {}

/**
 * Checksums `address` via quais' getAddress (mainnet rejects a lowercase address outright — see
 * memory note "Quai mainnet checksum + gas quirks" — so every address that reaches a tx object
 * must pass through here first, not just addresses the user types by hand).
 * @param {string} address
 * @returns {string} the mixed-case checksummed address
 * @throws {AddressError} if `address` is not a well-formed 20-byte hex address at all
 */
export function checksumAddress(address) {
  try {
    return getAddress(String(address));
  } catch {
    throw new AddressError(`"${address}" is not a valid address.`);
  }
}

/**
 * @param {string} address an already-well-formed hex address (checksummed or not — isQuaiAddress/
 *   getZoneForAddress tolerate either case)
 * @returns {boolean} true only for a Quai-ledger address resolving to the Cyprus-1 zone; never
 *   throws — anything malformed or out-of-zone or Qi-ledger is simply `false`.
 */
export function isCyprus1QuaiAddress(address) {
  try {
    return isQuaiAddress(address) && getZoneForAddress(address) === Zone.Cyprus1;
  } catch {
    return false;
  }
}

/**
 * The one check every write destination (and every wallet address this CLI will ever sign with)
 * must pass. Throws a specific, actionable message for each distinct way an address can be
 * unusable, rather than one generic "invalid address" — a Qi-ledger address is a different ledger
 * entirely (not a typo), and that distinction matters to the person reading the error.
 * @param {string} address
 * @returns {string} the checksummed address, once validated
 * @throws {AddressError}
 */
export function assertCyprus1QuaiAddress(address) {
  const checksummed = checksumAddress(address);
  if (isQiAddress(checksummed)) {
    throw new AddressError(`${checksummed} is a Qi-ledger address. Hartii pays on the Quai ledger — use a Quai address (starts 0x00…), or wrap your Qi to WQI first.`);
  }
  if (!isQuaiAddress(checksummed)) {
    throw new AddressError(`${checksummed} is not a Quai-ledger address.`);
  }
  const zone = getZoneForAddress(checksummed);
  if (zone !== Zone.Cyprus1) {
    throw new AddressError(`${checksummed} is in zone ${zone}, not Cyprus-1 — Hartii only operates in Cyprus-1.`);
  }
  return checksummed;
}

/** Shortens an address for display: 0x0003…bB64 (first 6 + last 4 hex chars after 0x). */
export function shortAddress(address) {
  const a = String(address || '');
  if (a.length <= 12) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
