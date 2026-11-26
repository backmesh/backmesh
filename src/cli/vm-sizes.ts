// The sizes of the always-on VMs install creates on Azure, read before any
// sign-in through the user's `az`: a subscription may be refused a size in
// a region (`NotAvailableForSubscription`, as sponsorship and trial offers
// are, some in every region), so each VM takes the first of its sizes the
// region offers, or have no quota for that size's family (a new subscription's
// `standardDSv5Family` may be 0), which `api create` and `vm` otherwise
// find only after the GitHub sign-in and the App install. AWS and GCP have
// no such per-account restriction: every account may launch `t3` and `e2`
// types in each US region that offers them, as all of backmesh's do. Their
// quotas are `alwaysOnQuota`'s, in install.
import { UsageError } from './errors.js';
import { GEOS, RUNNER_REGIONS, type RunCommand } from '../runners/regions.js';
import { usageNamed, type Usage } from '../runners/quota.js';

export interface AlwaysOn {
  // Such as "the control plane's VM".
  what: string;
  // In the order it takes them.
  sizes: readonly string[];
}

// A region install may create the always-on VMs in, with each one's size
// there, in `vms`' order.
export interface AlwaysOnRegion {
  region: string;
  sizes: string[];
}

// Each always-on size's vCPUs: t3.medium and t3.small, e2-medium and
// e2-small, and every Azure size install takes (`MANAGEMENT_VMS`,
// `LISTENER_VM_TYPES`).
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

// A region's sizes for the VMs, and why it can't take them: one line per
// VM it offers no size, or per quota without room.
interface Fit {
  sizes: string[];
  reasons: { name?: string; line: string }[];
}

interface Sized {
  what: string;
  size: string;
}

// Its quota's usage name, such as `standardDSv5Family`.
const familyOf = (skus: readonly Sku[], size: string) =>
  skus.find((s) => same(s.name ?? '')(size))?.family;

// The vCPUs free in the quota `name`; Infinity when `usage` doesn't name
// it, as such a quota passes.
const free = (usage: readonly Usage[], name: string) => {
  const found = usageNamed(usage, name);
  const left = found && found.limit - found.current;
  return left === undefined || !Number.isFinite(left) ? Infinity : left;
};

// The quotas in `usage` without room for `vms`, one line each: an
// on-demand VM counts against its family's vCPUs and the regional ones
// (`cores`).
const short = (
  skus: readonly Sku[],
  vms: readonly Sized[],
  region: string,
  usage: readonly Usage[],
) => {
  const need = new Map<string, Sized[]>([['cores', [...vms]]]);
  for (const vm of vms) {
    const family = familyOf(skus, vm.size);
    if (family) need.set(family, [...(need.get(family) ?? []), vm]);
  }
  return [...need].flatMap(([name, mine]) => {
    const left = free(usage, name);
    const vcpus = mine.length * ALWAYS_ON_VCPUS;
    if (left >= vcpus) return [];
    const what = mine.map((vm) => `${vm.what} (${vm.size})`).join(' and ');
    return [
      {
        name,
        line: `Azure's ${name} quota in ${region} has ${Math.max(left, 0)} vCPUs free (limit ${usageNamed(usage, name)!.limit}), under the ${vcpus} for ${what}.`,
      },
    ];
  });
};

// The entries for `vms`' sizes in `regions`, projected to what `refused`
// reads. One call: each `az vm list-skus` downloads Azure's whole catalog,
// and one per region at once starved a GitHub-hosted runner. That download
// can take minutes, so it gets three, and a second try. One region's
// alone is filtered by Azure, and quicker.
const readSkus = (
  vms: readonly AlwaysOn[],
  regions: readonly string[],
  command: RunCommand,
) => {
  const sizes = [...new Set(vms.flatMap((vm) => vm.sizes))];
  const read = () =>
    command(
      [
        ...['az', 'vm', 'list-skus', '--all'],
        ...(regions.length === 1 ? ['--location', regions[0]!] : []),
        ...['--resource-type', 'virtualMachines', '--query'],
        `[?${sizes.map((size) => `name=='${size}'`).join(' || ')}].{name:name,family:family,locations:locations,restrictions:restrictions}`,
        ...['--output', 'json'],
      ],
      undefined,
      180_000,
    ).then((out) => JSON.parse(out) as Sku[]);
  return read().catch(read);
};

