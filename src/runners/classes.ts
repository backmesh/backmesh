// The runner classes and their labels: each CI job runs
// in its own anycloud VM Job, on a VM of its class's size.
import { findVmType, type VmTypeDetails } from './anycloud.js';

export const CLOUDS = ['aws', 'gcp', 'azure'] as const;
export type Cloud = (typeof CLOUDS)[number];

/** The classes' vCPUs, at 4 GiB each; `backmesh-4` is the default. */
export const CLASS_VCPUS = [2, 4, 8, 16] as const;
export const GIB_PER_VCPU = 4;

const AWS_SIZE: Record<number, string> = {
  2: 'large',
  4: 'xlarge',
  8: '2xlarge',
  16: '4xlarge',
};

/**
 * Each class's general-purpose x86 types, in launch order: anycloud tries a
 * VM Job's types in catalog order and fails over on a failed launch
 * (`src/api/services/launch-targets.ts:67-117` at v0.1.73). The families were
 * the owner's (2026-11-04), reordered by cold start, build time and spot
 * capacity (owner, 2026-11-13; anycloud `experiments/runner-start/README.md`
 * on `experiment/runner-start`): AWS drops `m6i` (the highest spot price and
 * 9 of 13 spot refusals) and leads with `m8i` (not `m8a`, which us-east-2
 * refused 22 of 24 spot requests); GCP keeps `n2` ahead of `n2d` without
 * `c4d`'s extra Hyperdisk cost; Azure's `ads` family, whose local resource
 * disk anycloud already redirects the image stores onto
 * (`moveImageStoresToResourceDisk`), goes first: 21.5 s faster to start than
 * `as_v5` with no anycloud change (the OS disk stays Premium_LRS either way;
 * an actual ephemeral OS disk would save about 6 s more but isn't built).
 * AWS's on-demand classes try `m8a` first (owner, 2026-11-23; anycloud#30,
 * `experiments/m8a-vs-m8i`): it ran backmesh's builds in 0.64–0.88× `m8i`'s
 * time and launched 40 of 40 on demand, but its spot capacity is too scarce
 * to lead a spot class.
 */
export const VM_TYPES: Record<
  Cloud,
  (vcpus: number, spot: boolean) => string[]
> = {
  aws: (n, spot) =>
    [...(spot ? [] : ['m8a']), 'm8i', 'm7a', 'm7i', 'm6a'].map(
      (f) => `${f}.${AWS_SIZE[n]}`,
    ),
  gcp: (n) => [`n2-standard-${n}`, `n2d-standard-${n}`],
  azure: (n) => [
    `Standard_D${n}ads_v5`,
    `Standard_D${n}as_v5`,
    `Standard_D${n}s_v5`,
  ],
};

// The code's first character: the cloud, whether the class is spot, and
// whether it's a KVM, a public or a GPU class.
const CLOUD_CODE: Record<
  Cloud,
  [
    spot: string,
    onDemand: string,
    kvmSpot: string,
    kvmOnDemand: string,
    publicSpot: string,
    gpuSpot: string,
    gpuOnDemand: string,
  ]
> = {
  aws: ['a', 'b', 'k', 'l', 'c', 'd', 'e'],
  gcp: ['g', 'h', 'm', 'n', 'i', 'j', 'o'],
  azure: ['z', 'y', 'v', 'w', 'x', 't', 'u'],
};
const SPOT_CODES = [0, 2, 4, 5];
const GPU_CODES = [5, 6];

/**
 * The GPU classes' types, in launch order, as GitHub's GPU runner: one
 * NVIDIA T4 and 4 vCPUs (owner, 2026-11-18). AWS's `g4dn.xlarge` has 16 GiB
 * of memory to GitHub's 28, at 70 % of `g4dn.2xlarge`'s price, which follows
 * it with the same T4: with one type, a spot capacity refusal in all three
 * regions left anycloud no untried target, so v0.4.3-rc.1's runner backed
 * off 12 min before it launched (coordinator, 2026-11-18). Azure's matches
 * GitHub's. GCP has none: anycloud 0.1.78's GCP catalog leaves T4 out
 * (`INTENTIONALLY_EXCLUDED_ACCELERATORS`, `src/shared/catalog/gcp.ts`), and
 * `n1` isn't a GPU series it launches (`gcp-machine-capabilities.ts`).
 */
