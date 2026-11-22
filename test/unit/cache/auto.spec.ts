import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { judge, jobLines } from '../../../src/cache/auto/aside.js';
import {
  depKey,
  installedLocks,
  recordKey,
  toolsOf,
  type Facts,
  type JobRecord,
  type Restored,
} from '../../../src/cache/auto/job.js';
import { restore } from '../../../src/cache/auto/restore.js';
import { saveJob, type SaveJob } from '../../../src/cache/auto/save.js';
import { refPrefix, type ReadyFile } from '../../../src/cache/format.js';
import type { Store } from '../../../src/cache/store.js';
import { memoryStore } from './memory-store.js';

// The zstd CLI, as the runner image has it: on PATH, or ZSTD_DIR's.
if (process.env.ZSTD_DIR)
  process.env.PATH = `${process.env.ZSTD_DIR}:${process.env.PATH}`;

const DAY = 24 * 3_600_000;
const OWN = refPrefix(7, 'refs/heads/feature');
const DEF = refPrefix(7, 'refs/heads/main');
const JOB = {
  workflow: 'acme/app/.github/workflows/ci.yml',
  name: 'test (22)',
};
const WORKFLOW = `on: push
jobs:
  lint:
    env:
      BACKMESH_AUTO_CACHE: false
    steps:
      - run: true
  test:
    runs-on: backmesh-4
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v6
        with:
          node-version: 22
      - run: yarn install --frozen-lockfile
`;

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

// One runner's paths, the same for every job, as on backmesh's image; `vm`
// starts each job on a fresh one.
async function runner() {
  const root = await mkdtemp(join(tmpdir(), 'bm-auto-'));
  dirs.push(root);
  const r = {
    root,
    tools: join(root, 'toolcache'),
    home: join(root, 'home'),
    work: join(root, '_work'),
    ws: join(root, '_work', 'app', 'app'),
    state: join(root, 'state'),
    token: join(root, 'token'),
  };
  const vm = async (workflow = WORKFLOW) => {
    for (const d of [r.tools, r.home, r.work, r.state])
      await rm(d, { recursive: true, force: true });
    for (const d of [r.tools, r.home, r.state])
      await mkdir(d, { recursive: true });
    await mkdir(join(r.ws, '.github', 'workflows'), { recursive: true });
    await mkdir(join(r.ws, 'node_modules'));
    await writeFile(join(r.ws, '.github', 'workflows', 'ci.yml'), workflow);
    await writeFile(join(r.ws, 'yarn.lock'), 'left-pad@1.3.0\n');
  };
  return { ...r, vm };
}
type Runner = Awaited<ReturnType<typeof runner>>;

// setup-*'s install: the files, then the marker, last.
async function setupTool(r: Runner, tool = 'node', version = '22.23.5') {
  const dir = join(r.tools, tool, version, 'x64');
  await mkdir(join(dir, 'bin'), { recursive: true });
  await writeFile(join(dir, 'bin', tool), `#!${tool} ${version}`);
  await writeFile(join(dir, 'LICENSE'), 'MIT');
  await new Promise((ok) => setTimeout(ok, 5));
  await writeFile(`${dir}.complete`, '');
  return dir;
}
// A Yarn 1 install's download cache.
async function yarnCache(r: Runner, bytes = 100) {
  const dir = join(r.home, '.cache', 'yarn', 'v6');
  await mkdir(join(dir, 'npm-left-pad-1.3.0'), { recursive: true });
  await writeFile(
    join(dir, 'npm-left-pad-1.3.0', 'index.js'),
    'x'.repeat(bytes),
  );
  return dir;
}

const facts = (r: Runner, path: string): Facts => ({
  PATH: `${path}:/usr/local/bin:/usr/bin`,
  HOME: r.home,
  GITHUB_JOB: 'test',
  GITHUB_REPOSITORY: 'acme/app',
  GITHUB_WORKSPACE: r.ws,
  RUNNER_TOOL_CACHE: r.tools,
});

function bucket() {
  const { store, objects } = memoryStore();
  const manifests = () =>
    [...objects.keys()].filter((k) => k.endsWith('/manifest.json'));
  return { store, objects, manifests };
}
type Bucket = ReturnType<typeof bucket>;

async function save(
  r: Runner,
  b: Bucket,
  path: string,
  more: Partial<SaveJob> = {},
) {
  const restored = JSON.parse(
    await readFile(join(r.state, 'restored.json'), 'utf8').catch(
      () => '{"deps":{}}',
    ),
  ) as Restored;
  const logs: string[] = [];
  // The save starts after the job's last write.
  await new Promise((ok) => setTimeout(ok, 5));
  const record = await saveJob({
    store: b.store,
    prefixes: { own: OWN, default: DEF },
    own: OWN,
    job: JOB,
    facts: facts(r, path),
    restored,
    imageOs: 'ubuntu24',
    arch: 'x64',
    work: r.work,
    log: (l) => logs.push(l),
    ...more,
  });
  return { record, logs };
}

