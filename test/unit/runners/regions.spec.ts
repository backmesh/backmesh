import { describe, expect, it } from 'vitest';

import type { VmTypeDetails } from '../../../src/runners/anycloud.js';
import { findVmType } from '../../../src/runners/anycloud.js';
import {
  CLASS_VCPUS,
  GIB_PER_VCPU,
  HIGHMEM_GIB_PER_VCPU,
  HIGHMEM_TYPES,
  VM_TYPES,
  type Cloud,
} from '../../../src/runners/classes.js';
import {
  GEOS,
  geoOf,
  RUNNER_REGIONS,
  SUGGESTED_REGION,
} from '../../../src/runners/regions.js';

const SIZES: Record<number, string> = {
  2: 'large',
  4: 'xlarge',
  8: '2xlarge',
  16: '4xlarge',
};

// The families whose nested virtualization backmesh's KVM classes rely on
// (classes.ts's KVM filter): AWS's m8a, m7a and m6a don't
// nest, and Azure's ads_v5 doesn't either. Independent of classes.ts, so
// this test also catches a drift between the two.
const KVM_TYPES: Record<Cloud, (vcpus: number) => string[]> = {
  aws: (n) => ['m8i', 'm7i'].map((f) => `${f}.${SIZES[n]}`),
  gcp: (n) => [`n2-standard-${n}`],
  azure: (n) => [`Standard_D${n}as_v5`, `Standard_D${n}s_v5`],
};

function fits(
  type: VmTypeDetails | undefined,
  vcpus: number,
  gibPerVcpu = GIB_PER_VCPU,
): boolean {
  return (
    !!type &&
    type.vCPUs === vcpus &&
    type.memoryGiB === vcpus * gibPerVcpu &&
    !type.accelerators?.length
  );
}

/**
 * Whether `details` offers every type of every `backmesh-ubuntu-2404-Nvcpu`,
 * KVM and high-memory class.
 * The on-demand classes' own first types (GCP's c4d and c3d) needn't be
 * offered: their spot types follow them.
 */
function qualifies(cloud: Cloud, details: readonly VmTypeDetails[]): boolean {
  return CLASS_VCPUS.every((vcpus) => {
    // GCP's c4d leads where a region offers it; the others fall back.
    const general = VM_TYPES[cloud](vcpus, true)
      .filter((t) => !t.startsWith('c4d-'))
      .every((t) => fits(findVmType(details, t), vcpus));
    const kvm = KVM_TYPES[cloud](vcpus).every((t) => {
      const type = findVmType(details, t);
      return (
        fits(type, vcpus) && type?.capabilities?.nestedVirtualization === true
      );
    });
    const highmem = HIGHMEM_TYPES[cloud](vcpus).every((t) =>
      fits(findVmType(details, t), vcpus, HIGHMEM_GIB_PER_VCPU),
    );
    return general && kvm && highmem;
  });
}

// A pinned snapshot of the real catalog's US and EU regions
// (~/.anycloud/catalogs, 2026-11-13; m8a 2026-11-23; EU and the high-memory
// families 2026-11-25), hand-written like `runners/fixtures.ts`'s. Refresh
// it, and RUNNER_REGIONS with it, when the pinned anycloud version's
// catalog changes which of these a region offers.
function family(
  fam: string,
  nests: boolean,
  gibPerVcpu = GIB_PER_VCPU,
): VmTypeDetails[] {
  return CLASS_VCPUS.map((vcpus) => ({
    vmType: `${fam}.${SIZES[vcpus]}`,
    vCPUs: vcpus,
    memoryGiB: vcpus * gibPerVcpu,
    accelerators: [],
    capabilities: { nestedVirtualization: nests },
    regions: [],
  }));
}
const AWS_FAMILIES = [
  ...['m8a', 'm7a', 'm6a'].map((f) => [f, false, GIB_PER_VCPU] as const),
  ...['m8i', 'm7i'].map((f) => [f, true, GIB_PER_VCPU] as const),
  ...['r8a', 'r8i', 'r7a', 'r7i', 'r6a'].map(
    (f) => [f, false, HIGHMEM_GIB_PER_VCPU] as const,
  ),
];
// An AWS region's offer: every family but `lacks`'s, and `noNesting`'s
// without nested virtualization.
const aws = (lacks: string[] = [], noNesting: string[] = []) =>
  AWS_FAMILIES.filter(([f]) => !lacks.includes(f)).flatMap(([f, nests, gib]) =>
    family(f, nests && !noNesting.includes(f), gib),
  );
const AWS_FULL = aws();
// us-west-1: every real US AWS region but this one offers m7a and m8a.
const AWS_NO_M7A = aws(['m7a', 'm8a']);

