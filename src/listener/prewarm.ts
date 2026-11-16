import type { Log } from '../github/retry.js';
import type { JobMessage } from '../github/types.js';
import type {
  PastJob,
  RecentRuns,
  RecentWorkflows,
  WorkflowRef,
} from '../github/runs.js';
import { nearestRank } from './timings.js';

// The planner (no idle capacity, so a runner it starts
// is removed once it has idled 60 s after it's ready, 180 s for a cue's).
// It learns each workflow's runs from the scale-set messages (W1) and a
// lazy history backfill (W2), and predicts a new run's later jobs per
// label. Each prediction is a speculative slot, and the scaler adds a
// label's active slots to its desired count, so real ephemeral
// runners start early through the usual path. A replay simulation
// (`simulate.py`) is the reference model: combo
// timing, counts at the median of the last 20 runs, C2 and the precision
// guard are its recommended settings.
//
// Everything stays in memory, so a restart starts over. Repository, workflow
// and job names never leave this module: `status` gets counts only.

// A runner's boot, from its submit to its taking a job, is two parts: its VM
// Job's start (submit to running) and its registration (running to taking a
// job). Each label's boot is the same rank of its last 20 of each
// (`bootSample` in `timings.ts`) added together, not the rank of their sum,
// so anycloud's VM Job quick wins need no change here. Before
// any start is measured it's the replay's 63 s bare-metal Create-to-Ready
// plus 8 s to register; a label with no registration measured takes the
// same rank of every label's, else 8 s.
// T3 starts a slot a boot before its job: the cue benchmark found
// the median too fast for a cue's own slot, as half a label's boots run
// longer, so a cue's uses CUE_PERCENTILE instead of the median;
// T2's children start the moment their parent does, with no boot
// subtraction. Either way the slot ends IDLE_MS, or a cue's CUE_IDLE_MS,
// after its runner should be ready.
const BOOT_MS = 71_000;
const REGISTER_MS = 8_000;
const BOOTS_KEPT = 20;
const CUE_PERCENTILE = 0.75;
// An unused slot ends this long after its runner should be ready.
const IDLE_MS = 60_000;
// A cue's slot waits longer: its runner is the only one for its push, so
// losing it to a short idle timeout costs a full cold start, where a
// history prediction's loss is one of several for the same job.
const CUE_IDLE_MS = 180_000;
// A key is (workflow, event); predictions use its last 20 runs, T3 timing
// needs 5 of them, and T2 (start a job's children when it starts) runs with
// fewer.
const HISTORY_RUNS = 20;
const MIN_T3_RUNS = 5;
// The guard: a key whose finished runs' predicted slots were less than 60 %
// right, over 20 or more, runs reactive. Its predictions still count, so it
// can come back.
const GUARD_PRECISION = 0.6;
const GUARD_MIN_PREDICTED = 20;
const CUE_PROBE = 5;
// A job queued within 5 s of an earlier job's completion in its run is that
// job's child (the latest-finishing, so `needs: [a, b]` takes the later).
const PARENT_GAP_MS = 5_000;
// The listener can't hear a run end: a run whose jobs have all completed is
// learned once no message has named it for 2 minutes, and forgotten a day
// after its last, so a rerun of it is neither planned nor learned. A run
// with a longer gap between its jobs here (an approval, or a stretch on other
// runners) is learned without its later jobs: the medians over 20 runs and
// the guard absorb it, where a longer wait would hold every run's learning.
const SETTLE_MS = 2 * 60_000;
// A run's first wave (the jobs GitHub assigned within 5 s of its first) is
// learned this long after the listener first heard of it, for its other
// labels' messages to arrive, so a cue can predict a workflow after one run
// started rather than one completed (anycloud's integration
// runs take over 20 minutes).
const WAVE_MS = 30_000;
// PRs whose head branch was looked up, kept for cues.
const MAX_PULLS = 500;
const FORGET_MS = 86_400_000;
// A run first heard of this soon after the planner's start may have begun
// before it, so it's neither planned nor learned: its first-heard job may
// not be its trigger. A run whose first-heard job GitHub queued after the
// start is exempt (owner, 2026-11-13), so a cue right after a restart
// works, unless the key's learned first waves never had that job; with
// none learned, an older run's later job may still be taken for a
// trigger, which the medians over 20 runs and the guard absorb.
const WARMUP_MS = 30 * 60_000;
const MAX_KEYS = 200;
// W2's GitHub requests an hour, against the installation token: a backfill
// starts only with room for its runs list and a jobs page per run.
const BACKFILL_CALLS_PER_HOUR = 300;
const HOUR_MS = 3_600_000;
// A backfill's calls, reserved up front: its runs list and a jobs page per
// run, or for a cue's probe of a workflow no message named, the list and its
// newest run's page; the rest draw one by one.
const reservation = (probe: boolean) => 1 + (probe ? 1 : HISTORY_RUNS);

type Mode = 'T2' | 'T3' | null;
type Children = Map<string | null, [string, number][]>;

// A learned run: its jobs in queue order, the first one the trigger.
type Step = { name: string; label: string; offset: number; parent: number };
const ROOT = -1;

