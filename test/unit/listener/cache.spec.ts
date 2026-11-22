import { ORPCError } from '@orpc/client';
import { describe, expect, it } from 'vitest';

import { refPrefix, type CacheFile } from '../../../src/cache/format.js';
import { jobMessageSchema } from '../../../src/github/types.js';
import { CacheTokens, deriveRefs } from '../../../src/listener/cache.js';
import type { RunFacts } from '../../../src/github/runs.js';
import type { Route } from '../../../src/listener/routes.js';
import { assigned, message, ROUTE, setup } from './fakes.js';

const run = (over: Partial<RunFacts> = {}): RunFacts => ({
  repoId: 7,
  path: '.github/workflows/ci.yml',
  headBranch: 'feature',
  headRepository: 'acme/app',
  pullRequests: [],
  defaultBranch: 'main',
  ...over,
});
const job = (
  eventName: string,
  ref: string,
  path = '.github/workflows/ci.yml',
) => ({
  eventName,
  jobWorkflowRef: `acme/app/${path}@${ref}`,
  ownerName: 'Acme',
  repositoryName: 'App',
});

describe('deriveRefs', () => {
  it('writes a push to its own branch, and reads the default branch', () => {
    expect(deriveRefs(job('push', 'refs/heads/feature'), run())).toEqual({
      own: 'refs/heads/feature',
      default: 'refs/heads/main',
    });
    // A branch with a slash, and the default branch.
    for (const branch of ['feature/x', 'main'])
      expect(
        deriveRefs(
          job('push', `refs/heads/${branch}`),
          run({ headBranch: branch }),
        ).own,
      ).toBe(`refs/heads/${branch}`);
    // A schedule or a dispatch on its branch, and a reusable workflow of its
    // own repository on a branch push.
    for (const event of ['schedule', 'workflow_dispatch'])
      expect(deriveRefs(job(event, 'refs/heads/feature'), run()).own).toBe(
        'refs/heads/feature',
      );
    expect(
      deriveRefs(
        job('push', 'refs/heads/feature', '.github/workflows/build.yml'),
        run(),
      ).own,
    ).toBe('refs/heads/feature');
  });

  it("gives a pull request its merge ref and its base, and a fork's no write", () => {
    const pr = run({
      pullRequests: [{ number: 12, baseRef: 'release' }],
    });
    expect(deriveRefs(job('pull_request', 'refs/pull/12/merge'), pr)).toEqual({
      own: 'refs/pull/12/merge',
      base: 'refs/heads/release',
      default: 'refs/heads/main',
    });
    // A fork's reads its base and the default branch, and writes nothing.
    for (const headRepository of ['fork/app', null]) {
      expect(
        deriveRefs(
          job('pull_request', 'refs/pull/12/merge'),
          run({ ...pr, headRepository }),
        ),
      ).toEqual({ base: 'refs/heads/release', default: 'refs/heads/main' });
    }
    // A run that lists no pull request: no base, own still the merge ref.
    expect(
      deriveRefs(job('pull_request', 'refs/pull/12/merge'), run()),
    ).toEqual({
      own: 'refs/pull/12/merge',
      default: 'refs/heads/main',
    });
  });

  it("reads a merge queue's base from its ref", () => {
    const ref = 'refs/heads/gh-readonly-queue/main/pr-5-0123abcd';
    expect(
      deriveRefs(job('merge_group', ref), run({ headBranch: ref.slice(11) })),
    ).toEqual({
      own: ref,
      base: 'refs/heads/main',
      default: 'refs/heads/main',
    });
  });

  // Another repository's reusable workflow: its ref is the workflow's, not
  // the run's, and the run's head branch may be a tag's name.
  it('writes nothing for other events, other repositories, or a branch the run does not name', () => {
    const readOnly = { default: 'refs/heads/main' };
    expect(
      deriveRefs(
        job('pull_request_target', 'refs/heads/main'),
        run({ headBranch: 'main' }),
      ),
    ).toEqual(readOnly);
    expect(
      deriveRefs(
        {
          ...job('push', 'refs/heads/feature'),
          jobWorkflowRef: 'other/ci/.github/workflows/x.yml@refs/heads/feature',
        },
        run(),
      ),
    ).toEqual(readOnly);
    expect(deriveRefs(job('push', 'refs/heads/other'), run())).toEqual(
      readOnly,
    );
    expect(
      deriveRefs(
        job('push', 'refs/heads/feature'),
        run({ headRepository: 'fork/app' }),
      ),
    ).toEqual(readOnly);
  });

  it('never gives a reusable workflow a tag, or a pull request the run does not list', () => {
    const reusable = '.github/workflows/build.yml';
    expect(
      deriveRefs(
        job('push', 'refs/tags/v1', reusable),
        run({ headBranch: 'v1' }),
      ).own,
    ).toBeUndefined();
    expect(
      deriveRefs(job('push', 'refs/tags/v1'), run({ headBranch: 'v1' })).own,
    ).toBe('refs/tags/v1');
    expect(
      deriveRefs(job('pull_request', 'refs/pull/9/merge', reusable), run()).own,
    ).toBeUndefined();
  });
});

