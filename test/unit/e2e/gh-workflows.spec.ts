import { describe, expect, it } from 'vitest';

import {
  anyRunActive,
  ciInstallRunsArgs,
  diagnoseWithRetry,
  dispatchAndFind,
  jobLogsArgs,
  parseDiagnosis,
  parseTerminatedAt,
  type WorkflowRun,
} from '../../../test/e2e/gh-workflows.ts';

const noSleep = async () => undefined;

describe('ciInstallRunsArgs', () => {
  it('reads with an explicit GET and no -f/-F field flags', () => {
    const args = ciInstallRunsArgs('backmesh/backmesh');
    // gh api switches to POST the moment any -f/-F is present; asserting
    // none are here is what keeps this a read (round 2's finding A: a -f
    // per_page flag made this call a POST, which 404s/422s against this
    // endpoint).
    expect(args).not.toContain('-f');
    expect(args).not.toContain('-F');
    expect(args.slice(0, 3)).toEqual(['api', '-X', 'GET']);
    expect(args[3]).toBe(
      'repos/backmesh/backmesh/actions/workflows/ci-install.yml/runs?per_page=20',
    );
  });
});

describe('anyRunActive', () => {
  it('is false when every run has completed', () => {
    expect(
      anyRunActive([{ status: 'completed' }, { status: 'completed' }]),
    ).toBe(false);
  });

  it('is false for an empty listing', () => {
    expect(anyRunActive([])).toBe(false);
  });

  it.each(['queued', 'in_progress', 'waiting', 'requested', 'pending'])(
    'is true when a run is %s',
    (status) => {
      expect(anyRunActive([{ status: 'completed' }, { status }])).toBe(true);
    },
  );
});

describe('jobLogsArgs', () => {
  it('asks for raw logs with --allow-escape-sequences', () => {
    // Run 42775988257: without this flag, `gh api .../logs` refused to print
    // a log that (as Actions logs always do) carries escape sequences,
    // crashing `jobLog()` with an opaque "Command failed" instead of a clear
    // failure message.
    const args = jobLogsArgs('backmesh/backmesh', 129694673631);
    expect(args).toEqual([
      'api',
      'repos/backmesh/backmesh/actions/jobs/129694673631/logs',
      '--allow-escape-sequences',
    ]);
  });
});

