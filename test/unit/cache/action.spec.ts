import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const github = vi.hoisted(() => ({
  restoreCache: vi.fn(async (): Promise<string | undefined> => undefined),
  saveCache: vi.fn(async () => 1),
}));
vi.mock('@actions/cache', () => github);

import {
  post,
  restore,
  restoreDeadlineMs,
  save,
} from '../../../src/cache/action.js';
import {
  entryVersion,
  esc,
  type ReadyFile,
} from '../../../src/cache/format.js';

let root: string;
let workspace: string;
const saved = { ...process.env };

// The step's environment, as the runner sets it, and its token copy.
async function step(
  inputs: Record<string, string>,
  file?: ReadyFile,
  state: Record<string, string> = {},
) {
  root = await mkdtemp(join(tmpdir(), 'bm-action-'));
  workspace = join(root, 'w', 'r', 'r');
  await mkdir(workspace, { recursive: true });
  for (const f of ['out', 'state']) await writeFile(join(root, f), '');
  if (file)
    await writeFile(join(root, '.backmesh-cache'), JSON.stringify(file));
  // On a backmesh runner the job's own RUNNER_NAME points at its live token
  // file; the test must see only the copy it writes.
  delete process.env.RUNNER_NAME;
  Object.assign(process.env, {
    RUNNER_TEMP: root,
    GITHUB_WORKSPACE: workspace,
    GITHUB_OUTPUT: join(root, 'out'),
    GITHUB_STATE: join(root, 'state'),
    ...Object.fromEntries(
      Object.entries(inputs).map(([k, v]) => [`INPUT_${k.toUpperCase()}`, v]),
    ),
    ...Object.fromEntries(
      Object.entries(state).map(([k, v]) => [`STATE_${k}`, v]),
    ),
  });
}
const outputs = async () => readFile(join(root, 'out'), 'utf8');

const own = 'cache/1/' + '0'.repeat(32) + '/';
const ready = (prefixes: ReadyFile['prefixes'] = { own }): ReadyFile => ({
  v: 1,
  state: 'ready',
  cloud: 'gcp',
  bucket: 'b',
  prefixes,
  tokens: [
    {
      prefixes: Object.values(prefixes),
      expiresAt: Date.now() + 9e5,
      credentials: { accessToken: 't' },
    },
  ],
  expiresAt: Date.now() + 9e5,
});

beforeEach(() => {
  github.restoreCache.mockClear();
  github.saveCache.mockClear();
  process.exitCode = undefined;
});
afterEach(async () => {
  process.env = { ...saved };
  vi.unstubAllGlobals();
  if (root) await rm(root, { recursive: true, force: true });
});

describe('restoreDeadlineMs', () => {
  it('gives 10 minutes, plus the entry at 50 MB/s, at most 2 hours', () => {
    expect(restoreDeadlineMs()).toBe(10 * 60_000);
    // 50 GB, a cap raised past the default: 1,000 s more.
    expect(restoreDeadlineMs(50e9)).toBe(10 * 60_000 + 1_000_000);
    expect(restoreDeadlineMs(1e12)).toBe(2 * 3_600_000);
  });
});

describe('the cache action', () => {
  it("uses GitHub's cache with no token file, and sets actions/cache's outputs", async () => {
    await step({ path: 'deps', key: 'k' });
    github.restoreCache.mockResolvedValueOnce('k');
    await restore();
    expect(github.restoreCache).toHaveBeenCalledOnce();
    expect(await outputs()).toMatch(
      /cache-hit[^]*true[^]*cache-matched-key[^]*k/,
    );
  });

  it("removes the entry's files when a piece fails, then uses GitHub's cache", async () => {
    await step(
      { path: 'deps', key: 'k', 'fail-on-cache-miss': 'true' },
      ready(),
    );
    const entry = `${own}e/${esc('k')}/${entryVersion(['deps'])}/0001-x/`;
    const manifest = {
      v: 1,
      key: 'k',
      bytes: 1,
      pieces: [{ name: 'p00.tar', zstd: false, members: ['deps/a.js'] }],
    };
    // A file the failed piece would have written, left from before.
    await mkdir(join(workspace, 'deps'));
    await writeFile(join(workspace, 'deps', 'a.js'), 'stale');
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.searchParams.get('list-type'))
        return new Response(
          `<ListBucketResult><Contents><Key>${entry}manifest.json</Key></Contents></ListBucketResult>`,
        );
      if (url.pathname.endsWith('manifest.json'))
        return Response.json(manifest);
      return new Response('gone', { status: 404 });
    });
    github.restoreCache.mockResolvedValueOnce(undefined);
    await restore();
    await expect(readFile(join(workspace, 'deps', 'a.js'))).rejects.toThrow(
      /ENOENT/,
    );
    expect(github.restoreCache).toHaveBeenCalledOnce();
    // GitHub's miss, with fail-on-cache-miss, fails the step.
    expect(process.exitCode).toBe(1);
  });

  it('saves nothing on a read-only ref, and the post step skips an exact hit', async () => {
    await step({ path: 'deps', key: 'k' }, ready({ default: own }));
    await save();
    expect(github.saveCache).not.toHaveBeenCalled();
    await expect(readFile(join(root, 'w', '_backmesh-cache'))).rejects.toThrow(
      /ENOENT/,
    );

    await step({ path: 'deps', key: 'k' }, undefined, {
      key: 'k',
      matched: 'k',
    });
    await post();
    expect(github.saveCache).not.toHaveBeenCalled();
  });

  it("refuses a key in the automatic caches' reserved prefix, in either cache", async () => {
    for (const file of [ready(), undefined]) {
      await step({ path: 'deps', key: 'bm-auto-npm-x64-s-l' }, file);
      await save();
      expect(github.saveCache).not.toHaveBeenCalled();
      await expect(
        readFile(join(root, 'w', '_backmesh-cache')),
      ).rejects.toThrow(/ENOENT/);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses GitHub's cache for a key too long for an object name", async () => {
    await step({ path: 'deps', key: 'k'.repeat(701) }, ready());
    await save();
    expect(github.saveCache).toHaveBeenCalledOnce();
  });
});