interface Job {
  name: string;
  label: string;
  queuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

interface Run {
  key: string;
  // The label most learned runs' triggers ran on: the first job assigned on
  // it is the trigger and spends no slot. Each label has its own session,
  // so the trigger isn't always the first job heard of.
  trigger: string | undefined;
  jobs: Map<string, Job & { assigned: boolean }>;
  lastAt: number;
  closed: boolean;
  settled: boolean;
  // Whether W1 learns it: a run it doesn't, heard in the warm-up but queued
  // before the start, or past its offer, W2 may still learn once it's
  // completed.
  fresh: boolean;
  // When the listener first heard of it, and whether its first wave is
  // learned (or never will be: a run that isn't fresh).
  heardAt: number;
  waved: boolean;
  // T2's predicted children per parent job name, null for the roots.
  children: Children;
  // Predicted slots per label, for the guard.
  predicted: Map<string, number>;
}

// The cue guard's invariants (test/unit/listener/prewarm-invariants.spec.ts
// checks these with randomized sequences, also across a listener restart
// and a cold repo's backfill and replan; rounds 7, 9, 10 and two
// independent reviews after it each broke one of them a different way,
// always in `cue()`'s slot-lifecycle bookkeeping):
//
// 1. A key-bearing slot (`Slot.key !== undefined`) leaves that state
//    exactly once, three ways: taken (`plan()` increments `cueTaken` and
//    `cueScored` together, in the same step that deletes its `key`),
//    replaced (a re-cue adds a fresh slot for the same key and label in
//    the same step that drops this one, while it hadn't started yet —
//    its continuation, not scored, since the prediction it represents
//    hasn't actually gone unused yet), or scored a miss alone (in the
//    same step that removes it from `this.slots`, whether by `settle()`'s
//    natural expiry or `cue()`'s own leftover cleanup, once there's no
//    replacement left to cover it, or because it had already started —
//    a running runner a re-cue leaves behind is a real wasted one,
//    replacement or not). So between any two points in time, the number
//    of a key's slots that stopped being key-bearing, less however many
//    not-yet-started ones were replaced, equals exactly its `cueScored`
//    delta over the same span. `cancel()` is the one deliberate
//    exception: a user's explicit `backmesh cue --cancel` removes
//    without scoring, since it isn't a prediction that went unused, it's
//    the user saying they don't want it.
// 2. `cueTaken <= cueScored` for every key, always (taking a slot scores
//    it too, so it can never outrun being scored).
// 3. A key `cueKeys()` skips only for its probe counter (still guarded,
//    not this round's turn), or because it's precision-guarded (T2/T3's
//    own, separate guard), or because it's a pull_request key this call's
//    `pr` is merely uncertain ('?') about, keeps every slot it already
//    has: none of those is a determination about them either way, so
//    `cue()` must neither remove nor score them — they're still live
//    candidates for the push itself. A key it drops for any other reason
//    (a prefix mismatch, a push key that didn't run, or a pull_request
//    key `pr` definitely rules out) has nothing left to wait for, so its
//    slots are cleaned up the same as a visited key's. (Rounds 9 and 10
//    each broke the probe-skipped case a different way, for two
//    different slot shapes; the first independent review found the
//    broader cut was too broad the other way, sweeping up a visited
//    key's own replaced slots as well; the second found two more skip
//    reasons — precision-guarded, and an uncertain pull_request match —
//    were still being dropped and scored like a definite mismatch.)
// 4. A kept slot is only ever one that will still be due, with at least
//    half of CUE_IDLE_MS to spare, by the new target time (`ready`): one
//    that would already be running out by then is not kept, even if its
//    clamped `activeAt` would otherwise fit, so a push is never left
//    looking for a runner that's about to expire just as it needed one.
// 5. A guarded key (`cueScored >= GUARD_MIN_PREDICTED` and
//    `cueTaken / cueScored < GUARD_PRECISION`) that CUE_PROBE lets through
//    gets a real probe slot, and invariant 1 means that slot is always
//    eventually resolved (taken, replaced or scored) by something, so
//    the guard can never be stuck with cueScored frozen and no live
//    probe able to move it: there is always a path back to being
//    unguarded if the pushes start taking its probes.
interface Key {
  runs: Step[][];
  // Its runs' first waves, each the labels of the jobs in it, newest last:
  // what a cue starts.
  waves: string[][];
  // The same waves' job names: in the warm-up, a run whose first-heard job
  // isn't one of them began before the listener (`plan`).
  starters: string[][];
  // The branches its runs were heard on, for cues: a push run's ref, or a
  // pull_request run's PR's head branch, looked up.
  branches: Set<string>;
  backfill: 'none' | 'pending' | 'done';
  // The runs a backfill has read.
  backfilled: Set<number>;
  // The guard's record: right and predicted slots over finished runs.
  hits: number;
  predicted: number;
  // The cue guard's record: cue slots a run took, of those taken or expired.
  cueTaken: number;
  cueScored: number;
  // Cues skipped while the cue guard held, for its probes.
  cueSkipped: number;
}

interface Slot {
  run: number;
  // A cue's slot names its push's key and branch instead, until that run
  // arrives and takes it.
  key?: string;
  branch?: string;
  label: string;
  activeAt: number;
  // Set once at creation and never changed, even when a re-cue keeps the
  // slot (only `run` is reassigned then): `expiresAt - CUE_IDLE_MS` is the
  // boot the slot was scheduled with, plus `activeAt` (`plan`'s `up` reads
  // it this way, for a cued run's later jobs), so a cue's slot needs no
  // separate field to remember it.
  expiresAt: number;
  // Started for a cue, which a run's taking it keeps.
  cue?: true;
  // A cue's slot whose start is logged.
  started?: true;
}

export interface PlannerStatus {
  keys: number;
  guarded: number;
  // An error turned the planner off until the listener restarts.
  off: boolean;
}

export interface PlannerDeps {
  // The scale sets' labels: backfilled jobs on other labels aren't ours.
  labels: string[];
  history?: RecentRuns;
  // A workflow run's head branch, or undefined when its head is another
  // repository's (a fork's PR).
  runBranch?: (
    owner: string,
    repo: string,
    runId: number,
  ) => Promise<string | undefined>;
  // A repository's own workflow files (`workflowFiles` in `runs.ts`), for a
  // cue's repo with none learned.
  workflows?: RecentWorkflows;
  // A cue's slots planned late, once its repo's backfill answered: the
  // scaler reconciles.
  replanned?: () => void;
  log: Log;
  now?: () => number;
}

// An untaken cue slot's workflow and branch, for the log.
const cueOf = ({ key, branch }: Slot) =>
  key === undefined ? {} : { workflow: key, branch };

export class Planner {
  private readonly labels: Set<string>;
  private readonly keys = new Map<string, Key>();
  private readonly runs = new Map<number, Run>();
  private slots: Slot[] = [];
  private calls: number[] = [];
  // Each PR's head branch ('' for a fork's), or, while it's looked up, the
  // keys whose runs wait for it: one push starts several workflows at once.
  private readonly pulls = new Map<string, string | Set<Key>>();
  private off = false;
  private readonly since: number;
  private cues = 0;
  // Test-only: the keys the last cue() call visited (debugLastVisited
  // below), for the invariant property test.
  private lastVisited = new Set<string>();
  // Test-only: the keys the last cue() call left alone — still
  // cue-guarded, precision-guarded, or pr-uncertain (debugProbeSkipped
  // below) — narrower than lastVisited's complement, which also includes
  // keys dropped outright for a definite mismatch.
  private lastProbeSkipped = new Set<string>();
  // Repos whose workflows a cue is backfilling, lower-cased, with each
  // branch's latest cue, planned again once they answer.
  private readonly learning = new Map<
    string,
    Map<string, { ready: number; pr: 'y' | 'n' | '?' }>
  >();
  // Repos not to read again until when: one whose read found no workflow
  // using the labels for an hour, and one the budget or a full key map cut
  // short for 10 minutes, so cues don't spend W2's budget on them.
  private readonly unused = new Map<string, number>();
  // PRs whose fresh run waits for its branch's lookup, with the run's key.
  private readonly freshPulls = new Map<string, string>();
  // Measured starts and registrations per label, newest last.
  private readonly boots = new Map<
    string,
    { starts: number[]; registers: number[] }
  >();

  constructor(private readonly deps: PlannerDeps) {
    this.labels = new Set(deps.labels);
    this.since = deps.now?.() ?? Date.now();
  }

  // Every scale-set message, on the scale set `label`. A new run is planned
  // at its first; JobAssigned spends one of its slots, JobStarted starts
  // T2's children, and a failed or cancelled JobCompleted drops the run's
  // slots (C2).
  observe(label: string, job: JobMessage, now: number): void {
    this.safe(() => this.see(label, job, now), undefined);
  }

