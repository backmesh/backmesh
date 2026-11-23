import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import type { PastJob, RecentRuns } from '../../../src/github/runs.js';
import {
  jobMessageSchema,
  type JobMessage,
} from '../../../src/github/types.js';
import {
  children,
  items,
  learn,
  Planner,
  type PlannerDeps,
} from '../../../src/listener/prewarm.js';
import { message } from './fakes.js';

// Expected counts and times below are worked by hand from the replay's model
// (`simulate.py`): T3 starts a slot at the trigger plus its
// median offset minus the 71 s lead, and every slot ends 71 + 60 s after it
// starts.
const L = 'backmesh-ubuntu-2404-4vcpu';
const L8 = 'backmesh-ubuntu-2404-8vcpu';
const s = (seconds: number) => seconds * 1000;
const REF = 'acme/app/.github/workflows/ci.yml@refs/heads/main';

interface Spec {
  name: string;
  label?: string;
  q: number;
  start: number | null;
  end: number;
  result?: string;
}

// A run's messages in time order, each job Available and Assigned at its
// queue time, Started and Completed after; times in seconds. GitHub sends no
// JobAvailable (`scale-set-messages.json`), but at the same instant as the
// JobAssigned it changes nothing, and the replay test below has none.
function events(runId: number, jobs: Spec[], ref = REF) {
  const out: { at: number; label: string; job: JobMessage }[] = [];
  jobs.forEach((spec, i) => {
    const label = spec.label ?? L;
    const fields: Partial<JobMessage> = {
      workflowRunId: runId,
      jobId: `${runId}-${i}`,
      jobDisplayName: spec.name,
      jobWorkflowRef: ref,
      queueTime: s(spec.q),
      requestLabels: [label],
    };
    const at = (sec: number, type: JobMessage['messageType'], more = {}) =>
      out.push({
        at: s(sec),
        label,
        job: message(type, { ...fields, ...more }),
      });
    at(spec.q, 'JobAvailable');
    at(spec.q, 'JobAssigned');
    if (spec.start !== null) {
      at(spec.start, 'JobStarted', { runnerAssignTime: s(spec.start) });
    }
    at(spec.end, 'JobCompleted', {
      finishTime: s(spec.end),
      result: spec.result ?? 'Succeeded',
    });
  });
  return out.sort((a, b) => a.at - b.at);
}

function feed(planner: Planner, list: ReturnType<typeof events>) {
  for (const { at, label, job } of list) planner.observe(label, job, at);
}

// A run of the build-then-tests shape at `t0`: `build` waits `wait` s for a
// runner and runs `dur` s, then `tests` jobs queue 2 s after it ends.
function buildRun(t0: number, tests: number, dur = 100, wait = 71): Spec[] {
  const end = t0 + wait + dur;
  return [
    { name: 'build', q: t0, start: t0 + wait, end },
    ...Array.from({ length: tests }, (_, i) => ({
      name: `test (${i})`,
      q: end + 2,
      start: end + 80,
      end: end + 200,
    })),
  ];
}

