import { ORPCError } from '@orpc/client';

import type { ActionsClient } from '../github/actions-client.js';
import type { Note, WorkflowRun } from '../github/checks.js';
import type { Log } from '../github/retry.js';
import type { JobMessage, Statistics } from '../github/types.js';
import { StartupBackoff } from './backoff.js';
import type { CacheTokens } from './cache.js';
import { BOOT_DEADLINE_MS, Failover } from './failover.js';
import type { Quotas } from './quota.js';
import {
  codeClass,
  PUBLIC_VCPU_CAP,
  spotCapacity,
} from '../runners/classes.js';
import { codeOf, RUNNER_NAME, runnerName, type Route } from './routes.js';
import type { Gate } from './gate.js';
import type { Planner } from './prewarm.js';
import {
  RECOVERING,
  type ElsewhereJob,
  type JobEnd,
  type Refusal,
  type RunnerJob,
  type RunnerJobs,
} from './runner-jobs.js';
import type { ScaleSetsStatus } from './status.js';
import {
  bootSample,
  DAY_MS,
  gitHubJob,
  JobRows,
  ROWS_KEPT_MS,
  type JobRow,
  type Start,
} from './timings.js';

// The control plane's in-flight limit, across every org's listener:
// jobs above it wait at GitHub.
export const RUNNER_CAP = 500;
const SUBMITS_PER_CLOUD = 4;
// Listeners count and submit independently, so one tick submits at most
// this many: the shared cap is overshot by at most 50 per other listener.
// It isn't a per-org maximum: a tick that reaches it reconciles again.
const SUBMITS_PER_TICK = 50;
// How long a completed runner's Job may stay listed before scale-down
// terminates it: the reclaim re-read window, so a reclaim isn't read as a
// cancel.
export const COMPLETED_GRACE_MS = 10 * 60_000;

export type { WorkflowRun };

// What happens to a run's reclaimed jobs: `retry` when
// backmesh reruns them itself, else why it won't.
export type RetryDecision = 'retry' | 'noretry' | 'attempt-cap' | 'unavailable';

// A failed job whose runner's Job was reclaimed, or lost on demand.
export interface Reclaim {
  job: string;
  runner: string;
  label: string;
  spot: boolean;
  // Such as "aws m6a.xlarge us-east-2".
  vm: string;
}

// The retry's routing (`Retrier`): the on-demand window and
// the breaker pick whether a spot route's runner gets a spot VM, and the
// waiting runs are polled once per reconcile. Rows it returns go into the
// job rows.
export interface Routing {
  observe(route: Route, job: JobMessage, spot: boolean | null): JobRow | void;
  onDemand(route: Route, now: number): boolean;
  // The spot capacities (`spotCapacity`) a cycle found reclaims on.
  reclaimed(capacities: Set<string>, now: number): void;
  poll(now: number): Promise<JobRow[]>;
  retried(jobId: string): boolean;
  status(now: number): ScaleSetsStatus['retry'];
}

// The note's reason for each decision the user must act on, for `n` jobs.
const NO_RETRY: Record<
  Exclude<RetryDecision, 'retry'>,
  (n: number) => string
> = {
  unavailable: (n) =>
    `backmesh doesn't rerun ${n === 1 ? 'it' : 'them'} automatically.`,
  noretry: (n) =>
    `\`backmesh-noretry\` opted ${n === 1 ? 'it' : 'them'} out of the automatic rerun.`,
  'attempt-cap': () => "This run is at attempt 3, backmesh's limit.",
};

type Mint = { set: ScaleSet; spot: boolean; regions: string[]; start: Start };

// A runner whose job failed, until its Job's end says whether it was a
// reclaim.
interface FailedJob {
  set: ScaleSet;
  run: WorkflowRun;
  job: string;
  at: number;
}

export interface ScaleSet {
  route: Route;
  scaleSetId: number;
  statistics: Statistics | undefined;
  backoff: StartupBackoff;
  // The last reconcile held desired below TotalAssignedJobs for the cap.
  capped: boolean;
  // The last reconcile minted no more for its cloud's spot or on-demand
  // vCPU quota.
  quota?: { spot: boolean; limit: number; regions: readonly string[] };
  // Its runner regions whose quota can't fit one of its runners, skipped
  // until a read shows it raised; every one of them skipped means none can
  // start.
  skipped?: {
    cloud: 'aws' | 'azure';
    spot: boolean;
    // One runner's vCPUs, which each skipped region's quota is under.
    vcpus: number;
    regions: { region: string; limit: number }[];
    // Every one of its runner regions: none can start.
    all: boolean;
  };
  // A spot label's regions that fit its quota, every one avoided for slow
  // boots: none starts until the first avoidance ends (ms).
  avoiding?: { regions: string[]; until: number };
}

export interface ScalerDeps {
  install: string;
  jobs: RunnerJobs;
  // The cache's per-runner token Secrets.
  cache?: Pick<CacheTokens, 'prepare' | 'started' | 'completed' | 'tick'>;
  github: Pick<
    ActionsClient,
    'generateJitConfig' | 'getRunnerByName' | 'removeRunner'
  >;
  // Puts a note on the run in the listener's log.
  note: (run: WorkflowRun, note: Note) => Promise<void>;
  // The retry decision for a run's reclaims; `unavailable`
  // without, or when it fails.
  retry?: (run: WorkflowRun, reclaims: Reclaim[]) => Promise<RetryDecision>;
  routing?: Routing;
  // Queues the job's telemetry event; it never waits on the Worker.
  jobStarted?: (route: Route, job: JobMessage, spot: boolean | null) => void;
  // Speculative runners ahead of predicted jobs.
  planner?: Planner;
  // With `--public-repos`: the jobs left out of each set's count.
  gate?: Pick<Gate, 'heldOn' | 'holds' | 'tick'>;
  // The runner regions' vCPU quotas; without, nothing is capped by them.
  quotas?: Quotas;
  log: Log;
  now?: () => number;
}