describe('dispatchAndFind', () => {
  it('returns the run id that appeared after dispatching', async () => {
    const existing: WorkflowRun[] = [
      { id: 1, createdAt: '2026-11-10T00:00:00Z' },
    ];
    let dispatched = false;
    const dispatch = async () => {
      dispatched = true;
    };
    const listRuns = async (): Promise<WorkflowRun[]> =>
      dispatched
        ? [...existing, { id: 2, createdAt: '2026-11-10T00:00:05Z' }]
        : existing;

    const runId = await dispatchAndFind(
      dispatch,
      listRuns,
      noSleep,
      'lost-runner-check.yml',
      { label: 'backmesh-4', step: 'docker' },
    );
    expect(runId).toBe(2);
  });

  it('passes the workflow and inputs through to dispatch', async () => {
    let seen: { workflow: string; inputs: Record<string, string> } | undefined;
    let dispatched = false;
    const dispatch = async (
      workflow: string,
      inputs: Record<string, string>,
    ) => {
      seen = { workflow, inputs };
      dispatched = true;
    };
    const listRuns = async (): Promise<WorkflowRun[]> =>
      dispatched ? [{ id: 9, createdAt: '2026-11-10T00:00:00Z' }] : [];
    await dispatchAndFind(dispatch, listRuns, noSleep, 'ci-install.yml', {
      mode: 'stop-runner',
      runner: 'bmabcde-01-abcdefgh',
    });
    expect(seen).toEqual({
      workflow: 'ci-install.yml',
      inputs: { mode: 'stop-runner', runner: 'bmabcde-01-abcdefgh' },
    });
  });

  it('picks the newest of several new runs', async () => {
    let dispatched = false;
    const dispatch = async () => {
      dispatched = true;
    };
    const listRuns = async (): Promise<WorkflowRun[]> =>
      dispatched
        ? [
            { id: 10, createdAt: '2026-11-10T00:00:01Z' },
            { id: 11, createdAt: '2026-11-10T00:00:02Z' },
          ]
        : [];
    const runId = await dispatchAndFind(
      dispatch,
      listRuns,
      noSleep,
      'ci-install.yml',
      {},
    );
    expect(runId).toBe(11);
  });

  it('polls until a new run appears, then stops', async () => {
    const results: WorkflowRun[][] = [
      [], // the pre-dispatch snapshot
      [], // first poll after dispatch: still nothing new
      [], // second poll: still nothing new
      [{ id: 1, createdAt: '2026-11-10T00:00:00Z' }], // third poll: there it is
    ];
    const listRuns = async (): Promise<WorkflowRun[]> => results.shift() ?? [];
    let slept = 0;
    const runId = await dispatchAndFind(
      async () => undefined,
      listRuns,
      async () => {
        slept++;
      },
      'ci-install.yml',
      {},
    );
    expect(runId).toBe(1);
    expect(slept).toBe(2);
  });

  it('times out when no new run ever appears', async () => {
    let now = 0;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      await expect(
        dispatchAndFind(
          async () => undefined,
          async () => [],
          async () => {
            now += 30_000;
          },
          'ci-install.yml',
          {},
          { timeoutMs: 60_000 },
        ),
      ).rejects.toThrow('no new run appeared');
    } finally {
      Date.now = realNow;
    }
  });

  it('with a match predicate, skips a new run that belongs to someone else', async () => {
    const results: WorkflowRun[][] = [
      [{ id: 1, createdAt: '2026-11-10T00:00:00Z' }], // the pre-dispatch snapshot
      [
        { id: 1, createdAt: '2026-11-10T00:00:00Z' },
        // Someone else's concurrent dispatch of the same workflow, created
        // after ours but found first.
        { id: 2, createdAt: '2026-11-10T00:00:01Z', displayTitle: 'theirs' },
      ],
      [
        { id: 1, createdAt: '2026-11-10T00:00:00Z' },
        { id: 2, createdAt: '2026-11-10T00:00:01Z', displayTitle: 'theirs' },
        { id: 3, createdAt: '2026-11-10T00:00:02Z', displayTitle: 'ours' },
      ],
    ];
    let call = 0;
    const runId = await dispatchAndFind(
      async () => undefined,
      async () => results[Math.min(call++, results.length - 1)]!,
      noSleep,
      'lost-runner-check.yml',
      {},
      { match: (run) => run.displayTitle === 'ours' },
    );
    expect(runId).toBe(3);
  });

  it('with a match predicate, times out if only a non-matching run appears', async () => {
    let now = 0;
    const realNow = Date.now;
    Date.now = () => now;
    const results: WorkflowRun[][] = [
      [],
      [{ id: 2, createdAt: '2026-11-10T00:00:01Z', displayTitle: 'theirs' }],
    ];
    let call = 0;
    try {
      await expect(
        dispatchAndFind(
          async () => undefined,
          async () => results[Math.min(call++, results.length - 1)]!,
          async () => {
            now += 30_000;
          },
          'lost-runner-check.yml',
          {},
          { timeoutMs: 60_000, match: (run) => run.displayTitle === 'ours' },
        ),
      ).rejects.toThrow('no new matching run appeared');
    } finally {
      Date.now = realNow;
    }
  });
});

// GitHub's job-log download (not the live run view) timestamps every line
// individually, observed on run 42753394421.
const timestamped = (lines: string[]) =>
  lines.map((line) => `2026-11-10T12:00:00.1234567Z ${line}`).join('\n');

describe('parseTerminatedAt', () => {
  it('extracts the timestamp ci-install.yml prints before terminating, past the log timestamp prefix', () => {
    const log = timestamped([
      'Terminating bmabcde-01-abcdefgh at 2026-11-10T12:00:00.000Z',
      'some other line',
    ]);
    expect(parseTerminatedAt(log, 'bmabcde-01-abcdefgh')).toBe(
      '2026-11-10T12:00:00.000Z',
    );
  });

  it("throws when the runner's line isn't in the log", () => {
    expect(() =>
      parseTerminatedAt('nothing here', 'bmabcde-01-abcdefgh'),
    ).toThrow('no "Terminating bmabcde-01-abcdefgh at ..." line');
  });

  it("surfaces ci-install.yml's own error line instead of just reporting the expected line missing", () => {
    // Run 42776045377 (dispatched by the empty-runner_name bug above, run
    // 42775988257): ci-install.yml's `fail()` refused with a blank
    // $RUNNER_ID before ever printing "Terminating ... at ...".
    const log = timestamped([
      '[36;1m[[ $RUNNER_ID =~ ...',
      "##[error] isn't a runner Job ID",
      '##[error]Process completed with exit code 1.',
    ]);
    expect(() => parseTerminatedAt(log, 'bmabcde-01-abcdefgh')).toThrow(
      "isn't a runner Job ID",
    );
  });
});

