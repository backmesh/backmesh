// e2e.yml's `test-org` label member: the test org's runners take jobs only
// from its own repositories, so this pushes run.json to a run/<nonce> branch
// of TEST_ORG_REPO, on top of its default branch, whose labels.yml a push
// runs only if it's in the pushed tree; labels.yml calls e2e-labels.yml and
// pushes its result back (test-org-run.ts). GIT_SSH_COMMAND names the
// repository's write deploy key: a deploy key's push starts workflows. A
// cancel (SIGINT, then SIGTERM) deletes the branch too, once a push in
// flight is done. It fails, pushing nothing, while the repository's
// labels.yml isn't test/e2e/test-org/labels.yml.
//
//   TEST_ORG_REPO=backmesh-dryrun/e2e MATRIX=<plan.ts output> REF=<sha> \
//     GIT_SSH_COMMAND='ssh -i <key> -o IdentitiesOnly=yes' \
//     node test/e2e/run-test-org-labels.ts
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { runOnTestOrg } from './test-org-run.ts';

const execFileAsync = promisify(execFile);
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const { TEST_ORG_REPO: repo, MATRIX: matrix, REF: ref } = process.env;
if (!repo || !matrix || !ref) {
  throw new Error('TEST_ORG_REPO, MATRIX and REF are required');
}
const remote = `git@github.com:${repo}.git`;
const dir = mkdtempSync(join(tmpdir(), 'test-org-'));
const git = async (...args: string[]) =>
  (await execFileAsync('git', ['-C', dir, ...args])).stdout;
await git('init', '-q');
await git('fetch', '-q', '--depth=1', remote, 'HEAD');
await git('checkout', '-q', 'FETCH_HEAD');
const LABELS = '.github/workflows/labels.yml';
const copy = join(import.meta.dirname, 'test-org/labels.yml');
if (readFileSync(join(dir, LABELS), 'utf8') !== readFileSync(copy, 'utf8')) {
  throw new Error(
    `${repo}'s ${LABELS} isn't test/e2e/test-org/labels.yml: push that copy there`,
  );
}

const nonce = randomUUID();
const remove = async (branch: string) => {
  await git('push', '-q', remote, '--delete', branch);
};
// A cancel waits for a push in flight, so the delete comes after it; once
// cancelled, nothing more is pushed.
let cancelled = false;
let pushing: Promise<unknown> = Promise.resolve();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    cancelled = true;
    void pushing
      .catch(() => undefined)
      .then(() => remove(`run/${nonce}`))
      .catch((err: unknown) => {
        console.log(`::warning::couldn't delete run/${nonce}: ${String(err)}`);
      })
      .finally(() => process.exit(130));
  });
}

const url = await runOnTestOrg(
  {
    push: async (branch, files) => {
      for (const [name, text] of Object.entries(files)) {
        writeFileSync(join(dir, name), text);
      }
      await git('add', '.');
      await git(
        '-c',
        'user.name=backmesh e2e',
        '-c',
        'user.email=e2e@backmesh.com',
        'commit',
        '-qm',
        branch,
      );
      if (cancelled) throw new Error('cancelled');
      pushing = git('push', '-q', remote, `HEAD:refs/heads/${branch}`);
      await pushing;
    },
    read: async (branch) => {
      await git('fetch', '-q', '--depth=1', remote, `refs/heads/${branch}`);
      return git('show', 'FETCH_HEAD:result.json').catch(() => null);
    },
    remove,
  },
  sleep,
  {
    matrix,
    ref,
    nonce,
    // The label jobs and the warm-hit chain, up to 10 jobs in series,
    // 10 minutes each, after a fresh install's first boots.
    timeoutMs: 120 * 60_000,
  },
);
console.log(`${url} passed`);
