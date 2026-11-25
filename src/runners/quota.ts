// The vCPU quotas the runners' VMs count against: a region's spot and
// on-demand vCPUs for the classes' families, and for the GPU classes' own.
import type { AnycloudApi } from '../anycloud/client.js';
import { GPU, type Cloud } from './classes.js';
import type { RunCommand } from './regions.js';

/** A region's spot and on-demand vCPU limits; GCP's aren't read. */
export interface QuotaLimits {
  spot?: number;
  onDemand?: number;
  // The GPU classes' family: AWS's G and VT spot and on demand, and Azure's
  // NCASv3_T4 on demand (its spot GPU VMs count against `spot`).
  gpuSpot?: number;
  gpuOnDemand?: number;
}
export type QuotaKind = keyof QuotaLimits;

/**
 * The quotas: AWS's Service Quotas codes and Azure's compute usage names, as
 * anycloud reads them (`src/shared/quota-resolvers/aws.ts:13-17`,
 * `azure-identity.ts:73-74`, `azure.ts:47`), and where to raise them.
 */
const QUOTA: Record<
  QuotaKind,
  Partial<Record<Exclude<Cloud, 'gcp'>, readonly [string, string]>>
> = {
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
  gpuSpot: {
    aws: [
      'L-3819A6DF',
      'EC2 "All G and VT Spot Instance Requests" (L-3819A6DF)',
    ],
  },
  gpuOnDemand: {
    aws: [
      'L-DB2E81BA',
      'EC2 "Running On-Demand G and VT instances" (L-DB2E81BA)',
    ],
    azure: ['standardNCASv3_T4Family', '"Standard NCASv3_T4 Family vCPUs"'],
  },
};

const quota = (cloud: Exclude<Cloud, 'gcp'>, kind: QuotaKind) =>
  QUOTA[kind][cloud]!;

/**
 * The quotas a runner counts against, the GPU family's first: Azure's spot
 * VMs all count against its low-priority vCPUs, whatever their family, and
 * its on-demand ones against their family's and the regional vCPUs
 * (anycloud `src/api/services/quota/azure.ts:385-392`).
 */
export function quotaKinds(
  cloud: Cloud,
  spot: boolean,
  gpu?: string,
): QuotaKind[] {
  if (!gpu) return [spot ? 'spot' : 'onDemand'];
  if (cloud === 'azure') return spot ? ['spot'] : ['gpuOnDemand', 'onDemand'];
  return [spot ? 'gpuSpot' : 'gpuOnDemand'];
}

/** A quota kind as plans and status name it. */
export const KIND_NAME: Record<QuotaKind, string> = {
  spot: 'spot',
  onDemand: 'on-demand',
  gpuSpot: 'GPU spot',
  gpuOnDemand: 'GPU on-demand',
};

/** The default class's vCPUs: a quota under it runs no `backmesh-ubuntu-2404-4vcpu` job. */
const DEFAULT_VCPUS = 4;

/**
 * Reads the region's limits through the user's own signed-in cloud CLI, for
 * install's plan before any credential exists on a control plane: anycloud's
 * `api create` reads no quota. backmesh links no cloud SDK.
 */
export async function readQuota(
  cloud: Cloud,
  region: string,
  command: RunCommand,
  usageOf = (r: string) => readUsage(r, command),
): Promise<QuotaLimits> {
  // Google's quotas aren't read, as anycloud's `quota status` doesn't
  // read them (`src/api/services/quota/handler.ts:47-62`).
  if (cloud === 'gcp') return {};
  if (cloud === 'aws') {
    const read = (code: string) => readServiceQuota(code, region, command);
    // The GPU quotas are only shown, so a failed read leaves them unread.
    const gpu = (kind: 'gpuSpot' | 'gpuOnDemand') =>
      read(quota('aws', kind)[0]).catch(() => undefined);
    return {
      spot: await read(quota('aws', 'spot')[0]),
      onDemand: await read(quota('aws', 'onDemand')[0]),
      gpuSpot: await gpu('gpuSpot'),
      gpuOnDemand: await gpu('gpuOnDemand'),
    };
  }
  const usage = await usageOf(region);
  const read = (name: string) => usageNamed(usage, name)?.limit;
  return {
    spot: read(quota('azure', 'spot')[0]),
    onDemand: read(quota('azure', 'onDemand')[0]),
    gpuOnDemand: read(quota('azure', 'gpuOnDemand')[0]),
  };
}

