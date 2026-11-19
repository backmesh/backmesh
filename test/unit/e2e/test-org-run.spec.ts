import { describe, expect, it } from 'vitest';

import {
  runOnTestOrg,
  type TestOrgGit,
} from '../../../test/e2e/test-org-run.ts';

const noSleep = async () => undefined;
const MATRIX = '{"include":[{"label":"backmesh-4","cloud":"azure"}]}';
const URL = 'https://github.com/backmesh-dryrun/e2e/actions/runs/7';

// A test org's branch: run.json as pushed, then the result labels.yml writes
// back after `polls` reads, if any.
function fakeGit(result?: object, polls = 2) {
  const pushed: Record<string, string>[] = [];
  const deleted: string[] = [];
  let reads = 0;
  const git: TestOrgGit = {
    push: async (branch, files) => {
      pushed.push({ branch, ...files });
    },
    read: async () =>
      result && ++reads > polls ? JSON.stringify(result) : null,
    remove: async (branch) => {
      deleted.push(branch);
    },
  };
  return { git, pushed, deleted };
}

const run = (git: TestOrgGit, timeoutMs = 60_000) =>
  runOnTestOrg(git, noSleep, {
    matrix: MATRIX,
    ref: 'a'.repeat(40),
    nonce: 'n1',
    timeoutMs,
    now: (() => {
      let t = 0;
      return () => (t += 15_000);
    })(),
  });

describe('runOnTestOrg', () => {
  it('pushes run.json to run/<nonce>, waits for its result, and deletes the branch', async () => {
    const { git, pushed, deleted } = fakeGit({
      conclusion: 'success',
      url: URL,
    });
    await expect(run(git)).resolves.toBe(URL);
    expect(pushed).toEqual([
      {
        branch: 'run/n1',
        'run.json': `${JSON.stringify(
          { matrix: JSON.parse(MATRIX), ref: 'a'.repeat(40), nonce: 'n1' },
          null,
          2,
        )}\n`,
      },
    ]);
    expect(deleted).toEqual(['run/n1']);
  });

  it('fails with the run when the label jobs did not succeed, and still deletes the branch', async () => {
    const { git, deleted } = fakeGit({ conclusion: 'failure', url: URL });
    await expect(run(git)).rejects.toThrow(`${URL} ended failure`);
    expect(deleted).toEqual(['run/n1']);
  });

  it('fails when no result arrives in time, and still deletes the branch', async () => {
    const { git, deleted } = fakeGit();
    await expect(run(git, 60_000)).rejects.toThrow(
      'labels.yml wrote no result to run/n1 within 1 minutes',
    );
    expect(deleted).toEqual(['run/n1']);
  });

  it('deletes the branch even when the push fails partway', async () => {
    const { git, deleted } = fakeGit();
    git.push = async () => {
      throw new Error('push refused');
    };
    await expect(run(git)).rejects.toThrow('push refused');
    expect(deleted).toEqual(['run/n1']);
  });
});
