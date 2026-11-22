import { describe, expect, it } from 'vitest';

import { RateBudget, watchRate } from '../../../src/github/rate-budget.js';
import {
  gateGitHub,
  runJobs,
  type GateJob,
  type RunJobs,
} from '../../../src/github/runs.js';
import type { JobMessage } from '../../../src/github/types.js';
import type { WorkflowRun } from '../../../src/github/checks.js';
import { Starts, type StartsDeps } from '../../../src/listener/starts.js';
import type { Route } from '../../../src/listener/routes.js';
import { fakeGitHub, json, octokitFor } from '../github/fake-github.js';
import { message, ROUTE } from './fakes.js';

const RUNNER = 'bmabc12-a4-00000001';
const REF = 'acme/app/.github/workflows/ci.yml@refs/heads/main';

const assignedJob = (fields: Partial<JobMessage> = {}) =>
  message('JobAssigned', {
    jobWorkflowRef: REF,
    jobDisplayName: 'test',
    ...fields,
  });
type Listed = GateJob & { attempt: string };
const rest = (fields: Partial<Listed> = {}): Listed => ({
  name: 'test',
  labels: [ROUTE.label],
  runnerName: RUNNER,
  startedAt: 1_000,
  done: false,
  attempt: '1:abc',
  ...fields,
});

