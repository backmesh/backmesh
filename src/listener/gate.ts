// The public-repository gate:
// a fork's pull request in a public repository is untrusted, and runs only on
// `backmesh-ubuntu-2404-public-<n>vcpu`. GitHub assigns a job before the listener hears of
// it, so the gate can't hold one back: it leaves untrusted and unclassified
// jobs out of their set's desired count, force-cancels an untrusted run
// through the Worker's /v1/cancel (the listener's token reads Actions only,
// owner 2026-11-19), and terminates any runner on another label that starts
// one of its jobs. A
// sweep of the public repositories' active runs covers what a restart's lost
// messages miss.
import type { Note, WorkflowRun } from '../github/checks.js';
import type { Log } from '../github/retry.js';
import type { GateGitHub } from '../github/runs.js';
import type { JobMessage } from '../github/types.js';
import type { Route } from './routes.js';

export const PR_EVENTS = [
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
];
const DAY_MS = 24 * 3_600_000;
export const SWEEP_MS = 5 * 60_000;
const CANCEL_MS = 60_000;
// After a cancel, GitHub stops counting the run's jobs: they count again
// then, in case no JobCompleted comes for one that never started.
const RELEASE_MS = 2 * 60_000;
// An untrusted run's job on a public label runs at most this long; its
// runner's Job is terminated this long after the cancel if it's still
// running.
export const LIMIT_MS = 60 * 60_000;
const LIMIT_GRACE_MS = 5 * 60_000;

export interface GateDeps {
  github: GateGitHub;
  note: (run: WorkflowRun, note: Note) => Promise<void>;
  // Ends a runner's Job.
  terminate: (runner: string) => Promise<void>;
  // A runner this install minted for a scale set that isn't public, and one
  // for a public set.
  privateRunner: (name: string) => boolean;
  publicRunner: (name: string) => boolean;
  // The install's labels that aren't public, and those that are.
  privateLabels: ReadonlySet<string>;
  publicLabels: readonly string[];
  // A run classified trusted: its jobs count again.
  changed: () => void;
  // A trusted run's messages the planner missed while it was held, in order.
  replay: (label: string, job: JobMessage) => void;
  log: Log;
  now?: () => number;
}

interface RunState {
  run: WorkflowRun;
  at: number;
  trusted?: boolean;
  // Trusted for its repository's visibility, which the move may flip.
  privateRepo?: boolean;
  // Its messages while unclassified, for the planner once it's trusted.
  heard: { label: string; job: JobMessage }[];
  reading?: boolean;
  // When a read last failed: the next tick reads again.
  failed?: boolean;
  // A job on a label that isn't public, for the note.
  asked?: { job: string; label: string };
  cancelledAt?: number;
  // When a cancel last went through.
  cancelled?: number;
  // The cancel was refused, so no more tries.
  refused?: boolean;
  // Runners on a label that isn't public that started one of its jobs.
  runners: Set<string>;
  // Past the runtime limit: a later public job of the run ends as it starts.
  limited?: boolean;
  evicted: Set<string>;
}

const keyOf = ({ owner, repo, runId }: WorkflowRun) =>
  `${owner}/${repo}/${runId}`.toLowerCase();
const runOf = (job: JobMessage): WorkflowRun => ({
  owner: job.ownerName,
  repo: job.repositoryName,
  runId: job.workflowRunId,
});
const jobKey = (job: JobMessage) =>
  `${keyOf(runOf(job))}/${job.jobId || job.jobDisplayName}`;

export class Gate {
  private readonly runs = new Map<string, RunState>();
  // Jobs left out of their set's desired count, with their set's code.
  private readonly held = new Map<string, { code: string; key: string }>();
  // Each repository's visibility, from the sweep's listing: at most 5
  // minutes old, so a repository the move made public is known within one
  // sweep.
  private visibility = new Map<string, boolean>();
  // Runners on public sets busy with a pull-request job, from its
  // JobStarted or the sweep's `started_at`, for the runtime limit.
  private readonly timed = new Map<
    string,
    { key: string; job: string; label: string; at: number; limited?: number }
  >();
  private sweptAt = -Infinity;
  private ticking: Promise<void> | undefined;

  constructor(private readonly deps: GateDeps) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  // Every message, before the scaler's.
  observe(route: Route, job: JobMessage): void {
    if (!PR_EVENTS.includes(job.eventName) || !job.workflowRunId) return;
    const run = runOf(job);
    const key = keyOf(run);
    // A public set's jobs all count; an untrusted run's are timed, from
    // GitHub's assign time, or the sweep's `started_at` if it seeded the
    // runner first.
    if (route.public) {
      if (job.messageType === 'JobCompleted') this.timed.delete(job.runnerName);
      if (job.messageType !== 'JobStarted' || !job.runnerName) return;
      const limited = this.runs.get(key);
      if (limited?.limited) {
        void this.evict(limited, job.runnerName, 'runtime limit terminate');
        return;
      }
      if (!this.timed.has(job.runnerName)) {
        this.timed.set(job.runnerName, {
          key,
          job: job.jobDisplayName,
          label: route.label,
          at: job.runnerAssignTime ?? this.now(),
        });
      }
      const state = this.state(run);
      if (state.trusted === undefined && !state.reading) {
        void this.classify(state);
      }
      return;
    }
    const completed = job.messageType === 'JobCompleted';
    if (completed) this.held.delete(jobKey(job));
    // A completion of a run this listener never heard of isn't held.
    const state = completed ? this.runs.get(key) : this.state(run);
    if (!state || state.trusted) return;
    if (state.trusted === undefined) {
      state.heard.push({ label: route.label, job });
    }
    if (completed) return;
    state.asked ??= { job: job.jobDisplayName, label: route.label };
    this.held.set(jobKey(job), { code: route.code, key });
    if (job.messageType === 'JobStarted' && job.runnerName) {
      state.runners.add(job.runnerName);
    }
    if (state.trusted === false) void this.untrusted(state);
    else if (!state.reading) void this.classify(state);
  }