export const GPU_TYPES: Record<Cloud, string[]> = {
  aws: ['g4dn.xlarge', 'g4dn.2xlarge'],
  gcp: [],
  azure: ['Standard_NC4as_T4_v3'],
};
/**
 * The GPU classes' shape. Quota checks count each runner at these 4 vCPUs,
 * so a region with room for one `g4dn.xlarge` keeps the label; a
 * `g4dn.2xlarge` fallback uses 8 of it.
 */
export const GPU = { model: 'T4', vcpus: 4 } as const;

/** `backmesh-public-<n>`'s sizes: the home cloud's spot, no KVM. */
export const PUBLIC_VCPUS = [2, 4] as const;
/** The vCPUs they may hold at once. */
export const PUBLIC_VCPU_CAP = 32;

/** The cloud, spot-ness and vCPUs a runner class's code names. */
export function codeClass(
  code: string,
): { cloud: Cloud; spot: boolean; vcpus: number; gpu: boolean } | undefined {
  for (const [cloud, letters] of Object.entries(CLOUD_CODE)) {
    const i = letters.indexOf(code[0] ?? '');
    const vcpus = parseInt(code.slice(1), 36);
    if (i >= 0 && Number.isInteger(vcpus) && vcpus > 0) {
      return {
        cloud: cloud as Cloud,
        spot: SPOT_CODES.includes(i),
        vcpus,
        gpu: GPU_CODES.includes(i),
      };
    }
  }
  return undefined;
}

export interface CloudTarget {
  cloud: Cloud;
  /**
   * The runners' anchor region: the control plane's on its own cloud, or
   * `SUGGESTED_REGION` elsewhere (`parseRunners`). The actual runner
   * regions are `RUNNER_REGIONS` (`regions.ts`), account-allowed.
   */
  region: string;
  /**
   * The anycloud connection the VM Jobs launch with, as the listener's
   * routes record it: empty until install names it on the control plane.
   */
  credentials: string;
}

export interface RunnerClass extends CloudTarget {
  /** The `runs-on` label, one GitHub scale set. */
  label: string;
  /**
   * The scale set's 2-character code in its runners' IDs: the cloud, kind
   * and vCPUs in base 36, so it's the same after a restart.
   */
  code: string;
  vcpus: number;
  spot: boolean;
  kvm: boolean;
  vmTypes: string[];
  /** Where its VM Jobs may launch: the regions offering one of its types. */
  regions: string[];
  /**
   * `backmesh-public-<n>`: the only labels a public repository's fork pull
   * request may use.
   */
  public?: boolean;
  /** `backmesh-gpu-t4`: its VMs' one GPU, passed into the job. */
  gpu?: typeof GPU.model;
}

/**
 * On-demand classes are `backmesh-od-<n>`, KVM ones `backmesh-kvm-<n>`.
 * The home cloud, the control plane's, has the plain labels; another cloud's
 * name it (`prefixed`), so adding or removing a cloud renames no label
 * (owner, 2026-11-08).
 */
export const classLabel = (
  cloud: Cloud,
  prefixed: boolean,
  onDemand: boolean,
  kvm: boolean,
  vcpus: number,
) =>
  `backmesh-${prefixed ? `${cloud}-` : ''}${kvm ? 'kvm-' : ''}${onDemand ? 'od-' : ''}${vcpus}`;

/** A GPU class's label, such as `backmesh-gpu-od-t4` or `backmesh-azure-gpu-t4`. */
export const gpuLabel = (cloud: Cloud, prefixed: boolean, onDemand: boolean) =>
  `backmesh-${prefixed ? `${cloud}-` : ''}gpu-${onDemand ? 'od-' : ''}${GPU.model.toLowerCase()}`;

/** Where a spot class's reclaims count for the breaker, such as "aws spot". */
export const spotCapacity = ({
  cloud,
  kvm,
  gpu,
}: {
  cloud: Cloud;
  kvm: boolean;
  gpu?: string;
}) => `${cloud}${kvm ? ' KVM' : ''}${gpu ? ' GPU' : ''} spot`;