// The job's token, ready.
async function readyToken(
  r: Runner,
  prefixes: ReadyFile['prefixes'] = { own: OWN, default: DEF },
  job = JOB,
) {
  const file: ReadyFile = {
    v: 1,
    state: 'ready',
    cloud: 'aws',
    bucket: 'b',
    region: 'us-east-2',
    prefixes,
    tokens: [],
    expiresAt: Date.now() + 9e5,
    job,
  };
  await writeFile(r.token, JSON.stringify(file));
}
const envOf = (r: Runner) => ({
  RUNNER_TOOL_CACHE: r.tools,
  HOME: r.home,
  ImageOS: 'ubuntu24',
});
// The restores run at once, so their lines come in any order.
const linesOf = async (r: Runner) =>
  (await readFile(join(r.state, 'lines'), 'utf8').catch(() => ''))
    .trim()
    .split('\n')
    .filter(Boolean)
    .sort();

async function restoreJob(
  r: Runner,
  b: Bucket,
  prefixes: ReadyFile['prefixes'] = { own: OWN, default: DEF },
  job = JOB,
) {
  await readyToken(r, prefixes, job);
  await restore(r.token, r.state, envOf(r), () => b.store);
  return linesOf(r);
}

// A bucket whose bodies of keys matching `held` stall until `open()`.
function gated(b: Bucket, held: RegExp) {
  let open!: () => void;
  const gate = new Promise<void>((ok) => (open = ok));
  const store: Store = {
    ...b.store,
    get: async (key) => {
      const res = await b.store.get(key);
      if (!held.test(key)) return res;
      const data = new Uint8Array(await res.arrayBuffer());
      return new Response(
        new ReadableStream({
          async pull(c) {
            await gate;
            c.enqueue(data);
            c.close();
          },
        }),
      );
    },
  };
  return { store, open };
}
// Polls `check` for up to 2 s.
async function eventually(check: () => Promise<boolean>) {
  for (let i = 0; i < 400 && !(await check()); i++)
    await new Promise((ok) => setTimeout(ok, 5));
  return check();
}
const started = (r: Runner, at = Date.now()) =>
  writeFile(join(r.state, 'started'), String(at));
const exists = (path: string) =>
  readFile(path).then(
    () => true,
    () => false,
  );
async function until(path: string) {
  while (!(await exists(path))) await new Promise((ok) => setTimeout(ok, 5));
}

