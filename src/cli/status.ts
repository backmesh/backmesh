// `backmesh status`: the runners, the queue, month-to-date
// cost and the doctor checks, from the hosted API and the listener's
// `/status`.
import { CACHE_CAP_ENV } from '../listener/sweep.js';
import { z } from 'zod';

import type { AnycloudApi, AnycloudExec } from '../anycloud/client.js';
import {
  FEATURES,
  missingFeatures,
  type FeatureTable,
} from '../anycloud/features.js';
import { runnerGroupName } from '../github/runner-group.js';
import { OVERRIDE_ENV } from '../app/override.js';
import type { TelemetryStatus } from '../listener/telemetry.js';
import { INSTALL_KEY_ENV, ROTATING_FROM_ENV } from './worker.js';
import { parseRoutes, RUNNERS_ENV } from '../listener/routes.js';
import { where } from '../runners/classes.js';
import {
  KIND_NAME,
  formatGpuQuota,
  formatQuota,
  quotaCheck,
  quotaCode,
  readQuotas,
  readQuotaStatus,
} from '../runners/quota.js';
import {
  formatReasons,
  formatJobs,
  formatPlanner,
  formatSlow,
  kindOf,
  listenerStatusSchema,
  tokenRefused,
} from '../listener/status.js';
import {
  clusterIdOf,
  installTag,
  listenerName,
  orgOfListener,
  readInstallation,
  readOrgId,
  readPublicRepos,
  publicReposWarning,
  sessionOf,
  type Listener,
} from './installation.js';
import { inListener } from './listener-vm.js';
import {
  API_TOKEN_ENV,
  LISTENER_IMAGE_ENV,
  RUNNER_GROUP_ENV,
} from '../listener/env.js';

// The listener binds loopback only and its image has Node but no curl, so
// `status`, `upgrade` and `uninstall` call it inside its container, through
// `docker exec` on its VM. Prints the response's code and JSON body, and the
// named variables of its environment.
const execSchema = z.object({
  code: z.number().int(),
  body: z.unknown(),
  env: z.record(z.string(), z.string()),
});

export async function execListener(
  exec: AnycloudExec,
  { vm }: { vm: { id: string; lost?: boolean; org?: string } },
  path: string,
  {
    method = 'GET',
    env = [],
  }: { method?: 'GET' | 'POST'; env?: string[] } = {},
) {
  const script = `fetch("http://127.0.0.1:8080${path}", { method: "${method}" }).then(async (r) => console.log(JSON.stringify({ code: r.status, body: await r.json(), env: Object.fromEntries(${JSON.stringify(env)}.map((name) => [name, process.env[name]])) })))`;
  if (vm.lost) {
    throw new Error(
      `its VM ${vm.id} is gone, and anycloud doesn't replace it; run \`backmesh upgrade\` to create another, or \`backmesh uninstall --org ${vm.org}\` to finish removing it`,
    );
  }
  const { code, stdout, stderr } = await exec(vm.id, inListener(script));
  if (code !== 0) {
    throw new Error(
      stderr.trim().split('\n').at(-1) || `its exec exited ${code}`,
    );
  }
  return execSchema.parse(JSON.parse(stdout));
}

export const readApiVersion = async (
  apiUrl: string,
  fetch: typeof globalThis.fetch,
) =>
  z
    .object({ version: z.string() })
    .parse(await (await fetch(`${apiUrl}/v1/version`)).json()).version;

// The listener's `/status` (`listenerStatusSchema`), and the org, its
// ID, runner image, install key and override install gave it.
export async function readListener(
  exec: AnycloudExec,
  listener: Pick<Listener, 'vm'>,
) {
  const { body, env } = await execListener(exec, listener, '/status', {
    env: [
      'ORG',
      'ORG_ID',
      OVERRIDE_ENV,
      'BACKMESH_RUNNER_IMAGE',
      INSTALL_KEY_ENV,
      RUNNERS_ENV,
      ROTATING_FROM_ENV,
      CACHE_CAP_ENV,
      LISTENER_IMAGE_ENV,
      RUNNER_GROUP_ENV,
      API_TOKEN_ENV,
    ],
  });
  return {
    image: z.string().parse(env[LISTENER_IMAGE_ENV]),
    runnerGroup: env[RUNNER_GROUP_ENV],
    // Its anycloud service token.
    apiToken: env[API_TOKEN_ENV],
    status: listenerStatusSchema.parse(body),
    // The listener doesn't start without it.
    org: z.string().parse(env.ORG),
    orgId: env.ORG_ID === undefined ? undefined : Number(env.ORG_ID),
    override: !!env[OVERRIDE_ENV],
    runnerImage: env.BACKMESH_RUNNER_IMAGE,
    // Absent on a listener installed before install keys.
    installKey: env[INSTALL_KEY_ENV],
    // The runner classes (`routes.ts`), absent before VM Jobs.
    runners: env[RUNNERS_ENV],
    // Set while `rotate-key` has a replacement minted but not yet revoked
    // the install named here; absent otherwise.
    rotatingFrom: env[ROTATING_FROM_ENV],
    // `install --cache-cap`, absent for the default.
    // A value that isn't a positive number reads as the default.
    cacheCapGb:
      Number(env[CACHE_CAP_ENV]) > 0 ? Number(env[CACHE_CAP_ENV]) : undefined,
  };
}

