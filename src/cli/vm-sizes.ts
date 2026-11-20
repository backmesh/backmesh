// The sizes of the always-on VMs install creates on Azure, read before any
// sign-in through the user's `az`: a subscription may be refused a size in
// a region (`NotAvailableForSubscription`, as sponsorship and trial offers
// are), or have no quota for its family (a new subscription's
// `standardDSv5Family` may be 0), which `cluster create` and `vm` otherwise
// find only after the GitHub sign-in and the App install. AWS and GCP have
// no such per-account restriction: every account may launch `t3` and `e2`
// types in each US region that offers them, as all of backmesh's do. Their
// quotas are `alwaysOnQuota`'s, in install.
import { UsageError } from './errors.js';
import { RUNNER_REGIONS, type RunCommand } from '../runners/regions.js';
import { usageNamed, type Usage } from '../runners/quota.js';

export interface AlwaysOn {
  // Such as "the control plane's VM".
  what: string;
  size: string;
}

// Each always-on size's vCPUs: t3.large and t3.small, e2-standard-2 and
// e2-small, Standard_D2s_v5 and Standard_B2s.
export const ALWAYS_ON_VCPUS = 2;

interface Sku {
  name?: string;
  // Its quota's usage name, such as `standardDSv5Family`.
  family?: string;
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

// The quotas in `usage` without room for `vms`, one line each: an
// on-demand VM counts against its family's vCPUs and the regional ones
// (`cores`). A quota `usage` doesn't name passes.
const short = (
  skus: readonly Sku[],
  vms: readonly AlwaysOn[],
  region: string,
  usage: readonly Usage[],
) => {
  const need = new Map<string, AlwaysOn[]>([['cores', [...vms]]]);
  for (const vm of vms) {
    const family = skus.find((s) => same(s.name ?? '')(vm.size))?.family;
    if (family) need.set(family, [...(need.get(family) ?? []), vm]);
  }
  return [...need].flatMap(([name, mine]) => {
    const found = usageNamed(usage, name);
    const free = found && found.limit - found.current;
    const vcpus = mine.length * ALWAYS_ON_VCPUS;
    if (free === undefined || !Number.isFinite(free) || free >= vcpus) {
      return [];
    }
    const what = mine.map((vm) => `${vm.what} (${vm.size})`).join(' and ');
    return [
      {
        name,
        line: `Azure's ${name} quota in ${region} has ${Math.max(free, 0)} vCPUs free (limit ${found!.limit}), under the ${vcpus} for ${what}.`,
      },
    ];
  });
};

// Every region's entries for `vms`' sizes, projected to what `refused`
// reads. One call: each `az vm list-skus` downloads Azure's whole catalog,
// and one per region at once starved a GitHub-hosted runner.
const readSkus = (vms: readonly AlwaysOn[], command: RunCommand) =>
  command([
    ...['az', 'vm', 'list-skus', '--all'],
    ...['--resource-type', 'virtualMachines', '--query'],
    `[?${vms.map((vm) => `name=='${vm.size}'`).join(' || ')}].{name:name,family:family,locations:locations,restrictions:restrictions}`,
    ...['--output', 'json'],
  ]).then((out) => JSON.parse(out) as Sku[]);

/**
 * Where install creates `vms`: the first of `candidates` offering every
 * size with quota for it in `usage` (when given: a resumed control plane's
 * VM may count there already), and with `fallback` (a new control plane)
 * the passing regions after it, which install tries in turn when Azure
 * refuses the create for capacity or quota. `advice` ends the error when
 * none passes. Undefined when the sizes couldn't be read, so install tries
 * the first candidate alone.
 */
export async function alwaysOnRegions(
  candidates: readonly string[],
  vms: readonly AlwaysOn[],
  {
    fallback,
    advice,
    usage,
  }: {
    fallback: boolean;
    advice: string;
    usage?: (region: string) => Promise<Usage[]>;
  },
  command: RunCommand,
  report: { print: (line: string) => void },
): Promise<string[] | undefined> {
  const region = candidates[0]!;
  const all = await readSkus(vms, command).catch(() => undefined);
  if (!all) {
    report.print(
      `Azure's VM sizes couldn't be read, so install tries ${region} alone.`,
    );
    return undefined;
  }
  // Why each candidate can't take `vms`, one line each; none when it can.
  // A region whose usage can't be read passes, as `cluster create` finds
  // out.
  const unread: string[] = [];
  const why = async (r: string) => {
    const sizes = vms.flatMap((vm) => {
      const reason = refused(all, vm.size, r);
      return reason
        ? [
            {
              line: `Azure won't create ${vm.what} (${vm.size}) in ${r} for this subscription: ${reason}.`,
            },
          ]
        : [];
    });
    if (sizes.length || !usage) return sizes;
    const read = await usage(r).catch(() => undefined);
    if (!read) unread.push(r);
    return read ? short(all, vms, r, read) : [];
  };
  const reasons: { name?: string; line: string }[][] = [];
  for (const r of candidates) reasons.push(await why(r));
  const lines = reasons[0]!.map(({ line }) => line);
  if (unread.length) {
    lines.push(
      `Azure's vCPU quotas couldn't be read in ${unread.join(', ')}, so the plan takes them to have room for ${vms.map((vm) => vm.what).join(' and ')}.`,
    );
  }
  const passing = candidates.filter((_, i) => !reasons[i]!.length);
  if (!passing.length) {
    const what = vms.map((vm) => `${vm.what} (${vm.size})`).join(' and ');
    const quotas = [
      ...new Set(reasons.flat().flatMap(({ name }) => name ?? [])),
    ];
    throw new UsageError(
      [
        ...lines,
        `No Azure region install tries (${candidates.join(', ')}) offers this subscription ${what}${quotas.length ? ' with quota for it' : ''}. ${advice}${quotas.length ? ` Or raise Azure's ${quotas.join(' and ')} vCPU quota in ${candidates.length > 1 ? 'one of those regions' : region}.` : ''}`,
      ].join('\n'),
    );
  }
  lines.forEach((line) => report.print(line));
  const [first, ...rest] = passing;
  if (!fallback) return [first!];
  if (rest.length) {
    report.print(
      `If Azure has no capacity or quota for the control plane's VM in ${first} when install creates it, install tries ${rest.join(', ')}, in turn.`,
    );
  }
  return passing;
}

/** `region` first, then backmesh's other US regions when it's one of them. */
export const candidateRegions = (region: string) =>
  RUNNER_REGIONS.azure.includes(region)
    ? [region, ...RUNNER_REGIONS.azure.filter((r) => r !== region)]
    : [region];

// Azure's refusal of a create for capacity or a size the region can't take
// now: `SkuNotAvailable`, an allocation failure, or a family or regional
// quota the plan read with room that usage took since (`QuotaExceeded`).
export const noCapacity = (error: unknown) =>
  /SkuNotAvailable|AllocationFailed|Overconstrained\w*AllocationRequest|QuotaExceeded/.test(
    String(error),
  );
