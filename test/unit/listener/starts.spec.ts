import { describe, expect, it } from 'vitest';

import type { GateJob, RunJobs } from '../../../src/github/runs.js';
import type { JobMessage } from '../../../src/github/types.js';
import type { WorkflowRun } from '../../../src/github/checks.js';
import { AFTER_S, Starts } from '../../../src/listener/starts.js';
import type { Route } from '../../../src/listener/routes.js';
import { retryingFetch } from '../../../src/github/retry.js';
import { runJobs } from '../../../src/github/runs.js';
import { fakeGitHub, json, octokitFor } from '../github/fake-github.js';
import { message, ROUTE } from './fakes.js';

const RUNNER = 'bmabc12-a4-00000001';
const REF = 'acme/app/.github/workflows/ci.yml@refs/heads/main';

const assignedJob = (fields: Partial<JobMessage> = {}) =>
  message('JobAssigned', { jobWorkflowRef: REF, ...fields });
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
const queued = (name = 'test') =>
  rest({ name, runnerName: null, startedAt: null });
const RATE = { remaining: 4_000, limit: 5_000, reset: 3_600_000 };

// `list` answers each read: its jobs, with an ETag and a rate, or a whole
// answer, or throws.
function starts(
  list: (run: WorkflowRun, etag?: string) => Listed[] | RunJobs = () => [],
) {
  let now = 0;
  const reads: { at: number; etag?: string }[] = [];
  const started: { route: Route; job: JobMessage; startedAt: number }[] = [];
  const logs: Record<string, unknown>[] = [];
  const waiting = new Set([RUNNER]);
  const watch = new Starts({
    jobs: async (run, etag) => {
      reads.push({ at: now, etag });
      const answer = list(run, etag);
      return Array.isArray(answer)
        ? { etag: `"${reads.length}"`, jobs: answer, rate: RATE }
        : answer;
    },
    waiting: (route, runner) => route.code === 'a4' && waiting.has(runner),
    started: (route, job, startedAt) => {
      waiting.delete(job.runnerName);
      started.push({ route, job, startedAt });
    },
    log: (entry) => logs.push(entry),
    now: () => now,
  });
  // Polls every second through `to`.
  const until = async (to: number) => {
    for (; now <= to; now += 1_000) await watch.poll();
    now = to;
  };
  return { watch, reads, started, logs, waiting, until };
}

