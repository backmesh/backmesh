import { describe, expect, it } from 'vitest';

import type { AttemptJob, RunState } from '../../../src/github/runs.js';
import { MAX_WAITING, Retrier } from '../../../src/listener/retry.js';
import type { Route } from '../../../src/listener/routes.js';
import type { Reclaim } from '../../../src/listener/scaler.js';
import { assigned, failJob, message, ROUTE, setup } from './fakes.js';

const MIN = 60_000;
const RUN = { owner: 'acme', repo: 'app', runId: 7 };
const SPOT: Route = {
  ...ROUTE,
  onDemand: { label: 'backmesh-od-4' },
};
const reclaim = (runner: string, job = 'test'): Reclaim => ({
  job,
  runner,
  label: SPOT.label,
  spot: true,
  vm: 'aws m6a.xlarge us-east-2',
});

// GitHub's view of run 7: its state, and each attempt's jobs.
function fakeRuns() {
  const clock = { now: 0 };
  const state: RunState = {
    status: 'in_progress',
    conclusion: null,
    attempt: 1,
  };
  let jobs: AttemptJob[] = [
    {
      name: 'test',
      conclusion: 'failure',
      runnerName: 'r1',
      labels: ['backmesh-4'],
    },
    { name: 'lint', conclusion: 'success', runnerName: 'r2', labels: [] },
  ];
  const calls: string[] = [];
  let failRerun:
    | { status: number; headers: Record<string, string>; code?: string }
    | undefined;
  const logs: ({ msg: string } & Record<string, unknown>)[] = [];
  const retrier = new Retrier({
    runs: {
      get: async () => {
        calls.push('get');
        return { ...state };
      },
      jobs: async (_run, attempt) => {
        calls.push(`jobs ${attempt}`);
        return jobs;
      },
      rerunFailedJobs: async () => {
        if (failRerun) {
          throw Object.assign(new Error('refused'), {
            status: failRerun.status,
            code: failRerun.code,
            response: { headers: failRerun.headers },
          });
        }
        calls.push('rerun');
        state.attempt++;
        state.status = 'queued';
      },
    },
    ours: (runner) => runner.startsWith('bm'),
    log: (entry) => void logs.push(entry),
    now: () => clock.now,
  });
  const finish = (conclusion = 'failure') => {
    state.status = 'completed';
    state.conclusion = conclusion;
  };
  return {
    retrier,
    state,
    clock,
    calls,
    logs,
    finish,
    setJobs: (next: AttemptJob[]) => (jobs = next),
    failRerun: (
      status?: number,
      headers: Record<string, string> = {},
      code?: string,
    ) => (failRerun = status ? { status, headers, code } : undefined),
  };
}

