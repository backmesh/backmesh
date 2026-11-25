import { z } from 'zod';

import { statisticsSchema } from '../github/types.js';
import { telemetryStatusSchema } from './telemetry.js';
import {
  KIND_NAME,
  quotaCode,
  quotaKinds,
  quotaToRaise,
  type QuotaKind,
} from '../runners/quota.js';
import { BOOT_DEADLINE_MS } from './failover.js';
import { QUOTA_REFUSALS } from './runner-jobs.js';

// What `/status` returns and `backmesh status` parses:
// whether the App is installed yet, and per scale set, GitHub's statistics,
// the runner Jobs from the scaler's listing by state, the reasons runners are
// short and the startup-failure backoff. Only counts, as no job maps to a
// runner before it starts, and the summaries of the job rows.
// A quota record's kind (`quotaKinds`).
const quotaKind = z.enum(['spot', 'onDemand', 'gpuSpot', 'gpuOnDemand']);

const percentiles = z.object({ p50: z.number(), p95: z.number() }).nullable();
// `JobRows.summary` (`timings.ts`).
const jobsSummary = z.object({
  jobs: z.number().int(),
  startMs: percentiles,
  runMs: percentiles,
  dominant: z.object({ segment: z.string(), share: z.number() }).nullable(),
  reclaims: z.number().int(),
  startupFailures: z.number().int(),
  // Runs backmesh reran, and where the retries started.
  reruns: z.number().int(),
  retries: z.object({ onDemand: z.number().int(), spot: z.number().int() }),
  // Jobs that fell back on demand (`fallback`). Optional, as an older
  // listener doesn't report it.
  fellBack: z.number().int().optional(),
  // Jobs and submit to running by launched region, and refused launches by
  // region. Optional, as an older listener doesn't report them.
  regions: z
    .record(z.string(), z.object({ jobs: z.number().int(), vmMs: percentiles }))
    .optional(),
  refusedIn: z.record(z.string(), z.number().int()).optional(),
  // The refused launches by anycloud's diagnosis; the runners refused for
  // quota at least once, the regions that refused them, and their submit to
  // anycloud's re-queue after their last refusal.
  refusedFor: z.record(z.string(), z.number().int()).optional(),
  quotaRefused: z
    .object({
      runners: z.number().int(),
      regions: z.array(z.string()),
      waitMs: percentiles,
    })
    .optional(),
  // When the rows start, if later than the window: a restart or the cap.
  since: z.iso.datetime().nullable(),
  // Jobs and queued to started by what their runner was started for.
  // Optional, as an older listener doesn't report it.
  startedFor: z
    .record(
      z.string(),
      z.object({ jobs: z.number().int(), startMs: percentiles }),
    )
    .optional(),
});

