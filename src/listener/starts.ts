// A job's start, from the REST jobs list ahead of its JobStarted: GitHub
// sends JobStarted to the listener a median 12 s after the job starts, in
// bursts, up to 48 s (anycloud-sh's CI, 2026-11-22, 93 jobs; JobCompleted
// came 0.3 s after its end), while the list names the job's runner about
// 2 s after. The cache's token waits for the start, and the job-started hook
// for the token at most 10 s. So each run with a job assigned to this
// listener and not yet started is read every 2 s, for each job at most
// 2 minutes from its JobAssigned (a cold runner starts about 35-55 s after),
// one read for all of the run's jobs, within one budget for the listener.
// A job is started from its JobAssigned message, the fields JobStarted
// carries, with the runner the list names.
import { setTimeout as sleep } from 'node:timers/promises';

import type { WorkflowRun } from '../github/checks.js';
import type { Log } from '../github/retry.js';
import type { GateJob } from '../github/runs.js';
import type { JobMessage } from '../github/types.js';
import type { Route } from './routes.js';

const EVERY_MS = 2_000;
const WATCH_MS = 120_000;
// 30 reads a minute, 10 at once: at most 1,800 an hour of the installation's
// 5,000, which the listener's other reads share.
const PER_MS = 30 / 60_000;
const BURST = 10;
// A 403 or 429 without a retry-after or a reset.
const PAUSE_MS = 60_000;

export interface StartsDeps {
  // The run's latest attempt's jobs.
  jobs(run: WorkflowRun): Promise<GateJob[]>;
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
}

interface Run {
  run: WorkflowRun;
  jobs: Map<string, Watched>;
  next: number;
}

export class Starts {
  private readonly runs = new Map<string, Run>();
  private tokens = BURST;
  private filledAt: number;
  private pausedUntil = -Infinity;
  private polling = false;

  constructor(private readonly deps: StartsDeps) {
    this.filledAt = this.now();
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
        };
        this.runs.set(key, run);
      }
      run.jobs.set(job.jobId, { route, job, at: this.now() });
    } else if (
      job.messageType === 'JobStarted' ||
      job.messageType === 'JobCompleted'
    ) {
      const run = this.runs.get(key);
      run?.jobs.delete(job.jobId);
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
      this.tokens = Math.min(
        BURST,
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
      due.sort((a, b) => a.next - b.next);
      const reads: Promise<void>[] = [];
      for (const run of due) {
        if (now < this.pausedUntil || this.tokens < 1) break;
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
    let jobs: GateJob[];
    try {
      jobs = await this.deps.jobs(run.run);
    } catch (error) {
      const until = pauseUntil(error, this.now());
      if (until !== undefined && until > this.pausedUntil) {
        this.pausedUntil = until;
        this.deps.log({
          msg: 'job start reads paused',
          seconds: Math.ceil((until - this.now()) / 1000),
          error: String(error),
        });
      }
      return;
    }
    const watched = [...run.jobs.values()];
    for (const w of watched) {
      const name = w.job.jobDisplayName;
      const listed = jobs.filter((job) => job.name === name);
      // A name two jobs share can't say which one started; JobStarted can.
      if (
        listed.length !== 1 ||
        watched.filter((o) => o.job.jobDisplayName === name).length !== 1
      ) {
        run.jobs.delete(w.job.jobId);
        continue;
      }
      const [job] = listed as [GateJob];
      if (job.done) run.jobs.delete(w.job.jobId);
      if (job.done || !job.runnerName || job.startedAt === null) continue;
      run.jobs.delete(w.job.jobId);
      if (
        job.labels.includes(w.route.label) &&
        this.deps.waiting(w.route, job.runnerName)
      )
        this.deps.started(
          w.route,
          { ...w.job, messageType: 'JobStarted', runnerName: job.runnerName },
          job.startedAt,
        );
    }
  }
}

// When a refused read's 403 or 429 lets reads start again.
function pauseUntil(error: unknown, now: number): number | undefined {
  const { status, response } = error as {
    status?: number;
    response?: { headers?: Record<string, string | undefined> };
  };
  if (status !== 403 && status !== 429) return undefined;
  const after = Number(response?.headers?.['retry-after']);
  if (after > 0) return now + after * 1000;
  const reset = Number(response?.headers?.['x-ratelimit-reset']) * 1000;
  return reset > now ? reset : now + PAUSE_MS;
}