describe('the automatic caches, from one job to the next', () => {
  it('saves the tools and caches a job used, restores them into its next run, and stores nothing more', async () => {
    const r = await runner();
    const b = bucket();
    await r.vm();
    const node = await setupTool(r);
    await yarnCache(r);
    const first = await save(r, b, join(node, 'bin'));
    expect(first.record.tools).toEqual([
      { tool: 'node', version: '22.23.5', arch: 'x64' },
    ]);
    expect(first.record.deps.map((d) => d.pm)).toEqual(['yarn']);
    // The tool, the Yarn cache and the record.
    expect(b.manifests()).toHaveLength(3);

    await r.vm();
    const lines = await restoreJob(r, b);
    expect(lines).toEqual([
      expect.stringMatching(
        /^backmesh cache: auto restored node 22\.23\.5 \(own\)/,
      ),
      expect.stringMatching(/^backmesh cache: auto restored yarn \(own\)/),
    ]);
    expect(await readFile(join(node, 'bin', 'node'), 'utf8')).toBe(
      '#!node 22.23.5',
    );
    // setup-* takes a tool without its marker as missing.
    await expect(readFile(`${node}.complete`)).resolves.toBeDefined();
    const yarn = join(
      r.home,
      '.cache',
      'yarn',
      'v6',
      'npm-left-pad-1.3.0',
      'index.js',
    );
    expect(await readFile(yarn, 'utf8')).toHaveLength(100);
    // No staging directory is left beside a target.
    expect(await readdir(join(r.tools, 'node', '22.23.5'))).toEqual([
      'x64',
      'x64.complete',
    ]);

    const second = await save(r, b, join(node, 'bin'));
    expect(second.record).toEqual(first.record);
    expect(b.manifests()).toHaveLength(3);
  });

  it('restores nothing for another matrix leg, which has no record yet, and says so', async () => {
    const r = await runner();
    const b = bucket();
    await r.vm();
    await yarnCache(r);
    await save(r, b, join(await setupTool(r), 'bin'));
    await r.vm();
    expect(
      await restoreJob(r, b, undefined, { ...JOB, name: 'test (20)' }),
    ).toEqual([
      'backmesh cache: auto found no record of this job yet: its save writes one',
    ]);
    await expect(readdir(join(r.tools))).resolves.toEqual([]);
  });

  it("restores a new branch's first job from the default branch's record, and the job then stores nothing", async () => {
    const r = await runner();
    const b = bucket();
    await r.vm();
    await yarnCache(r);
    const node = await setupTool(r);
    await save(r, b, join(node, 'bin'), {
      prefixes: { own: DEF, default: DEF },
      own: DEF,
    });
    await r.vm();
    const lines = await restoreJob(r, b);
    expect(lines.every((l) => l.includes('(default)'))).toBe(true);
    const before = b.objects.size;
    await save(r, b, join(node, 'bin'));
    expect(b.objects.size).toBe(before);
  });

  it('gives way to a step that made its directory first', async () => {
    const r = await runner();
    const b = bucket();
    await r.vm();
    await yarnCache(r);
    await save(r, b, join(r.tools, 'none'));
    await r.vm();
    const mine = join(r.home, '.cache', 'yarn', 'v6');
    await mkdir(mine, { recursive: true });
    await writeFile(join(mine, 'own'), 'step');
    expect(await restoreJob(r, b)).toEqual([
      expect.stringMatching(
        /^backmesh cache: auto gave way yarn: a step made .* first, at \+\d+\.\d s$/,
      ),
    ]);
    expect(await readdir(mine)).toEqual(['own']);
    expect(await readdir(join(r.home, '.cache', 'yarn'))).toEqual(['v6']);
  });

  it('leaves no directory when a piece fails, such as one swept mid-fetch', async () => {
    const r = await runner();
    const b = bucket();
    await r.vm();
    const node = await setupTool(r);
    await save(r, b, join(node, 'bin'));
    for (const k of b.objects.keys())
      if (k.includes('bm-auto-tool') && k.endsWith('.tar.zst'))
        b.objects.delete(k);
    await r.vm();
    expect(await restoreJob(r, b)).toEqual([
      expect.stringMatching(/^backmesh cache: auto failed node 22\.23\.5: /),
    ]);
    // Neither the tool, its marker, nor a staging directory.
    expect(await readdir(r.tools)).toEqual(['node']);
    expect(await readdir(join(r.tools, 'node'))).toEqual(['22.23.5']);
    expect(await readdir(join(r.tools, 'node', '22.23.5'))).toEqual([]);
  });

  it('holds the hook for the tools only: a dependency cache restores in the background', async () => {
    const r = await runner();
    const b = bucket();
    await r.vm();
    const node = await setupTool(r);
    await yarnCache(r);
    await save(r, b, join(node, 'bin'));
    await r.vm();
    await readyToken(r);
    const g = gated(b, /bm-auto-yarn.*\.tar/);
    const running = restore(r.token, r.state, envOf(r), () => g.store);
    await until(join(r.state, 'tools-done'));
    expect(await linesOf(r)).toEqual([
      expect.stringMatching(/^backmesh cache: auto restored node 22\.23\.5/),
    ]);
    expect(await exists(join(r.state, 'done'))).toBe(false);
    g.open();
    await running;
    expect(await linesOf(r)).toEqual([
      expect.stringMatching(/restored node/),
      expect.stringMatching(
        /^backmesh cache: auto restored yarn \(own\) {2}0 MB in \d+\.\d s, at \+\d+\.\d s$/,
      ),
    ]);
    // For the saver: when it landed, which it notes before the rename.
    const restored = JSON.parse(
      await readFile(join(r.state, 'restored.json'), 'utf8'),
    ) as Restored;
    expect(restored.deps.yarn?.landed).toBeGreaterThan(0);
  });

  it('gives way to a step that makes the directory while it downloads, and leaves the step its files', async () => {
    const r = await runner();
    const b = bucket();
    await r.vm();
    await yarnCache(r);
    await save(r, b, join(r.tools, 'none'));
    await r.vm();
    await readyToken(r);
    const g = gated(b, /bm-auto-yarn.*\.tar/);
    const running = restore(r.token, r.state, envOf(r), () => g.store);
    await until(join(r.state, 'tools-done'));
    const mine = join(r.home, '.cache', 'yarn', 'v6');
    await mkdir(mine, { recursive: true });
    await writeFile(join(mine, 'own'), 'step');
    g.open();
    await running;
    expect(await linesOf(r)).toEqual([
      expect.stringMatching(/^backmesh cache: auto gave way yarn/),
    ]);
    expect(await readdir(mine)).toEqual(['own']);
    expect(await readdir(join(r.home, '.cache', 'yarn'))).toEqual(['v6']);
    // Not restored, so the saver treats the step's cache as the job's.
    expect(
      JSON.parse(await readFile(join(r.state, 'restored.json'), 'utf8')).deps,
    ).toEqual({});
  });

  it("gives up a dependency cache still restoring at its limit after the job's start, stops its download and leaves no directory", async () => {
    const r = await runner();
    const b = bucket();
    await r.vm();
    await yarnCache(r);
    await save(r, b, join(r.tools, 'none'));
    await r.vm();
    await readyToken(r);
    await started(r);
    const g = gated(b, /bm-auto-yarn.*\.tar/);
    await restore(r.token, r.state, envOf(r), () => g.store, 300);
    expect(await linesOf(r)).toEqual([
      expect.stringMatching(
        /^backmesh cache: auto gave up yarn: still restoring at \+0\.[3-9] s$/,
      ),
    ]);
    // The download stops, without its body ever ending, and its staging
    // directory goes.
    const yarn = join(r.home, '.cache', 'yarn');
    expect(await eventually(async () => !(await readdir(yarn)).length)).toBe(
      true,
    );
    expect(
      JSON.parse(await readFile(join(r.state, 'restored.json'), 'utf8')).deps,
    ).toEqual({});
  });

  it("counts its limit from the job's start, so a runner started early waits on for its job", async () => {
    const r = await runner();
    const b = bucket();
    await r.vm();
    await yarnCache(r);
    await save(r, b, join(r.tools, 'none'));
    await r.vm();
    await writeFile(r.token, JSON.stringify({ v: 1, state: 'pending' }));
    const running = restore(r.token, r.state, envOf(r), () => b.store, 600);
    // Past the limit, idle: no job yet.
    await new Promise((ok) => setTimeout(ok, 800));
    await started(r);
    await readyToken(r);
    await running;
    expect(await linesOf(r)).toEqual([
      expect.stringMatching(/^backmesh cache: auto restored yarn \(own\)/),
    ]);
  });

  it('stops its restores when told to, and leaves no staging directory', async () => {
    const r = await runner();
    const b = bucket();
    await r.vm();
    await yarnCache(r);
    await save(r, b, join(r.tools, 'none'));
    await r.vm();
    await readyToken(r);
    const g = gated(b, /bm-auto-yarn.*\.tar/);
    const stop = new AbortController();
    const running = restore(
      r.token,
      r.state,
      envOf(r),
      () => g.store,
      undefined,
      stop.signal,
    );
    const yarn = join(r.home, '.cache', 'yarn');
    await eventually(async () =>
      (await readdir(yarn).catch(() => [])).some((n) => n.includes('.bm-')),
    );
    stop.abort();
    await running;
    expect(await readdir(yarn)).toEqual([]);
    await expect(readFile(join(r.state, 'done'))).resolves.toBeDefined();
    expect(await linesOf(r)).toEqual([
      'backmesh cache: auto stopped yarn: the job ended',
    ]);
  });

  it('says nothing when stopped on a runner that never got a job', async () => {
    const r = await runner();
    const b = bucket();
    await r.vm();
    await writeFile(r.token, JSON.stringify({ v: 1, state: 'pending' }));
    const stop = new AbortController();
    const running = restore(
      r.token,
      r.state,
      {},
      () => b.store,
      undefined,
      stop.signal,
    );
    await new Promise((ok) => setTimeout(ok, 50));
    stop.abort();
    await running;
    expect(await linesOf(r)).toEqual([]);
  });

  it("ends a request stalled before its response, through the store's signal", async () => {
    const r = await runner();
    const b = bucket();
    await r.vm();
    await yarnCache(r);
    await save(r, b, join(r.tools, 'none'));
    await r.vm();
    await readyToken(r);
    await started(r);
    // A piece's GET that never answers, until its signal ends it.
    const storeOf = (_: unknown, signal?: AbortSignal): Store => ({
      ...b.store,
      get: (key) =>
        /bm-auto-yarn.*\.tar/.test(key)
          ? new Promise((_, fail) =>
              signal?.addEventListener('abort', () => fail(signal.reason)),
            )
          : b.store.get(key),
    });
    await restore(r.token, r.state, envOf(r), storeOf, 300);
    const yarn = join(r.home, '.cache', 'yarn');
    expect(await eventually(async () => !(await readdir(yarn)).length)).toBe(
      true,
    );
  });

  it('ends a tool download once the hook gave up, and leaves no directory', async () => {
    const r = await runner();
    const b = bucket();
    await r.vm();
    await save(r, b, join(await setupTool(r), 'bin'));
    await r.vm();
    await readyToken(r);
    const g = gated(b, /bm-auto-tool.*\.tar/);
    const running = restore(r.token, r.state, envOf(r), () => g.store);
    const version = join(r.tools, 'node', '22.23.5');
    await eventually(async () =>
      (await readdir(version).catch(() => [])).some((n) => n.includes('.bm-')),
    );
    await writeFile(join(r.state, 'gave-up'), '');
    await running;
    expect(await linesOf(r)).toEqual([
      'backmesh cache: auto skipped node 22.23.5: the job started without it',
    ]);
    expect(await readdir(version)).toEqual([]);
  });

  it('once the hook gave up, restores no tool, but waits on for the token for the dependency caches', async () => {
    const r = await runner();
    const b = bucket();
    await r.vm();
    const node = await setupTool(r);
    await yarnCache(r);
    await save(r, b, join(node, 'bin'));
    await r.vm();
    await writeFile(r.token, JSON.stringify({ v: 1, state: 'pending' }));
    await writeFile(join(r.state, 'gave-up'), '');
    const running = restore(r.token, r.state, envOf(r), () => b.store);
    await new Promise((ok) => setTimeout(ok, 300));
    await readyToken(r);
    await running;
    expect(await linesOf(r)).toEqual([
      expect.stringMatching(/^backmesh cache: auto restored yarn \(own\)/),
      'backmesh cache: auto skipped node 22.23.5: the job started without it',
    ]);
    expect(await readdir(r.tools)).toEqual([]);
  });

  it('gives up on a token still pending at its limit', async () => {
    const r = await runner();
    const b = bucket();
    await r.vm();
    await writeFile(r.token, JSON.stringify({ v: 1, state: 'pending' }));
    await started(r);
    await restore(r.token, r.state, {}, () => b.store, 300);
    expect(await linesOf(r)).toEqual([
      expect.stringMatching(
        /^backmesh cache: auto gave up: no cache token by \+\d+\.\d s$/,
      ),
    ]);
    await expect(readFile(join(r.state, 'done'))).resolves.toBeDefined();
    await expect(readFile(join(r.state, 'tools-done'))).resolves.toBeDefined();
    // The hook's timing line reads when the token came: it never did.
    await expect(readFile(join(r.state, 'ready'))).rejects.toThrow();
  });

  it('notes when the token came, for the hook to time its wait', async () => {
    const r = await runner();
    const b = bucket();
    await r.vm();
    const before = Date.now();
    await restoreJob(r, b);
    const ready = Number(await readFile(join(r.state, 'ready'), 'utf8'));
    expect(ready).toBeGreaterThanOrEqual(before);
    expect(ready).toBeLessThanOrEqual(Date.now());
  });

  it('says why when the cache is off for the runner', async () => {
    const r = await runner();
    const b = bucket();
    await r.vm();
    await writeFile(
      r.token,
      JSON.stringify({ v: 1, state: 'off', reason: 'FORBIDDEN' }),
    );
    await restore(r.token, r.state, {}, () => b.store);
    expect(await readFile(join(r.state, 'lines'), 'utf8')).toBe(
      'backmesh cache: auto skipped: the cache is off for this runner (FORBIDDEN)\n',
    );
  });

  it('ignores a record whose tool names a path outside the tool cache', async () => {
    const r = await runner();
    const b = bucket();
    await r.vm();
    const { record } = await save(r, b, join(await setupTool(r), 'bin'));
    // The job's own ref is the job's to write.
    const key = [...b.objects.keys()].find(
      (k) => k.includes(recordKey(JOB)) && k.endsWith('record.json'),
    )!;
    const bad: JobRecord = {
      ...record,
      tools: [{ tool: '..', version: '..', arch: 'etc' }],
    };
    b.objects.set(key, Buffer.from(JSON.stringify(bad)));
    await r.vm();
    expect(await restoreJob(r, b)).toEqual([
      expect.stringMatching(/ignored its job record/),
    ]);
  });
});

