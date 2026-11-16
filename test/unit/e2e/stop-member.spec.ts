import { describe, expect, it } from 'vitest';

import {
  runStopMember,
  type JobStatus,
  type RunnerJobDiagnosis,
  type StopMemberDeps,
} from '../../../test/e2e/stop-member.ts';

const noSleep = async () => undefined;

// Builds deps whose getJob progresses through a scripted sequence of
// statuses on each call, as the lost-runner-check.yml job would while the
// stop member polls it; the sequence's last entry repeats for any extra
// call, such as the cancel-on-error check's own read after everything else
// has already happened.
function fakeDeps(
  overrides: Partial<StopMemberDeps> & {
    jobStatuses?: JobStatus[];
    diagnoses?: RunnerJobDiagnosis[];
    cancelled?: number[];
  },
): StopMemberDeps {
  const jobStatuses = overrides.jobStatuses ?? [];
  const diagnoses = overrides.diagnoses ?? [
    { cleanedAt: '2026-11-10T12:00:30Z', cleanupError: null },
  ];
  const cancelled = overrides.cancelled ?? [];
  let jobCall = 0;
  let diagnosisCall = 0;
  return {
    dispatchLostRunnerCheck:
      overrides.dispatchLostRunnerCheck ?? (async () => 1),
    getJob:
      overrides.getJob ??
      (async () => {
        const status = jobStatuses[Math.min(jobCall, jobStatuses.length - 1)];
        jobCall++;
        if (!status) throw new Error('no scripted job status left');
        return status;
      }),
    cancelRun:
      overrides.cancelRun ??
      (async (runId) => {
        cancelled.push(runId);
      }),
    terminateRunner:
      overrides.terminateRunner ?? (async () => '2026-11-10T12:00:00Z'),
    diagnoseRunner:
      overrides.diagnoseRunner ??
      (async () => {
        const d = diagnoses[Math.min(diagnosisCall, diagnoses.length - 1)];
        diagnosisCall++;
        if (!d) throw new Error('no scripted diagnosis left');
        return d;
      }),
    sleep: overrides.sleep ?? noSleep,
  };
}

const running = (runnerName: string | null): JobStatus => ({
  status: 'in_progress',
  conclusion: null,
  runnerName,
  completedAt: null,
});

const failed = (completedAt: string): JobStatus => ({
  status: 'completed',
  conclusion: 'failure',
  runnerName: 'bmabcde-01-abcdefgh',
  completedAt,
});

