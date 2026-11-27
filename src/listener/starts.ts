// A job's start, from the REST jobs list ahead of its JobStarted, for its
// cache token: GitHub sends JobStarted to the listener late and in batches
// (v0.7.2: the token came a median 21 s into the job, the mint and the
// Secret's delivery under 2 s of that), while the list names the job's
// runner about 2 s after its start (#94's measurement, 2026-11-22).
// JobAssigned names no runner, and a cold runner takes its job 30-60 s
// later, so each run with a job assigned to this listener and not yet
// started is read on a schedule from the job's JobAssigned (`AFTER_S`),
// one read for all of the run's jobs, until each is started or its schedule
// ends; JobStarted stays the fallback.
//
// The cost: at most `AFTER_S.length` reads a run's wave, each conditional on
// the run's last ETag (a 304 costs none of the hourly limit); at most 60 a
// minute, 5 at once, for GitHub's secondary limits; none below a reserve of
// the hourly limit, nor while GitHub asks for a pause. Each run's watch logs
// its reads as `job start reads`.
import { setTimeout as sleep } from 'node:timers/promises';

import type { WorkflowRun } from '../github/checks.js';
import type { Log } from '../github/retry.js';
import type { RunJobs } from '../github/runs.js';
import type { JobMessage } from '../github/types.js';
import type { Route } from './routes.js';

// Seconds from a job's JobAssigned: early for a runner already waiting,
// closer around a cold runner's boot.
export const AFTER_S = [3, 8, 15, 22, 30, 38, 46, 55, 70, 90];
// Two jobs' schedules a little apart share reads.
const GAP_MS = 2_000;
const PER_MS = 60 / 60_000;
const AT_ONCE = 5;
const READ_TIMEOUT_MS = 10_000;
// Kept for the listener's other reads: 1,500 of 5,000, 2,500 of 12,500.
const RESERVE = (limit: number) => Math.max(1_500, limit * 0.2);
// A refusal for the rate limit with no retry-after.
const PAUSE_MS = 60_000;

export interface StartsDeps {
  jobs(run: WorkflowRun, etag?: string, signal?: AbortSignal): Promise<RunJobs>;
  // Whether `runner` is one of `route`'s still waiting for its job.
  waiting(route: Route, runner: string): boolean;
  // `startedAt`: GitHub's, from the list.
  started(route: Route, job: JobMessage, startedAt: number): void;
  log: Log;
  now?: () => number;
}

interface Watched {
  route: Route;
  job: JobMessage;
  at: number;
  // The run attempt and head SHA the list first named it with.
  attempt?: string;
}

interface Run {
  key: string;
  run: WorkflowRun;
  jobs: Map<string, Watched>;
  next: number;
  etag?: string;
  reading?: true;
  // Logged when its watch ends: reads, 304s among them, tokens started.
  counts: { reads: number; unchanged: number; fromList: number };
}

const key = (job: JobMessage) =>
  `${job.ownerName}/${job.repositoryName}/${job.workflowRunId}`;

// A job's first read after `t`, or undefined once its schedule is over.
const slot = (w: Watched, t: number) =>
  AFTER_S.map((s) => w.at + s * 1000).find((at) => at > t);

export class Starts {
  private readonly runs = new Map<string, Run>();
  private tokens = AT_ONCE;
  private reading = 0;
  private filledAt: number;
  private heldUntil = -Infinity;
  private reset = -Infinity;

  constructor(private readonly deps: StartsDeps) {
    this.filledAt = this.now();
  }

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  observe(route: Route, job: JobMessage): void {
    if (job.messageType === 'JobAssigned') {
      // Never a job whose run or ref can't be read.
      if (
        !job.jobId ||
        !job.ownerName ||
        !job.repositoryName ||
        !job.workflowRunId ||
        !job.jobWorkflowRef ||
        !job.eventName
      )
        return;
      let run = this.runs.get(key(job));
      if (!run) {
        run = {
          key: key(job),
          run: {
            owner: job.ownerName,
            repo: job.repositoryName,
            runId: job.workflowRunId,
          },
          jobs: new Map(),
          next: Infinity,
          counts: { reads: 0, unchanged: 0, fromList: 0 },
        };
        this.runs.set(key(job), run);
      }
      // A redelivery keeps the job's schedule.
      if (run.jobs.has(job.jobId)) return;
      const w = { route, job, at: this.now() };
      run.jobs.set(job.jobId, w);
      run.next = Math.min(run.next, slot(w, -Infinity)!);
    } else if (
      job.messageType === 'JobStarted' ||
      job.messageType === 'JobCompleted'
    ) {
      const run = this.runs.get(key(job));
      if (run?.jobs.delete(job.jobId)) this.end(run);
    }
  }