  // The label's active slots: what the scaler adds to its desired count;
  // with `cue`, a cue's only. A cue's slot is logged when it's first
  // counted, which a `status` read can be.
  speculative(label: string, now: number, cue = false): number {
    return this.safe(() => {
      const active = this.slots.filter(
        (s) =>
          s.label === label &&
          (!cue || s.cue) &&
          s.activeAt <= now &&
          now < s.expiresAt,
      );
      for (const slot of active) {
        if (!slot.cue || slot.started) continue;
        slot.started = true;
        this.note({
          msg: 'cue slot started',
          label,
          run: slot.run,
          ...cueOf(slot),
          bootMs: this.cueReadyAt(slot) - slot.activeAt,
        });
      }
      return active.length;
    }, 0);
  }

  // Milliseconds to the next slot start or expiry, for the listener's timer:
  // its 50 s reconcile is too coarse for T3.
  nextDue(now: number): number | undefined {
    return this.safe(() => {
      const due = this.slots.flatMap((s) =>
        [s.activeAt, s.expiresAt].filter((at) => at > now),
      );
      return due.length ? Math.min(...due) - now : undefined;
    }, undefined);
  }

  // A cue: a push to the repo's branch is coming in about
  // `leadMs`. Starts the first waves (the trigger and the jobs queued with
  // it) of the repo's push and pull_request workflows (`cueKeys`), each
  // runner ready then (at CUE_PERCENTILE of the label's recent boots, never
  // earlier than now: the lead itself caps how early a slot starts, since
  // `ready - boot` can't go below `now` when `boot` runs past `leadMs`) and
  // ending CUE_IDLE_MS after it should be ready.
  //
  // A later cue for the same repo and branch reschedules the earlier one's:
  // its runners not started yet are dropped and planned again, and those
  // booting, ready and still due by the new target are kept and stand for
  // the new first wave with their own expiry, so the push never has two
  // and none idles longer. One a re-cue replaces outright scores
  // nothing — the replacement is its continuation, not an independent
  // miss — but one left over because its label's count fell (round 7)
  // still does.
  cue(
    repo: string,
    branch: string,
    leadMs: number,
    now: number,
    pr: 'y' | 'n' | '?' = '?',
  ) {
    const none = { added: 0, kept: 0, dropped: 0 };
    return this.safe(() => {
      this.settle(now);
      const ready = now + leadMs;
      // A repo with no workflow learned yet, such as the first cue after a
      // restart: its push and pull_request workflows are backfilled, and
      // the cue planned again once they answer.
      const prefix = `${repo.toLowerCase()}/.github/workflows/`;
      if (
        ![...this.keys.keys()].some((k) => k.toLowerCase().startsWith(prefix))
      ) {
        this.learnRepo(repo, now);
      }
      this.learning.get(repo.toLowerCase())?.set(branch, { ready, pr });
      const earlier = this.cued(repo, branch);
      // Only an already-started slot that will still be due, with half
      // of CUE_IDLE_MS to spare, by `ready` can be kept; one not started
      // yet, or one that would already be running out by then, is always
      // dropped and planned again (never reused even if its own clamped
      // activeAt would fit), so it starts in `unmatched` and stays there.
      // Matching only removes an entry on an actual reuse, so a slot
      // found but rejected stays too, rather than being lost from
      // bookkeeping along with the search; the condition lives inside the
      // search itself so a different slot for the same key and label, if
      // one exists and does fit, is still found.
      const unmatched = new Set(earlier);
      const result = { ...none };
      const run = -++this.cues;
      const visited = new Set<string>();
      // Keys cueKeys() skips for a reason that's no determination either
      // way — still cue-guarded and not this round's probe turn, already
      // precision-guarded (T2/T3's separate guard), or a pull_request key
      // this cue's `pr` can't yet rule out ('?', uncertain, against a key
      // an earlier definite cue started): their slots are untouched
      // below, since they're still live candidates for the push itself.
      // A key it skips because it (or the branch) definitively doesn't
      // match has nothing left to wait for, so its slots fall through to
      // the same cleanup as a visited key's.
      const probeSkipped = new Set<string>();
      // How many fresh slots this call added per key and label: a
      // not-yet-started leftover for the same pair is that replacement's
      // continuation, not a separate miss, so only the excess beyond it
      // gets scored below. One already running when this call started is
      // scored regardless: a real runner went unused, replacement or not.
      const addedPerPair = new Map<string, number>();
      const pairKey = (key: string, label: string) => `${key}\0${label}`;
      for (const [key, state] of this.cueKeys(repo, branch, pr, probeSkipped)) {
        visited.add(key);
        for (const [label, n] of firstWave(state.waves)) {
          const boot = this.boot(label, CUE_PERCENTILE);
          const activeAt = Math.max(now, ready - boot);
          for (let i = 0; i < n; i++) {
            const old = earlier.find(
              (slot) =>
                unmatched.has(slot) &&
                slot.key === key &&
                slot.label === label &&
                slot.activeAt <= now &&
                ready + CUE_IDLE_MS / 2 <= slot.expiresAt,
            );
            if (old) {
              old.run = run;
              unmatched.delete(old);
              result.kept++;
              continue;
            }
            const expiresAt = this.cueExpiresAt(activeAt, boot);
            const slot = { run, key, branch, label, activeAt, expiresAt };
            this.slots.push({ ...slot, cue: true });
            result.added++;
            const pk = pairKey(key, label);
            addedPerPair.set(pk, (addedPerPair.get(pk) ?? 0) + 1);
          }
        }
      }
      // Whatever's left unmatched for a key this call didn't leave alone
      // is now stale: drop it, or it'd sit uncounted past its own
      // CUE_IDLE_MS. Score it a cue-guard miss first, as settle() does
      // for one that simply expires — unless it hadn't started yet and
      // this same call already added a fresh slot for the same key and
      // label, which is this leftover's own replacement, not an
      // independent prediction that went unused; only the excess over
      // that count still scores, and one already running always does.
      const stale = [...unmatched].filter(
        (slot) => !probeSkipped.has(slot.key!),
      );
      if (stale.length) {
        const byPair = new Map<string, Slot[]>();
        for (const slot of stale) {
          const pk = pairKey(slot.key!, slot.label);
          (byPair.get(pk) ?? byPair.set(pk, []).get(pk)!).push(slot);
        }
        for (const [pk, group] of byPair) {
          const running = group.filter((slot) => slot.activeAt <= now);
          const waiting = group.filter((slot) => slot.activeAt > now);
          const toScore = [
            ...running,
            ...waiting.slice(addedPerPair.get(pk) ?? 0),
          ];
          for (const slot of toScore) {
            const state = this.keys.get(slot.key!);
            if (state) state.cueScored++;
          }
        }
        this.slots = this.slots.filter((slot) => !stale.includes(slot));
        result.dropped += stale.length;
      }
      this.lastVisited = visited;
      this.lastProbeSkipped = probeSkipped;
      return result;
    }, none);
  }

  // `backmesh cue --cancel`: drops the repo's branch's cued runners that no
  // run has taken, started or not, so the scaler removes them. Returns how
  // many.
  cancel(repo: string, branch: string, now: number): number {
    return this.safe(() => {
      this.settle(now);
      this.learning.get(repo.toLowerCase())?.delete(branch);
      const earlier = this.cued(repo, branch);
      this.slots = this.slots.filter((slot) => !earlier.includes(slot));
      return earlier.length;
    }, 0);
  }