// The count loop, after ARC's
// `cmd/ghalistener/scaler/scaler.go`: desired is the scale set's
// TotalAssignedJobs within the share of 500 left, actual is one listing.
// Nothing is stored per job but its rows; the sets below only hold names
// of Jobs that haven't left the listing, or whose end isn't counted yet.
export class Scaler {
  readonly sets = new Map<string, ScaleSet>();
  // Busy marks: runners named by a JobStarted.
  private readonly started = new Set<string>();
  // Runners named by a JobCompleted, with when: they take no other job, so
  // they aren't actual. Their Jobs end by themselves; scale-down
  // terminates one still listed after COMPLETED_GRACE_MS.
  private readonly completed = new Map<string, number>();
  // Runners this process minted, with whether each got a spot VM.
  private readonly minted = new Map<string, boolean>();
  // What each was started for, until its job's row or its end.
  private readonly startedFor = new Map<string, Start>();
  private readonly terminated = new Set<string>();
  // Runner Jobs past the boot deadline that were replaced, or that had
  // nowhere to be.
  private readonly slow = new Set<string>();
  // Replaced slow Jobs whose removal is still to do.
  private readonly replaced = new Set<string>();
  // Jobs whose registration scale-down removed but whose terminate failed.
  private readonly orphans = new Set<string>();
  // Jobs found slow (refused past the deadline), which scale-down takes
  // first, and each late Job's refused regions, as last read.
  private readonly slowSeen = new Set<string>();
  private readonly refusals = new Map<
    string,
    { at: number; regions: string[]; backedOff: string[] }
  >();
  readonly failover = new Failover();
  private quotasRead = false;
  private readonly failed = new Map<string, FailedJob>();
  // Runs that got a note, with when and the jobs it named.
  private readonly noted = new Map<string, { at: number; jobs: Reclaim[] }>();
  private listed: RunnerJob[] = [];
  // Other orgs' listeners' unended runner Jobs, at the last listing. Their
  // completed runners count until their Jobs end: the listing can't tell
  // them from live ones.
  private others = 0;
  private readonly rows: JobRows;
  // Completed jobs until their runner Job's timeline is read.
  private readonly joins = new Set<{
    label: string;
    job: JobMessage;
    at: number;
  }>();

  constructor(private readonly deps: ScalerDeps) {
    this.rows = new JobRows(deps.log, () => this.now());
  }

  remove(set: ScaleSet): void {
    this.sets.delete(set.route.code);
  }

  add(route: Route, scaleSetId: number): ScaleSet {
    const set: ScaleSet = {
      route,
      scaleSetId,
      statistics: undefined,
      backoff: new StartupBackoff(),
      capped: false,
    };
    this.sets.set(route.code, set);
    // The first reads start now, so the first burst is capped once they
    // answer.
    for (const spot of [true, false]) {
      this.deps.quotas?.limit(
        route.cloud,
        route.credentials,
        route.regions,
        spot,
        this.now(),
      );
    }
    return set;
  }

  observe(set: ScaleSet, job: JobMessage): void {
    // Whether a started job's VM is spot: as this process minted its runner,
    // else the listing's.
    const spot =
      this.minted.get(job.runnerName) ??
      this.listed.find((listed) => listed.id === job.runnerName)?.spot ??
      null;
    const row = this.deps.routing?.observe(set.route, job, spot);
    if (row) this.rows.add(row);
    // Public sets get no planner runners, and a fork's jobs teach it nothing.
    if (!set.route.public && !this.deps.gate?.holds(job)) {
      this.deps.planner?.observe(set.route.label, job, this.now());
    }
    switch (job.messageType) {
      case 'JobStarted':
        // Logged per delivery: a redelivered batch logs it again, so readers
        // dedupe by job ID.
        this.deps.log({
          msg: 'job started',
          at: this.now(),
          ...gitHubJob(set.route.label, job),
        });
        this.started.add(job.runnerName);
        set.backoff.reset();
        this.deps.cache?.started(set.route, job);
        if (job.jobId) this.deps.jobStarted?.(set.route, job, spot);
        return;
      case 'JobCompleted': {
        // The rows keep a redelivered completion once.
        const { jobId } = job;
        if (!(jobId && [...this.joins].some((e) => e.job.jobId === jobId))) {
          this.joins.add({ label: set.route.label, job, at: this.now() });
        }
        if (job.runnerName) {
          this.started.delete(job.runnerName);
          this.completed.set(job.runnerName, this.now());
          this.deps.cache?.completed(job.runnerName);
          // Any result but these may be a reclaim; the Job's end decides.
          if (!['succeeded', 'skipped'].includes(job.result.toLowerCase())) {
            this.failed.set(job.runnerName, {
              set,
              run: {
                owner: job.ownerName,
                repo: job.repositoryName,
                runId: job.workflowRunId,
              },
              job: job.jobDisplayName,
              at: this.now(),
            });
          }
        }
        return;
      }
      case 'JobAssigned':
      case 'JobAvailable':
        return;
    }
  }

  // GitHub's X-ScaleSetMaxCapacity: what the cap leaves this scale set.
  capacity(set: ScaleSet): number {
    // A retiring scale set is assigned no new job (`retire`).
    if (set.route.retiring) return 0;
    const others = this.listed.filter(
      (job) =>
        !this.completed.has(job.id) && this.codeOf(job) !== set.route.code,
    );
    const left = Math.max(0, RUNNER_CAP - this.others - others.length);
    if (!set.route.public) return left;
    // A public set's share of the public cap, after the other public sets'.
    const used = others.reduce((sum, job) => {
      const route = this.sets.get(this.codeOf(job) ?? '')?.route;
      return sum + (route?.public ? route.vcpus : 0);
    }, 0);
    return Math.min(
      left,
      Math.max(0, Math.floor((PUBLIC_VCPU_CAP - used) / set.route.vcpus)),
    );
  }

  // GitHub's assigned count, less the jobs the gate leaves out.
  private assigned(set: ScaleSet): number {
    return Math.max(
      0,
      (set.statistics?.totalAssignedJobs ?? 0) -
        (this.deps.gate?.heldOn(set.route.code) ?? 0),
    );
  }

