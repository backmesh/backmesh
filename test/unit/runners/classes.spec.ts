import { describe, expect, it } from 'vitest';

import {
  codeClass,
  planClasses,
  spotCapacity,
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
    const { classes, problems, noKvm, noGpu, noArm } = planClasses(
      [AWS],
      catalog,
      'aws',
    );
    expect(problems).toEqual([]);
    expect(noKvm).toEqual([]);
    expect(noGpu).toEqual([]);
    expect(noArm).toEqual([]);
    expect(classes.map((c) => `${c.label} ${c.code}`)).toEqual([
      ...[
        'backmesh-ubuntu-2404-2vcpu a2',
        'backmesh-ubuntu-2404-4vcpu a4',
        'backmesh-ubuntu-2404-8vcpu a8',
        'backmesh-ubuntu-2404-16vcpu ag',
      ],
      ...[
        'backmesh-ubuntu-2404-od-2vcpu b2',
        'backmesh-ubuntu-2404-od-4vcpu b4',
      ],
      ...[
        'backmesh-ubuntu-2404-od-8vcpu b8',
        'backmesh-ubuntu-2404-od-16vcpu bg',
      ],
      ...[
        'backmesh-ubuntu-2404-kvm-2vcpu k2',
        'backmesh-ubuntu-2404-kvm-4vcpu k4',
      ],
      ...[
        'backmesh-ubuntu-2404-kvm-8vcpu k8',
        'backmesh-ubuntu-2404-kvm-16vcpu kg',
      ],
      ...[
        'backmesh-ubuntu-2404-kvm-od-2vcpu l2',
        'backmesh-ubuntu-2404-kvm-od-4vcpu l4',
      ],
      ...[
        'backmesh-ubuntu-2404-kvm-od-8vcpu l8',
        'backmesh-ubuntu-2404-kvm-od-16vcpu lg',
      ],
      ...[
        'backmesh-ubuntu-2404-gpu-t4 d4',
        'backmesh-ubuntu-2404-gpu-od-t4 e4',
      ],
      ...[
        'backmesh-ubuntu-2404-highmem-2vcpu ah',
        'backmesh-ubuntu-2404-highmem-4vcpu ai',
        'backmesh-ubuntu-2404-highmem-8vcpu aj',
        'backmesh-ubuntu-2404-highmem-16vcpu ak',
      ],
      ...[
        'backmesh-ubuntu-2404-highmem-od-2vcpu bh',
        'backmesh-ubuntu-2404-highmem-od-4vcpu bi',
        'backmesh-ubuntu-2404-highmem-od-8vcpu bj',
        'backmesh-ubuntu-2404-highmem-od-16vcpu bk',
      ],
      ...[
        'backmesh-ubuntu-2404-arm-2vcpu f2',
        'backmesh-ubuntu-2404-arm-4vcpu f4',
      ],
      ...[
        'backmesh-ubuntu-2404-arm-8vcpu f8',
        'backmesh-ubuntu-2404-arm-16vcpu fg',
      ],
      ...[
        'backmesh-ubuntu-2404-arm-od-2vcpu p2',
        'backmesh-ubuntu-2404-arm-od-4vcpu p4',
      ],
      ...[
        'backmesh-ubuntu-2404-arm-od-8vcpu p8',
        'backmesh-ubuntu-2404-arm-od-16vcpu pg',
      ],
      ...[
        'backmesh-ubuntu-2404-arm-highmem-2vcpu fh',
        'backmesh-ubuntu-2404-arm-highmem-4vcpu fi',
      ],
      ...[
        'backmesh-ubuntu-2404-arm-highmem-8vcpu fj',
        'backmesh-ubuntu-2404-arm-highmem-16vcpu fk',
      ],
      ...[
        'backmesh-ubuntu-2404-arm-highmem-od-2vcpu ph',
        'backmesh-ubuntu-2404-arm-highmem-od-4vcpu pi',
      ],
      ...[
        'backmesh-ubuntu-2404-arm-highmem-od-8vcpu pj',
        'backmesh-ubuntu-2404-arm-highmem-od-16vcpu pk',
      ],
    ]);
    expect(classes[1]).toEqual({
      ...AWS,
      label: 'backmesh-ubuntu-2404-4vcpu',
      code: 'a4',
      vcpus: 4,
      spot: true,
      kvm: false,
      // m8a first; the order drops m6i even though the catalog still offers it.
      vmTypes: [
        'm8a.xlarge',
        'm8i.xlarge',
        'm7a.xlarge',
        'm7i.xlarge',
        'm6a.xlarge',
      ],
      regions: ['us-east-2'],
    });
    // On demand tries the same types.
    expect(
      classes.find((c) => c.label === 'backmesh-ubuntu-2404-od-4vcpu')?.vmTypes,
    ).toEqual(classes[1]!.vmTypes);
    expect(
      classes.find((c) => c.label === 'backmesh-ubuntu-2404-kvm-od-16vcpu'),
    ).toEqual(
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
        'backmesh-ubuntu-2404-4vcpu',
        'backmesh-ubuntu-2404-od-4vcpu',
        'backmesh-azure-ubuntu-2404-kvm-od-4vcpu',
      ]),
    );
    expect(labels.some((l) => l.startsWith('backmesh-aws-'))).toBe(false);
    // Adding a cloud renames none of the home cloud's labels.
    const alone = planClasses([AWS], catalog, 'aws').classes.map(
      (c) => c.label,
    );
    expect(labels).toEqual(expect.arrayContaining(alone));
    expect(
      classes.find((c) => c.label === 'backmesh-azure-ubuntu-2404-2vcpu')?.code,
    ).toBe('z2');
  });

  it("adds the home cloud's backmesh-ubuntu-2404-public-2vcpu and -4 with --public-repos, spot and without KVM", () => {
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
        label: 'backmesh-ubuntu-2404-public-2vcpu',
        code: 'c2',
        cloud: 'aws',
        spot: true,
        kvm: false,
        vcpus: 2,
      },
      {
        label: 'backmesh-ubuntu-2404-public-4vcpu',
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
    expect(
      classes.find((c) => c.label === 'backmesh-ubuntu-2404-kvm-4vcpu'),
    ).toEqual(
      expect.objectContaining({ code: 'm4', vmTypes: ['n2-standard-4'] }),
    );
  });

  it("tries c4d, then c3d, before n2 and n2d on GCP's on-demand classes only", () => {
    const { classes, problems } = planClasses([GCP], catalog, 'gcp', true);
    // c4d's 3.875 GiB a vCPU passes for 4 GiB.
    expect(problems).toEqual([]);
    const types = (label: string) =>
      classes.find((c) => c.label === label)?.vmTypes;
    // c4d-standard-2 wasn't measured, and c3d has no 2-vCPU size.
    expect(types('backmesh-ubuntu-2404-od-2vcpu')).toEqual([
      'n2-standard-2',
      'n2d-standard-2',
    ]);
    expect(types('backmesh-ubuntu-2404-od-16vcpu')).toEqual([
      'c4d-standard-16',
      'c3d-standard-16',
      'n2-standard-16',
      'n2d-standard-16',
    ]);
    expect(types('backmesh-ubuntu-2404-4vcpu')).toEqual([
      'n2-standard-4',
      'n2d-standard-4',
    ]);
    expect(types('backmesh-ubuntu-2404-public-4vcpu')).toEqual([
      'n2-standard-4',
      'n2d-standard-4',
    ]);
    // Neither nests.
    expect(types('backmesh-ubuntu-2404-kvm-od-4vcpu')).toEqual([
      'n2-standard-4',
    ]);
    // AWS's and Azure's on-demand classes keep their spot types.
    const aws = planClasses([AWS], catalog, 'aws').classes;
    expect(
      aws.find((c) => c.label === 'backmesh-ubuntu-2404-od-4vcpu')?.vmTypes,
    ).toEqual(
      aws.find((c) => c.label === 'backmesh-ubuntu-2404-4vcpu')?.vmTypes,
    );
  });

  it("gives Azure's backmesh-ubuntu-2404-4vcpu all three families, but its KVM twin only as_v5 and s_v5, since ads_v5 doesn't nest", () => {
    const { classes } = planClasses([AZURE], catalog, 'azure');
    expect(
      classes.find((c) => c.label === 'backmesh-ubuntu-2404-4vcpu'),
    ).toEqual(
      expect.objectContaining({
        vmTypes: ['Standard_D4ads_v5', 'Standard_D4as_v5', 'Standard_D4s_v5'],
      }),
    );
    expect(
      classes.find((c) => c.label === 'backmesh-ubuntu-2404-kvm-4vcpu'),
    ).toEqual(
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

  it('keeps a class in a region without m8a, on the types after it', () => {
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
    for (const label of [
      'backmesh-ubuntu-2404-4vcpu',
      'backmesh-ubuntu-2404-od-4vcpu',
    ]) {
      expect(classes.find((c) => c.label === label)?.regions).toEqual([
        'us-east-2',
        'us-west-2',
      ]);
    }
    // With no region offering it, install names it like any other type.
    expect(
      planClasses([AWS], catalogs({ aws: noM8a }), 'aws').problems,
    ).toEqual(
      ['large', 'xlarge', '2xlarge', '4xlarge'].map(
        (size) => `m8a.${size} isn't offered in aws us-east-2`,
      ),
    );
  });

  it("gives each size a high-memory class of 8 GiB types on spot and on demand, each cloud's memory-optimized twin of its general families", () => {
    const { classes, problems } = planClasses(
      [AWS, GCP, AZURE],
      catalog,
      'gcp',
    );
    expect(problems).toEqual([]);
    const highmem = classes.filter((c) => c.highmem && !c.arm);
    expect(
      highmem
        .filter((c) => c.vcpus === 16)
        .map(({ label, code, spot, vmTypes }) => [label, code, spot, vmTypes]),
    ).toEqual([
      [
        'backmesh-aws-ubuntu-2404-highmem-16vcpu',
        'ak',
        true,
        ['r8a', 'r8i', 'r7a', 'r7i', 'r6a'].map((f) => `${f}.4xlarge`),
      ],
      [
        'backmesh-aws-ubuntu-2404-highmem-od-16vcpu',
        'bk',
        false,
        ['r8a', 'r8i', 'r7a', 'r7i', 'r6a'].map((f) => `${f}.4xlarge`),
      ],
      [
        'backmesh-ubuntu-2404-highmem-16vcpu',
        'gk',
        true,
        ['n2-highmem-16', 'n2d-highmem-16'],
      ],
      [
        'backmesh-ubuntu-2404-highmem-od-16vcpu',
        'hk',
        false,
        ['n2-highmem-16', 'n2d-highmem-16'],
      ],
      [
        'backmesh-azure-ubuntu-2404-highmem-16vcpu',
        'zk',
        true,
        ['Standard_E16ads_v5', 'Standard_E16as_v5', 'Standard_E16s_v5'],
      ],
      [
        'backmesh-azure-ubuntu-2404-highmem-od-16vcpu',
        'yk',
        false,
        ['Standard_E16ads_v5', 'Standard_E16as_v5', 'Standard_E16s_v5'],
      ],
    ]);
    expect(highmem.every((c) => !c.kvm && !c.gpu && !c.public)).toBe(true);
    // Every code is unique, and another listener's high-memory runner reads
    // as its size, on its cloud's general quota.
    const codes = classes.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codeClass('gk')).toEqual({
      cloud: 'gcp',
      spot: true,
      vcpus: 16,
      gpu: false,
    });
    expect(codeClass('bh')).toEqual({
      cloud: 'aws',
      spot: false,
      vcpus: 2,
      gpu: false,
    });
    // --public-repos never makes a high-memory label public.
    expect(
      planClasses([GCP], catalog, 'gcp', true).classes.filter(
        (c) => c.public && c.highmem,
      ),
    ).toEqual([]);
  });

  it('names a high-memory type a region lacks or offers in the wrong shape', () => {
    const odd = catalogs({
      gcp: CATALOG.gcp
        .filter((type) => type.vmType !== 'n2d-highmem-8')
        .map((type) =>
          type.vmType === 'n2-highmem-4' ? { ...type, memoryGiB: 16 } : type,
        ),
    });
    expect(planClasses([GCP], odd, 'gcp').problems).toEqual([
      'n2-highmem-4 is 4 vCPU / 16 GiB, not a 4 vCPU / 32 GiB CPU type',
      "n2d-highmem-8 isn't offered in gcp us-central1",
    ]);
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
    const small = catalogs({
      gcp: CATALOG.gcp.map((type) =>
        type.vmType === 'c4d-standard-4' ? { ...type, memoryGiB: 14 } : type,
      ),
    });
    expect(planClasses([GCP], small, 'gcp').problems).toEqual([
      'c4d-standard-4 is 4 vCPU / 14 GiB, not a 4 vCPU / 16 GiB CPU type',
    ]);
    // Only c4d may have less than 4 GiB a vCPU.
    const n2 = catalogs({
      gcp: CATALOG.gcp.map((type) =>
        type.vmType === 'n2-standard-4' ? { ...type, memoryGiB: 15 } : type,
      ),
    });
    expect(planClasses([GCP], n2, 'gcp').problems).toEqual([
      'n2-standard-4 is 4 vCPU / 15 GiB, not a 4 vCPU / 16 GiB CPU type',
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
    const four = classes.find((c) => c.label === 'backmesh-ubuntu-2404-4vcpu')!;
    expect(four.regions).toEqual(['us-east-2', 'us-west-2', 'us-east-1']);
    expect(
      classes.find((c) => c.label === 'backmesh-ubuntu-2404-kvm-od-4vcpu')
        ?.regions,
    ).toEqual(['us-east-2']);
  });

  it("gives AWS and Azure a T4 class on spot and on demand, as GitHub's GPU runner", () => {
    const { classes, noGpu } = planClasses([AWS, AZURE, GCP], catalog, 'aws');
    const gpu = classes.filter((c) => c.gpu);
    expect(gpu).toEqual([
      {
        ...AWS,
        label: 'backmesh-ubuntu-2404-gpu-t4',
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
      expect.objectContaining({
        label: 'backmesh-ubuntu-2404-gpu-od-t4',
        code: 'e4',
      }),
      expect.objectContaining({
        label: 'backmesh-azure-ubuntu-2404-gpu-t4',
        code: 't4',
        cloud: 'azure',
        vmTypes: ['Standard_NC4as_T4_v3'],
      }),
      expect.objectContaining({
        label: 'backmesh-azure-ubuntu-2404-gpu-od-t4',
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
    expect(
      classes.find((c) => c.label === 'backmesh-ubuntu-2404-gpu-t4')?.regions,
    ).toEqual(['westus2', 'eastus']);
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

  it('gives AWS and GCP arm64 classes, general and high-memory, on spot and on demand', () => {
    const { classes, noArm, problems } = planClasses(
      [AWS, AZURE, GCP],
      catalog,
      'gcp',
    );
    expect(problems).toEqual([]);
    const arm = classes.filter((c) => c.arm);
    expect(
      arm
        .filter((c) => c.vcpus === 4)
        .map(({ label, code, spot, vmTypes }) => [label, code, spot, vmTypes]),
    ).toEqual([
      [
        'backmesh-aws-ubuntu-2404-arm-4vcpu',
        'f4',
        true,
        ['m8g.xlarge', 'm7g.xlarge'],
      ],
      [
        'backmesh-aws-ubuntu-2404-arm-od-4vcpu',
        'p4',
        false,
        ['m8g.xlarge', 'm7g.xlarge'],
      ],
      [
        'backmesh-aws-ubuntu-2404-arm-highmem-4vcpu',
        'fi',
        true,
        ['r8g.xlarge', 'r7g.xlarge'],
      ],
      [
        'backmesh-aws-ubuntu-2404-arm-highmem-od-4vcpu',
        'pi',
        false,
        ['r8g.xlarge', 'r7g.xlarge'],
      ],
    ]);
    expect(arm[1]).toEqual({
      ...AWS,
      label: 'backmesh-aws-ubuntu-2404-arm-4vcpu',
      code: 'f4',
      vcpus: 4,
      spot: true,
      kvm: false,
      vmTypes: ['m8g.xlarge', 'm7g.xlarge'],
      regions: ['us-east-2'],
      arm: true,
    });
    expect(arm.find((c) => c.code === 'fi')).toMatchObject({
      highmem: true,
      arm: true,
    });
    // anycloud boots the arm64 image on AWS and GCP only, and the
    // fixture's GCP catalog has t2a but no c4a, as one from before the
    // catalog's arch column: t2a would boot the amd64 image, so GCP gets
    // none (c4a's below).
    expect(noArm).toEqual([AZURE, GCP]);
    // An anycloud without arm64 boots gets no arm64 class, and no line.
    const older = planClasses([AWS, GCP], catalog, 'gcp', false, false);
    expect(older.classes.some((c) => c.arm)).toBe(false);
    expect(older.noArm).toEqual([]);
    // Every code is unique, and another listener's arm64 runner holds its
    // cloud's quota at its size.
    const codes = classes.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codeClass('fg')).toEqual({
      cloud: 'aws',
      spot: true,
      vcpus: 16,
      gpu: false,
    });
    expect(codeClass('rk')).toEqual({
      cloud: 'gcp',
      spot: false,
      vcpus: 16,
      gpu: false,
    });
    // arm64 spot capacity is its own: reclaims there pause only the arm64
    // labels' spot, onto their on-demand twins.
    expect(spotCapacity(arm[0]!)).toBe('aws arm spot');
    expect(spotCapacity(arm.find((c) => c.code === 'fi')!)).toBe(
      'aws arm high-memory spot',
    );
    expect(spotCapacity(classes[1]!)).toBe('aws spot');
    // --public-repos never makes an arm64 label public.
    expect(
      planClasses([AWS], catalog, 'aws', true)
        .classes.filter((c) => c.public)
        .map((c) => c.label),
    ).toEqual([
      'backmesh-ubuntu-2404-public-2vcpu',
      'backmesh-ubuntu-2404-public-4vcpu',
    ]);
  });

  it("gives GCP's arm64 classes the regions that offer c4a or t2a, and its high-memory ones c4a-highmem's", () => {
    const c4a = (shape: string, gib: number) =>
      [2, 4, 8, 16].map((n) => ({
        vmType: `c4a-${shape}-${n}`,
        vCPUs: n,
        memoryGiB: n * gib,
        accelerators: [],
        capabilities: { nestedVirtualization: false },
        regions: [{ region: 'europe-west4-a', spotPricePerHour: null }],
      }));
    const t2a = (t: { vmType: string }) => t.vmType.startsWith('t2a-');
    const regions = new Map([
      // c4a and t2a, as europe-west4; c4a alone; t2a alone; neither.
      [
        'europe-west4',
        [...CATALOG.gcp, ...c4a('standard', 4), ...c4a('highmem', 8)],
      ],
      [
        'europe-west1',
        [
          ...CATALOG.gcp.filter((t) => !t2a(t)),
          ...c4a('standard', 4),
          ...c4a('highmem', 8),
        ],
      ],
      ['us-central1', CATALOG.gcp],
      ['europe-west3', CATALOG.gcp.filter((t) => !t2a(t))],
    ]);
    const { classes } = planClasses([GCP], new Map([['gcp', regions]]), 'gcp');
    const of = (label: string) => classes.find((c) => c.label === label);
    expect(of('backmesh-ubuntu-2404-arm-4vcpu')?.regions).toEqual([
      'europe-west4',
      'europe-west1',
      'us-central1',
    ]);
    expect(of('backmesh-ubuntu-2404-arm-highmem-od-16vcpu')).toMatchObject({
      code: 'rk',
      vmTypes: ['c4a-highmem-16'],
      regions: ['europe-west4', 'europe-west1'],
    });
  });

  it('keeps an arm64 class to the regions that offer Graviton, and drops it, unblocked, without any', () => {
    const graviton = (t: { vmType: string }) => /^[mr][78]g\./.test(t.vmType);
    const regions = new Map([
      ['us-east-2', CATALOG.aws],
      ['us-west-2', CATALOG.aws.filter((t) => !graviton(t))],
    ]);
    const { classes } = planClasses([AWS], new Map([['aws', regions]]), 'aws');
    expect(
      classes.find((c) => c.label === 'backmesh-ubuntu-2404-arm-4vcpu')
        ?.regions,
    ).toEqual(['us-east-2']);
    const plan = planClasses(
      [AWS],
      catalogs({ aws: CATALOG.aws.filter((t) => !graviton(t)) }),
      'aws',
    );
    expect(plan.classes.some((c) => c.arm)).toBe(false);
    expect(plan.noArm).toEqual([AWS]);
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
