// The vCPU quotas the runners' VMs count against: a region's spot and
// on-demand vCPUs for the classes' families.
import type { AnycloudApi } from '../anycloud/client.js';
import type { Cloud } from './classes.js';
import type { RunCommand } from './regions.js';

/**
 * The regional spot and on-demand vCPU quotas: AWS's Service Quotas codes
 * and Azure's compute usage names, as anycloud reads them
 * (`src/shared/quota-resolvers/aws.ts:17`, `azure-identity.ts:73-74`), and
 * where to raise them.
 */
const QUOTA = {
  spot: {
    aws: [
      'L-34B43A08',
      'EC2 "All Standard (A, C, D, H, I, M, R, T, Z) Spot Instance Requests" (L-34B43A08)',
    ],
    azure: ['lowPriorityCores', '"Total Regional Low-priority vCPUs"'],
  },
  onDemand: {
    aws: [
      'L-1216C47A',
      'EC2 "Running On-Demand Standard (A, C, D, H, I, M, R, T, Z) instances" (L-1216C47A)',
    ],
    azure: ['cores', '"Total Regional vCPUs"'],
  },
} as const;

/** A region's spot and on-demand vCPU limits; GCP's aren't read. */
export interface QuotaLimits {
  spot?: number;
  onDemand?: number;
}

/** The default class's vCPUs: a quota under it runs no `backmesh-4` job. */
const DEFAULT_VCPUS = 4;

/**
 * Reads the region's limits through the user's own signed-in cloud CLI, for
 * install's plan before any credential exists on a control plane: anycloud's
 * `cluster create` reads no quota. backmesh links no cloud SDK.
 */
export async function readQuota(
  cloud: Cloud,
  region: string,
  command: RunCommand,
): Promise<QuotaLimits> {
  // Google's quotas aren't read, as anycloud's `quota status` doesn't
  // read them (`src/api/services/quota/handler.ts:47-62`).
  if (cloud === 'gcp') return {};
  if (cloud === 'aws') {
    const read = async (code: string) =>
      Number(
        await command([
          ...['aws', 'service-quotas', 'get-service-quota'],
          ...['--service-code', 'ec2', '--quota-code', code],
          ...['--region', region, '--query', 'Quota.Value'],
          ...['--output', 'text'],
        ]),
      );
    return {
      spot: await read(QUOTA.spot.aws[0]),
      onDemand: await read(QUOTA.onDemand.aws[0]),
    };
  }
  const usage = JSON.parse(
    await command([
      ...['az', 'vm', 'list-usage', '--location', region],
      ...['--output', 'json'],
    ]),
  ) as { name?: { value?: string }; limit?: number | string }[];
  const read = (name: string) => {
    const found = usage.find(
      (entry) => entry.name?.value?.toLowerCase() === name.toLowerCase(),
    );
    return found && Number(found.limit);
  };
  return {
    spot: read(QUOTA.spot.azure[0]),
    onDemand: read(QUOTA.onDemand.azure[0]),
  };
}

export interface QuotaCheck {
  /** The vCPU limit, summed over the regions read; undefined on GCP. */
  vcpus?: number;
  /** The quota to raise. */
  increase: string;
  /** The regions whose limit wasn't read, when another's was. */
  unread?: string[];
  /** Why the runners can't start. */
  problem?: string;
}

/** The quota's short name: AWS's code, or Azure's usage name. */
export function quotaCode(cloud: Exclude<Cloud, 'gcp'>, spot: boolean) {
  return cloud === 'aws'
    ? QUOTA[spot ? 'spot' : 'onDemand'].aws[0]
    : QUOTA[spot ? 'spot' : 'onDemand'].azure[1];
}

/**
 * A runner region whose spot or on-demand quota can't fit one VM of some of
 * the cloud's classes: the listener skips it for those, keeping it in the
 * list, until a read shows the quota raised. For install's plan, such as
 * "us-west-1: spot quota 5 vCPU, skipped for backmesh-8, backmesh-16; raise
 * L-34B43A08 to use it". GCP's quotas aren't read, so it's never skipped.
 */
