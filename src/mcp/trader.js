import { z } from 'zod';

/** Local public-data reader only: status(), limits(), activity({after?,limit?}).
 * The CLI adapter supplies these methods; no signer/model key or write API is reachable here.
 */
export function buildTraderTools(reader) {
  const read = async (method, args) => {
    if (typeof reader?.[method] !== 'function') return { configured: false, reason: 'trader-reader-not-configured' };
    const value = await reader[method](args);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Trader reader returned an invalid object result.');
    return value;
  };
  return [
    { name: 'hartii_trader_status', description: 'Read the local holder trader status. No unlock, arm or signing authority.', inputSchema: {}, handler: () => read('status') },
    { name: 'hartii_trader_limits', description: 'Read the local trader policy limits and blockers. Cannot change limits.', inputSchema: {}, handler: () => read('limits') },
    { name: 'hartii_trader_activity', description: 'Read the local trader public activity journal. Cursor is a nonnegative event sequence.', inputSchema: { after: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(), limit: z.number().int().min(1).max(100).optional() }, handler: (args) => read('activity', args) },
  ].map((tool) => ({ ...tool, write: false, local: true }));
}
