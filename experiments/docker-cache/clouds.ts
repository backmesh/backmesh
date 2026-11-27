// The Docker layer cache spike's per-cloud check (README.md): pushes
// target/docker-cache.yml and setup.sh, the shim and the proxy's bundle to a
// docker-cache/<nonce> branch of the test org's repository, on LABEL, and
// reads the row its job writes to the results branch. Run by e2e.yml's
// test-org leg, with `dockercache`:
//
//   TARGET_REPO=backmesh-dryrun/e2e LABEL=backmesh-ubuntu-2404-4vcpu \
//   GIT_SSH_COMMAND='ssh -i <deploy key>' OUTPUT_DIR=… \
//     node experiments/docker-cache/clouds.ts
//
// On a timeout or a cancel it pushes docker-cache-cancel/<nonce>, whose
// workflow cancels the run; then it deletes both branches.
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
const out = env('OUTPUT_DIR');
const RESULT_WAIT_MS = 45 * 60_000;
const here = new URL('.', import.meta.url).pathname;
const nonce = randomUUID();
const BRANCH = `docker-cache/${nonce}`;
const CANCEL = `docker-cache-cancel/${nonce}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const work = await mkdtemp(join(tmpdir(), 'docker-cache-'));
const git = async (...args: string[]) =>
  (await run('git', args, { cwd: work })).stdout.trim();

await git('clone', '-q', '--depth=1', `git@github.com:${repo}.git`, '.');
await git('config', 'user.name', 'backmesh Docker cache spike');
await git('config', 'user.email', 'docker-cache@users.noreply.github.com');
if (!(await git('ls-remote', 'origin', 'refs/heads/results'))) {
  await git('switch', '-q', '--orphan', 'results');
  await git('commit', '-q', '--allow-empty', '-m', 'Results');
  await git('push', '-q', 'origin', 'HEAD:refs/heads/results');
}
// Only the target's files: the repository's own workflows don't run.
await git('switch', '-q', '--orphan', 'docker-cache');
await mkdir(join(work, '.github/workflows'), { recursive: true });
await mkdir(join(work, 'docker-cache/dist'), { recursive: true });
for (const f of ['setup.sh', 'docker', 'dist/proxy.mjs'])
  await copyFile(join(here, f), join(work, 'docker-cache', f));
await writeFile(
  join(work, '.github/workflows/docker-cache.yml'),
  (await readFile(join(here, 'target/docker-cache.yml'), 'utf8'))
    .replace('__LABEL__', label)
    .replace('__BRANCH__', BRANCH),
);
await writeFile(
  join(work, '.github/workflows/cancel.yml'),
  `name: Cancel docker-cache
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

interface Build {
  round: number;
  arm: 'off' | 'on';
  state: 'cold' | 'warm' | 'changed';
  code: number;
  ms: number;
  cached: number;
}
interface Row {
  conclusion: string;
  bucket: string;
  builds: Build[];
  proxy: {
    cloud: string;
    hits: number;
    writes: number;
    bytesWritten: number;
    errors: string[];
    tokens: { id: string; ok: number }[];
  } | null;
}
let row: Row | undefined;
try {
  await git('push', '-q', 'origin', `HEAD:refs/heads/${BRANCH}`);
  const deadline = Date.now() + RESULT_WAIT_MS;
  while (!row && Date.now() < deadline) {
    await sleep(15_000);
    await git('fetch', '-q', 'origin', 'results');
    const text = await git('show', `FETCH_HEAD:results/${sha}.json`).catch(
      () => undefined,
    );
    if (text) row = JSON.parse(text) as Row;
  }
} finally {
  done = true;
  await cleanUp(!row);
}
if (!row) {
  throw new Error(`no row for ${sha} within ${RESULT_WAIT_MS / 60_000} min`);
}
await mkdir(out, { recursive: true });
await writeFile(join(out, 'result.json'), `${JSON.stringify(row, null, 2)}\n`);

// Passes when the job did, every build passed, the cold builds wrote
// through the proxy without an error and the warm ones read their writes
// back.
const p = row.proxy;
const of = (arm: string, state: string) =>
  row!.builds.filter((b) => b.arm === arm && b.state === state);
const median = (bs: Build[]) =>
  bs.map((b) => b.ms / 1000).sort((a, b) => a - b)[bs.length >> 1];
const failures = [
  row.conclusion !== 'success' && `the job ended ${row.conclusion}`,
  row.builds.some((b) => b.code) && 'a build failed',
  !p?.writes && 'nothing written',
  of('on', 'warm').some((b) => !b.cached) && 'a warm build hit nothing',
  p?.errors.length && `proxy errors: ${p.errors.slice(0, 3).join('; ')}`,
].filter(Boolean);
const summary = `Docker cache on \`${label}\` (${p?.cloud}, ${row.bucket}), healthchecks, median s over ${of('off', 'cold').length} rounds: off ${median(of('off', 'cold'))}, cold ${median(of('on', 'cold'))}, warm ${median(of('on', 'warm'))}, changed ${median(of('on', 'changed'))}; ${p?.writes} writes, ${p?.bytesWritten} bytes, ${p?.hits} hits; ${(p?.tokens ?? []).filter((t) => t.ok > 0).length} tokens used. ${failures.length ? `Failed: ${failures.join(', ')}.` : 'Passed.'}\n`;
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
}
if (failures.length) process.exitCode = 1;
