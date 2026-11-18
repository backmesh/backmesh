// e2e.yml's `test-org` label member: the test org's runners take jobs only
// from its own repositories, so this dispatches TEST_ORG_REPO's labels.yml,
// which calls e2e-labels.yml, finds the run by its nonce, and fails unless
// it succeeds. GH_TOKEN may dispatch and read that one repository's runs.
//
//   TEST_ORG_REPO=backmesh-dryrun/e2e MATRIX=<plan.ts output> REF=<sha> \
//     node test/e2e/run-test-org-labels.ts
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import { dispatchAndFind } from './gh-workflows.ts';

const execFileAsync = promisify(execFile);
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const { TEST_ORG_REPO: repo, MATRIX: matrix, REF: ref } = process.env;
if (!repo || !matrix || !ref) {
  throw new Error('TEST_ORG_REPO, MATRIX and REF are required');
}
const WORKFLOW = 'labels.yml';
// The label jobs' 10 minutes each, after a fresh install's first boots.
const TIMEOUT_MS = 60 * 60_000;

const gh = async (args: string[]) =>
  (await execFileAsync('gh', args, { maxBuffer: 64 * 1024 * 1024 })).stdout;

const nonce = randomUUID();
const runId = await dispatchAndFind(
  (workflow, inputs) =>
    gh([
      'workflow',
      'run',
      workflow,
      '--repo',
      repo,
      ...Object.entries(inputs).flatMap(([k, v]) => ['-f', `${k}=${v}`]),
    ]).then(() => undefined),
  async (workflow) =>
    (
      JSON.parse(
        await gh([
          'run',
          'list',
          '--repo',
          repo,
          '--workflow',
          workflow,
          '--limit',
          '20',
          '--json',
          'databaseId,createdAt,displayTitle',
        ]),
      ) as { databaseId: number; createdAt: string; displayTitle: string }[]
    ).map((r) => ({
      id: r.databaseId,
      createdAt: r.createdAt,
      displayTitle: r.displayTitle,
    })),
  sleep,
  WORKFLOW,
  { matrix, ref, nonce },
  { match: (run) => run.displayTitle?.endsWith(nonce) ?? false },
);
const url = `https://github.com/${repo}/actions/runs/${runId}`;
console.log(`::notice title=Test org's label run::${url}`);
const deadline = Date.now() + TIMEOUT_MS;
for (;;) {
  const { status, conclusion } = JSON.parse(
    await gh([
      'run',
      'view',
      String(runId),
      '--repo',
      repo,
      '--json',
      'status,conclusion',
    ]),
  ) as { status: string; conclusion: string | null };
  if (status === 'completed') {
    if (conclusion === 'success') break;
    throw new Error(`${url} ended ${conclusion}`);
  }
  if (Date.now() > deadline) {
    await gh(['run', 'cancel', String(runId), '--repo', repo]).catch(() => '');
    throw new Error(`${url} didn't finish within an hour; cancelled`);
  }
  await sleep(15_000);
}
console.log(`${url} passed`);
