import { ORPCError } from '@orpc/client';

import type { JobMessage, Runner } from '../../../src/github/types.js';
import type { Route } from '../../../src/listener/routes.js';
import type {
  JobEnd,
  RunnerJob,
  RunnerJobs,
  RunnerSpec,
  RunnerTimeline,
} from '../../../src/listener/runner-jobs.js';
import type { Note, WorkflowRun } from '../../../src/github/checks.js';
import { Scaler, type ScalerDeps } from '../../../src/listener/scaler.js';

export const INSTALL = 'abc12';
export const ROUTE: Route = {
  label: 'backmesh-ubuntu-2404-4vcpu',
  code: 'a4',
  cloud: 'aws',
  region: 'us-east-2',
  credentials: 'bm-aws',
  vcpus: 4,
  spot: true,
  kvm: false,
  vmTypes: ['m6a.xlarge', 'm7a.xlarge'],
  regions: ['us-east-2'],
};

const VM = {
  cloud: 'aws',
  region: 'us-east-2',
  vmType: 'm6a.xlarge',
  refusals: [],
};

// anycloud's Jobs: `end` moves one out of the listing with an end reason. A
// submitted Job's timeline has it running 30 s after its submit.
export function fakeJobs(now: () => number = () => 0) {
  const live = new Map<string, RunnerJob>();
  const ended = new Map<string, JobEnd>();
  const submitted: RunnerSpec[] = [];
  const terminated: string[] = [];
  let failSubmit = 0;
  let submitStatus = 400;
  let failEndReads = 0;
  let failTimelineReads = 0;
  // Other orgs' listeners' unended runner Jobs on the control plane.
  const control = {
    others: 0,
    elsewhere: [] as { id: string; spot: boolean; region: string | null }[],
  };
  const timelines = new Map<string, RunnerTimeline>();
  // Runs inside each end read, as a message can arrive during one.
  let duringEndRead = () => {};
  const jobs: RunnerJobs = {
    list: async () => ({
      mine: [...live.values()],
      others: control.others,
      elsewhere: control.elsewhere,
    }),
    submit: async (spec) => {
      // A 5xx here is a gateway's, after the Job landed.
      const landed = failSubmit === 0 || submitStatus >= 500;
      if (landed) {
        submitted.push(spec);
        timelines.set(spec.id, {
          submittedAt: now(),
          dockerReadyAt: now() + 20_000,
          pulledAt: now() + 25_000,
          prepulled: true,
          runningAt: now() + 30_000,
          region: spec.regions[0]!,
          refusals: [],
          backedOff: [],
          refusedUntil: null,
        });
        live.set(spec.id, {
          id: spec.id,
          state: 'queued',
          submittedAt: now(),
          latestMessage: null,
          spot: spec.spot,
        });
      }
      if (failSubmit > 0) {
        failSubmit--;
        throw new ORPCError('FAILED', { status: submitStatus });
      }
    },
    end: async (id) => {
      duringEndRead();
      if (failEndReads > 0) {
        failEndReads--;
        throw new ORPCError('INTERNAL_SERVER_ERROR', { status: 500 });
      }
      return ended.get(id);
    },
    timeline: async (id) => {
      if (failTimelineReads > 0) {
        failTimelineReads--;
        throw new ORPCError('INTERNAL_SERVER_ERROR', { status: 500 });
      }
      return timelines.get(id);
    },
    terminate: async (id) => {
      terminated.push(id);
      const spot = live.get(id)?.spot ?? true;
      live.delete(id);
      ended.set(id, { ...VM, spot, reason: 'cancelled', detail: null });
    },
  };
  return {
    jobs,
    live,
    control,
    submitted,
    terminated,
    failNextSubmits: (count: number, status = 400) => {
      failSubmit = count;
      submitStatus = status;
    },
    // Sets a listed Job's state, on a spot VM.
    setState: (id: string, state: string, fields: Partial<RunnerJob> = {}) =>
      live.set(id, {
        id,
        state,
        submittedAt: 0,
        latestMessage: null,
        spot: true,
        ...fields,
      }),
    failNextEndReads: (count: number) => (failEndReads = count),
    failNextTimelineReads: (count: number) => (failTimelineReads = count),
    onEndRead: (hook: () => void) => (duringEndRead = hook),
    // `null` leaves the listing before the end is recorded.
    end: (
      id: string,
      reason: JobEnd['reason'],
      detail: string | null = null,
    ) => {
      const spot = live.get(id)?.spot ?? true;
      live.delete(id);
      ended.set(id, { ...VM, spot, reason, detail });
    },
  };
}