describe('the saver', () => {
  it("doesn't save a tool a step changed after setup, and leaves out corepack's links and Python's bytecode", async () => {
    const r = await runner();
    const b = bucket();
    await r.vm();
    const python = await setupTool(r, 'Python', '3.12.16');
    const node = await setupTool(r, 'node');
    // pip install outside a virtual environment, into Python's own tree.
    await mkdir(join(python, 'lib', 'site-packages'), { recursive: true });
    await writeFile(join(python, 'lib', 'site-packages', 'requests.py'), '');
    // corepack enable, and Python's first import of its modules.
    await symlink('../lib/corepack/yarn.js', join(node, 'bin', 'yarn'));
    await mkdir(join(node, 'lib', '__pycache__'), { recursive: true });
    await writeFile(join(node, 'lib', '__pycache__', 'gyp.pyc'), '');
    const { record, logs } = await save(
      r,
      b,
      `${join(python, 'bin')}:${join(node, 'bin')}`,
    );
    // A tool it can't save stays out of the record: the next job would
    // only miss it.
    expect(record.tools.map((t) => t.tool)).toEqual(['node']);
    expect(logs).toContainEqual(
      expect.stringMatching(
        /^result=changed key=bm-auto-tool-ubuntu24-Python-3\.12\.16-x64 /,
      ),
    );
    expect(logs).toContainEqual(
      expect.stringMatching(
        /^result=saved key=bm-auto-tool-ubuntu24-node-22\.23\.5-x64 /,
      ),
    );
    const pieces = await Promise.all(
      [...b.objects.keys()]
        .filter(
          (k) => k.includes('bm-auto-tool') && k.endsWith('manifest.json'),
        )
        .map(async (k) => JSON.parse(b.objects.get(k)!.toString())),
    );
    const members = pieces.flatMap((m) =>
      m.pieces.flatMap((p: { members: string[] }) => p.members),
    );
    expect(members).not.toContain('bin/yarn');
    expect(members).toContain('bin/node');
  });

  it('leaves a tool whose upload failed out of the record', async () => {
    const r = await runner();
    const b = bucket();
    await r.vm();
    const node = await setupTool(r);
    const put = b.store.put;
    b.store.put = async (key, body) => {
      if (key.includes('bm-auto-tool') && !key.endsWith('/claim'))
        throw new Error('503');
      return put(key, body);
    };
    const { record, logs } = await save(r, b, join(node, 'bin'));
    expect(record.tools).toEqual([]);
    expect(logs).toContainEqual(
      expect.stringMatching(
        /^result=failed key=bm-auto-tool-ubuntu24-node-22\.23\.5-x64 /,
      ),
    );
  });

  it('stores nothing for a container: job, and its next run restores nothing', async () => {
    const r = await runner();
    const b = bucket();
    await r.vm();
    await yarnCache(r);
    await setupTool(r);
    const { record } = await save(r, b, '/__t/node/22.23.5/x64/bin');
    expect(record).toEqual({
      v: 1,
      tools: [],
      deps: [],
      aside: [],
      container: true,
    });
    expect(b.manifests()).toHaveLength(1);
    await r.vm();
    expect(await restoreJob(r, b)).toEqual([
      'backmesh cache: auto skipped: a container: job runs in its own image',
    ]);
  });

  it('saves only the record for a job that opts out, or whose workflow it cannot read, and its next run says why', async () => {
    for (const workflow of [
      WORKFLOW.replace(
        '    runs-on: backmesh-4',
        '    env:\n      BACKMESH_AUTO_CACHE: "false"',
      ),
      'name: not this job\n',
    ]) {
      const r = await runner();
      const b = bucket();
      await r.vm(workflow);
      await yarnCache(r);
      const { record } = await save(r, b, join(await setupTool(r), 'bin'));
      expect(record).toEqual({
        v: 1,
        tools: [],
        deps: [],
        aside: [],
        off: true,
      });
      expect(b.manifests()).toHaveLength(1);
      await r.vm();
      expect(await restoreJob(r, b)).toEqual([
        'backmesh cache: auto skipped: the job opts out, or its workflow file is not in its repository',
      ]);
    }
  });

  it('steps aside for a cache the job keeps itself, and the next run skips it too', async () => {
    const r = await runner();
    const b = bucket();
    const own = WORKFLOW.replace(
      '      - run: yarn',
      '      - uses: ./.github/actions/deps\n      - run: yarn',
    );
    await r.vm(own);
    // A local composite action that caches Yarn's directory.
    await mkdir(join(r.ws, '.github', 'actions', 'deps'), { recursive: true });
    await writeFile(
      join(r.ws, '.github', 'actions', 'deps', 'action.yml'),
      'runs:\n  using: composite\n  steps:\n    - uses: actions/cache@v4\n      with:\n        path: |\n          node_modules\n          ~/.cache/yarn\n        key: y\n',
    );
    await yarnCache(r);
    const { record } = await save(r, b, join(r.tools, 'none'));
    expect(record.aside).toEqual(['yarn']);
    expect(b.manifests()).toHaveLength(1);
    await r.vm(own);
    expect(await restoreJob(r, b)).toEqual([
      'backmesh cache: auto skipped yarn: the job caches .cache/yarn/v6 itself',
    ]);
  });

  it("skips a key another job's upload has claimed", async () => {
    const r = await runner();
    const b = bucket();
    await r.vm();
    await yarnCache(r);
    const first = await save(r, b, join(r.tools, 'none'));
    // A job that finished with this one, still uploading: its claim only.
    const b2 = bucket();
    for (const [k, v] of b.objects)
      if (k.includes('bm-auto-yarn') && k.endsWith('/claim'))
        b2.objects.set(k, v);
    await save(r, b2, join(r.tools, 'none'));
    expect(b2.manifests().filter((k) => k.includes('bm-auto-yarn'))).toEqual(
      [],
    );
    expect(first.record.deps).toHaveLength(1);
  });

  it('resets a line that grew past twice its cold save, and the cold install after it starts a new one', async () => {
    const r = await runner();
    const b = bucket();
    await r.vm();
    await yarnCache(r, 100);
    await save(r, b, join(r.tools, 'none'));
    // A new lockfile: the restore, of the record's key, is one lockfile
    // behind, and the install adds 200 bytes of new packages to the 100.
    await r.vm();
    await writeFile(join(r.ws, 'yarn.lock'), 'left-pad@1.3.1\n');
    expect(await restoreJob(r, b)).toEqual([
      expect.stringMatching(/restored yarn \(own\)/),
    ]);
    // The install, after the restore landed.
    await new Promise((ok) => setTimeout(ok, 5));
    await writeFile(
      join(r.home, '.cache', 'yarn', 'v6', 'new.js'),
      'y'.repeat(200),
    );
    const grown = await save(r, b, join(r.tools, 'none'));
    expect(grown.record.deps[0]).toMatchObject({ base: 100, reset: true });
    expect(grown.logs).toEqual([
      expect.stringMatching(/^result=reset /),
      expect.stringMatching(/^result=recorded /),
    ]);

    await r.vm();
    await writeFile(join(r.ws, 'yarn.lock'), 'left-pad@1.3.1\n');
    expect(await restoreJob(r, b)).toEqual([
      expect.stringMatching(/skipped yarn: its cache outgrew its lockfile/),
    ]);
    await yarnCache(r, 150);
    const cold = await save(r, b, join(r.tools, 'none'));
    expect(cold.record.deps[0]).toEqual({
      pm: 'yarn',
      key: grown.record.deps[0]!.key,
      base: 150,
    });
    expect(cold.logs[0]).toMatch(/^result=saved key=bm-auto-yarn-/);
  });

  it("saves the default branch's dependency entry again past 3 days, never a tool, and refreshes an old record", async () => {
    const r = await runner();
    const b = bucket();
    const main = { prefixes: { own: DEF, default: DEF }, own: DEF };
    await r.vm();
    await yarnCache(r);
    const node = await setupTool(r);
    await save(r, b, join(node, 'bin'), main);
    await r.vm();
    await restoreJob(r, b, { own: DEF, default: DEF });
    const later = { ...main, now: Date.now() + 4 * DAY };
    const { logs } = await save(r, b, join(node, 'bin'), later);
    expect(logs).toEqual([
      expect.stringMatching(/^result=saved key=bm-auto-yarn-/),
      expect.stringMatching(/^result=recorded /),
    ]);
    // Within 3 days, or on another branch, nothing is saved again.
    expect((await save(r, b, join(node, 'bin'), main)).logs).toEqual([]);
    await r.vm();
    await restoreJob(r, b);
    expect(
      (await save(r, b, join(node, 'bin'), { now: Date.now() + 4 * DAY })).logs,
    ).toEqual([]);
  });
});

