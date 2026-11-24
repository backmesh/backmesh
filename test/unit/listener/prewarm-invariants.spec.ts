import { describe, expect, it } from 'vitest';

import type { JobMessage } from '../../../src/github/types.js';
import { Planner, type PlannerDeps } from '../../../src/listener/prewarm.js';
import { message } from './fakes.js';

// A property test for the cue guard's invariants (documented above `Key`
// in src/listener/prewarm.ts, right next to cueScored/cueTaken). Rounds
// 7, 9 and 10 of its review, and an independent review after that, each
// broke one of them a different way — all in cue()'s slot-lifecycle
// bookkeeping — so instead of patching that case by case again, this
// drives randomized sequences of cue, cancel and a run taking a cue's
// slot (sometimes through to a failed completion) across a few push and
// pull_request keys and branches, and checks the invariants after every
// single step. No new dependency: a small seeded PRNG stands in for
// fast-check, which isn't in this repo.

// mulberry32: deterministic per seed, so a failure reproduces exactly
// from the seed and step index printed in its message.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(rng: () => number, xs: readonly T[]): T =>
  xs[Math.floor(rng() * xs.length)]!;
const s = (seconds: number) => seconds * 1000;
const flush = () => new Promise((resolve) => setImmediate(resolve));

const REPO = 'acme/app';
const BRANCHES = ['main', 'dev', 'feature'] as const;
// Two push keys (workflow files), each with its own label, so a cue's
// slot and a take are unambiguous.
const KEYS = [
  { file: 'ci.yml', label: 'backmesh-ubuntu-2404-4vcpu' },
  { file: 'deploy.yml', label: 'backmesh-ubuntu-2404-8vcpu' },
] as const;
const refFor = (file: string, branch: string) =>
  `${REPO}/.github/workflows/${file}@refs/heads/${branch}`;

type Slots = ReturnType<Planner['debugSlots']>;
type Guard = ReturnType<Planner['debugCueGuard']>;

function setup(runBranch?: PlannerDeps['runBranch']) {
  let now = 0;
  const planner = new Planner({
    labels: KEYS.map((k) => k.label),
    log: () => undefined,
    runBranch,
    // Started 2 h before the first learning event, well past WARMUP_MS,
    // so every run below is "fresh" and learned.
    now: () => now - 2 * 3600_000,
  });
  let runId = 1;
  // Learn each push key on each branch once, so cueKeys() considers all
  // of them (`ran`) from the start.
  for (const key of KEYS) {
    for (const branch of BRANCHES) {
      const id = runId++;
      const fields: Partial<JobMessage> = {
        workflowRunId: id,
        jobId: `${id}-0`,
        jobDisplayName: 'build',
        jobWorkflowRef: refFor(key.file, branch),
        queueTime: now,
        requestLabels: [key.label],
      };
      planner.observe(key.label, message('JobAvailable', fields), now);
      planner.observe(key.label, message('JobAssigned', fields), now);
      planner.observe(
        key.label,
        message('JobStarted', { ...fields, runnerAssignTime: now + 1000 }),
        now + 1000,
      );
      planner.observe(
        key.label,
        message('JobCompleted', {
          ...fields,
          finishTime: now + 2000,
          result: 'Succeeded',
        }),
        now + 2000,
      );
      now += 3000;
    }
  }
  // Past WAVE_MS (30 s) and SETTLE_MS (2 min) for every run above: the
  // next call below learns all their waves at once.
  now += 31 * 60_000;
  return {
    planner,
    now: () => now,
    advance: (ms: number) => (now += ms),
    nextRunId: () => runId++,
  };
}

// Two further keys the random test's own steps never target directly, so
// cueKeys() keeps leaving them alone (debugProbeSkipped) for the rest of
// the run: this plants one cue slot for each while it's still a live
// candidate, which every later random 'cue' step on their branch must
// then keep untouched, exercising invariant 3's other two reasons without
// needing to synthesize them mid-stream.
const GUARD_KEY = { file: 'flaky.yml', label: 'backmesh-ubuntu-2404-4vcpu' };
const REVIEW_KEY = { file: 'review.yml', label: 'backmesh-ubuntu-2404-16vcpu' };
const GUARD_KEY_NAME = `${REPO}/.github/workflows/${GUARD_KEY.file} push`;
const REVIEW_KEY_NAME = `${REPO}/.github/workflows/${REVIEW_KEY.file} pull_request`;