// The Actions service's runners: removal is refused for a busy one.
export function fakeRunners() {
  const runners = new Map<string, Runner>();
  const busy = new Set<string>();
  const calls: string[] = [];
  let next = 1;
  let failLookups = 0;
  return {
    runners,
    busy,
    calls,
    failNextLookups: (count: number) => (failLookups = count),
    github: {
      generateJitConfig: async (scaleSetId: number, name: string) => {
        calls.push(`mint ${name}`);
        const runner = { id: next++, name, runnerScaleSetId: scaleSetId };
        runners.set(name, runner);
        return { runner, encodedJitConfig: `jit-${name}` };
      },
      getRunnerByName: async (name: string) => {
        if (failLookups > 0) {
          failLookups--;
          throw new Error('lookup failed');
        }
        return runners.get(name);
      },
      removeRunner: async (id: number) => {
        const runner = [...runners.values()].find((r) => r.id === id);
        if (runner && busy.has(runner.name)) return 'busy' as const;
        calls.push(`remove ${runner?.name}`);
        if (runner) runners.delete(runner.name);
        return 'removed' as const;
      },
    },
  };
}

export function setup(
  routes: Route[] = [ROUTE],
  retry?: ScalerDeps['retry'],
  routing?: ScalerDeps['routing'],
  jobStarted?: ScalerDeps['jobStarted'],
  planner?: ScalerDeps['planner'],
  quotas?: ScalerDeps['quotas'],
  cache?: ScalerDeps['cache'],
  gate?: ScalerDeps['gate'],
) {
  const clock = { now: 0 };
  const anycloud = fakeJobs(() => clock.now);
  const github = fakeRunners();
  const notes: { run: WorkflowRun; note: Note }[] = [];
  const logs: ({ msg: string } & Record<string, unknown>)[] = [];
  const make = () =>
    new Scaler({
      install: INSTALL,
      jobs: anycloud.jobs,
      github: github.github,
      note: async (run, note) => {
        github.calls.push(`note ${note.name}`);
        notes.push({ run, note });
      },
      retry,
      routing,
      jobStarted,
      planner,
      quotas,
      cache,
      gate,
      log: (entry) => void logs.push(entry),
      now: () => clock.now,
    });
  const scaler = make();
  const sets = routes.map((route, i) => scaler.add(route, i + 1));
  return { anycloud, github, clock, notes, logs, scaler, sets, make };
}

export const assigned = (totalAssignedJobs: number) => ({
  totalAvailableJobs: 0,
  totalAcquiredJobs: 0,
  totalAssignedJobs,
  totalRunningJobs: 0,
  totalRegisteredRunners: 0,
  totalBusyRunners: 0,
  totalIdleRunners: 0,
});

// A scale-set job message for run 7's `test` job in acme/app.
export const message = (
  messageType: JobMessage['messageType'],
  fields: Partial<JobMessage> = {},
): JobMessage => ({
  messageType,
  runnerRequestId: 0,
  repositoryName: 'app',
  ownerName: 'acme',
  jobId: 'job-1',
  jobDisplayName: 'test',
  jobWorkflowRef: '',
  workflowRunId: 7,
  eventName: 'push',
  requestLabels: [ROUTE.label],
  queueTime: null,
  scaleSetAssignTime: null,
  runnerAssignTime: null,
  finishTime: null,
  runnerId: 0,
  runnerName: '',
  result: '',
  ...fields,
});

// Runs one failed job on `set` and ends its runner's Job with `reason`.
export async function failJob(
  env: ReturnType<typeof setup>,
  set: ReturnType<typeof setup>['sets'][number],
  reason: JobEnd['reason'],
  jobId = 'job-1',
) {
  set.statistics = assigned(1);
  await env.scaler.reconcile();
  const id = env.anycloud.submitted.at(-1)!.id;
  const fields = { runnerName: id, result: 'Failed', jobId };
  env.scaler.observe(set, message('JobStarted', fields));
  env.scaler.observe(set, message('JobCompleted', fields));
  set.statistics = assigned(0);
  env.anycloud.end(id, reason);
  await env.scaler.reconcile();
  return id;
}