describe('the saver, after a dependency cache restored in the background', () => {
  // A restore of the record's key, one lockfile behind; `install` writes
  // into the cache after it lands.
  async function behind(install: boolean) {
    const r = await runner();
    const b = bucket();
    await r.vm();
    await yarnCache(r);
    await save(r, b, join(r.tools, 'none'));
    await r.vm();
    await writeFile(join(r.ws, 'yarn.lock'), 'left-pad@1.3.1\n');
    await restoreJob(r, b);
    await new Promise((ok) => setTimeout(ok, 5));
    if (install)
      await writeFile(join(r.home, '.cache', 'yarn', 'v6', 'new.js'), 'y');
    return { r, b, ...(await save(r, b, join(r.tools, 'none'))) };
  }

  it("doesn't save it under the new lockfile when nothing was written into it after it landed", async () => {
    const { logs, record } = await behind(false);
    expect(logs).toEqual([
      expect.stringMatching(/^result=stale key=bm-auto-yarn-/),
      expect.stringMatching(/^result=recorded /),
    ]);
    // Still in the record, so the next run restores it.
    expect(record.deps.map((d) => d.pm)).toEqual(['yarn']);
  });

  it('saves it when the install wrote into it after it landed', async () => {
    const { logs } = await behind(true);
    expect(logs[0]).toMatch(/^result=saved key=bm-auto-yarn-/);
  });
});