  // Resolves true when the tick submitted SUBMITS_PER_TICK runners, so the
  // caller reconciles again at once. Runners are submitted straight after
  // the listing, and its housekeeping (`housekeep`) waits for them (owner,
  // 2026-11-13): what it learns, such as a startup failure or a reclaim for
  // the breaker, shapes the next cycle's runners.
  async reconcile(): Promise<boolean> {
    // The first cycle waits up to 10 s for the quota reads the scale sets
    // started, so a fresh start doesn't send runners to a region its quota
    // skips.
    if (!this.quotasRead) {
      this.quotasRead = true;
      await this.deps.quotas?.settled(10_000);
    }
    const now = this.now();
    const { mine: jobs, others, elsewhere = [] } = await this.deps.jobs.list();
    this.listed = jobs;
    this.others = others;
    const ids = new Set(jobs.map((job) => job.id));
    // The runners minted before the listing: one this cycle mints isn't
    // listed yet, and hasn't ended.
    const minted = [...this.minted.keys()];

    // Completed runners past the grace and those of a route that's gone
    // all go.
    const live = jobs.filter((job) => !this.completed.has(job.id));
    const retired = jobs.filter((job) => {
      const at = this.completed.get(job.id);
      return at === undefined
        ? !this.sets.has(this.codeOf(job) ?? '')
        : now - at >= COMPLETED_GRACE_MS;
    });
    // Scale sets' extras, removed after the submits.
    const downs: Parameters<Scaler['scaleDown']>[] = [];
    let room = RUNNER_CAP - others - live.length;
    let tick = SUBMITS_PER_TICK;
    for (const set of this.sets.values()) {
      set.quota = undefined;
      set.skipped = undefined;
      set.avoiding = undefined;
      // Recorded for `status` every cycle, whether or not the set mints.
      this.placement(set, !!this.deps.routing?.onDemand(set.route, now), now);
    }
    const quota = this.quotaLeft(jobs, elsewhere, now);
    // A replacement nets out against the slow Job it replaces, so it takes
    // the tick's submissions but not the cap's room.
    const { names: replacements, more } = await this.replaceSlow(
      live,
      tick,
      quota,
      now,
    );
    tick -= replacements.length;
    const mints: Mint[] = [];
    // A Job terminated already, and still listed, no longer counts;
    // a replacement submitted this cycle, not listed yet, does.
    const mineOf = (set: ScaleSet) =>
      live.filter(
        (job) =>
          this.codeOf(job) === set.route.code &&
          !this.terminated.has(job.id) &&
          !this.orphans.has(job.id),
      );
    const pending = (set: ScaleSet) =>
      replacements.filter(
        (name) =>
          codeOf(this.deps.install, name) === set.route.code &&
          !live.some((job) => job.id === name),
      ).length;
    // The planner's runners take only the room real jobs leave, and give
    // back what other scale sets' real jobs need, so they never hold one
    // back.
    let spare = [...this.sets.values()].reduce(
      (left, set) =>
        left -
        Math.max(0, this.assigned(set) - mineOf(set).length - pending(set)),
      room,
    );
    // What the public cap leaves (`capacity`), so a capacity GitHub had
    // before a burst can't overshoot it.
    let publicLeft =
      PUBLIC_VCPU_CAP -
      [...this.sets.values()]
        .filter((set) => set.route.public)
        .reduce(
          (sum, set) =>
            sum + (mineOf(set).length + pending(set)) * set.route.vcpus,
          0,
        );
    // Likewise with the tick's submissions.
    let spareTick = tick - (room - spare);
    // Real jobs' runners are minted in this pass, within the quota; the
    // planner's speculative ones in the next, so the quota goes to real jobs
    // first. Past the quota none is minted and the job waits
    // at GitHub until a runner ends; only what's minted spends the tick.
    const extras: {
      set: ScaleSet;
      spot: boolean;
      regions: string[];
      extra: number;
    }[] = [];
    for (const set of this.sets.values()) {
      if (!set.statistics) continue;
      const mine = mineOf(set);
      const have = mine.length + pending(set);
      const assigned = this.assigned(set);
      const real = Math.min(assigned, have + Math.max(0, room));
      const base = Math.max(have, real);
      // A retiring scale set runs the jobs it was already assigned, with
      // none started ahead (`retire`).
      const speculative =
        set.route.retiring || set.route.public
          ? 0
          : (this.deps.planner?.speculative(set.route.label, now) ?? 0);
      const desired = Math.min(
        assigned + speculative,
        Math.max(real, base + spare),
      );
      spare -= desired - base;
      set.capped = desired < assigned;
      // In the on-demand window or a breaker pause, new runners get
      // on-demand VMs and spot ones go first.
      const onDemand = !!this.deps.routing?.onDemand(set.route, now);
      if (have > desired) {
        downs.push([mine, have - desired, set.route.label, onDemand]);
        continue;
      }
      const short = Math.max(0, real - have);
      const allowed = set.backoff.allowance(
        Math.min(desired - have, tick, short + Math.max(0, spareTick)),
        now,
      );
      const { spot, regions } = this.placement(set, onDemand, now);
      const needed = Math.min(
        allowed,
        short,
        set.route.public
          ? Math.max(0, Math.floor(publicLeft / set.route.vcpus))
          : Infinity,
      );
      let count = 0;
      for (; count < needed && quota.take(set, spot, true, regions); count++) {
        mints.push({ set, spot, regions, start: 'reactive' });
      }
      if (set.route.public) publicLeft -= count * set.route.vcpus;
      room -= count;
      tick -= count;
      if (count === needed && allowed > needed && !set.route.public) {
        extras.push({ set, spot, regions, extra: allowed - needed });
      }
    }
    for (const { set, spot, regions, extra } of extras) {
      let count = 0;
      const most = Math.min(extra, tick, room, Math.max(0, spareTick));
      // A cue's slots that no idle cue runner fills yet get the first.
      const idle = mineOf(set).filter(
        (job) =>
          this.startedFor.get(job.id) === 'cue' &&
          !this.started.has(job.id) &&
          !this.completed.has(job.id),
      ).length;
      let cues =
        (this.deps.planner?.speculative(set.route.label, now, true) ?? 0) -
        idle;
      for (; count < most && quota.take(set, spot, false, regions); count++) {
        const start = cues-- > 0 ? 'cue' : 'predicted';
        mints.push({ set, spot, regions, start });
      }
      room -= count;
      tick -= count;
      spareTick -= count;
    }
    const submitted = await this.scaleUp(mints);
    // Its own time: the submits may have taken a while.
    await this.housekeep(ids, minted, retired, downs, this.now());
    return (tick === 0 && submitted) || more;
  }

