// A results file's shape (run.ts writes it, report.ts reads it) and the
// figures computed from it.

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
