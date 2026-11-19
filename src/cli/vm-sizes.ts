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
  return sku.restrictions?.find(
    (r) =>
      r.type === 'Location' && r.restrictionInfo?.locations?.some(same(region)),
  )?.reasonCode;
};

/**
 * The regions install tries, in order, for `vms`: `region` and then, for a
 * US region, backmesh's other US regions, each offering every size. A
 * capacity refusal on create moves them to the next. Undefined when `az`
 * couldn't be read, so install tries `region` alone.
 */
export async function alwaysOnRegions(
  region: string,
  vms: readonly AlwaysOn[],
  command: RunCommand,
  report: { print: (line: string) => void },
): Promise<string[] | undefined> {
  const names = vms.map((vm) => `name=='${vm.size}'`).join(' || ');
  const skus = await command([
    ...['az', 'vm', 'list-skus', '--all'],
    ...['--resource-type', 'virtualMachines', '--query', `[?${names}]`],
    ...['--output', 'json'],
  ])
    .then((out) => JSON.parse(out) as Sku[])
    .catch(() => undefined);
  if (!skus) {
    report.print(
      `Azure's VM sizes couldn't be read, so install tries ${region} alone.`,
    );
    return undefined;
  }
  const lines = vms.flatMap((vm) => {
    const why = refused(skus, vm.size, region);
    return why
      ? [
          `Azure won't create ${vm.what} (${vm.size}) in ${region} for this subscription: ${why}.`,
        ]
      : [];
  });
  const candidates = RUNNER_REGIONS.azure.includes(region)
    ? [region, ...RUNNER_REGIONS.azure.filter((r) => r !== region)]
    : [region];
  const regions = candidates.filter((r) =>
    vms.every((vm) => !refused(skus, vm.size, r)),
  );
  const all = vms.map((vm) => `${vm.what} (${vm.size})`).join(' and ');
  if (!regions.length) {
    throw new UsageError(
      [
        ...lines,
        `No Azure region backmesh tries offers this subscription ${vms.length > 1 ? 'both ' : ''}${all}: ${candidates.join(', ')}. Pass --control-plane azure:<region> with one that does, or use another subscription.`,
      ].join('\n'),
    );
  }
  lines.forEach((line) => report.print(line));
  const [first, ...rest] = regions;
  if (rest.length) {
    report.print(
      `If Azure has no capacity for ${vms.length > 1 ? 'them' : 'it'} in ${first}, install tries ${rest.join(', ')}, in turn.`,
    );
  }
  return regions;
}

// Azure's refusal of a create for capacity or a size the region can't take
// now: `SkuNotAvailable`, or an allocation failure.
export const noCapacity = (error: unknown) =>
  /SkuNotAvailable|AllocationFailed|OverconstrainedAllocationRequest/.test(
    String(error),
  );
