import { describe, it, expect } from 'vitest';
import { renderReview, reviewKind } from '../src/review.js';
import { stripAnsi } from '../src/output.js';

const TO = '0x0000000000000000000000000000000000000d04';
const base = {
  network: 'mainnet', chainId: 9, from: '0x0000000000000000000000000000000000000d01', to: TO,
  gasLimit: '46800', gasPriceWei: '44648016312494', estimatedFeeQuai: '1.741272636187266', nonce: 4,
  dataDigest: '0xabc', dataSelector: 'none', dataBytes: 0, guardedQuai: '2.5', guardedWithFeeQuai: '4.241272636187266',
};
const send = { ...base, action: 'Send QUAI', valueQuai: '2.5' };
const plain = (s, o) => stripAnsi(renderReview(s, { color: false, ...o }));

describe('renderReview', () => {
  it('leads with one plain sentence, then fee and total, then the confirm line', () => {
    const text = plain(send);
    const lines = text.split('\n').filter(Boolean);
    expect(lines[0]).toContain('Send QUAI');
    expect(text).toMatch(/You send 2\.5 QUAI to 0x/);
    expect(text.indexOf('You send')).toBeLessThan(text.indexOf('Network fee'));
    expect(text.indexOf('Network fee')).toBeLessThan(text.indexOf('Total in QUAI'));
    expect(text).toMatch(/Total in QUAI\s+up to 4\.2413 QUAI/);
    expect(text).toMatch(/Network fee\s+up to 1\.7413 QUAI/);
    expect(text.trim().endsWith('Nothing is sent until you confirm.')).toBe(true);
  });
  it('shows the full recipient address in groups, never only an abbreviation', () => {
    const text = plain(send);
    expect(text.replace(/\s/g, '')).toContain(TO.slice(2).toLowerCase().replace(/./g, (c) => c).replace(/d04$/, ''));
    expect(text).toMatch(/To\s+0x([0-9a-fA-F]{4} ){9}[0-9a-fA-F]{4}/);
  });
  it('keeps raw wei and base units out of the default review', () => {
    const text = plain(send);
    expect(text).not.toContain('44648016312494');
    expect(text).not.toContain('dataDigest');
    expect(text).not.toContain('gasLimit');
  });
  it('--details adds the technical fields as an aligned block, with gas in gwei', () => {
    const text = plain(send, { details: true });
    expect(text).toContain('Details');
    expect(text).toMatch(/Nonce\s+4/);
    expect(text).toMatch(/Fee estimate\s+1\.741272636187266 QUAI/);
    expect(text).toMatch(/Gas price\s+44,648\.016312494 gwei/);
    expect(text).toMatch(/Data digest\s+0xabc/);
  });
  it('renders warnings after the totals, danger carrying a word, ordered danger first', () => {
    const text = plain({ ...send, warnings: [
      { level: 'info', code: 'new-recipient', text: 'You have not sent to this address before.' },
      { level: 'danger', code: 'high-slippage', text: 'Slippage above 10% can lose most of the value.' },
    ] });
    expect(text.indexOf('Total in QUAI')).toBeLessThan(text.indexOf('Warning:'));
    expect(text.indexOf('Warning:')).toBeLessThan(text.indexOf('Note:'));
    expect(text.indexOf('Note:')).toBeLessThan(text.indexOf('Nothing is sent'));
  });
  it('uses red only for danger and none at all without colour', () => {
    const coloured = renderReview({ ...send, warnings: [{ level: 'danger', code: 'x', text: 'Bad.' }, { level: 'warn', code: 'y', text: 'Hmm.' }] }, { color: true, depth: 24 });
    expect(coloured).toContain('38;2;240;70;92'); // #F0465C
    const calm = renderReview(send, { color: true, depth: 24 });
    expect(calm).not.toContain('38;2;240;70;92');
    expect(renderReview(send, { color: false })).not.toMatch(/\u001b/);
  });
  it('falls back to 256 and 16 colours', () => {
    expect(renderReview(send, { color: true, depth: 8 })).toMatch(/\u001b\[38;5;\d+m/);
    expect(renderReview(send, { color: true, depth: 4 })).not.toContain('38;');
  });
  it.each([
    [{ ...base, action: 'Send TOK (0x0000000000000000000000000000000000000d02)', tokenAmount: '10', token: 'TOK (0x0000000000000000000000000000000000000d02)', recipient: TO }, 'send', /You send 10 TOK to/],
    [{ ...base, action: 'Buy TOK (0x0000000000000000000000000000000000000d02)', token: 'TOK (0x0000000000000000000000000000000000000d02)', quaiIn: '5', expectedTokensOut: '267444.05', minTokensOut: '259420.7', slippageBps: '300' }, 'buy', /You buy about 267,444\.05 TOK for 5 QUAI/],
    [{ ...base, action: 'Sell TOK', token: 'TOK', tokensIn: '1000', expectedQuaiOut: '1.2', minQuaiOut: '1.1', slippageBps: '300' }, 'sell', /You sell 1,000 TOK for about 1\.2 QUAI/],
    [{ ...base, action: 'Swap A -> B', tokenIn: 'A', tokenOut: 'B', amountIn: '3', expectedOut: '9', minOut: '8.7' }, 'swap', /You swap 3 A for about 9 B/],
    [{ ...base, action: 'Approve TOK for curve', token: 'TOK' }, 'approve', /You let curve use your TOK\. This step moves no funds/],
    [{ ...base, action: 'Airdrop TOK (batch 1/1)', recipients: '120', total: '5000', asset: 'TOK' }, 'airdrop', /You send 5,000 TOK to 120 people/],
    [{ ...base, action: 'OTC offer TOK', offering: '100 TOK', wantedQuai: '50' }, 'otc-offer', /You offer 100 TOK for 50 QUAI/],
    [{ ...base, action: 'OTC fill #3', receiving: '100 TOK', totalDueQuai: '51' }, 'otc-fill', /You pay 51 QUAI and receive 100 TOK/],
    [{ ...base, action: 'Claim TOK', claiming: '12 TOK' }, 'claim', /You claim 12 TOK/],
    [{ ...base, action: 'Wall engrave', message: 'hello', maxSentQuai: '1' }, 'wall', /You engrave "hello" on the Hartii wall for up to 1 QUAI/],
    [{ ...base, action: 'Wrap QUAI', amountIn: '2' }, 'wrap', /You wrap 2 QUAI into WQUAI/],
  ])('describes %# in a plain first sentence', (summary, kind, re) => {
    expect(reviewKind(summary)).toBe(kind);
    expect(plain(summary)).toMatch(re);
  });
  it('shows a third-party token symbol only together with its contract address', () => {
    const text = plain({ ...base, action: 'Buy TOK (0x0000000000000000000000000000000000000d02)', token: 'TOK (0x0000000000000000000000000000000000000d02)', quaiIn: '5', expectedTokensOut: '10' });
    expect(text).toMatch(/Token\s+TOK\s+0x([0-9a-fA-F]{4} ){9}[0-9a-fA-F]{4}/);
  });
  it('strips terminal control sequences from third-party text', () => {
    const text = renderReview({ ...base, action: 'Claim X', claiming: '1 EVIL\u001b]52;c;c2VjcmV0\u0007', warnings: [{ level: 'warn', code: 'a', text: 'ok\u001b[2J' }] }, { color: false });
    expect(text).not.toContain('c2VjcmV0');
    expect(text).not.toContain('\u001b');
  });
  it('is complete with an empty summary and stays within width at 60/80/120', () => {
    expect(() => renderReview({}, { color: false })).not.toThrow();
    for (const width of [60, 80, 120]) {
      const text = plain({ ...send, warnings: [{ level: 'danger', code: 'c', text: 'A long sentence about danger that must wrap cleanly inside the terminal width without cutting words in half.' }] }, { width, details: true });
      for (const line of text.split('\n')) expect(Array.from(line).length).toBeLessThanOrEqual(width);
    }
  });
  it('dry run says preview, terse stays on one line', () => {
    expect(plain(send, { dryRun: true })).toContain('This is a preview. Nothing is sent.');
    const terse = plain(send, { terse: true });
    expect(terse.split('\n')).toHaveLength(1);
    expect(terse).toContain('You send 2.5 QUAI');
  });
  it('does not mutate the summary', () => {
    const copy = structuredClone(send);
    renderReview(send, { details: true });
    expect(send).toEqual(copy);
  });
});