export function skippedRegions(
  cloud: Cloud,
  limits: ReadonlyMap<string, QuotaLimits>,
  classes: readonly {
    label: string;
    vcpus: number;
    spot: boolean;
    regions: readonly string[];
  }[],
): string[] {
  if (cloud === 'gcp') return [];
  const lines: string[] = [];
  for (const [region, limit] of limits) {
    for (const spot of [true, false]) {
      const vcpus = spot ? limit.spot : limit.onDemand;
      if (vcpus === undefined || !Number.isFinite(vcpus)) continue;
      const mine = classes.filter(
        (c) => c.spot === spot && c.regions.includes(region),
      );
      const under = mine.filter((c) => c.vcpus > vcpus);
      if (!under.length) continue;
      const which =
        under.length === mine.length
          ? ''
          : ` for ${under.map((c) => c.label).join(', ')}`;
      lines.push(
        `${region}: ${spot ? 'spot' : 'on-demand'} quota ${vcpus} vCPU, skipped${which}; raise ${quotaCode(cloud, spot)} to use it`,
      );
    }
  }
  return lines;
}

/**
 * The labels that would start no runners: every one of their runner
 * regions' quota for their kind (spot, or on demand for an `od` label) is
 * under one of their VMs, and a spot label never falls back on demand
 * (owner, 2026-11-09). One line each for install's and upgrade's plans.
 */
export function startsNoRunners(
  cloud: Cloud,
  limits: ReadonlyMap<string, QuotaLimits>,
  classes: readonly {
    label: string;
    vcpus: number;
    spot: boolean;
    regions: readonly string[];
  }[],
): string[] {
  if (cloud === 'gcp') return [];
  return classes.flatMap((c) => {
    const each = c.regions.map((region) => {
      const vcpus = c.spot
        ? limits.get(region)?.spot
        : limits.get(region)?.onDemand;
      return { region, vcpus };
    });
    const under = each.every(
      ({ vcpus }) =>
        vcpus !== undefined && Number.isFinite(vcpus) && vcpus < c.vcpus,
    );
    if (!under || !each.length) return [];
    const kind = c.spot ? 'spot' : 'on-demand';
    return [
      `${c.label} would start no runners: every runner region's ${kind} quota is under one ${c.vcpus}-vCPU runner (${each.map(({ region, vcpus }) => `${region} ${vcpus} vCPU`).join(', ')}); raise ${quotaCode(cloud, c.spot)} in ${each.map(({ region }) => region).join(' or ')} to use it.`,
    ];
  });
}

/** The AWS or Azure quota to raise for more spot or on-demand vCPUs. */
export function quotaToRaise(
  cloud: Exclude<Cloud, 'gcp'>,
  regions: readonly string[],
  spot: boolean,
): string {
  const [, quota] = QUOTA[spot ? 'spot' : 'onDemand'][cloud];
  return `${quota} in ${regions.join(', ')}`;
}

/**
 * Runners past the quota wait in anycloud's launch retries, so the quotas of
 * the runners' regions, summed, cap how many jobs run at once; under one
 * `backmesh-4` VM it's a problem.
 */
export function quotaCheck(
  cloud: Cloud,
  regions: readonly string[],
  limits: ReadonlyMap<string, QuotaLimits>,
  spot: boolean,
): QuotaCheck {
  const names = regions.join(', ');
  if (cloud === 'gcp') {
    // Google's quota names (external): spot VMs count against
    // PREEMPTIBLE_CPUS when the region sets it, and against the family
    // quotas otherwise.
    return {
      increase: `"CPUS_ALL_REGIONS" (32 by default) and ${names}'s ${spot ? '"PREEMPTIBLE_CPUS", ' : '"CPUS", '}"N2D_CPUS" and "N2_CPUS"`,
    };
  }
  const [name] = QUOTA[spot ? 'spot' : 'onDemand'][cloud];
  const increase = quotaToRaise(cloud, regions, spot);
  const each = regions.map((region) => {
    const found = limits.get(region);
    const vcpus = spot ? found?.spot : found?.onDemand;
    return vcpus !== undefined && Number.isFinite(vcpus) ? vcpus : undefined;
  });
  const read = each.filter((v) => v !== undefined);
  if (!read.length) {
    const problem = `${cloud} reported no ${name} limit in ${names}.`;
    return { increase, problem };
  }
  const vcpus = read.reduce((sum, v) => sum + v, 0);
  const unread = regions.filter((_, i) => each[i] === undefined);
  const problem = `${cloud} allows ${vcpus} ${spot ? 'spot' : 'on-demand'} vCPUs, under one ${DEFAULT_VCPUS}-vCPU VM; raise ${increase}`;
  return {
    vcpus,
    increase,
    ...(unread.length && { unread }),
    ...(vcpus < DEFAULT_VCPUS && { problem }),
  };
}

