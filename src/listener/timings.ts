import type { Log } from '../github/retry.js';
import type { JobMessage } from '../github/types.js';
import {
  QUOTA_REFUSALS,
  type Refusal,
  type RunnerTimeline,
} from './runner-jobs.js';
import type { Reclaim, RetryDecision } from './scaler.js';

// Per-job rows: the record every aggregate is computed
// from on read. Each row is one JSON line in the listener's log. The last 7
// days' rows are also kept here, in memory, so a restart empties them.
export const DAY_MS = 86_400_000;
export const ROWS_KEPT_MS = 7 * DAY_MS;
// About 1 KiB each: older rows go first, and the summaries say since when.
export const MAX_ROWS = 50_000;

// What the scale-set messages say about a job: ARC's metric labels
// (`organization`, `repository`, `job_name`, `event_name`, `job_result`;
// `job_workflow_ref`), GitHub's four timestamps, and backmesh's label, the
// scale set, which ARC's labels lack. A missing timestamp is null.
export function gitHubJob(label: string, job: JobMessage) {
  return {
    label,
    jobId: job.jobId,
    runId: job.workflowRunId,
    org: job.ownerName,
    repo: job.repositoryName,
    workflowRef: job.jobWorkflowRef || null,
    job: job.jobDisplayName,
    event: job.eventName,
    runner: job.runnerName || null,
    queuedAt: job.queueTime,
    assignedAt: job.scaleSetAssignTime,
    runnerAssignedAt: job.runnerAssignTime,
    finishedAt: job.finishTime,
  };
}

// What a completed job says about its runner's boot (the planner's,
// `prewarm.ts`): its VM Job's start, submit to running, for any runner; and
// its registration, running to taking the job, only when the job was waiting
// by the time the runner was running, as a runner running earlier may have
// idled. Null without
// the marks, or for an impossible order.
export function bootSample(
  job: JobMessage,
  runner: Pick<RunnerTimeline, 'submittedAt' | 'runningAt'> | null,
) {
  const { queueTime, runnerAssignTime } = job;
  const running = runner?.runningAt ?? null;
  const gap = (from: number | null, to: number | null) =>
    from !== null && to !== null && to >= from ? to - from : null;
  const waited = queueTime !== null && running !== null && queueTime <= running;
  return {
    startMs: gap(runner?.submittedAt ?? null, running),
    registerMs: waited ? gap(running, runnerAssignTime) : null,
  };
}

// What the runner that took a job was started for: a cue's slot, a slot the
// planner predicted from history, or a job waiting for it. Runners are
// interchangeable within a label, so a cue's runner may take a predicted
// job, or another repo's, and the reverse. A cue runner whose job is assigned
// but not started still counts as filling its slot, so a cue runner held back
// by the tick or quota then may start as `predicted`.
export const STARTS = ['cue', 'predicted', 'reactive'] as const;
export type Start = (typeof STARTS)[number];

type Completed = { kind: 'job completed'; at: number } & ReturnType<
  typeof gitHubJob
> & {
    result: string;
    // The runner Job's anycloud timeline, joined on the runner's name; null
    // with no runner, or when it couldn't be read.
    runnerJob: RunnerTimeline | null;
    // Null with no runner, for one another listener process started, or
    // when its Job ended before its job's completion was heard.
    start: Start | null;
    // A rerun backmesh recognized as its retry.
    retry?: true;
  };

export type JobRow =
  | Completed
  | ({ kind: 'job reclaimed'; at: number; retry: RetryDecision } & Reclaim & {
        repo: string;
        runId: number;
      })
  // The retry: one row per label of a rerun's reclaimed jobs,
  // and one per recognized retry's start, saying whether it got an
  // on-demand VM.
  | { kind: 'run rerun'; at: number; label: string; run: string }
  | {
      kind: 'retry started';
      at: number;
      label: string;
      jobId: string;
      runner: string;
      onDemand: boolean;
    }
  | {
      kind: 'runner failed to start';
      at: number;
      label: string;
      runner: string;
      // Such as "exited: Exited with code 1".
      end: string;
      // Its launches refused for quota or capacity, such as before retries
      // ran out.
      refusals: Refusal[];
    };

// Queued to a runner taking the job, split where it was assigned to the
// scale set, its runner was submitted and its VM was up with the runner's
// container started, in this order. Each runs from the mark before: a runner submitted before the job's
// assignment, for an earlier count, gives the listener 0. Null without every
// mark.
export const SEGMENTS = ['github', 'listener', 'vm', 'runner'] as const;

export function segments(row: Completed): number[] | null {
  const { queuedAt, runnerJob: r } = row;
  const marks = [
    row.assignedAt,
    r?.submittedAt ?? null,
    r?.runningAt ?? null,
    row.runnerAssignedAt,
  ];
  if (queuedAt === null || marks.includes(null)) return null;
  let prev = queuedAt;
  return marks.map((mark) => {
    const at = Math.max(prev, mark!);
    const ms = at - prev;
    prev = at;
    return ms;
  });
}

const span = (from: number | null, to: number | null) =>
  from === null || to === null ? null : to - from;

// The nearest-rank percentile `p` (0 to 1) over the values, sorted
// ascending; clamped, so an edge `p` of exactly 0 or 1 still indexes inside
// the array. Shared with `prewarm.ts`'s cue boot estimate. Every caller
// here checks `.length` first, so an empty array fails loudly instead of
// silently returning `undefined` as a `number`.
export function nearestRank(sorted: number[], p: number): number {
  if (!sorted.length) throw new Error('nearestRank: empty input');
  const i = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(p * sorted.length) - 1),
  );
  return sorted[i]!;
}

