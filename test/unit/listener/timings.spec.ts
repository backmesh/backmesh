import { describe, expect, it } from 'vitest';

import { jobMessageSchema } from '../../../src/github/types.js';
import type { RunnerTimeline } from '../../../src/listener/runner-jobs.js';
import {
  bootSample,
  DAY_MS,
  gitHubJob,
  JobRows,
  MAX_ROWS,
  ROWS_KEPT_MS,
  segments,
  type JobRow,
  type Start,
} from '../../../src/listener/timings.js';
import { message as scaleSetJob } from './fakes.js';

// A JobCompleted as the queue sends it (actions/scaleset `types.go`
// `JobCompleted` and `JobMessageBase`), with the service's .NET timestamps.
const wire = {
  messageType: 'JobCompleted',
  runnerRequestId: 4321,
  repositoryName: 'web',
  ownerName: 'acme',
  jobId: '8a7c3e52-1f0b-5d6e-9a41-2c7d8e9f0a1b',
  jobWorkflowRef: 'acme/web/.github/workflows/ci.yml@refs/pull/12/merge',
  jobDisplayName: 'test (node 22)',
  workflowRunId: 987654321,
  eventName: 'pull_request',
  requestLabels: ['backmesh-4'],
  queueTime: '2026-11-05T12:00:00.1234567Z',
  scaleSetAssignTime: '2026-11-05T12:00:01.1234567Z',
  runnerAssignTime: '2026-11-05T12:01:49.1234567Z',
  finishTime: '2026-11-05T12:05:31.1234567Z',
  result: 'succeeded',
  runnerId: 42,
  runnerName: 'bmabc12-a4-k2j9x0qz',
};
const message = (fields: Partial<typeof wire> = {}) =>
  jobMessageSchema.parse({ ...wire, ...fields });
const ms = Date.parse;

// The runner Job's timeline, as `RunnerJobs.timeline` reads it: submitted
// after the job's assignment, its VM up and container started 87.5 s later.
const timeline: RunnerTimeline = {
  submittedAt: ms('2026-11-05T12:00:02.500Z'),
  dockerReadyAt: ms('2026-11-05T12:00:50.000Z'),
  pulledAt: ms('2026-11-05T12:01:25.000Z'),
  prepulled: true,
  runningAt: ms('2026-11-05T12:01:30.000Z'),
  region: 'us-east-2',
  refusals: [],
  backedOff: [],
  refusedUntil: null,
};

const completed = (
  fields: Partial<typeof wire> = {},
  runnerJob: RunnerTimeline | null = timeline,
  at = 0,
  start: Start | null = 'reactive',
): JobRow => ({
  kind: 'job completed',
  at,
  ...gitHubJob('backmesh-4', message(fields)),
  result: fields.result ?? wire.result,
  runnerJob,
  start,
});