// The control plane's current spot and on-demand vCPU limits for the
// region: AWS's standard-family Service Quotas and Azure's regional cores,
// as anycloud keys them (`awsQuotaResourceKey`, `AZURE_QUOTA_RESOURCE_KEYS`).
const KEYS = {
  aws: { spot: 'aws:l-34b43a08', onDemand: 'aws:l-1216c47a' },
  azure: { spot: 'azure:lowprioritycores', onDemand: 'azure:cores' },
} as const;

/**
 * Reads the region's limits through the control plane's quota status, with
 * the cloud's credential there: what upgrade, status and the listener read,
 * so none needs the user's cloud CLI. A limit the control plane couldn't
 * read comes back as an `unavailable` row with why, which fails the read as
 * the CLI's error did; `partial` leaves that limit unknown instead, so the
 * listener still takes the other.
 */
export async function readQuotaStatus(
  api: AnycloudApi,
  cloud: Cloud,
  credentialName: string,
  region: string,
  partial = false,
): Promise<QuotaLimits> {
  if (cloud === 'gcp') return {};
  const { entries } = await api.getQuotaStatus({
    query: {
      cloud: cloud === 'aws' ? 'AWS' : 'Azure',
      credentialName,
      region,
    },
  });
  const mine = entries.filter((entry) => entry.region === region);
  const current = (key: string) => {
    const found = mine.find(
      (entry) => entry.kind === 'current' && entry.resourceKey === key,
    );
    if (found) return found.currentLimit;
    if (partial) return undefined;
    // Keyed to the limit, or with no key: AWS's whole-region read, or one
    // of Azure's read scopes, which matter only with the limit's row gone.
    const unavailable = mine.find(
      (entry) =>
        entry.kind === 'unavailable' &&
        (entry.resourceKey === key || entry.resourceKey === undefined),
    );
    if (unavailable) throw new Error(unavailable.message ?? unavailable.status);
    return undefined;
  };
  return {
    spot: current(KEYS[cloud].spot),
    onDemand: current(KEYS[cloud].onDemand),
  };
}

/**
 * The runner regions' limits, home first, each read by `read`. The home
 * region's read fails as `read` does; another region that fails to read,
 * such as one the account hasn't enabled, is left unread.
 */
export async function readQuotas(
  regions: readonly string[],
  read: (region: string) => Promise<QuotaLimits>,
): Promise<Map<string, QuotaLimits>> {
  const limits = await Promise.all(
    regions.map((region, i) =>
      read(region).catch((error: unknown) => {
        if (i === 0) throw error;
        return {};
      }),
    ),
  );
  return new Map(regions.map((region, i) => [region, limits[i]!]));
}

/** The line install prints per quota, such as "64 spot vCPUs (16 backmesh-4 jobs at once)". */
export function formatQuota(check: QuotaCheck, spot: boolean): string {
  const kind = spot ? 'spot' : 'on-demand';
  const unread = check.unread ? `, unread in ${check.unread.join(', ')}` : '';
  return check.vcpus === undefined
    ? `${kind} vCPUs unread (raise ${check.increase} for more jobs at once)`
    : `${check.vcpus} ${kind} vCPUs (${Math.floor(check.vcpus / DEFAULT_VCPUS)} backmesh-4 jobs at once${unread})`;
}