export interface StatusDeps {
  api: AnycloudApi;
  apiUrl: string;
  exec: AnycloudExec;
  fetch?: typeof globalThis.fetch;
  now?: Date;
  features?: FeatureTable;
  // Narrows the report to one org.
  org?: string;
}

export async function readStatus({
  api,
  apiUrl,
  exec,
  fetch = globalThis.fetch,
  now = new Date(),
  features = FEATURES,
  org: only,
}: StatusDeps) {
  const clusterId = clusterIdOf(apiUrl);
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const [version, control] = await Promise.all([
    readApiVersion(apiUrl, fetch),
    readInstallation(api),
  ]);
  const listeners = control.orgs.filter(
    ({ name }) => !only || name === listenerName(only),
  );
  if (only && !listeners.length) {
    throw new Error(`There's no listener for ${only} on ${apiUrl}.`);
  }
  // One section per org: its listener, and its runners' month-to-date cost
  // through its own session.
  const orgs = await Promise.all(
    listeners.map(async (entry) => {
      const { name, vm } = entry;
      const login = orgOfListener(name)!;
      // The install key and service token stay out of the report, which
      // `--json` prints, and the classes are summed up per cloud.
      const listener = await readListener(exec, entry).then(
        async ({ installKey: _, apiToken: __, runners, ...listener }) => ({
          ...listener,
          runners: await runnerClouds(runners, api),
          // The org's public repositories its runner group refuses.
          refusedPublicRepos: lacksPublic(runners)
            ? await readPublicRepos(login, fetch)
            : undefined,
        }),
        (error: unknown) => ({ error: message(error) }),
      );
      const host = { vm: vm.id, lost: vm.lost };
      const org = 'org' in listener ? listener.org : login;
      // The tag needs the org's ID: the listener's, or GitHub's while it's
      // down. Neither failing here stops the other orgs' sections.
      // Known once the tag is, even if the cost report then fails.
      let runnerGroup: string | null = null;
      try {
        const orgId =
          ('orgId' in listener && listener.orgId) ||
          (await readOrgId(login, fetch));
        const tag = installTag(clusterId, orgId);
        runnerGroup =
          ('runnerGroup' in listener && listener.runnerGroup) ||
          runnerGroupName(tag, vm.id);
        const session = sessionOf(tag);
        const cost = await api.getWorkloadCostReport({
          query: { session, sessionExact: 'true', sinceMs: String(monthStart) },
        });
        return {
          org,
          ...host,
          session,
          runnerGroup,
          listener,
          cost: {
            since: new Date(monthStart).toISOString(),
            totalUsd: cost.totalCost,
            byCloud: Object.fromEntries(
              Object.entries(cost.byProvider).map(([cloud, { cost }]) => [
                cloud,
                cost,
              ]),
            ),
          },
        };
      } catch (error) {
        return {
          org,
          ...host,
          session: null,
          runnerGroup,
          listener,
          cost: null,
          costError: message(error),
        };
      }
    }),
  );

  const warnings = [...control.problems];
  if (!orgs.length) {
    warnings.push(
      `There's no listener on this control plane; run \`backmesh install\`.`,
    );
  }
  for (const { org, listener, ...section } of orgs) {
    if ('costError' in section) {
      warnings.push(
        `${org}'s runner cost couldn't be read: ${section.costError}`,
      );
    }
    const broker = 'status' in listener && listener.status.broker;
    if (broker) {
      warnings.push(
        `${org}: the token broker has failed since ${minute(broker.since)}: ${broker.error}. The listener keeps its current token until it expires, then stops scaling.`,
      );
    }
    const anycloud = 'status' in listener && listener.status.anycloud;
    if (anycloud) {
      warnings.push(
        tokenRefused(anycloud)
          ? `${org}: the control plane has refused the listener's service token since ${minute(anycloud.since)}, so it can't start runners; a restore from a backup older than the token does this. Run \`backmesh upgrade\` to issue it a new one.`
          : `${org}: the listener hasn't reached the control plane since ${minute(anycloud.since)}: ${anycloud.error}.`,
      );
    }
    if (
      'refusedPublicRepos' in listener &&
      listener.refusedPublicRepos?.names.length
    ) {
      warnings.push(
        publicReposWarning(
          org,
          listener.refusedPublicRepos,
          'backmesh upgrade --public-repos',
        ),
      );
    }
    if ('error' in listener) {
      warnings.push(`${org}'s listener didn't answer: ${listener.error}`);
    } else if (!listener.status.installed) {
      warnings.push(
        `The backmesh App isn't installed on ${listener.org}; the listener waits for it and its log has the install link.`,
      );
    } else {
      const lost = listener.status.notInstalled;
      if (lost) {
        warnings.push(
          `The backmesh App's installation on ${listener.org} is gone since ${minute(lost.since)}, so the listener can't reach GitHub or start runners. An org owner installs the App again at ${lost.installUrl}; the listener picks it up without a restart.`,
        );
      }
      // The installation's Actions permission: backmesh.com reruns and
      // cancels for the listener with its write.
      const actions = listener.status.actionsPermission;
      if (actions && actions !== 'write') {
        warnings.push(
          `The backmesh App has Actions: ${actions} on ${listener.org}; backmesh.com needs Actions: write there to rerun reclaimed jobs and cancel fork runs. An org owner accepts the App's new permissions at https://github.com/organizations/${listener.org}/settings/installations.`,
        );
      }
      for (const set of listener.status.scaleSets) {
        const { skipped, avoiding } = set;
        if (avoiding?.onDemand) {
          warnings.push(
            `${listener.org}: ${set.label} starts its runners on demand until ${avoiding.until.slice(11, 16)}Z: spot runners in ${avoiding.regions.join(', ')} missed the start deadline, so its jobs bill at the on-demand rate until then.`,
          );
        } else if (avoiding) {
          warnings.push(
            `${listener.org}: ${set.label} starts no runners until ${avoiding.until.slice(11, 16)}Z: runners in ${avoiding.regions.join(', ')} missed the 3-minute start deadline${skipped?.regions.length ? ', and its other regions are skipped for quota' : ''}. Its jobs wait at GitHub meanwhile.`,
          );
        }
        if (!skipped?.all) continue;
        const regions = skipped.regions
          .map(({ region, limit }) => `${region} ${limit} vCPU`)
          .join(', ');
        warnings.push(
          `${listener.org}: ${set.label} starts no runners: every runner region's ${KIND_NAME[kindOf(skipped.spot, skipped.regions[0]?.kind)]} quota is under one ${skipped.vcpus}-vCPU runner (${regions}). Its jobs wait at GitHub until ${[...new Set(skipped.regions.map((r) => quotaCode(skipped.cloud, kindOf(skipped.spot, r.kind))))].join(' or ')} is raised; nothing to reinstall.`,
        );
      }
    }
  }
  // C29 comes in release 1.
  const missing = missingFeatures(version, ['release-1'], features);
  if (missing.includes('release-1')) {
    warnings.push(
      `The control plane (${version}) is too old for this backmesh. Run \`backmesh upgrade\`.`,
    );
  }

  return {
    api: { url: apiUrl, version, missingFeatures: missing },
    orgs,
    warnings,
  };
}