describe('Retrier', () => {
  // The rerun goes through the Worker (`/v1/rerun`), so the listener's own
  // token needs no Actions write.
  it("decides at detection from the run's attempt and the opt-out", async () => {
    expect(await fakeRuns().retrier.decide(RUN, [reclaim('r1')])).toBe('retry');

    const capped = fakeRuns();
    capped.state.attempt = 3;
    expect(await capped.retrier.decide(RUN, [reclaim('r1')])).toBe(
      'attempt-cap',
    );

    const opted = fakeRuns();
    opted.setJobs([
      {
        name: 'test',
        conclusion: 'failure',
        runnerName: 'r1',
        labels: ['backmesh-4', 'backmesh-noretry'],
      },
    ]);
    expect(await opted.retrier.decide(RUN, [reclaim('r1')])).toBe('noretry');
    expect(opted.retrier.status(0).waiting).toBe(0);

    const { retrier } = fakeRuns();
    expect(await retrier.decide(RUN, [reclaim('r1')])).toBe('retry');
    expect(retrier.status(0).waiting).toBe(1);
  });

  it(`waits for at most ${MAX_WAITING} runs; past them a reclaim is unavailable`, async () => {
    const { retrier } = fakeRuns();
    for (let runId = 1; runId <= MAX_WAITING; runId++) {
      expect(await retrier.decide({ ...RUN, runId }, [reclaim('r1')])).toBe(
        'retry',
      );
    }
    expect(await retrier.decide({ ...RUN, runId: 999 }, [reclaim('r1')])).toBe(
      'unavailable',
    );
    // A run already waiting still takes its later reclaims.
    expect(await retrier.decide({ ...RUN, runId: 1 }, [reclaim('r2')])).toBe(
      'retry',
    );
  });

  it('polls every 2 minutes for an hour, then doubling to 30, with no cap', async () => {
    const { retrier, clock, calls } = fakeRuns();
    await retrier.decide(RUN, [reclaim('r1')]);
    const polls: number[] = [];
    for (let t = 0; t <= 49 * 60 * MIN; t += MIN) {
      clock.now = t;
      const before = calls.length;
      await retrier.poll(t);
      if (calls.length > before) polls.push(t / MIN);
    }
    expect(polls.slice(0, 3)).toEqual([2, 4, 6]);
    const late = polls.filter((t) => t > 60);
    expect(late.slice(0, 5)).toEqual([64, 72, 88, 118, 148]);
    // Still polling two days later.
    expect(polls.at(-1)).toBeGreaterThan(48 * 60);
    expect(retrier.status(clock.now).waiting).toBe(1);
  });

  it.each([
    ['another job failed', 'failure', 1],
    ['run cancelled', 'cancelled', 1],
    ['rerun by hand', 'failure', 2],
  ] as const)(
    'skips a run with no check run: %s',
    async (reason, conclusion, attempt) => {
      const env = fakeRuns();
      await env.retrier.decide(RUN, [reclaim('r1')]);
      if (reason === 'another job failed') {
        env.setJobs([
          { name: 'test', conclusion: 'failure', runnerName: 'r1', labels: [] },
          { name: 'lint', conclusion: 'failure', runnerName: 'r2', labels: [] },
        ]);
      }
      env.finish(conclusion);
      env.state.attempt = attempt;
      expect(await env.retrier.poll(2 * MIN)).toEqual([]);
      expect(env.calls).not.toContain('rerun');
      expect(env.logs).toContainEqual(
        expect.objectContaining({ msg: 'retry skipped', reason }),
      );
      expect(env.retrier.status(0).waiting).toBe(0);
      // A person's rerun of the reclaimed job is routed like backmesh's.
      env.retrier.observe(SPOT, message('JobAssigned'), null);
      expect(env.retrier.onDemand(SPOT, 3 * MIN)).toBe(true);
    },
  );

  it.each(['timed_out', 'startup_failure', 'action_required'])(
    "skips a run where another job's conclusion is %s",
    async (conclusion) => {
      const env = fakeRuns();
      await env.retrier.decide(RUN, [reclaim('r1')]);
      env.setJobs([
        { name: 'test', conclusion: 'failure', runnerName: 'r1', labels: [] },
        { name: 'lint', conclusion, runnerName: 'r2', labels: [] },
        { name: 'e2e', conclusion: 'cancelled', runnerName: 'r3', labels: [] },
      ]);
      env.finish();
      await env.retrier.poll(2 * MIN);
      expect(env.calls).not.toContain('rerun');
      expect(env.logs).toContainEqual(
        expect.objectContaining({ reason: 'another job failed' }),
      );
    },
  );

  it("waits for a failed job's runner end before calling it another failure", async () => {
    const env = fakeRuns();
    await env.retrier.decide(RUN, [reclaim('r1')]);
    const failed = (runnerName: string) => ({
      name: runnerName,
      conclusion: 'failure',
      runnerName,
      labels: [],
    });
    env.setJobs([failed('r1'), failed('bmabc12-a4-00000002')]);
    env.finish();
    await env.retrier.poll(2 * MIN);
    expect(env.retrier.status(0).waiting).toBe(1);
    // The second reclaim is read a cycle later, into the same entry.
    await env.retrier.decide(RUN, [reclaim('bmabc12-a4-00000002', 'lint')]);
    await env.retrier.poll(4 * MIN);
    expect(env.calls).toContain('rerun');

    // A genuine failure on our runner is skipped after the grace.
    const other = fakeRuns();
    await other.retrier.decide(RUN, [reclaim('r1')]);
    other.setJobs([failed('r1'), failed('bmabc12-a4-00000002')]);
    other.finish();
    for (let t = 2; t <= 14; t += 2) await other.retrier.poll(t * MIN);
    expect(other.calls).not.toContain('rerun');
    expect(other.logs).toContainEqual(
      expect.objectContaining({ reason: 'another job failed' }),
    );
  });

  it('drops a run when GitHub refuses the rerun, and retries a server error', async () => {
    const env = fakeRuns();
    await env.retrier.decide(RUN, [reclaim('r1')]);
    env.finish();
    env.failRerun(502);
    await env.retrier.poll(2 * MIN);
    expect(env.retrier.status(0).waiting).toBe(1);
    env.failRerun(403);
    await env.retrier.poll(4 * MIN);
    expect(env.retrier.status(0).waiting).toBe(0);
    expect(env.logs.at(-1)).toMatchObject({ msg: 'rerun refused; dropped' });
  });

  it('keeps a run waiting while the installation lacks Actions write, as an owner accepts it', async () => {
    const env = fakeRuns();
    await env.retrier.decide(RUN, [reclaim('r1')]);
    env.finish();
    env.failRerun(409, {}, 'actions_write_needed');
    await env.retrier.poll(2 * MIN);
    expect(env.retrier.status(0).waiting).toBe(1);
    env.failRerun();
    await env.retrier.poll(4 * MIN);
    expect(env.calls).toContain('rerun');
  });

  it.each<Record<string, string>>([
    { 'retry-after': '60' },
    { 'x-ratelimit-remaining': '0' },
  ])('retries a rerun a secondary rate limit refused (%o)', async (headers) => {
    const env = fakeRuns();
    await env.retrier.decide(RUN, [reclaim('r1')]);
    env.finish();
    env.failRerun(403, headers);
    await env.retrier.poll(2 * MIN);
    expect(env.retrier.status(0).waiting).toBe(1);
    expect(env.logs.at(-1)).toMatchObject({
      msg: 'run read failed; retrying',
    });
    env.failRerun();
    await env.retrier.poll(4 * MIN);
    expect(env.calls).toContain('rerun');
  });

  it('opens the on-demand window from the retry’s assignment to its start', async () => {
    const env = fakeRuns();
    await env.retrier.decide(RUN, [reclaim('r1')]);
    env.finish();
    await env.retrier.poll(2 * MIN);

    // Another job on the scale set opens nothing.
    env.retrier.observe(
      SPOT,
      message('JobAssigned', { jobDisplayName: 'x' }),
      null,
    );
    expect(env.retrier.onDemand(SPOT, 0)).toBe(false);
    env.retrier.observe(SPOT, message('JobAssigned'), null);
    expect(env.retrier.onDemand(SPOT, 0)).toBe(true);
    // Only spot routes with an on-demand label are rerouted, and a window
    // whose start was lost closes after 30 minutes.
    expect(env.retrier.onDemand(ROUTE, 0)).toBe(false);
    await env.retrier.poll(31 * MIN);
    expect(env.retrier.onDemand(SPOT, 31 * MIN)).toBe(false);
    env.retrier.observe(SPOT, message('JobAssigned'), null);

    const row = env.retrier.observe(
      SPOT,
      message('JobStarted', { runnerName: 'od-1' }),
      false,
    );
    expect(row).toMatchObject({
      kind: 'retry started',
      label: 'backmesh-4',
      onDemand: true,
    });
    expect(env.retrier.onDemand(SPOT, 0)).toBe(false);
    expect(env.retrier.retried('job-1')).toBe(true);
    expect(env.retrier.retried('job-1')).toBe(false);
  });

  it("pauses a route's spot capacity for 30 minutes after 2 reclaim events in 15", () => {
    const { retrier } = fakeRuns();
    const pools = new Set(['aws spot']);
    retrier.reclaimed(pools, 0);
    retrier.reclaimed(pools, 16 * MIN);
    expect(retrier.onDemand(SPOT, 16 * MIN)).toBe(false);
    retrier.reclaimed(pools, 30 * MIN);
    expect(retrier.onDemand(SPOT, 30 * MIN)).toBe(true);
    expect(retrier.status(30 * MIN).paused).toEqual([
      { capacity: 'aws spot', until: new Date(60 * MIN).toISOString() },
    ]);
    // The KVM classes' spot is another capacity.
    expect(retrier.onDemand({ ...SPOT, kvm: true }, 30 * MIN)).toBe(false);
    // A reclaim during the pause starts it again.
    retrier.reclaimed(pools, 50 * MIN);
    expect(retrier.onDemand(SPOT, 70 * MIN)).toBe(true);
    expect(retrier.onDemand(SPOT, 80 * MIN)).toBe(false);
  });

  it("counts one VM's reclaim read over two cycles as one event", () => {
    const { retrier } = fakeRuns();
    const pools = new Set(['aws spot']);
    // Its idle Jobs are read in one cycle, its busy ones in the next.
    retrier.reclaimed(pools, 0);
    retrier.reclaimed(pools, 2 * MIN);
    retrier.reclaimed(pools, 4 * MIN);
    expect(retrier.onDemand(SPOT, 4 * MIN)).toBe(false);
    // Reclaims in every cycle still trip it, 5 minutes after the first.
    retrier.reclaimed(pools, 6 * MIN);
    expect(retrier.onDemand(SPOT, 6 * MIN)).toBe(true);
  });
});

