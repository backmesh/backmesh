import { describe, expect, it } from 'vitest';

import type { VmTypeDetails } from '../../../src/runners/anycloud.js';
import { findVmType } from '../../../src/runners/anycloud.js';
import {
  CLASS_VCPUS,
  GIB_PER_VCPU,
  VM_TYPES,
  type Cloud,
} from '../../../src/runners/classes.js';
import { RUNNER_REGIONS } from '../../../src/runners/regions.js';

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

function fits(type: VmTypeDetails | undefined, vcpus: number): boolean {
  return (
    !!type &&
    type.vCPUs === vcpus &&
    type.memoryGiB === vcpus * GIB_PER_VCPU &&
    !type.accelerators?.length
  );
}

/** Whether `details` offers every type of every `backmesh-N` and KVM class. */
function qualifies(cloud: Cloud, details: readonly VmTypeDetails[]): boolean {
  return CLASS_VCPUS.every((vcpus) => {
    const general = VM_TYPES[cloud](vcpus).every((t) =>
      fits(findVmType(details, t), vcpus),
    );
    const kvm = KVM_TYPES[cloud](vcpus).every((t) => {
      const type = findVmType(details, t);
      return (
        fits(type, vcpus) && type?.capabilities?.nestedVirtualization === true
      );
    });
    return general && kvm;
  });
}

// A pinned snapshot of the real catalog's US regions (~/.anycloud/catalogs,
// 2026-11-13; m8a 2026-11-23), hand-written like `runners/fixtures.ts`'s. Refresh it, and
// RUNNER_REGIONS with it, when the pinned anycloud version's catalog
// changes which of these a region offers.
function family(
  fam: string,
  nests: boolean,
  only: readonly number[] = CLASS_VCPUS,
): VmTypeDetails[] {
  return only.map((vcpus) => ({
    vmType: `${fam}.${SIZES[vcpus]}`,
    vCPUs: vcpus,
    memoryGiB: vcpus * GIB_PER_VCPU,
    accelerators: [],
    capabilities: { nestedVirtualization: nests },
    regions: [],
  }));
}
const AWS_FULL = [
  ...family('m8a', false),
  ...family('m8i', true),
  ...family('m7a', false),
  ...family('m7i', true),
  ...family('m6a', false),
];
// us-west-1: every real AWS region but this one offers m7a and m8a.
const AWS_NO_M7A = AWS_FULL.filter(
  (t) => !t.vmType.startsWith('m7a.') && !t.vmType.startsWith('m8a.'),
);

function azureType(fam: string, nests: boolean, vcpus: number): VmTypeDetails {
  return {
    vmType: `Standard_D${vcpus}${fam}`,
    vCPUs: vcpus,
    memoryGiB: vcpus * GIB_PER_VCPU,
    accelerators: [],
    capabilities: { nestedVirtualization: nests },
    regions: [],
  };
}
const AZURE_FULL = CLASS_VCPUS.flatMap((vcpus) => [
  azureType('ads_v5', false, vcpus),
  azureType('as_v5', true, vcpus),
  azureType('s_v5', true, vcpus),
]);

function gcpType(fam: string, nests: boolean, vcpus: number): VmTypeDetails {
  return {
    vmType: `${fam}-standard-${vcpus}`,
    vCPUs: vcpus,
    memoryGiB: vcpus * GIB_PER_VCPU,
    accelerators: [],
    capabilities: { nestedVirtualization: nests },
    regions: [],
  };
}
const GCP_FULL = CLASS_VCPUS.flatMap((vcpus) => [
  gcpType('n2', true, vcpus),
  gcpType('n2d', false, vcpus),
]);

const PINNED: Record<Cloud, Record<string, VmTypeDetails[]>> = {
  aws: {
    'us-east-1': AWS_FULL,
    'us-east-2': AWS_FULL,
    'us-west-2': AWS_FULL,
    // Excluded: no m7a at any size.
    'us-west-1': AWS_NO_M7A,
  },
  gcp: {
    'us-east4': GCP_FULL,
    'us-central1': GCP_FULL,
    'us-east1': GCP_FULL,
    'us-east5': GCP_FULL,
    'us-south1': GCP_FULL,
    'us-west1': GCP_FULL,
    'us-west2': GCP_FULL,
    'us-west3': GCP_FULL,
    'us-west4': GCP_FULL,
    // Excluded: almost no general-purpose types.
    'us-central2': [],
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
      expect([...RUNNER_REGIONS[cloud]].sort()).toEqual(qualifying);
    },
  );

  it('excludes us-west-1 for AWS specifically because it lacks m7a', () => {
    expect(qualifies('aws', PINNED.aws['us-west-1']!)).toBe(false);
    // m8a is offered in every AWS runner region.
    for (const region of RUNNER_REGIONS.aws) {
      expect(PINNED.aws[region]!.some((t) => t.vmType === 'm8a.xlarge')).toBe(
        true,
      );
    }
    expect(RUNNER_REGIONS.aws).not.toContain('us-west-1');
  });

  it('excludes us-central2 for GCP specifically because it offers nothing', () => {
    expect(qualifies('gcp', PINNED.gcp['us-central2']!)).toBe(false);
    expect(RUNNER_REGIONS.gcp).not.toContain('us-central2');
  });

  it('lists every pinned US Azure region, which all qualify', () => {
    expect([...RUNNER_REGIONS.azure].sort()).toEqual(
      Object.keys(PINNED.azure).sort(),
    );
  });

  it("anchors each cloud's list on its SUGGESTED_REGION", async () => {
    const { SUGGESTED_REGION } =
      await import('../../../src/runners/regions.js');
    for (const cloud of ['aws', 'gcp', 'azure'] as const) {
      expect(RUNNER_REGIONS[cloud][0]).toBe(SUGGESTED_REGION[cloud]);
    }
  });
});
