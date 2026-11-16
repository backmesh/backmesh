import { describe, expect, it } from 'vitest';

import { planClasses } from '../../../src/runners/classes.js';
import { classRate, formatRate } from '../../../src/runners/rate.js';
import { awsInRegions, CATALOG, catalogs } from './fixtures.js';

const TARGETS = [
  { cloud: 'aws', region: 'us-east-2', credentials: 'bm-aws' },
  { cloud: 'gcp', region: 'us-central1', credentials: 'bm-gcp' },
  { cloud: 'azure', region: 'westus2', credentials: 'bm-azure' },
] as const;

describe('class rate', () => {
  it.each([
    [0, 'spot', { low: 0.05, high: 0.07 }],
    [0, 'on demand', { low: 0.17, high: 0.23 }],
    [1, 'spot', { low: 0.09, high: 0.12 }],
    [2, 'on demand', { low: 0.17, high: 0.23 }],
  ] as const)(
    "ranges target %i's backmesh-4 VM over its types on %s",
    (i, kind, rate) => {
      const target = TARGETS[i];
      const details = CATALOG[target.cloud];
      const { classes } = planClasses([target], catalogs(), target.cloud);
      const route = classes.find(
        (c) => c.vcpus === 4 && !c.kvm && c.spot === (kind === 'spot'),
      )!;
      expect(classRate(route, details)).toEqual(rate);
    },
  );

  it('prices the default class per cloud, and says when a region is unpriced', () => {
    const { classes } = planClasses([TARGETS[0]], catalogs(), 'aws');
    expect(formatRate(classes, CATALOG.aws)).toBe(
      'aws us-east-2: no VM while idle; while its job runs, a backmesh-4 VM costs about $0.05–0.07 an hour on spot and $0.17–0.23 on demand, plus its disk, and the other sizes scale with their vCPUs',
    );
    const elsewhere = classes.map((c) => ({ ...c, regions: ['eu-west-1'] }));
    expect(formatRate(elsewhere, CATALOG.aws)).toContain(
      'an unpriced amount an hour on spot',
    );
  });

  it("ranges over every region's prices and names the regions", () => {
    const home = awsInRegions({ 'us-west-2': 2 });
    const { classes } = planClasses(
      [TARGETS[0]],
      new Map([
        [
          'aws',
          new Map([
            ['us-east-2', home],
            ['us-west-2', home],
          ]),
        ],
      ]),
      'aws',
    );
    expect(formatRate(classes, home)).toMatch(
      /^aws us-east-2 and us-west-2: .* about \$0\.05–0\.14 an hour on spot and \$0\.17–0\.23 on demand/,
    );
  });
});
