import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePreset } from '../src/presets.js';
import { resolveMcpContext, buildMcpServer } from '../src/mcp/server.js';
import { buildTools } from '../src/mcp/tools.js';

describe('resolvePreset', () => {
  it('defines the three presets in exact wei', () => {
    expect(resolvePreset({ preset: 'conservative' })).toMatchObject({ perTxQuai: '10', dailyQuai: '50', perTxWei: '10000000000000000000', maxSlippageBps: 100 });
    expect(resolvePreset({ preset: 'normal' })).toMatchObject({ perTxQuai: '50', dailyQuai: '250', maxSlippageBps: 200 });
    expect(resolvePreset({ preset: 'degen' })).toMatchObject({ perTxQuai: '250', dailyQuai: '1000', dailyWei: '1000000000000000000000', maxSlippageBps: 500 });
  });
  it('null without a preset; unknown preset errors', () => {
    expect(resolvePreset({})).toBeNull();
    expect(() => resolvePreset({ preset: 'yolo' })).toThrow(/Unknown --preset/);
    expect(() => resolvePreset({ preset: '__proto__' })).toThrow(/Unknown --preset/);
  });
  it('explicit caps may only lower', () => {
    expect(resolvePreset({ preset: 'normal', maxPerTx: '5.5', maxPerDay: '250' })).toMatchObject({ perTxQuai: '5.5', dailyQuai: '250' });
    expect(() => resolvePreset({ preset: 'normal', maxPerTx: '50.000000000000000001' })).toThrow(/only lower/);
    expect(() => resolvePreset({ preset: 'conservative', maxPerDay: '51' })).toThrow(/only lower/);
    expect(() => resolvePreset({ preset: 'normal', maxPerTx: 'abc' })).toThrow(/--max-per-tx/);
  });
});

describe('mcp context with preset', () => {
  const home = mkdtempSync(join(tmpdir(), 'hartii-preset-'));
  it('preset satisfies the --allow-writes cap requirement', () => {
    const c = resolveMcpContext({ home, allowWrites: true, preset: 'conservative' });
    expect(c).toMatchObject({ allowWrites: true, limits: { perTxQuai: '10', dailyQuai: '50' }, preset: { preset: 'conservative', maxSlippageBps: 100 } });
  });
  it('lower explicit caps win, raising errors, no preset keeps old behaviour', () => {
    expect(resolveMcpContext({ home, allowWrites: true, preset: 'degen', maxPerTx: '20' }).limits).toEqual({ perTxQuai: '20', dailyQuai: '1000' });
    expect(() => resolveMcpContext({ home, allowWrites: true, preset: 'degen', maxPerTx: '251' })).toThrow(/only lower/);
    expect(() => resolveMcpContext({ home, allowWrites: true })).toThrow(/requires explicit/);
    expect(() => resolveMcpContext({ home, preset: 'nope' })).toThrow(/Unknown --preset/);
  });
  it('a preset alone does not enable writes', () => {
    expect(resolveMcpContext({ home, preset: 'normal' }).allowWrites).toBe(false);
  });
  it('hartii_trader_limits shows the active preset and caps', async () => {
    const ctx = { ...resolveMcpContext({ home, preset: 'normal' }), traderReader: { limits: () => ({ ok: true, configured: true }) } };
    const tool = buildTools(ctx).find(t => t.name === 'hartii_trader_limits');
    expect(await tool.handler({})).toMatchObject({ ok: true, activePreset: { preset: 'normal', perTxQuai: '50', dailyQuai: '250', maxSlippageBps: 200 } });
  });
  it('write tools reject slippage above the preset ceiling and default to it', async () => {
    const ctx = { ...resolveMcpContext({ home, allowWrites: true, preset: 'conservative' }) };
    const buy = buildTools(ctx).find(t => t.name === 'hartii_buy');
    await expect(buy.handler({ token: '0x0010000000000000000000000000000000000002', quai: '1', slippage: '1.01' })).rejects.toThrow(/preset/);
    expect(buildMcpServer).toBeTypeOf('function');
  });
});