  // The repo's branch's cue slots that no run has taken yet.
  private cued(repo: string, branch: string) {
    const prefix = `${repo.toLowerCase()}/.github/workflows/`;
    return this.slots.filter(
      (slot) =>
        slot.branch === branch && slot.key?.toLowerCase().startsWith(prefix),
    );
  }

  // The keys a cue starts. A key is a workflow and its event, so each of a
  // workflow's events has its own history and guards, and a guarded key
  // starts nothing. A push key starts when it ran on the branch, or on more
  // than one. A pull_request key starts when one of its runs was for a PR
  // from the branch (a run's ref names only its PR, `refs/pull/<n>/merge`,
  // so the branch is looked up);
  // with no branch looked up at all, it starts on every cue of its repo.
  // When the CLI read whether the branch has a PR (`pr`), that decides
  // instead: its pull_request keys start only for `y`, all of them unless
  // one has run for the branch's PR already (then those that have, as path
  // or base filters may exclude the rest), and a repo with no learned key
  // of that kind starts nothing.
  // The cue guard, like the precision guard, stops a key whose cue slots
  // runs took less than 60 % of, over 20 or more; every CUE_PROBE-th cue
  // still starts it, so it keeps scoring and can come back.
  // `probeSkipped` collects every key this round gets no new slot for but
  // whose decision isn't this cue's to make, so cue() leaves whatever it
  // already has alone, untouched and unscored, same as a key still
  // mid-wait for its own probe turn: one that's become precision-guarded
  // (T2/T3's own, separate guard), or a pull_request key this call's `pr`
  // is merely uncertain ('?') about, as opposed to a definite 'n', as
  // well as one still throttled by the cue guard's own probe counter.
  // Everything else — a prefix mismatch, a push key that didn't run, or a
  // pull_request key `pr` definitely rules out — has nothing left to wait
  // for, so cue() drops and scores it like a visited key's.
  private *cueKeys(
    repo: string,
    branch: string,
    pr: 'y' | 'n' | '?',
    probeSkipped: Set<string>,
  ) {
    const prefix = `${repo.toLowerCase()}/.github/workflows/`;
    const known = [...this.keys].some(
      ([key, state]) =>
        key.toLowerCase().startsWith(prefix) &&
        key.endsWith(' pull_request') &&
        state.branches.has(branch),
    );
    for (const [key, state] of this.keys) {
      const lower = key.toLowerCase();
      if (!lower.startsWith(prefix)) continue;
      if (isGuarded(state)) {
        probeSkipped.add(key);
        continue;
      }
      const ran = state.branches.has(branch);
      const push = lower.endsWith(' push') && (ran || state.branches.size >= 2);
      const pullKey = lower.endsWith(' pull_request');
      const pull =
        pullKey &&
        (pr === '?'
          ? ran || state.branches.size === 0
          : pr === 'y' && (ran || !known));
      if (!push && !pull) {
        if (pullKey && pr === '?') probeSkipped.add(key);
        continue;
      }
      const missing =
        state.cueScored >= GUARD_MIN_PREDICTED &&
        state.cueTaken / state.cueScored < GUARD_PRECISION;
      if (missing && ++state.cueSkipped % CUE_PROBE !== 0) {
        probeSkipped.add(key);
        continue;
      }
      yield [key, state] as const;
    }
  }

  // A runner of the label started its VM Job in `startMs` and, when its job
  // was waiting for it, registered and took it in `registerMs`.
  booted(label: string, startMs: number | null, registerMs: number | null) {
    this.safe(() => {
      const boots = this.boots.get(label) ?? { starts: [], registers: [] };
      this.boots.set(label, boots);
      if (startMs !== null)
        boots.starts = [...boots.starts, startMs].slice(-BOOTS_KEPT);
      if (registerMs !== null) {
        boots.registers = [...boots.registers, registerMs].slice(-BOOTS_KEPT);
      }
    }, undefined);
  }

  // The label's expected boot: a runner starts at the push's expected time
  // less this. `p` is the rank over the label's last BOOTS_KEPT starts and
  // registrations, 0.5 (the median) for history predictions, and
  // CUE_PERCENTILE for a cue, which can't rely on a later job to cover a
  // slow boot.
  boot(label: string, p = 0.5): number {
    const boots = this.boots.get(label);
    if (!boots?.starts.length) return BOOT_MS;
    const all = [...this.boots.values()].flatMap((b) => b.registers);
    const register = boots.registers.length
      ? bootRank(boots.registers, p)
      : all.length
        ? bootRank(all, p)
        : REGISTER_MS;
    return bootRank(boots.starts, p) + register;
  }

  // A cue slot's expiry, and the inverse: when it should be ready
  // (`activeAt` plus its boot), recovered from `expiresAt` instead of a
  // stored field. The two stay in sync by construction, through this one
  // pair, rather than by a comment at each of their call sites.
  private cueExpiresAt(activeAt: number, boot: number): number {
    return activeAt + boot + CUE_IDLE_MS;
  }
  private cueReadyAt(slot: Pick<Slot, 'expiresAt'>): number {
    return slot.expiresAt - CUE_IDLE_MS;
  }

  status(): PlannerStatus {
    const guarded = this.safe(
      () => [...this.keys.values()].filter(isGuarded).length,
      0,
    );
    const keys = [...this.keys.values()].filter((k) => k.runs.length).length;
    return { keys, guarded, off: this.off };
  }

  // Test-only: the cue guard's counters, by key, for the invariant
  // property test above `Key`. Not read by production code.
  debugCueGuard(): Map<string, { cueScored: number; cueTaken: number }> {
    return new Map(
      [...this.keys].map(([key, s]) => [
        key,
        { cueScored: s.cueScored, cueTaken: s.cueTaken },
      ]),
    );
  }

  // Test-only: a snapshot of the slots in flight, for the same property
  // test. `ref` is each slot's own object, stable across calls so a test
  // can tell which one a later step removed or took; the other fields
  // are copied out at call time, since `cue()` mutates a kept slot's
  // `run` and a taken slot's `key` in place, which a snapshot read later
  // would otherwise see as already changed.
  debugSlots(): {
    ref: object;
    key?: string;
    branch?: string;
    label: string;
    run: number;
    activeAt: number;
    expiresAt: number;
    cue: boolean;
  }[] {
    return this.slots.map((slot) => ({
      ref: slot,
      key: slot.key,
      branch: slot.branch,
      label: slot.label,
      run: slot.run,
      activeAt: slot.activeAt,
      expiresAt: slot.expiresAt,
      cue: slot.cue === true,
    }));
  }

  // Test-only: the keys the last cue() call visited (yielded by
  // cueKeys()), for the same property test to check that a key it
  // didn't visit was left alone — cueKeys()'s own skip bookkeeping
  // (cueSkipped) has no other way to observe from outside.
  debugLastVisited(): ReadonlySet<string> {
    return this.lastVisited;
  }

  // Test-only: the keys the last cue() call left alone — still
  // cue-guarded (its probe counter), precision-guarded, or pr-uncertain —
  // narrower than debugLastVisited()'s complement, which also includes
  // keys dropped for a definite mismatch.
  debugProbeSkipped(): ReadonlySet<string> {
    return this.lastProbeSkipped;
  }

