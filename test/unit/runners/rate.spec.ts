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
    [0, 'on demand', { low: 0.17, high: 0.24 }],
    [1, 'spot', { low: 0.08, high: 0.12 }],
    [2, 'on demand', { low: 0.17, high: 0.23 }],
  ] as const)(
    "ranges target %i's backmesh-ubuntu-2404-4vcpu VM over its types on %s",
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

  it('prices the default class, the largest high-memory class, the GPU class and the arm64 class per cloud, and says when a region is unpriced', () => {
    const { classes } = planClasses([TARGETS[0]], catalogs(), 'aws');
    expect(formatRate(classes, CATALOG.aws)).toEqual([
      'aws us-east-2: no VM while idle; while its job runs, a backmesh-ubuntu-2404-4vcpu VM costs about $0.05–0.07 an hour on spot and $0.17–0.24 on demand, plus its disk, and the other sizes scale with their vCPUs',
      'aws us-east-2: a backmesh-ubuntu-2404-highmem-16vcpu VM (128 GiB: r8a.4xlarge, r8i.4xlarge, r7a.4xlarge, r7i.4xlarge, r6a.4xlarge) costs about $0.31–0.46 an hour on spot and $0.91–1.28 on demand, plus its disk, and the smaller ones scale with their vCPUs',
      'aws us-east-2: a backmesh-ubuntu-2404-gpu-t4 VM (g4dn.xlarge, g4dn.2xlarge) costs about $0.27–0.37 an hour on spot and $0.53–0.75 on demand, plus its disk',
      'aws us-east-2: a backmesh-ubuntu-2404-arm-4vcpu VM (arm64: m8g.xlarge, m7g.xlarge) costs about $0.05–0.06 an hour on spot and $0.16–0.18 on demand, plus its disk, and the other sizes scale with their vCPUs',
    ]);
    const elsewhere = classes.map((c) => ({ ...c, regions: ['eu-west-1'] }));
    expect(formatRate(elsewhere, CATALOG.aws)[0]).toContain(
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
    expect(formatRate(classes, home)[0]).toMatch(
      /^aws us-east-2 and us-west-2: .* about \$0\.05–0\.14 an hour on spot and \$0\.17–0\.24 on demand/,
    );
  });
});