describe("Yarn 1's save", () => {
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  const lock = (...hashes: string[]) =>
    hashes
      .map(
        (h) =>
          `x@${h.slice(0, 1)}:\n  resolved "https://registry.yarnpkg.com/x/-/x.tgz#${h}"\n`,
      )
      .join('');

  // A restore one lockfile behind, landed after the install, which wrote
  // nothing into it: saved under the new lockfile only if it holds every
  // entry that lockfile names.
  it.each([
    ['saves it when it holds every entry', lock(A), /^result=saved /],
    ['marks it stale when it lacks one', lock(A, B), /^result=stale /],
  ])('%s the new lockfile names', async (_, next, result) => {
    const r = await runner();
    const b = bucket();
    await r.vm();
    await writeFile(join(r.ws, 'yarn.lock'), `# first\n${lock(A)}`);
    const entry = join(r.home, '.cache', 'yarn', 'v6', `npm-x-1.0.0-${A}`);
    await mkdir(entry, { recursive: true });
    await writeFile(join(entry, 'f'), 'x');
    await save(r, b, join(r.tools, 'none'));
    await r.vm();
    await writeFile(join(r.ws, 'yarn.lock'), next);
    await restoreJob(r, b);
    const { logs } = await save(r, b, join(r.tools, 'none'));
    expect(logs[0]).toMatch(result);
  });

  it('leaves out the entries no installed lockfile resolves', async () => {
    const r = await runner();
    const b = bucket();
    await r.vm();
    const used = 'a'.repeat(40);
    const old = 'b'.repeat(40);
    await writeFile(
      join(r.ws, 'yarn.lock'),
      `left-pad@^1.3.0:\n  version "1.3.0"\n  resolved "https://registry.yarnpkg.com/left-pad/-/left-pad-1.3.0.tgz#${used}"\n`,
    );
    const v6 = join(r.home, '.cache', 'yarn', 'v6');
    for (const name of [
      `npm-left-pad-1.3.0-${used}-integrity`,
      `npm-left-pad-1.2.0-${old}-integrity`,
      // No hash in its name, such as a file: package's: kept.
      'npm-local-1.0.0',
      '.tmp',
    ]) {
      await mkdir(join(v6, name), { recursive: true });
      await writeFile(join(v6, name, 'f'), 'x');
    }
    const { record } = await save(r, b, join(r.tools, 'none'));
    expect(record.deps[0]?.base).toBe(2);
    await r.vm();
    await restoreJob(r, b);
    expect((await readdir(v6)).sort()).toEqual([
      'npm-left-pad-1.3.0-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-integrity',
      'npm-local-1.0.0',
    ]);
  });
});