// p50 and p95 over the known values; null with none.
function percentiles(values: (number | null)[]) {
  const known = values.filter((v) => v !== null).sort((a, b) => a - b);
  return known.length
    ? { p50: nearestRank(known, 0.5), p95: nearestRank(known, 0.95) }
    : null;
}

export class JobRows {
  private readonly rows: JobRow[] = [];
  // Completed jobs kept, by job ID: a batch is redelivered until its delete
  // succeeds, so a job's completion is kept once.
  private readonly completed = new Set<string>();
  // The kept rows start here: the listener's start, or the last row dropped
  // for MAX_ROWS.
  private from: number;

  constructor(
    private readonly log: Log,
    private readonly now: () => number,
  ) {
    this.from = now();
  }

  add(row: JobRow): void {
    if (row.kind === 'job completed' && row.jobId) {
      if (this.completed.has(row.jobId)) return;
      this.completed.add(row.jobId);
    }
    const { kind, ...fields } = row;
    this.log({ msg: kind, ...fields });
    this.rows.push(row);
    const since = this.now() - ROWS_KEPT_MS;
    while (
      this.rows[0] &&
      (this.rows.length > MAX_ROWS || this.rows[0].at < since)
    ) {
      const dropped = this.rows.shift()!;
      if (dropped.at >= since) this.from = dropped.at;
      if (dropped.kind === 'job completed') {
        this.completed.delete(dropped.jobId);
      }
    }
  }

  // The label's rows over the last `windowMs`: queued to started and run
  // time, the segment that took the most of all start time, reclaimed jobs
  // and startup failures. `since` is when the rows start, if later.
  summary(label: string, windowMs: number) {
    const start = this.now() - windowMs;
    const rows = this.rows.filter((r) => r.label === label && r.at >= start);
    const jobs = rows.filter((r) => r.kind === 'job completed');
    const totals = SEGMENTS.map(() => 0);
    for (const row of jobs) {
      segments(row)?.forEach((ms, i) => (totals[i]! += ms));
    }
    const all = totals.reduce((a, b) => a + b, 0);
    const most = totals.indexOf(Math.max(...totals));
    const count = (kind: JobRow['kind']) =>
      rows.filter((r) => r.kind === kind).length;
    const started = rows.filter((r) => r.kind === 'retry started');
    const onDemand = started.filter((r) => r.onDemand).length;
    // Where the runners launched, their submit to running, and where the
    // cloud refused a launch first and why.
    const launched = Map.groupBy(jobs, (r) => r.runnerJob?.region ?? null);
    launched.delete(null);
    const runners = rows.flatMap((r) =>
      r.kind === 'job completed'
        ? [{ refusals: r.runnerJob?.refusals ?? [], timeline: r.runnerJob }]
        : r.kind === 'runner failed to start'
          ? [{ refusals: r.refusals, timeline: null }]
          : [],
    );
    const refused = runners.flatMap((r) => r.refusals);
    // The runners refused for quota at least once, where, and their wait
    // until anycloud re-queued them after their last refusal. A runner
    // that never ran has no wait.
    const forQuota = (r: { refusals: Refusal[] }) =>
      r.refusals.filter((x) => QUOTA_REFUSALS.includes(x.diagnosis));
    const quota = runners.filter((r) => forQuota(r).length);
    return {
      jobs: jobs.length,
      startMs: percentiles(
        jobs.map((r) => span(r.queuedAt, r.runnerAssignedAt)),
      ),
      // Queued to started by what the runner was started for.
      startedFor: Object.fromEntries(
        STARTS.map((s) => {
          const of = jobs.filter((r) => r.start === s);
          const ms = of.map((r) => span(r.queuedAt, r.runnerAssignedAt));
          return [s, { jobs: of.length, startMs: percentiles(ms) }];
        }),
      ),
      runMs: percentiles(
        jobs.map((r) => span(r.runnerAssignedAt, r.finishedAt)),
      ),
      dominant: all
        ? { segment: SEGMENTS[most]!, share: totals[most]! / all }
        : null,
      reclaims: count('job reclaimed'),
      startupFailures: count('runner failed to start'),
      reruns: count('run rerun'),
      retries: { onDemand, spot: started.length - onDemand },
      regions: Object.fromEntries(
        [...launched].map(([region, rows]) => [
          region,
          {
            jobs: rows.length,
            vmMs: percentiles(
              rows.map((r) =>
                span(r.runnerJob!.submittedAt, r.runnerJob!.runningAt),
              ),
            ),
          },
        ]),
      ),
      refusedIn: Object.fromEntries(
        [...Map.groupBy(refused, (r) => r.region)].map(([region, all]) => [
          region,
          all.length,
        ]),
      ),
      refusedFor: Object.fromEntries(
        [...Map.groupBy(refused, (r) => r.diagnosis)].map(([d, all]) => [
          d,
          all.length,
        ]),
      ),
      quotaRefused: {
        runners: quota.length,
        regions: [
          ...new Set(quota.flatMap((r) => forQuota(r).map((x) => x.region))),
        ],
        waitMs: percentiles(
          quota.map(({ timeline: t }) =>
            span(t?.submittedAt ?? null, t?.refusedUntil ?? null),
          ),
        ),
      },
      since: this.from > start ? new Date(this.from).toISOString() : null,
    };
  }
}