export const listenerStatusSchema = z.object({
  // False while the listener waits for the App's installation on the org.
  installed: z.boolean(),
  // The App installation's Actions permission (`read`, `write` or `none`),
  // null until the first token. Retry needs `write`. Optional, as
  // an older listener doesn't report it.
  actionsPermission: z.string().nullable().optional(),
  // Since when, and why, the token broker has failed; null while it answers.
  broker: z.object({ since: z.iso.datetime(), error: z.string() }).nullable(),
  // Since when the broker has answered that the App isn't installed, with
  // its install link; null once it mints. Optional, as an older listener
  // doesn't report it.
  notInstalled: z
    .object({ since: z.iso.datetime(), installUrl: z.string() })
    .nullable()
    .optional(),
  // Since when, and why, the control plane has refused the listener's
  // service token; null while it takes it. Optional, as a listener from
  // before its VM doesn't report it.
  anycloud: z
    .object({ since: z.iso.datetime(), error: z.string() })
    .nullable()
    .optional(),
  // Telemetry's sends. Optional, as one waiting for the App has none.
  telemetry: telemetryStatusSchema.optional(),
  runners: z.number().int(),
  cap: z.number().int(),
  // The runs waiting to be rerun and the spot capacities the breaker paused,
  // such as "aws spot".
  retry: z
    .object({
      waiting: z.number().int(),
      paused: z.array(
        z.object({ capacity: z.string(), until: z.iso.datetime() }),
      ),
    })
    .optional(),
  // The runner regions the boot deadline avoids, such as "aws us-east-2",
  // with until when. Optional, as an older listener has none.
  avoided: z
    .array(z.object({ where: z.string(), until: z.iso.datetime() }))
    .optional(),
  // The planner: the workflows it has learned, those whose
  // predictions the precision guard turned off, and whether an error turned
  // it off. Counts only, no names. Optional, as an older listener has none.
  planner: z
    .object({
      keys: z.number().int(),
      guarded: z.number().int(),
      off: z.boolean(),
    })
    .optional(),
  scaleSets: z.array(
    z.object({
      label: z.string(),
      // Optional, as an older listener doesn't report it.
      cloud: z.enum(['aws', 'gcp', 'azure']).optional(),
      // A GPU label's GPU, such as T4; optional, as other labels have none.
      gpu: z.string().optional(),
      // Removed by install or upgrade: draining, then deleted.
      retiring: z.boolean().optional(),
      // Waiting for a VM; launching; running a runner.
      queued: z.number().int(),
      starting: z.number().int(),
      running: z.number().int(),
      // The oldest queued Job's age, or null with none queued.
      oldestQueuedMs: z.number().nullable(),
      // The queued Jobs' status reasons, such as a capacity error, counted.
      reasons: z.array(z.object({ reason: z.string(), count: z.number() })),
      // The control plane's 500-runner cap held this scale set back.
      capped: z.boolean(),
      // The last 15 minutes' runner Jobs still retrying a launch at the boot
      // deadline (`failover.ts`): those replaced, those with nowhere to go, the
      // regions they were slow in, and where their replacements went. Optional,
      // as an older listener has none.
      slow: z
        .object({
          replaced: z.number().int(),
          // Of them, spot ones replaced on demand (`fallback`). Optional, as
          // an older listener has none.
          onDemand: z.number().int().optional(),
          // Slow ones with no other region of their kind to go to.
          stuck: z.number().int(),
          from: z.array(z.string()),
          to: z.array(z.string()),
        })
        .optional(),
      // Its runner regions whose spot or on-demand quota can't fit one of its
      // runners, skipped until a read shows it raised. Optional, as an older
      // listener has none.
      skipped: z
        .object({
          cloud: z.enum(['aws', 'azure']),
          spot: z.boolean(),
          vcpus: z.number().int(),
          all: z.boolean(),
          // `kind`: optional, as an older listener has none.
          regions: z.array(
            z.object({
              region: z.string(),
              limit: z.number(),
              kind: quotaKind.optional(),
            }),
          ),
        })
        .optional(),
      // A spot label's regions that fit its quota, every one avoided for
      // slow boots, so none starts until `until`, or with `onDemand` (an
      // on-demand pair) its real jobs' runners start on demand until then.
      // Optional, as an older listener has none.
      avoiding: z
        .object({
          regions: z.array(z.string()),
          until: z.iso.datetime(),
          onDemand: z.boolean().optional(),
        })
        .optional(),
      // The cloud's spot or on-demand vCPU quota held this scale set back.
      // Optional, as an older listener has none.
      quota: z
        .object({
          cloud: z.enum(['aws', 'gcp', 'azure']),
          regions: z.array(z.string()),
          spot: z.boolean(),
          kind: quotaKind.optional(),
          limit: z.number(),
        })
        .optional(),
      // Runners the planner wants up ahead of predicted jobs.
      speculative: z.number().int().optional(),
      statistics: statisticsSchema.nullable(),
      // The last 24 hours and 7 days of job rows. Optional, as upgrade and
      // uninstall read an older listener's `/status`.
      jobs: z.object({ day: jobsSummary, week: jobsSummary }).optional(),
      backoff: z
        .object({
          failures: z.number().int(),
          // Such as "exited: Exited with code 1".
          lastEnd: z.string().nullable(),
          nextProbeAt: z.iso.datetime().nullable(),
        })
        .nullable(),
    }),
  ),
});
export type ListenerStatus = z.infer<typeof listenerStatusSchema>;

// `anycloud` is a refused token when the control plane answered 401.
export const tokenRefused = (anycloud: ListenerStatus['anycloud']) =>
  !!anycloud?.error.startsWith('HTTP 401');

// The part the scaler reports.
export type ScaleSetsStatus = Omit<
  ListenerStatus,
  | 'installed'
  | 'actionsPermission'
  | 'broker'
  | 'notInstalled'
  | 'anycloud'
  | 'telemetry'
>;

const seconds = (ms: number) =>
  ms < 60_000
    ? `${Math.round(ms / 1000)} s`
    : `${(ms / 60_000).toFixed(1)} min`;
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

// The label's last 24 hours in `backmesh status`, zero counts left out;
// `--json` has the rest.
export function formatJobs(set: ListenerStatus['scaleSets'][number]): string[] {
  const day = set.jobs?.day;
  if (!day) return [];
  const start = day.startMs
    ? ` · start ${seconds(day.startMs.p50)} typical, ${seconds(day.startMs.p95)} slowest`
    : '';
  const retry = [
    ...(day.reclaims ? [`${count(day.reclaims, 'job')} reclaimed`] : []),
    ...(day.reruns ? [`${count(day.reruns, 'run')} rerun`] : []),
    ...(day.fellBack
      ? [`${count(day.fellBack, 'job')} fell back on demand`]
      : []),
  ].join(', ');
  // Split once a cue or a prediction started a runner that took a job.
  const by = Object.entries(day.startedFor ?? {});
  const split = by.some(([s, b]) => s !== 'reactive' && b.jobs)
    ? by.flatMap(([s, b]) =>
        b.startMs
          ? [
              `      ${s}: ${count(b.jobs, 'job')}, start ${seconds(b.startMs.p50)} typical, ${seconds(b.startMs.p95)} slowest`,
            ]
          : [],
      )
    : [];
  return [
    ...(day.jobs ? [`    ${count(day.jobs, 'job')} today${start}`] : []),
    ...split,
    ...(retry ? [`    ${retry}`] : []),
    ...(day.startupFailures
      ? [`    ${count(day.startupFailures, 'runner')} failed to start`]
      : []),
    ...quotaWarning(set.cloud, set.gpu, day),
  ];
}