  // Ends a run's watch, logging its reads, once no job is left.
  private end(run: Run) {
    if (run.jobs.size > 0 || run.reading) return;
    this.runs.delete(run.key);
    const { owner, repo, runId } = run.run;
    this.deps.log({
      msg: 'job start reads',
      run: `${owner}/${repo}/${runId}`,
      ...run.counts,
    });
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      void this.poll();
      await sleep(1_000, undefined, { signal }).catch(() => undefined);
    }
  }

  // Starts each due run's read, earliest due first, while the limits allow.
  poll(): Promise<void> {
    const now = this.now();
    this.tokens = Math.min(
      AT_ONCE,
      this.tokens + (now - this.filledAt) * PER_MS,
    );
    this.filledAt = now;
    // Jobs whose schedule passed, as during a hold, are left to JobStarted.
    for (const run of this.runs.values()) {
      for (const [id, w] of run.jobs)
        if (!run.reading && slot(w, now - GAP_MS) === undefined)
          run.jobs.delete(id);
      this.end(run);
    }
    if (now < this.heldUntil) return Promise.resolve();
    const due = [...this.runs.values()]
      .filter((run) => !run.reading && run.next <= now)
      .sort((a, b) => a.next - b.next);
    const reads: Promise<void>[] = [];
    for (const run of due) {
      if (this.tokens < 1 || this.reading >= AT_ONCE) break;
      this.tokens -= 1;
      reads.push(this.read(run));
    }
    return Promise.all(reads).then(() => undefined);
  }

  private async read(run: Run): Promise<void> {
    run.reading = true;
    this.reading++;
    run.counts.reads++;
    let listed: RunJobs | undefined;
    try {
      listed = await this.deps.jobs(
        run.run,
        run.etag,
        AbortSignal.timeout(READ_TIMEOUT_MS),
      );
    } catch (error) {
      this.refused(error);
    }
    delete run.reading;
    this.reading--;
    if (listed) this.listed(run, listed);
    // The next read: the earliest of the jobs' next slots, a gap after this.
    const now = this.now();
    for (const [id, w] of run.jobs)
      if (slot(w, now) === undefined) run.jobs.delete(id);
    run.next = Math.max(
      now + GAP_MS,
      Math.min(...[...run.jobs.values()].map((w) => slot(w, now)!)),
    );
    this.end(run);
  }

  private refused(error: unknown) {
    const { status, response } = error as {
      status?: number;
      response?: { headers?: Record<string, unknown> };
    };
    const after = Number(response?.headers?.['retry-after']);
    const remaining = Number(response?.headers?.['x-ratelimit-remaining']);
    if (status === 429 || (status === 403 && (after > 0 || remaining === 0)))
      this.hold(
        after > 0
          ? this.now() + after * 1000
          : this.reset > this.now()
            ? this.reset
            : this.now() + PAUSE_MS,
      );
  }

  private hold(until: number) {
    if (until <= this.heldUntil) return;
    this.heldUntil = until;
    this.deps.log({
      msg: 'job start reads paused',
      seconds: Math.ceil((until - this.now()) / 1000),
    });
  }

  private listed(run: Run, listed: RunJobs) {
    run.etag = listed.etag;
    if (listed.rate) {
      this.reset = listed.rate.reset;
      if (listed.rate.remaining < RESERVE(listed.rate.limit))
        this.hold(listed.rate.reset);
    }
    if (!listed.jobs) {
      run.counts.unchanged++;
      return;
    }
    // Those still watched once the list answered: a JobStarted heard
    // meanwhile has started its job.
    const watched = [...run.jobs.values()];
    for (const w of watched) {
      const name = w.job.jobDisplayName;
      const named = listed.jobs.filter((job) => job.name === name);
      const [job] = named;
      // A name two jobs share can't say which one started, nor a run moved
      // to another attempt which job was assigned; JobStarted can.
      w.attempt ??= job?.attempt;
      if (
        !job ||
        named.length !== 1 ||
        watched.filter((o) => o.job.jobDisplayName === name).length !== 1 ||
        job.attempt !== w.attempt ||
        job.done
      ) {
        run.jobs.delete(w.job.jobId);
        continue;
      }
      if (!job.runnerName || job.startedAt === null) continue;
      run.jobs.delete(w.job.jobId);
      if (
        job.labels.includes(w.route.label) &&
        this.deps.waiting(w.route, job.runnerName)
      ) {
        run.counts.fromList++;
        this.deps.started(
          w.route,
          { ...w.job, messageType: 'JobStarted', runnerName: job.runnerName },
          job.startedAt,
        );
      }
    }
  }
}
