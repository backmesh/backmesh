// The sccache spike's per-cloud check (README.md): pushes target/sccache.yml
// and the proxy's bundle to a sccache/<nonce> branch of the test org's
// repository, on LABEL, and reads the row its job writes to the results
// branch. Run by e2e.yml's test-org leg, with `sccache`:
//
//   TARGET_REPO=backmesh-dryrun/e2e LABEL=backmesh-ubuntu-2404-4vcpu \
//   GIT_SSH_COMMAND='ssh -i <deploy key>' OUTPUT_DIR=… \
//     node experiments/sccache/clouds.ts
//
// On a timeout or a cancel it pushes sccache-cancel/<nonce>, whose workflow
// cancels the run; then it deletes both branches.
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
const RESULT_WAIT_MS = 50 * 60_000;
const here = new URL('.', import.meta.url).pathname;
const nonce = randomUUID();
const BRANCH = `sccache/${nonce}`;
const CANCEL = `sccache-cancel/${nonce}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const work = await mkdtemp(join(tmpdir(), 'sccache-'));
const git = async (...args: string[]) =>
  (await run('git', args, { cwd: work })).stdout.trim();

await git('clone', '-q', '--depth=1', `git@github.com:${repo}.git`, '.');
await git('config', 'user.name', 'backmesh sccache spike');
await git('config', 'user.email', 'sccache@users.noreply.github.com');
if (!(await git('ls-remote', 'origin', 'refs/heads/results'))) {
  await git('switch', '-q', '--orphan', 'results');
  await git('commit', '-q', '--allow-empty', '-m', 'Results');
  await git('push', '-q', 'origin', 'HEAD:refs/heads/results');
}
// Only the target's files: the repository's own workflows don't run.
await git('switch', '-q', '--orphan', 'sccache');
await mkdir(join(work, '.github/workflows'), { recursive: true });
await copyFile(join(here, 'dist/proxy.mjs'), join(work, 'proxy.mjs'));
await writeFile(
  join(work, '.github/workflows/sccache.yml'),
  (await readFile(join(here, 'target/sccache.yml'), 'utf8'))
    .replace('__LABEL__', label)
    .replace('__BRANCH__', BRANCH),
);
await writeFile(
  join(work, '.github/workflows/cancel.yml'),
  `name: Cancel sccache
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

interface Stats {
  hits: number;
  misses: number;
  writes: number;
  writeErrors: number;
  readErrors: number;
}
interface Row {
  conclusion: string;
  bucket: string;
  seconds?: { cold?: number; warm?: number };
  cold: Stats | null;
  warm: Stats | null;
  proxy: {
    cloud: string;
    puts: number;
    hits: number;
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

// Passes when the job did, wrote through the proxy without an error, read
// its writes back in the warm build, and used a renewed token.
const p = row.proxy;
const renewed = (p?.tokens ?? []).filter((t) => t.ok > 0).length;
const failures = [
  row.conclusion !== 'success' && `the job ended ${row.conclusion}`,
  !row.cold?.writes && 'the cold build wrote nothing',
  (row.cold?.writeErrors || row.warm?.writeErrors) && 'sccache write errors',
  !row.warm?.hits && 'the warm build hit nothing',
  p?.errors.length && `proxy errors: ${p.errors.slice(0, 3).join('; ')}`,
  renewed < 2 && 'no request with a renewed token',
].filter(Boolean);
const summary = `sccache on \`${label}\` (${p?.cloud}, ${row.bucket}): cold ${row.seconds?.cold} s, ${row.cold?.writes} writes, ${p?.bytesWritten} bytes; warm ${row.seconds?.warm} s, ${row.warm?.hits} hits, ${row.warm?.misses} misses; ${renewed} tokens used. ${failures.length ? `Failed: ${failures.join(', ')}.` : 'Passed.'}\n`;
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
}
if (failures.length) process.exitCode = 1;