async function seedLeftAloneKeys(
  planner: Planner,
  now: () => number,
  advance: (ms: number) => void,
  nextRunId: () => number,
) {
  // The pull_request key: learned only via a PR whose head branch resolves
  // to 'dev' (the planner's `runBranch` dep below), so `ran('dev')` is
  // true but no other branch is known at all — exactly what makes
  // pr='?' (every random 'cue' step uses it) uncertain, not a definite
  // mismatch, for 'main' and 'feature'.
  const prId = nextRunId();
  const reviewFields: Partial<JobMessage> = {
    workflowRunId: prId,
    jobId: `${prId}-0`,
    jobDisplayName: 'review',
    jobWorkflowRef: `${REPO}/.github/workflows/${REVIEW_KEY.file}@refs/pull/9/merge`,
    eventName: 'pull_request',
    queueTime: now(),
    requestLabels: [REVIEW_KEY.label],
  };
  planner.observe(
    REVIEW_KEY.label,
    message('JobAvailable', reviewFields),
    now(),
  );
  planner.observe(
    REVIEW_KEY.label,
    message('JobAssigned', reviewFields),
    now(),
  );
  await flush(); // resolves the PR's head branch
  advance(2000);
  planner.observe(
    REVIEW_KEY.label,
    message('JobStarted', { ...reviewFields, runnerAssignTime: now() }),
    now(),
  );
  advance(2000);
  planner.observe(
    REVIEW_KEY.label,
    message('JobCompleted', {
      ...reviewFields,
      finishTime: now(),
      result: 'Succeeded',
    }),
    now(),
  );
  advance(130_000);

  // The precision-guarded key: a run with 4 real children seeds the
  // pattern T2 then predicts from, then enough runs that under-deliver
  // against it to cross GUARD_MIN_PREDICTED at well under GUARD_PRECISION
  // (same shape as prewarm.spec.ts's own guard test, without backfill). A
  // cue slot planted on 'main' while it's still unguarded is the one
  // every later random 'cue' step on 'main' must then leave alone.
  const round = (tests: number) => {
    const id = nextRunId();
    const build: Partial<JobMessage> = {
      workflowRunId: id,
      jobId: `${id}-build`,
      jobDisplayName: 'build',
      jobWorkflowRef: refFor(GUARD_KEY.file, 'main'),
      queueTime: now(),
      requestLabels: [GUARD_KEY.label],
    };
    planner.observe(GUARD_KEY.label, message('JobAvailable', build), now());
    planner.observe(GUARD_KEY.label, message('JobAssigned', build), now());
    advance(1000);
    planner.observe(
      GUARD_KEY.label,
      message('JobStarted', { ...build, runnerAssignTime: now() }),
      now(),
    );
    advance(2000);
    planner.observe(
      GUARD_KEY.label,
      message('JobCompleted', {
        ...build,
        finishTime: now(),
        result: 'Succeeded',
      }),
      now(),
    );
    for (let i = 0; i < tests; i++) {
      advance(2000);
      const test: Partial<JobMessage> = {
        workflowRunId: id,
        jobId: `${id}-test-${i}`,
        jobDisplayName: `test (${i})`,
        jobWorkflowRef: refFor(GUARD_KEY.file, 'main'),
        queueTime: now(),
        requestLabels: [GUARD_KEY.label],
      };
      planner.observe(GUARD_KEY.label, message('JobAvailable', test), now());
      planner.observe(GUARD_KEY.label, message('JobAssigned', test), now());
      advance(80_000);
      planner.observe(
        GUARD_KEY.label,
        message('JobStarted', { ...test, runnerAssignTime: now() }),
        now(),
      );
      advance(120_000);
      planner.observe(
        GUARD_KEY.label,
        message('JobCompleted', {
          ...test,
          finishTime: now(),
          result: 'Succeeded',
        }),
        now(),
      );
    }
    advance(130_000); // past SETTLE_MS: settles this round before the next
  };
  round(4);
  planner.cue(REPO, 'main', s(3600), now(), '?');
  // 10 further single-test runs pull the learned pattern's median down
  // from 4 to 1 (still matching every prediction, so the ratio itself
  // stays near 1.0); switching to zero-test runs after that undercuts a
  // median that's no longer high enough to absorb a few more misses
  // before it also falls, crossing GUARD_PRECISION while predicted is
  // already past GUARD_MIN_PREDICTED (empirically round 15 of 60, here
  // bounded generously since the exact round depends on medianInt's
  // tie-breaking, not asserted directly).
  for (let i = 0; i < 10; i++) round(1);
  for (let i = 0; i < 40 && planner.status().guarded === 0; i++) round(0);
}

// Every key-bearing slot that stopped being one (removed from the
// planner, or had its key taken away) must be matched by exactly that
// many more cueScored misses or hits for its key, less however many were
// a re-cue's own replacement for the same key and label (`replacedByKey`,
// from `cue()`'s return and a before/after diff: its continuation, not an
// independent miss) — except a slot cancel() itself removed, still live
// (not already naturally expired) right before it ran, the one
// deliberate exception: the user said cancel, not "this went unused," so
// settle()'s ordinary expiry scoring on anything else this same step
// still applies in full.
function checkInvariants(
  before: Slots,
  guardBefore: Guard,
  after: Slots,
  guardAfter: Guard,
  cancelledByThisStep: readonly Slots[number][],
  replacedByKey: ReadonlyMap<string, number>,
  ctx: string,
) {
  expect(before.length, ctx).toBeGreaterThanOrEqual(0); // never throws
  // `after`'s entry for a slot still present, by its stable `ref`, else
  // undefined (removed). Its `key` is this step's own current value,
  // captured fresh by debugSlots(), not a live read of a field cue()
  // may since have mutated in place.
  const afterByRef = new Map(after.map((slot) => [slot.ref, slot]));
  const cancelled = new Set(cancelledByThisStep.map((slot) => slot.ref));
  const keys = new Set([...guardBefore.keys(), ...guardAfter.keys()]);
  for (const key of keys) {
    // A key MAX_KEYS evicted mid-step is gone from guardAfter entirely
    // (not merely reset to 0,0): that's not a scoring event, so it's
    // exempt from every check below but cueTaken <= cueScored, which an
    // evicted key trivially satisfies by no longer existing.
    const evicted = guardBefore.has(key) && !guardAfter.has(key);
    const gBefore = guardBefore.get(key) ?? { cueScored: 0, cueTaken: 0 };
    const gAfter = guardAfter.get(key) ?? { cueScored: 0, cueTaken: 0 };
    expect(gAfter.cueTaken, `${ctx} cueTaken<=cueScored`).toBeLessThanOrEqual(
      gAfter.cueScored,
    );
    if (evicted) continue;
    expect(
      gAfter.cueScored,
      `${ctx} cueScored never decreases`,
    ).toBeGreaterThanOrEqual(gBefore.cueScored);
    const stopped = before.filter((slot) => {
      if (slot.key !== key || cancelled.has(slot.ref)) return false;
      const still = afterByRef.get(slot.ref);
      return !still || still.key !== key;
    });
    const replaced = replacedByKey.get(key) ?? 0;
    expect(
      stopped.length - replaced,
      `${ctx} key ${key}: scored = stopped - replaced`,
    ).toBe(gAfter.cueScored - gBefore.cueScored);
  }
}