  // The listing's ends, reclaims and removals, after the cycle's submits,
  // in the order they ran before them.
  private async housekeep(
    ids: Set<string>,
    minted: string[],
    retired: RunnerJob[],
    downs: Parameters<Scaler['scaleDown']>[],
    now: number,
  ): Promise<void> {
    // Never throws.
    if (this.deps.cache) await this.deps.cache.tick(ids);
    // Its reads and sweep don't hold up the cycle.
    void this.deps.gate?.tick();
    const idleReclaims = await this.countEnds(ids, minted, now);
    const { byRun: reclaims, capacities } = await this.readReclaims(ids, now);
    this.deps.routing?.reclaimed(
      new Set([...capacities, ...idleReclaims]),
      now,
    );
    for (const names of [
      this.started,
      this.completed,
      this.terminated,
      this.slow,
      this.replaced,
      this.slowSeen,
      this.refusals,
      this.orphans,
    ]) {
      for (const name of names.keys()) {
        if (!ids.has(name) && !this.minted.has(name)) names.delete(name);
      }
    }
    await this.scaleDown(retired, retired.length, 'retired');
    for (const id of this.orphans) {
      await this.deps.jobs
        .terminate(id)
        .then(() => {
          this.orphans.delete(id);
          this.terminated.add(id);
        })
        .catch((error: unknown) =>
          this.deps.log({
            msg: 'terminate failed; retrying next cycle',
            runner: id,
            error: String(error),
          }),
        );
    }
    for (const down of downs) await this.scaleDown(...down);
    // Notes wait for the replacements: they're advice, the runners aren't.
    await this.settleReclaims(reclaims, now);
    for (const row of (await this.deps.routing?.poll(now)) ?? []) {
      this.rows.add(row);
    }
    await this.joinCompleted(now);
  }

  // Milliseconds to the planner's next slot start or expiry.
  nextDue(): number | undefined {
    return this.deps.planner?.nextDue(this.now());
  }

  // At shutdown: the completed jobs still waiting for their runner Job's read
  // are written without it.
  flushJobs(): Promise<void> {
    return this.joinCompleted(this.now(), false);
  }

  // Uninstall's drain, `desired` 0, once the sessions are gone so nothing
  // mints: idle runners go as scale-down removes them, then the busy ones' Jobs
  // are terminated and their jobs fail. Returns how many runner Jobs were still
  // listed, so the caller repeats until none are.
  async drain(): Promise<number> {
    this.listed = (await this.deps.jobs.list()).mine;
    const left = this.listed.filter((job) => !this.terminated.has(job.id));
    await this.scaleDown(left, left.length, 'drain');
    for (const job of left) {
      if (this.terminated.has(job.id)) continue;
      this.terminated.add(job.id);
      await this.deps.jobs.terminate(job.id);
    }
    return this.listed.length;
  }

  // The queue counts and reasons, from the last listing, without completed
  // runners. A finalizing Job's runner has exited (anycloud
  // `src/shared/workload.ts:29-30`), so it's in no state count.
  status(): ScaleSetsStatus {
    const now = this.now();
    const actual = this.listed.filter((job) => !this.completed.has(job.id));
    return {
      runners: actual.length,
      cap: RUNNER_CAP,
      ...(this.deps.routing && { retry: this.deps.routing.status(now) }),
      ...(this.deps.planner && { planner: this.deps.planner.status() }),
      ...(this.failover.avoidedNow(now).length && {
        avoided: this.failover.avoidedNow(now).map(({ where, until }) => ({
          where,
          until: new Date(until).toISOString(),
        })),
      }),
      scaleSets: [...this.sets.values()].map((set) => {
        const mine = actual.filter(
          (job) =>
            this.codeOf(job) === set.route.code && job.state !== 'finalizing',
        );
        const queued = mine.filter((job) => job.state === 'queued');
        const running = mine.filter((job) => job.state === 'running').length;
        const oldest = Math.min(...queued.map((job) => job.submittedAt));
        const reasons = Map.groupBy(
          queued,
          (job) => job.latestMessage ?? 'no reason given',
        );
        const { failures, lastEnd, delayMs, nextProbeAt } = set.backoff;
        return {
          label: set.route.label,
          cloud: set.route.cloud,
          ...(set.route.retiring && { retiring: true }),
          queued: queued.length,
          starting: mine.length - queued.length - running,
          running,
          oldestQueuedMs: queued.length ? Math.max(0, now - oldest) : null,
          reasons: [...reasons].map(([reason, jobs]) => ({
            reason,
            count: jobs.length,
          })),
          capped: set.capped,
          ...this.slowStatus(set, now),
          ...(set.skipped && { skipped: set.skipped }),
          ...(set.avoiding && {
            avoiding: {
              regions: set.avoiding.regions,
              until: new Date(set.avoiding.until).toISOString(),
            },
          }),
          ...(set.quota && {
            quota: {
              cloud: set.route.cloud,
              spot: set.quota.spot,
              limit: set.quota.limit,
              regions: [...set.quota.regions],
            },
          }),
          ...(this.deps.planner && {
            speculative: this.deps.planner.speculative(set.route.label, now),
          }),
          statistics: set.statistics ?? null,
          jobs: {
            day: this.rows.summary(set.route.label, DAY_MS),
            week: this.rows.summary(set.route.label, ROWS_KEPT_MS),
          },
          backoff:
            delayMs === undefined
              ? null
              : {
                  failures,
                  lastEnd: lastEnd ?? null,
                  nextProbeAt:
                    nextProbeAt === undefined
                      ? null
                      : new Date(nextProbeAt).toISOString(),
                },
        };
      }),
    };
  }

  // A runner this process minted that left the listing without starting a
  // job or being scaled down is a startup failure, unless its Job was
  // reclaimed or lost (one read per such end). A failed read keeps the
  // runner for the next cycle.
  // Returns the spot capacities whose runners it found reclaimed, for the
  // breaker.
  private async countEnds(ids: Set<string>, minted: string[], now: number) {
    const capacities = new Set<string>();
    for (const name of minted) {
      if (ids.has(name)) continue;
      const set = this.sets.get(codeOf(this.deps.install, name) ?? '');
      try {
        let failure: string | undefined;
        let refusals: Refusal[] = [];
        if (
          ![this.started, this.completed, this.terminated, this.orphans].some(
            (names) => names.has(name),
          )
        ) {
          const end = await this.deps.jobs.end(name);
          // No Job: its submit never landed, so drop the registration. A Job
          // that ended before its runner started never used its JIT config:
          // drop its registration too, or it stays offline in the org.
          if (end === undefined || end.reason !== null) {
            await this.removeRegistration(name);
          }
          if (end === undefined) {
            // Nothing more to read.
          } else if (reclaimed(end)) {
            if (set?.route.onDemand && end.spot) {
              capacities.add(spotCapacity(set.route));
            }
          } else if (end.reason) {
            failure = [end.reason, end.detail].filter(Boolean).join(': ');
            refusals = end.refusals;
          }
        }
        this.minted.delete(name);
        // A job's row still to join reads it.
        if (![...this.joins].some((e) => e.job.runnerName === name)) {
          this.startedFor.delete(name);
        }
        const delay = set?.backoff.delayMs;
        set?.backoff.ended(name, failure, now);
        if (set && failure) {
          this.rows.add({
            kind: 'runner failed to start',
            at: now,
            label: set.route.label,
            runner: name,
            end: failure,
            refusals,
          });
        }
        // The backoff: shown in `status` and here, not on the jobs' runs.
        if (set && set.backoff.delayMs !== delay) {
          this.deps.log({
            msg: 'runners fail to start; backing off',
            label: set.route.label,
            failures: set.backoff.failures,
            lastEnd: set.backoff.lastEnd,
            nextProbeAt: new Date(set.backoff.nextProbeAt!).toISOString(),
          });
        }
      } catch (error) {
        this.deps.log({
          msg: 'end read failed; retrying next cycle',
          runner: name,
          error: String(error),
        });
      }
    }
    return capacities;
  }

