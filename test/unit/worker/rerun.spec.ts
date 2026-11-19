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
      await env.DB.prepare('SELECT * FROM reruns').all<{
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

  it.each([
    ['a GitHub-hosted runner', 'GitHub Actions 2'],
    ["another install's runner", 'bmzzzzz-a4-k3j9x0qz'],
    ['no runner', null],
  ])('refuses when a failed job ran on %s', async (_, runner) => {
    upstream.runs.get('acme/app/42')!.jobs.push({
      conclusion: 'failure',
      runner_name: runner,
    });

    const res = await rerun();

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: expect.stringContaining(
        "didn't all run on this install's runners",
      ),
    });
    expect(upstream.reruns).toEqual([]);
  });

  it("binds the key to the install's runner tag on its first rerun", async () => {
    expect((await rerun()).status).toBe(200);

    const other = await rerun({ ...RUN, install: 'zzzzz' });

    expect(other.status).toBe(403);
    expect(upstream.reruns).toHaveLength(1);
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