// How many of `before`'s stopped slots a 'cue' step replaced outright: a
// fresh slot for the exact same key and label that appeared in `after`
// but wasn't in `before`, up to one per not-yet-started stopped slot of
// that pair (round 7's shrunk-count case can still leave an excess
// unreplaced, which this correctly doesn't count). A slot already due to
// expire by `stepNow` (settle() would remove and score it regardless of
// anything cue() does) is never eligible: only one still live when the
// step started is cue()'s own to replace. Nor is one already running
// (finding 3): a re-cue's replacement doesn't retroactively make the
// runner it leaves behind unwasted, so that one always scores.
function replacementsByKey(
  before: Slots,
  after: Slots,
  stepNow: number,
): Map<string, number> {
  const beforeRefs = new Set(before.map((slot) => slot.ref));
  const addedPerPair = new Map<string, number>();
  for (const slot of after) {
    if (slot.key === undefined || beforeRefs.has(slot.ref)) continue;
    const pk = `${slot.key}\0${slot.label}`;
    addedPerPair.set(pk, (addedPerPair.get(pk) ?? 0) + 1);
  }
  const stoppedPerPair = new Map<string, number>();
  const afterRefs = new Set(after.map((slot) => slot.ref));
  for (const slot of before) {
    if (
      slot.key === undefined ||
      slot.expiresAt <= stepNow ||
      slot.activeAt <= stepNow
    ) {
      continue;
    }
    if (afterRefs.has(slot.ref)) continue; // still a slot; not stopped
    const pk = `${slot.key}\0${slot.label}`;
    stoppedPerPair.set(pk, (stoppedPerPair.get(pk) ?? 0) + 1);
  }
  const replacedByKey = new Map<string, number>();
  for (const [pk, stoppedCount] of stoppedPerPair) {
    const added = addedPerPair.get(pk) ?? 0;
    const replaced = Math.min(stoppedCount, added);
    if (!replaced) continue;
    const key = pk.split('\0')[0]!;
    replacedByKey.set(key, (replacedByKey.get(key) ?? 0) + replaced);
  }
  return replacedByKey;
}

// Property (a): after a 'cue' step, each label of a key it visited holds
// exactly that label's first-wave count of key-bearing slots on this
// branch — never more (round 7's leak, or a kept slot that also adds a
// new one, would leave 2) and never fewer. A slot still due is also
// caught here on the same pass: one with `expiresAt` under `ready` is
// either not actually kept (finding 3) or a replacement that's itself
// already too short-lived, either of which this flags directly, rather
// than by its indirect effect on the count.
function checkFirstWaveCounts(
  after: Slots,
  visited: ReadonlySet<string>,
  branch: string,
  ready: number,
  ctx: string,
) {
  const perPair = new Map<string, number>();
  for (const slot of after) {
    if (slot.key === undefined || !visited.has(slot.key)) continue;
    if (slot.branch !== branch) continue;
    const pk = `${slot.key}\0${slot.label}`;
    perPair.set(pk, (perPair.get(pk) ?? 0) + 1);
    expect(
      slot.expiresAt,
      `${ctx} ${pk} kept slot still due at ready`,
    ).toBeGreaterThanOrEqual(ready);
  }
  for (const [pk, count] of perPair) {
    expect(count, `${ctx} ${pk} exactly one slot per label`).toBe(1);
  }
}

type Step =
  | { kind: 'cue'; branch: string; leadS: number }
  | { kind: 'cancel'; branch: string }
  | {
      kind: 'take';
      branch: string;
      key: (typeof KEYS)[number];
      fails: boolean;
    };

function randomStep(rng: () => number): Step {
  const roll = rng();
  const branch = pick(rng, BRANCHES);
  if (roll < 0.55)
    return { kind: 'cue', branch, leadS: 30 + Math.floor(rng() * 570) };
  if (roll < 0.7) return { kind: 'cancel', branch };
  return {
    kind: 'take',
    branch,
    key: pick(rng, KEYS),
    fails: rng() < 0.2,
  };
}