describe('Scaler with the retry', () => {
  const OD: Route = {
    ...ROUTE,
    label: 'backmesh-od-4',
    code: 'b4',
    spot: false,
  };

  async function reclaimedRun() {
    const runs = fakeRuns();
    const env = setup(
      [SPOT, OD],
      (run, reclaims) => runs.retrier.decide(run, reclaims),
      runs.retrier,
    );
    const spot = env.sets[0]!;
    const id = await failJob(env, spot, 'reclaimed');
    runs.setJobs([
      { name: 'test', conclusion: 'failure', runnerName: id, labels: [] },
    ]);
    return { ...env, runs, spot };
  }

  it('reruns on demand when anycloud ends a busy runner reclaimed before GitHub reports its job', async () => {
    // At maxRetries 0, anycloud fails the Job `reclaimed` within a reconcile,
    // with no terminate from the listener; GitHub reports the job failed
    // minutes later, once the runner's lost.
    const runs = fakeRuns();
    const env = setup(
      [SPOT, OD],
      (run, reclaims) => runs.retrier.decide(run, reclaims),
      runs.retrier,
    );
    const spot = env.sets[0]!;
    spot.statistics = assigned(1);
    await env.scaler.reconcile();
    const id = env.anycloud.submitted.at(-1)!.id;
    const fields = { runnerName: id, result: 'Failed', jobId: 'job-1' };
    env.scaler.observe(spot, message('JobStarted', fields));
    env.anycloud.end(id, 'reclaimed');
    await env.scaler.reconcile();
    await env.scaler.reconcile();
    expect(env.anycloud.terminated).toEqual([]);
    env.clock.now = 9 * MIN;
    env.scaler.observe(spot, message('JobCompleted', fields));
    spot.statistics = assigned(0);
    runs.setJobs([
      { name: 'test', conclusion: 'failure', runnerName: id, labels: [] },
    ]);
    await env.scaler.reconcile();
    expect(env.logs).toContainEqual(
      expect.objectContaining({
        msg: 'job reclaimed',
        runner: id,
        retry: 'retry',
      }),
    );

    runs.finish();
    env.clock.now = 11 * MIN;
    runs.clock.now = 11 * MIN;
    await env.scaler.reconcile();
    expect(runs.calls).toContain('rerun');
    // The rerun's job, once GitHub assigns it, gets an on-demand runner.
    env.scaler.observe(spot, message('JobAssigned', { jobId: 'job-2' }));
    spot.statistics = assigned(1);
    await env.scaler.reconcile();
    expect(env.anycloud.submitted.at(-1)!.spot).toBe(false);
  });

  it('reruns the run and mints its retry on demand, removing spot runners first', async () => {
    const env = await reclaimedRun();
    // The rerun's note names the on-demand label for jobs that can't wait.
    expect(env.notes.map(({ note }) => note)).toEqual([
      expect.objectContaining({
        title: 'Spot reclaim',
        summary: expect.stringMatching(
          /reruns its failed jobs .* use `backmesh-od-4`\.$/,
        ),
      }),
    ]);
    env.runs.finish();
    env.clock.now = 2 * MIN;
    env.runs.clock.now = 2 * MIN;
    await env.scaler.reconcile();
    expect(env.runs.calls).toContain('rerun');
    expect(env.scaler.status().scaleSets[0]!.jobs?.day).toMatchObject({
      reclaims: 1,
      reruns: 1,
    });

    // A spot runner minted before the retry was assigned.
    env.spot.statistics = assigned(1);
    await env.scaler.reconcile();
    env.scaler.observe(env.spot, message('JobAssigned', { jobId: 'job-2' }));
    env.spot.statistics = assigned(2);
    await env.scaler.reconcile();
    expect(env.anycloud.submitted.map((spec) => spec.spot)).toEqual([
      true,
      true,
      false,
    ]);
    // Scale-down in the window keeps the on-demand runner.
    env.spot.statistics = assigned(1);
    await env.scaler.reconcile();
    const left = [...env.anycloud.live.values()];
    expect(left.map((job) => job.spot)).toEqual([false]);

    const od = left[0]!.id;
    env.scaler.observe(
      env.spot,
      message('JobStarted', { runnerName: od, jobId: 'job-2' }),
    );
    expect(env.logs).toContainEqual(
      expect.objectContaining({
        msg: 'retry started',
        onDemand: true,
      }),
    );
    env.scaler.observe(
      env.spot,
      message('JobCompleted', {
        runnerName: od,
        jobId: 'job-2',
        result: 'Succeeded',
      }),
    );
    await env.scaler.reconcile();
    expect(env.logs).toContainEqual(
      expect.objectContaining({
        msg: 'job completed',
        jobId: 'job-2',
        retry: true,
      }),
    );
    expect(env.scaler.status().scaleSets[0]!.jobs?.day.retries).toEqual({
      onDemand: 1,
      spot: 0,
    });
    expect(env.runs.logs).toContainEqual(
      expect.objectContaining({
        msg: 'run rerun',
        run: 'acme/app/7',
        attempt: 1,
      }),
    );
    expect(env.scaler.status().retry?.waiting).toBe(0);
  });

  it('counts a retry started before the next listing on demand, as it was minted', async () => {
    const env = await reclaimedRun();
    env.runs.finish();
    env.clock.now = 2 * MIN;
    await env.scaler.reconcile();
    env.scaler.observe(env.spot, message('JobAssigned', { jobId: 'job-2' }));
    env.spot.statistics = assigned(1);
    await env.scaler.reconcile();
    const od = env.anycloud.submitted.at(-1)!;
    expect(od.spot).toBe(false);
    env.scaler.observe(
      env.spot,
      message('JobStarted', { runnerName: od.id, jobId: 'job-2' }),
    );
    expect(env.logs).toContainEqual(
      expect.objectContaining({ msg: 'retry started', onDemand: true }),
    );
  });

  it('mints on demand while the breaker pauses the spot capacity', async () => {
    const env = await reclaimedRun();
    // A second reclaim event 5 minutes later trips it.
    env.clock.now = 5 * MIN;
    await failJob(env, env.spot, 'reclaimed', 'job-3');
    expect(env.scaler.status().retry?.paused).toEqual([
      { capacity: 'aws spot', until: new Date(35 * MIN).toISOString() },
    ]);
    env.spot.statistics = assigned(1);
    await env.scaler.reconcile();
    expect(env.anycloud.submitted.at(-1)!.spot).toBe(false);
  });

  it('trips the breaker on spot runners reclaimed before they ran, and drops their registrations', async () => {
    const env = setup(
      [SPOT, OD],
      async () => 'unavailable',
      fakeRuns().retrier,
    );
    // Each one's Job fails reclaimed without ever being listed recovering,
    // and no job started on it: not a startup failure, a spot reclaim.
    const reclaimIdle = async (at: number) => {
      env.clock.now = at;
      env.sets[0]!.statistics = assigned(1);
      await env.scaler.reconcile();
      const id = env.anycloud.submitted.at(-1)!.id;
      env.anycloud.end(id, 'reclaimed');
      env.sets[0]!.statistics = assigned(0);
      await env.scaler.reconcile();
      return id;
    };
    const first = await reclaimIdle(0);
    await reclaimIdle(5 * MIN);
    // Its unused JIT registration goes with it.
    expect(env.github.calls).toContain(`remove ${first}`);
    expect(env.scaler.status().retry?.paused).toEqual([
      { capacity: 'aws spot', until: expect.any(String) },
    ]);
    expect(env.sets[0]!.backoff.failures).toBe(0);
  });

  it("names the on-demand label in a note, and an on-demand loss isn't a spot VM", async () => {
    const od = setup([SPOT, OD], async () => 'unavailable');
    await failJob(od, od.sets[1]!, 'lost');
    expect(od.notes[0]!.note.title).toBe('Rerun needed: a job lost a VM');

    const spot = setup([SPOT, OD], async () => 'unavailable');
    await failJob(spot, spot.sets[0]!, 'reclaimed');
    expect(spot.notes[0]!.note.summary).toMatch(
      / To start on an on-demand runner instead, use `backmesh-od-4`\.$/,
    );
  });
});