/**
 * Where install creates `vms`, each at the first of its sizes the region
 * offers: the first of `candidates` offering each VM a size, with quota for
 * them in `usage` (when given: a resumed control plane's
 * VM may count there already), and with `fallback` (a new control plane)
 * the passing regions after it, which install tries in turn when Azure
 * refuses the create for capacity or quota. `advice` ends the error when
 * none passes, or when the sizes can't be read.
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
): Promise<AlwaysOnRegion[]> {
  const region = candidates[0]!;
  const what = vms.map((vm) => vm.what).join(' and ');
  const all = await readSkus(vms, candidates, command).catch(
    (cause: unknown) => {
      // `execFile`'s error: killed at the timeout, or az's own last line.
      const { killed, stderr, message } = cause as {
        killed?: boolean;
        stderr?: string;
        message?: string;
      };
      const reason = killed
        ? 'it timed out after 3 minutes, twice'
        : (stderr?.split('\n').findLast((line) => line.trim()) ??
          String(message ?? cause).split('\n')[0]);
      throw new UsageError(
        `Azure's VM sizes couldn't be read with \`az vm list-skus\` (${reason}), so the plan can't tell which region this subscription may create ${what} in. Check that \`az\` answers, then run install again.`,
        { cause },
      );
    },
  );
  // Why each candidate can't take `vms`, one line each; none when it can.
  // A region whose usage can't be read passes, as `api create` finds
  // out.
  const unread: string[] = [];
  const why = async (r: string): Promise<Fit> => {
    const offered = vms.map((vm) =>
      vm.sizes.filter((size) => !refused(all, size, r)),
    );
    const none = vms.flatMap((vm, i) =>
      offered[i]!.length
        ? []
        : [
            {
              line: `Azure won't create ${vm.what} in ${r} for this subscription in any of its sizes: ${vm.sizes.map((size) => `${size} (${refused(all, size, r)})`).join(', ')}.`,
            },
          ],
    );
    if (none.length) return { sizes: [], reasons: none };
    const read = usage && (await usage(r).catch(() => undefined));
    if (usage && !read) unread.push(r);
    // Each VM's first offered size whose family has room beside the VMs
    // before it, else its first, whose quota `short` names.
    const taken = new Map<string, number>();
    const sizes = offered.map((mine) => {
      const room = (size: string) => {
        const family = familyOf(all, size);
        return (
          !read ||
          !family ||
          free(read, family) - (taken.get(family) ?? 0) >= ALWAYS_ON_VCPUS
        );
      };
      const size = mine.find(room) ?? mine[0]!;
      const family = familyOf(all, size);
      if (family) {
        taken.set(family, (taken.get(family) ?? 0) + ALWAYS_ON_VCPUS);
      }
      return size;
    });
    const sized = vms.map((vm, i) => ({ what: vm.what, size: sizes[i]! }));
    return { sizes, reasons: read ? short(all, sized, r, read) : [] };
  };
  const results: Fit[] = [];
  for (const r of candidates) results.push(await why(r));
  const reasons = results.map((result) => result.reasons);
  const lines = reasons[0]!.map(({ line }) => line);
  if (unread.length) {
    lines.push(
      `Azure's vCPU quotas couldn't be read in ${unread.join(', ')}, so the plan takes them to have room for ${vms.map((vm) => vm.what).join(' and ')}.`,
    );
  }
  const passing = candidates.flatMap((r, i) =>
    reasons[i]!.length ? [] : [{ region: r, sizes: results[i]!.sizes }],
  );
  if (!passing.length) {
    const quotas = [
      ...new Set(reasons.flat().flatMap(({ name }) => name ?? [])),
    ];
    throw new UsageError(
      [
        ...lines,
        `No Azure region install tries (${candidates.join(', ')}) offers this subscription a size for ${what}${quotas.length ? ' with quota for it' : ''}. ${advice}${quotas.length ? ` Or raise Azure's ${quotas.join(' and ')} vCPU quota in ${candidates.length > 1 ? 'one of those regions' : region}.` : ''}`,
      ].join('\n'),
    );
  }
  lines.forEach((line) => report.print(line));
  return fallback ? passing : passing.slice(0, 1);
}

/** `region` first, then its geo's other Azure runner regions when it's one of them. */
export function candidateRegions(region: string) {
  const geo = GEOS.find((g) => RUNNER_REGIONS[g].azure.includes(region));
  return geo
    ? [region, ...RUNNER_REGIONS[geo].azure.filter((r) => r !== region)]
    : [region];
}

// Azure's refusal of a create for capacity or a size the region can't take
// now: `SkuNotAvailable`, an allocation failure, or a family or regional
// quota the plan read with room that usage took since (`QuotaExceeded`, or
// `OperationNotAllowed` "exceeding approved ... quota").
export const noCapacity = (error: unknown) =>
  /SkuNotAvailable|AllocationFailed|Overconstrained\w*AllocationRequest|QuotaExceeded|exceeding approved/.test(
    String(error),
  );
