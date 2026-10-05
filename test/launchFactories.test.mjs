import { describe, it, expect } from 'vitest';
import { launchFactories } from '../src/liveAddresses.js';

describe('launchFactories', () => {
  it('includes the pinned V1 factory so V1-era curves (e.g. QAXE) still verify', () => {
    const list = launchFactories('mainnet').map((a) => a.toLowerCase());
    expect(list).toContain('0x001af1bbb40807fcb99c9eeaa49df5e91e7efd42');
    expect(list.length).toBeGreaterThanOrEqual(3);
  });
  it('returns no factories off mainnet', () => {
    expect(launchFactories('orchard')).toEqual([]);
  });
});