describe('parseDiagnosis', () => {
  // ci-install.yml's diagnose step pretty-prints one object per named id
  // (its `jq` block, without -c), nested inside a job group; a raw job-log
  // download renders `::group::`/`::endgroup::` as `##[group]`/`##[endgroup]`
  // and timestamps every line (observed on run 42753394421).
  const diagnoseLog = (...fields: string[]) =>
    timestamped([
      '##[group]bmabcde-01-abcdefgh',
      '{',
      '  "id": "bmabcde-01-abcdefgh",',
      '  "state": "terminated",',
      '  "endReason": "terminated",',
      ...fields,
      '  "events": [',
      '    { "state": "retrying", "at": "2026-11-10T11:59:00Z" }',
      '  ]',
      '}',
      '--- anycloud logs bmabcde-01-abcdefgh',
      'runner log line',
      '##[endgroup]',
    ]);

  it('extracts cleanedAt and cleanupError once cleaned up', () => {
    const log = diagnoseLog(
      '  "cleanedAt": "2026-11-10T12:00:10Z",',
      '  "cleanupError": null,',
    );
    expect(parseDiagnosis(log, 'bmabcde-01-abcdefgh')).toEqual({
      cleanedAt: '2026-11-10T12:00:10Z',
      cleanupError: null,
    });
  });

  it('reports a cleanup error', () => {
    const log = diagnoseLog(
      '  "cleanedAt": "2026-11-10T12:00:10Z",',
      '  "cleanupError": "some { odd } message",',
    );
    expect(parseDiagnosis(log, 'bmabcde-01-abcdefgh')).toEqual({
      cleanedAt: '2026-11-10T12:00:10Z',
      cleanupError: 'some { odd } message',
    });
  });

  it('reports null when not yet cleaned up', () => {
    const log = diagnoseLog('  "cleanedAt": null,', '  "cleanupError": null,');
    expect(parseDiagnosis(log, 'bmabcde-01-abcdefgh')).toEqual({
      cleanedAt: null,
      cleanupError: null,
    });
  });

  it("throws when the runner's diagnosis isn't in the log", () => {
    expect(() => parseDiagnosis('nothing here', 'bmabcde-01-abcdefgh')).toThrow(
      'no diagnose JSON for bmabcde-01-abcdefgh',
    );
  });

  it("surfaces ci-install.yml's own error line instead of just reporting the expected JSON missing", () => {
    // "Find the saved anycloud state" runs ahead of diagnose and can fail
    // before diagnose ever prints an object, unlike the ci-install-busy
    // refusal (thrown locally, never written to a ci-install.yml log).
    const log = timestamped([
      '[command]/usr/bin/env gh api --paginate ...',
      '##[error]The newest anycloud-state artifact expired, so the cluster record is lost. Restore it from a backup.',
      '##[error]Process completed with exit code 1.',
    ]);
    expect(() => parseDiagnosis(log, 'bmabcde-01-abcdefgh')).toThrow(
      'the cluster record is lost',
    );
  });
});

describe('diagnoseWithRetry', () => {
  it('returns as soon as an attempt reports cleaned up', async () => {
    let attempts = 0;
    const result = await diagnoseWithRetry(async () => {
      attempts++;
      return { cleanedAt: '2026-11-10T12:00:30Z', cleanupError: null };
    }, noSleep);
    expect(attempts).toBe(1);
    expect(result.cleanedAt).toBe('2026-11-10T12:00:30Z');
  });

  it('retries once if the first attempt finds it not yet cleaned up', async () => {
    let attempts = 0;
    const result = await diagnoseWithRetry(async () => {
      attempts++;
      return attempts === 1
        ? { cleanedAt: null, cleanupError: null }
        : { cleanedAt: '2026-11-10T12:01:00Z', cleanupError: null };
    }, noSleep);
    expect(attempts).toBe(2);
    expect(result.cleanedAt).toBe('2026-11-10T12:01:00Z');
  });

  it('gives up after one retry, returning the last (not cleaned up) result', async () => {
    let attempts = 0;
    const result = await diagnoseWithRetry(async () => {
      attempts++;
      return { cleanedAt: null, cleanupError: null };
    }, noSleep);
    expect(attempts).toBe(2);
    expect(result.cleanedAt).toBeNull();
  });

  it('waits before every attempt, including the first', async () => {
    const waits: number[] = [];
    await diagnoseWithRetry(
      async () => ({ cleanedAt: '2026-11-10T12:00:30Z', cleanupError: null }),
      async (ms) => {
        waits.push(ms);
      },
      45_000,
    );
    expect(waits).toEqual([45_000]);
  });

  it("propagates an attempt's own error instead of retrying", async () => {
    await expect(
      diagnoseWithRetry(async () => {
        throw new Error('ci-install.yml already has a run in flight');
      }, noSleep),
    ).rejects.toThrow('ci-install.yml already has a run in flight');
  });
});