describe('job rows', () => {
  it("keep ARC's labels, the scale set and GitHub's timestamps", () => {
    expect(gitHubJob('backmesh-4', message())).toEqual({
      label: 'backmesh-4',
      jobId: '8a7c3e52-1f0b-5d6e-9a41-2c7d8e9f0a1b',
      runId: 987654321,
      org: 'acme',
      repo: 'web',
      workflowRef: 'acme/web/.github/workflows/ci.yml@refs/pull/12/merge',
      job: 'test (node 22)',
      event: 'pull_request',
      runner: 'bmabc12-a4-k2j9x0qz',
      queuedAt: ms('2026-11-05T12:00:00.123Z'),
      assignedAt: ms('2026-11-05T12:00:01.123Z'),
      runnerAssignedAt: ms('2026-11-05T12:01:49.123Z'),
      finishedAt: ms('2026-11-05T12:05:31.123Z'),
    });
    // A job canceled before a runner took it.
    expect(
      gitHubJob(
        'backmesh-4',
        message({
          runnerAssignTime: '0001-01-01T00:00:00Z',
          runnerName: undefined,
          jobWorkflowRef: undefined,
        }),
      ),
    ).toMatchObject({
      runner: null,
      workflowRef: null,
      runnerAssignedAt: null,
    });
  });

  it('split queued to started at the assignment, the submit and the VM', () => {
    const row = completed();
    // github, listener, vm, runner.
    expect(row.kind === 'job completed' && segments(row)).toEqual([
      1_000, 1_377, 87_500, 19_123,
    ]);
    // A runner submitted and running before the job was assigned: an
    // earlier count's, waiting for any job.
    const early = completed({}, { ...timeline, submittedAt: 0, runningAt: 1 });
    expect(early.kind === 'job completed' && segments(early)).toEqual([
      1_000, 0, 0, 108_000,
    ]);
    const unread = completed({}, null);
    expect(unread.kind === 'job completed' && segments(unread)).toBeNull();
  });

  it('log every row, and summarize 24 hours and 7 days per label', () => {
    const clock = { now: 0 };
    const logged: object[] = [];
    const rows = new JobRows(
      (entry) => logged.push(entry),
      () => clock.now,
    );
    // An hour apart over 8 days: startups of 1 to 192 s, each run a minute,
    // the VM segment growing with them. Every fourth launched in us-west-2
    // after us-east-2 refused it, the last two thirds of its VM start in:
    // every eighth twice, for quota and then for capacity, the others once,
    // for capacity.
    for (let h = 1; h <= 192; h++) {
      clock.now = h * 3_600_000;
      const assigned = ms(wire.scaleSetAssignTime);
      const at = (d: number) => new Date(assigned + d).toISOString();
      rows.add(
        completed(
          {
            jobId: `job-${h}`,
            runnerAssignTime: at(h * 1000),
            finishTime: at(h * 1000 + 60_000),
          },
          {
            ...timeline,
            submittedAt: assigned,
            runningAt: assigned + h * 900,
            ...(h % 4
              ? {
                  region: 'us-east-2',
                  refusals: [],
                  backedOff: [],
                  refusedUntil: null,
                }
              : {
                  region: 'us-west-2',
                  refusals: [
                    ...(h % 8
                      ? []
                      : [
                          {
                            region: 'us-east-2',
                            diagnosis: 'quota-exhausted-region',
                          },
                        ]),
                    { region: 'us-east-2', diagnosis: 'capacity-exhausted' },
                  ],
                  backedOff: ['us-east-2'],
                  refusedUntil: assigned + h * 600,
                }),
          },
          clock.now,
        ),
      );
    }
    rows.add({
      kind: 'job reclaimed',
      at: clock.now,
      job: 'test',
      runner: 'bmabc12-a4-00000001',
      label: 'backmesh-4',
      spot: true,
      vm: 'aws m6a.xlarge us-east-2',
      repo: 'acme/web',
      runId: 987654321,
      retry: 'unavailable',
    });
    rows.add({
      kind: 'runner failed to start',
      at: clock.now - 2 * DAY_MS,
      label: 'backmesh-4',
      runner: 'bmabc12-a4-00000002',
      end: 'failed: retry attempts exhausted',
      refusals: [{ region: 'us-east-1', diagnosis: 'quota-exhausted-region' }],
    });

    expect(logged).toHaveLength(194);
    expect(logged[0]).toMatchObject({
      msg: 'job completed',
      label: 'backmesh-4',
      event: 'pull_request',
      runnerJob: { submittedAt: expect.any(Number) },
    });
    expect(logged.at(-1)).toMatchObject({ msg: 'runner failed to start' });
    expect(rows.summary('backmesh-4', DAY_MS)).toEqual({
      // Hours 168 to 192.
      jobs: 25,
      startMs: { p50: 181_000, p95: 192_000 },
      runMs: { p50: 60_000, p95: 60_000 },
      // 0.9 of each startup after GitHub's second.
      dominant: { segment: 'vm', share: expect.closeTo(0.895, 3) },
      reclaims: 1,
      startupFailures: 0,
      reruns: 0,
      retries: { onDemand: 0, spot: 0 },
      regions: {
        'us-east-2': { jobs: 18, vmMs: { p50: 161_100, p95: 171_900 } },
        'us-west-2': { jobs: 7, vmMs: { p50: 162_000, p95: 172_800 } },
      },
      // Launches refused, and the 4 runners refused for quota among them:
      // hours 168, 176, 184 and 192.
      refusedIn: { 'us-east-2': 11 },
      refusedFor: { 'quota-exhausted-region': 4, 'capacity-exhausted': 7 },
      quotaRefused: {
        runners: 4,
        regions: ['us-east-2'],
        waitMs: { p50: 105_600, p95: 115_200 },
      },
      since: null,
      startedFor: {
        cue: { jobs: 0, startMs: null },
        predicted: { jobs: 0, startMs: null },
        reactive: { jobs: 25, startMs: { p50: 181_000, p95: 192_000 } },
      },
    });
    // Hours 24 to 192: the rest fell out.
    expect(rows.summary('backmesh-4', ROWS_KEPT_MS)).toMatchObject({
      jobs: 169,
      startMs: { p50: 109_000, p95: 185_000 },
      reclaims: 1,
      startupFailures: 1,
      // A runner that never ran counts its refusals too, and has no wait.
      refusedIn: { 'us-east-2': 65, 'us-east-1': 1 },
      refusedFor: { 'capacity-exhausted': 43, 'quota-exhausted-region': 23 },
      quotaRefused: {
        runners: 23,
        regions: ['us-east-2', 'us-east-1'],
        waitMs: { p50: 62_400, p95: 110_400 },
      },
      since: null,
    });
    expect(rows.summary('backmesh-8', DAY_MS)).toMatchObject({
      jobs: 0,
      startMs: null,
      dominant: null,
    });
  });

  it('split queued to started by what the runner was started for', () => {
    const rows = new JobRows(
      () => undefined,
      () => 0,
    );
    const took = (jobId: string, at: string, start: Start | null) =>
      rows.add(completed({ jobId, runnerAssignTime: at }, null, 0, start));
    took('a', '2026-11-05T12:00:05.1234567Z', 'cue');
    took('b', '2026-11-05T12:00:09.1234567Z', 'cue');
    took('c', '2026-11-05T12:00:30.1234567Z', 'predicted');
    took('d', '2026-11-05T12:01:49.1234567Z', 'reactive');
    // A runner another listener process started counts only in the total.
    took('e', '2026-11-05T12:02:00.1234567Z', null);
    expect(rows.summary('backmesh-4', DAY_MS)).toMatchObject({
      jobs: 5,
      startedFor: {
        cue: { jobs: 2, startMs: { p50: 5_000, p95: 9_000 } },
        predicted: { jobs: 1, startMs: { p50: 30_000, p95: 30_000 } },
        reactive: { jobs: 1, startMs: { p50: 109_000, p95: 109_000 } },
      },
    });
  });

  it('keep a redelivered completion once', () => {
    const logged: object[] = [];
    const rows = new JobRows(
      (entry) => logged.push(entry),
      () => 0,
    );
    rows.add(completed());
    rows.add(completed());
    expect(logged).toHaveLength(1);
    expect(rows.summary('backmesh-4', DAY_MS).jobs).toBe(1);
  });

  it('forget a completion once its row is 7 days old', () => {
    const clock = { now: 0 };
    const logged: object[] = [];
    const rows = new JobRows(
      (entry) => logged.push(entry),
      () => clock.now,
    );
    rows.add(completed());
    clock.now = ROWS_KEPT_MS + 1;
    // Any later row trims the old one, and its job ID with it, so a late
    // redelivery is a new row.
    rows.add(completed({ jobId: 'job-2' }, null, clock.now));
    rows.add(completed({}, null, clock.now));
    rows.add(completed({ jobId: 'job-2' }, null, clock.now));
    expect(logged).toHaveLength(3);
    expect(rows.summary('backmesh-4', DAY_MS).jobs).toBe(2);
  });

  it('say since when, after a restart or the row cap', () => {
    const clock = { now: 5 * DAY_MS };
    const rows = new JobRows(
      () => undefined,
      () => clock.now,
    );
    expect(rows.summary('backmesh-4', ROWS_KEPT_MS).since).toBe(
      new Date(5 * DAY_MS).toISOString(),
    );
    clock.now += DAY_MS + 1;
    expect(rows.summary('backmesh-4', DAY_MS).since).toBeNull();

    for (let i = 0; i <= MAX_ROWS; i++) {
      clock.now += 1;
      rows.add(completed({ jobId: `job-${i}` }, null, clock.now));
    }
    expect(rows.summary('backmesh-4', DAY_MS)).toMatchObject({
      jobs: MAX_ROWS,
      since: new Date(6 * DAY_MS + 2).toISOString(),
    });
  });
});

