// The control-plane burst (README.md): pushes the cue benchmark's target
// (benchmarks/cue/target) to a burst/<nonce> branch of the test org's
// repository as one workflow of JOBS jobs on LABEL, so they queue at once,
// and reads their times from the row its report.mjs writes. Run by
// e2e.yml's test-org leg, with `burst`, on the leg's installation:
//
//   TARGET_REPO=backmesh-dryrun/e2e LABEL=backmesh-ubuntu-2404-4vcpu JOBS=60 \
//   GIT_SSH_COMMAND='ssh -i <deploy key>' OUTPUT_DIR=… \
//     node benchmarks/control-plane-burst/run.ts
//
// On a timeout or a cancel it pushes burst-cancel/<nonce>, whose workflow
// cancels the burst's run, so no queued job is left for the next leg's
// runners on the same label; then it deletes both branches.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const repo = env('TARGET_REPO');
const label = env('LABEL');
const jobs = Number(env('JOBS'));
const out = env('OUTPUT_DIR');
// report.mjs reads one page of the run's jobs.
if (!Number.isInteger(jobs) || jobs < 1 || jobs > 99) {
  throw new Error('JOBS takes 1 to 99 jobs: report.mjs reads 100 at most');
}
// The burst on a small spot quota queues in waves.
const RESULT_WAIT_MS = 120 * 60_000;
const target = new URL('../cue/target/', import.meta.url).pathname;
const nonce = randomUUID();
const BRANCH = `burst/${nonce}`;
const CANCEL = `burst-cancel/${nonce}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const work = await mkdtemp(join(tmpdir(), 'burst-'));
const git = async (...args: string[]) =>
  (await run('git', args, { cwd: work })).stdout.trim();

await git('clone', '-q', '--depth=1', `git@github.com:${repo}.git`, '.');
await git('config', 'user.name', 'backmesh control-plane burst');
await git('config', 'user.email', 'burst@users.noreply.github.com');
// report.mjs writes its rows to the results branch, which must exist.
if (!(await git('ls-remote', 'origin', 'refs/heads/results'))) {
  await git('switch', '-q', '--orphan', 'results');
  await git('commit', '-q', '--allow-empty', '-m', 'Burst results');
  await git('push', '-q', 'origin', 'HEAD:refs/heads/results');
}
// Only the target's files: the repository's own workflows don't run.
await git('switch', '-q', '--orphan', 'burst');
await mkdir(join(work, '.github/workflows'), { recursive: true });
for (const file of ['package.json', 'yarn.lock', 'report.mjs']) {
  await copyFile(join(target, file), join(work, file));
}
await writeFile(
  join(work, `.github/workflows/bench-${label}-w${jobs}.yml`),
  (await readFile(join(target, 'bench.yml'), 'utf8'))
    .replace('__LABEL__', label)
    .replace('__BRANCH__', BRANCH)
    .replace(
      '__SHARDS__',
      JSON.stringify(Array.from({ length: jobs }, (_, i) => i + 1)),
    ),
);
await writeFile(
  join(work, '.github/workflows/cancel.yml'),
  `name: Cancel burst
on:
  push:
    branches: [${CANCEL}]
permissions: {}
jobs:
  cancel:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      actions: write
    steps:
      - env:
          GH_TOKEN: \${{ github.token }}
          GH_REPO: \${{ github.repository }}
        run: gh run list --branch ${BRANCH} --json databaseId --jq '.[].databaseId' | xargs -rn1 gh run cancel
`,
);
await git('add', '-A');
await git('commit', '-q', '-m', BRANCH);
const sha = await git('rev-parse', 'HEAD');

// Cancels the burst's run, then deletes both branches; a failed delete
// only warns.
let done = false;
async function cleanUp(cancel: boolean) {
  if (cancel) await git('push', '-q', 'origin', `HEAD:refs/heads/${CANCEL}`);
  for (const branch of cancel ? [BRANCH, CANCEL] : [BRANCH]) {
    await git('push', '-q', 'origin', '--delete', branch).catch((e: unknown) =>
      console.log(`::warning::couldn't delete ${branch}: ${String(e)}`),
    );
  }
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    if (!done) void cleanUp(true).finally(() => process.exit(130));
  });
}

interface Step {
  name: string;
  startedAt: string | null;
  conclusion: string | null;
}
type Job = { createdAt: string; startedAt: string | null; steps: Step[] };

await git('push', '-q', 'origin', `HEAD:refs/heads/${BRANCH}`);
const deadline = Date.now() + RESULT_WAIT_MS;
let row: { jobs: Job[] } | undefined;
while (!row && Date.now() < deadline) {
  await sleep(15_000);
  await git('fetch', '-q', 'origin', 'results');
  const text = await git('show', `FETCH_HEAD:results/${sha}.json`).catch(
    () => undefined,
  );
  if (text) row = JSON.parse(text) as { jobs: Job[] };
}
done = true;
await cleanUp(!row);
if (!row) {
  throw new Error(`no row for ${sha} within ${RESULT_WAIT_MS / 60_000} min`);
}

// Nearest rank, over whole seconds, as GitHub's times are.
const seconds = (from: string, to: string | null | undefined) =>
  to ? Math.round((Date.parse(to) - Date.parse(from)) / 1000) : undefined;
const figure = (values: (number | undefined)[]) => {
  const s = values.filter((v) => v !== undefined).sort((a, b) => a - b);
  const at = (p: number) => s[Math.max(0, Math.ceil(p * s.length) - 1)];
  return { p50: at(0.5), p90: at(0.9), max: s.at(-1) };
};
const marker = (job: Job) => job.steps.find((s) => s.name === 'Marker');
const result = {
  label,
  failed: row.jobs.filter((j) => marker(j)?.conclusion !== 'success').length,
  queuedToAssigned: figure(
    row.jobs.map((j) => seconds(j.createdAt, j.startedAt)),
  ),
  queuedToFirstStep: figure(
    row.jobs.map((j) => seconds(j.createdAt, marker(j)?.startedAt)),
  ),
};
await writeFile(
  join(out, 'result.json'),
  `${JSON.stringify({ ...result, row }, null, 2)}\n`,
);
const { failed, queuedToAssigned: a, queuedToFirstStep: f } = result;
const summary = `Burst of ${jobs} jobs on \`${label}\`: ${failed} failed; queued to assigned p50 ${a.p50} s, p90 ${a.p90} s, max ${a.max} s; queued to first step p50 ${f.p50} s, p90 ${f.p90} s, max ${f.max} s.\n`;
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
}