  // Any error leaves the scaler reactive, as without a planner.
  private safe<T>(fn: () => T, fallback: T): T {
    if (this.off) return fallback;
    try {
      return fn();
    } catch (error) {
      this.off = true;
      this.slots = [];
      this.log('planner failed; scaling reactively', error);
      return fallback;
    }
  }

  private log(msg: string, error: unknown) {
    this.note({ msg, error: String(error) });
  }

  // A cue slot's steps are logged so a late cue can be explained: its
  // start, its push's run taking it and its expiry. `run` is the cue's
  // number, negative, until a run takes the slot; the
  // workflow and branch join an untaken one to its `cue` line.
  private note(entry: Parameters<Log>[0]) {
    try {
      this.deps.log(entry);
    } catch {
      // The log is advice; the scaler goes on.
    }
  }

  private see(label: string, message: JobMessage, now: number): void {
    this.settle(now);
    const id = message.workflowRunId;
    if (!id || !message.jobId) return;
    let run = this.runs.get(id);
    if (!run) {
      const key = keyOf(message);
      if (!key) return;
      run = this.plan(id, key, message, now);
    }
    if (run.settled) return;
    run.lastAt = now;
    let job = run.jobs.get(message.jobId);
    if (!job) {
      job = {
        name: message.jobDisplayName,
        label,
        // GitHub sends no queueTime; its assign time is on GitHub's clock,
        // as its finish times and W2's history are.
        queuedAt: message.queueTime ?? message.scaleSetAssignTime ?? now,
        startedAt: null,
        finishedAt: null,
        assigned: false,
      };
      run.jobs.set(message.jobId, job);
    }
    // Batches are redelivered until deleted, so each step counts once.
    switch (message.messageType) {
      case 'JobAssigned':
        // Assigned is when TotalAssignedJobs counts the job: its slot goes
        // then, so desired doesn't move and the slot's runner takes it.
        if (job.assigned) return;
        job.assigned = true;
        if (label === run.trigger) run.trigger = undefined;
        else this.spend(id, label, now);
        return;
      case 'JobStarted':
        if (job.startedAt !== null) return;
        job.startedAt = message.runnerAssignTime ?? now;
        for (const [l, n] of run.children.get(job.name) ?? []) {
          for (let i = 0; i < n; i++) this.addSlot(id, l, now, now);
        }
        return;
      case 'JobCompleted':
        if (job.finishedAt !== null) return;
        job.finishedAt = message.finishTime ?? now;
        if (!['succeeded', 'skipped'].includes(message.result.toLowerCase())) {
          run.closed = true;
          this.slots = this.slots.filter((s) => s.run !== id);
        }
        return;
      case 'JobAvailable':
        return;
    }
  }

  // A new run, at its first job (the trigger): combo timing, T3 with 5 runs
  // of history, else T2, else nothing.
  private plan(id: number, key: string, message: JobMessage, now: number) {
    const { state } = this.key(key, refOf(message), now);
    const branch = /@refs\/heads\/(.+)$/.exec(message.jobWorkflowRef)?.[1];
    if (branch) ranOn(state, branch);
    const pull = /@refs\/pull\/(\d+)\/merge$/.exec(message.jobWorkflowRef)?.[1];
    const pr = message.eventName === 'pull_request';
    const head =
      pull && pr
        ? this.pullBranch(state, message, Number(pull), now)
        : undefined;
    // A run first heard of past its offer, or in the warm-up but queued
    // before the start, may have begun before this listener: it's neither
    // planned nor learned. GitHub offers
    // a scale set's jobs as JobAssigned, with no JobAvailable before it
    // (diagnose run 42504211142), so either is an offer.
    // In the warm-up, one queued after the start is fresh too, unless the
    // key's learned first waves never had its job: then it's
    // a later job of a run that began before.
    // GitHub's clock against the listener's: a few seconds' skew only
    // moves which runs at the very start count.
    const queued = message.queueTime ?? message.scaleSetAssignTime;
    const starts = state.starters.flat();
    const fresh =
      (message.messageType === 'JobAvailable' ||
        message.messageType === 'JobAssigned') &&
      (now - this.since >= WARMUP_MS ||
        (queued !== null &&
          queued >= this.since &&
          (!starts.length || starts.includes(message.jobDisplayName))));
    const predicted = new Map<string, number>();
    for (const [label] of fresh ? items(state.runs) : []) {
      predicted.set(label, (predicted.get(label) ?? 0) + 1);
    }
    const use = !fresh || isGuarded(state) ? [] : state.runs;
    const mode: Mode =
      use.length >= MIN_T3_RUNS ? 'T3' : use.length ? 'T2' : null;
    const trigger = mostCommon(state.runs.map((steps) => steps[0]!.label));
    // The push's newest cue's slots become a planned run's: its jobs'
    // assignments spend them, the trigger's too, so none goes before GitHub
    // counts its job. An unplanned run's jobs spend nothing, so they, and
    // an older cue's, stay until they expire.
    // A pull_request run takes its PR's branch's cue, or, before that
    // branch is looked up, the key's newest pull_request cue, whichever
    // branch it named.
    // Its push came: a cue backfilling the repo isn't planned again for it.
    // A PR whose branch is still being looked up ends it once that answers.
    if (fresh) {
      const ran = branch ?? head;
      if (ran) this.pushed(key, ran);
      else if (pull && pr) {
        const pullId =
          `${message.ownerName}/${message.repositoryName}#${pull}`.toLowerCase();
        // Only while a lookup is in flight, which clears it.
        if (this.pulls.get(pullId) instanceof Set) {
          this.freshPulls.set(pullId, key);
        }
      }
    }
    const pending = this.slots.filter(
      (slot) =>
        fresh &&
        slot.key === key &&
        (slot.branch === (branch ?? head) ||
          (pr && head === undefined && slot.branch !== undefined)),
    );
    const newest = Math.min(...pending.map((slot) => slot.run));
    const cued = pending.filter((slot) => slot.run === newest);
    // The trigger spends a cue slot only when the cue has one on its label.
    const covered =
      trigger !== undefined && cued.some((slot) => slot.label === trigger);
    state.cueTaken += cued.length;
    state.cueScored += cued.length;
    if (cued.length) {
      // Its last runner, by each slot's stored boot: negative when they
      // should all have been ready that long ago. A slot not started yet
      // boots from now, as `up` below says.
      const ready = Math.max(
        ...cued.map(
          (slot) => this.cueReadyAt(slot) - Math.max(0, slot.activeAt - now),
        ),
      );
      this.note({
        msg: 'cue taken',
        cue: newest,
        ...cueOf(cued[0]!),
        run: id,
        slots: cued.length,
        readyInMs: ready - now,
      });
    }
    for (const slot of cued) {
      slot.run = id;
      delete slot.key;
      delete slot.branch;
    }
    const run: Run = {
      key,
      trigger: covered ? undefined : trigger,
      jobs: new Map(),
      lastAt: now,
      closed: false,
      settled: !fresh,
      fresh,
      heardAt: now,
      waved: !fresh,
      children: mode === 'T2' ? children(use) : new Map(),
      predicted,
    };
    this.runs.set(id, run);
    // Descendants queue after their trigger waits for a runner: a boot, or
    // for a cued run what's left of its own slot's frozen boot (its
    // `activeAt` plus the boot it was given, recovered through the same
    // `cueExpiresAt` formula `cue()` built it with, never changed after
    // even when kept on a re-cue), not whatever the label's boots have
    // moved to since. A cue slot not started yet goes at the trigger's
    // assignment, so that trigger boots in full.
    const up = cued
      .filter((slot) => slot.label === trigger && slot.activeAt <= now)
      .map((slot) => this.cueReadyAt(slot) - now);
    const wait = (label: string) =>
      up.length ? Math.max(0, Math.min(...up)) : this.boot(label);
    const hist = use.map((steps) =>
      steps.map((st) =>
        st.parent === ROOT
          ? st
          : { ...st, offset: st.offset + wait(steps[0]!.label) },
      ),
    );
    const planned: [string, number][] = [
      ...(mode === 'T3'
        ? items(hist).map(([label, offset]): [string, number] => [
            label,
            now + offset - this.boot(label),
          ])
        : []),
      ...(run.children.get(null) ?? []).flatMap(([label, n]) =>
        Array.from({ length: n }, (): [string, number] => [label, now]),
      ),
    ].sort((a, b) => a[1] - b[1]);
    // The cue's slots already cover the first wave: the trigger, then the
    // earliest slots the plan adds per label.
    const cover = new Map<string, number>();
    for (const slot of cued) {
      cover.set(slot.label, (cover.get(slot.label) ?? 0) + 1);
    }
    if (covered) cover.set(trigger, cover.get(trigger)! - 1);
    for (const [label, at] of planned) {
      const left = cover.get(label) ?? 0;
      if (left > 0) cover.set(label, left - 1);
      else this.addSlot(id, label, at, now);
    }
    return run;
  }