/** An AWS EC2 quota's value in the region, such as L-1216C47A's. */
export const readServiceQuota = async (
  code: string,
  region: string,
  command: RunCommand,
) =>
  Number(
    await command([
      ...['aws', 'service-quotas', 'get-service-quota'],
      ...['--service-code', 'ec2', '--quota-code', code],
      ...['--region', region, '--query', 'Quota.Value'],
      ...['--output', 'text'],
    ]),
  );

/** A region's Azure compute usage: its limit and what's in use, in vCPUs. */
export interface Usage {
  name: string;
  limit: number;
  current: number;
}

/**
 * The region's Azure compute usage, through the user's `az`: the regional
 * and low-priority vCPUs, and each VM family's.
 */
export const readUsage = async (
  region: string,
  command: RunCommand,
): Promise<Usage[]> =>
  (
    JSON.parse(
      await command([
        ...['az', 'vm', 'list-usage', '--location', region],
        ...['--output', 'json'],
      ]),
    ) as {
      name?: { value?: string };
      limit?: number | string;
      currentValue?: number | string;
    }[]
  ).map((entry) => ({
    name: entry.name?.value ?? '',
    limit: Number(entry.limit),
    current: Number(entry.currentValue ?? 0),
  }));

/** The usage named `name`, whatever its case. */
export const usageNamed = (usage: readonly Usage[], name: string) =>
  usage.find((entry) => entry.name.toLowerCase() === name.toLowerCase());

export interface QuotaCheck {
  /** The vCPU limit, summed over the regions read; undefined on GCP. */
  vcpus?: number;
  /** The `backmesh-ubuntu-2404-4vcpu` VMs each region's limit fits, summed. */
  jobs?: number;
  /** The quota to raise. */
  increase: string;
  /** The regions whose limit wasn't read, when another's was. */
  unread?: string[];
  /** Why the runners can't start. */
  problem?: string;
}

/** The quota's short name: AWS's code, or Azure's usage name. */
export function quotaCode(cloud: Exclude<Cloud, 'gcp'>, kind: QuotaKind) {
  const [code, name] = quota(cloud, kind);
  return cloud === 'aws' ? code : name;
}

interface Planned {
  label: string;
  vcpus: number;
  spot: boolean;
  gpu?: string;
  regions: readonly string[];
}

// A region's limit of the kind, when read.
const limitOf = (
  limits: ReadonlyMap<string, QuotaLimits>,
  region: string,
  kind: QuotaKind,
) => {
  const vcpus = limits.get(region)?.[kind];
  return vcpus !== undefined && Number.isFinite(vcpus) ? vcpus : undefined;
};

/**
 * A runner region whose quota of some kind can't fit one VM of some of the
 * cloud's classes: the listener skips it for those, keeping it in the list,
 * until a read shows the quota raised. For install's plan, such as
 * "us-west-1: spot quota 5 vCPU, skipped for backmesh-ubuntu-2404-8vcpu, backmesh-ubuntu-2404-16vcpu; raise
 * L-34B43A08 to use it". GCP's quotas aren't read, so it's never skipped.
 */
export function skippedRegions(
  cloud: Cloud,
  limits: ReadonlyMap<string, QuotaLimits>,
  classes: readonly Planned[],
): string[] {
  if (cloud === 'gcp') return [];
  const kinds = Object.keys(QUOTA) as QuotaKind[];
  return [...limits.keys()].flatMap((region) =>
    kinds.flatMap((kind) => {
      const vcpus = limitOf(limits, region, kind);
      if (vcpus === undefined) return [];
      const mine = classes.filter(
        (c) =>
          quotaKinds(cloud, c.spot, c.gpu).includes(kind) &&
          c.regions.includes(region),
      );
      const under = mine.filter((c) => c.vcpus > vcpus);
      if (!under.length) return [];
      const which =
        under.length === mine.length
          ? ''
          : ` for ${under.map((c) => c.label).join(', ')}`;
      return [
        `${region}: ${KIND_NAME[kind]} quota ${vcpus} vCPU, skipped${which}; raise ${quotaCode(cloud, kind)} to use it`,
      ];
    }),
  );
}

