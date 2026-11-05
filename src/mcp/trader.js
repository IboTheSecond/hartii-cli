import { z } from 'zod';

/** Local public-data reader only: status(), limits(), activity({after?,limit?}).
 * The CLI adapter supplies these methods; no signer/model key or write API is reachable here.
 */
export const presetView = (p) => ({ preset: p.preset, perTxQuai: p.perTxQuai, dailyQuai: p.dailyQuai, maxSlippageBps: p.maxSlippageBps });

export function buildTraderTools(reader, preset) {
  const read = async (method, args) => {
    if (typeof reader?.[method] !== 'function') return { configured: false, reason: 'trader-reader-not-configured' };
    const value = await reader[method](args);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Trader reader returned an invalid object result.');
    return value;
  };
  return [
    { name: 'hartii_trader_status', description: 'Read the local holder trader status. No unlock, arm or signing authority.', inputSchema: {}, handler: () => read('status') },
    { name: 'hartii_trader_limits', description: 'Read the local trader policy limits and blockers. Cannot change limits.', inputSchema: {}, handler: async () => { const v = await read('limits'); return preset ? { ...v, activePreset: presetView(preset) } : v; } },
    { name: 'hartii_trader_activity', description: 'Read the local trader public activity journal. Cursor is a nonnegative event sequence.', inputSchema: { after: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(), limit: z.number().int().min(1).max(100).optional() }, handler: (args) => read('activity', args) },
  ].map((tool) => ({ ...tool, write: false, local: true }));
}