// A fake anycloud API: Secrets by name, and mints that answer or refuse.
function fakeApi() {
  const secrets = new Map<string, { file: CacheFile; updatedAt: number }>();
  const mints: unknown[] = [];
  let mint: () => unknown = () => ({
    cloud: 'AWS',
    region: 'us-east-2',
    tokens: [
      {
        grants: [0, 1],
        expiresAt: 900_000,
        credentials: {
          accessKeyId: 'a',
          secretAccessKey: 's',
          sessionToken: 't',
        },
      },
    ],
  });
  let now = 0;
  const api = {
    saveSecret: async ({
      params,
      body,
    }: {
      params: { name: string };
      body: { values: Record<string, string> };
    }) => {
      secrets.set(params.name, {
        file: JSON.parse(body.values.BACKMESH_CACHE!),
        updatedAt: now,
      });
    },
    deleteSecret: async ({ params }: { params: { name: string } }) => {
      if (!secrets.delete(params.name))
        throw new ORPCError('NOT_FOUND', { status: 404 });
    },
    listSecrets: async () =>
      [...secrets].map(([name, s]) => ({
        name,
        createdAt: s.updatedAt,
        updatedAt: s.updatedAt,
      })),
    mintStorageTokens: async (input: unknown) => {
      mints.push(input);
      return mint();
    },
  };
  return {
    api: api as unknown as ConstructorParameters<typeof CacheTokens>[0]['api'],
    secrets,
    mints,
    setMint: (fn: () => unknown) => (mint = fn),
    clock: { get: () => now, set: (t: number) => (now = t) },
  };
}

const route = ROUTE;
const started = (runner: string) =>
  jobMessageSchema.parse({
    messageType: 'JobStarted',
    runnerName: runner,
    ownerName: 'acme',
    repositoryName: 'app',
    eventName: 'push',
    jobWorkflowRef: 'acme/app/.github/workflows/ci.yml@refs/heads/feature',
    jobDisplayName: 'test (20)',
    workflowRunId: 99,
  });

function tokens(region: string | null = 'us-east-2') {
  const fake = fakeApi();
  const logs: Record<string, unknown>[] = [];
  const cache = new CacheTokens({
    api: fake.api,
    install: 'abc12',
    buckets: [],
    run: async () => run(),
    region: async () => region,
    log: (entry) => logs.push(entry),
    now: fake.clock.get,
  });
  const settle = () => new Promise((r) => setTimeout(r, 10));
  return { ...fake, cache, logs, settle };
}

