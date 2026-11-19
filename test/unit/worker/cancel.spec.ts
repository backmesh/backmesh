// POST /v1/cancel (owner, 2026-11-19): the public-repository gate's fork
// protection without Actions write on the listener's token. The Worker
// force-cancels a run only when it's a fork's pull request in one of the
// key's org's public repositories, and either asks for a backmesh label
// that isn't public or has run past the 60-minute limit on this install's
// runner, with a token that has Actions write for that one call.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../worker/src/index.js';
import worker from '../../../worker/src/index.js';
import { keyOf, ORIGIN, testEnv, Upstream } from './fakes.js';

let env: Env;
let upstream: Upstream;

const TAG = 'a1b2c';
const OURS = `bm${TAG}-c4-k3j9x0qz`;
const RUN = { owner: 'acme', repo: 'app', run_id: 42 };
const NOW = Date.UTC(2026, 10, 19, 12);
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
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
  upstream.repos.set('acme/app', { ownerId: 11, private: false });
  upstream.runs.set('acme/app/42', {
    status: 'in_progress',
    attempt: 1,
    head: 'mallory/app',
    jobs: [
      {
        conclusion: null,
        status: 'queued',
        runner_name: null,
        labels: ['backmesh-kvm-4'],
        started_at: null,
      },
    ],
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const cancel = async (body: object = {}) =>
  worker.fetch(
    new Request(`${ORIGIN}/v1/cancel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${await keyOf(env, 11)}`,
      },
      body: JSON.stringify({ ...RUN, install: TAG, reason: 'label', ...body }),
    }),
    env,
  );

describe('POST /v1/cancel', () => {
  it("force-cancels a fork's run that asks for a label that isn't public, with a one-call Actions write token", async () => {
    const res = await cancel();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cancelled: true });
    expect(upstream.cancels).toEqual([
      {
        run: 'acme/app/42',
        permissions: { actions: 'write', metadata: 'read' },
      },
    ]);
    expect(upstream.mints[0]).toEqual({ actions: 'read', metadata: 'read' });
    const rows = (
      await env.DB.prepare(
        "SELECT * FROM run_actions WHERE action = 'cancel'",
      ).all<{ outcome: string }>()
    ).results;
    expect(rows).toEqual([expect.objectContaining({ outcome: 'ok' })]);
  });

  it("cancels at the runtime limit only for a job on this install's runner past 60 minutes", async () => {
    const run = upstream.runs.get('acme/app/42')!;
    run.jobs = [
      {
        conclusion: null,
        status: 'in_progress',
        runner_name: OURS,
        labels: ['backmesh-public-4'],
        started_at: ago(59),
      },
    ];
    expect((await cancel({ reason: 'limit' })).status).toBe(403);
    run.jobs[0]!.started_at = ago(60);
    expect((await cancel({ reason: 'limit' })).status).toBe(200);
    // On the public label alone, the label reason doesn't hold.
    upstream.cancels = [];
    expect((await cancel({ reason: 'label' })).status).toBe(403);
    expect(upstream.cancels).toEqual([]);
  });

  it.each([
    [
      'a private repository',
      () => upstream.repos.set('acme/app', { ownerId: 11, private: true }),
    ],
    [
      "another org's repository",
      () => upstream.repos.set('acme/app', { ownerId: 12, private: false }),
    ],
    [
      "a run from the repository's own branch",
      () => (upstream.runs.get('acme/app/42')!.head = 'acme/app'),
    ],
  ])('refuses %s', async (_, arrange) => {
    arrange();

    expect((await cancel()).status).toBe(403);
    expect(upstream.cancels).toEqual([]);
  });

  it('refuses a finished run, a malformed request and another tag', async () => {
    upstream.runs.get('acme/app/42')!.status = 'completed';
    expect((await cancel()).status).toBe(409);
    expect((await cancel({ reason: 'whim' })).status).toBe(400);
    upstream.runs.get('acme/app/42')!.status = 'queued';
    expect((await cancel()).status).toBe(200);
    expect((await cancel({ install: 'zzzzz' })).status).toBe(403);
  });

  it('allows 20 cancels an hour per install', async () => {
    for (let i = 0; i < 20; i++) expect((await cancel()).status).toBe(200);

    expect((await cancel()).status).toBe(429);
  });
});