async function runProperty(seed: number, steps: number) {
  const rng = mulberry32(seed);
  const { planner, now, advance, nextRunId } = setup(async () => 'dev');
  await seedLeftAloneKeys(planner, now, advance, nextRunId);
  // Sanity: the seeding above actually left something for later random
  // 'cue' steps to leave alone, not a vacuous check.
  const sawPrecisionGuarded = planner.status().guarded >= 1;
  let sawGuarded = false;
  let sawLeftAloneGuard = false;
  let sawLeftAloneReview = false;
  for (let i = 0; i < steps; i++) {
    advance(Math.floor(rng() * 300) * 1000);
    const step = randomStep(rng);
    const ctx = `seed ${seed} step ${i} (${JSON.stringify(step)})`;
    const before = planner.debugSlots();
    const guardBefore = planner.debugCueGuard();
    const stepNow = now();
    let cancelled: (typeof before)[number][] = [];
    if (step.kind === 'cue') {
      const cueNow = stepNow;
      const ready = cueNow + s(step.leadS);
      planner.cue(REPO, step.branch, s(step.leadS), cueNow, '?');
      // A key this call left alone — debugProbeSkipped(), still cue-
      // guarded, precision-guarded or pr-uncertain — must come out fully
      // untouched: this call made no determination about it either way.
      // (Checking this on `visited`'s complement instead, as an earlier
      // round did, is too broad: a key dropped for a definite mismatch is
      // correctly NOT left alone, and asserting it is would hide that.) A
      // slot settle() would have expired anyway (due before this call
      // ran) is the one exception, unconditional and owed regardless.
      const visited = planner.debugLastVisited();
      const probeSkipped = planner.debugProbeSkipped();
      if (probeSkipped.has(GUARD_KEY_NAME)) sawLeftAloneGuard = true;
      if (probeSkipped.has(REVIEW_KEY_NAME)) sawLeftAloneReview = true;
      const afterNow = planner.debugSlots();
      const stillByRef = new Map(afterNow.map((slot) => [slot.ref, slot]));
      for (const slot of before) {
        if (
          slot.key === undefined ||
          !probeSkipped.has(slot.key) ||
          slot.expiresAt <= cueNow
        ) {
          continue;
        }
        const still = stillByRef.get(slot.ref);
        expect(
          still,
          `${ctx} left-alone key ${slot.key} slot untouched`,
        ).toBeDefined();
        expect(
          still?.key,
          `${ctx} left-alone key ${slot.key} slot untouched`,
        ).toBe(slot.key);
      }
      checkFirstWaveCounts(afterNow, visited, step.branch, ready, ctx);
    } else if (step.kind === 'cancel') {
      const cancelNow = stepNow;
      const dropped = planner.cancel(REPO, step.branch, cancelNow);
      // cancel() runs settle() first, which expires (and scores) any
      // slot whose time was already up; only what's left is its own to
      // remove unscored (the deliberate exception) — settle()'s own
      // expiries this same step still owe the usual scoring.
      cancelled = before.filter(
        (slot) =>
          slot.key !== undefined &&
          slot.branch === step.branch &&
          slot.expiresAt > cancelNow,
      );
      expect(dropped, `${ctx} cancel's count`).toBe(cancelled.length);
    } else {
      const id = nextRunId();
      const fields: Partial<JobMessage> = {
        workflowRunId: id,
        jobId: `${id}-0`,
        jobDisplayName: 'build',
        jobWorkflowRef: refFor(step.key.file, step.branch),
        queueTime: now(),
        requestLabels: [step.key.label],
      };
      planner.observe(step.key.label, message('JobAvailable', fields), now());
      planner.observe(step.key.label, message('JobAssigned', fields), now());
      // Sometimes ride the run through to a completion, occasionally a
      // failed one (C2: drops the run's own predicted slots; shouldn't
      // touch the cue guard's counters at all, already taken by now).
      planner.observe(
        step.key.label,
        message('JobStarted', { ...fields, runnerAssignTime: now() }),
        now(),
      );
      planner.observe(
        step.key.label,
        message('JobCompleted', {
          ...fields,
          finishTime: now() + 1000,
          result: step.fails ? 'Failed' : 'Succeeded',
        }),
        now() + 1000,
      );
    }
    const after = planner.debugSlots();
    const guardAfter = planner.debugCueGuard();
    const replaced = replacementsByKey(before, after, stepNow);
    checkInvariants(
      before,
      guardBefore,
      after,
      guardAfter,
      cancelled,
      replaced,
      ctx,
    );
    expect(planner.status().off, ctx).toBe(false);
    // `status().guarded` is the *precision* guard (T2/T3 history), a
    // different counter from the cue guard this test is about; check
    // the cue guard's own condition directly (GUARD_MIN_PREDICTED = 20,
    // GUARD_PRECISION = 0.6 in prewarm.ts — not exported, so mirrored
    // here).
    for (const g of guardAfter.values()) {
      if (g.cueScored >= 20 && g.cueTaken / g.cueScored < 0.6)
        sawGuarded = true;
    }
  }
  return {
    sawGuarded,
    sawPrecisionGuarded,
    sawLeftAloneGuard,
    sawLeftAloneReview,
  };
}

