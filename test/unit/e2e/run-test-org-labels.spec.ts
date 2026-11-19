import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REMOTE = 'git@github.com:backmesh-dryrun/e2e.git';
const URL = 'https://github.com/backmesh-dryrun/e2e/actions/runs/7';

const git = (cwd: string, ...args: string[]) => {
  const out = spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
    { cwd, encoding: 'utf8' },
  );
  if (out.status !== 0) throw new Error(out.stderr);
  return out.stdout;
};

// A bare stand-in for the test org's e2e repository, its default branch
// holding `labels` as labels.yml. Its post-receive hook plays labels.yml: it
// records the tree of each run/* push and, when `answer`, adds result.json on
// top. With `slowPush`, a run/* push marks `pushing` and takes 2 s.
function testOrgRepo(
  answer: boolean,
  {
    labels = readFileSync('test/e2e/test-org/labels.yml', 'utf8'),
    slowPush = false,
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'test-org-repo-'));
  const bare = join(dir, 'e2e.git');
  const seed = join(dir, 'seed');
  git(dir, 'init', '-q', '--bare', '-b', 'main', bare);
  git(dir, 'init', '-q', '-b', 'main', seed);
  mkdirSync(join(seed, '.github/workflows'), { recursive: true });
  writeFileSync(join(seed, '.github/workflows/labels.yml'), labels);
  git(seed, 'add', '.');
  git(seed, 'commit', '-qm', 'seed');
  git(seed, 'push', '-q', bare, 'main');
  const hook = join(bare, 'hooks/post-receive');
  writeFileSync(
    hook,
    `#!/bin/bash
while read -r old new ref; do
  [[ $ref == refs/heads/run/* && $new != 0000000000000000000000000000000000000000 ]] || continue
  git cat-file -e "$new:result.json" 2>/dev/null && continue
  git ls-tree -r --name-only "$new" >${dir}/tree
  ${answer ? '' : 'continue'}
  blob=$(echo '{"conclusion":"success","url":"${URL}"}' | git hash-object -w --stdin)
  tree=$( (git ls-tree "$new"; printf '100644 blob %s\\tresult.json\\n' "$blob") | git mktree)
  commit=$(git -c user.name=t -c user.email=t@t commit-tree "$tree" -p "$new" -m result)
  git update-ref "$ref" "$commit" "$new"
done
`,
  );
  chmodSync(hook, 0o755);
  if (slowPush) {
    const pre = join(bare, 'hooks/pre-receive');
    writeFileSync(
      pre,
      `#!/bin/bash
while read -r old new ref; do
  [[ $ref == refs/heads/run/* && $new != 0000000000000000000000000000000000000000 ]] || continue
  touch ${dir}/pushing
  sleep 2
done
`,
    );
    chmodSync(pre, 0o755);
  }
  const pushing = () => existsSync(join(dir, 'pushing'));
  const branches = () =>
    git(bare, 'for-each-ref', '--format=%(refname)', 'refs/heads/run/');
  const tree = () =>
    existsSync(join(dir, 'tree'))
      ? readFileSync(join(dir, 'tree'), 'utf8')
      : '';
  return { bare, branches, tree, pushing };
}

// The script, its remote rewritten to the bare repository.
const start = (bare: string) =>
  spawn('node', ['test/e2e/run-test-org-labels.ts'], {
    env: {
      ...process.env,
      TEST_ORG_REPO: 'backmesh-dryrun/e2e',
      MATRIX: '{"include":[{"label":"backmesh-4"}]}',
      REF: 'a'.repeat(40),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.${bare}.insteadOf`,
      GIT_CONFIG_VALUE_0: REMOTE,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const exit = (child: ReturnType<typeof start>) =>
  new Promise<{ code: number | null; out: string }>((resolve) => {
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => resolve({ code, out }));
  });

describe('run-test-org-labels.ts', () => {
  it("pushes run.json on the default branch's tree, so its labels.yml runs, and deletes the branch after", async () => {
    const repo = testOrgRepo(true);
    const { code, out } = await exit(start(repo.bare));
    expect(code, out).toBe(0);
    expect(out).toContain(`${URL} passed`);
    expect(repo.tree().split('\n')).toEqual(
      expect.arrayContaining(['.github/workflows/labels.yml', 'run.json']),
    );
    expect(repo.branches()).toBe('');
  }, 30_000);

  it('deletes the branch when cancelled while it waits', async () => {
    const repo = testOrgRepo(false);
    const child = start(repo.bare);
    const done = exit(child);
    while (!repo.branches()) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    child.kill('SIGINT');
    const { code } = await done;
    expect(code).not.toBe(0);
    expect(repo.branches()).toBe('');
  }, 30_000);

  it('deletes the branch when cancelled during its push, once the push is done', async () => {
    const repo = testOrgRepo(false, { slowPush: true });
    const child = start(repo.bare);
    const done = exit(child);
    while (!repo.pushing()) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    child.kill('SIGINT');
    expect((await done).code).not.toBe(0);
    // Past any push still running on its own.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(repo.branches()).toBe('');
  }, 30_000);

  it("fails, pushing nothing, while the test org's labels.yml isn't this repository's copy", async () => {
    const repo = testOrgRepo(true, { labels: 'name: labels\n' });
    const { code, out } = await exit(start(repo.bare));
    expect(code).not.toBe(0);
    expect(out).toContain(
      "backmesh-dryrun/e2e's .github/workflows/labels.yml isn't test/e2e/test-org/labels.yml",
    );
    expect(repo.tree()).toBe('');
    expect(repo.branches()).toBe('');
  }, 30_000);
});
