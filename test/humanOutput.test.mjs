/* eslint-disable no-control-regex -- asserting that terminal control characters are stripped */
import { describe, it, expect } from 'vitest';
import { formatHumanResult } from '../src/humanOutput.js';
describe('human command output', () => {
  it('converts indexed QUAI wei marks to QUAI while preserving token balances as base units', () => {
    const text = formatHumanResult({wallet:'fixture',network:'mainnet',quai:'100.0',holdings:[{symbol:'TOK',balance:'1000000000000000000',valueQuai:'3000000000000000000',priceSource:'curve'}]});
    expect(text).toContain('3.0');expect(text).not.toContain('3000000000000000000');expect(text).toContain('1000000000000000000');
  });
  it.each([['0','0.0'],[null,'—'],['','—'],[' ','—'],['bad','—'],['-1','—'],['0x10','—'],['0001','—']])('keeps zero distinct from an unavailable or malformed balance mark (%s)',(value,expected)=>{
    const text=formatHumanResult({wallet:'fixture',network:'mainnet',quai:'1.0',holdings:[{symbol:'MARK',balance:'9',valueQuai:value,priceSource:'curve'}]});
    expect(text).toContain(expected);if(expected==='—')expect(text).not.toContain('0.0');
  });
  it('aligns token columns and preserves exact price strings', () => {
    const text = formatHumanResult({ items: [{ symbol: 'HRTI', address: '0xabc', lastPriceWei: '1000000000000001', holderCount: 0, status: 'active' }] });
    expect(text).toContain('0.001000000000000001');
    expect(text).toContain('SYMBOL'); expect(text).toContain('HOLDERS');
    expect(text).not.toContain('{');
  });
  it('shows unknown holdings as unavailable rather than zero', () => {
    const text = formatHumanResult({ wallet: '0xabc', network: 'orchard', quai: '12.000001', holdings: null, holdingsError: 'mainnet only' });
    expect(text).toContain('12.000001 QUAI'); expect(text).toContain('mainnet only');
    expect(text).not.toContain('No token holdings');
  });
  it('distinguishes aborts from success and exposes transaction explorer links', () => {
    expect(formatHumanResult({ ok: false, aborted: true, summary: { action: 'Send' } })).toContain('Aborted');
    expect(formatHumanResult({ ok: true, quaiscanUrl: 'https://quaiscan.io/tx/0x123' })).toContain('https://quaiscan.io/tx/0x123');
  });
  it('removes control sequences from names and errors', () => {
    const text = formatHumanResult({ items: [{ symbol: 'X\x1b]52;c;c2VjcmV0\x07\rFAKE', address: '0xabc' }] });
    expect(text).not.toMatch(/[\x00-\x09\x0b-\x1f]/);
    expect(text).not.toContain('c2VjcmV0');
  });
  it('shows check failures clearly and respects demo labels', () => {
    expect(formatHumanResult({ demo: true, ok: false, checks: [{ name: 'rpc', ok: false, detail: 'offline' }] })).toContain('FAIL');
    expect(formatHumanResult({ demo: true, summary: { action: 'Buy' } })).toContain('DEMO');
  });
});
