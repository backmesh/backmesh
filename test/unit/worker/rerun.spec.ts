// POST /v1/rerun (owner, 2026-11-19): the listener's spot-reclaim retry
// without Actions write on its own token. The install key asks; the Worker
// reruns a run's failed jobs only when they all ran on that install's
// runners, with a token that has Actions write for that one call.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../worker/src/index.js';
import worker from '../../../worker/src/index.js';
import { keyOf, ORIGIN, testEnv, Upstream } from './fakes.js';

let env: Env;
let upstream: Upstream;

const TAG = 'a1b2c';
const OURS = `bm${TAG}-a4-k3j9x0qz`;
const RUN = { owner: 'acme', repo: 'app', run_id: 42 };

beforeEach(async () => {
  env = testEnv();
  upstream = new Upstream();
  vi.stubGlobal('fetch', upstream.fetch);
  upstream.installations.set(11, {
    id: 7,
    login: 'acme',
    permissions: {
      organization_self_hosted_runners: 'write',
      actions: 'write',
      metadata: 'read',
    },
  });
  await env.DB.prepare(
    "INSERT INTO orgs (id, login) VALUES (11, 'acme')",
  ).run();
  upstream.repos.set('acme/app', { ownerId: 11 });
  upstream.runs.set('acme/app/42', {
    status: 'completed',
    attempt: 1,
    jobs: [
      { conclusion: 'success', runner_name: 'GitHub Actions 3' },
      { conclusion: 'failure', runner_name: OURS },
      { conclusion: 'cancelled', runner_name: `bm${TAG}-a4-zzzzzzzz` },
    ],
  });
});
afterEach(() => vi.unstubAllGlobals());

const rerun = async (
  body: object = { ...RUN, install: TAG },
  key: string | null | undefined = undefined,
) =>
  worker.fetch(
    new Request(`${ORIGIN}/v1/rerun`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key !== null && {
          Authorization: `Bearer ${key ?? (await keyOf(env, 11))}`,
        }),
      },
      body: JSON.stringify(body),
    }),
    env,
  );