  // A slot for the run's label, active from `at` (or now) until its runner
  // has idled IDLE_MS.
  private addSlot(run: number, label: string, at: number, now: number) {
    if (this.runs.get(run)?.closed) return;
    const activeAt = Math.max(now, at);
    this.slots.push({
      run,
      label,
      activeAt,
      expiresAt: activeAt + this.boot(label) + IDLE_MS,
    });
  }

  // The run's earliest unexpired slot of the label: an active one, else one
  // not started yet, which then never starts.
  private spend(run: number, label: string, now: number) {
    const mine = this.slots.filter(
      (s) => s.run === run && s.label === label && now < s.expiresAt,
    );
    const slot = mine.find((s) => s.activeAt <= now) ?? mine[0];
    if (slot) this.slots = this.slots.filter((s) => s !== slot);
  }

  // Learns the finished runs, drops expired slots and forgets old runs.
  private settle(now: number) {
    // A cue slot no run took scores a miss for the cue guard.
    for (const s of this.slots) {
      if (s.key !== undefined && s.expiresAt <= now) {
        const state = this.keys.get(s.key);
        if (state) state.cueScored++;
        // Seen at the next message, so `at` says when.
        this.note({
          msg: 'cue slot expired',
          label: s.label,
          run: s.run,
          ...cueOf(s),
          at: s.expiresAt,
        });
      }
    }
    this.slots = this.slots.filter((s) => now < s.expiresAt);
    for (const [id, run] of this.runs) {
      if (now - run.lastAt >= FORGET_MS) {
        this.runs.delete(id);
        continue;
      }
      if (!run.waved && now - run.heardAt >= WAVE_MS) {
        run.waved = true;
        const state = this.keys.get(run.key);
        if (state) {
          const jobs = [...run.jobs.values()];
          state.waves = [...state.waves, waveOf(jobs)].slice(-HISTORY_RUNS);
          state.starters = [...state.starters, waveNames(jobs)].slice(
            -HISTORY_RUNS,
          );
        }
      }
      if (run.settled || now - run.lastAt < SETTLE_MS) continue;
      if ([...run.jobs.values()].some((job) => job.finishedAt === null)) {
        continue;
      }
      run.settled = true;
      const steps = learn([...run.jobs.values()]);
      run.jobs.clear();
      const state = this.keys.get(run.key);
      if (!steps || !state) continue;
      state.runs = [...state.runs, steps].slice(-HISTORY_RUNS);
      for (const [label, n] of run.predicted) {
        const actual = steps.slice(1).filter((s) => s.label === label).length;
        state.hits += Math.min(n, actual);
        state.predicted += n;
      }
    }
  }

  // The key's state, most recently used last; an unseen key starts its
  // backfill.
  private key(
    key: string,
    ref: WorkflowRef | undefined,
    now: number,
    // A cue's backfill of a workflow no job message named yet.
    probe = false,
  ): { state: Key; backfill?: Promise<void> } {
    const state = this.keys.get(key) ?? {
      runs: [],
      waves: [],
      starters: [],
      branches: new Set(),
      backfill: 'none',
      backfilled: new Set(),
      hits: 0,
      predicted: 0,
      cueTaken: 0,
      cueScored: 0,
      cueSkipped: 0,
    };
    this.keys.delete(key);
    this.keys.set(key, state);
    if (this.keys.size > MAX_KEYS) {
      this.keys.delete(this.keys.keys().next().value!);
    }
    // A key W1 has learned from needs no history, and W2 would learn its
    // runs again once settle() forgets them.
    if (
      state.backfill === 'none' &&
      !state.runs.length &&
      this.deps.history &&
      ref &&
      this.reserve(reservation(probe), now)
    ) {
      // Reserved now, so backfills started together can't cut each other
      // short.
      return {
        state,
        backfill: this.backfill(state, ref, now, probe).catch(() => undefined),
      };
    }
    return { state };
  }

  // Whether `n` more of the hour's W2 calls fit.
  private fits(n: number, now: number): boolean {
    this.calls = this.calls.filter((at) => now - at < HOUR_MS);
    return this.calls.length + n <= BACKFILL_CALLS_PER_HOUR;
  }

  // A fresh run of the key on `branch`: the cue backfilling its repo isn't
  // planned again for that branch.
  private pushed(key: string, branch: string) {
    this.learning.get(key.split('/.github/')[0]!.toLowerCase())?.delete(branch);
  }

  // Takes `n` of the hour's W2 calls, or none when they don't fit.
  private reserve(n: number, now: number): boolean {
    if (!this.fits(n, now)) return false;
    this.calls.push(...Array<number>(n).fill(now));
    return true;
  }

