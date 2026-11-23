import { describe, expect, it } from 'vitest';

import {
  codeClass,
  planClasses,
  type CloudTarget,
} from '../../../src/runners/classes.js';
import { CATALOG, catalogs } from './fixtures.js';

const AWS: CloudTarget = {
  cloud: 'aws',
  region: 'us-east-2',
  credentials: 'bm-aws',
};
const GCP: CloudTarget = {
  cloud: 'gcp',
  region: 'us-central1',
  credentials: 'bm-gcp',
};
const AZURE: CloudTarget = {
  cloud: 'azure',
  region: 'westus2',
  credentials: 'bm-azure',
};
const catalog = catalogs();

describe('runner classes', () => {
  it('gives each size a spot, on-demand and KVM class of 4 GiB VM types', () => {
    const { classes, problems, noKvm, noGpu } = planClasses(
      [AWS],
      catalog,
      'aws',
    );
    expect(problems).toEqual([]);
    expect(noKvm).toEqual([]);
    expect(noGpu).toEqual([]);
    expect(classes.map((c) => `${c.label} ${c.code}`)).toEqual([
      ...['backmesh-2 a2', 'backmesh-4 a4', 'backmesh-8 a8', 'backmesh-16 ag'],
      ...['backmesh-od-2 b2', 'backmesh-od-4 b4'],
      ...['backmesh-od-8 b8', 'backmesh-od-16 bg'],
      ...['backmesh-kvm-2 k2', 'backmesh-kvm-4 k4'],
      ...['backmesh-kvm-8 k8', 'backmesh-kvm-16 kg'],
      ...['backmesh-kvm-od-2 l2', 'backmesh-kvm-od-4 l4'],
      ...['backmesh-kvm-od-8 l8', 'backmesh-kvm-od-16 lg'],
      ...['backmesh-gpu-t4 d4', 'backmesh-gpu-od-t4 e4'],
    ]);
    expect(classes[1]).toEqual({
      ...AWS,
      label: 'backmesh-4',
      code: 'a4',
      vcpus: 4,
      spot: true,
      kvm: false,
      // The new order drops m6i even though the catalog still offers it.
      vmTypes: ['m8i.xlarge', 'm7a.xlarge', 'm7i.xlarge', 'm6a.xlarge'],
      regions: ['us-east-2'],
    });
    // On demand tries m8a first; spot doesn't, since m8a's spot capacity is scarce.
    expect(classes.find((c) => c.label === 'backmesh-od-4')?.vmTypes).toEqual([
      'm8a.xlarge',
      'm8i.xlarge',
      'm7a.xlarge',
      'm7i.xlarge',
      'm6a.xlarge',
    ]);
    expect(classes.find((c) => c.label === 'backmesh-kvm-od-16')).toEqual(
      expect.objectContaining({
        spot: false,
        kvm: true,
        vmTypes: ['m8i.4xlarge', 'm7i.4xlarge'],
      }),
    );
  });

  it('gives the home cloud the plain labels and names every other cloud', () => {
    const { classes } = planClasses([AWS, AZURE], catalog, 'aws');
    const labels = classes.map((c) => c.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        'backmesh-4',
        'backmesh-od-4',
        'backmesh-azure-kvm-od-4',
      ]),
    );
    expect(labels.some((l) => l.startsWith('backmesh-aws-'))).toBe(false);
    // Adding a cloud renames none of the home cloud's labels.
    const alone = planClasses([AWS], catalog, 'aws').classes.map(
      (c) => c.label,
    );
    expect(labels).toEqual(expect.arrayContaining(alone));
    expect(classes.find((c) => c.label === 'backmesh-azure-2')?.code).toBe(
      'z2',
    );
  });

  it("adds the home cloud's backmesh-public-2 and -4 with --public-repos, spot and without KVM", () => {
    const { classes } = planClasses([AWS, GCP], catalog, 'aws', true);
    const shown = classes
      .filter((c) => c.public)
      .map(({ label, code, cloud, spot, kvm, vcpus }) => ({
        label,
        code,
        cloud,
        spot,
        kvm,
        vcpus,
      }));
    expect(shown).toEqual([
      {
        label: 'backmesh-public-2',
        code: 'c2',
        cloud: 'aws',
        spot: true,
        kvm: false,
        vcpus: 2,
      },
      {
        label: 'backmesh-public-4',
        code: 'c4',
        cloud: 'aws',
        spot: true,
        kvm: false,
        vcpus: 4,
      },
    ]);
    // Another listener's public runner still reads as its cloud's spot.
    expect(codeClass('c4')).toEqual({
      cloud: 'aws',
      spot: true,
      vcpus: 4,
      gpu: false,
    });
    expect(codeClass('x2')).toEqual({
      cloud: 'azure',
      spot: true,
      vcpus: 2,
      gpu: false,
    });
    expect(
      planClasses([AWS], catalog, 'aws').classes.some((c) => c.public),
    ).toBe(false);
  });

  it("gives GCP KVM classes on n2 only, since AMD's n2d doesn't nest", () => {
    const { classes, noKvm } = planClasses([GCP], catalog, 'gcp');
    expect(noKvm).toEqual([]);
    expect(classes[0]?.vmTypes).toEqual(['n2-standard-2', 'n2d-standard-2']);
    expect(classes.find((c) => c.label === 'backmesh-kvm-4')).toEqual(
      expect.objectContaining({ code: 'm4', vmTypes: ['n2-standard-4'] }),
    );
  });

  it("gives Azure's backmesh-4 all three families, but its KVM twin only as_v5 and s_v5, since ads_v5 doesn't nest", () => {
    const { classes } = planClasses([AZURE], catalog, 'azure');
    expect(classes.find((c) => c.label === 'backmesh-4')).toEqual(
      expect.objectContaining({
        vmTypes: ['Standard_D4ads_v5', 'Standard_D4as_v5', 'Standard_D4s_v5'],
      }),
    );
    expect(classes.find((c) => c.label === 'backmesh-kvm-4')).toEqual(
      expect.objectContaining({
        vmTypes: ['Standard_D4as_v5', 'Standard_D4s_v5'],
      }),
    );
  });

  it('keeps only the KVM types the region nests, and drops a size with none', () => {
    const flat = catalogs({
      aws: CATALOG.aws.map((type) =>
        type.vmType === 'm8i.large' || type.vmType.startsWith('m7i.')
          ? { ...type, capabilities: { nestedVirtualization: false } }
          : type,
      ),
    });
    const { classes } = planClasses([AWS], flat, 'aws');
    const kvm = classes.filter((c) => c.kvm && c.spot);
    expect(kvm.map((c) => [c.vcpus, c.vmTypes])).toEqual([
      [4, ['m8i.xlarge']],
      [8, ['m8i.2xlarge']],
      [16, ['m8i.4xlarge']],
    ]);
  });

  it('keeps an on-demand class in a region without m8a, on the types after it', () => {
    const noM8a = CATALOG.aws.filter((type) => !type.vmType.startsWith('m8a.'));
    const { classes, problems } = planClasses(
      [AWS],
      new Map([
        [
          'aws',
          new Map([
            ['us-east-2', CATALOG.aws],
            ['us-west-2', noM8a],
          ]),
        ],
      ]),
      'aws',
    );
    expect(problems).toEqual([]);
    expect(classes.find((c) => c.label === 'backmesh-od-4')?.regions).toEqual([
      'us-east-2',
      'us-west-2',
    ]);
    // With no region offering it, install names it like any other type.
    expect(
      planClasses([AWS], catalogs({ aws: noM8a }), 'aws').problems,
    ).toEqual(
      ['large', 'xlarge', '2xlarge', '4xlarge'].map(
        (size) => `m8a.${size} isn't offered in aws us-east-2`,
      ),
    );
  });

  it('names each type a region lacks or offers in the wrong shape', () => {
    const odd = catalogs({
      aws: CATALOG.aws
        .filter((type) => type.vmType !== 'm7a.large')
        .map((type) =>
          type.vmType === 'm6a.xlarge' ? { ...type, memoryGiB: 8 } : type,
        ),
    });
    expect(planClasses([AWS], odd, 'aws').problems).toEqual([
      "m7a.large isn't offered in aws us-east-2",
      'm6a.xlarge is 4 vCPU / 8 GiB, not a 4 vCPU / 16 GiB CPU type',
    ]);
  });

  it('gives each class the regions that offer its types, and KVM the ones that nest', () => {
    const flat = CATALOG.aws.map((type) =>
      type.vmType.startsWith('m7i.') || type.vmType.startsWith('m8i.')
        ? { ...type, capabilities: { nestedVirtualization: false } }
        : type,
    );
    const west = flat.filter((type) => !type.vmType.startsWith('m6a.'));
    const regions = new Map([
      ['us-east-2', CATALOG.aws],
      ['us-west-2', west],
      ['us-east-1', flat],
    ]);
    const { classes, problems } = planClasses(
      [AWS],
      new Map([['aws', regions]]),
      'aws',
    );
    expect(problems).toEqual([]);
    const four = classes.find((c) => c.label === 'backmesh-4')!;
    expect(four.regions).toEqual(['us-east-2', 'us-west-2', 'us-east-1']);
    expect(
      classes.find((c) => c.label === 'backmesh-kvm-od-4')?.regions,
    ).toEqual(['us-east-2']);
  });

  it("gives AWS and Azure a T4 class on spot and on demand, as GitHub's GPU runner", () => {
    const { classes, noGpu } = planClasses([AWS, AZURE, GCP], catalog, 'aws');
    const gpu = classes.filter((c) => c.gpu);
    expect(gpu).toEqual([
      {
        ...AWS,
        label: 'backmesh-gpu-t4',
        code: 'd4',
        vcpus: 4,
        spot: true,
        kvm: false,
        // The same T4 on 8 vCPUs next, so a spot refusal fails over at
        // once instead of backing off.
        vmTypes: ['g4dn.xlarge', 'g4dn.2xlarge'],
        regions: ['us-east-2'],
        gpu: 'T4',
      },
      expect.objectContaining({ label: 'backmesh-gpu-od-t4', code: 'e4' }),
      expect.objectContaining({
        label: 'backmesh-azure-gpu-t4',
        code: 't4',
        cloud: 'azure',
        vmTypes: ['Standard_NC4as_T4_v3'],
      }),
      expect.objectContaining({
        label: 'backmesh-azure-gpu-od-t4',
        code: 'u4',
      }),
    ]);
    // anycloud can't launch a T4 on GCP yet: no GPU labels there.
    expect(noGpu).toEqual([GCP]);
    // Another listener's GPU runner holds its GPU quota, not the CPU one.
    expect(codeClass('d4')).toEqual({
      cloud: 'aws',
      spot: true,
      vcpus: 4,
      gpu: true,
    });
    expect(codeClass('u4')).toMatchObject({ spot: false, gpu: true });
    // --public-repos never makes a GPU label public.
    expect(
      planClasses([AWS], catalog, 'aws', true).classes.filter((c) => c.public),
    ).toHaveLength(2);
  });

  it('keeps a GPU class to the regions whose catalog offers its type, and drops a T4 in the wrong shape', () => {
    const t4 = CATALOG.azure.find((t) => t.vmType === 'Standard_NC4as_T4_v3')!;
    // Azure's catalog offers it only where anycloud's GPU image is, so
    // westus has none.
    const regions = new Map([
      ['westus2', CATALOG.azure],
      ['westus', CATALOG.azure.filter((t) => t !== t4)],
      ['eastus', CATALOG.azure],
    ]);
    const { classes } = planClasses(
      [AZURE],
      new Map([['azure', regions]]),
      'azure',
    );
    expect(classes.find((c) => c.label === 'backmesh-gpu-t4')?.regions).toEqual(
      ['westus2', 'eastus'],
    );
    const twoGpus = catalogs({
      azure: CATALOG.azure.map((t) =>
        t === t4 ? { ...t, accelerators: [{ name: 'T4', count: 2 }] } : t,
      ),
    });
    const plan = planClasses([AZURE], twoGpus, 'azure');
    expect(plan.classes.some((c) => c.gpu)).toBe(false);
    expect(plan.noGpu).toEqual([AZURE]);
    expect(plan.problems).toEqual([]);
  });

  it('names a listed region that offers none of the types', () => {
    const regions = new Map([
      ['us-east-2', CATALOG.aws],
      ['us-esat-1', []],
    ]);
    expect(
      planClasses([AWS], new Map([['aws', regions]]), 'aws').problems,
    ).toEqual(["aws us-esat-1 offers none of the runners' VM types"]);
  });
});
