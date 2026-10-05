import { describe, it, expect } from 'vitest';
import { Interface } from 'quais';
import { quoteAndBuildBuy } from '../src/trade.js';
import { BONDING_CURVE_ABI, BONDING_CURVE_V3_ABI } from '../src/abi/bondingCurve.js';
import { DEMO_CURVE_META } from '../src/demoFixtures.js';
import { rawBuyOut } from '../src/curveQuote.js';

const curve = new Interface([...BONDING_CURVE_ABI, ...BONDING_CURVE_V3_ABI]);
const CURVE = '0x0010000000000000000000000000000000000003';

function providerFor(meta) {
  return {
    call: async (tx) => {
      const p = curve.parseTransaction({ data: tx.data });
      if (p.name === 'creatorPayout') return curve.encodeFunctionResult(p.name, [CURVE]);
      if (p.name === 'quoteBuy') return curve.encodeFunctionResult(p.name, [rawBuyOut(meta, p.args[0])]);
      return curve.encodeFunctionResult(p.name, [meta[p.name]]);
    },
  };
}

describe('quoteAndBuildBuy finishing buy', () => {
  it('uses a 1-wei floor and trims the value sent when the buy would finish the curve', async () => {
    const meta = { ...DEMO_CURVE_META, tokensRemaining: 1000n };
    const q = await quoteAndBuildBuy(providerFor(meta), CURVE, 5n * 10n ** 18n, 300);
    expect(q.finishing).toBe(true);
    expect(q.minTokensOut).toBe(1n);
    expect(q.valueWei).toBeLessThan(5n * 10n ** 18n);
    expect(q.expectedOut).toBe(1000n);
  });
  it('keeps the slippage floor and full value for a normal buy', async () => {
    const q = await quoteAndBuildBuy(providerFor(DEMO_CURVE_META), CURVE, 10n ** 18n, 300);
    expect(q.finishing).toBe(false);
    expect(q.valueWei).toBe(10n ** 18n);
    expect(q.minTokensOut).toBe((q.expectedOut * 9700n) / 10000n);
  });
});
