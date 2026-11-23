// The cue benchmark (README.md): pushes to the target repo's bench branch,
// alternately with `backmesh cue` sent LEAD_S before the push and without,
// and reads each push's job times from the row the target's report.mjs
// writes. Run by cue-benchmark.yml:
//
//   TARGET_REPO=<owner>/<repo> LABEL=backmesh-16 ROUNDS=5 WIDTH=8 \
//   LEAD_S=75 BACKMESH_CLI=dist/cli/index.js BACKMESH_CUE_TOKEN=… \
//   GIT_SSH_COMMAND='ssh -i <deploy key>' OUTPUT_DIR=… node benchmarks/cue/run.ts
import { execFile } from 'node:child_process';
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const repo = env('TARGET_REPO');
const label = env('LABEL');
const rounds = Number(env('ROUNDS'));
const leadS = Number(env('LEAD_S'));
// The first wave's jobs: a matrix of this many on the label.
const width = Number(env('WIDTH'));
const cli = resolve(env('BACKMESH_CLI'));
const out = env('OUTPUT_DIR');
const BRANCH = 'bench';
// A push's row comes once its job is done; a job that never starts fails
// the round.
const RESULT_WAIT_MS = 20 * 60_000;
// Between rounds, so a round's runner is gone before the next push: longer
// than a cue's own idle window (180 s, prewarm.ts's CUE_IDLE_MS) plus a
// margin, so a cued round's leftover runner can't serve the next, uncued
// round and skew it as served.
const GAP_MS = 200_000;
// A job a runner took this soon after it queued had one waiting: the cue's,
// or for an uncued push another early runner on the label.
const SERVED_S = 10;
const target = new URL('./target/', import.meta.url).pathname;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const work = await mkdtemp(join(tmpdir(), 'cue-bench-'));
const git = async (...args: string[]) =>
  (await run('git', args, { cwd: work })).stdout.trim();

await git('clone', `git@github.com:${repo}.git`, '.');
await git('config', 'user.name', 'backmesh cue benchmark');
await git('config', 'user.email', 'cue-benchmark@users.noreply.github.com');
// report.mjs writes its rows to the results branch, which must exist.
if (!(await git('ls-remote', 'origin', 'refs/heads/results'))) {
  await git('switch', '--orphan', 'results');
  await git('commit', '--allow-empty', '-m', 'Cue benchmark results');
  await git('push', 'origin', 'HEAD:refs/heads/results');
}
const remoteBench = await git('ls-remote', 'origin', `refs/heads/${BRANCH}`);
await (remoteBench ? git('switch', BRANCH) : git('switch', '--orphan', BRANCH));

// The target's files, with the label and width, as the warm-up's commit: the
// planner learns the workflow's first wave from that push. The workflow is
// named for its label and width, as the planner keys history by workflow
// file: a new label's cues don't start runners on the old one, and a new
// width's first wave isn't sized from the old one's runs.
await rm(join(work, '.github/workflows'), { recursive: true, force: true });
await mkdir(join(work, '.github/workflows'), { recursive: true });
for (const file of ['package.json', 'yarn.lock', 'report.mjs']) {
  await copyFile(join(target, file), join(work, file));
}
const workflow = await readFile(join(target, 'bench.yml'), 'utf8');
await writeFile(
  join(work, `.github/workflows/bench-${label}-w${width}.yml`),
  workflow
    .replace('__LABEL__', label)
    .replace(
      '__SHARDS__',
      JSON.stringify(Array.from({ length: width }, (_, i) => i + 1)),
    ),
);
await git('add', '-A');

interface Job {
  name: string;
  createdAt: string;
  startedAt: string;
  runner: string | null;
  steps: {
    name: string;
    startedAt: string | null;
    conclusion: string | null;
  }[];
}
interface Row {
  sha: string;
  jobs: Job[];
}

// Commits, pushes and waits for the push's row.
async function push(message: string) {
  await git('commit', '--allow-empty', '-m', message);
  const sha = await git('rev-parse', 'HEAD');
  const pushedAt = Date.now();
  await git('push', 'origin', `HEAD:refs/heads/${BRANCH}`);
  const deadline = pushedAt + RESULT_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(10_000);
    await git('fetch', '-q', 'origin', 'results');
    const row = await git('show', `FETCH_HEAD:results/${sha}.json`).catch(
      () => undefined,
    );
    if (row) return { pushedAt, row: JSON.parse(row) as Row };
  }
  throw new Error(`no row for ${sha} within ${RESULT_WAIT_MS / 60_000} min`);
}

// The cue CLI as a user runs it, in the target's checkout: it reads the
// repo and branch from git. It never fails a push, so its outcome is kept.
async function cue() {
  const { stdout } = await run(
    'node',
    [cli, 'cue', '--in', String(leadS), '--json'],
    {
      cwd: work,
      env: { ...process.env, BACKMESH_ANYCLOUD_DIR: join(work, '.backmesh') },
    },
  );
  return JSON.parse(stdout) as { outcome: string; message: string };
}

// Whole seconds, as GitHub's times are.
const seconds = (from: string | number, to: string | null | undefined) =>
  to ? Math.round((Date.parse(to) - new Date(from).getTime()) / 1000) : null;