describe('toolsOf', () => {
  it('takes each tool-cache directory PATH names, and nothing outside the tool cache', () => {
    const t = '/w/toolcache';
    const path = [
      `${t}/node/22.23.5/x64/bin`,
      `${t}/node/22.23.5/x64/lib/node_modules/npm/bin`,
      `${t}/Python/3.12.16/x64`,
      `${t}/go/1.24.13/x64/../../../../../etc`,
      `${t}/short/1.0`,
      `${t}`,
      'relative/bin',
      '/usr/bin',
    ].join(':');
    expect(toolsOf(path, t)).toEqual([
      { tool: 'node', version: '22.23.5', arch: 'x64' },
      { tool: 'Python', version: '3.12.16', arch: 'x64' },
    ]);
  });
});

describe('lockfile keys', () => {
  it('keys each manager by the lockfiles the job installed, by path and content', async () => {
    const r = await runner();
    await r.vm();
    // Installed: the root's and packages/a's; not packages/b's, nor one in
    // node_modules, nor one five levels down.
    for (const d of ['packages/a', 'packages/b', 'node_modules/x', 'a/b/c/d/e'])
      await mkdir(join(r.ws, d), { recursive: true });
    for (const d of ['packages/a', 'a/b/c/d/e'])
      await mkdir(join(r.ws, d, 'node_modules'), { recursive: true });
    for (const f of [
      'packages/a/package-lock.json',
      'packages/b/package-lock.json',
      'node_modules/x/yarn.lock',
      'a/b/c/d/e/yarn.lock',
    ])
      await writeFile(join(r.ws, f), '{}');
    const locks = await installedLocks(r.ws);
    expect(locks).toEqual(['packages/a/package-lock.json', 'yarn.lock']);
    const npm = await depKey('npm', 'x64', r.ws, locks);
    const yarn = await depKey('yarn', 'x64', r.ws, locks);
    expect(npm).toMatch(/^bm-auto-npm-x64-[0-9a-f]{16}-[0-9a-f]{32}$/);
    expect(await depKey('pnpm', 'x64', r.ws, locks)).toBeUndefined();
    // A changed lockfile keeps its line's set and changes the key.
    await writeFile(join(r.ws, 'yarn.lock'), 'left-pad@2.0.0\n');
    const changed = await depKey('yarn', 'x64', r.ws, locks);
    expect(changed!.slice(0, -32)).toBe(yarn!.slice(0, -32));
    expect(changed).not.toBe(yarn);
  });
});

