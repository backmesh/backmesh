// The sizes of the always-on VMs install creates on Azure, read before any
// sign-in through the user's `az`: a subscription may be refused a size in
// a region (`NotAvailableForSubscription`, as sponsorship and trial offers
// are), which `cluster create` and `vm` otherwise find only after the
// GitHub sign-in and the App install. AWS and GCP have no such per-account
// restriction: every account may launch `t3` and `e2` types in each US
// region that offers them, as all of backmesh's do.
import { UsageError } from './errors.js';
import { RUNNER_REGIONS, type RunCommand } from '../runners/regions.js';

export interface AlwaysOn {
  // Such as "the control plane's VM".
  what: string;
  size: string;
}

interface Sku {
  name?: string;
  locations?: string[];
  restrictions?: {
    type?: string;
    reasonCode?: string;
    restrictionInfo?: { locations?: string[] | null };
  }[];
}

const same = (a: string) => (b: string) => a.toLowerCase() === b.toLowerCase();

// Why `region` can't take `size`; undefined when it can. A `Zone`
// restriction leaves the region's other zones.
const refused = (skus: readonly Sku[], size: string, region: string) => {
  const sku = skus.find(
    (s) => same(s.name ?? '')(size) && s.locations?.some(same(region)),
  );
  if (!sku) return "it isn't offered there";
  const restriction = sku.restrictions?.find(
    (r) =>
      r.type === 'Location' && r.restrictionInfo?.locations?.some(same(region)),
  );
  return restriction && (restriction.reasonCode ?? 'restricted');
};

// A region's entries for `vms`' sizes, projected to what `refused` reads.
const readSkus = (
  region: string,
  vms: readonly AlwaysOn[],
  command: RunCommand,
) =>
  command([
    ...['az', 'vm', 'list-skus', '--all', '--location', region],
    ...['--resource-type', 'virtualMachines', '--query'],
    `[?${vms.map((vm) => `name=='${vm.size}'`).join(' || ')}].{name:name,locations:locations,restrictions:restrictions}`,
    ...['--output', 'json'],
  ]).then((out) => JSON.parse(out) as Sku[]);

/**
 * Where install creates `vms`: the first of `candidates` offering every
 * size, and with `fallback` (a new control plane) the passing regions after
 * it, which install tries in turn when Azure has no capacity on create.
 * Undefined when `az` couldn't be read, so install tries `candidates[0]`
 * alone.
 */
export async function alwaysOnRegions(
  candidates: readonly string[],
  vms: readonly AlwaysOn[],
  fallback: boolean,
  command: RunCommand,
  report: { print: (line: string) => void },
): Promise<string[] | undefined> {
  const region = candidates[0]!;
  const skus = await Promise.all(
    candidates.map((r) => readSkus(r, vms, command)),
  ).catch(() => undefined);
  if (!skus) {
    report.print(
      `Azure's VM sizes couldn't be read, so install tries ${region} alone.`,
    );
    return undefined;
  }
  const all = skus.flat();
  const lines = vms.flatMap((vm) => {
    const why = refused(all, vm.size, region);
    return why
      ? [
          `Azure won't create ${vm.what} (${vm.size}) in ${region} for this subscription: ${why}.`,
        ]
      : [];
  });
  const passing = candidates.filter((r) =>
    vms.every((vm) => !refused(all, vm.size, r)),
  );
  if (!passing.length) {
    const what = vms.map((vm) => `${vm.what} (${vm.size})`).join(' and ');
    throw new UsageError(
      [
        ...lines,
        `No Azure region install tries (${candidates.join(', ')}) offers this subscription ${what}. ${fallback ? 'Pass --control-plane azure:<region> with a region that does, or use another subscription.' : 'Use another subscription.'}`,
      ].join('\n'),
    );
  }
  lines.forEach((line) => report.print(line));
  const [first, ...rest] = passing;
  if (!fallback) return [first!];
  if (rest.length) {
    report.print(
      `If Azure has no capacity for the control plane's VM in ${first} when install creates it, install tries ${rest.join(', ')}, in turn.`,
    );
  }
  return passing;
}

/** `region` first, then backmesh's other US regions when it's one of them. */
export const candidateRegions = (region: string) =>
  RUNNER_REGIONS.azure.includes(region)
    ? [region, ...RUNNER_REGIONS.azure.filter((r) => r !== region)]
    : [region];

/**
 * Where an earlier install's Azure control plane named `name` was started,
 * such as one stopped after a capacity fallback: `cluster create` resumes it
 * by its name tag in any region (`seed/azure.ts`'s `findByName`), so a
 * re-run must use its region.
 */
export const startedRegion = (name: string, command: RunCommand) =>
  command([
    ...['az', 'group', 'list', '--tag', `anycloud_cluster_name=${name}`],
    ...['--query', '[0].location', '--output', 'tsv'],
  ]).then(
    (out) => out.trim() || undefined,
    () => undefined,
  );

// Azure's refusal of a create for capacity or a size the region can't take
// now: `SkuNotAvailable`, or an allocation failure.
export const noCapacity = (error: unknown) =>
  /SkuNotAvailable|AllocationFailed|OverconstrainedAllocationRequest/.test(
    String(error),
  );
