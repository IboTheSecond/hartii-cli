// packages/hartii-cli/test/address.test.mjs
import { describe, it, expect } from 'vitest';
import { checksumAddress, isCyprus1QuaiAddress, assertCyprus1QuaiAddress, shortAddress, AddressError } from '../src/address.js';

// Real Cyprus-1 Quai-ledger address (QuaiWallV2, public on quaiscan — see AGENTS.md "Wall of Blocks").
const CYPRUS1_ADDRESS = '0x0003b264Bc457BF2dc6F4De80c6C714079febB64';
const CYPRUS1_LOWERCASE = CYPRUS1_ADDRESS.toLowerCase();
// A well-formed Quai address in a non-Cyprus-1 zone (same fixture agent-mcp's own config.test.mjs uses).
const OTHER_ZONE_ADDRESS = '0x123E11A27724152e016791A5F8f596a98B6b8415';
// A Qi-ledger address: second byte's MSB set (see memory note "Quai vs Qi address bit").
const QI_ADDRESS = '0x0080000000000000000000000000000000000001';

describe('checksumAddress', () => {
  it('checksums a lowercase address', () => {
    expect(checksumAddress(CYPRUS1_LOWERCASE)).toBe(CYPRUS1_ADDRESS);
  });

  it('throws AddressError for a malformed address', () => {
    expect(() => checksumAddress('not-an-address')).toThrow(AddressError);
  });
});

describe('isCyprus1QuaiAddress', () => {
  it('is true for a real Cyprus-1 Quai address', () => {
    expect(isCyprus1QuaiAddress(CYPRUS1_ADDRESS)).toBe(true);
  });

  it('is false for a different-zone Quai address', () => {
    expect(isCyprus1QuaiAddress(OTHER_ZONE_ADDRESS)).toBe(false);
  });

  it('is false for a Qi-ledger address', () => {
    expect(isCyprus1QuaiAddress(QI_ADDRESS)).toBe(false);
  });

  it('never throws on malformed input', () => {
    expect(isCyprus1QuaiAddress('garbage')).toBe(false);
    expect(isCyprus1QuaiAddress(undefined)).toBe(false);
  });
});

describe('assertCyprus1QuaiAddress', () => {
  it('returns the checksummed address when valid', () => {
    expect(assertCyprus1QuaiAddress(CYPRUS1_LOWERCASE)).toBe(CYPRUS1_ADDRESS);
  });

  it('rejects a Qi-ledger address with a Qi-specific message', () => {
    expect(() => assertCyprus1QuaiAddress(QI_ADDRESS)).toThrow(/Qi-ledger/);
  });

  it('tells a Qi-ledger address to use a Quai address or wrap to WQI', () => {
    expect(() => assertCyprus1QuaiAddress(QI_ADDRESS)).toThrow(/use a Quai address \(starts 0x00…\), or wrap your Qi to WQI first/);
  });

  it('rejects a non-Cyprus-1 Quai address with a zone-specific message', () => {
    expect(() => assertCyprus1QuaiAddress(OTHER_ZONE_ADDRESS)).toThrow(/Cyprus-1/);
  });

  it('rejects a malformed address', () => {
    expect(() => assertCyprus1QuaiAddress('nope')).toThrow(AddressError);
  });
});

describe('shortAddress', () => {
  it('shortens a long address', () => {
    expect(shortAddress(CYPRUS1_ADDRESS)).toBe('0x0003…bB64');
  });

  it('returns short strings unchanged', () => {
    expect(shortAddress('0xabc')).toBe('0xabc');
  });
});