  // A runner whose job didn't succeed gets one end read once its Job leaves
  // the listing, for up to COMPLETED_GRACE_MS: past it, scale-down may
  // terminate the Job itself. Returns the reclaims by run, and the spot
  // capacities they hit for the breaker; a failed read or a Job that hasn't
  // ended yet waits for the next cycle. A restart loses the entries, which is a missed
  // note, not a wrong one.
  private async readReclaims(ids: Set<string>, now: number) {
    const byRun = new Map<string, { run: WorkflowRun; reclaims: Reclaim[] }>();
    const capacities = new Set<string>();
    for (const [name, failed] of this.failed) {
      if (now - failed.at >= COMPLETED_GRACE_MS) {
        this.failed.delete(name);
        continue;
      }
      if (ids.has(name)) continue;
      let end: JobEnd | undefined;
      try {
        end = await this.deps.jobs.end(name);
      } catch (error) {
        this.deps.log({
          msg: 'end read failed; retrying next cycle',
          runner: name,
          error: String(error),
        });
        continue;
      }
      if (end?.reason === null) continue;
      this.failed.delete(name);
      if (!end || !reclaimed(end)) continue;
      const { run, set } = failed;
      const key = `${run.owner}/${run.repo}/${run.runId}`;
      const entry = byRun.get(key) ?? { run, reclaims: [] };
      byRun.set(key, entry);
      const { spot } = end;
      // The breaker pauses only spot with somewhere to send its runners.
      if (spot && set.route.onDemand) capacities.add(spotCapacity(set.route));
      entry.reclaims.push({
        job: failed.job,
        runner: name,
        label: set.route.label,
        spot,
        vm: [end.cloud, end.vmType, end.region].filter(Boolean).join(' '),
      });
    }
    return { byRun, capacities };
  }

  // Each reclaim goes into the job record with the run's retry decision. A
  // run gets one note: that backmesh reruns it, or that the user must
  // (owner, 2026-11-12). A later reclaim in the run, a rerun's included,
  // reposts it under the same name with every job, which replaces it on the
  // SHA.
  private async settleReclaims(
    byRun: Map<string, { run: WorkflowRun; reclaims: Reclaim[] }>,
    now: number,
  ): Promise<void> {
    for (const [key, { at }] of this.noted) {
      if (now - at >= DAY_MS) this.noted.delete(key);
    }
    for (const [key, { run, reclaims }] of byRun) {
      // Public labels have no automatic rerun.
      const onPublic = reclaims.some(
        (reclaim) =>
          [...this.sets.values()].find((s) => s.route.label === reclaim.label)
            ?.route.public,
      );
      const retry: RetryDecision =
        this.deps.retry && !onPublic
          ? await this.deps.retry(run, reclaims).catch((error: unknown) => {
              this.deps.log({
                msg: 'retry decision failed',
                run: key,
                error: String(error),
              });
              return 'unavailable' as const;
            })
          : 'unavailable';
      for (const reclaim of reclaims) {
        this.rows.add({
          kind: 'job reclaimed',
          at: now,
          ...reclaim,
          repo: `${run.owner}/${run.repo}`,
          runId: run.runId,
          retry,
        });
      }
      // A job reclaimed again in a rerun is named once, with its last VM.
      const all = [
        ...new Map(
          [...(this.noted.get(key)?.jobs ?? []), ...reclaims].map((reclaim) => [
            reclaim.job,
            reclaim,
          ]),
        ).values(),
      ];
      this.noted.set(key, { at: now, jobs: all });
      const jobs = all.map(
        ({ job, vm, spot }) =>
          `\`${job}\` (${vm ? `${vm}, ` : ''}${spot ? 'spot' : 'on demand'})`,
      );
      // An on-demand VM that ends `lost` isn't a spot reclaim.
      const vm = all.every((reclaim) => reclaim.spot) ? 'spot VM' : 'VM';
      // The on-demand labels of the jobs' sizes, for jobs that can't wait.
      const od = new Set(
        all.flatMap(({ label }) => {
          const route = [...this.sets.values()].find(
            (set) => set.route.label === label,
          )?.route;
          return route?.onDemand ? [`\`${route.onDemand.label}\``] : [];
        }),
      );
      const hint = od.size
        ? ` To start on an on-demand runner instead, use ${[...od].join(' or ')}.`
        : '';
      const lost = `${jobs.join(', ')} lost ${jobs.length === 1 ? 'its' : 'their'} ${vm}${vm === 'spot VM' ? ' to a reclaim' : ''}.`;
      await this.post(run, {
        name: `reclaims in run ${run.runId}`,
        ...(retry === 'retry'
          ? {
              title: vm === 'spot VM' ? 'Spot reclaim' : 'VM lost',
              summary: `${lost} If the run's only failures are reclaims, backmesh reruns its failed jobs once it finishes, on an on-demand runner where it can, at most twice, unless a job sets \`backmesh-noretry\`.${hint}`,
            }
          : {
              title: `Rerun needed: ${jobs.length === 1 ? 'a job' : `${jobs.length} jobs`} lost a ${vm}`,
              summary: `${lost} ${NO_RETRY[retry](jobs.length)} Rerun the failed jobs from the Actions tab once the run finishes.${hint}`,
            }),
      });
    }
  }

