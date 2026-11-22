import { describe, expect, it } from 'vitest';

import type { GateJob } from '../../../src/github/runs.js';
import type { JobMessage } from '../../../src/github/types.js';
import type { WorkflowRun } from '../../../src/github/checks.js';
import { Starts } from '../../../src/listener/starts.js';
import type { Route } from '../../../src/listener/routes.js';
import { message, ROUTE } from './fakes.js';

const RUNNER = 'bmabc12-a4-00000001';
const REF = 'acme/app/.github/workflows/ci.yml@refs/heads/main';

const assignedJob = (fields: Partial<JobMessage> = {}) =>
  message('JobAssigned', {
    jobWorkflowRef: REF,
    jobDisplayName: 'test',
    ...fields,
  });
const rest = (fields: Partial<GateJob> = {}): GateJob => ({
  name: 'test',
  labels: [ROUTE.label],
  runnerName: RUNNER,
  startedAt: 1_000,
  done: false,
  ...fields,
});

function starts(
  list: (run: WorkflowRun) => Promise<GateJob[]> | GateJob[] = () => [],
) {
  let now = 0;
  const reads: WorkflowRun[] = [];
  const started: { route: Route; job: JobMessage; startedAt: number }[] = [];
  const logs: Record<string, unknown>[] = [];
  const waiting = new Set([RUNNER]);
  const watch = new Starts({
    jobs: async (run) => {
      reads.push(run);
      return list(run);
    },
    waiting: (route, runner) => route.code === 'a4' && waiting.has(runner),
    started: (route, job, startedAt) => {
      waiting.delete(job.runnerName);
      started.push({ route, job, startedAt });
    },
    log: (entry) => logs.push(entry),
    now: () => now,
  });
  return {
    watch,
    reads,
    started,
    logs,
    waiting,
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

  it('reads a run once per round for all its jobs, every 2 s, until each starts or 2 minutes pass', async () => {
    let jobs: GateJob[] = [
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
    // `b` is still read, up to 2 minutes after its JobAssigned.
    s.at(120_000);
    await s.watch.poll();
    expect(s.reads).toHaveLength(3);
    s.at(122_001);
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

  it('leaves to JobStarted a name two jobs share, one the list lacks, and another label or listener', async () => {
    const s = starts(() => [
      rest({ name: 'twin' }),
      rest({ name: 'twin', runnerName: 'bmabc12-a4-00000002' }),
      rest({ name: 'pair' }),
      rest({ name: 'other label', labels: ['backmesh-2'] }),
      rest({ name: 'not ours', runnerName: 'bmzzz99-a4-00000001' }),
      rest({ name: 'other set', runnerName: 'bmabc12-a2-00000001' }),
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
    // Each was given up after one read.
    s.at(2_000);
    await s.watch.poll();
    expect(s.reads).toHaveLength(1);
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

  it('reads at most 10 runs at once and 30 a minute', async () => {
    const s = starts(() => [rest({ runnerName: '', startedAt: null })]);
    for (let run = 1; run <= 40; run++)
      s.watch.observe(ROUTE, assignedJob({ workflowRunId: run }));
    await s.watch.poll();
    expect(s.reads).toHaveLength(10);
    // Refilled at one read each 2 s, oldest-due run first.
    s.at(2_000);
    await s.watch.poll();
    expect(s.reads).toHaveLength(11);
    expect(s.reads[10]!.runId).toBe(11);
    s.at(60_000);
    await s.watch.poll();
    expect(s.reads.length).toBeLessThanOrEqual(10 + 30);
  });

  it("pauses every read on GitHub's rate limit, until its retry-after", async () => {
    let fail: unknown = Object.assign(new Error('rate limited'), {
      status: 429,
      response: { headers: { 'retry-after': '30' } },
    });
    const s = starts(({ runId }) => {
      if (fail) throw fail;
      return [rest({ runnerName: `bmabc12-a4-0000000${runId}` })];
    });
    s.waiting.add('bmabc12-a4-00000001').add('bmabc12-a4-00000002');
    s.watch.observe(ROUTE, assignedJob({ workflowRunId: 1 }));
    s.watch.observe(ROUTE, assignedJob({ workflowRunId: 2 }));
    await s.watch.poll();
    expect(s.reads).toHaveLength(2);
    expect(s.logs[0]).toMatchObject({ msg: 'job start reads paused' });
    s.at(29_000);
    await s.watch.poll();
    expect(s.reads).toHaveLength(2);
    fail = undefined;
    s.at(30_000);
    await s.watch.poll();
    expect(s.started).toHaveLength(2);
  });
});
