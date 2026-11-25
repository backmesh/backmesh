// Hand-written `anycloud vm-types <cloud> <region> --details --json` records
// (anycloud `src/shared/catalog/vm-details.ts:9-25`): the 4-vCPU types at the
// catalog's us-east-2, us-central1 and westus2 prices of 2026-11-07, and the
// other sizes at those prices scaled by their vCPUs.
import type { VmTypeDetails } from '../../../src/runners/anycloud.js';
import type { Cloud, RegionCatalog } from '../../../src/runners/classes.js';

const SIZES = [2, 4, 8, 16];
const AWS_SIZE: Record<number, string> = {
  2: 'large',
  4: 'xlarge',
  8: '2xlarge',
  16: '4xlarge',
};

// Each size of a family: its name, and the 4-vCPU type's spot and on-demand
// $/hour; GCP's c4d has 3.875 GiB a vCPU, rounded down.
function family(
  name: (vcpus: number) => string,
  region: string,
  [spot, onDemand]: [number, number],
  nestedVirtualization: boolean,
  { sizes = SIZES, gibPerVcpu = 4 } = {},
): VmTypeDetails[] {
  return sizes.map((vcpus) => ({
    vmType: name(vcpus),
    vCPUs: vcpus,
    memoryGiB: Math.floor(vcpus * gibPerVcpu),
    accelerators: [],
    capabilities: { nestedVirtualization },
    regions: [
      {
        region,
        spotPricePerHour: (spot * vcpus) / 4,
        onDemandPricePerHour: (onDemand * vcpus) / 4,
      },
    ],
  }));
}

const aws = (
  f: string,
  prices: [number, number],
  nested = false,
  gibPerVcpu = 4,
) =>
  family((n) => `${f}.${AWS_SIZE[n]}`, 'us-east-2', prices, nested, {
    gibPerVcpu,
  });

// The high-memory classes' types, at 8 GiB a vCPU: the catalog's of
// 2026-11-25.
const HIGHMEM = { gibPerVcpu: 8 };

// A GPU type with one T4, at the catalog's prices of 2026-11-18.
const t4 = (
  vmType: string,
  vCPUs: number,
  memoryGiB: number,
  region: string,
  [spot, onDemand]: [number, number],
): VmTypeDetails => ({
  vmType,
  vCPUs,
  memoryGiB,
  accelerators: [{ name: 'T4', count: 1 }],
  capabilities: { nestedVirtualization: false },
  regions: [{ region, spotPricePerHour: spot, onDemandPricePerHour: onDemand }],
});

export const CATALOG = {
  aws: [
    ...aws('m6a', [0.0618, 0.1728]),
    ...aws('m7a', [0.068, 0.2318]),
    ...aws('m6i', [0.0691, 0.192]),
    ...aws('m7i', [0.0481, 0.2016], true),
    ...aws('m8i', [0.0543, 0.2117], true),
    // The catalog's of 2026-11-23.
    ...aws('m8a', [0.065, 0.2434]),
    ...aws('r8a', [0.096, 0.3195], false, 8),
    ...aws('r8i', [0.0837, 0.2778], false, 8),
    ...aws('r7a', [0.116, 0.3043], false, 8),
    ...aws('r7i', [0.1008, 0.2646], false, 8),
    ...aws('r6a', [0.0764, 0.2268], false, 8),
    // Graviton, anycloud 0.1.80's catalog of 2026-11-24, and its
    // high-memory twins, the catalog's of 2026-11-25.
    ...aws('m8g', [0.0534, 0.1795]),
    ...aws('m7g', [0.0608, 0.1632]),
    ...aws('r8g', [0.0428, 0.2356], false, 8),
    ...aws('r7g', [0.0748, 0.2142], false, 8),
    t4('g4dn.xlarge', 4, 16, 'us-east-2', [0.2732, 0.526]),
    t4('g4dn.2xlarge', 8, 32, 'us-east-2', [0.3696, 0.752]),
  ],
  // GCP offerings are zones priced at their region.
  gcp: [
    ...family(
      (n) => `n2d-standard-${n}`,
      'us-central1-a',
      [0.0856, 0.169],
      false,
    ),
    ...family(
      (n) => `n2-standard-${n}`,
      'us-central1-b',
      [0.1165, 0.1942],
      true,
    ),
    // The on-demand classes' first: c3d has no 2-vCPU size.
    ...family(
      (n) => `c4d-standard-${n}`,
      'us-central1-a',
      [0.0771, 0.1833],
      false,
      { gibPerVcpu: 3.875 },
    ),
    ...family(
      (n) => `c3d-standard-${n}`,
      'us-central1-a',
      [0.0415, 0.1816],
      false,
      { sizes: [4, 8, 16] },
    ),
    ...family(
      (n) => `n2-highmem-${n}`,
      'us-central1-a',
      [0.1572, 0.262],
      true,
      HIGHMEM,
    ),
    ...family(
      (n) => `n2d-highmem-${n}`,
      'us-central1-a',
      [0.1267, 0.228],
      false,
      HIGHMEM,
    ),
    // arm64: Ampere's t2a, with no c4a, as a catalog from before its arch
    // column (`planClasses`).
    ...family(
      (n) => `t2a-standard-${n}`,
      'us-central1-a',
      [0.08279, 0.154],
      false,
    ),
  ],
  // The catalog may spell a type in another case than the classes' list.
  azure: [
    // ads_v5 isn't in anycloud's AZURE_SUPPORTED_SERIES, so it doesn't nest.
    ...family((n) => `Standard_D${n}ads_v5`, 'westus2', [0.043, 0.233], false),
    ...family((n) => `standard_d${n}as_v5`, 'westus2', [0.0318, 0.172], true),
    ...family((n) => `Standard_D${n}s_v5`, 'westus2', [0.0355, 0.192], true),
    ...family(
      (n) => `Standard_E${n}ads_v5`,
      'westus2',
      [0.0484, 0.262],
      false,
      HIGHMEM,
    ),
    ...family(
      (n) => `Standard_E${n}as_v5`,
      'westus2',
      [0.0418, 0.226],
      true,
      HIGHMEM,
    ),
    ...family(
      (n) => `Standard_E${n}s_v5`,
      'westus2',
      [0.0466, 0.252],
      true,
      HIGHMEM,
    ),
    t4('Standard_NC4as_T4_v3', 4, 28, 'westus2', [0.1766, 0.526]),
  ],
};

/** Each cloud's catalog, read in its fixture region alone. */
export const HOME = { aws: 'us-east-2', gcp: 'us-central1', azure: 'westus2' };
export const catalogs = (
  catalog: Partial<Record<Cloud, VmTypeDetails[]>> = CATALOG,
): Map<Cloud, RegionCatalog> =>
  new Map(
    (Object.entries(catalog) as [Cloud, VmTypeDetails[]][]).map(
      ([cloud, details]) => [cloud, new Map([[HOME[cloud], details]])],
    ),
  );

/**
 * AWS's catalog as us-east-2 reads it, offering every type in us-east-1 and
 * us-west-2 too, where spot costs `factor` times as much.
 */
export const awsInRegions = (factor: Record<string, number>) =>
  CATALOG.aws.map((type) => ({
    ...type,
    regions: [
      ...type.regions,
      ...Object.entries(factor).map(([region, f]) => ({
        region,
        spotPricePerHour: type.regions[0]!.spotPricePerHour! * f,
        onDemandPricePerHour: type.regions[0]!.onDemandPricePerHour,
      })),
    ],
  }));