  // Whether the job's run isn't known trusted: its messages skip the planner,
  // and a trusted run's are replayed to it once classified.
  holds(job: JobMessage): boolean {
    const state = this.runs.get(keyOf(runOf(job)));
    return (
      PR_EVENTS.includes(job.eventName) && !!state && state.trusted !== true
    );
  }

  // The set's jobs left out of its desired count.
  heldOn(code: string): number {
    let n = 0;
    for (const held of this.held.values()) if (held.code === code) n++;
    return n;
  }

  // Each reconcile: failed reads again, and the sweep when it's due. One at
  // a time; never throws.
  tick(): Promise<void> {
    this.ticking ??= this.tock().finally(() => (this.ticking = undefined));
    return this.ticking;
  }

  private async tock() {
    const now = this.now();
    for (const [key, state] of this.runs) {
      const released =
        state.cancelled !== undefined && now - state.cancelled >= RELEASE_MS;
      if (now - state.at >= DAY_MS) this.runs.delete(key);
      else if (!released) continue;
      this.release(key);
    }
    for (const state of this.runs.values()) {
      if (state.failed && !state.reading) await this.classify(state);
    }
    if (now - this.sweptAt >= SWEEP_MS) {
      this.sweptAt = now;
      await this.sweep();
    }
    await this.limit(this.now());
  }

  // An untrusted run's job past the limit on a public label: the run is
  // force-cancelled with a note, and every one of its public runners' Jobs
  // terminated if still running 5 minutes later. Trusted runs are never
  // acted on.
  private async limit(now: number) {
    for (const [runner, timed] of this.timed) {
      const state = this.runs.get(timed.key);
      if (!state) {
        this.timed.delete(runner);
        continue;
      }
      if (state.trusted !== false) continue;
      if (timed.limited === undefined) {
        if (now - timed.at < LIMIT_MS) continue;
        // The cancel is the run's: its other jobs end with this one, and
        // one that starts later ends at once.
        for (const other of this.timed.values()) {
          if (other.key === timed.key) other.limited ??= now;
        }
        state.limited = true;
        // A limit cancel the Worker refuses isn't tried again (only the
        // label path is): the runners end at the grace either way.
        this.deps.log({ msg: 'runtime limit', run: timed.key, runner });
        await this.cancel(state, 'limit', {
          name: `runtime limit in run ${state.run.runId}`,
          title: 'Runtime limit',
          summary: `\`${timed.job}\` ran on \`${timed.label}\` for 60 minutes, the limit for pull requests from forks, so backmesh cancelled the run.`,
        });
      } else if (now - timed.limited >= LIMIT_GRACE_MS) {
        this.timed.delete(runner);
        await this.evict(state, runner, 'runtime limit terminate');
      }
    }
  }

  // Force-cancels the run and posts its note; false when the cancel failed.
  private async cancel(
    state: RunState,
    reason: 'label' | 'limit',
    note: Note,
  ): Promise<boolean> {
    const { run } = state;
    try {
      await this.deps.github.forceCancel(run, reason);
    } catch (error) {
      // Refused (the Worker's 403, such as for a run it doesn't see as a
      // fork's), its jobs stay uncounted and are ended as they start, and
      // the run isn't tried again.
      // `not_gated` is the Worker not seeing the limit yet, by its clock:
      // tried again.
      const { status, code } = error as { status?: number; code?: string };
      state.refused = status === 403 && code !== 'not_gated';
      this.deps.log({
        msg: 'fork run cancel failed',
        run: keyOf(run),
        error: String(error),
      });
      return false;
    }
    await this.deps.note(run, note).catch((error: unknown) =>
      this.deps.log({
        msg: 'note failed',
        run: keyOf(run),
        error: String(error),
      }),
    );
    return true;
  }

  private state(run: WorkflowRun): RunState {
    const key = keyOf(run);
    let state = this.runs.get(key);
    if (!state) {
      state = {
        run,
        at: this.now(),
        heard: [],
        runners: new Set(),
        evicted: new Set(),
      };
      this.runs.set(key, state);
    }
    return state;
  }

