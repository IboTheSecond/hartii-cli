// packages/hartii-cli/src/signer.js
//
// Builds the quais provider every read/write command needs. Mirrors
// packages/agent-mcp/src/signer.js exactly (`usePathing: false` — both packages talk to a single
// zone-pinned RPC URL, e.g. .../cyprus1, not a multi-shard-aware endpoint).
import { JsonRpcProvider } from 'quais';

/** @param {string} rpcUrl */
export function createProvider(rpcUrl) {
  return new JsonRpcProvider(rpcUrl, undefined, { usePathing: false });
}