describe('Planner cue guard invariants (property test)', () => {
  it('holds across many randomized sequences of cue, cancel and take', async () => {
    const seeds = 40;
    let guardedSeeds = 0;
    let precisionGuardedSeeds = 0;
    let leftAloneGuardSeeds = 0;
    let leftAloneReviewSeeds = 0;
    for (let seed = 1; seed <= seeds; seed++) {
      const {
        sawGuarded,
        sawPrecisionGuarded,
        sawLeftAloneGuard,
        sawLeftAloneReview,
      } = await runProperty(seed, 300);
      if (sawGuarded) guardedSeeds++;
      if (sawPrecisionGuarded) precisionGuardedSeeds++;
      if (sawLeftAloneGuard) leftAloneGuardSeeds++;
      if (sawLeftAloneReview) leftAloneReviewSeeds++;
    }
    // Not vacuous: the two seeded keys actually get left alone (invariant
    // 3's other two reasons) in every run, not just the cue guard's own
    // probe-skip case the rest of this test already covers.
    expect(precisionGuardedSeeds, 'precision-guarded key seeded').toBe(seeds);
    expect(leftAloneGuardSeeds, 'precision-guarded key left alone').toBe(seeds);
    expect(leftAloneReviewSeeds, 'pr-uncertain key left alone').toBe(seeds);
    // Not vacuous: the guard actually engages somewhere in most runs,
    // so the invariants are exercised against real guarded state, not
    // just the easy, never-guarded case.
    expect(guardedSeeds).toBeGreaterThan(seeds / 2);
  });

  // Property (b): in a sequence where every cued push arrives after its
  // last re-cue (never catching a slot mid-reschedule), nothing is ever
  // left to score a miss that wasn't also a take: cueTaken === cueScored
  // for a key that's cued and taken this way throughout.
  it('keeps cueTaken equal to cueScored when every push follows its last re-cue', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const rng = mulberry32(seed);
      const { planner, now, advance, nextRunId } = setup();
      const key = KEYS[0]!;
      const branch = 'main';
      for (let round = 0; round < 20; round++) {
        // 1-3 re-cues, each sooner than the last, then the push itself.
        const recues = 1 + Math.floor(rng() * 3);
        let leadS = 200 + Math.floor(rng() * 300);
        for (let r = 0; r < recues; r++) {
          planner.cue(REPO, branch, s(leadS), now(), '?');
          const stepS = Math.floor(leadS / (recues - r + 1));
          advance(s(stepS));
          leadS -= stepS;
        }
        // A later re-cue for the same target, close enough to the push
        // that the slot it's keeping may already be running (finding 4's
        // slack margin covers it either way): still kept, not scored, so
        // cueTaken stays equal to cueScored through this round too.
        planner.cue(REPO, branch, s(leadS), now(), '?');
        advance(Math.max(0, s(leadS) - 1000));
        const id = nextRunId();
        const fields: Partial<JobMessage> = {
          workflowRunId: id,
          jobId: `${id}-0`,
          jobDisplayName: 'build',
          jobWorkflowRef: refFor(key.file, branch),
          queueTime: now(),
          requestLabels: [key.label],
        };
        planner.observe(key.label, message('JobAvailable', fields), now());
        planner.observe(key.label, message('JobAssigned', fields), now());
        advance(s(260)); // past CUE_IDLE_MS, settles cleanly before the next round
      }
      const guard = planner
        .debugCueGuard()
        .get(`${REPO}/.github/workflows/${key.file} push`);
      expect(guard, `seed ${seed}`).toBeDefined();
      expect(guard!.cueTaken, `seed ${seed}`).toBe(guard!.cueScored);
    }
  });

  // pull_request keys, and the `pr` parameter: 'y' starts them whether or
  // not this key ran for the branch yet (unless another already has, and
  // this one hasn't), '?' starts them only once this key has, 'n' starts
  // neither — same invariants apply throughout.
  it('holds for a pull_request key across pr = y, n and ?', async () => {
    const key = { file: 'review.yml', label: 'backmesh-ubuntu-2404-16vcpu' };
    const prRef = (pull: number) =>
      `${REPO}/.github/workflows/${key.file}@refs/pull/${pull}/merge`;
    const { planner, now, advance, nextRunId } = setup(async (_o, _r, runId) =>
      runId === 1 ? 'feature' : undefined,
    );
    // Learn the key on 'feature' via a PR, head branch resolved async.
    const learnId = nextRunId();
    const fields: Partial<JobMessage> = {
      workflowRunId: learnId,
      jobId: `${learnId}-0`,
      jobDisplayName: 'review',
      jobWorkflowRef: prRef(42),
      eventName: 'pull_request',
      queueTime: now(),
      requestLabels: [key.label],
    };
    planner.observe(key.label, message('JobAvailable', fields), now());
    planner.observe(key.label, message('JobAssigned', fields), now());
    await flush();
    advance(31 * 60_000);
    const keyName = `${REPO}/.github/workflows/${key.file} pull_request`;
    for (const pr of ['y', 'n', '?'] as const) {
      const before = planner.debugSlots();
      const guardBefore = planner.debugCueGuard();
      const cueNow = now();
      planner.cue(REPO, 'feature', s(90), cueNow, pr);
      const after = planner.debugSlots();
      const guardAfter = planner.debugCueGuard();
      const ctx = `pr=${pr}`;
      checkInvariants(
        before,
        guardBefore,
        after,
        guardAfter,
        [],
        replacementsByKey(before, after, cueNow),
        ctx,
      );
      const started = after.some((slot) => slot.key === keyName);
      expect(started, ctx).toBe(pr !== 'n');
      advance(s(260));
    }
  });

  // Finding 2: an earlier definite cue (pr='y') starting a pull_request
  // key's slot on a branch it hasn't run on yet, followed immediately by
  // an uncertain one (pr='?', which alone can't tell this branch's key
  // apart from a real mismatch, since it's run on a different branch, not
  // this one) must leave that slot alone — not drop and score it as if
  // '?' were as definite as 'n'.
  it("leaves an earlier definite cue's pull_request slot alone through an uncertain re-cue", async () => {
    const key = { file: 'review.yml', label: 'backmesh-ubuntu-2404-16vcpu' };
    const keyName = `${REPO}/.github/workflows/${key.file} pull_request`;
    const { planner, now, advance, nextRunId } = setup(async () => 'feature');
    const learnId = nextRunId();
    const fields: Partial<JobMessage> = {
      workflowRunId: learnId,
      jobId: `${learnId}-0`,
      jobDisplayName: 'review',
      jobWorkflowRef: `${REPO}/.github/workflows/${key.file}@refs/pull/1/merge`,
      eventName: 'pull_request',
      queueTime: now(),
      requestLabels: [key.label],
    };
    planner.observe(key.label, message('JobAvailable', fields), now());
    await flush();
    advance(31 * 60_000);
    // A definite cue for 'dev' (never run yet, but nothing else known
    // rules it out either) starts the slot.
    planner.cue(REPO, 'dev', s(300), now(), 'y');
    const started = planner
      .debugSlots()
      .some((slot) => slot.key === keyName && slot.branch === 'dev');
    expect(started, 'y starts it').toBe(true);
    const before = planner.debugSlots();
    const guardBefore = planner.debugCueGuard().get(keyName);
    // An uncertain re-cue right after: 'dev' hasn't itself run, and the
    // only branch this key is known for is 'feature', so '?' can't rule
    // 'dev' in or out — it must leave the slot it just started alone.
    planner.cue(REPO, 'dev', s(290), now(), '?');
    const probeSkipped = planner.debugProbeSkipped();
    expect(probeSkipped.has(keyName), 'left alone, not dropped').toBe(true);
    const after = planner.debugSlots();
    const guardAfter = planner.debugCueGuard().get(keyName);
    const stillThere = after.some(
      (slot) => slot.key === keyName && slot.branch === 'dev',
    );
    expect(stillThere, 'slot untouched').toBe(true);
    expect(before.length, 'no slot dropped').toBe(after.length);
    expect(guardAfter?.cueScored ?? 0, 'not scored').toBe(
      guardBefore?.cueScored ?? 0,
    );
    expect(guardAfter?.cueTaken ?? 0, 'not taken either').toBe(
      guardBefore?.cueTaken ?? 0,
    );
  });

  // Finding 3: a re-cue that drops a leftover slot which had already
  // started (running, not just planned) must still score it a miss, even
  // when this same call also adds a fresh slot for the same key and
  // label — that fresh slot is not this one's replacement, since a real
  // reserved runner, not just a prediction, went unused. Only a
  // not-yet-started leftover is exempted as a replacement's continuation.
  it('scores a running leftover a miss even when the re-cue replaces it', () => {
    const { planner, now, advance } = setup();
    const key = KEYS[0]!;
    const keyName = `${REPO}/.github/workflows/${key.file} push`;
    const branch = 'main';
    // A short lead starts the slot active right away.
    planner.cue(REPO, branch, s(1), now(), '?');
    const startedSlot = planner
      .debugSlots()
      .find((slot) => slot.key === keyName && slot.branch === branch);
    expect(startedSlot, 'slot started').toBeDefined();
    advance(s(5)); // past activeAt: the slot is now running
    expect(now()).toBeGreaterThan(startedSlot!.activeAt);
    const guardBefore = planner.debugCueGuard().get(keyName);
    // A re-cue for the same key and label adds a fresh slot: under the
    // old, reverted behavior this would count the running leftover as
    // that fresh slot's own replacement and score nothing; it must score
    // a miss instead, since the running one was never taken.
    planner.cue(REPO, branch, s(300), now(), '?');
    const after = planner.debugSlots();
    expect(
      after.some((slot) => slot.ref === startedSlot!.ref),
      'the running leftover is gone',
    ).toBe(false);
    const guardAfter = planner.debugCueGuard().get(keyName);
    expect(
      (guardAfter?.cueScored ?? 0) - (guardBefore?.cueScored ?? 0),
      'scored a miss for the running leftover',
    ).toBe(1);
    expect(
      (guardAfter?.cueTaken ?? 0) - (guardBefore?.cueTaken ?? 0),
      'not a take',
    ).toBe(0);
  });

  // Finding 4: a re-cue's new target just inside the old kept condition's
  // margin (still due by `ready`, but with less than half of CUE_IDLE_MS
  // left) must not keep the running slot it's rescheduling — it's too
  // close to running out to trust, so the re-cue replaces it (and, by
  // finding 3, scores it a miss, since it had already started).
  it('replaces, rather than keeps, a running slot too close to its own expiry', () => {
    const { planner, now, advance } = setup();
    const key = KEYS[0]!;
    const keyName = `${REPO}/.github/workflows/${key.file} push`;
    const branch = 'main';
    planner.cue(REPO, branch, s(3600), now(), '?');
    const startedSlot = planner
      .debugSlots()
      .find((slot) => slot.key === keyName && slot.branch === branch)!;
    expect(startedSlot).toBeDefined();
    advance(startedSlot.activeAt - now() + s(5)); // now running
    const guardBefore = planner.debugCueGuard().get(keyName);
    // A target 45 s short of the slot's own expiry: within the old
    // condition's margin (still <= expiresAt), but inside the new
    // CUE_IDLE_MS / 2 (90 s) slack this re-cue requires to keep it.
    const ready2 = startedSlot.expiresAt - 45_000;
    planner.cue(REPO, branch, ready2 - now(), now(), '?');
    const after = planner.debugSlots();
    expect(
      after.some((slot) => slot.ref === startedSlot.ref),
      'the too-close-to-expiry slot is gone, not kept',
    ).toBe(false);
    expect(
      after.some(
        (slot) =>
          slot.key === keyName && slot.branch === branch && slot.run < 0,
      ),
      'replaced by a fresh cue slot',
    ).toBe(true);
    const guardAfter = planner.debugCueGuard().get(keyName);
    expect(
      (guardAfter?.cueScored ?? 0) - (guardBefore?.cueScored ?? 0),
      'scored a miss: it had already started',
    ).toBe(1);
  });

  // MAX_KEYS (200) eviction: learning one new key past the cap drops the
  // oldest from this.keys entirely. Its cue slots, if any, lose their Key
  // object mid-flight; cue()'s cleanup must still run without throwing,
  // and the remaining keys' invariants must still hold.
  it('stays within its invariants through MAX_KEYS eviction', () => {
    const { planner, now, advance, nextRunId } = setup();
    planner.cue(REPO, 'main', s(300), now());
    const before = planner.debugSlots();
    const guardBefore = planner.debugCueGuard();
    const stepNow = now();
    // 200 fresh keys push the two learned above (and whichever of these
    // 200 come first) out the back of the LRU.
    for (let i = 0; i < 205; i++) {
      const id = nextRunId();
      const fields: Partial<JobMessage> = {
        workflowRunId: id,
        jobId: `${id}-0`,
        jobDisplayName: 'build',
        jobWorkflowRef: `${REPO}/.github/workflows/evict-${i}.yml@refs/heads/main`,
        queueTime: now(),
        requestLabels: ['backmesh-ubuntu-2404-4vcpu'],
      };
      planner.observe(
        'backmesh-ubuntu-2404-4vcpu',
        message('JobAvailable', fields),
        now(),
      );
      advance(1000);
    }
    const after = planner.debugSlots();
    const guardAfter = planner.debugCueGuard();
    expect(planner.status().off).toBe(false);
    checkInvariants(
      before,
      guardBefore,
      after,
      guardAfter,
      [],
      replacementsByKey(before, after, stepNow),
      'eviction',
    );
    expect(
      planner.cue(REPO, 'main', s(300), now()).dropped,
    ).toBeGreaterThanOrEqual(0);
  });

  // C (owner, 2026-11-13): the same invariants across a listener restart,
  // where the planner starts with nothing learned and in its warm-up, and
  // the cold-repo backfill a cue starts then. The backfill answers only on
  // an 'answer' step, so cues, cancels and runs interleave with it, and
  // its replan (one cue per branch still ahead) is checked like any step.
  // A 'stale' step is a pre-restart run's job: queued before the start, or
  // after it but not one that starts a run.
  it('holds across a listener restart and a cold repo backfill', async () => {
    let replannedSeeds = 0;
    let takenSeeds = 0;
    let staleMet = 0;
    const logged = [0, 0, 0];
    for (let seed = 1; seed <= 30; seed++) {
      const run = await runRestartProperty(seed, 200);
      if (run.replanned) replannedSeeds++;
      if (run.taken) takenSeeds++;
      staleMet += run.staleMet;
      run.logged.forEach((n, i) => (logged[i]! += n));
    }
    // The three cue events all fired, each checked step by step above.
    for (const n of logged) expect(n).toBeGreaterThan(30);
    // Pre-restart jobs met live cue slots, which they never took.
    expect(staleMet).toBeGreaterThan(10);
    // Not vacuous: the backfill's replan starts slots in over half the
    // runs (only a cue whose push is still ahead when the answer comes is
    // replanned), and pushes take cue slots in most.
    expect(replannedSeeds).toBeGreaterThan(15);
    expect(takenSeeds).toBeGreaterThan(25);
  });
});