/** Why `vmType`, offered in `details`, can't be a class's VM; undefined when it can. */
function shapeProblem(
  details: readonly VmTypeDetails[],
  vmType: string,
  vcpus: number,
): string | undefined {
  const type = findVmType(details, vmType);
  if (!type) return;
  const memory = vcpus * GIB_PER_VCPU;
  const fits =
    type.vCPUs === vcpus &&
    type.memoryGiB === memory &&
    !type.accelerators?.length;
  return fits
    ? undefined
    : `${vmType} is ${type.vCPUs} vCPU / ${type.memoryGiB} GiB, not a ${vcpus} vCPU / ${memory} GiB CPU type`;
}

/** Each region's `vm-types --details` records, the install region first. */
export type RegionCatalog = ReadonlyMap<string, readonly VmTypeDetails[]>;

/** "aws us-east-2", or "aws us-east-2, us-east-1 and us-west-2". */
export function where(cloud: Cloud, regions: readonly string[]): string {
  const last = regions.at(-1);
  return regions.length > 1
    ? `${cloud} ${regions.slice(0, -1).join(', ')} and ${last}`
    : `${cloud} ${last}`;
}

export interface ClassPlan {
  classes: RunnerClass[];
  /** Why the classes can't run; empty when they can. */
  problems: string[];
  /** The targets whose regions have no KVM class. */
  noKvm: CloudTarget[];
  /** The targets whose regions have no GPU class. */
  noGpu: CloudTarget[];
}

/**
 * Every class of each runner cloud, from its regions' catalogs: spot and on
 * demand, then KVM spot and on demand on the sizes whose KVM types a region
 * offers with nested virtualization. Every runner region is one of
 * `RUNNER_REGIONS` (`regions.ts`), fixed because it offers every type of
 * every class (owner, 2026-11-13), so a class's types need no per-region
 * filter: only a KVM class's do, since nesting isn't part of that
 * guarantee for every family. Each class launches in the regions that offer
 * one of its types; a cloud without any KVM type gets no KVM labels, so it
 * never blocks the others.
 */