export type StatusReport = Awaited<ReturnType<typeof readStatus>>;

// Whether the classes parse and have none of `--public-repos`'s public
// ones.
function lacksPublic(json: string | undefined) {
  try {
    return !!json && !parseRoutes(json).some((r) => r.public && !r.retiring);
  } catch {
    return false;
  }
}

// Each cloud's regions, label count and summed vCPU quotas, such as "aws
// us-east-2, 16 labels; quota: 640 spot vCPUs (…)"; null when the listener
// has no classes, or they don't parse. The quotas are the control plane's
// reads with each cloud's credential there, so no cloud CLI is needed; GCP's
// aren't read.
async function runnerClouds(json: string | undefined, api: AnycloudApi) {
  if (!json) return null;
  let routes;
  try {
    // A draining label's cloud may be gone.
    routes = parseRoutes(json).filter((r) => !r.retiring);
  } catch {
    return null;
  }
  return Promise.all(
    [...Map.groupBy(routes, (r) => r.cloud)].map(async ([cloud, labels]) => {
      // The install region first, whose read failing fails the line.
      const regions = [
        ...new Set([labels[0]!.region, ...labels.flatMap((r) => r.regions)]),
      ];
      const line = `${where(cloud, regions)}, ${labels.length} labels`;
      if (cloud === 'gcp') return line;
      const credentials = labels[0]!.credentials;
      const quota = await readQuotas(regions, (region) =>
        readQuotaStatus(api, cloud, credentials, region),
      ).then(
        (limits) =>
          [
            [true, false]
              .map((spot) =>
                formatQuota(quotaCheck(cloud, regions, limits, spot), spot),
              )
              .join(', '),
            ...(labels.some((r) => r.gpu)
              ? [
                  formatGpuQuota(
                    cloud,
                    limits,
                    labels.filter((r) => r.gpu),
                  ),
                ]
              : []),
          ].join('; '),
        (error: unknown) => `unread (${message(error)})`,
      );
      return `${line}; quota: ${quota}`;
    }),
  );
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const minute = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')}Z`;

// Telemetry's line, only when its sends fail.
function formatTelemetry({
  lastError,
  lastStatus,
  pending,
}: TelemetryStatus): string[] {
  if (lastStatus === 401) {
    return [
      "Telemetry: backmesh.com refused this install's sign-in; run backmesh upgrade to sign in with GitHub again.",
    ];
  }
  if (!lastError) return [];
  const refused = String(lastStatus).startsWith('4');
  return [
    `Telemetry: backmesh.com ${refused ? 'refused' : "didn't answer"} (${lastError}); ${pending} event${pending === 1 ? '' : 's'} to send. Jobs aren't affected.`,
  ];
}

const usd = (value: number) => `$${value.toFixed(2)}`;
const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`;

export function formatStatus(report: StatusReport): string {
  const { api, orgs, warnings } = report;
  const lines = [
    `Control plane ${api.url} (${api.version})`,
    '',
    'Runners: each job gets its own VM; the job controls that VM’s Docker.',
    '',
  ];
  for (const section of orgs) {
    const { org, session, runnerGroup, listener, cost } = section;
    lines.push(
      `${org}${session ? `, session ${session}` : ''}${runnerGroup ? `, runner group ${runnerGroup}` : ''}:`,
      `Listener VM: ${section.vm}${section.lost ? ' (gone)' : ''}`,
    );
    if ('status' in listener && !listener.status.installed) {
      lines.push(`Listener: waiting for the App's installation on ${org}`);
    } else if ('status' in listener) {
      const { status } = listener;
      lines.push(
        `Queue (${status.runners} runners; the control plane's cap is ${status.cap}):`,
      );
      for (const set of status.scaleSets) {
        const stats = set.statistics;
        lines.push(
          `  ${set.label}${set.retiring ? ' (draining, then deleted)' : ''}: ${stats ? `${stats.totalAssignedJobs} assigned, ${stats.totalRunningJobs} running; ` : ''}runners ${set.queued} queued, ${set.starting} starting, ${set.running} running`,
        );
        if (set.oldestQueuedMs !== null) {
          lines.push(`    oldest queued ${minutes(set.oldestQueuedMs)}`);
        }
        lines.push(...formatReasons(set, status.cap));
        lines.push(...formatJobs(set));
        lines.push(...formatSlow(set));
        if (set.backoff) {
          lines.push(
            `    backing off after ${set.backoff.failures} startup failures (last ${set.backoff.lastEnd ?? 'unknown'}), next probe ${set.backoff.nextProbeAt ?? 'pending'}`,
          );
        }
      }
      const retry = status.retry;
      if (retry?.waiting || retry?.paused.length) {
        const paused = retry.paused.map(
          ({ capacity, until }) =>
            `; ${capacity} paused until ${until.slice(11, 16)}Z`,
        );
        lines.push(
          `Retry: ${retry.waiting} run${retry.waiting === 1 ? '' : 's'} waiting to be rerun${paused.join('')}`,
        );
      }
      if (status.avoided?.length) {
        const avoided = status.avoided.map(
          ({ where, until }) => `${where} until ${until.slice(11, 16)}Z`,
        );
        lines.push(
          `Avoiding ${avoided.join(', ')}: runners there missed the 3-minute start deadline`,
        );
      }
      lines.push(...formatPlanner(status.planner));
      lines.push(
        `Runner VMs: ${listener.runners?.join('; ') ?? 'none'}`,
        `Runner image: ${listener.runnerImage ?? 'unknown'}`,
        ...(status.telemetry ? formatTelemetry(status.telemetry) : []),
      );
    }
    if (cost) {
      lines.push(
        `Cost since ${cost.since.slice(0, 10)}: ${usd(cost.totalUsd)}${Object.entries(
          cost.byCloud,
        )
          .map(([cloud, value]) => `, ${cloud} ${usd(value)}`)
          .join('')}`,
      );
    }
    lines.push('');
  }
  lines.push(
    ...(warnings.length
      ? ['Warnings:', ...warnings.map((warning) => `  ${warning}`)]
      : ['No warnings.']),
  );
  return lines.join('\n');
}