  // A repository the sweep listed as private is trusted without a run read;
  // the run read tells any other's visibility.
  private async classify(state: RunState) {
    const { owner, repo } = state.run;
    state.reading = true;
    try {
      if (this.visibility.get(`${owner}/${repo}`.toLowerCase())) {
        state.trusted = state.privateRepo = true;
      } else {
        const run = await this.deps.github.run(state.run);
        state.trusted = run.private || !run.fork;
        state.privateRepo = run.private;
      }
      state.failed = false;
    } catch (error) {
      state.failed = true;
      this.deps.log({
        msg: 'run read failed; its pull-request jobs wait',
        run: keyOf(state.run),
        error: String(error),
      });
      return;
    } finally {
      state.reading = false;
    }
    const heard = state.heard;
    state.heard = [];
    if (!state.trusted) return this.untrusted(state);
    this.release(keyOf(state.run));
    for (const { label, job } of heard) this.deps.replay(label, job);
    this.deps.changed();
  }

  private release(key: string) {
    for (const [job, held] of this.held) {
      if (held.key === key) this.held.delete(job);
    }
  }

  // Cancels the run, at most once a minute, and ends its runners on labels
  // that aren't public.
  private async untrusted(state: RunState) {
    for (const runner of state.runners) await this.evict(state, runner);
    const now = this.now();
    if (!state.asked || state.refused) return;
    if (state.cancelledAt !== undefined && now - state.cancelledAt < CANCEL_MS)
      return;
    state.cancelledAt = now;
    const { run } = state;
    const { job, label } = state.asked;
    const labels = this.deps.publicLabels.map((l) => `\`${l}\``).join(' or ');
    const cancelled = await this.cancel(state, 'label', {
      name: `fork run ${run.runId}`,
      title: 'Fork run cancelled',
      summary: `\`${job}\` asked for \`${label}\`. In this public repository, pull requests from forks run only on ${labels || 'no backmesh label'}, so backmesh cancelled the run. Use one of them, or a GitHub-hosted runner.`,
    });
    if (!cancelled) return;
    state.cancelled = now;
    this.deps.log({ msg: 'fork run cancelled', run: keyOf(run), job, label });
  }

  private async evict(
    state: RunState,
    runner: string,
    msg = 'untrusted job on a private label',
  ) {
    if (state.evicted.has(runner)) return;
    state.evicted.add(runner);
    this.deps.log({
      msg,
      run: keyOf(state.run),
      runner,
    });
    await this.deps.terminate(runner).catch((error: unknown) => {
      // Ended again next time.
      state.evicted.delete(runner);
      this.deps.log({
        msg: 'terminate failed; retrying',
        runner,
        error: String(error),
      });
    });
  }

  // The public repositories' queued and in-progress fork runs: each one
  // with a job on a label that isn't public is cancelled, and this install's
  // runners on those labels that run its jobs end.
  private async sweep() {
    const { github, log } = this.deps;
    let repos;
    try {
      repos = await github.repos();
    } catch (error) {
      // A stale listing could trust a repository made public since.
      this.visibility = new Map();
      log({ msg: 'sweep failed', error: String(error) });
      return;
    }
    this.visibility = new Map(
      repos.map((r) => [`${r.owner}/${r.repo}`.toLowerCase(), r.private]),
    );
    // A run trusted for a repository that's public now is read again.
    for (const [key, state] of this.runs) {
      const { owner, repo } = state.run;
      if (
        state.privateRepo &&
        this.visibility.get(`${owner}/${repo}`.toLowerCase()) === false
      ) {
        this.runs.delete(key);
      }
    }
    for (const { owner, repo } of repos.filter((r) => !r.private)) {
      let runs;
      try {
        runs = await github.activeRuns(owner, repo, PR_EVENTS);
      } catch (error) {
        log({
          msg: 'sweep failed',
          repo: `${owner}/${repo}`,
          error: String(error),
        });
        continue;
      }
      // One run's failed read skips only that run.
      for (const { runId, fork } of runs) {
        if (!fork) continue;
        try {
          const state = this.state({ owner, repo, runId });
          state.trusted = false;
          state.failed = false;
          const jobs = await github.jobs(state.run);
          for (const job of jobs) {
            if (job.done) continue;
            const label = job.labels.find((l) =>
              this.deps.privateLabels.has(l),
            );
            if (label) state.asked ??= { job: job.name, label };
            if (job.runnerName && this.deps.privateRunner(job.runnerName)) {
              state.runners.add(job.runnerName);
            }
            // A restart lost its JobStarted: the limit runs from GitHub's
            // start.
            const { runnerName, startedAt } = job;
            if (
              runnerName &&
              startedAt !== null &&
              this.deps.publicRunner(runnerName) &&
              !this.timed.has(runnerName)
            ) {
              this.timed.set(runnerName, {
                key: keyOf(state.run),
                job: job.name,
                label:
                  job.labels.find((l) => this.deps.publicLabels.includes(l)) ??
                  '',
                at: startedAt,
              });
              log({
                msg: 'runtime limit timed from the sweep',
                runner: runnerName,
              });
            }
          }
          await this.untrusted(state);
        } catch (error) {
          log({ msg: 'sweep failed', run: runId, error: String(error) });
        }
      }
    }
  }
}