export function planClasses(
  targets: readonly CloudTarget[],
  catalog: ReadonlyMap<Cloud, RegionCatalog>,
  // The control plane's cloud, whose labels are plain; others name theirs.
  // None when no runners are on it.
  home: Cloud | undefined,
  // `install --public-repos`: the home cloud's `backmesh-public-<n>` too.
  publicRepos = false,
): ClassPlan {
  const plan: ClassPlan = { classes: [], problems: [], noKvm: [], noGpu: [] };
  for (const target of targets) {
    const byRegion = [...(catalog.get(target.cloud) ?? [])];
    const fits = (
      details: readonly VmTypeDetails[],
      vmType: string,
      n: number,
    ) => !!findVmType(details, vmType) && !shapeProblem(details, vmType, n);
    // A KVM class tries the same types as the general one, in the same
    // order, filtered to the ones a runner region's catalog reports nested
    // virtualization for: GCP's `n2d` doesn't nest, and `n2` does
    // (anycloud's `src/shared/catalog/nested-virtualization.ts`). AWS's
    // `m8a`, `m7a` and `m6a` don't nest, so KVM classes get only `m8i` then `m7i`;
    // Azure's `ads_v5` doesn't nest either, so KVM classes keep `as_v5`
    // then `s_v5`. There's no separate list to keep in step with
    // `VM_TYPES`'s order.
    const nests = (
      details: readonly VmTypeDetails[],
      vmType: string,
      n: number,
    ) =>
      fits(details, vmType, n) &&
      findVmType(details, vmType)?.capabilities?.nestedVirtualization === true;
    const kvmTypes = (vcpus: number, spot: boolean) =>
      VM_TYPES[target.cloud](vcpus, spot).filter((vmType) =>
        byRegion.some(([, details]) => nests(details, vmType, vcpus)),
      );
    const classes = [false, true].flatMap((kvm) =>
      [true, false].flatMap((spot) =>
        CLASS_VCPUS.flatMap((vcpus): RunnerClass[] => {
          const ok = kvm ? nests : fits;
          const vmTypes = kvm
            ? kvmTypes(vcpus, spot)
            : VM_TYPES[target.cloud](vcpus, spot);
          const regions = byRegion.flatMap(([region, details]) =>
            vmTypes.some((vmType) => ok(details, vmType, vcpus))
              ? [region]
              : [],
          );
          if (!vmTypes.length || (kvm && !regions.length)) return [];
          const code = `${CLOUD_CODE[target.cloud][(kvm ? 2 : 0) + (spot ? 0 : 1)]}${vcpus.toString(36)}`;
          const label = classLabel(
            target.cloud,
            target.cloud !== home,
            !spot,
            kvm,
            vcpus,
          );
          return [
            {
              ...target,
              label,
              code,
              vcpus,
              spot,
              kvm,
              vmTypes,
              regions,
            },
          ];
        }),
      ),
    );
    const names = byRegion.map(([region]) => region);
    // Every type of the size's spot and on-demand classes.
    const allTypes = (vcpus: number) => [
      ...new Set(
        [true, false].flatMap((spot) => VM_TYPES[target.cloud](vcpus, spot)),
      ),
    ];
    plan.problems.push(
      ...CLASS_VCPUS.flatMap((vcpus) =>
        allTypes(vcpus).flatMap((vmType) => {
          const offered = byRegion.find(([, d]) => findVmType(d, vmType));
          return offered
            ? (shapeProblem(offered[1], vmType, vcpus) ?? [])
            : [`${vmType} isn't offered in ${where(target.cloud, names)}`];
        }),
      ),
      ...byRegion.flatMap(([region, details]) =>
        CLASS_VCPUS.some((vcpus) =>
          allTypes(vcpus).some((t) => fits(details, t, vcpus)),
        )
          ? []
          : [`${target.cloud} ${region} offers none of the runners' VM types`],
      ),
    );
    if (!classes.some((c) => c.kvm)) plan.noKvm.push(target);
    // The GPU classes: their types' regions that offer one T4 with at
    // least the class's vCPUs. Among the runner regions, Azure's catalog offers its
    // type only in those anycloud's GPU image reaches
    // (`AZURE_GPU_COMMUNITY_IMAGE_REGIONS`, `src/shared/catalog/azure-gpu-map.ts`
    // at 0.1.78). A cloud with none gets no GPU labels, and install says so.
    const gpuFits = (details: readonly VmTypeDetails[], vmType: string) => {
      const type = findVmType(details, vmType);
      const [one, ...more] = type?.accelerators ?? [];
      return (
        (type?.vCPUs ?? 0) >= GPU.vcpus &&
        one?.name === GPU.model &&
        one.count === 1 &&
        !more.length
      );
    };
    const gpuRegions = byRegion.flatMap(([region, details]) =>
      GPU_TYPES[target.cloud].some((t) => gpuFits(details, t)) ? [region] : [],
    );
    const gpu = gpuRegions.length
      ? [true, false].map((spot): RunnerClass => ({
          ...target,
          label: gpuLabel(target.cloud, target.cloud !== home, !spot),
          code: `${CLOUD_CODE[target.cloud][spot ? 5 : 6]}${GPU.vcpus.toString(36)}`,
          vcpus: GPU.vcpus,
          spot,
          kvm: false,
          vmTypes: GPU_TYPES[target.cloud],
          regions: gpuRegions,
          gpu: GPU.model,
        }))
      : [];
    if (!gpu.length) plan.noGpu.push(target);
    plan.classes.push(...classes, ...gpu);
    if (publicRepos && target.cloud === home) {
      plan.classes.push(
        ...classes.flatMap((c) =>
          c.spot &&
          !c.kvm &&
          (PUBLIC_VCPUS as readonly number[]).includes(c.vcpus)
            ? [
                {
                  ...c,
                  label: `backmesh-public-${c.vcpus}`,
                  code: `${CLOUD_CODE[target.cloud][4]}${c.vcpus.toString(36)}`,
                  public: true,
                },
              ]
            : [],
        ),
      );
    }
  }
  return plan;
}