// The quota a record names; an older listener's names only spot or on demand.
export const kindOf = (spot: boolean, kind?: QuotaKind): QuotaKind =>
  kind ?? (spot ? 'spot' : 'onDemand');

const CLOUD_NAME = { aws: 'AWS', gcp: 'GCP', azure: 'Azure' } as const;

// A warning when quota held the label's runners back enough to act on: at
// least 3 runners refused for quota, with their p95 wait at least 2 minutes.
// A capacity refusal has no quota to raise. The quota named is the first of
// QUOTA_REFUSALS refused.
function quotaWarning(
  cloud: keyof typeof CLOUD_NAME | undefined,
  gpu: string | undefined,
  w: z.infer<typeof jobsSummary>,
): string[] {
  const q = w.quotaRefused;
  const wait = q?.waitMs?.p95 ?? 0;
  if (!cloud || !q || q.runners < 3 || wait < 120_000) return [];
  const first = QUOTA_REFUSALS.find((d) => w.refusedFor?.[d]);
  const regions = q.regions.join(', ');
  const spot = first === 'account-regional-spot-quota-exhausted';
  const fix =
    cloud === 'gcp'
      ? first === 'quota-exhausted-account'
        ? 'CPUS_ALL_REGIONS above its default 32'
        : `CPUS, C4D_CPUS, C3D_CPUS, N2D_CPUS and N2_CPUS in ${regions}`
      : cloud === 'azure' && !spot
        ? `the VM family's vCPU quota in ${regions}`
        : `${quotaCode(cloud, quotaKinds(cloud, spot, gpu)[0]!)} in ${regions}`;
  return [
    `    ⚠ ${q.runners} runners waited for ${CLOUD_NAME[cloud]} quota in ${regions}, up to ${seconds(wait)}.`,
    `      Raise ${fix} to start them right away.`,
  ];
}

// The planner's line in `backmesh status`, once it has learned a workflow.
export function formatPlanner(planner: ListenerStatus['planner']): string[] {
  if (planner?.off) return ['Planner: off after an error; scaling reactively'];
  if (!planner?.keys) return [];
  const guarded = planner.guarded
    ? `, ${planner.guarded} reactive (predictions under 60 % right)`
    : '';
  return [
    `Planner: ${planner.keys} workflow${planner.keys === 1 ? '' : 's'} learned${guarded}`,
  ];
}

// The queue reasons as `backmesh status` prints them under a scale set.
export function formatReasons(
  set: ListenerStatus['scaleSets'][number],
  cap: number,
): string[] {
  const lines = set.reasons.map(
    ({ reason, count }) => `    ${count} queued: ${reason}`,
  );
  if (set.speculative) {
    lines.push(`    ${set.speculative} started ahead of predicted jobs`);
  }
  if (set.capped) {
    lines.push(`    held back by the control plane's ${cap}-runner cap`);
  }
  return lines;
}

// A scale set's slow starts and quota cap.
export function formatSlow(set: ListenerStatus['scaleSets'][number]): string[] {
  const lines: string[] = [];
  const { slow, quota } = set;
  const runners = (n: number) => `${n} runner${n === 1 ? '' : 's'}`;
  if (slow?.replaced) {
    lines.push(
      `    ${runners(slow.replaced)} starting slowly in ${slow.from.join(', ')}; replaced ${slow.to.map((to) => `in ${to}`).join('; ')}${slow.onDemand ? `, ${slow.onDemand} on demand` : ''}`,
    );
  }
  if (slow?.stuck) {
    lines.push(
      `    ${runners(slow.stuck)} still retrying a launch ${BOOT_DEADLINE_MS / 1000} s after submit, with no other region to replace ${slow.stuck === 1 ? 'it' : 'them'} in`,
    );
  }
  if (set.skipped) {
    const { cloud, spot, vcpus } = set.skipped;
    for (const { region, limit, kind } of set.skipped.regions) {
      lines.push(
        `    ${region}: ${KIND_NAME[kindOf(spot, kind)]} quota ${limit} vCPU, under one ${vcpus}-vCPU runner, skipped; raise ${quotaCode(cloud, kindOf(spot, kind))} to use it`,
      );
    }
  }
  if (quota && quota.cloud !== 'gcp') {
    const kind = kindOf(quota.spot, quota.kind);
    lines.push(
      `    capped by ${quota.cloud} ${quota.regions.join(', ')} ${KIND_NAME[kind]} vCPU quota (${quota.limit}); raise ${quotaToRaise(quota.cloud, quota.regions, kind)}`,
    );
  }
  return lines;
}
