// A results file's shape (run.ts writes it, report.ts and the site read it)
// and the figures computed from it.
import {
  AWS_DISK_PER_HOUR,
  AWS_ON_DEMAND_XLARGE,
  AWS_SPOT_XLARGE,
  GITHUB_4_CORE_PER_MIN,
} from '../../website/src/cost.ts';

export interface Job {
  id: number;
  url: string;
  conclusion: string | null;
  runner: string | null;
  // GitHub's times, in whole seconds.
  createdAt: string;
  startedAt: string;
  completedAt: string | null;
  steps: {
    name: string;
    startedAt: string | null;
    completedAt: string | null;
  }[];
  // backmesh's start-up marks (runner/runner-job.sh), in epoch µs, from the
  // Marks step; none on GitHub's runners.
  marks: Record<string, number>;
  // The job log's `backmesh cache: auto` lines.
  cache: string[];
  nproc: number | null;
  // lscpu's model name; none in results before 2026-11-23's cores run.
  cpu?: string | null;
  // bench-cache.yml's jobs: each cache's `cache-hit` output, and the Docker
  // build's CACHED steps.
  hits?: Record<string, string>;
  dockerCached?: number;
  // On backmesh's AWS runners: `aws <region>` and the VM type.
  region: string | null;
  vm: string | null;
}

export interface Run {
  runId: number;
  url: string;
  jobs: Record<string, Job>;
}

export interface Results {
  date: string;
  backmesh: string;
  anycloud: string;
  // Whose installation, and its cloud and region.
  installation: string;
  repo: string;
  // backmesh's commit the bench.yml came from.
  commit: string;
  labels: Record<
    string,
    { round: number; branch: string; cold: Run; warm: Run }[]
  >;
}

// The cold start's pieces, from the job's queueing to its first step (the
// Marks step), in order. Each runs from the piece before it, or from the
// queueing if later: a runner started before the job, by a cue or the
// planner, has its earlier pieces count 0.
export const SEGMENTS = [
  ['listener', 'Queued to runner submitted', 'submitted'],
  ['vm', 'VM launched (submitted to kernel start)', 'vm_booted'],
  [
    'container',
    'OS boot, Docker install, image pull, container start',
    'container_started',
  ],
  ['runner', 'Runner connected to GitHub', 'runner_listening'],
  ['assigned', 'GitHub assigned the job', 'startedAt'],
  ['setUpJob', 'Set up job (actions downloaded)', 'job_received'],
  // Results before 0.5.7 only: the job-started hook no longer waits for the
  // automatic restores, and marks no `restore_waited`.
  ['cacheHold', 'Cache hold (automatic restores)', 'restore_waited'],
  ['toFirstStep', 'Rest of the setup, to the first step', 'firstStep'],
] as const;
export type Segment = (typeof SEGMENTS)[number][0];

const ms = (iso: string | null) => (iso ? Date.parse(iso) : null);

// In seconds: the wait (queued to the first step), the build (first step to
// done), their total, and each cold-start piece; null for a job that didn't
// succeed. On GitHub's runners only `assigned` and `toFirstStep` have marks.
export function figures(job: Job) {
  const firstStep = ms(
    job.steps.find((s) => s.name === 'Marks')?.startedAt ?? null,
  );
  const done = ms(job.completedAt);
  if (job.conclusion !== 'success' || firstStep === null || done === null)
    return null;
  const queued = Date.parse(job.createdAt);
  const at: Record<string, number | undefined> = {
    ...Object.fromEntries(
      Object.entries(job.marks).map(([k, us]) => [k, us / 1000]),
    ),
    startedAt: Date.parse(job.startedAt),
    firstStep,
  };
  let prev = queued;
  const segments: Partial<Record<Segment, number>> = {};
  for (const [key, , mark] of SEGMENTS) {
    const t = at[mark];
    if (t === undefined) continue;
    segments[key] = Math.max(0, t - prev) / 1000;
    prev = Math.max(prev, t);
  }
  return {
    wait: (firstStep - queued) / 1000,
    build: (done - firstStep) / 1000,
    total: (done - queued) / 1000,
    segments,
  };
}