/**
 * The labels that would start no runners: in every one of their runner
 * regions, one of the quotas of their kind (spot, or on demand for an `od`
 * label; the GPU family's for a GPU label) is under one of their VMs, as a
 * spot label falls back on demand for spot capacity, never for quota. One
 * line each for install's and upgrade's plans.
 */
export function startsNoRunners(
  cloud: Cloud,
  limits: ReadonlyMap<string, QuotaLimits>,
  classes: readonly Planned[],
): string[] {
  if (cloud === 'gcp') return [];
  return classes.flatMap((c) => {
    const each = c.regions.map((region) => {
      const kind = quotaKinds(cloud, c.spot, c.gpu).find((k) => {
        const vcpus = limitOf(limits, region, k);
        return vcpus !== undefined && vcpus < c.vcpus;
      });
      return { region, kind, vcpus: kind && limitOf(limits, region, kind) };
    });
    if (!each.length || !each.every(({ kind }) => kind)) return [];
    const codes = [...new Set(each.map(({ kind }) => quotaCode(cloud, kind!)))];
    return [
      `${c.label} would start no runners: every runner region's ${KIND_NAME[each[0]!.kind!]} quota is under one ${c.vcpus}-vCPU runner (${each.map(({ region, vcpus }) => `${region} ${vcpus} vCPU`).join(', ')}); raise ${codes.join(' or ')} in ${each.map(({ region }) => region).join(' or ')} to use it.`,
    ];
  });
}

/** The AWS or Azure quota to raise for more vCPUs of the kind. */
export function quotaToRaise(
  cloud: Exclude<Cloud, 'gcp'>,
  regions: readonly string[],
  kind: QuotaKind,
): string {
  return `${quota(cloud, kind)[1]} in ${regions.join(', ')}`;
}

// The VMs of `vcpus` each region's limit fits, summed: a VM is in one
// region, so 3 vCPUs in each of four regions fit no 4-vCPU VM.
const fits = (limits: readonly number[], vcpus: number) =>
  limits.reduce((sum, v) => sum + Math.floor(v / vcpus), 0);

/**
 * Runners past the quota wait in anycloud's launch retries, so the quotas of
 * the runners' regions, summed, cap how many jobs run at once; under one
 * `backmesh-ubuntu-2404-4vcpu` VM it's a problem.
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
    // quotas otherwise; on-demand ones try c4d and c3d first.
    return {
      increase: `"CPUS_ALL_REGIONS" (32 by default) and ${names}'s ${spot ? '"PREEMPTIBLE_CPUS", ' : '"CPUS", "C4D_CPUS", "C3D_CPUS", '}"N2D_CPUS" and "N2_CPUS"`,
    };
  }
  const kind = spot ? 'spot' : 'onDemand';
  const [name] = quota(cloud, kind);
  const increase = quotaToRaise(cloud, regions, kind);
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
  const jobs = fits(read, DEFAULT_VCPUS);
  const unread = regions.filter((_, i) => each[i] === undefined);
  const problem = `${cloud} allows ${vcpus} ${spot ? 'spot' : 'on-demand'} vCPUs, under one ${DEFAULT_VCPUS}-vCPU VM; raise ${increase}`;
  return {
    vcpus,
    jobs,
    increase,
    ...(unread.length && { unread }),
    ...(vcpus < DEFAULT_VCPUS && { problem }),
  };
}

// The control plane's current limits for the region, as anycloud keys them
// (`awsQuotaResourceKey`, `AZURE_QUOTA_RESOURCE_KEYS`, and Azure's GPU
// families, which its quota status lists: `quota/azure.ts:501-536`).
const KEYS: Record<Exclude<Cloud, 'gcp'>, QuotaLimitKeys> = {
  aws: {
    spot: 'aws:l-34b43a08',
    onDemand: 'aws:l-1216c47a',
    gpuSpot: 'aws:l-3819a6df',
    gpuOnDemand: 'aws:l-db2e81ba',
  },
  azure: {
    spot: 'azure:lowprioritycores',
    onDemand: 'azure:cores',
    gpuOnDemand: 'azure:standardncasv3_t4family',
  },
};
type QuotaLimitKeys = Partial<Record<QuotaKind, string>> &
  Record<'spot' | 'onDemand', string>;

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
  return Object.fromEntries(
    Object.entries(KEYS[cloud]).map(([kind, key]) => [kind, current(key)]),
  );
}

/**
 * The runner regions' limits, home first, each read by `read`, two regions
 * at a time: each read is a cloud CLI process, and one per region at once
 * starved a GitHub-hosted runner. The home region's read fails as `read`
 * does; another region that fails to read, such as one the account hasn't
 * enabled, is left unread.
 */
