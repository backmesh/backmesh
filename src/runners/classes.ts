// The runner classes and their labels: each CI job runs
// in its own anycloud VM Job, on a VM of its class's size.
import { findVmType, type VmTypeDetails } from './anycloud.js';

export const CLOUDS = ['aws', 'gcp', 'azure'] as const;
export type Cloud = (typeof CLOUDS)[number];

/** The classes' vCPUs, at 4 GiB each; `backmesh-ubuntu-2404-4vcpu` is the default. */
export const CLASS_VCPUS = [2, 4, 8, 16] as const;
export const GIB_PER_VCPU = 4;
// GCP's c4d has 3.875 GiB a vCPU, rounded down: 15 GiB at 4 vCPUs. Only
// it may have less than 4 GiB a vCPU, so another such type still fails.
const C4D_GIB_PER_VCPU = 3.875;

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
 * refused 22 of 24 spot requests); GCP spot keeps `n2` ahead of `n2d` without
 * `c4d`'s extra Hyperdisk cost; Azure's `ads` family, whose local resource
 * disk anycloud already redirects the image stores onto
 * (`moveImageStoresToResourceDisk`), goes first: 21.5 s faster to start than
 * `as_v5` with no anycloud change (the OS disk stays Premium_LRS either way;
 * an actual ephemeral OS disk would save about 6 s more but isn't built).
 * AWS's classes, spot too, try `m8a` first (owner, 2026-11-23;
 * anycloud#30, `experiments/m8a-vs-m8i`): it ran backmesh's builds in
 * 0.64–0.88× `m8i`'s time, and since anycloud fails a spot launch over to the
 * next target as soon as a zone refuses (anycloud#35), spot `xlarge` landed
 * on `m8a` 20 of 20 times in about 9.6 s and `4xlarge` 9 of 20 in about
 * 13.7 s.
 * GCP's on-demand classes try AMD's `c4d` (Zen 5) and `c3d` (Zen 4) first:
 * at 4 vCPUs on demand, anycloud#38 measured 0.50 and 0.71 of `n2`'s build
 * time and 0.78 and 0.76 of its cost per Job, `c4d`'s Hyperdisk Balanced
 * boot disk included. `backmesh-ubuntu-2404-od-2vcpu` keeps `n2` and `n2d`: `c3d` has no
 * 2-vCPU size, and `c4d`'s wasn't measured. A region without either falls
 * back to `n2` and `n2d`; spot stays as it is until its own measurements
 * land.
 */
export const VM_TYPES: Record<
  Cloud,
  (vcpus: number, spot: boolean) => string[]
> = {
  aws: (n) =>
    ['m8a', 'm8i', 'm7a', 'm7i', 'm6a'].map((f) => `${f}.${AWS_SIZE[n]}`),
  gcp: (n, spot) => [
    ...(spot || n < 4 ? [] : [`c4d-standard-${n}`, `c3d-standard-${n}`]),
    `n2-standard-${n}`,
    `n2d-standard-${n}`,
  ],
  azure: (n) => [
    `Standard_D${n}ads_v5`,
    `Standard_D${n}as_v5`,
    `Standard_D${n}s_v5`,
  ],
};

// The code's first character: the cloud, whether the class is spot, and
// whether it's a KVM, a public, a GPU or an arm64 class. Azure has no arm64
// classes (`ARM_TYPES`).
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
    armSpot?: string,
    armOnDemand?: string,
  ]
> = {
  aws: ['a', 'b', 'k', 'l', 'c', 'd', 'e', 'f', 'p'],
  gcp: ['g', 'h', 'm', 'n', 'i', 'j', 'o', 'q', 'r'],
  azure: ['z', 'y', 'v', 'w', 'x', 't', 'u'],
};
const SPOT_CODES = [0, 2, 4, 5, 7];
const GPU_CODES = [5, 6];
/**
 * A high-memory class's second character: its vCPUs, as the general
 * class's base-36 digit is, under a first character shared with the
 * general class of its cloud and spot-ness. Few first characters are left
 * (36, less the 25 above), so a memory variant takes none of them, and an
 * arm64 high-memory class can pair these with the arm64 letters. No base-36
 * vCPU digit is one of these, since 17 to 20 vCPUs is no class's size.
 */
const HIGHMEM_SIZE: Record<number, string> = {
  2: 'h',
  4: 'i',
  8: 'j',
  16: 'k',
};

/**
 * The high-memory classes' types, in launch order: 8 GiB a vCPU, twice the
 * general classes', at the same vCPUs, for jobs a general class's memory
 * runs out of, such as a big Rust link (owner, 2026-11-25). Each cloud's
 * memory-optimized twin of its general families, in the same order: AWS's
 * `r` for `m`, GCP's `highmem` for `standard`, Azure's `E` for `D`. GCP's
 * on-demand ones don't lead with `c4d` or `c3d` as the general classes'
 * do: neither was measured at this shape, and `c4d-highmem` has 7.875 GiB a
 * vCPU. They count against the general classes' vCPU quotas (`quota.ts`).
 */
export const HIGHMEM_TYPES: Record<Cloud, (vcpus: number) => string[]> = {
  aws: (n) =>
    ['r8a', 'r8i', 'r7a', 'r7i', 'r6a'].map((f) => `${f}.${AWS_SIZE[n]}`),
  gcp: (n) => [`n2-highmem-${n}`, `n2d-highmem-${n}`],
  azure: (n) => [
    `Standard_E${n}ads_v5`,
    `Standard_E${n}as_v5`,
    `Standard_E${n}s_v5`,
  ],
};
export const HIGHMEM_GIB_PER_VCPU = 8;

/**
 * The arm64 classes' types, in launch order, at the general classes' 4 GiB
 * a vCPU. AWS's are Graviton, `m8g` (Graviton4) then `m7g` (Graviton3)
 * (owner, 2026-11-24): anycloud#36 measured `m8g` at 0.94 of `m8i`'s build
 * time at xlarge and 1.03 at 4xlarge, at 0.85 of its on-demand price; its
 * spot took 42% of zones at xlarge and 75% at 4xlarge. GCP's are Axion's
 * `c4a`, then Ampere's `t2a` (anycloud#50), which only a few regions offer,
 * so a class's regions are the ones offering either. Azure's `Dpsv5` and
 * `Epsv5` are in its catalog, but anycloud boots only AWS's and GCP's
 * arm64 types on the arm64 image (anycloud#47, #50), so Azure has none.
 * AWS's count against the general classes' vCPU quotas (`quota.ts`).
 */
export const ARM_TYPES: Record<Cloud, (vcpus: number) => string[]> = {
  aws: (n) => ['m8g', 'm7g'].map((f) => `${f}.${AWS_SIZE[n]}`),
  gcp: (n) => [`c4a-standard-${n}`, `t2a-standard-${n}`],
  azure: () => [],
};

/**
 * The arm64 high-memory classes' types, at the high-memory classes' 8 GiB a
 * vCPU: the memory-optimized twins of `ARM_TYPES`, AWS's `r8g` then `r7g`
 * and GCP's `c4a-highmem` (`t2a` has no high-memory shape).
 */
export const ARM_HIGHMEM_TYPES: Record<Cloud, (vcpus: number) => string[]> = {
  aws: (n) => ['r8g', 'r7g'].map((f) => `${f}.${AWS_SIZE[n]}`),
  gcp: (n) => [`c4a-highmem-${n}`],
  azure: () => [],
};

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

/** `backmesh-ubuntu-2404-public-<n>vcpu`'s sizes: the home cloud's spot, no KVM. */
export const PUBLIC_VCPUS = [2, 4] as const;
/** The vCPUs they may hold at once. */
export const PUBLIC_VCPU_CAP = 32;

/** The cloud, spot-ness and vCPUs a runner class's code names. */
export function codeClass(
  code: string,
): { cloud: Cloud; spot: boolean; vcpus: number; gpu: boolean } | undefined {
  const size = code.slice(1);
  const highmem = Object.entries(HIGHMEM_SIZE).find(([, c]) => c === size);
  for (const [cloud, letters] of Object.entries(CLOUD_CODE)) {
    const i = letters.indexOf(code[0] ?? '');
    const vcpus = highmem ? Number(highmem[0]) : parseInt(size, 36);
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
   * `backmesh-ubuntu-2404-public-<n>vcpu`: the only labels a public repository's fork pull
   * request may use.
   */
  public?: boolean;
  /** `backmesh-ubuntu-2404-gpu-t4`: its VMs' one GPU, passed into the job. */
  gpu?: typeof GPU.model;
  /** `backmesh-ubuntu-2404-highmem-<n>vcpu`: 8 GiB a vCPU (`HIGHMEM_TYPES`). */
  highmem?: true;
  /** `backmesh-ubuntu-2404-arm-<n>vcpu`: arm64 VMs, which pull the runner image's arm64 build. */
  arm?: true;
  /**
   * `--runner-region`: its runners try `regions[0]` alone first, for its
   * cache, and the other regions only when the cloud refuses them there.
   * Without it, anycloud places each in the cheapest of `regions`.
   */
  preferred?: true;
}

/**
 * The OS every label names: the runner image's (`runner/Dockerfile`), the
 * same on every cloud and class (owner, 2026-11-24).
 */
const OS = 'ubuntu-2404';

/**
 * A class's label: `backmesh-ubuntu-2404-4vcpu`, on demand
 * `backmesh-ubuntu-2404-od-4vcpu`, KVM `backmesh-ubuntu-2404-kvm-4vcpu`.
 * The home cloud, the control plane's, has the plain labels; another cloud's
 * name it (`prefixed`, `backmesh-aws-ubuntu-2404-4vcpu`), so adding or
 * removing a cloud renames no label (owner, 2026-11-08).
 */
export const classLabel = (
  cloud: Cloud,
  prefixed: boolean,
  onDemand: boolean,
  kvm: boolean,
  vcpus: number,
) =>
  `backmesh-${prefixed ? `${cloud}-` : ''}${OS}-${kvm ? 'kvm-' : ''}${onDemand ? 'od-' : ''}${vcpus}vcpu`;

/** A GPU class's label, such as `backmesh-ubuntu-2404-gpu-od-t4` or `backmesh-azure-ubuntu-2404-gpu-t4`. */
export const gpuLabel = (cloud: Cloud, prefixed: boolean, onDemand: boolean) =>
  `backmesh-${prefixed ? `${cloud}-` : ''}${OS}-gpu-${onDemand ? 'od-' : ''}${GPU.model.toLowerCase()}`;

/** A high-memory class's label, such as `backmesh-ubuntu-2404-highmem-16vcpu` or `backmesh-aws-ubuntu-2404-highmem-od-16vcpu`. */
export const highmemLabel = (
  cloud: Cloud,
  prefixed: boolean,
  onDemand: boolean,
  vcpus: number,
) =>
  `backmesh-${prefixed ? `${cloud}-` : ''}${OS}-highmem-${onDemand ? 'od-' : ''}${vcpus}vcpu`;

/**
 * An arm64 class's label, such as `backmesh-ubuntu-2404-arm-od-4vcpu`,
 * `backmesh-gcp-ubuntu-2404-arm-4vcpu` or
 * `backmesh-ubuntu-2404-arm-highmem-16vcpu`.
 */
export const armLabel = (
  cloud: Cloud,
  prefixed: boolean,
  onDemand: boolean,
  vcpus: number,
  highmem = false,
) =>
  `backmesh-${prefixed ? `${cloud}-` : ''}${OS}-arm-${highmem ? 'highmem-' : ''}${onDemand ? 'od-' : ''}${vcpus}vcpu`;

/** A public class's label, such as `backmesh-ubuntu-2404-public-4vcpu`. */
export const publicLabel = (vcpus: number) =>
  `backmesh-${OS}-public-${vcpus}vcpu`;

/**
 * Where a spot class's reclaims count for the breaker, such as "aws spot":
 * a high-memory or arm64 family's spot capacity is its own, as KVM's and
 * GPU's are.
 */
export const spotCapacity = ({
  cloud,
  kvm,
  gpu,
  highmem,
  arm,
}: {
  cloud: Cloud;
  kvm: boolean;
  gpu?: string;
  highmem?: boolean;
  arm?: boolean;
}) =>
  `${cloud}${kvm ? ' KVM' : ''}${gpu ? ' GPU' : ''}${arm ? ' arm' : ''}${highmem ? ' high-memory' : ''} spot`;

/** Why `vmType`, offered in `details`, can't be a class's VM; undefined when it can. */
function shapeProblem(
  details: readonly VmTypeDetails[],
  vmType: string,
  vcpus: number,
  gibPerVcpu = GIB_PER_VCPU,
): string | undefined {
  const type = findVmType(details, vmType);
  if (!type) return;
  const memory = vcpus * gibPerVcpu;
  const gib = type.memoryGiB ?? 0;
  const least = vmType.startsWith('c4d-')
    ? Math.floor(vcpus * C4D_GIB_PER_VCPU)
    : memory;
  const fits =
    type.vCPUs === vcpus &&
    gib <= memory &&
    gib >= least &&
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
  /** The targets whose regions have no arm64 class. */
  noArm: CloudTarget[];
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
  // `install --public-repos`: the home cloud's `backmesh-ubuntu-2404-public-<n>vcpu` too.
  publicRepos = false,
): ClassPlan {
  const plan: ClassPlan = {
    classes: [],
    problems: [],
    noKvm: [],
    noGpu: [],
    noArm: [],
  };
  for (const target of targets) {
    const byRegion = [...(catalog.get(target.cloud) ?? [])];
    const fits = (
      details: readonly VmTypeDetails[],
      vmType: string,
      n: number,
      gibPerVcpu = GIB_PER_VCPU,
    ) =>
      !!findVmType(details, vmType) &&
      !shapeProblem(details, vmType, n, gibPerVcpu);
    // A KVM class tries the same types as the general one, in the same
    // order, filtered to the ones a runner region's catalog reports nested
    // virtualization for: GCP's `n2d` doesn't nest, and `n2` does
    // (anycloud's `src/shared/catalog/nested-virtualization.ts`), nor do
    // `c4d` and `c3d`. AWS's `m8a`, `m7a` and `m6a` don't nest, so KVM
    // classes get only `m8i` then `m7i`;
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
    // The on-demand types end with the spot ones (`VM_TYPES`).
    plan.problems.push(
      ...CLASS_VCPUS.flatMap((vcpus) =>
        VM_TYPES[target.cloud](vcpus, false).flatMap((vmType) => {
          const offered = byRegion.find(([, d]) => findVmType(d, vmType));
          return offered
            ? (shapeProblem(offered[1], vmType, vcpus) ?? [])
            : [`${vmType} isn't offered in ${where(target.cloud, names)}`];
        }),
      ),
      ...byRegion.flatMap(([region, details]) =>
        CLASS_VCPUS.some((vcpus) =>
          VM_TYPES[target.cloud](vcpus, false).some((t) =>
            fits(details, t, vcpus),
          ),
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
    // The high-memory classes: spot and on demand of each size, in the
    // regions that offer one of its types. Every runner region offers them
    // all, as the general classes' (`regions.ts`), so a type a region lacks
    // or of another shape is a problem, as theirs is.
    const highmem = [true, false].flatMap((spot) =>
      CLASS_VCPUS.map((vcpus): RunnerClass => {
        const vmTypes = HIGHMEM_TYPES[target.cloud](vcpus);
        return {
          ...target,
          label: highmemLabel(
            target.cloud,
            target.cloud !== home,
            !spot,
            vcpus,
          ),
          code: `${CLOUD_CODE[target.cloud][spot ? 0 : 1]}${HIGHMEM_SIZE[vcpus]}`,
          vcpus,
          spot,
          kvm: false,
          vmTypes,
          regions: byRegion.flatMap(([region, details]) =>
            vmTypes.some((t) => fits(details, t, vcpus, HIGHMEM_GIB_PER_VCPU))
              ? [region]
              : [],
          ),
          highmem: true,
        };
      }),
    );
    plan.problems.push(
      ...CLASS_VCPUS.flatMap((vcpus) =>
        HIGHMEM_TYPES[target.cloud](vcpus).flatMap((vmType) => {
          const offered = byRegion.find(([, d]) => findVmType(d, vmType));
          return offered
            ? (shapeProblem(offered[1], vmType, vcpus, HIGHMEM_GIB_PER_VCPU) ??
                [])
            : [`${vmType} isn't offered in ${where(target.cloud, names)}`];
        }),
      ),
    );
    // The arm64 classes, general and high-memory: spot and on demand of
    // each size, in the regions that offer one of its types. Unlike the
    // other classes', their types aren't in every runner region (GCP's
    // `t2a` is in few, and `c4a` not in all), so a class launches only
    // where one is, and a cloud without any gets no arm64 labels and
    // blocks nothing, as GPU's.
    const letters = CLOUD_CODE[target.cloud];
    const arm = [false, true].flatMap((himem) =>
      [true, false].flatMap((spot) =>
        CLASS_VCPUS.flatMap((vcpus): RunnerClass[] => {
          const letter = letters[spot ? 7 : 8];
          const vmTypes = (himem ? ARM_HIGHMEM_TYPES : ARM_TYPES)[target.cloud](
            vcpus,
          );
          const gib = himem ? HIGHMEM_GIB_PER_VCPU : GIB_PER_VCPU;
          const regions = byRegion.flatMap(([region, details]) =>
            vmTypes.some((t) => fits(details, t, vcpus, gib)) ? [region] : [],
          );
          if (!letter || !regions.length) return [];
          return [
            {
              ...target,
              label: armLabel(
                target.cloud,
                target.cloud !== home,
                !spot,
                vcpus,
                himem,
              ),
              code: `${letter}${himem ? HIGHMEM_SIZE[vcpus] : vcpus.toString(36)}`,
              vcpus,
              spot,
              kvm: false,
              vmTypes,
              regions,
              arm: true,
              ...(himem && { highmem: true as const }),
            },
          ];
        }),
      ),
    );
    if (!arm.length) plan.noArm.push(target);
    plan.classes.push(...classes, ...gpu, ...highmem, ...arm);
    if (publicRepos && target.cloud === home) {
      plan.classes.push(
        ...classes.flatMap((c) =>
          c.spot &&
          !c.kvm &&
          (PUBLIC_VCPUS as readonly number[]).includes(c.vcpus)
            ? [
                {
                  ...c,
                  label: publicLabel(c.vcpus),
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
