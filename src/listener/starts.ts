// A job's start, from the REST jobs list ahead of its JobStarted: GitHub
// sends JobStarted to the listener a median 12 s after the job starts, in
// bursts, up to 48 s (anycloud-sh's CI, 2026-11-22, 93 jobs; JobCompleted
// came 0.3 s after its end), while the list names the job's runner about
// 2 s after. The cache's token waits for the start, and the job-started hook
// for the token at most 10 s. So each run with a job assigned to this
// listener and not yet started is read every 2 s, one read for all of the
// run's jobs, each job for at most 90 s from its JobAssigned (the same 93
// started 32-67 s after GitHub assigned them, 61 s at p90). A job is
// started from its JobAssigned message, the fields JobStarted carries, with
// the runner the list names.
//
// The cost: each read is conditional on the run's last ETag, and a 304
// doesn't count against the installation's hourly limit. Every read counts
// toward GitHub's secondary limits, so at most 60 a minute, 5 at once. Reads
// wait while the installation's budget holds them (`rate-budget.ts`): a
// pause GitHub asked for, or the hour's reserve reached.
import { setTimeout as sleep } from 'node:timers/promises';

import type { WorkflowRun } from '../github/checks.js';
import type { RateBudget } from '../github/rate-budget.js';
import type { Log } from '../github/retry.js';
import type { RunJobs } from '../github/runs.js';
import type { JobMessage } from '../github/types.js';
import type { Route } from './routes.js';

const EVERY_MS = 2_000;
const WATCH_MS = 90_000;
const PER_MS = 60 / 60_000;
const AT_ONCE = 5;
const READ_TIMEOUT_MS = 10_000;
// A run's failed reads (a 5xx, a network error) wait 4, 8, 16, then 30 s.
const RETRY_MAX_MS = 30_000;
const HOUR = 3_600_000;

export interface StartsDeps {
  jobs(run: WorkflowRun, etag?: string, signal?: AbortSignal): Promise<RunJobs>;
  budget: Pick<RateBudget, 'heldUntil' | 'remaining'>;
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
  run: WorkflowRun;
  jobs: Map<string, Watched>;
  next: number;
  etag?: string;
  failures: number;
}

// The hour's counts, logged as `job start reads`.
const noCounts = () => ({
  reads: 0,
  unchanged: 0,
  failed: 0,
  fromList: 0,
  fromJobStarted: 0,
});

export class Starts {
  private readonly runs = new Map<string, Run>();
  private tokens = AT_ONCE;
  private filledAt: number;
  private heldLogged: number | undefined;
  private polling = false;
  private counts = noCounts();
  private countedAt: number;

  constructor(private readonly deps: StartsDeps) {
    this.filledAt = this.countedAt = this.now();
  }

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  observe(route: Route, job: JobMessage): void {
    const key = `${job.ownerName}/${job.repositoryName}/${job.workflowRunId}`;
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
      let run = this.runs.get(key);
      if (!run) {
        run = {
          run: {
            owner: job.ownerName,
            repo: job.repositoryName,
            runId: job.workflowRunId,
          },
          jobs: new Map(),
          next: this.now(),
          failures: 0,
        };
        this.runs.set(key, run);
      }
      // A redelivery keeps the job's window.
      if (!run.jobs.has(job.jobId))
        run.jobs.set(job.jobId, { route, job, at: this.now() });
    } else if (
      job.messageType === 'JobStarted' ||
      job.messageType === 'JobCompleted'
    ) {
      const run = this.runs.get(key);
      if (run?.jobs.delete(job.jobId) && job.messageType === 'JobStarted')
        this.counts.fromJobStarted++;
      if (run?.jobs.size === 0) this.runs.delete(key);
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.poll();
      await sleep(1_000, undefined, { signal }).catch(() => undefined);
    }
  }

  // One round: each due run, oldest due first, while the budget lasts.
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const now = this.now();
      if (now - this.countedAt >= HOUR) {
        this.deps.log({
          msg: 'job start reads',
          ...this.counts,
          remaining: this.deps.budget.remaining ?? null,
        });
        this.counts = noCounts();
        this.countedAt = now;
      }
      this.tokens = Math.min(
        AT_ONCE,
        this.tokens + (now - this.filledAt) * PER_MS,
      );
      this.filledAt = now;
      const due: Run[] = [];
      for (const [key, run] of this.runs) {
        for (const [id, w] of run.jobs)
          if (now - w.at > WATCH_MS) run.jobs.delete(id);
        if (run.jobs.size === 0) this.runs.delete(key);
        else if (run.next <= now) due.push(run);
      }
      if (due.length === 0) return;
      const held = this.deps.budget.heldUntil();
      if (held !== undefined) {
        if (held !== this.heldLogged)
          this.deps.log({
            msg: 'job start reads paused',
            seconds: Math.ceil((held - now) / 1000),
            remaining: this.deps.budget.remaining ?? null,
          });
        this.heldLogged = held;
        return;
      }
      due.sort((a, b) => a.next - b.next);
      const reads: Promise<void>[] = [];
      for (const run of due) {
        if (this.tokens < 1) break;
        this.tokens -= 1;
        run.next = now + EVERY_MS;
        reads.push(this.read(run));
      }
      await Promise.all(reads);
    } finally {
      this.polling = false;
    }
  }

  private async read(run: Run): Promise<void> {
    let listed: RunJobs;
    this.counts.reads++;
    try {
      listed = await this.deps.jobs(
        run.run,
        run.etag,
        AbortSignal.timeout(READ_TIMEOUT_MS),
      );
      run.failures = 0;
    } catch {
      // A refusal for the rate limit holds the budget; anything else backs
      // this run off.
      this.counts.failed++;
      run.failures++;
      run.next = Math.max(
        run.next,
        this.now() + Math.min(RETRY_MAX_MS, EVERY_MS * 2 ** run.failures),
      );
      return;
    }
    run.etag = listed.etag;
    if (!listed.jobs) {
      this.counts.unchanged++;
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
        job.attempt !== w.attempt
      ) {
        run.jobs.delete(w.job.jobId);
        continue;
      }
      if (job.done) run.jobs.delete(w.job.jobId);
      if (job.done || !job.runnerName || job.startedAt === null) continue;
      run.jobs.delete(w.job.jobId);
      if (
        job.labels.includes(w.route.label) &&
        this.deps.waiting(w.route, job.runnerName)
      ) {
        this.counts.fromList++;
        this.deps.started(
          w.route,
          { ...w.job, messageType: 'JobStarted', runnerName: job.runnerName },
          job.startedAt,
        );
      }
    }
  }
}
