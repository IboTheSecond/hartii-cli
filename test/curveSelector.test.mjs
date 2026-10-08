import { describe, it, expect } from 'vitest';
import { Interface, JsonRpcApiProvider } from 'quais';
import { readCurveMeta } from '../src/curveState.js';
import { BONDING_CURVE_ABI, BONDING_CURVE_V3_ABI } from '../src/abi/bondingCurve.js';
import { DEMO_CURVE_META } from '../src/demoFixtures.js';

const CURVE = '0x0010000000000000000000000000000000000003';
const iface = new Interface([...BONDING_CURVE_ABI, ...BONDING_CURVE_V3_ABI]);
const payload = { jsonrpc: '2.0', id: 1, method: 'quai_call', params: [{ to: CURVE, data: iface.encodeFunctionData('creatorPayout') }, 'latest'] };
function sdkError({ message = 'execution reverted', data, code = -32000 } = {}) {
  return JsonRpcApiProvider.prototype.getRpcError.call({}, payload, { error: { code, message, ...(data === undefined ? {} : { data }) } }, '0x00');
}
const providerWith = failure => ({ call: async tx => {
  const parsed = iface.parseTransaction(tx);
  if (parsed.name === 'creatorPayout') throw failure;
  return iface.encodeFunctionResult(parsed.name, [DEMO_CURVE_META[parsed.name] ?? 0n]);
} });

describe('CLI curve generation uses actual SDK error evidence', () => {
  it.each(['0x', null, undefined])('supports a legacy execution revert with raw data %s', async data => {
    const failure = sdkError({ data });
    expect(failure.reason).toBe(data === '0x' ? 'require(false)' : null);
    expect(await readCurveMeta(providerWith(failure), CURVE)).toMatchObject({ isV3: false });
  });
  it.each([
    sdkError({ code: -32005, message: 'rate limit exceeded' }),
    sdkError({ code: -32603, message: 'upstream timeout' }),
    sdkError({ data: '0x1234' }),
    Object.assign(Error('bare CALL_EXCEPTION'), { code: 'CALL_EXCEPTION', data: '0x' }),
  ])('fails closed on transport, nonempty data or absent raw execution evidence', async failure => {
    await expect(readCurveMeta(providerWith(failure), CURVE)).rejects.toBe(failure);
  });
});