describe('CacheTokens', () => {
  const name = 'bmabc12-a4-00000001';
  const secret = `_bm-cache-${name}`;

  it('saves pending before submit, ready with own read-write and default read-only at JobStarted', async () => {
    const t = tokens();
    expect(await t.cache.prepare(name)).toEqual([secret]);
    expect(t.secrets.get(secret)!.file).toEqual({ v: 1, state: 'pending' });
    t.cache.started(route, started(name));
    await t.settle();
    const own = refPrefix(7, 'refs/heads/feature');
    const def = refPrefix(7, 'refs/heads/main');
    expect(t.mints[0]).toMatchObject({
      params: { credentialName: 'bm-aws' },
      query: { region: 'us-east-2' },
      body: {
        lifetimeSeconds: 900,
        grants: [
          {
            bucket: 'bm-cache-abc12-us-east-2',
            prefix: own,
            mode: 'readwrite',
            noDelete: true,
          },
          { bucket: 'bm-cache-abc12-us-east-2', prefix: def, mode: 'read' },
        ],
      },
    });
    expect(t.secrets.get(secret)!.file).toMatchObject({
      state: 'ready',
      cloud: 'aws',
      region: 'us-east-2',
      prefixes: { own, default: def },
      tokens: [{ prefixes: [own, def] }],
      expiresAt: 900_000,
      job: { workflow: 'acme/app/.github/workflows/ci.yml', name: 'test (20)' },
    });
    // A redelivered JobStarted mints nothing more.
    t.cache.started(route, started(name));
    await t.settle();
    expect(t.mints).toHaveLength(1);
  });

  it('renews every 10 minutes until 10 minutes after JobCompleted, then deletes the Secret when the Job ends', async () => {
    const t = tokens();
    await t.cache.prepare(name);
    await t.cache.tick(new Set([name]));
    t.cache.started(route, started(name));
    await t.settle();
    t.clock.set(10 * 60_000);
    await t.cache.tick(new Set([name]));
    await t.settle();
    expect(t.mints).toHaveLength(2);
    t.cache.completed(name);
    t.clock.set(20 * 60_000);
    await t.cache.tick(new Set([name]));
    await t.settle();
    expect(t.mints).toHaveLength(2);
    expect(t.secrets.has(secret)).toBe(true);
    await t.cache.tick(new Set());
    expect(t.secrets.has(secret)).toBe(false);
  });

  it('turns the cache off on a refused mint, and retries a 5xx', async () => {
    const refused = tokens();
    refused.setMint(() => {
      throw new ORPCError('BUCKET_ACCESS_DENIED', { status: 403 });
    });
    await refused.cache.prepare(name);
    refused.cache.started(route, started(name));
    await refused.settle();
    expect(refused.secrets.get(secret)!.file).toEqual({
      v: 1,
      state: 'off',
      reason: 'BUCKET_ACCESS_DENIED',
    });

    const flaky = tokens();
    flaky.setMint(() => {
      throw new ORPCError('INTERNAL_SERVER_ERROR', { status: 502 });
    });
    await flaky.cache.prepare(name);
    flaky.cache.started(route, started(name));
    await flaky.settle();
    expect(flaky.secrets.get(secret)!.file.state).toBe('pending');
    flaky.setMint(() => ({
      cloud: 'AWS',
      region: 'us-east-2',
      tokens: [
        {
          grants: [0, 1],
          expiresAt: 5,
          credentials: {
            accessKeyId: 'a',
            secretAccessKey: 's',
            sessionToken: 't',
          },
        },
      ],
    }));
    flaky.clock.set(30_000);
    await flaky.cache.tick(new Set([name]));
    await flaky.settle();
    expect(flaky.secrets.get(secret)!.file).toMatchObject({
      state: 'ready',
      expiresAt: 5,
    });
    // JobStarted to the first `ready`, the retry's wait included; a
    // renewal isn't logged again.
    flaky.clock.set(10 * 60_000 + 30_000);
    await flaky.cache.tick(new Set([name]));
    await flaky.settle();
    expect(flaky.mints).toHaveLength(3);
    expect(
      flaky.logs.filter((entry) => entry.msg === 'cache token ready'),
    ).toEqual([{ msg: 'cache token ready', runner: name, ms: 30_000 }]);
  });

  it('keeps a Secret deleted when its Job ends during a mint', async () => {
    const t = tokens();
    let answer!: () => void;
    t.setMint(
      () =>
        new Promise((resolve) => {
          answer = () =>
            resolve({
              cloud: 'GCP',
              tokens: [
                {
                  grants: [0, 1],
                  expiresAt: 1,
                  credentials: { accessToken: 'g' },
                },
              ],
            });
        }),
    );
    await t.cache.prepare(name);
    await t.cache.tick(new Set([name]));
    t.cache.started(route, started(name));
    await t.settle();
    await t.cache.tick(new Set());
    answer();
    await t.settle();
    expect(t.secrets.has(secret)).toBe(false);
  });

  it("deletes a never-listed runner's Secret (a refused submit) after 10 minutes, and sweeps this install's orphans", async () => {
    const t = tokens();
    await t.cache.prepare(name);
    t.clock.set(11 * 60_000);
    await t.cache.tick(new Set());
    expect(t.secrets.has(secret)).toBe(false);
    t.secrets.set('_bm-cache-bmabc12-a4-orphan01', {
      file: { v: 1, state: 'pending' },
      updatedAt: 0,
    });
    t.secrets.set('_bm-cache-bmzzz99-a4-others01', {
      file: { v: 1, state: 'pending' },
      updatedAt: 0,
    });
    t.clock.set(25 * 3_600_000);
    await t.cache.tick(new Set());
    expect([...t.secrets.keys()]).toEqual(['_bm-cache-bmzzz99-a4-others01']);
  });
});

describe('the scaler with the cache', () => {
  it("names each runner's Secret in its Job, and tells the cache of its job's start and end", async () => {
    const seen: string[] = [];
    const cache = {
      prepare: async (name: string) => (
        seen.push(`prepare ${name}`),
        [`_bm-cache-${name}`]
      ),
      started: (_: Route, job: { runnerName: string }) =>
        void seen.push(`started ${job.runnerName}`),
      completed: (name: string) => void seen.push(`completed ${name}`),
      tick: async (ids: ReadonlySet<string>) =>
        void seen.push(`tick ${ids.size}`),
    };
    const { anycloud, github, scaler, sets } = setup(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      cache,
    );
    // The Secret is saved while GitHub mints the JIT config.
    const { generateJitConfig } = github.github;
    github.github.generateJitConfig = async (id, name) => {
      seen.push('jit');
      await new Promise((resolve) => setImmediate(resolve));
      seen.push('jit answered');
      return generateJitConfig(id, name);
    };
    const { submit } = anycloud.jobs;
    anycloud.jobs.submit = async (spec) => (seen.push('submit'), submit(spec));
    sets[0]!.statistics = assigned(1);
    await scaler.reconcile();
    const [spec] = anycloud.submitted;
    expect(spec!.secrets).toEqual([`_bm-cache-${spec!.id}`]);
    scaler.observe(sets[0]!, message('JobStarted', { runnerName: spec!.id }));
    scaler.observe(
      sets[0]!,
      message('JobCompleted', { runnerName: spec!.id, result: 'succeeded' }),
    );
    // The cache's housekeeping waits for the cycle's submits.
    expect(seen).toEqual([
      'jit',
      `prepare ${spec!.id}`,
      'jit answered',
      'submit',
      'tick 0',
      `started ${spec!.id}`,
      `completed ${spec!.id}`,
    ]);
  });
});