function azureType(
  fam: string,
  nests: boolean,
  vcpus: number,
  series = 'D',
  gibPerVcpu = GIB_PER_VCPU,
): VmTypeDetails {
  return {
    vmType: `Standard_${series}${vcpus}${fam}`,
    vCPUs: vcpus,
    memoryGiB: vcpus * gibPerVcpu,
    accelerators: [],
    capabilities: { nestedVirtualization: nests },
    regions: [],
  };
}
const AZURE_FULL = CLASS_VCPUS.flatMap((vcpus) => [
  azureType('ads_v5', false, vcpus),
  azureType('as_v5', true, vcpus),
  azureType('s_v5', true, vcpus),
  azureType('ads_v5', false, vcpus, 'E', HIGHMEM_GIB_PER_VCPU),
  azureType('as_v5', true, vcpus, 'E', HIGHMEM_GIB_PER_VCPU),
  azureType('s_v5', true, vcpus, 'E', HIGHMEM_GIB_PER_VCPU),
]);

function gcpType(
  fam: string,
  nests: boolean,
  vcpus: number,
  shape = 'standard',
  gibPerVcpu = GIB_PER_VCPU,
): VmTypeDetails {
  return {
    vmType: `${fam}-${shape}-${vcpus}`,
    vCPUs: vcpus,
    memoryGiB: vcpus * gibPerVcpu,
    accelerators: [],
    capabilities: { nestedVirtualization: nests },
    regions: [],
  };
}
const GCP_FULL = CLASS_VCPUS.flatMap((vcpus) => [
  gcpType('n2', true, vcpus),
  gcpType('n2d', false, vcpus),
  gcpType('n2', true, vcpus, 'highmem', HIGHMEM_GIB_PER_VCPU),
  gcpType('n2d', false, vcpus, 'highmem', HIGHMEM_GIB_PER_VCPU),
]);
// The on-demand classes' first types: c4d at 3.875 GiB a vCPU, and c3d,
// which has no 2-vCPU size.
const C4D = CLASS_VCPUS.map((vcpus) => ({
  ...gcpType('c4d', false, vcpus),
  memoryGiB: Math.floor(vcpus * 3.875),
}));
const C3D = [4, 8, 16].map((vcpus) => gcpType('c3d', false, vcpus));
const GCP_NEWEST = [...GCP_FULL, ...C4D, ...C3D];

// The US regions, then the EU's: only EU member states' regions, as the
// EU geo keeps a job's data in the EU, so London, Zurich and Norway's
// aren't pinned.
const PINNED: Record<Cloud, Record<string, VmTypeDetails[]>> = {
  aws: {
    'us-east-1': AWS_FULL,
    'us-east-2': AWS_FULL,
    'us-west-2': AWS_FULL,
    // Excluded: no m7a at any size.
    'us-west-1': AWS_NO_M7A,
    'eu-central-1': AWS_FULL,
    'eu-west-1': AWS_FULL,
    // Excluded: no m8a, m8i, m6a, r8a or r6a; m7i doesn't nest there.
    'eu-north-1': aws(['m8a', 'm8i', 'm6a', 'r8a', 'r6a'], ['m7i']),
    // Excluded: no m8a, m8i or m7a, and no r8a, r7a or r6a.
    'eu-south-1': aws(['m8a', 'm8i', 'm7a', 'r8a', 'r7a', 'r6a'], ['m7i']),
    // Excluded: no m6a or r6a; neither m8i nor m7i nests there.
    'eu-south-2': aws(['m6a', 'r6a'], ['m8i', 'm7i']),
    // Excluded: no m8a, m7a, r8a, r7a or r6a.
    'eu-west-3': aws(['m8a', 'm7a', 'r8a', 'r7a', 'r6a']),
  },
  gcp: {
    'us-east4': GCP_NEWEST,
    'us-central1': GCP_NEWEST,
    'us-east1': GCP_NEWEST,
    'us-east5': GCP_NEWEST,
    // No c4d or c3d.
    'us-south1': GCP_FULL,
    'us-west1': GCP_NEWEST,
    // No c3d.
    'us-west2': [...GCP_FULL, ...C4D],
    'us-west3': [...GCP_FULL, ...C4D],
    'us-west4': GCP_NEWEST,
    // Excluded: almost no general-purpose types.
    'us-central2': [],
    'europe-west4': GCP_NEWEST,
    'europe-west1': GCP_NEWEST,
    'europe-west3': GCP_NEWEST,
    'europe-west9': GCP_NEWEST,
    'europe-west8': GCP_NEWEST,
    'europe-west12': GCP_NEWEST,
    'europe-west10': GCP_NEWEST,
    'europe-southwest1': GCP_NEWEST,
    'europe-north1': GCP_NEWEST,
    'europe-central2': GCP_NEWEST,
    // Excluded: no n2 or n2d.
    'europe-north2': [...C4D, ...C3D],
  },
  azure: {
    eastus: AZURE_FULL,
    centralus: AZURE_FULL,
    eastus2: AZURE_FULL,
    northcentralus: AZURE_FULL,
    southcentralus: AZURE_FULL,
    westcentralus: AZURE_FULL,
    westus: AZURE_FULL,
    westus2: AZURE_FULL,
    westus3: AZURE_FULL,
    westeurope: AZURE_FULL,
    northeurope: AZURE_FULL,
    germanywestcentral: AZURE_FULL,
    francecentral: AZURE_FULL,
    swedencentral: AZURE_FULL,
    italynorth: AZURE_FULL,
    polandcentral: AZURE_FULL,
    spaincentral: AZURE_FULL,
    austriaeast: AZURE_FULL,
    belgiumcentral: AZURE_FULL,
    denmarkeast: AZURE_FULL,
  },
};