  // Each completed job's row, with its runner Job's timeline: one read each,
  // none when `read` is false. A failed read is retried next cycle for up to
  // COMPLETED_GRACE_MS, then the row goes without it.
  private async joinCompleted(now: number, read = true): Promise<void> {
    for (const entry of this.joins) {
      const { label, job, at } = entry;
      let runnerJob = null;
      try {
        if (read && job.runnerName) {
          runnerJob = (await this.deps.jobs.timeline(job.runnerName)) ?? null;
        }
      } catch (error) {
        if (now - at < COMPLETED_GRACE_MS) continue;
        this.deps.log({
          msg: 'runner Job read failed; its row has no timeline',
          runner: job.runnerName,
          error: String(error),
        });
      }
      this.joins.delete(entry);
      const start = this.startedFor.get(job.runnerName) ?? null;
      this.startedFor.delete(job.runnerName);
      const { startMs, registerMs } = bootSample(job, runnerJob);
      this.deps.planner?.booted(label, startMs, registerMs);
      const { result } = job;
      const retry = this.deps.routing?.retried(job.jobId);
      this.rows.add({
        kind: 'job completed',
        at,
        ...gitHubJob(label, job),
        result,
        runnerJob,
        start,
        ...(retry && { retry }),
      });
    }
  }

  // Idle extras go, queued Jobs first. The registration is removed before
  // the Job, and GitHub refuses a runner with a job, so a busy runner is
  // never terminated, even when a restart lost its busy mark. A failure
  // leaves the extras to the next cycle.
  private async scaleDown(
    jobs: RunnerJob[],
    excess: number,
    label: string,
    // In the on-demand window: on-demand runners go last.
    keepOnDemand = false,
  ): Promise<void> {
    const kept = (job: RunnerJob) => Number(keepOnDemand && !job.spot);
    // Slow ones past the boot deadline go first, then queued ones.
    const order = (job: RunnerJob) =>
      this.slowSeen.has(job.id) ? 0 : job.state === 'queued' ? 1 : 2;
    // A Job terminated already, and still listed, has nothing left to
    // remove.
    const idle = jobs
      .filter(
        (job) => !this.started.has(job.id) && !this.terminated.has(job.id),
      )
      .sort((a, b) => kept(a) - kept(b) || order(a) - order(b));
    try {
      for (const job of idle) {
        if (excess === 0) return;
        if ((await this.removeRegistration(job.id)) === 'busy') {
          // A completed runner is skipped this cycle only, so its Job
          // still goes once GitHub lets the registration go.
          if (!this.completed.has(job.id)) this.started.add(job.id);
          continue;
        }
        // Marked only once it's gone. Its registration is, so it can take no
        // job: it's an orphan whose terminate is retried every cycle.
        this.orphans.add(job.id);
        await this.deps.jobs.terminate(job.id);
        this.orphans.delete(job.id);
        this.terminated.add(job.id);
        excess--;
      }
    } catch (error) {
      this.deps.log({ msg: 'scale-down failed', label, error: String(error) });
    }
  }

  private async removeRegistration(name: string) {
    const runner = await this.deps.github.getRunnerByName(name);
    return runner && this.deps.github.removeRunner(runner.id);
  }

  // Up to 4 submissions at a time per cloud. The first failure stops the
  // cycle's submissions, so a cycle mints at most desired − actual; the next
  // cycle recounts. Resolves false when a failure stopped it.
  private async scaleUp(mints: Mint[]): Promise<boolean> {
    const byCloud = Map.groupBy(mints, (mint) => mint.set.route.cloud);
    let stopped = false;
    const worker = async (queue: typeof mints) => {
      for (let next = queue.shift(); next && !stopped; next = queue.shift()) {
        const { set, spot, regions, start } = next;
        await this.mint(set, spot, regions, true, start).catch(
          (error: unknown) => {
            stopped = true;
            this.deps.log({
              msg: 'runner submit failed; stopping this cycle',
              label: set.route.label,
              error: String(error),
            });
          },
        );
      }
    };
    await Promise.all(
      [...byCloud.values()].flatMap((queue) =>
        Array.from({ length: SUBMITS_PER_CLOUD }, () => worker(queue)),
      ),
    );
    return !stopped;
  }

  // `regions`: from `placement`, or a replacement's. A replacement (`probe`
  // false) isn't the startup-failure backoff's probe.
  private async mint(
    set: ScaleSet,
    spot: boolean,
    regions: readonly string[],
    probe = true,
    start: Start = 'reactive',
  ): Promise<string> {
    const { install, github, jobs } = this.deps;
    const { cloud, credentials, vmTypes, kvm, vcpus, code } = set.route;
    const name = runnerName(install, code);
    // The cache Secret is saved alongside: one left by a failed JIT call
    // goes with the cache's orphans (`CacheTokens.tick`).
    const [jit, secrets] = await Promise.all([
      github.generateJitConfig(set.scaleSetId, name),
      this.deps.cache?.prepare(name),
    ]);
    this.minted.set(name, spot);
    this.startedFor.set(name, start);
    if (probe) set.backoff.minted(name);
    try {
      await jobs.submit({
        ...(secrets && { secrets }),
        cloud,
        regions: [...regions],
        credentials,
        vmTypes,
        kvm,
        vcpus,
        spot,
        id: name,
        jitConfig: jit.encodedJitConfig,
      });
    } catch (error) {
      // A refusal means no Job: drop its registration. Otherwise (a 5xx,
      // which a gateway's 502 or 504 can send after the Job landed, or a
      // timeout), the next listing or end read finds out.
      if (error instanceof ORPCError && error.status < 500) {
        this.minted.delete(name);
        this.startedFor.delete(name);
        set.backoff.ended(name, undefined, this.now());
        await github.removeRunner(jit.runner.id);
      }
      throw error;
    }
    return name;
  }