describe('POST /v1/rerun', () => {
  it("reruns a completed run's failed jobs, all on this install's runners, with a one-call Actions write token", async () => {
    const res = await rerun();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rerun: true });
    expect(upstream.reruns).toEqual([
      {
        run: 'acme/app/42',
        permissions: { actions: 'write', metadata: 'read' },
      },
    ]);
    // The reads used a read-only token.
    expect(upstream.mints[0]).toEqual({ actions: 'read', metadata: 'read' });
    const rows = (
      await env.DB.prepare(
        "SELECT * FROM run_actions WHERE action = 'rerun'",
      ).all<{
        outcome: string;
        run: string;
      }>()
    ).results;
    expect(rows).toEqual([
      expect.objectContaining({ outcome: 'ok', run: 'acme/app/42' }),
    ]);
    expect(JSON.stringify(rows)).not.toContain('ghs_');
  });

  it('refuses a missing key and a malformed request', async () => {
    expect((await rerun(undefined, null)).status).toBe(401);
    expect((await rerun({ owner: 'acme', repo: 'app' })).status).toBe(400);
    expect((await rerun({ ...RUN, install: 'x' })).status).toBe(400);
    expect(upstream.reruns).toEqual([]);
  });

  it("refuses a repository outside the key's org", async () => {
    upstream.repos.set('globex/app', { ownerId: 12 });
    upstream.runs.set('globex/app/42', upstream.runs.get('acme/app/42')!);

    const other = await rerun({ ...RUN, owner: 'globex', install: TAG });
    const unknown = await rerun({ ...RUN, repo: 'gone', install: TAG });

    expect(other.status).toBe(403);
    expect(unknown.status).toBe(403);
    expect(upstream.reruns).toEqual([]);
  });

  it('refuses a run still going, one at its third attempt, and one with no failed job', async () => {
    const run = upstream.runs.get('acme/app/42')!;
    run.status = 'in_progress';
    expect((await rerun()).status).toBe(409);
    run.status = 'completed';
    run.attempt = 3;
    expect((await rerun()).status).toBe(409);
    run.attempt = 1;
    run.jobs = [{ conclusion: 'success', runner_name: OURS }];
    expect((await rerun()).status).toBe(409);
    expect(upstream.reruns).toEqual([]);
  });

  // The listener's rule: every job that failed or timed out ran on this
  // install's runners; a cancelled one, such as a matrix sibling fail-fast
  // cancelled, can be anywhere.
  it('reruns a fail-fast matrix whose cancelled siblings ran elsewhere', async () => {
    upstream.runs.get('acme/app/42')!.jobs = [
      { conclusion: 'failure', runner_name: OURS },
      { conclusion: 'cancelled', runner_name: 'GitHub Actions 2' },
      { conclusion: 'cancelled', runner_name: null },
    ];

    expect((await rerun()).status).toBe(200);
    expect(upstream.reruns).toHaveLength(1);
  });

  it('refuses a run whose only failures were cancellations', async () => {
    upstream.runs.get('acme/app/42')!.jobs = [
      { conclusion: 'cancelled', runner_name: OURS },
    ];

    expect((await rerun()).status).toBe(409);
  });

  it.each([
    ['a GitHub-hosted runner', 'failure', 'GitHub Actions 2'],
    ["another install's runner", 'failure', 'bmzzzzz-a4-k3j9x0qz'],
    ['no runner', 'failure', null],
    ['a GitHub-hosted runner, timed out', 'timed_out', 'GitHub Actions 2'],
  ])('refuses when a failed job ran on %s', async (_, conclusion, runner) => {
    upstream.runs.get('acme/app/42')!.jobs.push({
      conclusion,
      runner_name: runner,
    });

    const res = await rerun();

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: expect.stringContaining(
        "didn't all run on this install's runners",
      ),
      code: 'not_our_runners',
    });
    expect(upstream.reruns).toEqual([]);
  });

  it("binds the key to the install's runner tag on its first rerun", async () => {
    expect((await rerun()).status).toBe(200);

    const other = await rerun({ ...RUN, install: 'zzzzz' });

    expect(other.status).toBe(403);
    expect(upstream.reruns).toHaveLength(1);
  });

  it('binds one tag when two first calls race', async () => {
    // Each run's failed job ran on its own tag's runner, so only the
    // binding tells them apart.
    upstream.runs.set('acme/app/43', {
      status: 'completed',
      attempt: 1,
      jobs: [{ conclusion: 'failure', runner_name: 'bmzzzzz-a4-k3j9x0qz' }],
    });
    // One install key, minted before the race.
    const key = await keyOf(env, 11);
    const [a, b] = await Promise.all([
      rerun({ ...RUN, install: TAG }, key),
      rerun({ ...RUN, run_id: 43, install: 'zzzzz' }, key),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 403]);
    expect(upstream.reruns).toHaveLength(1);
  });

  it('answers 409 with where to accept Actions write while the installation grants it read only', async () => {
    upstream.installations.get(11)!.permissions.actions = 'read';

    const res = await rerun();

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error:
        "An owner of acme accepts the backmesh App's Actions write at https://github.com/organizations/acme/settings/installations/7, so backmesh.com can rerun and cancel runs.",
      code: 'actions_write_needed',
    });
    expect(upstream.reruns).toEqual([]);
    expect(upstream.mints).not.toContainEqual({
      actions: 'write',
      metadata: 'read',
    });
  });

  it('reruns once an owner accepts Actions write, though the installation was cached read only', async () => {
    upstream.installations.get(11)!.permissions.actions = 'read';
    expect((await rerun()).status).toBe(409);

    upstream.installations.get(11)!.permissions.actions = 'write';

    expect((await rerun()).status).toBe(200);
    expect(upstream.reruns).toHaveLength(1);
  });

  it('caps every call, refused ones too, at 200 an hour per install', async () => {
    upstream.runs.get('acme/app/42')!.jobs = [
      { conclusion: 'failure', runner_name: 'GitHub Actions 2' },
    ];
    for (let i = 0; i < 200; i++) expect((await rerun()).status).toBe(403);

    expect((await rerun()).status).toBe(429);
  });

  it.each([
    [
      'a 403 with retry-after',
      () =>
        Response.json(
          { message: 'You have exceeded a secondary rate limit.' },
          { status: 403, headers: { 'retry-after': '60' } },
        ),
      502,
    ],
    [
      "a 403 that says it's a rate limit",
      () =>
        Response.json(
          { message: 'You have exceeded a secondary rate limit.' },
          { status: 403 },
        ),
      502,
    ],
    [
      "GitHub's rate limit",
      () =>
        Response.json(
          { message: 'API rate limit exceeded' },
          { status: 403, headers: { 'x-ratelimit-remaining': '0' } },
        ),
      502,
    ],
    ['a 429', () => new Response('', { status: 429 }), 502],
    ['a 500', () => new Response('', { status: 500 }), 502],
  ])(
    'answers 502 for %s on the rerun, and records it, never left pending',
    async (_, answer, status) => {
      upstream.answers.set(
        '/repos/acme/app/actions/runs/42/rerun-failed-jobs',
        answer,
      );

      expect((await rerun()).status).toBe(status);
      const outcomes = (
        await env.DB.prepare('SELECT outcome FROM run_actions').all<{
          outcome: string;
        }>()
      ).results.map((r) => r.outcome);
      expect(outcomes).toEqual(['github_failed']);
    },
  );

  it("answers GitHub's own 4xx for the rerun, which the listener then drops", async () => {
    upstream.answers.set(
      '/repos/acme/app/actions/runs/42/rerun-failed-jobs',
      () =>
        Response.json(
          { message: 'This workflow run cannot be rerun' },
          { status: 403 },
        ),
    );

    const res = await rerun();

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining('cannot be rerun'),
      code: 'github_refused',
    });
  });

  it("reports GitHub's rate limit as GitHub's, not as another org's repository", async () => {
    upstream.answers.set('/repos/acme/app', () =>
      Response.json(
        { message: 'API rate limit exceeded' },
        { status: 403, headers: { 'x-ratelimit-remaining': '0' } },
      ),
    );

    const res = await rerun();

    expect(res.status).toBe(502);
  });

  it('allows 20 reruns an hour per install', async () => {
    for (let i = 0; i < 20; i++) expect((await rerun()).status).toBe(200);

    expect((await rerun()).status).toBe(429);
    expect(upstream.reruns).toHaveLength(20);
  });

  it('answers 409 with the install link while the App is off the org', async () => {
    upstream.installations.delete(11);

    const res = await rerun();

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'app_not_installed' });
  });
});