// Runs `runs` one after another from `start`, each 130 s after the last
// one's end, so the next message settles it; returns the time after them.
function learnRuns(planner: Planner, runs: Spec[][], firstId = 1, start = 0) {
  let t = start;
  runs.forEach((specs, i) => {
    const shifted = specs.map((spec) => ({
      ...spec,
      q: spec.q + t,
      start: spec.start === null ? null : spec.start + t,
      end: spec.end + t,
    }));
    feed(planner, events(firstId + i, shifted));
    t = Math.max(...shifted.map((spec) => spec.end)) + 130;
  });
  return t;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

const make = (history?: RecentRuns) => {
  const logs: Record<string, unknown>[] = [];
  // Started an hour ago, past the warm-up.
  let clock = s(-3600);
  const planner = new Planner({
    labels: [L, L8],
    history,
    log: (entry) => void logs.push(entry),
    now: () => clock,
  });
  clock = 0;
  return { planner, logs };
};

describe('Planner', () => {
  it("starts T2's children when their parent starts, with fewer than 5 runs", () => {
    const { planner } = make();
    const t = learnRuns(planner, [buildRun(0, 2)]);
    const next = buildRun(t, 2);
    const list = events(100, next);
    // The trigger: T2 has no roots to start, so nothing yet.
    feed(planner, list.slice(0, 2));
    expect(planner.speculative(L, s(t))).toBe(0);
    // `build` starts: its 2 children start now and end 131 s later.
    feed(planner, list.slice(2, 3));
    const started = s(t + 71);
    expect(planner.speculative(L, started)).toBe(2);
    // Predicted, not a cue's.
    expect(planner.speculative(L, started, true)).toBe(0);
    expect(planner.nextDue(started)).toBe(s(131));
    expect(planner.speculative(L, started + s(131))).toBe(0);
  });

  it('starts each T3 slot at its median offset minus the lead', () => {
    const { planner } = make();
    // The trigger waits 31 s, so its children's offsets are normalized by
    // +40 s: a test queued at 31 + dur + 2 s learns 73 + dur. Durations
    // 100, 110, 120, 130 and 500 s give 173, 183, 193, 203 and 573 s, with
    // 2, 2, 3, 1 and 2 tests; and `lint` on backmesh-ubuntu-2404-8vcpu queues with the
    // trigger.
    const runs = [100, 110, 120, 130, 500].map((dur, i) => [
      ...buildRun(0, [2, 2, 3, 1, 2][i]!, dur, 31),
      { name: 'lint', label: L8, q: 0, start: 40, end: 60 },
    ]);
    const t = learnRuns(planner, runs);
    const list = events(100, [
      ...buildRun(t, 2),
      { name: 'lint', label: L8, q: t, start: t + 71, end: t + 90 },
    ]);
    // Only the trigger's Available, then lint's: the median count of tests
    // is 2; the first at median(173, 183, 193, 203, 573) = 193 s, the second
    // at median(173, 183, 193, 573) = 188 s; lint's at 0, so at once.
    planner.observe(L, list[0]!.job, s(t));
    expect(planner.speculative(L8, s(t))).toBe(1);
    expect(planner.speculative(L, s(t + 116))).toBe(0);
    expect(planner.speculative(L, s(t + 117))).toBe(1);
    expect(planner.speculative(L, s(t + 122))).toBe(2);
    expect(planner.speculative(L, s(t + 117 + 131))).toBe(1);
    expect(planner.speculative(L, s(t + 122 + 131))).toBe(0);
    // lint's assignment spends its slot, not the trigger's.
    const lint = list.find(
      (e) =>
        e.job.jobDisplayName === 'lint' && e.job.messageType === 'JobAssigned',
    )!;
    const build = list.find((e) => e.job.messageType === 'JobAssigned')!;
    planner.observe(L, build.job, s(t));
    planner.observe(L8, lint.job, s(t));
    expect(planner.speculative(L8, s(t))).toBe(0);
    expect(planner.speculative(L, s(t + 122))).toBe(2);
    // A test's assignment before its slot started spends one not started.
    const test = list.find(
      (e) =>
        e.job.jobDisplayName === 'test (0)' &&
        e.job.messageType === 'JobAssigned',
    )!;
    planner.observe(L, test.job, s(t + 100));
    expect(planner.speculative(L, s(t + 122))).toBe(1);
  });

  it("drops a run's slots at its first failed or cancelled job (C2)", () => {
    const { planner } = make();
    const t = learnRuns(planner, [buildRun(0, 3)]);
    const list = events(100, buildRun(t, 3));
    feed(planner, list.slice(0, 3));
    expect(planner.speculative(L, s(t + 71))).toBe(3);
    planner.observe(
      L,
      { ...list[0]!.job, messageType: 'JobCompleted', result: 'Canceled' },
      s(t + 80),
    );
    expect(planner.speculative(L, s(t + 80))).toBe(0);
    expect(planner.nextDue(s(t + 80))).toBeUndefined();
  });

  it('learns a run only once no message has named it for 2 minutes', () => {
    const { planner } = make();
    const specs = buildRun(0, 2);
    feed(planner, events(1, specs));
    const end = 71 + 100 + 200;
    // 1 minute after its last job: not learned, so no T2 for the next run.
    feed(planner, events(2, buildRun(end + 60, 2)).slice(0, 3));
    expect(planner.speculative(L, s(end + 60 + 71))).toBe(0);
    // Past 2 minutes it's learned; and a late message of run 1, such as a
    // rerun's, neither plans nor relearns it.
    feed(planner, events(3, buildRun(end + 130, 2)).slice(0, 3));
    expect(planner.speculative(L, s(end + 130 + 71))).toBe(2);
    const rerun = specs.map((spec) => ({
      ...spec,
      q: spec.q + 1000,
      start: spec.start! + 1000,
      end: spec.end + 1000,
    }));
    feed(planner, events(1, rerun));
    expect(planner.speculative(L, s(1071))).toBe(0);
    expect(planner.status()).toEqual({ keys: 1, guarded: 0, off: false });
  });

  it('neither plans nor learns a run first heard of past its offer', () => {
    const { planner } = make();
    const t = learnRuns(planner, [buildRun(0, 2)]);
    // A listener restart mid-run: its first message is a JobStarted.
    feed(planner, events(100, buildRun(t, 4)).slice(2));
    expect(planner.speculative(L, s(t + 71))).toBe(0);
    // It isn't learned: learned, its 4 tests would make the median 3.
    const next = t + 1000;
    feed(planner, events(101, buildRun(next, 2)).slice(0, 3));
    expect(planner.speculative(L, s(next + 71))).toBe(2);
  });

  // What GitHub sent a scale set in the f-check run
  // (`scale-set-messages.json`): JobAssigned first, with no JobAvailable,
  // queueTime .NET's MinValue and runnerRequestId 0. Each job's messages are
  // those two captured ones with its own IDs and times, and a JobStarted made
  // from its JobAssigned with the runner's assign time, as no runner took the
  // captured job.
  it('learns and plans from the messages GitHub sends, which have no JobAvailable', () => {
    const captured: {
      messages: Record<string, unknown>[];
    } = JSON.parse(
      readFileSync(
        new URL('./scale-set-messages.json', import.meta.url),
        'utf8',
      ),
    );
    const [assigned, completed] = captured.messages as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(captured.messages.map((m) => m.messageType)).toEqual([
      'JobAssigned',
      'JobCompleted',
    ]);
    expect(jobMessageSchema.parse(assigned).queueTime).toBeNull();
    const base = Date.parse('2026-11-08T17:00:00Z');
    const iso = (sec: number) => new Date(base + s(sec)).toISOString();
    // `late` delivers a job's JobAssigned that much after GitHub's assign
    // time, which is what the planner must learn from.
    const wire = (
      run: number,
      name: string,
      q: number,
      start: number,
      end: number,
      late = 0,
    ) => {
      const own = {
        workflowRunId: run,
        jobId: `${run}-${name}`,
        jobDisplayName: name,
        requestLabels: [L],
        scaleSetAssignTime: iso(q),
      };
      return [
        { at: q + late, m: { ...assigned, ...own } },
        {
          at: start,
          m: {
            ...assigned,
            ...own,
            messageType: 'JobStarted',
            runnerAssignTime: iso(start),
            runnerName: `r-${run}-${name}`,
          },
        },
        {
          at: end,
          m: {
            ...completed,
            ...own,
            runnerAssignTime: iso(start),
            finishTime: iso(end),
            result: 'Succeeded',
          },
        },
      ];
    };
    const run = (id: number, t0: number) => [
      ...wire(id, 'root', t0, t0 + 58, t0 + 106),
      ...wire(id, 'fanout (1)', t0 + 107, t0 + 165, t0 + 177, 8),
      ...wire(id, 'fanout (2)', t0 + 107, t0 + 165, t0 + 177, 8),
    ];
    const { planner } = make();
    const send = (list: ReturnType<typeof run>) => {
      for (const { at, m } of list.sort((a, b) => a.at - b.at)) {
        planner.observe(L, jobMessageSchema.parse(m), base + s(at));
      }
    };
    send(run(1, 0));
    // Run 2's root, 130 s after run 1's last message, settles run 1.
    const next = run(2, 177 + 130);
    send(next.slice(0, 1));
    expect(planner.status().keys).toBe(1);
    // The children were learned as the root's, so nothing starts yet.
    expect(planner.speculative(L, base + s(177 + 130))).toBe(0);
    // T2: the root's start starts its 2 children's runners.
    send(next.slice(1, 2));
    expect(planner.speculative(L, base + s(177 + 130 + 58))).toBe(2);
  });

  it('spends no slot on the trigger, whichever label is heard of first', () => {
    for (const lintFirst of [false, true]) {
      const { planner } = make();
      // build on backmesh-ubuntu-2404-4vcpu and lint on backmesh-ubuntu-2404-8vcpu queue together, then 2
      // tests at 173 s: T3 from 5 runs.
      const run = (t0: number): Spec[] => [
        ...buildRun(t0, 2),
        { name: 'lint', label: L8, q: t0, start: t0 + 71, end: t0 + 90 },
      ];
      const t = learnRuns(
        planner,
        Array.from({ length: 5 }, () => run(0)),
      );
      const list = events(100, run(t)).filter((e) => e.at === s(t));
      // Each label's session delivers in its own order.
      const order = lintFirst
        ? [
            ...list.filter((e) => e.label === L8),
            ...list.filter((e) => e.label === L),
          ]
        : list;
      feed(planner, order);
      expect(planner.speculative(L8, s(t))).toBe(0);
      expect(planner.speculative(L, s(t + 102))).toBe(2);
    }
  });

  it("takes the trigger's label from most learned runs", () => {
    const { planner } = make();
    // Four runs start with build on backmesh-ubuntu-2404-4vcpu; the last skipped it and
    // started with lint on backmesh-ubuntu-2404-8vcpu. Tests at 173 s, lint at 0.
    const full = (t0: number): Spec[] => [
      ...buildRun(t0, 2),
      { name: 'lint', label: L8, q: t0, start: t0 + 71, end: t0 + 90 },
    ];
    const lintOnly: Spec[] = [
      { name: 'lint', label: L8, q: 0, start: 71, end: 90 },
      ...[0, 1].map((i) => ({
        name: `test (${i})`,
        q: 173,
        start: 250,
        end: 400,
      })),
    ];
    const t = learnRuns(planner, [
      full(0),
      full(0),
      full(0),
      full(0),
      lintOnly,
    ]);
    // build is the trigger, and lint spends its slot.
    feed(
      planner,
      events(100, full(t)).filter((e) => e.at === s(t)),
    );
    expect(planner.speculative(L8, s(t))).toBe(0);
    expect(planner.speculative(L, s(t + 102))).toBe(2);
  });

  it("expects each label's boot as its median start plus its median registration", () => {
    const { planner } = make();
    expect(planner.boot(L)).toBe(s(71));
    // Starts only, as of runners speculation started: 35 s, plus 8 s.
    for (const sec of [40, 30, 35]) planner.booted(L, s(sec), null);
    expect(planner.boot(L)).toBe(s(43));
    // A job that waited for its runner: registered in 5 s.
    planner.booted(L, null, s(5));
    expect(planner.boot(L)).toBe(s(40));
    expect(planner.boot(L8)).toBe(s(71));
    // A start on backmesh-ubuntu-2404-8vcpu, which speculation always serves: it takes the
    // other labels' registration.
    planner.booted(L8, s(20), null);
    expect(planner.boot(L8)).toBe(s(25));
    // The last 20 starts, at 90 s, push the first 3 out.
    for (let i = 0; i < 20; i++) planner.booted(L, s(90), null);
    expect(planner.boot(L)).toBe(s(95));
  });

  it('averages an even number of boots for the exact median, not a nearest-rank percentile', () => {
    const { planner } = make();
    // An even count (4): the two middle values, 20 and 30 s, average to
    // 25 s. Nearest rank at p = 0.5 would instead give 20 s.
    for (const sec of [10, 20, 30, 40]) planner.booted(L, s(sec), null);
    expect(planner.boot(L)).toBe(s(25 + 8));
  });

  it('starts and ends T3 slots by the learned boots, so a runner idles at most 60 s', () => {
    const { planner } = make();
    // backmesh-ubuntu-2404-4vcpu boots in 30 s, backmesh-ubuntu-2404-8vcpu in 90 s.
    for (let i = 0; i < 3; i++) {
      planner.booted(L, s(22), s(8));
      planner.booted(L8, s(82), s(8));
    }
    // 5 runs: build waits 30 s and runs 100 s; test on backmesh-ubuntu-2404-4vcpu and e2e
    // on backmesh-ubuntu-2404-8vcpu queue 2 s after it ends, at 132 s, which is 102 s
    // after a trigger that waited none.
    const run = (t0: number): Spec[] => [
      ...buildRun(t0, 1, 100, 30),
      { name: 'e2e', label: L8, q: t0 + 132, start: t0 + 230, end: t0 + 300 },
    ];
    const t = learnRuns(
      planner,
      Array.from({ length: 5 }, () => run(0)),
    );
    planner.observe(L, events(100, run(t))[0]!.job, s(t));
    // Both are due at 102 + build's 30 s boot = 132 s. test's runner starts
    // at 132 - 30 = 102 s and ends 30 + 60 s later, at 192 s; e2e's starts at
    // 132 - 90 = 42 s and ends 90 + 60 s later, also at 192 s.
    expect(planner.speculative(L, s(t + 101))).toBe(0);
    expect(planner.speculative(L, s(t + 102))).toBe(1);
    expect(planner.speculative(L, s(t + 191))).toBe(1);
    expect(planner.speculative(L, s(t + 192))).toBe(0);
    expect(planner.speculative(L8, s(t + 41))).toBe(0);
    expect(planner.speculative(L8, s(t + 42))).toBe(1);
    expect(planner.speculative(L8, s(t + 192))).toBe(0);
  });

  it("ends T2's slots 60 s after the learned boot", () => {
    const { planner } = make();
    for (let i = 0; i < 3; i++) planner.booted(L, s(22), s(8));
    const t = learnRuns(planner, [buildRun(0, 2)]);
    // build starts at t + 71: its children start, ready 30 s later, and end
    // 60 s after that.
    feed(planner, events(100, buildRun(t, 2)).slice(0, 3));
    expect(planner.speculative(L, s(t + 71 + 89))).toBe(2);
    expect(planner.speculative(L, s(t + 71 + 90))).toBe(0);
  });

  it('counts a redelivered batch once', () => {
    const { planner } = make();
    const t = learnRuns(planner, [buildRun(0, 3)]);
    const list = events(100, buildRun(t, 3));
    // The trigger and its start, delivered twice: 3 children, not 6.
    feed(planner, [...list.slice(0, 3), ...list.slice(0, 3)]);
    expect(planner.speculative(L, s(t + 71))).toBe(3);
    const test = list.find(
      (e) =>
        e.job.jobDisplayName === 'test (0)' &&
        e.job.messageType === 'JobAssigned',
    )!;
    planner.observe(L, test.job, s(t + 100));
    planner.observe(L, test.job, s(t + 100));
    expect(planner.speculative(L, s(t + 100))).toBe(2);
  });

  it('neither plans nor learns a run in its first 30 minutes, which may have begun before it', () => {
    const planner = new Planner({
      labels: [L],
      log: () => undefined,
      now: () => 0,
    });
    // Run 1 at 0 s isn't learned, so run 2 at 30 minutes has no T2; run 2
    // is learned, so run 3 has.
    const t = learnRuns(planner, [buildRun(0, 2)]);
    const start = Math.max(t, 1800);
    const u = learnRuns(planner, [buildRun(0, 2)], 2, start);
    expect(planner.speculative(L, s(start + 71))).toBe(0);
    feed(planner, events(3, buildRun(u, 2)).slice(0, 3));
    expect(planner.speculative(L, s(u + 71))).toBe(2);
  });

  // `prewarm-replay.json` comes from the replay's `simulate.py` through
  // `prewarm-replay.py`, which says how.
  const replay: {
    predictor: {
      hist: [string, string, number, number][][];
      items: [string, number][];
      children: [string | null, [string, number][]][];
    }[];
    learn: {
      jobs: [string, string, number, number, number][];
      steps: [string, string, number, number][];
    }[];
  } = JSON.parse(
    readFileSync(new URL('./prewarm-replay.json', import.meta.url), 'utf8'),
  );

  it("predicts what the replay's Predictor does on its own histories", () => {
    for (const c of replay.predictor) {
      const hist = c.hist.map((run) =>
        run.map(([name, label, offset, parent]) => ({
          name,
          label,
          offset,
          parent,
        })),
      );
      expect(items(hist)).toEqual(c.items);
      expect(new Map(children(hist))).toEqual(new Map(c.children));
    }
  });

  it("learns a run's parents and offsets as the replay's load and observe do", () => {
    for (const c of replay.learn) {
      const jobs = c.jobs.map(
        ([name, label, queuedAt, startedAt, finishedAt]) => ({
          name,
          label,
          queuedAt,
          startedAt,
          finishedAt,
        }),
      );
      // The replay normalizes to a trigger that waited 71 s; `learn`, to
      // one that waited none, and T3 adds the trigger's boot back.
      expect(
        learn(jobs)!.map((st) => [
          st.name,
          st.label,
          st.parent === -1 ? st.offset : st.offset + 71_000,
          st.parent,
        ]),
      ).toEqual(c.steps);
    }
  });

  it('backfills an unseen key once, keeping only its own labels, then plans T3 from it', async () => {
    const calls: unknown[] = [];
    const past: { id: number; jobs: PastJob[] }[] = Array.from(
      { length: 6 },
      (_, i) => ({
        id: 900 - i,
        jobs: [
          job('build', [L], 0, 71, 171),
          job('test', [L], 173, 250, 400),
          job('hosted', ['ubuntu-latest'], 173, 180, 200),
          job('skip', [L], 173, null, null, 'skipped'),
        ],
      }),
    );
    const { planner } = make(async (ref, count, take) => {
      calls.push({ ref, count, take: take() });
      return past;
    });
    feed(planner, events(1, buildRun(0, 0)).slice(0, 1));
    await flush();
    expect(calls).toEqual([
      {
        ref: { owner: 'acme', repo: 'app', workflow: 'ci.yml', event: 'push' },
        count: 20,
        take: true,
      },
    ]);
    // Six runs of history: T3, with test at 173 s, so from 102 s.
    feed(planner, events(2, buildRun(1000, 1)).slice(0, 1));
    expect(planner.speculative(L, s(1000 + 101))).toBe(0);
    expect(planner.speculative(L, s(1000 + 102))).toBe(1);
    // Another run of the key doesn't backfill again.
    feed(planner, events(3, buildRun(2000, 1)).slice(0, 1));
    expect(calls).toHaveLength(1);
  });

  // F's install saw its workflow first in the warm-up, while its first run,
  // queued before the start, was still going: that backfill found nothing
  // completed, and W1 doesn't learn such a run, so the next backfill must.
  it('backfills a key again while every backfill so far found nothing, learning a run heard in the warm-up', async () => {
    let past: { id: number; jobs: PastJob[] }[] = [];
    let calls = 0;
    let clock = 0;
    const planner = new Planner({
      labels: [L],
      history: async () => (calls++, past),
      log: () => undefined,
      now: () => clock,
    });
    const before = events(1, buildRun(0, 1)).slice(0, 1);
    before[0]!.job.queueTime = -1;
    feed(planner, before);
    await flush();
    past = [
      {
        id: 1,
        jobs: [
          job('build', [L], 0, 71, 171),
          job('test (0)', [L], 173, 250, 400),
        ],
      },
    ];
    clock = s(1900);
    feed(planner, events(2, buildRun(1900, 1)).slice(0, 1));
    await flush();
    expect(calls).toBe(2);
    expect(planner.status().keys).toBe(1);
    feed(planner, events(3, buildRun(2900, 1)).slice(0, 1));
    await flush();
    expect(calls).toBe(2);
  });

  it('backfills no key W1 has learned from', async () => {
    let calls = 0;
    const { planner } = make(async () => (calls++, []));
    // The first run's backfill finds nothing; W1 learns the run, settled
    // by the second run's first message, which then needs no backfill.
    const t = learnRuns(planner, [buildRun(0, 1)]);
    await flush();
    feed(planner, events(2, buildRun(t, 1)).slice(0, 1));
    await flush();
    expect(planner.status().keys).toBe(1);
    expect(calls).toBe(1);
  });

  it("gives an empty backfill's unused calls back to the hour's budget", async () => {
    const refs: string[] = [];
    const planner = new Planner({
      labels: [L],
      // One call each, so 14 backfills fit in 300 only if each gives back
      // the other 20 it reserved.
      history: async (ref, _count, take) => (
        refs.push(ref.workflow),
        take(),
        []
      ),
      log: () => undefined,
      now: () => 0,
    });
    for (let i = 1; i <= 20; i++) {
      planner.observe(
        L,
        message('JobAssigned', {
          workflowRunId: i,
          jobId: `${i}`,
          jobWorkflowRef: `acme/app/.github/workflows/w${i}.yml@refs/heads/main`,
        }),
        0,
      );
      await flush();
    }
    expect(refs).toHaveLength(20);
  });

  it("skips a backfill the hour's budget can't hold, and a reusable workflow's", async () => {
    const refs: string[] = [];
    let clock = 0;
    const planner = new Planner({
      labels: [L],
      history: async (ref, _count, take) => {
        refs.push(ref.workflow);
        while (take());
        return [];
      },
      log: () => undefined,
      now: () => clock,
    });
    const first = (runId: number, ref: string, at: number) =>
      planner.observe(
        L,
        message('JobAvailable', {
          workflowRunId: runId,
          jobId: `${runId}`,
          jobWorkflowRef: ref,
        }),
        at,
      );
    first(1, REF, 0);
    await flush();
    // The first took all 300 calls.
    first(2, 'acme/app/.github/workflows/b.yml@refs/heads/main', 0);
    first(3, 'acme/shared/.github/workflows/c.yml@v1', 0);
    await flush();
    expect(refs).toEqual(['ci.yml']);
    clock = s(3600);
    first(4, 'acme/app/.github/workflows/d.yml@refs/heads/main', clock);
    await flush();
    expect(refs).toEqual(['ci.yml', 'd.yml']);
  });

  it('reserves each backfill its runs list and a jobs page per run', async () => {
    const got: number[] = [];
    const planner = new Planner({
      labels: [L],
      history: async (_ref, _count, take) => {
        await flush();
        let n = 0;
        while (take()) n++;
        got.push(n);
        return [];
      },
      log: () => undefined,
      now: () => 0,
    });
    for (const [id, file] of [
      [1, 'a'],
      [2, 'b'],
    ] as const) {
      planner.observe(
        L,
        message('JobAvailable', {
          workflowRunId: id,
          jobId: `${id}`,
          jobWorkflowRef: `acme/app/.github/workflows/${file}.yml@refs/heads/main`,
        }),
        0,
      );
    }
    await flush();
    await flush();
    // The first takes all but the second's reserved 21 of the 300.
    expect(got).toEqual([279, 21]);
  });

  it('turns a key reactive below 60 % precision over 20 predicted slots, and keeps scoring it', async () => {
    // 20 backfilled runs of 4 tests predict 4; each live run has 1: 25 %.
    const past = Array.from({ length: 20 }, (_, i) => ({
      id: 900 - i,
      jobs: [
        job('build', [L], 0, 71, 171),
        ...[0, 1, 2, 3].map((n) => job(`test (${n})`, [L], 173, 250, 400)),
      ],
    }));
    const { planner } = make(async () => past);
    feed(planner, events(1, buildRun(0, 0)).slice(0, 1));
    await flush();
    // Five live runs, each predicted 4 and right on 1: 5 of 20. Their
    // history stays at a median of 4 tests, so each is still predicted.
    const t = learnRuns(
      planner,
      Array.from({ length: 5 }, () => buildRun(0, 1)),
      2,
    );
    expect(planner.status().guarded).toBe(0);
    // The next run settles the fifth: guarded, so no slots.
    feed(planner, events(50, buildRun(t, 1)).slice(0, 1));
    expect(planner.status()).toEqual({ keys: 1, guarded: 1, off: false });
    expect(planner.speculative(L, s(t + 102))).toBe(0);
    expect(planner.nextDue(s(t))).toBeUndefined();
  });

  it('turns itself off on an error and leaves the scaler reactive', async () => {
    const { planner, logs } = make(async () => [
      { id: 999, jobs: undefined as unknown as PastJob[] },
    ]);
    feed(planner, events(1, buildRun(0, 1)).slice(0, 1));
    await flush();
    expect(planner.status()).toEqual({ keys: 0, guarded: 0, off: true });
    expect(logs).toEqual([
      expect.objectContaining({ msg: 'planner failed; scaling reactively' }),
    ]);
    feed(planner, events(2, buildRun(1000, 1)));
    expect(planner.speculative(L, s(1071))).toBe(0);
  });

  it('logs a failed backfill without names and learns from messages', async () => {
    const { planner, logs } = make(async () => {
      throw new Error('Not Found');
    });
    feed(planner, events(1, buildRun(0, 1)));
    await flush();
    expect(logs).toEqual([
      {
        msg: 'planner backfill failed; learning from messages only',
        error: 'Error: Not Found',
      },
    ]);
    feed(planner, events(2, buildRun(1000, 1)).slice(0, 3));
    expect(planner.speculative(L, s(1071))).toBe(1);
  });
});

function job(
  name: string,
  labels: string[],
  q: number,
  start: number | null,
  end: number | null,
  conclusion = 'success',
): PastJob {
  return {
    name,
    labels,
    conclusion,
    queuedAt: s(q),
    startedAt: start === null ? null : s(start),
    finishedAt: end === null ? null : s(end),
  };
}

describe('Planner.cue', () => {
  // `build` on L waits `wait` s with `lint` on L8 queued beside it, then two
  // tests: the first wave is build and lint.
  const shape = (wait = 71) => [
    ...buildRun(0, 2, 100, wait),
    { name: 'lint', label: L8, q: 0, start: wait, end: wait + 20 },
  ];
  const cueAt = (t: number) => s(t + 10);
  // 10/20/30/40 s learned starts, each label given (no registrations, so
  // an 8 s default register): the median is 25 s, p95 40 s.
  const varyingBoots = (planner: Planner, ...labels: string[]) => {
    for (const sec of [10, 20, 30, 40]) {
      for (const label of labels) planner.booted(label, s(sec), null);
    }
  };

  it("starts the first wave 5 s before it'd be ready at the lead, and ends it 180 s idle after", () => {
    const { planner } = make();
    const t = learnRuns(planner, [shape(31)]);
    // A learned boot of 31 s on both labels (one sample: its percentile is
    // the same value).
    planner.booted(L, 23_000, 8_000);
    planner.booted(L8, 23_000, 8_000);
    const at = cueAt(t);
    expect(planner.cue('ACME/app', 'main', s(100), at).added).toBe(2);
    // Ready at +100 s, so each starts 31 s and the 5 s slack before.
    expect(planner.speculative(L, at + s(63))).toBe(0);
    expect(planner.speculative(L, at + s(64))).toBe(1);
    expect(planner.speculative(L8, at + s(64))).toBe(1);
    expect(planner.speculative(L, at + s(64 + 31 + 180) - 1)).toBe(1);
    expect(planner.speculative(L, at + s(64 + 31 + 180))).toBe(0);
  });

  it("times a cue slot's boot at a high percentile of the label's recent boots, not the median", () => {
    const { planner } = make();
    const t = learnRuns(planner, [shape(31)]);
    varyingBoots(planner, L, L8);
    expect(planner.boot(L)).toBe(s(25 + 8));
    const at = cueAt(t);
    expect(planner.cue('acme/app', 'main', s(100), at).added).toBe(2);
    // Ready at +100 s: p95's 48 s boot and the 5 s slack start the slot
    // at +47 s. The median's 33 s would only start it at +67 s.
    expect(planner.speculative(L, at + s(46))).toBe(0);
    expect(planner.speculative(L, at + s(47))).toBe(1);
  });

  it('idles a cued slot 180 s, against a predicted one at 60 s, both over a 1 s boot', () => {
    // A single learned sample: the median and every percentile of it are
    // the same value, so only IDLE_MS vs. CUE_IDLE_MS tells the two apart.
    const { planner: cued } = make();
    cued.booted(L, s(1), s(0));
    cued.booted(L8, s(1), s(0));
    const tc = learnRuns(cued, [shape(31)]);
    const at = cueAt(tc);
    expect(cued.cue('acme/app', 'main', 0, at).added).toBe(2);
    // Ready at once (the lead is already past): idled for 179 s, it's
    // there; for 180 s (CUE_IDLE_MS), it's gone at +181 s (the 1 s boot
    // plus 180).
    expect(cued.speculative(L, at + s(179))).toBe(1);
    expect(cued.speculative(L, at + s(180))).toBe(1);
    expect(cued.speculative(L, at + s(181))).toBe(0);

    const { planner: predicted } = make();
    predicted.booted(L, s(1), s(0));
    const tp = learnRuns(predicted, [buildRun(0, 2)]);
    // build's children (T2, under 5 runs of history) start the moment it
    // does, and idle out IDLE_MS (60 s) later: gone at the 1 s boot plus
    // 60, +61 s, not before.
    feed(predicted, events(100, buildRun(tp, 2)).slice(0, 3));
    expect(predicted.speculative(L, s(tp + 71 + 60))).toBe(2);
    expect(predicted.speculative(L, s(tp + 71 + 61))).toBe(0);
  });

  it('starts at once for a lead already past, with the default boot before any is learned', () => {
    const { planner } = make();
    const t = learnRuns(planner, [shape()]);
    const at = cueAt(t);
    expect(planner.cue('acme/app', 'main', 0, at).added).toBe(2);
    expect(planner.speculative(L, at)).toBe(1);
    expect(planner.speculative(L, at + s(71 + 180))).toBe(0);
  });

  it('cues only push workflows of the repo that ran on the branch, or on several', () => {
    const { planner } = make();
    let t = learnRuns(planner, [shape()]);
    const at = cueAt(t);
    expect(planner.cue('acme/other', 'main', 0, at).added).toBe(0);
    expect(planner.cue('acme/app', 'feature', 0, at).added).toBe(0);
    // A run of the same workflow on another branch: now any branch cues.
    const other = 'acme/app/.github/workflows/ci.yml@refs/heads/dev';
    feed(
      planner,
      events(
        50,
        shape().map((j) => ({
          ...j,
          q: j.q + t,
          start: j.start === null ? null : j.start + t,
          end: j.end + t,
        })),
        other,
      ),
    );
    t += 1000;
    expect(planner.cue('acme/app', 'feature', 0, s(t)).added).toBe(2);
  });

  // The scaler's desired count is TotalAssignedJobs plus the speculative
  // slots, so a slot must go only when its job's assignment counts it.
  const later = (t: number, specs = shape(1), id = 200, ref = REF) =>
    events(
      id,
      specs.map((j) => ({
        ...j,
        q: j.q + t,
        start: j.start === null ? null : j.start + t,
        end: j.end + t,
      })),
      ref,
    );
  const find = (list: ReturnType<typeof events>, name: string, type: string) =>
    list.find(
      (e) => e.job.jobDisplayName === name && e.job.messageType === type,
    )!;

  it("hands a cue's runners to its push's run, spending each at its job's assignment", () => {
    const { planner } = make();
    const t = learnRuns(planner, [shape(31)]);
    planner.cue('acme/app', 'main', 0, cueAt(t));
    const list = later(t + 20);
    const now = s(t + 20);
    // The trigger's Available: nothing goes yet, and T2's own root (lint)
    // is the cue's, not another.
    planner.observe(L, find(list, 'build', 'JobAvailable').job, now);
    expect(planner.speculative(L, now)).toBe(1);
    expect(planner.speculative(L8, now)).toBe(1);
    // Still a cue's once the run takes them.
    expect(planner.speculative(L8, now, true)).toBe(1);
    planner.observe(L, find(list, 'build', 'JobAssigned').job, now);
    expect(planner.speculative(L, now)).toBe(0);
    planner.observe(L8, find(list, 'lint', 'JobAvailable').job, now);
    planner.observe(L8, find(list, 'lint', 'JobAssigned').job, now);
    expect(planner.speculative(L8, now)).toBe(0);
  });

  it('leaves a root queued later than the trigger to T3, and in the warm-up learns only runs queued after the start', () => {
    const { planner } = make();
    const late = [
      ...shape(31),
      { name: 'deploy', label: L8, q: 300, start: 331, end: 340 },
    ];
    const t = learnRuns(planner, [late]);
    // build and lint; not deploy.
    expect(planner.cue('acme/app', 'main', 0, cueAt(t)).added).toBe(2);
    // Restarted at 0: a run queued then is learned and cued at once, as is
    // one queued later, but not one queued before.
    const restarted = () =>
      new Planner({ labels: [L, L8], log: () => undefined, now: () => 0 });
    const after = restarted();
    const end = learnRuns(after, [shape()]);
    expect(after.cue('acme/app', 'main', 0, s(end)).added).toBe(2);
    const earlier = restarted();
    const before = events(1, shape()).map((e) => ({
      ...e,
      job: { ...e.job, queueTime: -1 },
    }));
    feed(earlier, before);
    expect(earlier.cue('acme/app', 'main', 0, s(600)).added).toBe(0);
  });

  it("lets a cue's runners stand for T3's first-wave slots", () => {
    const { planner } = make();
    const t = learnRuns(
      planner,
      Array.from({ length: 5 }, () => shape(31)),
    );
    planner.cue('acme/app', 'main', 0, cueAt(t));
    const now = s(t + 20);
    planner.observe(L, later(t + 20)[0]!.job, now);
    // lint's T3 slot at offset 0 is the cue's; the tests' come later.
    expect(planner.speculative(L8, now)).toBe(1);
    expect(planner.speculative(L, now)).toBe(1);
    expect(planner.nextDue(now)).toBeGreaterThan(0);
  });

  it("logs a cue slot's start once, its push's run taking it, and an untaken one's expiry", () => {
    const steps = (logs: Record<string, unknown>[]) =>
      logs.filter((entry) => String(entry.msg).startsWith('cue '));
    const { planner, logs } = make();
    const t = learnRuns(planner, [shape(31)]);
    planner.booted(L, 23_000, 8_000);
    planner.booted(L8, 23_000, 8_000);
    const at = cueAt(t);
    planner.cue('acme/app', 'main', s(100), at);
    planner.speculative(L, at + s(63));
    expect(steps(logs)).toEqual([]);
    planner.speculative(L, at + s(64));
    planner.speculative(L, at + s(65), true);
    const workflow = 'acme/app/.github/workflows/ci.yml push';
    expect(steps(logs)).toEqual([
      {
        msg: 'cue slot started',
        label: L,
        run: -1,
        workflow,
        branch: 'main',
        bootMs: 31_000,
      },
    ]);
    // The push's run comes 5 s before its runners should be ready, by
    // the boot each slot was given, though boots measured since then run
    // longer.
    for (let i = 0; i < 20; i++) {
      planner.booted(L, 60_000, 8_000);
      planner.booted(L8, 60_000, 8_000);
    }
    const run = later(t + 100);
    planner.observe(L, find(run, 'build', 'JobAvailable').job, at + s(90));
    expect(steps(logs).at(-1)).toEqual({
      msg: 'cue taken',
      cue: -1,
      workflow,
      branch: 'main',
      run: 200,
      slots: 2,
      readyInMs: 5_000,
    });

    // A push before its cue's slots start: they never start, and a
    // runner boots from the push, 71 s by default.
    const early = make();
    const v = learnRuns(early.planner, [shape()]);
    early.planner.cue('acme/app', 'main', s(300), cueAt(v));
    const push = later(v + 100);
    early.planner.observe(
      L,
      find(push, 'build', 'JobAvailable').job,
      cueAt(v) + s(30),
    );
    expect(steps(early.logs)).toEqual([
      expect.objectContaining({ msg: 'cue taken', readyInMs: 71_000 }),
    ]);

    // Its last runner counts: lint's (71 s) started 26 s ago, build's
    // (31 s) not yet, so build's is ready in 31 s and lint's in 45.
    const mixed = make();
    const w = learnRuns(mixed.planner, [shape(31)]);
    mixed.planner.booted(L, 23_000, 8_000);
    mixed.planner.cue('acme/app', 'main', s(100), cueAt(w));
    mixed.planner.observe(
      L,
      find(later(w + 100), 'build', 'JobAvailable').job,
      cueAt(w) + s(50),
    );
    expect(steps(mixed.logs)).toEqual([
      expect.objectContaining({ msg: 'cue taken', readyInMs: 45_000 }),
    ]);

    const idle = make();
    const u = learnRuns(idle.planner, [shape()]);
    idle.planner.cue('acme/app', 'main', 0, cueAt(u));
    // Its runners (a 71 s boot) idle 180 s and expire; the next message
    // or cue sees it.
    idle.planner.cancel('acme/app', 'dev', cueAt(u) + s(300));
    expect(steps(idle.logs)).toEqual(
      [L, L8].map((label) => ({
        msg: 'cue slot expired',
        label,
        run: -1,
        workflow,
        branch: 'main',
        at: cueAt(u) + s(251),
      })),
    );
  });

  it("logs a kept cue slot's start once, and no expiry for one a cancel drops", () => {
    const steps = (logs: Record<string, unknown>[]) =>
      logs.filter((entry) => String(entry.msg).startsWith('cue '));
    const { planner, logs } = make();
    const t = learnRuns(planner, [shape(31)]);
    planner.booted(L, 23_000, 8_000);
    planner.booted(L8, 23_000, 8_000);
    const at = cueAt(t);
    planner.cue('acme/app', 'main', 0, at);
    planner.speculative(L, at);
    // A re-cue keeps both started slots; the push takes them under it.
    expect(planner.cue('acme/app', 'main', s(20), at + s(10)).kept).toBe(2);
    planner.speculative(L, at + s(11));
    planner.observe(
      L,
      find(later(t + 100), 'build', 'JobAvailable').job,
      at + s(20),
    );
    expect(steps(logs).map(({ msg, run, cue }) => ({ msg, run, cue }))).toEqual(
      [
        { msg: 'cue slot started', run: -1, cue: undefined },
        { msg: 'cue taken', run: 200, cue: -2 },
      ],
    );
    expect(steps(logs).at(-1)).toMatchObject({ slots: 2, readyInMs: 11_000 });

    const dropped = make();
    const u = learnRuns(dropped.planner, [shape()]);
    dropped.planner.cue('acme/app', 'main', 0, cueAt(u));
    dropped.planner.speculative(L, cueAt(u));
    dropped.planner.cancel('acme/app', 'main', cueAt(u) + s(10));
    dropped.planner.cancel('acme/app', 'main', cueAt(u) + s(400));
    expect(steps(dropped.logs).map(({ msg }) => msg)).toEqual([
      'cue slot started',
    ]);
  });

  it("keeps a cue's runners from another branch's run, and an unplanned one", () => {
    const { planner } = make();
    const t = learnRuns(planner, [shape(31)]);
    planner.cue('acme/app', 'main', 0, cueAt(t));
    // A run of the same workflow on dev takes none of them.
    const dev = later(t + 20, shape(1), 300, REF.replace('main', 'dev'));
    planner.observe(L, dev[0]!.job, s(t + 20));
    expect(planner.speculative(L, s(t + 20))).toBe(1);
    // A run heard of past its offer, first at a JobStarted, isn't planned
    // and spends nothing: the push's runners stay until they expire, 71 +
    // 180 s after the cue.
    const main = later(t + 20);
    planner.observe(L, find(main, 'build', 'JobStarted').job, s(t + 21));
    expect(planner.speculative(L, s(t + 21))).toBe(1);
    // The cue's lint, and dev's run's own.
    expect(planner.speculative(L8, s(t + 21))).toBe(2);
    expect(planner.speculative(L, cueAt(t) + s(251))).toBe(0);
  });

  it("times a cued run's later jobs by what's left of the trigger's boot", () => {
    // Tests queue 102 s after build starts; a boot is 71 s.
    const at = (cue: number, lead: number, push: number) => {
      const { planner } = make();
      const t = learnRuns(
        planner,
        Array.from({ length: 5 }, () => shape(31)),
      );
      planner.cue('acme/app', 'main', lead, s(t + cue));
      const list = later(t + push);
      const from = s(t + push);
      planner.observe(L, find(list, 'build', 'JobAvailable').job, from);
      planner.observe(L, find(list, 'build', 'JobAssigned').job, from);
      // When the tests' two slots start, from the push.
      for (let sec = 0; sec < 300; sec++) {
        if (planner.speculative(L, from + s(sec)) === 2) return sec;
      }
    };
    // A cue 10 s ahead: build's runner is up 61 s after the push.
    expect(at(0, 0, 10)).toBe(61 + 102 - 71);
    // One a boot ahead: it's up.
    expect(at(0, 0, 80)).toBe(102 - 71);
    // A push before the cue's slot started: build boots in full, as uncued.
    expect(at(0, s(300), 30)).toBe(71 + 102 - 71);
  });

  it("times a cued run's later jobs by what's left of the trigger's CUE_PERCENTILE boot, not the median", () => {
    const { planner } = make();
    // p95 is 40 s, giving a 48 s cue boot against a 33 s median.
    varyingBoots(planner, L);
    const t = learnRuns(
      planner,
      Array.from({ length: 5 }, () => shape(31)),
    );
    // Cued at once, the push 10 s later: what's left of the 48 s cue boot
    // is 38 s, not the median's 23 s.
    planner.cue('acme/app', 'main', 0, s(t));
    const list = later(t + 10);
    const from = s(t + 10);
    planner.observe(L, find(list, 'build', 'JobAvailable').job, from);
    planner.observe(L, find(list, 'build', 'JobAssigned').job, from);
    for (let sec = 0; sec < 300; sec++) {
      if (planner.speculative(L, from + s(sec)) === 2) {
        // The median would give 92 s (23 s left, less the 33 s T3
        // subtracts): using the cue's own percentile gives 107 s instead.
        expect(sec).toBe(107);
        return;
      }
    }
    throw new Error('never reached 2 speculative slots');
  });

  it("times a cued run's child by the slot's own frozen boot, not the label's boots as they stand once the trigger arrives", () => {
    // build (trigger, L) with a child on L8, 2 s after it ends, so only
    // L8's own boot (held fixed) feeds the final subtraction, isolating
    // what's tested: the cued trigger's own frozen boot against a fresh
    // recompute of L's boot, which the next lines move a lot.
    const childShape = (wait = 31) => [
      ...buildRun(0, 0, 100, wait),
      {
        name: 'followup',
        label: L8,
        q: wait + 100 + 2,
        start: wait + 100 + 80,
        end: wait + 100 + 200,
      },
    ];
    const { planner } = make();
    varyingBoots(planner, L); // p95: a 48 s cue boot, frozen onto the slot.
    planner.booted(L8, s(0), s(8)); // L8's own boot: a fixed 8 s.
    const t = learnRuns(
      planner,
      Array.from({ length: 5 }, () => childShape(31)),
    );
    planner.cue('acme/app', 'main', 0, s(t));
    // L's boots move a lot right after the cue, before the push: were the
    // slot's remaining wait re-read from these, it would be 160 s off.
    for (let i = 0; i < 20; i++) planner.booted(L, s(200), null);
    const list = events(
      200,
      childShape(1).map((j) => ({
        ...j,
        q: j.q + t + 10,
        start: j.start === null ? null : j.start + t + 10,
        end: j.end + t + 10,
      })),
    );
    const from = s(t + 10);
    planner.observe(L, find(list, 'build', 'JobAvailable').job, from);
    planner.observe(L, find(list, 'build', 'JobAssigned').job, from);
    for (let sec = 0; sec < 600; sec++) {
      if (planner.speculative(L8, from + s(sec)) === 1) {
        // Off the slot's frozen 48 s boot (38 s left of it, 10 s after the
        // cue): 132 s. Re-read from L's now-200+ s boot, it would be 292 s.
        expect(sec).toBe(132);
        return;
      }
    }
    throw new Error('never reached 1 speculative slot on L8');
  });

  it('spends no planned slot on the trigger when the cue has none on its label', () => {
    const max = (cued: boolean) => {
      const { planner } = make();
      const t = learnRuns(
        planner,
        Array.from({ length: 5 }, () => shape(31)),
      );
      // L8's cue slot outlives L's, which has expired by the push.
      planner.booted(L8, 192_000, 8_000);
      if (cued) planner.cue('acme/app', 'main', 0, s(t));
      const list = later(t + 150);
      const from = s(t + 150);
      planner.observe(L, find(list, 'build', 'JobAvailable').job, from);
      planner.observe(L, find(list, 'build', 'JobAssigned').job, from);
      let most = 0;
      for (let sec = 0; sec < 400; sec++) {
        most = Math.max(most, planner.speculative(L, from + s(sec)));
      }
      return most;
    };
    expect(max(false)).toBe(2);
    expect(max(true)).toBe(2);
  });

  it('reschedules a later cue for the same branch, never adding a second set', () => {
    const { planner } = make();
    const t = learnRuns(planner, [shape()]);
    const at = s(t);
    // Ready at +300 s, so each starts at +229 s.
    planner.cue('acme/app', 'main', s(300), at);
    // Later: dropped, and planned again from +429 s.
    expect(planner.cue('acme/app', 'main', s(490), at + s(10))).toEqual({
      added: 2,
      kept: 0,
      dropped: 2,
      capped: 0,
    });
    expect(planner.speculative(L, at + s(229))).toBe(0);
    expect(planner.speculative(L, at + s(429))).toBe(1);
    // Earlier: from +129 s.
    planner.cue('acme/app', 'main', s(190), at + s(10));
    expect(planner.speculative(L, at + s(129))).toBe(1);
    expect(planner.speculative(L8, at + s(429))).toBe(0);
    // Another branch's cue is its own.
    planner.cue('acme/app', 'dev', s(190), at + s(10));
    expect(planner.speculative(L, at + s(129))).toBe(1);
  });

  it('keeps runners already booting or ready, with their own expiry, so none idles longer', () => {
    const { planner } = make();
    const t = learnRuns(planner, [shape()]);
    const at = s(t);
    // Started at once: ready at +71 s, ending at +251 s.
    planner.cue('acme/app', 'main', 0, at);
    expect(planner.cue('acme/app', 'main', s(90), at + s(10))).toEqual({
      added: 0,
      kept: 2,
      dropped: 0,
      capped: 0,
    });
    // Moved past them, but still with over half of CUE_IDLE_MS (180 s) to
    // spare before +251 s: they stand for it, unmoved.
    expect(planner.cue('acme/app', 'main', s(130), at + s(20)).added).toBe(0);
    expect(planner.speculative(L, at + s(20))).toBe(1);
    // Moved far enough that less than 90 s of that is left: no longer
    // trusted to still be there when the push needs them, so a re-cue
    // replaces them instead — its own replacements end 180 s after their
    // own, later, boot.
    expect(planner.cue('acme/app', 'main', s(130), at + s(60))).toMatchObject({
      added: 2,
      kept: 0,
      dropped: 2,
    });
    expect(planner.speculative(L, at + s(60))).toBe(0);
    expect(planner.speculative(L, at + s(251))).toBe(1);
    // Moved so far past even that replacement's own margin that a further
    // one starts after it ends: it does.
    expect(planner.cue('acme/app', 'main', s(300), at + s(120))).toMatchObject({
      added: 2,
      kept: 0,
      dropped: 2,
    });
    expect(planner.speculative(L, at + s(251))).toBe(0);
    expect(planner.speculative(L, at + s(349))).toBe(1);
    // Once they've gone, a cue starts its own.
    expect(planner.cue('acme/app', 'main', s(130), at + s(650)).added).toBe(2);
  });

  it('stops cueing a key whose cue runners runs seldom take, probing every 5th cue', () => {
    const { planner } = make();
    const t = learnRuns(planner, [shape()]);
    let at = s(t);
    // Ten unused cues, each gap past the prior's 71 + 180 s expiry: 20
    // slots expire untaken.
    for (let i = 0; i < 10; i++, at += s(260)) {
      expect(planner.cue('acme/app', 'main', 0, at).added).toBe(2);
    }
    const started = Array.from(
      { length: 10 },
      (_, i) => planner.cue('acme/app', 'main', 0, at + s(260 * i)).added,
    );
    expect(started).toEqual([0, 0, 0, 0, 2, 0, 0, 0, 0, 2]);
  });

  it("leaves a guarded key's un-yielded probe slot alone on a reschedule, not dropped unscored", () => {
    const { planner } = make();
    const t = learnRuns(planner, [shape()]);
    let at = s(t);
    for (let i = 0; i < 10; i++, at += s(260)) {
      expect(planner.cue('acme/app', 'main', 0, at).added).toBe(2);
    }
    // The 5th subsequent cue is the guard's probe: it gets slots.
    for (let i = 0; i < 4; i++, at += s(260)) {
      expect(planner.cue('acme/app', 'main', 0, at).added).toBe(0);
    }
    at += s(260);
    expect(planner.cue('acme/app', 'main', 0, at).added).toBe(2);
    expect(planner.speculative(L, at)).toBe(1);
    // A reschedule right after, same branch: this key isn't the probe's
    // turn again, so cueKeys() skips it entirely. Its still-booting probe
    // slots are live candidates for the real push to take or expire on
    // their own, and must be left alone, not torn down as leftover.
    expect(planner.cue('acme/app', 'main', s(300), at + s(5))).toMatchObject({
      added: 0,
      kept: 0,
      dropped: 0,
    });
    expect(planner.speculative(L, at + s(5))).toBe(1);
    expect(planner.speculative(L8, at + s(5))).toBe(1);
  });

  it("leaves a guarded key's un-yielded probe slot alone even before it's started", () => {
    const { planner } = make();
    const t = learnRuns(planner, [shape()]);
    let at = s(t);
    for (let i = 0; i < 10; i++, at += s(260)) {
      expect(planner.cue('acme/app', 'main', 0, at).added).toBe(2);
    }
    for (let i = 0; i < 4; i++, at += s(260)) {
      expect(planner.cue('acme/app', 'main', 0, at).added).toBe(0);
    }
    at += s(260);
    // The probe, with a long lead: its slots aren't started yet (ready in
    // 600 s, well past the 71 s default boot).
    expect(planner.cue('acme/app', 'main', s(600), at).added).toBe(2);
    expect(planner.speculative(L, at + s(400))).toBe(0);
    // A reschedule moments later, same branch, not the probe's turn: the
    // old top-level filter dropped any not-yet-started slot for the
    // branch outright, any key, unscored. The probe's slots must survive
    // it and still start on schedule.
    expect(planner.cue('acme/app', 'main', 0, at + s(5))).toMatchObject({
      added: 0,
      kept: 0,
      dropped: 0,
    });
    expect(planner.speculative(L, at + s(523))).toBe(0);
    expect(planner.speculative(L, at + s(524))).toBe(1);
  });

  it("hands a run the rescheduled cue's runners, kept or new", () => {
    const { planner } = make();
    const t = learnRuns(
      planner,
      Array.from({ length: 5 }, () => shape(31)),
    );
    planner.cue('acme/app', 'main', 0, s(t + 10));
    planner.cue('acme/app', 'main', 0, s(t + 11));
    const now = s(t + 20);
    planner.observe(L, later(t + 20)[0]!.job, now);
    // The cue's build, which the trigger spends, and the tests.
    expect(planner.speculative(L, now + s(62 + 102 - 71))).toBe(3);
  });

  it("cancels the branch's cued runners, started or not", () => {
    const { planner } = make();
    let t = learnRuns(planner, [shape()]);
    // A run on dev too, so any branch cues.
    feed(planner, later(t, shape(), 90, REF.replace('main', 'dev')));
    t += 1000;
    const at = s(t);
    planner.cue('acme/app', 'main', 0, at);
    planner.cue('acme/app', 'dev', s(300), at);
    planner.cue('acme/other', 'main', 0, at);
    expect(planner.cancel('acme/app', 'dev', at + s(10))).toBe(2);
    // Past main's own cue's expiry too (71 + 180 s), so dev's cancelled
    // slots left nothing behind either.
    expect(planner.speculative(L, at + s(260))).toBe(0);
    expect(planner.speculative(L, at + s(10))).toBe(1);
    expect(planner.cancel('ACME/app', 'main', at + s(10))).toBe(2);
    expect(planner.speculative(L, at + s(10))).toBe(0);
    expect(planner.cancel('acme/app', 'main', at + s(10))).toBe(0);
    // A run's runners aren't a cue's any more.
    planner.cue('acme/app', 'main', 0, at + s(20));
    planner.observe(L, later(t + 30)[0]!.job, at + s(30));
    expect(planner.cancel('acme/app', 'main', at + s(30))).toBe(0);
    expect(planner.speculative(L8, at + s(30))).toBe(1);
  });

  it("starts the repo's pull_request workflows on any branch, and their run takes them", () => {
    const { planner } = make();
    const pr = (id: number, t0: number) =>
      events(
        id,
        shape().map((j) => ({
          ...j,
          q: j.q + t0,
          start: j.start === null ? null : j.start + t0,
          end: j.end + t0,
        })),
        'acme/app/.github/workflows/ci.yml@refs/pull/7/merge',
      ).map((e) => ({
        ...e,
        job: { ...e.job, eventName: 'pull_request' },
      }));
    feed(planner, pr(1, 0));
    const t = 1000;
    // The push key never ran on feature; the pull_request key has no
    // branches.
    expect(planner.cue('acme/app', 'feature', 0, s(t))).toMatchObject({
      added: 2,
    });
    // Its run spends the cue's build at its assignment.
    const run = pr(2, t + 20);
    planner.observe(L, run[0]!.job, s(t + 20));
    planner.observe(L, run[1]!.job, s(t + 20));
    expect(planner.speculative(L, s(t + 20))).toBe(0);
    expect(planner.speculative(L8, s(t + 20))).toBe(1);
    expect(planner.cancel('acme/app', 'feature', s(t + 20))).toBe(0);
    // On main, where the push key ran too: both keys' first waves.
    learnRuns(planner, [shape()], 3, t + 500);
    expect(planner.cue('acme/app', 'main', 0, s(t + 2000)).added).toBe(4);
  });

  it('drops a re-cue slot its label no longer wants, not just unstarted ones', () => {
    // A first wave of two parallel jobs on L (both queued at once, so
    // neither is the other's child): firstWave(L) starts at 2.
    const dual = (wait = 31): Spec[] => [
      { name: 'shardA', label: L, q: 0, start: wait, end: wait + 100 },
      { name: 'shardB', label: L, q: 0, start: wait, end: wait + 100 },
    ];
    const { planner } = make();
    const t = learnRuns(
      planner,
      Array.from({ length: 5 }, () => dual()),
    );
    const at = cueAt(t);
    // Two active slots on L.
    expect(planner.cue('acme/app', 'main', 0, at).added).toBe(2);
    expect(planner.speculative(L, at)).toBe(2);
    // On another branch, enough single-job runs pull the median from 2
    // down to 1, without touching main's cue.
    const other = REF.replace('main', 'other');
    for (let i = 0; i < 15; i++) {
      feed(planner, events(500 + i, dual(1).slice(0, 1), other));
    }
    // Re-cueing main now plans only 1 slot for L: the other must be
    // dropped, not left active and uncounted.
    expect(planner.cue('acme/app', 'main', 0, at + s(10))).toMatchObject({
      kept: 1,
      dropped: 1,
    });
    expect(planner.speculative(L, at + s(10))).toBe(1);
  });

  // A first wave of `n` matrix jobs on L, all queued at once.
  const matrix = (n: number): Spec[] =>
    Array.from({ length: n }, (_, i) => ({
      name: `shard (${i})`,
      q: 0,
      start: 31,
      end: 131,
    }));

  it('starts a matrix first wave in full, up to 64 untaken cue runners per org', () => {
    const { planner, logs } = make();
    const t = learnRuns(planner, [matrix(40)]);
    const at = cueAt(t);
    expect(planner.cue('acme/app', 'main', 0, at)).toEqual({
      added: 40,
      kept: 0,
      dropped: 0,
      capped: 0,
    });
    // Another repo's 40-wide wave gets the 24 the org has left.
    const web = 'acme/web/.github/workflows/ci.yml@refs/heads/main';
    const shifted = matrix(40).map((j) => ({
      ...j,
      q: t,
      start: t + 31,
      end: t + 131,
    }));
    feed(planner, events(900, shifted, web));
    const later = at + s(100);
    expect(planner.cue('acme/web', 'main', 0, later)).toMatchObject({
      added: 24,
      capped: 16,
    });
    expect(planner.speculative(L, later)).toBe(64);
    expect(logs).toContainEqual(
      expect.objectContaining({ msg: 'cue capped', repo: 'acme/web' }),
    );
  });

  it("frees a cue's runners from the cap once its run takes them", () => {
    const { planner } = make();
    const web = 'acme/web/.github/workflows/ci.yml@refs/heads/main';
    let t = learnRuns(planner, [matrix(70)]);
    feed(planner, events(900, matrix(70), web));
    const at = cueAt(t);
    expect(planner.cue('acme/app', 'main', 0, at).added).toBe(64);
    expect(planner.cue('acme/web', 'main', 0, at)).toMatchObject({
      added: 0,
      capped: 70,
    });
    // The push's run arrives: its trigger takes the cue's runners, before
    // any of its jobs is assigned, so another push's cue has the cap again.
    t = at / 1000 + 20;
    const run = events(
      901,
      matrix(70).map((j) => ({ ...j, q: t, start: t + 31, end: t + 131 })),
    );
    feed(planner, run.slice(0, 1));
    expect(planner.cue('acme/web', 'main', 0, s(t + 1)).added).toBe(64);
  });
});

describe('Planner.cue on a workflow mid-run', () => {
  // A PR's runs, as the listener hears them: each job assigned at its
  // `assignedMs` from `t0` (GitHub sends no queue time), none started yet.
  const ANY = 'anycloud-sh/anycloud';
  type Captured = {
    name: string;
    label: string;
    assignedMs: number;
    ref: string;
  };
  const assigned = (id: number, jobs: Captured[], t0: number, pull = 2348) =>
    jobs.map((job, i) => ({
      label: job.label,
      at: t0 + job.assignedMs,
      job: message('JobAssigned', {
        workflowRunId: id,
        jobId: `${id}-${i}`,
        jobDisplayName: job.name,
        jobWorkflowRef: `${ANY}/${job.ref.replace(/\/\d+\//, `/${pull}/`)}`,
        ownerName: 'anycloud-sh',
        repositoryName: 'anycloud',
        eventName: 'pull_request',
        scaleSetAssignTime: t0 + job.assignedMs,
        requestLabels: [job.label],
      }),
    }));
  const captured: { jobs: Captured[] } = JSON.parse(
    readFileSync(new URL('./cue-first-wave.json', import.meta.url), 'utf8'),
  );
  const labels = [
    'backmesh-ubuntu-2404-4vcpu',
    'backmesh-ubuntu-2404-8vcpu',
    'backmesh-ubuntu-2404-kvm-4vcpu',
    'backmesh-ubuntu-2404-kvm-16vcpu',
  ];
  const planner = (runBranch?: PlannerDeps['runBranch']) => {
    const logs: Record<string, unknown>[] = [];
    let clock = s(-3600);
    const p = new Planner({
      labels,
      runBranch,
      log: (entry) => void logs.push(entry),
      now: () => clock,
    });
    clock = 0;
    return Object.assign(p, { logs });
  };
  const feedRun = (
    p: Planner,
    id: number,
    jobs: Captured[],
    t0: number,
    pull?: number,
  ) => {
    for (const { label, at, job } of assigned(id, jobs, t0, pull)) {
      p.observe(label, job, at);
    }
  };
  const wave = (p: Planner, at: number, branch = 'feature') => {
    p.cue(ANY, branch, s(300), at);
    return labels.map((l) => p.speculative(l, at + s(300)));
  };
  const style = (name = 'style') => [
    {
      name,
      label: 'backmesh-ubuntu-2404-4vcpu',
      assignedMs: 0,
      ref: `.github/workflows/${name}.yml@refs/pull/2348/merge`,
    },
  ];

  it("reproduces the dogfood's one slot, and starts the first wave 30 s after a run's first job", () => {
    const p = planner();
    // Before: Mutant Survivors' one-job first wave was the only one learned
    // (its 05:13Z run), and Integration was learned only once completed,
    // over 20 minutes on, so a cue added one runner.
    const mutants = events(
      1,
      [
        { name: 'mutate', q: 0, start: 10, end: 60 },
        { name: 'report', q: 62, start: 70, end: 80 },
      ],
      `${ANY}/.github/workflows/mutant-survivors.yml@refs/pull/2300/merge`,
    ).map((e) => ({ ...e, job: { ...e.job, eventName: 'pull_request' } }));
    feed(p, mutants);
    // Integration's first run on backmesh labels: 43, 2, 7 and 1 jobs,
    // assigned within 0.75 s (diagnose run 42569076049).
    const t0 = s(1000);
    feedRun(p, 2, captured.jobs, t0);
    expect(p.cue(ANY, 'feature', s(300), t0 + s(29)).added).toBe(1);
    expect(wave(p, t0 + s(31))).toEqual([44, 2, 7, 1]);
  });

  it("looks up a PR's branch once for all its workflows, and starts them only for that branch", async () => {
    const asked: number[] = [];
    const p = planner(async (owner, repo, runId) => {
      asked.push(runId);
      expect([owner, repo]).toEqual(['anycloud-sh', 'anycloud']);
      return 'feature';
    });
    // One push starts style and integration at once: one lookup.
    feedRun(p, 1, style(), 0);
    feedRun(p, 2, captured.jobs.slice(0, 3), s(1));
    await flush();
    expect(asked).toEqual([1]);
    expect(wave(p, s(60), 'main')).toEqual([0, 0, 0, 0]);
    expect(wave(p, s(60))[0]).toBe(4);
  });

  it("records no branch for a fork's PR, and asks again after a failure", async () => {
    let fail = true;
    const asked: number[] = [];
    const p = planner(async (_owner, _repo, runId) => {
      asked.push(runId);
      if (fail) throw new Error('503');
      return undefined; // a fork's head
    });
    feedRun(p, 1, style(), 0);
    await flush();
    expect(p.logs).toContainEqual(
      expect.objectContaining({ msg: 'planner PR branch lookup failed' }),
    );
    fail = false;
    feedRun(p, 2, style(), s(100));
    feedRun(p, 3, style(), s(200));
    await flush();
    expect(asked).toEqual([1, 2]);
    // With no branch to go on, it starts on every cue, as before lookups.
    expect(wave(p, s(300), 'main')[0]).toBe(1);
  });

  it("hands a pull_request run its PR's branch's cue, not another branch's", async () => {
    const p = planner(async (_o, _r, runId) =>
      runId === 1 ? 'feature' : 'other',
    );
    feedRun(p, 1, style(), 0, 2348);
    feedRun(p, 2, style(), s(1), 2349);
    await flush();
    const at = s(100);
    // feature's cue is the older: a run that took the newest would take
    // other's.
    p.cue(ANY, 'feature', s(90), at);
    p.cue(ANY, 'other', s(90), at);
    feedRun(p, 3, style(), at + s(20), 2348);
    expect(p.cancel(ANY, 'feature', at + s(20))).toBe(0);
    expect(p.cancel(ANY, 'other', at + s(20))).toBe(1);
  });

  it("hands a fork's PR run no branch's cue", async () => {
    const p = planner(async (_o, _r, runId) =>
      runId === 1 ? 'feature' : undefined,
    );
    feedRun(p, 1, style(), 0, 2348);
    feedRun(p, 2, style(), s(1), 2349);
    await flush();
    const at = s(100);
    p.cue(ANY, 'feature', s(90), at);
    // PR 2349 is a fork's: its run leaves feature's runner to feature.
    feedRun(p, 3, style(), at + s(20), 2349);
    expect(p.cancel(ANY, 'feature', at + s(20))).toBe(1);
  });

  it('starts a wave learned from history, every queued job once, however often it backfills', async () => {
    // Integration's past runs: each first wave of 3 queued together and
    // cancelled before any started, so the backfill learns no steps and
    // runs again at the next run.
    const queued = Date.parse('2026-11-09T05:00:00Z');
    const history = vi.fn(async () =>
      [98, 99].map((id) => ({
        id,
        jobs: [0, 1, 2].map((i) => ({
          name: `it (${i})`,
          labels: ['backmesh-ubuntu-2404-4vcpu'],
          conclusion: 'cancelled',
          queuedAt: queued + i,
          startedAt: null,
          finishedAt: null,
        })),
      })),
    );
    let clock = s(-3600);
    const p = new Planner({
      labels,
      history,
      log: () => undefined,
      now: () => clock,
    });
    clock = 0;
    const one = captured.jobs.slice(0, 1);
    for (const [id, t0] of [
      [1, 0],
      [2, s(10)],
    ] as const) {
      feedRun(p, id, one, t0);
      await flush();
    }
    expect(history).toHaveBeenCalledTimes(2);
    // Waves of 3, 3, 1 and 1: a median of 2. Counting only started jobs
    // gives 1; adding the past runs again at the second backfill gives 3.
    expect(wave(p, s(60))[0]).toBe(2);
  });

  it("lets the CLI's PR flag decide whether pull_request workflows start", async () => {
    const p = planner(async (_o, _r, runId) =>
      runId === 1 ? 'feature' : 'other-pr',
    );
    // style ran for feature's PR, docs for another branch's PR.
    feedRun(p, 1, style(), 0, 2348);
    feedRun(p, 2, style('docs'), s(1), 2349);
    // ci runs on push, on main and dev: so for any branch.
    for (const [id, branch] of [
      [3, 'main'],
      [4, 'dev'],
    ] as const) {
      p.observe(
        'backmesh-ubuntu-2404-8vcpu',
        message('JobAssigned', {
          workflowRunId: id,
          jobId: `${id}-0`,
          jobDisplayName: 'ci',
          jobWorkflowRef: `${ANY}/.github/workflows/ci.yml@refs/heads/${branch}`,
          eventName: 'push',
          scaleSetAssignTime: s(id),
          requestLabels: ['backmesh-ubuntu-2404-8vcpu'],
        }),
        s(id),
      );
    }
    await flush();
    const start = (branch: string, pr: 'y' | 'n' | '?', at: number) => {
      p.cue(ANY, branch, s(300), at, pr);
      return labels.map((l) => p.speculative(l, at + s(300)));
    };
    // ?: the unknown-branch rule, by the branches PR runs were for.
    expect(start('x', '?', s(100))).toEqual([0, 1, 0, 0]);
    expect(start('feature', '?', s(1000))).toEqual([1, 1, 0, 0]);
    // y: every pull_request workflow for a branch none has run for, and
    // those that ran for it when one has.
    expect(start('x', 'y', s(2000))).toEqual([2, 1, 0, 0]);
    expect(start('feature', 'y', s(3000))).toEqual([1, 1, 0, 0]);
    // n: push workflows only.
    expect(start('feature', 'n', s(4000))).toEqual([0, 1, 0, 0]);
  });
});

// Owner, 2026-11-13: the first cue after a restart, for a repo the planner
// has learned nothing of, backfills its workflows and is planned again.
describe('Planner.cue after a restart', () => {
  const past = (branch?: string) =>
    [1, 2].map((id) => ({
      id,
      ...(branch && { branch }),
      jobs: [
        job('build', [L], 0, 31, 131),
        job('lint', [L8], 0, 31, 51),
        job('other', ['ubuntu-latest'], 0, 5, 20),
      ],
    }));
  const hosted = [
    { id: 9, jobs: [job('deploy', ['ubuntu-latest'], 0, 5, 20)] },
  ];
  const restarted = (lead = s(100)) => {
    let clock = 0;
    const refs: string[] = [];
    const reads: string[] = [];
    const replanned = vi.fn();
    const logs: Record<string, unknown>[] = [];
    const planner = new Planner({
      labels: [L, L8],
      // The repo's push workflow ran on main; nothing on pull_request.
      // Each backfill uses the 21 calls it reserved; hosted.yml's jobs run
      // on GitHub's runners, so asked, its read stops at its newest run.
      history: async (ref, _count, take, uses) => {
        refs.push(`${ref.owner}/${ref.repo} ${ref.workflow} ${ref.event}`);
        if (ref.workflow.startsWith('hosted')) {
          take();
          take();
          return uses?.(hosted[0]!.jobs) === false ? [] : hosted;
        }
        for (let i = 0; i < 21; i++) if (!take()) return [];
        return ref.event === 'push' ? past('main') : [];
      },
      workflows: async (owner, repo) => (
        reads.push(`${owner}/${repo}`),
        // As GitHub spells them.
        {
          owner: 'Acme',
          repo: repo === 'app' ? 'App' : repo,
          files:
            repo === 'mixed'
              ? ['hosted.yml', 'ci.yml']
              : repo === 'hosted'
                ? ['hosted.yml']
                : repo === 'many'
                  ? [
                      ...Array.from({ length: 9 }, (_, i) => `hosted${i}.yml`),
                      'ci.yml',
                    ]
                  : ['ci.yml'],
        }
      ),
      replanned,
      log: (entry) => void logs.push(entry),
      now: () => clock,
    });
    const at = s(10);
    clock = at;
    return {
      planner,
      refs,
      reads,
      replanned,
      logs,
      at,
      lead,
      tick: (ms: number) => (clock += ms),
      calls: () => (planner as unknown as { calls: number[] }).calls.length,
    };
  };

  it("backfills the repo's push and pull_request workflows, then plans the cue", async () => {
    const env = restarted();
    expect(env.planner.cue('acme/app', 'main', env.lead, env.at).added).toBe(0);
    await flush();
    expect(env.reads).toEqual(['acme/app']);
    expect(env.refs.sort()).toEqual([
      'Acme/App ci.yml pull_request',
      'Acme/App ci.yml push',
    ]);
    expect(env.replanned).toHaveBeenCalledTimes(1);
    expect(env.logs).toContainEqual(
      expect.objectContaining({ msg: 'cue slots after backfill', added: 2 }),
    );
    // build and lint, ready at the push.
    const ready = env.at + env.lead;
    expect(env.planner.speculative(L, ready, true)).toBe(1);
    expect(env.planner.speculative(L8, ready, true)).toBe(1);
    // The keys stay, the push one learned: the repo's next cue reads
    // nothing.
    expect(env.planner.status().keys).toBe(1);
    env.planner.cue('acme/app', 'main', env.lead, env.at);
    await flush();
    expect(env.reads).toHaveLength(1);
  });

  it("doesn't plan a cue whose push came before the backfill answered", async () => {
    const env = restarted(s(30));
    env.planner.cue('acme/app', 'main', env.lead, env.at);
    env.tick(s(30));
    await flush();
    expect(env.refs).toHaveLength(2);
    expect(env.replanned).not.toHaveBeenCalled();
    expect(env.planner.speculative(L, env.at + s(30), true)).toBe(0);
  });

  it("stays within the hour's W2 budget, and a cue whose keys didn't fit tries again", async () => {
    const env = restarted();
    for (let i = 0; i < 14; i++) {
      env.planner.cue(`acme/r${i}`, 'main', env.lead, env.at);
    }
    await flush();
    expect(env.reads).toHaveLength(14);
    expect(env.calls()).toBeLessThanOrEqual(300);
    const keys = (env.planner as unknown as { keys: Map<string, unknown> })
      .keys;
    const missing = Array.from({ length: 14 }, (_, i) => `r${i}`).filter(
      (r) => ![...keys.keys()].some((k) => k.startsWith(`Acme/${r}/`)),
    );
    expect(missing.length).toBeGreaterThan(0);
    // Cut short, it isn't read again for 10 minutes.
    const reads = env.reads.length;
    env.planner.cue(`acme/${missing[0]}`, 'main', env.lead, env.at + s(599));
    await flush();
    expect(env.reads).toHaveLength(reads);
    // An hour on, such a repo's cue reads it again.
    env.tick(3_600_000);
    env.planner.cue(`acme/${missing[0]}`, 'main', env.lead, env.at + 3_600_000);
    await flush();
    expect(env.reads.at(-1)).toBe(`acme/${missing[0]}`);
    expect(env.refs.at(-1)).toMatch(new RegExp(`^Acme/${missing[0]} ci\\.yml`));
  });

  it("probes past a repo's first workflows to one that uses the labels", async () => {
    const env = restarted();
    env.planner.cue('acme/many', 'main', env.lead, env.at);
    await flush();
    expect(env.refs).toHaveLength(2 * 10);
    expect(env.replanned).toHaveBeenCalledTimes(1);
    expect(env.planner.speculative(L, env.at + env.lead, true)).toBe(1);
  });

  it('stops at a workflow whose newest run used no backmesh label, and keeps no key for it', async () => {
    const env = restarted();
    env.planner.cue('acme/mixed', 'main', env.lead, env.at);
    await flush();
    expect(env.refs.sort()).toEqual([
      'Acme/mixed ci.yml pull_request',
      'Acme/mixed ci.yml push',
      'Acme/mixed hosted.yml pull_request',
      'Acme/mixed hosted.yml push',
    ]);
    // The list, ci.yml's 2 × 21, and hosted.yml's 2 reads of 2: the other
    // 19 of each were refunded.
    expect(env.calls()).toBe(1 + 2 * 21 + 2 * 2);
    expect(env.replanned).toHaveBeenCalledTimes(1);
    // Only ci.yml's push key stays; the repo's next cue reads nothing.
    expect(env.planner.status().keys).toBe(1);
    env.planner.cue('acme/mixed', 'main', env.lead, env.at);
    await flush();
    expect(env.reads).toHaveLength(1);
  });

  it("plans each branch's latest cue once the backfill answers, and none cancelled meanwhile", async () => {
    const env = restarted();
    env.planner.cue('acme/app', 'main', s(60), env.at);
    env.planner.cue('acme/app', 'main', env.lead, env.at);
    env.planner.cue('acme/app', 'dev', env.lead, env.at);
    expect(env.planner.cancel('acme/app', 'dev', env.at)).toBe(0);
    await flush();
    expect(env.reads).toHaveLength(1);
    expect(
      env.logs.filter((l) => l.msg === 'cue slots after backfill'),
    ).toEqual([expect.objectContaining({ added: 2 })]);
    // main's later push time: ready at +100 s, not +60 s.
    const ready = env.at + env.lead;
    expect(env.planner.speculative(L, ready, true)).toBe(1);
    expect(env.planner.cancel('acme/app', 'main', ready)).toBe(2);
  });

  it("doesn't take an older run's later job for a trigger, once the key has learned what starts its runs", async () => {
    const env = restarted();
    env.planner.cue('acme/app', 'main', env.lead, env.at);
    await flush();
    const ref = 'Acme/App/.github/workflows/ci.yml@refs/heads/main';
    const assigned = (runId: number, name: string, label: string) =>
      message('JobAssigned', {
        workflowRunId: runId,
        jobId: `${runId}-${name}`,
        jobDisplayName: name,
        jobWorkflowRef: ref,
        queueTime: env.at + s(20),
        requestLabels: [label],
      });
    // Run 50 began before the restart: its tests job, queued after it,
    // isn't one that starts a run, so it takes none of main's cue slots.
    env.planner.observe(L, assigned(50, 'test (0)', L), env.at + s(20));
    expect(env.planner.cancel('acme/app', 'main', env.at + s(20))).toBe(2);
    // A new run's build is.
    env.planner.cue('acme/app', 'main', env.lead, env.at + s(30));
    env.planner.observe(L, assigned(51, 'build', L), env.at + s(40));
    expect(env.planner.cancel('acme/app', 'main', env.at + s(40))).toBe(0);
  });

  it("keeps a key a run was heard on during its backfill, and none for a called workflow's jobs", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const planner = new Planner({
      labels: [L],
      // ci.yml's runs ran on hosted runners until now; caller.yml's
      // backmesh jobs are a called workflow's, named `<caller> / <called>`.
      history: async (ref, _count, take, uses) => {
        take();
        take();
        const jobs =
          ref.workflow === 'caller.yml'
            ? [job('build / test', [L], 0, 5, 20)]
            : [job('deploy', ['ubuntu-latest'], 0, 5, 20)];
        await gate;
        return uses?.(jobs) === false ? [] : [{ id: 1, jobs }];
      },
      workflows: async () => ({
        owner: 'acme',
        repo: 'app',
        files: ['ci.yml', 'caller.yml'],
      }),
      log: () => undefined,
      now: () => 0,
    });
    planner.cue('acme/app', 'main', s(100), 0);
    await flush();
    // ci.yml's first backmesh run starts meanwhile.
    feed(planner, events(5, buildRun(1, 1)).slice(0, 2));
    release();
    await flush();
    const keys = [
      ...(planner as unknown as { keys: Map<string, unknown> }).keys.keys(),
    ];
    expect(keys).toEqual(['acme/app/.github/workflows/ci.yml push']);
  });

  it('reads a repo whose workflows use none of the labels again only an hour later', async () => {
    const env = restarted();
    env.planner.cue('acme/hosted', 'main', env.lead, env.at);
    await flush();
    expect(env.reads).toEqual(['acme/hosted']);
    expect(env.refs).toHaveLength(2);
    env.planner.cue('acme/hosted', 'main', env.lead, env.at + s(60));
    await flush();
    expect(env.reads).toHaveLength(1);
    env.tick(3_600_000);
    env.planner.cue('acme/hosted', 'main', env.lead, env.at + 3_600_000);
    await flush();
    expect(env.reads).toHaveLength(2);
  });

  it("doesn't plan a branch again once its push's run arrived during the backfill", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const replanned = vi.fn();
    const planner = new Planner({
      labels: [L, L8],
      history: async (ref, _count, take) => {
        take();
        await gate;
        return ref.event === 'push'
          ? [
              {
                id: 1,
                branch: 'dev',
                jobs: [job('build', [L], -100, -90, -50)],
              },
            ]
          : [];
      },
      workflows: async () => ({
        owner: 'acme',
        repo: 'app',
        files: ['ci.yml'],
      }),
      replanned,
      log: () => undefined,
      now: () => 0,
    });
    planner.cue('acme/app', 'main', s(300), 0);
    planner.cue('acme/app', 'dev', s(300), 0);
    await flush();
    // main's push came early: its run is heard before the backfill answers.
    feed(planner, events(5, buildRun(1, 1)).slice(0, 2));
    release();
    await flush();
    expect(planner.speculative(L, s(300), true)).toBe(1);
    expect(planner.cancel('acme/app', 'main', 0)).toBe(0);
    expect(planner.cancel('acme/app', 'dev', 0)).toBe(1);
  });

  it('makes no probe key that would evict a learned one, nor reads for one', async () => {
    const workflows = vi.fn(async () => ({
      owner: 'acme',
      repo: 'cold',
      files: ['ci.yml'],
    }));
    const planner = new Planner({
      labels: [L],
      history: async () => [],
      workflows,
      log: () => undefined,
      now: () => 0,
    });
    // 200 keys (MAX_KEYS), the first heard first.
    for (let i = 0; i < 200; i++) {
      feed(
        planner,
        events(
          i + 1,
          buildRun(0, 1),
          `acme/w${i}/.github/workflows/ci.yml@refs/heads/main`,
        ).slice(0, 1),
      );
    }
    const keys = (planner as unknown as { keys: Map<string, unknown> }).keys;
    expect(keys.size).toBe(200);
    planner.cue('acme/cold', 'main', s(100), 0);
    await flush();
    expect(keys.size).toBe(200);
    expect(keys.has('acme/w0/.github/workflows/ci.yml push')).toBe(true);
    expect(workflows).not.toHaveBeenCalled();
  });

  it("doesn't plan a PR's branch again once its run arrived, when the branch is looked up after", async () => {
    let releaseHistory = () => {};
    const history = new Promise<void>((r) => (releaseHistory = r));
    let releaseBranch = () => {};
    const looked = new Promise<void>((r) => (releaseBranch = r));
    const planner = new Planner({
      labels: [L],
      history: async (ref, _count, take) => {
        take();
        await history;
        return ref.event === 'pull_request'
          ? [
              {
                id: 1,
                branch: 'feature',
                jobs: [job('style', [L], -100, -90, -50)],
              },
            ]
          : [];
      },
      runBranch: async () => (await looked, 'feature'),
      workflows: async () => ({
        owner: 'acme',
        repo: 'app',
        files: ['style.yml'],
      }),
      log: () => undefined,
      now: () => 0,
    });
    planner.cue('acme/app', 'feature', s(300), 0, 'y');
    await flush();
    // The PR's run comes first; its branch is looked up after.
    planner.observe(
      L,
      message('JobAssigned', {
        workflowRunId: 9,
        jobId: '9-0',
        jobDisplayName: 'style',
        jobWorkflowRef:
          'acme/app/.github/workflows/style.yml@refs/pull/7/merge',
        eventName: 'pull_request',
        queueTime: s(1),
        requestLabels: [L],
      }),
      s(1),
    );
    releaseBranch();
    await flush();
    releaseHistory();
    await flush();
    expect(planner.cancel('acme/app', 'feature', s(2))).toBe(0);
  });
});
