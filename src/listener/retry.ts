import { NO_RETRY_LABEL } from '../github/actions-client.js';
import type { WorkflowRun } from '../github/checks.js';
import type { Log } from '../github/retry.js';
import type { RunState, WorkflowRuns } from '../github/runs.js';
import type { JobMessage } from '../github/types.js';
import { spotCapacity } from '../runners/classes.js';
import type { Route } from './routes.js';
import {
  COMPLETED_GRACE_MS,
  type Reclaim,
  type RetryDecision,
  type Routing,
} from './scaler.js';
import { DAY_MS, type JobRow } from './timings.js';

// On-demand retry after a reclaim. Everything is in memory,
// as the listener stores nothing: a restart drops the waiting runs, a missed
// retry with no note, never a third one.
export const MAX_WAITING = 100;
// Attempt 3 is terminal, as RunsOn's: at most 2 automatic reruns.
const ATTEMPT_CAP = 3;
// RunsOn's cadence, with no time cap: every 2 minutes for the first
// hour after the reclaim, then doubling to every 30 minutes.
const POLL_MS = 2 * 60_000;
const MAX_POLL_MS = 30 * 60_000;
const HOUR_MS = 3_600_000;
// The breaker, `2/15/30` per spot capacity: a cloud's spot, or its
// KVM classes' spot.
const BREAKER_EVENTS = 2;
const BREAKER_WINDOW_MS = 15 * 60_000;
const PAUSE_MS = 30 * 60_000;
// One VM's reclaim can show in two cycles, its idle Jobs read before its busy
// ones, and anycloud's end read names no VM: cycles closer than this are one
// event.
const SAME_EVENT_MS = 5 * 60_000;
// A window whose JobStarted was lost (a response truncated past 50 messages)
// closes after this, so a scale set doesn't stay on demand.
const WINDOW_MS = 30 * 60_000;

// Job conclusions that aren't another failure. A cancelled job is fail-fast's
// doing once the reclaimed job failed.
const PASSED = new Set(['success', 'skipped', 'cancelled', 'neutral']);

// A secondary rate limit is a 403 with `retry-after` or no requests left.
function rateLimited(error: unknown): boolean {
  const headers = (
    error as { response?: { headers?: Record<string, unknown> } }
  ).response?.headers;
  return (
    headers?.['retry-after'] !== undefined ||
    String(headers?.['x-ratelimit-remaining']) === '0'
  );
}

interface Waiting {
  run: WorkflowRun;
  attempt: number;
  // The recorded reclaimed runners, and their jobs' display names with
  // their labels.
  runners: Set<string>;
  jobs: Map<string, string>;
  since: number;
  delayMs: number;
  nextAt: number;
  // When a poll first saw the run completed.
  completedAt?: number;
}

export interface RetrierDeps {
  // Reads with the install's token; reruns through the Worker's /v1/rerun.
  runs: WorkflowRuns;
  // A runner name this installation minted.
  ours: (runner: string) => boolean;
  log: Log;
  now?: () => number;
}

const runKey = ({ owner, repo, runId }: WorkflowRun) =>
  `${owner}/${repo}/${runId}`;
const jobKey = (job: JobMessage) =>
  `${job.ownerName}/${job.repositoryName}/${job.workflowRunId}/${job.jobDisplayName}`;

export class Retrier implements Routing {
  private readonly waiting = new Map<string, Waiting>();
  // The reruns' jobs expected back, by run and display name, with when.
  private readonly expected = new Map<string, number>();
  // The on-demand windows: a recognized retry from its JobAssigned to its
  // JobStarted, by job ID, with its scale set's code.
  private readonly windows = new Map<string, { code: string; at: number }>();
  // Recognized retries' job IDs, with when, until their completed row.
  private readonly retries = new Map<string, number>();
  private readonly events = new Map<string, number[]>();
  private readonly lastEvent = new Map<string, number>();
  private readonly pausedUntil = new Map<string, number>();

  constructor(private readonly deps: RetrierDeps) {}