export const median = (v: readonly number[]) => {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

// Two-sided Mann-Whitney U test's p: the normal approximation with continuity
// and tie corrections.
export function mannWhitney(x: readonly number[], y: readonly number[]) {
  const all = [...x.map((v) => [v, 0]), ...y.map((v) => [v, 1])].sort(
    (a, b) => a[0]! - b[0]!,
  );
  let r1 = 0;
  let ties = 0;
  for (let i = 0; i < all.length;) {
    let j = i;
    while (j < all.length && all[j]![0] === all[i]![0]) j++;
    for (let k = i; k < j; k++) if (all[k]![1] === 0) r1 += (i + j + 1) / 2;
    ties += (j - i) ** 3 - (j - i);
    i = j;
  }
  const [n1, n2, n] = [x.length, y.length, x.length + y.length];
  const u = r1 - (n1 * (n1 + 1)) / 2;
  const sd = Math.sqrt(((n1 * n2) / 12) * (n + 1 - ties / (n * (n - 1))));
  const z = Math.max(0, Math.abs(u - (n1 * n2) / 2) - 0.5) / sd;
  // The normal's upper tail (Abramowitz and Stegun 26.2.17).
  const t = 1 / (1 + 0.2316419 * z);
  const tail =
    0.3989423 *
    Math.exp((-z * z) / 2) *
    t *
    (0.3193815 +
      t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return Math.min(1, 2 * tail);
}

// Every succeeded job's figures in one arm of a label, optionally one build's.
export function jobs(
  r: Results,
  label: string,
  arm: 'cold' | 'warm',
  build?: string,
) {
  return r.labels[label]!.flatMap((round) =>
    Object.entries(round[arm].jobs)
      .filter(([name]) => !build || name === build)
      .flatMap(([, job]) => {
        const f = figures(job);
        return f ? [{ job, f }] : [];
      }),
  );
}
export const med = (
  fs: ReturnType<typeof jobs>,
  pick: (f: NonNullable<ReturnType<typeof figures>>) => number | undefined,
) => median(fs.map((j) => pick(j.f)).filter((v) => v !== undefined));

// Each label's speed against ubuntu-latest's, and a build's cost. A backmesh
// job costs its VM's spot price (cost.ts's `backmesh-ubuntu-2404-4vcpu` price for the VM's
// family, times its vCPUs over 4; its on-demand price on a `-od-` label) from
// the kernel's start to the job's end,
// with its disk, each for at least a minute as AWS bills them; ubuntu-latest's,
// what a private repository pays for GitHub's 4-vCPU runner: its per-minute
// price, each job rounded up to a whole minute.
export const BASE = 'ubuntu-latest';
export function cost(label: string, job: Job) {
  const end = Date.parse(job.completedAt!);
  if (label.startsWith(BASE))
    return (
      Math.ceil((end - Date.parse(job.startedAt)) / 60_000) *
      GITHUB_4_CORE_PER_MIN
    );
  const prices = label.includes('-od-')
    ? AWS_ON_DEMAND_XLARGE
    : AWS_SPOT_XLARGE;
  const price = prices[job.vm?.split('.')[0] ?? ''];
  const booted = job.marks.vm_booted;
  if (!price || !job.nproc || !booted) return undefined;
  const hours = Math.max(60_000, end - booted / 1000) / 3_600_000;
  return ((price * job.nproc) / 4 + AWS_DISK_PER_HOUR) * hours;
}

// An experiment without its own ubuntu-latest compares with the one in the
// release file it ran alongside: the same date and backmesh version.
export function withBase(r: Results, releases: readonly Results[]): Results {
  const base = releases.find(
    (a) => a.date === r.date && a.backmesh === r.backmesh,
  )?.labels[BASE];
  return r.labels[BASE] || !base
    ? r
    : { ...r, labels: { ...r.labels, [BASE]: base } };
}

// Orders results/'s file names, `<date>-<backmesh version>.json`, oldest
// first: by date, then version.
export const byName = (a: string, b: string) =>
  a.localeCompare(b, 'en', { numeric: true });