describe('judge', () => {
  const job = (steps: string, env = '') =>
    jobLines(`${env}jobs:\n  test:\n    steps:\n${steps}`, 'test')!;
  const aside = (steps: string, pkg = {}) =>
    [...judge([job(steps)], pkg).aside].sort();

  it("steps aside for actions/cache or backmesh/cache naming a manager's directory", () => {
    expect(
      aside(
        '      - uses: actions/cache@v4\n        with:\n          path: ~/.npm\n',
      ),
    ).toEqual(['npm']);
    expect(
      aside(
        "      - uses: 'backmesh/cache/restore@v1'\n        with:\n          path: |\n            node_modules\n            ~/.yarn/berry/cache\n",
      ),
    ).toEqual(['berry']);
    // A path from a step's output: the command that made it.
    expect(
      aside(
        '      - id: dir\n        run: echo "dir=$(pnpm store path)" >> $GITHUB_OUTPUT\n      - uses: actions/cache@v4\n        with:\n          path: ${{ steps.dir.outputs.dir }}\n',
      ),
    ).toEqual(['pnpm']);
    expect(
      aside(
        '      - uses: actions/upload-artifact@v4\n        with:\n          path: ~/.npm\n',
      ),
    ).toEqual([]);
  });

  it("steps aside for setup-node's cache, but not for an expression", () => {
    const node = (w: string, at = 'v6') =>
      `      - uses: actions/setup-node@${at}\n        with:\n${w}`;
    expect(aside(node('          cache: yarn\n'))).toEqual(['berry', 'yarn']);
    expect(
      aside(
        node(
          "          cache: ${{ vars.CI_BACKEND == 'hosted' && 'yarn' || '' }}\n",
        ),
      ),
    ).toEqual([]);
    // v5 and later cache npm unasked when the project names npm.
    const npm = { packageManager: 'npm@10.9.0' };
    expect(aside(node('          node-version: 22\n'), npm)).toEqual(['npm']);
    expect(
      aside(node('          node-version: 22\n'), {
        devEngines: { packageManager: { name: 'npm' } },
      }),
    ).toEqual(['npm']);
    expect(aside(node('          node-version: 22\n', 'v4'), npm)).toEqual([]);
    expect(
      aside(
        node(
          '          node-version: 22\n',
          '49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0',
        ),
        npm,
      ),
    ).toEqual([]);
    expect(
      aside(node('          package-manager-cache: false\n'), npm),
    ).toEqual([]);
    expect(
      aside(node('          node-version: 22\n'), {
        packageManager: 'yarn@4.5.0',
      }),
    ).toEqual([]);
  });

  it("reads the opt-out from the workflow's or the job's env, not another job's", () => {
    const steps = '      - run: true\n';
    expect(
      judge([job(steps, 'env:\n  BACKMESH_AUTO_CACHE: false\n')]).off,
    ).toBe(true);
    expect(
      judge([job(`    env:\n      BACKMESH_AUTO_CACHE: 'false'\n${steps}`)])
        .off,
    ).toBe(true);
    expect(judge([jobLines(WORKFLOW, 'test')!]).off).toBe(false);
    expect(judge([jobLines(WORKFLOW, 'lint')!]).off).toBe(true);
    expect(jobLines(WORKFLOW, 'deploy')).toBeUndefined();
  });
});