  // W2 for a cue's repo with no key: its workflow files (one call), then
  // each one's push and pull_request history, within the same hourly
  // budget. A workflow whose newest run has no job on these labels stops
  // there, its other calls refunded, and its keys go; a key the budget
  // can't fit isn't made, so a later cue tries again. Once they answer,
  // each branch's latest cue whose push is still ahead is planned again.
  private learnRepo(repo: string, now: number): void {
    const { workflows, history } = this.deps;
    const id = repo.toLowerCase();
    if (!workflows || !history || this.learning.has(id)) return;
    if (now < (this.unused.get(id) ?? -Infinity)) return;
    this.unused.delete(id);
    const [owner, name] = repo.split('/');
    // With the key map full, no probe key fits: nothing to read.
    if (this.keys.size >= MAX_KEYS) return;
    if (!owner || !name || !this.reserve(1, now)) return;
    const cues = new Map<string, { ready: number; pr: 'y' | 'n' | '?' }>();
    this.learning.set(id, cues);
    void workflows(owner, name)
      .then(async (found) => {
        // As GitHub spells them, as job messages' workflow refs do.
        const { owner: o, repo: r, files } = found;
        const read = this.deps.now?.() ?? Date.now();
        const made: string[] = [];
        let skipped = false;
        const backfills = this.safe(
          () =>
            files.flatMap((workflow) =>
              ['push', 'pull_request'].flatMap((event) => {
                const key = `${o}/${r}/.github/workflows/${workflow} ${event}`;
                if (this.keys.has(key)) return [];
                // A probe key evicts no learned one.
                if (
                  !this.fits(reservation(true), read) ||
                  this.keys.size >= MAX_KEYS
                ) {
                  skipped = true;
                  return [];
                }
                made.push(key);
                const ref = { owner: o, repo: r, workflow, event };
                return this.key(key, ref, read, true).backfill ?? [];
              }),
            ),
          [],
        );
        await Promise.all(backfills);
        const at = this.deps.now?.() ?? Date.now();
        this.safe(() => {
          for (const key of made) {
            const runs = [...this.runs.values()];
            if (
              this.keys.get(key)?.waves.length === 0 &&
              !runs.some((run) => run.key === key)
            ) {
              this.keys.delete(key);
            }
          }
          if (skipped) this.unused.set(id, at + 10 * 60_000);
          else if (made.every((key) => !this.keys.has(key))) {
            this.unused.set(id, at + HOUR_MS);
          }
        }, undefined);
        for (const [branch, { ready, pr }] of cues) {
          if (ready <= at) continue;
          const slots = this.cue(repo, branch, ready - at, at, pr);
          this.deps.log({ msg: 'cue slots after backfill', ...slots });
          if (Object.values(slots).some(Boolean)) this.deps.replanned?.();
        }
      })
      .catch((error: unknown) =>
        this.log('planner workflows read failed; the cue waits for W1', error),
      )
      .finally(() => this.learning.delete(id));
  }

  // A pull_request run's PR's head branch, for cues: looked up once per PR
  // from its first run, within W2's hourly budget, and recorded on the keys
  // of all its runs. Returns it when it's known already, '' for a fork's PR,
  // which takes no branch's cue.
  private pullBranch(
    state: Key,
    message: JobMessage,
    pull: number,
    now: number,
  ): string | undefined {
    const { ownerName: owner, repositoryName: repo } = message;
    const id = `${owner}/${repo}#${pull}`.toLowerCase();
    const known = this.pulls.get(id);
    if (typeof known === 'string') {
      if (known) ranOn(state, known);
      return known;
    }
    if (known) {
      known.add(state);
      return undefined;
    }
    if (!this.deps.runBranch) return undefined;
    this.calls = this.calls.filter((at) => now - at < HOUR_MS);
    if (this.calls.length >= BACKFILL_CALLS_PER_HOUR) return undefined;
    this.calls.push(now);
    const waiting = new Set([state]);
    this.pulls.set(id, waiting);
    this.deps
      .runBranch(owner, repo, message.workflowRunId)
      .then((branch) => {
        const fresh = this.freshPulls.get(id);
        this.freshPulls.delete(id);
        // Evicted meanwhile: its keys learn it from the PR's next run.
        if (this.pulls.get(id) !== waiting) return;
        this.pulls.set(id, branch ?? '');
        if (this.pulls.size > MAX_PULLS) {
          this.pulls.delete(this.pulls.keys().next().value!);
        }
        if (branch) {
          this.safe(() => {
            waiting.forEach((key) => ranOn(key, branch));
            if (fresh) this.pushed(fresh, branch);
          }, undefined);
        }
      })
      .catch((error: unknown) => {
        this.freshPulls.delete(id);
        if (this.pulls.get(id) === waiting) this.pulls.delete(id);
        this.log('planner PR branch lookup failed', error);
      });
    return undefined;
  }