  // The boot deadline (`failover.ts`): of a scale set's runner Jobs with no
  // VM BOOT_DEADLINE_MS after their submit and a launch the cloud refused,
  // as many as its assigned jobs lack runners get a replacement, oldest
  // first, so the planner's speculative runners never fail over. The
  // replacement goes to the route's other regions, of the same kind, else
  // nowhere (owner, 2026-11-09: a spot label never fails over on demand).
  // Once it's submitted the slow Job goes, unless its runner took a job
  // meanwhile, when the replacement is an extra that scale-down removes; a
  // slow Job whose removal failed is retried next cycle, and scale-down
  // takes slow Jobs first. Replacements share the
  // tick's submissions (not the cap's room: each nets out), skip a scale set
  // in its startup-failure backoff, and stop at the first failed submit.
  // Returns the replacements' names.
  private async replaceSlow(
    live: RunnerJob[],
    tick: number,
    quota: ReturnType<Scaler['quotaLeft']>,
    now: number,
  ): Promise<{ names: string[]; more: boolean }> {
    const submitted: string[] = [];
    // Slow Jobs left for the next cycle by the per-cycle limit: the cycle
    // runs again at once.
    let more = false;
    let reads = READS_PER_TICK;
    for (const set of this.sets.values()) {
      if (!set.statistics) continue;
      const mine = live.filter(
        (job) =>
          this.codeOf(job) === set.route.code &&
          !this.terminated.has(job.id) &&
          !this.orphans.has(job.id),
      );
      // Replaced already: only its removal is left.
      for (const job of mine.filter((job) => this.replaced.has(job.id))) {
        await this.dropSlow(job).catch((error: unknown) =>
          this.deps.log({
            msg: 'slow runner removal failed; retrying next cycle',
            runner: job.id,
            error: String(error),
          }),
        );
      }
      const late = mine
        .filter((job) => this.isLate(job, now))
        .sort((a, b) => a.submittedAt - b.submittedAt);
      const need = this.assigned(set) - (mine.length - late.length);
      // A scale set whose runners fail to start would fail its
      // replacements too: its backoff decides.
      if (set.backoff.delayMs !== undefined) continue;
      for (const job of late.slice(0, Math.max(0, need))) {
        if (this.slow.has(job.id)) continue;
        if (submitted.length >= Math.min(tick, REPLACEMENTS_PER_TICK)) {
          more = true;
          break;
        }
        if (
          !this.refusals.has(job.id) ||
          now - this.refusals.get(job.id)!.at >= 60_000
        ) {
          if (reads-- <= 0) {
            more = true;
            break;
          }
        }
        try {
          const name = await this.replace(set, job, quota, now);
          if (name) submitted.push(name);
        } catch (error) {
          this.deps.log({
            msg: 'slow runner replacement failed; stopping this cycle',
            runner: job.id,
            error: String(error),
          });
          return { names: submitted, more: false };
        }
      }
    }
    return { names: submitted, more };
  }

  // Past the deadline with no VM yet: slow if the cloud refused one of its
  // launches (`replace` reads that), not if it's waiting its turn in
  // anycloud's own provisioning queue.
  private isLate(job: RunnerJob, now: number) {
    return (
      !HAS_VM.has(job.state) &&
      // `provisioning` is anycloud trying a launch, maybe its next untried
      // type straight after a refusal: not yet waiting on a backoff.
      job.state !== 'provisioning' &&
      !this.started.has(job.id) &&
      !this.terminated.has(job.id) &&
      now - job.submittedAt >= BOOT_DEADLINE_MS
    );
  }

  // Resolves the replacement's name when it submitted one.
  private async replace(
    set: ScaleSet,
    job: RunnerJob,
    quota: ReturnType<Scaler['quotaLeft']>,
    now: number,
  ) {
    const { route } = set;
    const kind = { ...route, spot: job.spot };
    // Where the cloud refused its launches: none, and it's only waiting in
    // anycloud's queue, which another region wouldn't help. Read at most
    // once a minute per Job.
    let from: string[];
    let backedOff: string[];
    try {
      ({ regions: from, backedOff } = await this.refusedIn(job.id, now));
    } catch (error) {
      // One Job's read failing stops no other's replacement.
      this.deps.log({
        msg: 'slow runner timeline read failed; retrying next cycle',
        runner: job.id,
        error: String(error),
      });
      return undefined;
    }
    if (!from.length) return undefined;
    this.slowSeen.add(job.id);
    const rest = this.fits(set, job.spot, now).filter(
      (region) =>
        !from.includes(region) && !this.failover.avoiding(kind, region, now),
    );
    // Avoiding a region changes something only for a route with another
    // region its quota fits: avoiding the only one would start none.
    // A miss is a region whose refusal sent it into a backoff, with no
    // untried target left: one anycloud moved on from at once may have
    // launched on its next VM type had it not been replaced at 75 s.
    const missed = () => {
      if (this.fits(set, job.spot, now).length > 1) {
        this.failover.missed(kind, backedOff, now);
      }
    };
    let to: string;
    let name: string;
    if (rest.length) {
      // Pinned to regions the slow one wasn't in: their quota, not its.
      if (!quota.take(set, job.spot, true, rest)) return undefined;
      to = rest.join(', ');
      name = await this.mint(set, job.spot, rest, false);
    } else {
      this.slow.add(job.id);
      missed();
      this.failover.replacedOne({
        label: route.label,
        from,
        to: null,
        at: now,
      });
      this.deps.log({
        msg: 'runner starting slowly; nowhere to replace it',
        runner: job.id,
        label: route.label,
      });
      return undefined;
    }
    this.slow.add(job.id);
    this.replaced.add(job.id);
    missed();
    this.failover.replacedOne({ label: route.label, from, to, at: now });
    this.deps.log({
      msg: 'runner starting slowly; replaced',
      runner: job.id,
      replacement: name,
      label: route.label,
      from,
      to,
    });
    await this.dropSlow(job).catch((error: unknown) =>
      this.deps.log({
        msg: 'slow runner removal failed; retrying next cycle',
        runner: job.id,
        error: String(error),
      }),
    );
    return name;
  }

  // The replaced Job goes, unless its runner took a job; it's marked
  // terminated only once it is, so a failure is retried.
  private async dropSlow(job: RunnerJob) {
    if ((await this.removeRegistration(job.id)) === 'busy') {
      this.started.add(job.id);
    } else {
      await this.deps.jobs.terminate(job.id);
      this.terminated.add(job.id);
    }
    this.replaced.delete(job.id);
  }

  // The regions the cloud refused the Job's launches in, and those whose
  // refusal sent it into a backoff, from its timeline, read at most once a
  // minute.
  private async refusedIn(id: string, now: number) {
    const cached = this.refusals.get(id);
    if (cached && now - cached.at < 60_000) return cached;
    const timeline = await this.deps.jobs.timeline(id);
    const regions = [...new Set(timeline?.refusals.map((r) => r.region))];
    const read = { at: now, regions, backedOff: timeline?.backedOff ?? [] };
    this.refusals.set(id, read);
    return read;
  }