// `list` answers each read: its jobs with an ETag, or a whole answer.
function starts(
  list: (
    run: WorkflowRun,
    etag?: string,
  ) => Promise<Listed[] | RunJobs> | Listed[] | RunJobs = () => [],
  deps: Partial<StartsDeps> = {},
) {
  let now = 0;
  const reads: WorkflowRun[] = [];
  const etags: (string | undefined)[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const started: { route: Route; job: JobMessage; startedAt: number }[] = [];
  const logs: Record<string, unknown>[] = [];
  const waiting = new Set([RUNNER]);
  const budget = {
    held: undefined as number | undefined,
    remaining: 5_000 as number | undefined,
    heldUntil() {
      return this.held;
    },
  };
  const watch = new Starts({
    jobs: async (run, etag, signal) => {
      reads.push(run);
      etags.push(etag);
      signals.push(signal);
      const answer = await list(run, etag);
      return Array.isArray(answer)
        ? { etag: `"${reads.length}"`, jobs: answer }
        : answer;
    },
    budget,
    waiting: (route, runner) => route.code === 'a4' && waiting.has(runner),
    started: (route, job, startedAt) => {
      waiting.delete(job.runnerName);
      started.push({ route, job, startedAt });
    },
    log: (entry) => logs.push(entry),
    now: () => now,
    ...deps,
  });
  return {
    watch,
    reads,
    etags,
    signals,
    started,
    logs,
    waiting,
    budget,
    at: (t: number) => (now = t),
  };
}

describe('Starts', () => {
  it("starts a job from the REST list before its JobStarted, with its JobAssigned message's fields", async () => {
    const s = starts(() => [rest()]);
    const job = assignedJob();
    s.watch.observe(ROUTE, job);
    await s.watch.poll();
    expect(s.reads).toEqual([{ owner: 'acme', repo: 'app', runId: 7 }]);
    // Each read has its own deadline, so a hung socket stops no other.
    expect(s.signals[0]).toBeInstanceOf(AbortSignal);
    expect(s.started).toEqual([
      {
        route: ROUTE,
        job: { ...job, messageType: 'JobStarted', runnerName: RUNNER },
        startedAt: 1_000,
      },
    ]);
    // Started: nothing more is read for it.
    s.at(10_000);
    await s.watch.poll();
    expect(s.reads).toHaveLength(1);
  });

  it('reads a run once per round for all its jobs, every 2 s, until each starts or 90 s pass', async () => {
    let jobs: Listed[] = [
      rest({ name: 'a', runnerName: '', startedAt: null }),
      rest({ name: 'b', runnerName: '', startedAt: null }),
    ];
    const s = starts(() => jobs);
    s.watch.observe(ROUTE, assignedJob({ jobId: 'a', jobDisplayName: 'a' }));
    s.watch.observe(ROUTE, assignedJob({ jobId: 'b', jobDisplayName: 'b' }));
    await s.watch.poll();
    expect(s.reads).toHaveLength(1);
    s.at(1_000);
    await s.watch.poll();
    expect(s.reads).toHaveLength(1);
    s.at(2_000);
    jobs = [rest({ name: 'a' }), jobs[1]!];
    await s.watch.poll();
    expect(s.reads).toHaveLength(2);
    expect(s.started.map((x) => x.job.jobId)).toEqual(['a']);
    // A redelivered JobAssigned keeps `b`'s window: 90 s from the first.
    s.at(30_000);
    s.watch.observe(ROUTE, assignedJob({ jobId: 'b', jobDisplayName: 'b' }));
    s.at(90_000);
    await s.watch.poll();
    expect(s.reads).toHaveLength(3);
    s.at(92_001);
    await s.watch.poll();
    expect(s.reads).toHaveLength(3);
  });

  it('stops reading a job at its JobStarted or JobCompleted', async () => {
    const s = starts(() => [rest({ runnerName: '', startedAt: null })]);
    s.watch.observe(ROUTE, assignedJob({ jobId: 'a' }));
    s.watch.observe(ROUTE, assignedJob({ jobId: 'b', jobDisplayName: 'b' }));
    s.watch.observe(
      ROUTE,
      message('JobStarted', { jobId: 'a', runnerName: RUNNER }),
    );
    s.watch.observe(ROUTE, message('JobCompleted', { jobId: 'b' }));
    await s.watch.poll();
    expect(s.reads).toEqual([]);
  });

  it('starts nothing from a read that answers after the JobStarted', async () => {
    let answer!: (jobs: Listed[]) => void;
    const s = starts(() => new Promise<Listed[]>((r) => (answer = r)));
    s.watch.observe(ROUTE, assignedJob());
    const polled = s.watch.poll();
    await new Promise((r) => setImmediate(r));
    s.watch.observe(
      ROUTE,
      message('JobStarted', { jobId: 'job-1', runnerName: RUNNER }),
    );
    answer([rest()]);
    await polled;
    expect(s.started).toEqual([]);
  });

  it('leaves to JobStarted a name two jobs share, one the list lacks, another label or listener, and another attempt', async () => {
    let attempt = '1:abc';
    const s = starts(() => [
      rest({ name: 'twin' }),
      rest({ name: 'twin', runnerName: 'bmabc12-a4-00000002' }),
      rest({ name: 'pair' }),
      rest({ name: 'other label', labels: ['backmesh-2'] }),
      rest({ name: 'not ours', runnerName: 'bmzzz99-a4-00000001' }),
      rest({ name: 'other set', runnerName: 'bmabc12-a2-00000001' }),
      rest({ name: 'rerun', runnerName: '', startedAt: null, attempt }),
    ]);
    s.waiting.add('bmabc12-a4-00000002');
    for (const name of [
      'twin',
      'pair',
      'pair',
      'missing',
      'other label',
      'not ours',
      'other set',
      'rerun',
    ])
      s.watch.observe(
        ROUTE,
        assignedJob({
          jobId: `${name}-${Math.random()}`,
          jobDisplayName: name,
        }),
      );
    await s.watch.poll();
    expect(s.started).toEqual([]);
    expect(s.reads).toHaveLength(1);
    // Only `rerun` is still watched; the run moves to attempt 2.
    attempt = '2:abc';
    s.at(2_000);
    await s.watch.poll();
    expect(s.reads).toHaveLength(2);
    s.at(4_000);
    await s.watch.poll();
    expect(s.reads).toHaveLength(2);
    expect(s.started).toEqual([]);
  });

  it('never watches a job whose run or ref is missing', async () => {
    const s = starts(() => [rest()]);
    for (const fields of [
      { jobWorkflowRef: '' },
      { eventName: '' },
      { workflowRunId: 0 },
      { repositoryName: '' },
      { jobId: '' },
    ])
      s.watch.observe(ROUTE, assignedJob(fields));
    await s.watch.poll();
    expect(s.reads).toEqual([]);
  });

  it('reads at most 5 runs at once and 60 a minute', async () => {
    const s = starts(() => [rest({ runnerName: '', startedAt: null })]);
    for (let run = 1; run <= 40; run++)
      s.watch.observe(ROUTE, assignedJob({ workflowRunId: run }));
    await s.watch.poll();
    expect(s.reads).toHaveLength(5);
    // Refilled at one read a second, oldest-due run first.
    s.at(1_000);
    await s.watch.poll();
    expect(s.reads).toHaveLength(6);
    expect(s.reads[5]!.runId).toBe(6);
    for (let t = 2_000; t <= 60_000; t += 1_000) {
      s.at(t);
      await s.watch.poll();
    }
    expect(s.reads).toHaveLength(5 + 60);
  });

  it('reads each run conditionally on its last ETag, and a 304 starts nothing', async () => {
    let answer: Listed[] | RunJobs = [
      rest({ runnerName: '', startedAt: null }),
    ];
    const s = starts(() => answer);
    s.watch.observe(ROUTE, assignedJob());
    await s.watch.poll();
    answer = { etag: '"1"', jobs: undefined };
    s.at(2_000);
    await s.watch.poll();
    expect(s.started).toEqual([]);
    answer = [rest()];
    s.at(4_000);
    await s.watch.poll();
    expect(s.etags).toEqual([undefined, '"1"', '"1"']);
    expect(s.started).toHaveLength(1);
    // The hour's counts.
    s.watch.observe(ROUTE, assignedJob({ jobId: 'late' }));
    s.watch.observe(
      ROUTE,
      message('JobStarted', { jobId: 'late', runnerName: RUNNER }),
    );
    s.at(3_600_000);
    await s.watch.poll();
    expect(s.logs).toEqual([
      {
        msg: 'job start reads',
        reads: 3,
        unchanged: 1,
        failed: 0,
        fromList: 1,
        fromJobStarted: 1,
        remaining: 5_000,
      },
    ]);
  });

  it('backs a run off after a failed read, and no other, then reads it again', async () => {
    let fail = true;
    const s = starts(({ runId }) => {
      if (fail && runId === 1) throw new Error('fetch failed');
      return [rest({ runnerName: '', startedAt: null })];
    });
    s.watch.observe(ROUTE, assignedJob({ workflowRunId: 1 }));
    s.watch.observe(ROUTE, assignedJob({ workflowRunId: 2 }));
    await s.watch.poll();
    // 4 s for run 1 after its first failure; 2 s for run 2.
    s.at(2_000);
    await s.watch.poll();
    expect(s.reads.map((r) => r.runId)).toEqual([1, 2, 2]);
    s.at(4_000);
    await s.watch.poll();
    expect(s.reads.map((r) => r.runId)).toEqual([1, 2, 2, 1, 2]);
    // Its second failure: 8 s. Then it answers, and 2 s again.
    fail = false;
    s.at(12_000);
    await s.watch.poll();
    s.at(14_000);
    await s.watch.poll();
    expect(s.reads.filter((r) => r.runId === 1)).toHaveLength(4);
    expect(s.logs).toEqual([]);
  });

  it('reads nothing while the budget holds reads, and says so once', async () => {
    const s = starts(() => [rest()]);
    s.budget.held = 30_000;
    s.budget.remaining = 1_499;
    s.watch.observe(ROUTE, assignedJob());
    await s.watch.poll();
    s.at(1_000);
    await s.watch.poll();
    expect(s.reads).toEqual([]);
    expect(s.logs).toEqual([
      { msg: 'job start reads paused', seconds: 30, remaining: 1_499 },
    ]);
    s.budget.held = undefined;
    s.at(30_000);
    await s.watch.poll();
    expect(s.started).toHaveLength(1);
  });

  it("is held by another read's response below the installation's reserve", async () => {
    const RUNS = 'https://api.github.com/repos/acme/app/actions/runs/7';
    const { fetch, calls } = fakeGitHub({
      [`GET ${RUNS}/jobs`]: json(200, { total_count: 0, jobs: [] }),
      // The gate's read of the run: 1,499 of 5,000 left until a minute on.
      [`GET ${RUNS}`]: json(
        200,
        {
          repository: { private: true, full_name: 'acme/app' },
          head_repository: { full_name: 'acme/app' },
        },
        {
          'x-ratelimit-remaining': '1499',
          'x-ratelimit-limit': '5000',
          'x-ratelimit-reset': '60',
          'x-ratelimit-resource': 'core',
        },
      ),
    });
    const octokit = octokitFor(fetch);
    let now = 0;
    const budget = new RateBudget(() => now);
    watchRate(octokit, budget);
    const s = starts(undefined, {
      jobs: runJobs(octokit),
      budget,
      now: () => now,
    });
    await gateGitHub(octokit).run({ owner: 'acme', repo: 'app', runId: 7 });
    s.watch.observe(ROUTE, assignedJob());
    await s.watch.poll();
    expect(calls).toHaveLength(1);
    // Past the reset, reads go on.
    now = 60_000;
    await s.watch.poll();
    expect(calls).toHaveLength(2);
  });
});