  // Step 1, at reclaim detection: `ScalerDeps.retry`. A rejection is
  // `unavailable` there.
  async decide(run: WorkflowRun, reclaims: Reclaim[]): Promise<RetryDecision> {
    const { attempt } = await this.deps.runs.get(run);
    if (attempt >= ATTEMPT_CAP) return 'attempt-cap';
    const jobs = await this.deps.runs.jobs(run, attempt);
    const optedOut = reclaims.some((reclaim) =>
      jobs
        .find((job) => job.runnerName === reclaim.runner)
        ?.labels.includes(NO_RETRY_LABEL),
    );
    if (optedOut) return 'noretry';
    let entry = this.waiting.get(runKey(run));
    if (entry?.attempt !== attempt) {
      if (!entry && this.waiting.size >= MAX_WAITING) return 'unavailable';
      const now = this.now();
      entry = {
        run,
        attempt,
        runners: new Set(),
        jobs: new Map(),
        since: now,
        delayMs: POLL_MS,
        nextAt: now + POLL_MS,
      };
      this.waiting.set(runKey(run), entry);
    }
    const now = this.now();
    for (const { runner, job, label } of reclaims) {
      entry.runners.add(runner);
      entry.jobs.set(job, label);
      // Its rerun, backmesh's or a person's, is routed on demand (step 4).
      this.expected.set(`${runKey(run)}/${job}`, now);
    }
    return 'retry';
  }

  // Steps 2 and 3: polls each waiting run that's due and, once it's
  // completed, reruns its failed jobs through the Worker or drops it with a
  // log line. Returns the rerun rows.
  async poll(now: number): Promise<JobRow[]> {
    for (const [key, at] of this.expected) {
      if (now - at >= DAY_MS) this.expected.delete(key);
    }
    for (const [id, at] of this.retries) {
      if (now - at >= DAY_MS) this.retries.delete(id);
    }
    for (const [id, { at }] of this.windows) {
      if (now - at >= WINDOW_MS) this.windows.delete(id);
    }
    const rows: JobRow[] = [];
    for (const [key, entry] of this.waiting) {
      if (now < entry.nextAt) continue;
      try {
        const state = await this.deps.runs.get(entry.run);
        if (state.status !== 'completed') {
          if (now - entry.since >= HOUR_MS) {
            entry.delayMs = Math.min(entry.delayMs * 2, MAX_POLL_MS);
          }
          entry.nextAt = now + entry.delayMs;
          continue;
        }
        entry.completedAt ??= now;
        const skip = await this.skip(entry, state, now);
        if (skip === 'wait') {
          entry.nextAt = now + POLL_MS;
          continue;
        }
        if (!skip) await this.deps.runs.rerunFailedJobs(entry.run);
        this.waiting.delete(key);
        // The rerun's jobs are expected from now, however long it waited.
        for (const job of entry.jobs.keys()) {
          if (!skip) this.expected.set(`${key}/${job}`, now);
        }
        this.deps.log({
          msg: skip ? 'retry skipped' : 'run rerun',
          run: key,
          attempt: entry.attempt,
          ...(skip && { reason: skip }),
        });
        if (skip) continue;
        for (const label of new Set(entry.jobs.values())) {
          rows.push({ kind: 'run rerun', at: now, label, run: key });
        }
      } catch (error) {
        // GitHub refusing the call won't change by asking again; a rate
        // limit, a 429 or a 403 that says so, will.
        // The Worker's 409 while the installation lacks Actions write waits
        // for an owner to accept it.
        const { status, code } = error as { status?: unknown; code?: unknown };
        const refused =
          typeof status === 'number' &&
          status < 500 &&
          status !== 429 &&
          code !== 'actions_write_needed' &&
          !(status === 403 && rateLimited(error));
        if (refused) this.waiting.delete(key);
        else {
          // The Worker's 409 (no Actions write yet) or 429 (its limit)
          // backs off, doubling up to MAX_POLL_MS.
          if (status === 409 || status === 429) {
            entry.delayMs = Math.min(entry.delayMs * 2, MAX_POLL_MS);
          }
          entry.nextAt = now + entry.delayMs;
        }
        this.deps.log({
          msg: refused ? 'rerun refused; dropped' : 'run read failed; retrying',
          run: key,
          error: String(error),
        });
      }
    }
    return rows;
  }