describe('runner regions', () => {
  it.each(['aws', 'gcp', 'azure'] as const)(
    "matches %s's RUNNER_REGIONS to every pinned region that qualifies, and excludes every one that doesn't",
    (cloud) => {
      const pinned = PINNED[cloud];
      const qualifying = Object.keys(pinned)
        .filter((region) => qualifies(cloud, pinned[region]!))
        .sort();
      expect(GEOS.flatMap((geo) => RUNNER_REGIONS[geo][cloud]).sort()).toEqual(
        qualifying,
      );
    },
  );

  it('excludes us-west-1 for AWS specifically because it lacks m7a', () => {
    expect(qualifies('aws', PINNED.aws['us-west-1']!)).toBe(false);
    // m8a is offered in every AWS runner region.
    for (const region of RUNNER_REGIONS.us.aws) {
      expect(PINNED.aws[region]!.some((t) => t.vmType === 'm8a.xlarge')).toBe(
        true,
      );
    }
    expect(RUNNER_REGIONS.us.aws).not.toContain('us-west-1');
  });

  it('excludes us-central2 for GCP specifically because it offers nothing', () => {
    expect(qualifies('gcp', PINNED.gcp['us-central2']!)).toBe(false);
    expect(RUNNER_REGIONS.us.gcp).not.toContain('us-central2');
  });

  it("keeps each spot class's types, in order, among its on-demand twin's, both ending in the same fallbacks, so a region without GCP's c4d or c3d falls back to n2 and n2d", () => {
    for (const cloud of ['aws', 'gcp', 'azure'] as const) {
      for (const vcpus of CLASS_VCPUS) {
        const spot = VM_TYPES[cloud](vcpus, true);
        const onDemand = VM_TYPES[cloud](vcpus, false);
        expect(onDemand.filter((t) => spot.includes(t))).toEqual(spot);
        expect(onDemand.slice(-2)).toEqual(spot.slice(-2));
      }
    }
    // The anchor offers each on-demand type.
    for (const vcpus of CLASS_VCPUS) {
      for (const t of VM_TYPES.gcp(vcpus, false)) {
        expect(findVmType(PINNED.gcp['us-east4']!, t)).toBeDefined();
      }
    }
  });

  it('lists every pinned US and EU Azure region, which all qualify', () => {
    expect(GEOS.flatMap((geo) => RUNNER_REGIONS[geo].azure).sort()).toEqual(
      Object.keys(PINNED.azure).sort(),
    );
  });

  it("anchors each geo's list for each cloud on its SUGGESTED_REGION, in europe-west4 for GCP's EU", () => {
    for (const geo of GEOS) {
      for (const cloud of ['aws', 'gcp', 'azure'] as const) {
        expect(RUNNER_REGIONS[geo][cloud][0]).toBe(
          SUGGESTED_REGION[geo][cloud],
        );
      }
    }
    expect(SUGGESTED_REGION.eu.gcp).toBe('europe-west4');
  });

  it("reads a route's geo from its regions, US when none is a geo's", () => {
    const route = (cloud: Cloud, regions: string[]) => ({ cloud, regions });
    expect(geoOf([route('gcp', ['europe-west4', 'europe-west1'])])).toBe('eu');
    expect(geoOf([route('aws', ['us-east-2'])])).toBe('us');
    // A single-region route outside every geo's list.
    expect(geoOf([route('aws', ['ap-south-1'])])).toBe('us');
    expect(geoOf([])).toBe('us');
  });
});