type RestartStep =
  | { kind: 'cue'; branch: string; leadS: number; pr: 'y' | '?' }
  | { kind: 'cancel'; branch: string }
  | { kind: 'take'; branch: string; key: (typeof KEYS)[number] }
  | {
      kind: 'stale';
      branch: string;
      key: (typeof KEYS)[number];
      before: boolean;
    }
  | { kind: 'answer' };

async function runRestartProperty(seed: number, steps: number) {
  const rng = mulberry32(seed);
  let now = 0;
  // Each answer waits for an 'answer' step.
  let pending: (() => void)[] = [];
  const later = <T>(value: T) =>
    new Promise<T>((resolve) => pending.push(() => resolve(value)));
  const logs: Record<string, unknown>[] = [];
  const planner = new Planner({
    labels: KEYS.map((k) => k.label),
    // ci.yml and deploy.yml ran `build` on their labels, on random
    // branches; hosted.yml on GitHub's runners; nothing on pull_request.
    // A read the hour's budget cuts short returns nothing.
    history: (ref, _count, take, uses) => {
      if (!take() || !take()) return later([]);
      const key = KEYS.find((k) => k.file === ref.workflow);
      const runs =
        ref.event !== 'push'
          ? []
          : Array.from({ length: 3 }, (_, i) => ({
              id: 10_000 + i,
              branch: pick(rng, BRANCHES),
              jobs: [
                {
                  name: 'build',
                  labels: [key?.label ?? 'ubuntu-latest'],
                  conclusion: 'success',
                  queuedAt: -s(3600) + i * s(600),
                  startedAt: -s(3600) + i * s(600) + s(30),
                  finishedAt: -s(3600) + i * s(600) + s(90),
                },
              ],
            }));
      return later(runs.length && uses?.(runs[0]!.jobs) === false ? [] : runs);
    },
    workflows: () =>
      later({
        owner: 'acme',
        repo: 'app',
        files: [...KEYS.map((k) => k.file), 'hosted.yml'],
      }),
    log: (entry) => void logs.push(entry),
    // The restart: the planner starts now, with nothing learned.
    now: () => now,
  });
  let runId = 1;
  const job = (
    key: (typeof KEYS)[number],
    branch: string,
    name: string,
    queued: number,
  ): Partial<JobMessage> => {
    const id = runId++;
    return {
      workflowRunId: id,
      jobId: `${id}-0`,
      jobDisplayName: name,
      jobWorkflowRef: refFor(key.file, branch),
      queueTime: queued,
      requestLabels: [key.label],
    };
  };
  let taken = false;
  // Pre-restart jobs heard in the warm-up while their branch had live cue
  // slots on the key: the warm-up assertion below isn't vacuous.
  let staleMet = 0;
  // The cue events: each cue slot logs its start once, when the scaler
  // first counts it.
  const startedRefs = new Set<object>();
  const events = (from: number, msg: string) =>
    logs.slice(from).filter((l) => l.msg === msg);
  for (let i = 0; i < steps; i++) {
    now += Math.floor(rng() * 60) * 1000;
    const roll = rng();
    const branch = pick(rng, BRANCHES);
    const step: RestartStep =
      roll < 0.4
        ? {
            kind: 'cue',
            branch,
            leadS: 30 + Math.floor(rng() * 270),
            pr: rng() < 0.5 ? 'y' : '?',
          }
        : roll < 0.5
          ? { kind: 'cancel', branch }
          : roll < 0.7
            ? { kind: 'take', branch, key: pick(rng, KEYS) }
            : roll < 0.8
              ? {
                  kind: 'stale',
                  branch,
                  key: pick(rng, KEYS),
                  before: rng() < 0.5,
                }
              : { kind: 'answer' };
    const ctx = `restart seed ${seed} step ${i} (${JSON.stringify(step)})`;
    const before = planner.debugSlots();
    const guardBefore = planner.debugCueGuard();
    const stepNow = now;
    const logFrom = logs.length;
    let cancelled: Slots = [];
    if (step.kind === 'cue') {
      planner.cue(REPO, step.branch, s(step.leadS), now, step.pr);
      checkFirstWaveCounts(
        planner.debugSlots(),
        planner.debugLastVisited(),
        step.branch,
        now + s(step.leadS),
        ctx,
      );
    } else if (step.kind === 'cancel') {
      const dropped = planner.cancel(REPO, step.branch, now);
      cancelled = before.filter(
        (slot) =>
          slot.key !== undefined &&
          slot.branch === step.branch &&
          slot.expiresAt > now,
      );
      expect(dropped, `${ctx} cancel's count`).toBe(cancelled.length);
    } else if (step.kind === 'take' || step.kind === 'stale') {
      const fields =
        step.kind === 'take'
          ? job(step.key, step.branch, 'build', now)
          : step.before
            ? job(step.key, step.branch, 'build', -1000)
            : job(step.key, step.branch, 'test (0)', now);
      const guard = planner.debugCueGuard();
      const key = `${REPO}/.github/workflows/${step.key.file} push`;
      if (
        step.kind === 'stale' &&
        step.before &&
        now < 30 * 60_000 &&
        before.some(
          (slot) =>
            slot.key === key &&
            slot.branch === step.branch &&
            slot.expiresAt > now,
        )
      ) {
        staleMet++;
      }
      planner.observe(step.key.label, message('JobAssigned', fields), now);
      if (
        (planner.debugCueGuard().get(key)?.cueTaken ?? 0) >
        (guard.get(key)?.cueTaken ?? 0)
      ) {
        // In the warm-up (30 minutes from the restart at 0), a job queued
        // before the restart never takes a cue. One queued after it but not
        // a run's first is told apart only once the key learned a first
        // wave without it (prewarm.spec.ts covers that), so here it's held
        // to the invariants alone; past the warm-up, any job starts a run,
        // as before.
        if (now < 30 * 60_000 && step.kind === 'stale' && step.before) {
          expect(step.kind, `${ctx} only a fresh run takes a cue`).toBe('take');
        }
        if (step.kind === 'take') taken = true;
      }
    } else {
      const answers = pending;
      pending = [];
      for (const answer of answers) answer();
      for (let f = 0; f < 5; f++) await flush();
      // A replan's own answers wait for the next 'answer' step.
    }
    const after = planner.debugSlots();
    const guardAfter = planner.debugCueGuard();
    checkInvariants(
      before,
      guardBefore,
      after,
      guardAfter,
      cancelled,
      replacementsByKey(before, after, stepNow),
      ctx,
    );
    // Exactly one `cue slot expired` per untaken cue slot settle() dropped
    // this step, and the `cue taken` events' slots add up to cueTaken's
    // rise. Events are matched to their slots by label, run and (for an
    // expiry) time, not just counted, so one slot logging twice and
    // another not at all fails.
    const afterRefs = new Set(after.map((slot) => slot.ref));
    const tag = (label: unknown, run: unknown, at: unknown = '') =>
      `${String(label)} ${String(run)} ${String(at)}`;
    const expired = before.filter(
      (slot) =>
        slot.key !== undefined &&
        slot.expiresAt <= stepNow &&
        !afterRefs.has(slot.ref),
    );
    expect(
      events(logFrom, 'cue slot expired')
        .map((l) => tag(l.label, l.run, l.at))
        .sort(),
      `${ctx} expired`,
    ).toEqual(expired.map((x) => tag(x.label, x.run, x.expiresAt)).sort());
    let takenSlots = 0;
    for (const [key, g] of guardAfter) {
      takenSlots += g.cueTaken - (guardBefore.get(key)?.cueTaken ?? 0);
    }
    expect(
      events(logFrom, 'cue taken').reduce((n, l) => n + Number(l.slots), 0),
      `${ctx} taken`,
    ).toBe(takenSlots);
    // The scaler counts each label's cue slots every cycle: each logs its
    // start the first time, and never again.
    const counted = logs.length;
    for (const { label } of KEYS) planner.speculative(label, now, true);
    const starting = after.filter(
      (slot) =>
        slot.cue &&
        slot.activeAt <= now &&
        now < slot.expiresAt &&
        !startedRefs.has(slot.ref),
    );
    for (const slot of starting) startedRefs.add(slot.ref);
    expect(
      events(counted, 'cue slot started')
        .map((l) => tag(l.label, l.run))
        .sort(),
      `${ctx} started`,
    ).toEqual(starting.map((x) => tag(x.label, x.run)).sort());
    expect(planner.status().off, ctx).toBe(false);
  }
  const replanned = logs.some(
    (l) => l.msg === 'cue slots after backfill' && Number(l.added) > 0,
  );
  const logged = ['cue slot started', 'cue taken', 'cue slot expired'].map(
    (msg) => events(0, msg).length,
  );
  return { replanned, taken, staleMet, logged };
}