// One job's figures, in seconds: push to the job queued, queued to a
// runner taking it, queued to the marker's start, the job's setup (its
// steps before the marker) and push to the marker's start. A failed install
// or marker fails the round: GitHub gives a skipped step a start too.
function jobFigures(pushedAt: number, job: Job) {
  const step = (name: string) => job.steps.find((s) => s.name === name);
  for (const name of ['Install', 'Marker']) {
    if (step(name)?.conclusion !== 'success') {
      throw new Error(`${job.name}: ${name} didn't succeed`);
    }
  }
  const marker = step('Marker')!.startedAt;
  const install = step('Install')!.startedAt;
  return {
    pushToMarker: seconds(pushedAt, marker),
    pushToQueued: seconds(pushedAt, job.createdAt),
    queuedToAssigned: seconds(job.createdAt, job.startedAt),
    queuedToMarker: seconds(job.createdAt, marker),
    setup: seconds(job.startedAt, marker),
    install: seconds(install!, marker),
  };
}
type Figures = ReturnType<typeof jobFigures>;

// A push's figures: each the median over its jobs, and how many of them a
// runner took within SERVED_S of their queueing.
function figures(pushedAt: number, row: Row) {
  if (row.jobs.length !== width) {
    throw new Error(`${row.sha}: ${row.jobs.length} jobs, not ${width}`);
  }
  const jobs = row.jobs.map((job) => jobFigures(pushedAt, job));
  const of = (key: keyof Figures) =>
    median(jobs.map((j) => j[key]).filter((x) => x !== null));
  return {
    served: jobs.filter((j) => (j.queuedToAssigned ?? 1e9) <= SERVED_S).length,
    queuedToMarker: of('queuedToMarker'),
    pushToMarker: of('pushToMarker'),
    queuedToAssigned: of('queuedToAssigned'),
    pushToQueued: of('pushToQueued'),
    setup: of('setup'),
    install: of('install'),
  };
}

const results: {
  round: number;
  cued: boolean;
  cue?: { outcome: string; message: string };
  sha: string;
  runners: (string | null)[];
  figures: ReturnType<typeof figures>;
}[] = [];

// Median and range per figure, cued against not.
const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};
const NAMES = {
  queuedToMarker: 'Queued to first real step',
  pushToMarker: 'Push to first real step',
  queuedToAssigned: 'Queued to assigned',
  pushToQueued: 'Push to queued',
  setup: 'Job setup (assigned to first real step)',
  install: 'of which yarn install',
} as const;
type Result = (typeof results)[number];
// Over the pushes `which` picks: their jobs' share served, and the median
// and range of each push's median.
const share = (which: (r: Result) => boolean) => {
  const of = results.filter(which);
  const served = of.reduce((n, r) => n + r.figures.served, 0);
  const jobs = of.length * width;
  return jobs
    ? `${served} of ${jobs} (${Math.round((100 * served) / jobs)}%)`
    : 'n/a';
};
const cell = (which: (r: Result) => boolean, key: keyof typeof NAMES) => {
  const v = results.filter(which).map((r) => r.figures[key]);
  if (!v.length) return 'n/a';
  return `${median(v)} s (${Math.min(...v)}–${Math.max(...v)})`;
};

async function benchmark() {
  for (let round = 0; round < 2 * rounds; round++) {
    const cued = round % 2 === 0;
    const sent = cued ? await cue() : undefined;
    if (sent) {
      console.log(`round ${round}: cue ${sent.outcome}: ${sent.message}`);
      // Without a cue the round would measure nothing cued.
      if (sent.outcome !== 'sent') throw new Error(`cue ${sent.outcome}`);
      await sleep(leadS * 1000);
    }
    const { pushedAt, row } = await push(
      `Cue benchmark round ${round}, ${cued ? 'cued' : 'not cued'}`,
    );
    const result = {
      round,
      cued,
      ...(sent && { cue: sent }),
      sha: row.sha,
      runners: row.jobs.map((job) => job.runner),
      figures: figures(pushedAt, row),
    };
    console.log(JSON.stringify(result));
    results.push(result);
    await writeFile(
      join(out, 'results.json'),
      JSON.stringify(results, null, 2),
    );
    await sleep(GAP_MS);
  }
}

async function summarize() {
  const columns: [string, (r: Result) => boolean][] = [
    ['Cued', (r) => r.cued],
    ['Not cued', (r) => !r.cued],
  ];
  const table = [
    `### Cue benchmark: ${label}, ${width} jobs a push, ${rounds} × 2 pushes, cue ${leadS} s ahead`,
    '',
    `Per push, its jobs' median; then the median (min–max) over pushes, in seconds. Served: a runner took the job within ${SERVED_S} s of its queueing.`,
    '',
    `| Figure | ${columns.map(([name]) => name).join(' | ')} |`,
    `| --- |${columns.map(() => ' --- |').join('')}`,
    `| Jobs served | ${columns.map(([, which]) => share(which)).join(' | ')} |`,
    ...Object.entries(NAMES).map(
      ([key, name]) =>
        `| ${name} | ${columns.map(([, which]) => cell(which, key as keyof typeof NAMES)).join(' | ')} |`,
    ),
    '',
    '| Round | Cued | Served | Queued to first real step |',
    '| --- | --- | --- | --- |',
    ...results.map(
      (r) =>
        `| ${r.round} | ${r.cued ? 'yes' : 'no'} | ${r.figures.served} of ${width} | ${r.figures.queuedToMarker} s |`,
    ),
    '',
  ].join('\n');
  console.log(table);
  await writeFile(join(out, 'summary.md'), table);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, table);
  }
}

// Every finished round is kept, and summarized, however the run ends. Last
// in the file, after every const and function it needs: this is what
// makes the module-evaluation-order crash (run 43459782240, "Cannot
// access 'served' before initialization") structurally impossible to
// reintroduce, since nothing below here could execute before it.
await mkdir(out, { recursive: true });
try {
  console.log('warm-up push');
  await push('Cue benchmark warm-up');
  await sleep(GAP_MS);
  await benchmark();
} finally {
  await summarize();
}
