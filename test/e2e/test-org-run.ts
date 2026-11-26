// e2e.yml's `test-org` label member, without the git calls
// (run-test-org-labels.ts makes them): pushes run.json to a run/<nonce>
// branch of the test org's e2e repository, whose push starts its labels.yml
// (test/e2e/test-org/labels.yml), and waits for the result.json labels.yml
// pushes back to that branch. A deploy key can push and fetch but can't read
// the repository's runs, hence the result on the branch. The branch is
// deleted afterwards, whatever happened; a failed delete only warns, so it
// never hides the run's own result.

export interface TestOrgGit {
  push(branch: string, files: Record<string, string>): Promise<void>;
  /** The branch's result.json, or null while there's none. */
  read(branch: string): Promise<string | null>;
  remove(branch: string): Promise<void>;
}

export interface TestOrgRun {
  matrix: string; // plan.ts's output
  ref: string;
  nonce: string;
  timeoutMs: number;
  now?: () => number;
}

/** Resolves with the label run's URL once it succeeds. */
export async function runOnTestOrg(
  git: TestOrgGit,
  sleep: (ms: number) => Promise<void>,
  { matrix, ref, nonce, timeoutMs, now = Date.now }: TestOrgRun,
): Promise<string> {
  const branch = `run/${nonce}`;
  try {
    const run = { matrix: JSON.parse(matrix) as unknown, ref, nonce };
    await git.push(branch, {
      'run.json': `${JSON.stringify(run, null, 2)}\n`,
    });
    const deadline = now() + timeoutMs;
    for (;;) {
      const result = await git.read(branch);
      if (result !== null) {
        const { conclusion, url } = JSON.parse(result) as {
          conclusion: string;
          url: string;
        };
        if (conclusion !== 'success')
          throw new Error(`${url} ended ${conclusion}`);
        return url;
      }
      if (now() >= deadline) {
        throw new Error(
          `labels.yml wrote no result to ${branch} within ${timeoutMs / 60_000} minutes`,
        );
      }
      await sleep(15_000);
    }
  } finally {
    await git.remove(branch).catch((err: unknown) => {
      console.log(`::warning::couldn't delete ${branch}: ${String(err)}`);
    });
  }
}