describe('runStopMember', () => {
  it('passes end to end on the happy path', async () => {
    const deps = fakeDeps({
      jobStatuses: [
        running(null),
        running('bmabcde-01-abcdefgh'),
        failed('2026-11-10T12:00:05Z'),
      ],
    });
    const result = await runStopMember(deps, 'backmesh-4');
    expect(result).toEqual({
      runnerId: 'bmabcde-01-abcdefgh',
      terminatedAt: '2026-11-10T12:00:00Z',
      failedAt: '2026-11-10T12:00:05Z',
      secondsToFail: 5,
    });
  });

  it('keeps polling on an empty (or whitespace) runner_name instead of terminating it', async () => {
    let terminated: string | undefined;
    const deps = fakeDeps({
      jobStatuses: [
        running(''),
        running('  '),
        running(null),
        running('bmabcde-01-abcdefgh'),
        failed('2026-11-10T12:00:03Z'),
      ],
      terminateRunner: async (runnerId) => {
        terminated = runnerId;
        return '2026-11-10T12:00:00Z';
      },
    });
    await runStopMember(deps, 'backmesh-4');
    // Run 42775988257: GitHub reports `runner_name: ""` before a runner
    // registers, not null; terminating that empty id dispatched
    // ci-install.yml's stop-runner with a blank runner, which it refused.
    expect(terminated).toBe('bmabcde-01-abcdefgh');
  });

  it('polls until the runner registers before terminating', async () => {
    let terminated: string | undefined;
    const deps = fakeDeps({
      jobStatuses: [
        running(null),
        running(null),
        running('bmabcde-01-abcdefgh'),
        failed('2026-11-10T12:00:03Z'),
      ],
      terminateRunner: async (runnerId) => {
        terminated = runnerId;
        return '2026-11-10T12:00:00Z';
      },
    });
    await runStopMember(deps, 'backmesh-4');
    expect(terminated).toBe('bmabcde-01-abcdefgh');
  });

  it('throws when the job ends before ever getting a runner', async () => {
    const deps = fakeDeps({
      jobStatuses: [
        {
          status: 'completed',
          conclusion: 'cancelled',
          runnerName: null,
          completedAt: '2026-11-10T12:00:00Z',
        },
      ],
    });
    await expect(runStopMember(deps, 'backmesh-4')).rejects.toThrow(
      'ended (cancelled) before it ever had a runner',
    );
  });

  it("throws when GitHub doesn't mark the job failed", async () => {
    const deps = fakeDeps({
      jobStatuses: [
        running('bmabcde-01-abcdefgh'),
        {
          status: 'completed',
          conclusion: 'cancelled',
          runnerName: 'bmabcde-01-abcdefgh',
          completedAt: '2026-11-10T12:00:05Z',
        },
      ],
    });
    await expect(runStopMember(deps, 'backmesh-4')).rejects.toThrow(
      'ended cancelled, not failure',
    );
  });

  it('throws when the job takes more than 15 s to fail', async () => {
    const deps = fakeDeps({
      jobStatuses: [
        running('bmabcde-01-abcdefgh'),
        failed('2026-11-10T12:00:16Z'),
      ],
    });
    await expect(runStopMember(deps, 'backmesh-4')).rejects.toThrow(
      'not within 15 s',
    );
  });

  it('throws on a negative delta (a clock or ordering problem)', async () => {
    const deps = fakeDeps({
      jobStatuses: [
        running('bmabcde-01-abcdefgh'),
        failed('2026-11-10T11:59:59Z'),
      ],
    });
    await expect(runStopMember(deps, 'backmesh-4')).rejects.toThrow(
      'not within 15 s',
    );
  });

  it('calls diagnoseRunner exactly once, already retried by the deps', async () => {
    let diagnoseCalls = 0;
    const deps = fakeDeps({
      jobStatuses: [
        running('bmabcde-01-abcdefgh'),
        failed('2026-11-10T12:00:05Z'),
      ],
      diagnoseRunner: async () => {
        diagnoseCalls++;
        return { cleanedAt: '2026-11-10T12:01:00Z', cleanupError: null };
      },
    });
    const result = await runStopMember(deps, 'backmesh-4');
    expect(diagnoseCalls).toBe(1);
    expect(result.runnerId).toBe('bmabcde-01-abcdefgh');
  });

  it('throws when the runner Job was never confirmed cleaned up', async () => {
    const deps = fakeDeps({
      jobStatuses: [
        running('bmabcde-01-abcdefgh'),
        failed('2026-11-10T12:00:05Z'),
      ],
      diagnoses: [{ cleanedAt: null, cleanupError: null }],
    });
    await expect(runStopMember(deps, 'backmesh-4')).rejects.toThrow(
      "wasn't cleaned up",
    );
  });

  it('throws when the runner Job cleans up with an error', async () => {
    const deps = fakeDeps({
      jobStatuses: [
        running('bmabcde-01-abcdefgh'),
        failed('2026-11-10T12:00:05Z'),
      ],
      diagnoses: [
        {
          cleanedAt: '2026-11-10T12:00:30Z',
          cleanupError: 'some cleanup error',
        },
      ],
    });
    await expect(runStopMember(deps, 'backmesh-4')).rejects.toThrow(
      'cleaned up with an error: some cleanup error',
    );
  });

  it("cancels the lost-runner-check run if it's still live when something else throws", async () => {
    const cancelled: number[] = [];
    const deps = fakeDeps({
      dispatchLostRunnerCheck: async () => 4242,
      // The job never completes in this scenario: terminateRunner throws
      // before GitHub ever marks it failed.
      jobStatuses: [running('bmabcde-01-abcdefgh')],
      terminateRunner: async () => {
        throw new Error('ci-install.yml already has a run in flight');
      },
      cancelled,
    });
    await expect(runStopMember(deps, 'backmesh-4')).rejects.toThrow(
      'ci-install.yml already has a run in flight',
    );
    expect(cancelled).toEqual([4242]);
  });

  it('cancels unconditionally, even when the job already completed before the throw', async () => {
    const cancelled: number[] = [];
    const deps = fakeDeps({
      dispatchLostRunnerCheck: async () => 4242,
      jobStatuses: [
        running('bmabcde-01-abcdefgh'),
        failed('2026-11-10T12:00:16Z'), // 16 s: over the 15 s budget
      ],
      cancelled,
    });
    await expect(runStopMember(deps, 'backmesh-4')).rejects.toThrow(
      'not within 15 s',
    );
    // Cancelling an already-completed run is just a no-op error on GitHub's
    // side, swallowed like any other cancelRun failure; the point is this
    // never skips calling it.
    expect(cancelled).toEqual([4242]);
  });

  it('cancels even when getJob itself throws, instead of skipping the cancel to read it first', async () => {
    const cancelled: number[] = [];
    const deps = fakeDeps({
      dispatchLostRunnerCheck: async () => 4242,
      getJob: async () => {
        throw new Error('transient GitHub API error');
      },
      cancelled,
    });
    await expect(runStopMember(deps, 'backmesh-4')).rejects.toThrow(
      'transient GitHub API error',
    );
    expect(cancelled).toEqual([4242]);
  });

  it('swallows a cancelRun failure so the original error still surfaces', async () => {
    const deps = fakeDeps({
      jobStatuses: [running('bmabcde-01-abcdefgh')],
      terminateRunner: async () => {
        throw new Error('the original failure');
      },
      cancelRun: async () => {
        throw new Error('cancel also failed');
      },
    });
    await expect(runStopMember(deps, 'backmesh-4')).rejects.toThrow(
      'the original failure',
    );
  });
});