export async function readQuotas(
  regions: readonly string[],
  read: (region: string) => Promise<QuotaLimits>,
): Promise<Map<string, QuotaLimits>> {
  const limits: QuotaLimits[] = [];
  let next = 0;
  const reader = async () => {
    while (next < regions.length) {
      const i = next++;
      limits[i] = await read(regions[i]!).catch((error: unknown) => {
        if (i === 0) throw error;
        return {};
      });
    }
  };
  await Promise.all([reader(), reader()]);
  return new Map(regions.map((region, i) => [region, limits[i]!]));
}

/** The line install prints per quota, such as "64 spot vCPUs (16 backmesh-ubuntu-2404-4vcpu jobs at once)". */
export function formatQuota(check: QuotaCheck, spot: boolean): string {
  const kind = spot ? 'spot' : 'on-demand';
  const unread = check.unread ? `, unread in ${check.unread.join(', ')}` : '';
  return check.vcpus === undefined
    ? `${kind} vCPUs unread (raise ${check.increase} for more jobs at once)`
    : `${check.vcpus} ${kind} vCPUs (${check.jobs} backmesh-ubuntu-2404-4vcpu jobs at once${unread})`;
}

/**
 * The GPU labels' quota line for install's plan and `backmesh status`, such as
 * "GPU quota: 0 spot vCPUs, 8 on-demand vCPUs (2 backmesh-ubuntu-2404-gpu-od-t4 jobs at
 * once); raise ... to run backmesh-ubuntu-2404-gpu-t4", over each label's own regions. A
 * new account usually has none (AWS's G and VT and Azure's NCASv3_T4 default
 * to 0), so it's shown, never refused: the GPU labels' jobs wait at GitHub
 * until it's raised.
 */
export function formatGpuQuota(
  cloud: Exclude<Cloud, 'gcp'>,
  limits: ReadonlyMap<string, QuotaLimits>,
  labels: readonly {
    label: string;
    spot: boolean;
    regions: readonly string[];
  }[],
): string {
  const parts: string[] = [];
  const raise: string[] = [];
  for (const { label, spot, regions } of labels) {
    const kind = spot ? 'gpuSpot' : 'gpuOnDemand';
    // Azure's spot GPU VMs count against the spot vCPUs, shown already.
    if (!QUOTA[kind][cloud]) continue;
    const read = regions.flatMap((r) => limitOf(limits, r, kind) ?? []);
    const vcpus = read.reduce((sum, v) => sum + v, 0);
    const name = spot ? 'spot' : 'on-demand';
    parts.push(
      read.length
        ? `${vcpus} ${name} vCPUs (${fits(read, GPU.vcpus)} ${label} jobs at once)`
        : `${name} vCPUs unread`,
    );
    if (!read.length || vcpus < GPU.vcpus) {
      raise.push(`${quotaToRaise(cloud, regions, kind)} to run ${label}`);
    }
  }
  const spot =
    cloud === 'azure'
      ? ', and its spot VMs count against the spot vCPUs above'
      : '';
  return `GPU quota: ${parts.join(', ')}${spot}${raise.length ? `; raise ${raise.join(', and ')}` : ''}`;
}
