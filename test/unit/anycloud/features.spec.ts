import { describe, expect, it } from 'vitest';

import { FEATURES, missingFeatures } from '../../../src/anycloud/features.js';

describe('feature detection', () => {
  const table = { ...FEATURES, 'release-1': '0.2.0', c26: '0.10.1' };

  it('compares versions numerically', () => {
    expect(missingFeatures('0.2.0', ['release-1'], table)).toEqual([]);
    expect(missingFeatures('0.10.0', ['release-1', 'c26'], table)).toEqual([
      'c26',
    ]);
    expect(missingFeatures('0.1.71', ['release-1'], table)).toEqual([
      'release-1',
    ]);
  });

  it('has release 1 from 0.1.72, and the seed, role connections and region lists from 0.1.74', () => {
    const later = ['c26', 'role-connections', 'c28', 'vm-job-regions'] as const;
    expect(missingFeatures('0.1.71', ['release-1'])).toEqual(['release-1']);
    expect(missingFeatures('0.1.73', ['release-1', ...later])).toEqual([
      ...later,
    ]);
    expect(missingFeatures('0.1.74', ['release-1', ...later])).toEqual([]);
  });

  it('counts a feature with no release yet as missing', () => {
    expect(
      missingFeatures('99.0.0', ['c28'], { ...table, c28: undefined }),
    ).toEqual(['c28']);
  });
});