describe('bootSample', () => {
  const runner = { submittedAt: 1_000, runningAt: 31_000 };
  const job = (queueTime: number | null, runnerAssignTime: number | null) =>
    scaleSetJob('JobCompleted', { queueTime, runnerAssignTime });

  it('takes the start from any runner, the registration only when its job was waiting by the time it ran', () => {
    expect(bootSample(job(0, 39_000), runner)).toEqual({
      startMs: 30_000,
      registerMs: 8_000,
    });
    expect(bootSample(job(31_000, 39_000), runner)).toEqual({
      startMs: 30_000,
      registerMs: 8_000,
    });
    expect(bootSample(job(32_000, 90_000), runner)).toEqual({
      startMs: 30_000,
      registerMs: null,
    });
  });

  it('drops missing marks and impossible orders', () => {
    expect(bootSample(job(0, 39_000), null)).toEqual({
      startMs: null,
      registerMs: null,
    });
    expect(
      bootSample(job(0, 39_000), { submittedAt: 1_000, runningAt: null }),
    ).toEqual({ startMs: null, registerMs: null });
    expect(
      bootSample(job(0, 39_000), { submittedAt: 40_000, runningAt: 31_000 }),
    ).toEqual({ startMs: null, registerMs: 8_000 });
    expect(bootSample(job(0, 20_000), runner)).toEqual({
      startMs: 30_000,
      registerMs: null,
    });
  });
});