  // The vCPUs each route's spot or on-demand quota leaves: the limits of its
  // own runner regions, summed (a runner Job may launch in any of them, so a
  // full region spills to the others), less the vCPUs of every runner Job
  // that may hold quota in them: of the cloud and kind, launched in one of
  // those regions or, this listener's not yet placed, allowed in one. That's
  // this listener's (completed ones still on their VMs included) and other
  // orgs' listeners' placed ones on the control plane, which share its cloud
  // connections. An unknown quota (GCP's, or before its first read) holds
  // nothing back. `take` spends a runner's, or records the cap on the set
  // and answers false.
  private quotaLeft(jobs: RunnerJob[], elsewhere: ElsewhereJob[], now: number) {
    interface Holder {
      cloud: string;
      spot: boolean;
      vcpus: number;
      // Where it is or may launch.
      regions: readonly string[];
    }
    const holders: Holder[] = [];
    for (const job of jobs) {
      const route = this.sets.get(this.codeOf(job) ?? '')?.route;
      if (!route) continue;
      holders.push({
        cloud: route.cloud,
        spot: job.spot,
        vcpus: route.vcpus,
        regions: job.region ? [job.region] : route.regions,
      });
    }
    // Another listener's Job not yet placed holds no quota anywhere yet.
    for (const job of elsewhere) {
      const of = RUNNER_NAME.test(job.id)
        ? codeClass(job.id.slice(8, 10))
        : undefined;
      if (!of || !job.region) continue;
      holders.push({
        cloud: of.cloud,
        spot: job.spot,
        vcpus: of.vcpus,
        regions: [job.region],
      });
    }
    const room = (route: Route, spot: boolean, regions: readonly string[]) => {
      const limit = this.deps.quotas?.limit(
        route.cloud,
        route.credentials,
        regions,
        spot,
        now,
      );
      if (limit === undefined) return undefined;
      const used = holders
        .filter(
          (h) =>
            h.cloud === route.cloud &&
            h.spot === spot &&
            h.regions.some((r) => regions.includes(r)),
        )
        .reduce((sum, h) => sum + h.vcpus, 0);
      return { limit, room: limit - used };
    };
    return {
      // The quota of the regions the runner may go to, as `mint` sends.
      // `record` false: a speculative runner held back isn't a cap to show.
      take: (
        set: ScaleSet,
        spot: boolean,
        record: boolean,
        regions: readonly string[],
      ): boolean => {
        const { route } = set;
        // Every runner region skipped for quota: none can start.
        if (!regions.length) return false;
        const quota = room(route, spot, regions);
        if (!quota) return true;
        if (quota.room < route.vcpus) {
          if (record) set.quota = { spot, limit: quota.limit, regions };
          return false;
        }
        holders.push({ cloud: route.cloud, spot, vcpus: route.vcpus, regions });
        return true;
      },
    };
  }

  // A set's new runners' kind and regions this cycle: spot unless it's an
  // `od-*` label or in the on-demand window; then the regions that fit
  // that kind's quota, less those the failover avoids. Records the regions
  // skipped for `status`; none left means none of its runners can start.
  private placement(set: ScaleSet, onDemand: boolean, now: number) {
    const { route } = set;
    const usable = (spot: boolean) => {
      const { fit, skipped } = this.fitting(set, spot, now);
      return {
        fit,
        skipped,
        open: fit.filter(
          (region) => !this.failover.avoiding({ ...route, spot }, region, now),
        ),
      };
    };
    let spot = route.spot && !onDemand;
    let kind = usable(spot);
    // The on-demand window or pause on a spot route, with no region
    // fitting the on-demand quota: spot where it fits, rather than none. The
    // on-demand regions it skipped are shown, with all false.
    let spotInstead: typeof kind | undefined;
    if (route.spot && onDemand && !kind.fit.length) {
      const sp = usable(true);
      if (sp.fit.length) {
        spotInstead = kind;
        spot = true;
        kind = sp;
      }
    }
    const shown = spotInstead ?? kind;
    if (shown.skipped.length && route.cloud !== 'gcp') {
      set.skipped = {
        cloud: route.cloud,
        spot: spotInstead ? false : spot,
        vcpus: route.vcpus,
        regions: shown.skipped,
        all: !spotInstead && !kind.fit.length,
      };
    }
    // No region left open (every one skipped for quota, or avoided): none
    // starts, and its jobs wait at GitHub. A spot label never falls back on
    // demand for it (owner, 2026-11-09). On-demand runners whose every
    // region that fits is avoided keep starting in them, as the breaker never
    // left them none before.
    if (!kind.open.length && kind.fit.length) {
      if (!spot) return { spot, regions: kind.fit };
      set.avoiding = {
        regions: kind.fit,
        until: Math.min(
          ...kind.fit.map((region) =>
            this.failover.until({ ...route, spot }, region),
          ),
        ),
      };
    }
    return { spot, regions: kind.open };
  }

  // The route's runner regions whose quota fits one of its runners, or isn't
  // known (GCP's never is). Those that don't stay in its list, and are
  // skipped until a read shows the quota raised.
  private fits(set: ScaleSet, spot: boolean, now: number): string[] {
    return this.fitting(set, spot, now).fit;
  }

  private fitting(set: ScaleSet, spot: boolean, now: number) {
    const { route } = set;
    const skipped: { region: string; limit: number }[] = [];
    const fit = route.regions.filter((region) => {
      const limit = this.deps.quotas?.regionLimit(
        route.cloud,
        route.credentials,
        region,
        spot,
        now,
      );
      if (limit === undefined || limit >= route.vcpus) return true;
      skipped.push({ region, limit });
      return false;
    });
    return { fit, skipped };
  }

  // The scale set's slow runners in the last 15 minutes, for `status`.
  private slowStatus(set: ScaleSet, now: number) {
    const slow = this.failover.status(set.route.label, now);
    return slow ? { slow } : {};
  }

  // A failed post is logged and not retried: the note is advice.
  private async post(run: WorkflowRun, note: Note): Promise<void> {
    await this.deps.note(run, note).catch((error: unknown) =>
      this.deps.log({
        msg: 'note failed',
        run: `${run.owner}/${run.repo}/${run.runId}`,
        error: String(error),
      }),
    );
  }

  private codeOf(job: RunnerJob): string | undefined {
    return codeOf(this.deps.install, job.id);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

// A runner Job in these states has a VM, booting or up, wherever anycloud
// placed it: it isn't slow to launch (anycloud `src/shared/workload.ts`,
// `DEPLOY_STEPS` after provisioning).
const HAS_VM = new Set([
  'initializing',
  'downloading',
  'syncing',
  'starting',
  'running',
  RECOVERING,
  'finalizing',
]);
// Timeline reads for late Jobs per reconcile, cached a minute each: a
// burst's late Jobs are read over a few cycles, not all in one.
const READS_PER_TICK = 20;
// Replacements per reconcile, each a few calls in turn, so a burst's don't
// hold up the cycle's scale-downs.
const REPLACEMENTS_PER_TICK = 10;

// The Job's VM was reclaimed or went away.
function reclaimed(end: JobEnd): boolean {
  return end.reason === 'reclaimed' || end.reason === 'lost';
}
