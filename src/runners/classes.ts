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
 */
export const VM_TYPES: Record<Cloud, (vcpus: number) => string[]> = {
  aws: (n) => ['m8i', 'm7a', 'm7i', 'm6a'].map((f) => `${f}.${AWS_SIZE[n]}`),
  gcp: (n) => [`n2-standard-${n}`, `n2d-standard-${n}`],
  azure: (n) => [
    `Standard_D${n}ads_v5`,
    `Standard_D${n}as_v5`,
    `Standard_D${n}s_v5`,
  ],
};

// The code's first character: the cloud, whether the class is spot, and
// whether it's a KVM or a public class.
const CLOUD_CODE: Record<
  Cloud,
  [
    spot: string,
    onDemand: string,
    kvmSpot: string,
    kvmOnDemand: string,
    publicSpot: string,
  ]
> = {
  aws: ['a', 'b', 'k', 'l', 'c'],
  gcp: ['g', 'h', 'm', 'n', 'i'],
  azure: ['z', 'y', 'v', 'w', 'x'],
};

/** `backmesh-public-<n>`'s sizes: the home cloud's spot, no KVM. */
export const PUBLIC_VCPUS = [2, 4] as const;
/** The vCPUs they may hold at once. */
export const PUBLIC_VCPU_CAP = 32;

/** The cloud, spot-ness and vCPUs a runner class's code names. */
export function codeClass(
  code: string,
): { cloud: Cloud; spot: boolean; vcpus: number } | undefined {
  for (const [cloud, letters] of Object.entries(CLOUD_CODE)) {
    const i = letters.indexOf(code[0] ?? '');
    const vcpus = parseInt(code.slice(1), 36);
    if (i >= 0 && Number.isInteger(vcpus) && vcpus > 0) {
      return { cloud: cloud as Cloud, spot: i % 2 === 0, vcpus };
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

/** Where a spot class's reclaims count for the breaker, such as "aws spot". */
export const spotCapacity = ({ cloud, kvm }: { cloud: Cloud; kvm: boolean }) =>
  `${cloud}${kvm ? ' KVM' : ''} spot`;

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
  const plan: ClassPlan = { classes: [], problems: [], noKvm: [] };
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
    // `m7a` and `m6a` don't nest, so KVM classes get only `m8i` then `m7i`;
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
    const kvmTypes = (vcpus: number) =>
      VM_TYPES[target.cloud](vcpus).filter((vmType) =>
        byRegion.some(([, details]) => nests(details, vmType, vcpus)),
      );
    const classes = [false, true].flatMap((kvm) =>
      [true, false].flatMap((spot) =>
        CLASS_VCPUS.flatMap((vcpus): RunnerClass[] => {
          const ok = kvm ? nests : fits;
          const vmTypes = kvm ? kvmTypes(vcpus) : VM_TYPES[target.cloud](vcpus);
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
    plan.problems.push(
      ...CLASS_VCPUS.flatMap((vcpus) =>
        VM_TYPES[target.cloud](vcpus).flatMap((vmType) => {
          const offered = byRegion.find(([, d]) => findVmType(d, vmType));
          return offered
            ? (shapeProblem(offered[1], vmType, vcpus) ?? [])
            : [`${vmType} isn't offered in ${where(target.cloud, names)}`];
        }),
      ),
      ...byRegion.flatMap(([region, details]) =>
        CLASS_VCPUS.some((vcpus) =>
          VM_TYPES[target.cloud](vcpus).some((t) => fits(details, t, vcpus)),
        )
          ? []
          : [`${target.cloud} ${region} offers none of the runners' VM types`],
      ),
    );
    if (!classes.some((c) => c.kvm)) plan.noKvm.push(target);
    plan.classes.push(...classes);
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