describe('Starts', () => {
  it("starts a job from the REST list, with its JobAssigned message's fields and the list's runner", async () => {
    const s = starts(() => [rest()]);
    const job = assignedJob();
    s.watch.observe(ROUTE, job);
    await s.until(2_000);
    expect(s.reads).toEqual([]);
    await s.until(3_000);
    expect(s.started).toEqual([
      {
        route: ROUTE,
        job: { ...job, messageType: 'JobStarted', runnerName: RUNNER },
        startedAt: 1_000,
      },
    ]);
    // Started: the watch ends, logged with its reads.
    await s.until(100_000);
    expect(s.reads).toHaveLength(1);
    expect(s.logs).toEqual([
      {
        msg: 'job start reads',
        run: 'acme/app/7',
        reads: 1,
        unchanged: 0,
        fromList: 1,
      },
    ]);
  });

  it("reads a run's jobs together on the schedule, conditional on the last ETag, and stops after the last slot", async () => {
    const s = starts((_, etag) =>
      etag === '"1"' ? { etag, jobs: undefined, rate: RATE } : [queued('a')],
    );
    s.watch.observe(ROUTE, assignedJob({ jobId: 'a', jobDisplayName: 'a' }));
    // A second job of the run a second later shares the reads.
    await s.until(1_000);
    s.watch.observe(ROUTE, assignedJob({ jobId: 'b', jobDisplayName: 'a2' }));
    await s.until(200_000);
    // b isn't listed: it's left to JobStarted after the first read.
    expect(s.reads.map((r) => r.at / 1000)).toEqual(AFTER_S);
    expect(s.reads.slice(1).every((r) => r.etag === '"1"')).toBe(true);
    expect(s.logs).toMatchObject([{ reads: 10, unchanged: 9, fromList: 0 }]);
  });

  it('starts a job whose runner the list names only on a later read', async () => {
    let listed = [queued()];
    const s = starts(() => listed);
    s.watch.observe(ROUTE, assignedJob());
    await s.until(30_000);
    expect(s.started).toEqual([]);
    listed = [rest({ startedAt: 33_000 })];
    await s.until(38_000);
    expect(s.started).toMatchObject([{ startedAt: 33_000 }]);
    expect(s.reads.map((r) => r.at / 1000)).toEqual([3, 8, 15, 22, 30, 38]);
  });

  it('leaves to JobStarted a job heard started first, a shared name, another attempt, label or runner, or a job missing run fields', async () => {
    const cases: [Partial<JobMessage>, Listed[]][] = [
      [{}, [rest(), rest()]],
      [{}, [rest({ labels: ['other'] })]],
      [{}, [rest({ runnerName: 'bmabc12-b8-00000001' })]],
      [{}, [rest({ runnerName: 'someone-elses' })]],
      [{}, [rest({ done: true })]],
      [{ jobWorkflowRef: '' }, [rest()]],
      [{ eventName: '' }, [rest()]],
    ];
    for (const [fields, listed] of cases) {
      const s = starts(() => listed);
      s.watch.observe(ROUTE, assignedJob(fields));
      await s.until(100_000);
      expect(s.started).toEqual([]);
    }
    // Another attempt than the one first listed.
    let listed = [queued()];
    const s = starts(() => listed);
    s.watch.observe(ROUTE, assignedJob());
    await s.until(3_000);
    listed = [rest({ attempt: '2:def' })];
    await s.until(100_000);
    expect(s.started).toEqual([]);
    expect(s.reads).toHaveLength(2);
    // JobStarted heard first.
    const first = starts(() => [rest()]);
    first.watch.observe(ROUTE, assignedJob());
    first.watch.observe(
      ROUTE,
      message('JobStarted', { jobWorkflowRef: REF, runnerName: RUNNER }),
    );
    await first.until(100_000);
    expect(first.reads).toEqual([]);
    expect(first.logs).toMatchObject([{ reads: 0, fromList: 0 }]);
  });

  it('keeps a redelivered job on its first schedule', async () => {
    const s = starts(() => [queued()]);
    s.watch.observe(ROUTE, assignedJob());
    await s.until(2_000);
    s.watch.observe(ROUTE, assignedJob());
    await s.until(200_000);
    expect(s.reads.map((r) => r.at / 1000)).toEqual(AFTER_S);
  });

  it('reads at most 5 at once, and pauses below the reserve and on a rate-limit refusal', async () => {
    let answer: () => Listed[] | RunJobs = () => [queued()];
    const s = starts(() => answer());
    for (let run = 1; run <= 8; run++)
      s.watch.observe(ROUTE, assignedJob({ workflowRunId: run }));
    await s.until(3_000);
    expect(s.reads).toHaveLength(5);
    // The next second's token reads one more.
    await s.until(4_000);
    expect(s.reads).toHaveLength(6);

    answer = () => ({
      etag: undefined,
      jobs: [queued()],
      rate: { remaining: 1_000, limit: 5_000, reset: 60_000 },
    });
    await s.until(5_000);
    expect(s.logs).toContainEqual({
      msg: 'job start reads paused',
      seconds: 55,
    });
    const held = s.reads.length;
    await s.until(59_000);
    expect(s.reads).toHaveLength(held);

    answer = () => {
      throw Object.assign(new Error('limit'), {
        status: 403,
        response: { headers: { 'retry-after': '30' } },
      });
    };
    await s.until(61_000);
    expect(s.logs.at(-1)).toEqual({
      msg: 'job start reads paused',
      seconds: 30,
    });
    const refused = s.reads.length;
    await s.until(89_000);
    expect(s.reads).toHaveLength(refused);
    await s.until(90_000);
    expect(s.reads.length).toBeGreaterThan(refused);
  });

  it("holds its reads on a 429 through the listener's retrying octokit, and leaves to JobStarted jobs whose schedule passed meanwhile", async () => {
    const { fetch, calls } = fakeGitHub({
      'GET https://api.github.com/repos/acme/app/actions/runs/7/jobs': json(
        429,
        {},
        { 'retry-after': '120' },
      ),
    });
    const octokit = octokitFor(retryingFetch(fetch, { sleep: async () => {} }));
    let now = 0;
    const logs: Record<string, unknown>[] = [];
    const watch = new Starts({
      jobs: runJobs(octokit, fetch),
      waiting: () => true,
      started: () => {},
      log: (entry) => logs.push(entry),
      now: () => now,
    });
    watch.observe(ROUTE, assignedJob());
    for (; now <= 200_000; now += 1_000) await watch.poll();
    expect(calls).toHaveLength(1);
    expect(logs).toEqual([
      { msg: 'job start reads paused', seconds: 120 },
      {
        msg: 'job start reads',
        run: 'acme/app/7',
        reads: 1,
        unchanged: 0,
        fromList: 0,
      },
    ]);
  });
});