  // Step 4: a recognized retry opens its scale set's on-demand window until
  // it starts; its start becomes a row saying whether its VM was spot.
  observe(
    route: Route,
    job: JobMessage,
    spot: boolean | null,
  ): JobRow | undefined {
    switch (job.messageType) {
      case 'JobAssigned':
        if (this.expected.has(jobKey(job))) {
          this.windows.set(job.jobId, { code: route.code, at: this.now() });
          this.retries.set(job.jobId, this.now());
        }
        return;
      case 'JobStarted':
        if (!this.windows.delete(job.jobId)) return;
        this.expected.delete(jobKey(job));
        return {
          kind: 'retry started',
          at: this.now(),
          label: route.label,
          jobId: job.jobId,
          runner: job.runnerName,
          onDemand: spot === false,
        };
      case 'JobCompleted':
        this.windows.delete(job.jobId);
        return;
      case 'JobAvailable':
        return;
    }
  }

  // Whether a spot route's runners get on-demand VMs: a retry waits in the
  // window, or the breaker paused the route's spot capacity.
  onDemand(route: Route, now: number): boolean {
    if (!route.onDemand) return false;
    if ((this.pausedUntil.get(spotCapacity(route)) ?? 0) > now) return true;
    return [...this.windows.values()].some(({ code }) => code === route.code);
  }

  // The breaker: a reconcile cycle with a reclaim on a spot capacity is one
  // event, merged into the last event when under 5 minutes after it; 2 in 15
  // minutes pause it for 30, and a reclaim during the pause starts it again.
  reclaimed(capacities: Set<string>, now: number): void {
    for (const capacity of capacities) {
      const last = this.lastEvent.get(capacity);
      if (last !== undefined && now - last < SAME_EVENT_MS) continue;
      this.lastEvent.set(capacity, now);
      const paused = (this.pausedUntil.get(capacity) ?? 0) > now;
      const recent = [...(this.events.get(capacity) ?? []), now].filter(
        (at) => now - at < BREAKER_WINDOW_MS,
      );
      if (!paused && recent.length < BREAKER_EVENTS) {
        this.events.set(capacity, recent);
        continue;
      }
      this.events.delete(capacity);
      this.pausedUntil.set(capacity, now + PAUSE_MS);
      this.deps.log({
        msg: 'spot paused after reclaims',
        capacity,
        until: new Date(now + PAUSE_MS).toISOString(),
      });
    }
  }

  // Whether the job was a recognized retry; asked once, for its row.
  retried(jobId: string): boolean {
    return this.retries.delete(jobId);
  }

  status(now: number) {
    return {
      waiting: this.waiting.size,
      paused: [...this.pausedUntil]
        .filter(([, until]) => until > now)
        .map(([capacity, until]) => ({
          capacity,
          until: new Date(until).toISOString(),
        })),
    };
  }

  // Why not to rerun, or `wait` while another failed job ran on one of our
  // runners whose end, maybe a reclaim, isn't read yet.
  private async skip(
    entry: Waiting,
    state: RunState,
    now: number,
  ): Promise<string | undefined> {
    if (state.attempt !== entry.attempt) return 'rerun by hand';
    // A run cancelled by a person or a `concurrency` group isn't ours to undo.
    if (state.conclusion !== 'failure') return `run ${state.conclusion}`;
    const jobs = await this.deps.runs.jobs(entry.run, entry.attempt);
    // `rerun-failed-jobs` reruns every job that didn't pass, a timed-out
    // or startup failure too.
    const others = jobs.filter(
      (job) =>
        !PASSED.has(job.conclusion ?? 'success') &&
        !entry.runners.has(job.runnerName ?? ''),
    );
    if (!others.length) return undefined;
    const pending = others.every((job) => this.deps.ours(job.runnerName ?? ''));
    return pending && now - entry.completedAt! < COMPLETED_GRACE_MS
      ? 'wait'
      : 'another job failed';
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}