  // W2: the workflow's latest completed runs, older than any W1 has seen,
  // in front of what W1 learned since. A failure leaves W1 to learn alone.
  // `at` is when key() reserved its calls.
  private async backfill(
    state: Key,
    ref: WorkflowRef,
    at: number,
    probe = false,
  ) {
    state.backfill = 'pending';
    let reserved = reservation(probe);
    // A run's second page of jobs onward takes from what's left.
    const take = () => {
      if (reserved > 0) return reserved-- > 0;
      const now = this.deps.now?.() ?? Date.now();
      this.calls = this.calls.filter((at) => now - at < HOUR_MS);
      if (this.calls.length >= BACKFILL_CALLS_PER_HOUR) return false;
      this.calls.push(now);
      return true;
    };
    // What the backfill didn't use goes back to the hour's budget.
    const refund = () => {
      for (; reserved > 0; reserved--) {
        const i = this.calls.lastIndexOf(at);
        if (i >= 0) this.calls.splice(i, 1);
      }
    };
    try {
      // A job of a called (reusable) workflow, named `<caller> / <called>`,
      // is keyed by the called file's ref, so it doesn't count: its caller's
      // key would hold cue slots no run takes.
      const ours = (jobs: PastJob[]) =>
        jobs.some(
          (job) =>
            !job.name.includes(' / ') &&
            job.labels.some((l) => this.labels.has(l)),
        );
      const past = await this.deps.history!(
        ref,
        HISTORY_RUNS,
        take,
        probe ? ours : undefined,
      ).finally(refund);
      this.safe(() => {
        // A backfill that learned nothing runs again, so its runs' waves are
        // added once.
        const ours = past
          .filter(
            (run) =>
              !this.runs.get(run.id)?.fresh && !state.backfilled.has(run.id),
          )
          .reverse()
          .map((run) =>
            run.jobs.flatMap((job) => {
              const label = job.labels.find((l) => this.labels.has(l));
              // A probe's key leaves out a called workflow's jobs, as its
              // `uses` gate does.
              return label &&
                job.conclusion !== 'skipped' &&
                !(probe && job.name.includes(' / '))
                ? [{ ...job, label }]
                : [];
            }),
          );
        for (const run of past) state.backfilled.add(run.id);
        // Where they ran, for cues: a push's branch, or a PR's head branch
        // in this repo.
        for (const run of [...past].reverse()) {
          if (
            run.branch &&
            run.jobs.some((j) => j.labels.some((l) => this.labels.has(l)))
          ) {
            ranOn(state, run.branch);
          }
        }
        const learned = ours.flatMap((jobs) => {
          const steps = learn(jobs);
          return steps ? [steps] : [];
        });
        state.runs = [...learned, ...state.runs].slice(-HISTORY_RUNS);
        // A wave counts every job GitHub queued in it, as W1's counts every
        // job assigned, cancelled ones too.
        state.waves = [
          ...ours.filter((jobs) => jobs.length).map(waveOf),
          ...state.waves,
        ].slice(-HISTORY_RUNS);
        state.starters = [
          ...ours.filter((jobs) => jobs.length).map(waveNames),
          ...state.starters,
        ].slice(-HISTORY_RUNS);
      }, undefined);
    } catch (error) {
      this.log('planner backfill failed; learning from messages only', error);
      state.backfill = 'done';
      return;
    }
    // A key first seen before any run of it completed has nothing to learn
    // yet, so its next run backfills again; the hourly budget bounds it.
    state.backfill = state.runs.length ? 'done' : 'none';
  }
}

// A run's first wave: the labels of its jobs queued within 5 s of its
// first.
function waveOf(jobs: { label: string; queuedAt: number }[]): string[] {
  const first = Math.min(...jobs.map((job) => job.queuedAt));
  return jobs
    .filter((job) => job.queuedAt - first <= PARENT_GAP_MS)
    .map((job) => job.label);
}

// Its jobs' names.
function waveNames(jobs: { name: string; queuedAt: number }[]): string[] {
  const first = Math.min(...jobs.map((job) => job.queuedAt));
  return jobs
    .filter((job) => job.queuedAt - first <= PARENT_GAP_MS)
    .map((job) => job.name);
}

// The branch moves to the newest of the key's last 20.
function ranOn(state: Key, branch: string) {
  state.branches.delete(branch);
  state.branches.add(branch);
  if (state.branches.size > HISTORY_RUNS) {
    state.branches.delete(state.branches.values().next().value!);
  }
}

function mostCommon(labels: string[]): string | undefined {
  const counts = Map.groupBy(labels, (label) => label);
  return [...counts].sort((a, b) => b[1].length - a[1].length)[0]?.[0];
}

function isGuarded(key: Key): boolean {
  return (
    key.predicted >= GUARD_MIN_PREDICTED &&
    key.hits / key.predicted < GUARD_PRECISION
  );
}

// `acme/web/.github/workflows/ci.yml@refs/heads/main` and the event: every
// branch of a workflow shares its history.
function keyOf(message: JobMessage): string | undefined {
  const path = message.jobWorkflowRef.split('@')[0];
  return path ? `${path} ${message.eventName}` : undefined;
}

// The backfill's workflow, when it's the job's own repository's. A reusable
// workflow's ref names the called file, whose runs the API doesn't list.
function refOf(message: JobMessage): WorkflowRef | undefined {
  const [owner, repo, dir, sub, workflow, ...rest] = message.jobWorkflowRef
    .split('@')[0]!
    .split('/');
  const own =
    `${owner}/${repo}`.toLowerCase() ===
    `${message.ownerName}/${message.repositoryName}`.toLowerCase();
  return own &&
    dir === '.github' &&
    sub === 'workflows' &&
    workflow &&
    !rest.length
    ? { owner: owner!, repo: repo!, workflow, event: message.eventName }
    : undefined;
}

// A run's jobs that ran, in queue order (by name on a tie), each with its
// parent and its offset from the trigger's queue time. A descendant's offset
// is normalized to a trigger that took a job at once, so a trigger that
// started sooner or later doesn't move what's learned; T3 adds the trigger's
// expected boot back.
export function learn(jobs: Job[]): Step[] | undefined {
  const ran = jobs
    .filter((job) => job.startedAt !== null && job.finishedAt !== null)
    .sort(
      (a, b) =>
        a.queuedAt - b.queuedAt ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
  const trigger = ran[0];
  if (!trigger) return undefined;
  const delta = trigger.queuedAt - trigger.startedAt!;
  return ran.map((job, i) => {
    let parent = ROOT;
    for (let p = 0; p < i; p++) {
      const done = ran[p]!.finishedAt!;
      if (
        done <= job.queuedAt + 1000 &&
        job.queuedAt - done <= PARENT_GAP_MS &&
        (parent === ROOT || done > ran[parent]!.finishedAt!)
      ) {
        parent = p;
      }
    }
    const offset = job.queuedAt - trigger.queuedAt;
    return {
      name: job.name,
      label: job.label,
      offset: parent === ROOT ? offset : offset + delta,
      parent,
    };
  });
}

function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

// `boot`'s own rank `p` over the values: deliberately not an alias for
// `nearestRank` (`timings.ts`), which this isn't interchangeable with at
// p = 0.5 (it picks the lower of the two middle values on an even count,
// where this averages them). T2/T3's p = 0.5 gets the exact median, so
// they're unchanged by this file adding a cue's own, higher p.
function bootRank(values: number[], p: number): number {
  return p === 0.5
    ? median(values)
    : nearestRank(
        [...values].sort((a, b) => a - b),
        p,
      );
}

// Half rounds up; none is 0.
const medianInt = (values: number[]) =>
  values.length ? Math.floor(median(values) + 0.5) : 0;

const sortedLabels = (steps: Step[]) =>
  [...new Set(steps.map((s) => s.label))].sort();

// T3's slots: per label, the median count of the runs' later jobs, the i-th
// at the median of the runs' i-th offsets.
export function items(hist: Step[][]): [string, number][] {
  return sortedLabels(hist.flatMap((run) => run.slice(1))).flatMap((label) => {
    const per = hist.map((run) =>
      run
        .slice(1)
        .filter((s) => s.label === label)
        .map((s) => s.offset)
        .sort((a, b) => a - b),
    );
    const n = medianInt(per.map((offsets) => offsets.length));
    return Array.from({ length: n }, (_, i): [string, number] => [
      label,
      median(per.filter((o) => o.length > i).map((o) => o[i]!)),
    ]);
  });
}

// A cue's slots: per label, the median count of the runs' first waves' jobs
// (the trigger and the jobs queued within 5 s of it). A later root, such as
// one after an approval, is left to T3.
export function firstWave(waves: string[][]): [string, number][] {
  return [...new Set(waves.flat())]
    .sort()
    .flatMap((label): [string, number][] => {
      const n = medianInt(
        waves.map((w) => w.filter((l) => l === label).length),
      );
      return n > 0 ? [[label, n]] : [];
    });
}

// T2's slots: per parent job name (null for the trigger's sibling roots), the
// median count of its children per label over the runs it ran in.
export function children(hist: Step[][]): Children {
  const names = new Set<string | null>([null]);
  for (const run of hist) {
    for (const s of run.slice(1)) {
      if (s.parent !== ROOT) names.add(run[s.parent]!.name);
    }
  }
  const out: Children = new Map();
  for (const name of names) {
    const runs =
      name !== null
        ? hist.filter((run) => run.some((s) => s.name === name))
        : hist;
    const labels = sortedLabels(runs.flatMap((run) => run.slice(1)));
    const counts = labels.map((label): [string, number] => [
      label,
      medianInt(
        runs.map(
          (run) =>
            run
              .slice(1)
              .filter(
                (s) =>
                  s.label === label &&
                  (name !== null
                    ? s.parent !== ROOT && run[s.parent]!.name === name
                    : s.parent === ROOT),
              ).length,
        ),
      ),
    ]);
    out.set(
      name,
      counts.filter(([, n]) => n > 0),
    );
  }
  return out;
}
