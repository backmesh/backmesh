import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../worker/src/index.js';
import worker from '../../../worker/src/index.js';
import { mintKey } from '../../../worker/src/installs.js';
import { eventSchema, intake, retain } from '../../../worker/src/telemetry.js';
import { authed, limiter, ORIGIN, testEnv, Upstream } from './fakes.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 6, 12);

let env: Env;
let upstream: Upstream;
// Each org's first install, minted as `backmesh install` would.
let installs: Map<number, { id: string; org: number }>;

beforeEach(() => {
  env = testEnv();
  upstream = new Upstream();
  installs = new Map();
  vi.stubGlobal('fetch', upstream.fetch);
});
afterEach(() => vi.unstubAllGlobals());

async function installOf(org: number) {
  if (!installs.has(org)) {
    installs.set(org, { id: (await mintKey(env.DB, org)).install, org });
  }
  return installs.get(org)!;
}

const event = (org: number, job: number, startedAt = NOW) => ({
  id: createHash('sha256').update(`${org}:${job}`).digest('hex'),
  version: '0.1.7',
  started_at: new Date(startedAt).toISOString(),
  cloud: 'aws',
  region: 'us-east-2',
  vm_type: 'm7a.4xlarge',
  capacity: 'spot',
  label: 'backmesh-4',
  queued_ms: 2_100,
  boot_ms: 41_000,
  features: [],
});

const send = async (
  org: number,
  events: unknown[],
  now = NOW,
  install?: { id: string; org: number },
) =>
  intake(
    new Request(`${ORIGIN}/v1/events`, {
      method: 'POST',
      body: JSON.stringify({ events }),
    }),
    env,
    install ?? (await installOf(org)),
    now,
  );

// The org's stored events, by when they count as started.
const stored = async (org: number) =>
  (
    await env.DB.prepare(
      'SELECT started_at FROM events WHERE org = ? ORDER BY started_at',
    )
      .bind(org)
      .all<{ started_at: number }>()
  ).results.map((r) => r.started_at);

describe('events', () => {
  it('stores a resent event and a resent batch once', async () => {
    const batch = [event(11, 1), event(11, 2)];
    await send(11, batch);
    await send(11, batch);
    await send(11, [event(11, 2)]);

    expect(await stored(11)).toHaveLength(2);
  });

  it("keeps one org's events from claiming another org's job", async () => {
    await send(12, [event(11, 1)]);
    await send(11, [event(11, 1)]);

    expect(await stored(11)).toHaveLength(1);
  });

  it('clamps a future or older-than-35-days started_at to when it arrived', async () => {
    await send(11, [
      event(11, 1, NOW + DAY),
      event(11, 2, NOW - 40 * DAY),
      event(11, 3, NOW - 34 * DAY),
    ]);

    expect(await stored(11)).toEqual([NOW - 34 * DAY, NOW, NOW]);
  });

  it('refuses an unknown feature name', async () => {
    const res = await send(11, [{ ...event(11, 1), features: ['tune'] }]);

    expect(res.status).toBe(400);
  });

  it('refuses a malformed event, or one naming a repository', async () => {
    expect((await send(11, [{ ...event(11, 1), id: 'job-1' }])).status).toBe(
      400,
    );
    expect(
      (await send(11, [{ ...event(11, 1), repository: 'acme/api' }])).status,
    ).toBe(400);
  });

  it('folds events older than 90 days into daily counts, adding to a day', async () => {
    await send(11, [event(11, 1), event(11, 2)]);
    await retain(env.DB, NOW + 91 * DAY);
    await send(11, [event(11, 3, NOW)], NOW);
    await retain(env.DB, NOW + 91 * DAY);

    const rows = await env.DB.prepare(
      'SELECT org, day, jobs FROM daily_counts',
    ).all();
    expect(rows.results).toEqual([{ org: 11, day: '2026-11-06', jobs: 3 }]);
    expect(await env.DB.prepare('SELECT * FROM events').all()).toEqual({
      results: [],
    });
  });

  it("accepts the telemetry statement's example payload and lists every field", async () => {
    const page = readFileSync(
      new URL(
        '../../../website/src/content/docs/telemetry.md',
        import.meta.url,
      ),
      'utf8',
    );
    const example = JSON.parse(page.match(/```json\n([\s\S]*?)```/)![1]!);
    const listed = [...page.matchAll(/^\| `(\w+)`/gm)].map((m) => m[1]);

    const res = await intake(
      new Request(`${ORIGIN}/v1/events`, {
        method: 'POST',
        body: JSON.stringify(example),
      }),
      env,
      await installOf(11),
      Date.parse(example.events[0].started_at),
    );

    expect(await res.json()).toEqual({ accepted: 1 });
    expect(listed.sort()).toEqual(Object.keys(eventSchema.shape).sort());
    expect(Object.keys(example.events[0]).sort()).toEqual(listed);
  });
});

describe('install keys', () => {
  it('refuses events and status without a valid key', async () => {
    for (const authorization of [undefined, 'Bearer bmk_' + '0'.repeat(64)]) {
      const headers: Record<string, string> = authorization
        ? { Authorization: authorization }
        : {};
      const res = await worker.fetch(
        new Request(`${ORIGIN}/v1/status`, { headers }),
        env,
      );
      expect(res.status).toBe(401);
    }
    expect((await authed(env, 11, '/v1/status')).status).toBe(200);
  });

  it('takes events through the key, which names the org', async () => {
    const res = await authed(env, 11, '/v1/events', {
      method: 'POST',
      body: JSON.stringify({ events: [event(11, 1, Date.now())] }),
    });

    expect(await res.json()).toEqual({ accepted: 1 });
    expect(await stored(11)).toHaveLength(1);
  });

  it('answers 429 over the rate limits', async () => {
    env.SIGNIN_LIMIT = limiter(1);
    env.INSTALL_LIMIT = limiter(1);
    upstream.memberships.set('alice', [
      { id: 11, login: 'acme', role: 'admin' },
    ]);
    upstream.installations.set(11, { id: 7, login: 'acme', permissions: {} });
    const signIn = () =>
      worker.fetch(
        new Request(`${ORIGIN}/v1/installs`, {
          method: 'POST',
          body: JSON.stringify({ org: 'acme', github_token: 'token-alice' }),
        }),
        env,
      );

    expect((await signIn()).status).toBe(200);
    expect((await signIn()).status).toBe(429);
    expect((await authed(env, 11, '/v1/status')).status).toBe(200);
    expect((await authed(env, 11, '/v1/status')).status).toBe(429);
    // Refused keys count against the client IP.
    const bogus = () =>
      worker.fetch(
        new Request(`${ORIGIN}/v1/status`, {
          headers: { Authorization: `Bearer bmk_${'0'.repeat(64)}` },
        }),
        env,
      );
    expect((await bogus()).status).toBe(429);
  });

  it('keeps a disowned install disowned when its org signs in for it', async () => {
    upstream.memberships.set('alice', [
      { id: 11, login: 'acme', role: 'admin' },
    ]);
    const first = await mintKey(env.DB, 11);
    await env.DB.prepare('UPDATE installs SET disowned = 1').run();

    const again = await mintKey(env.DB, 11, first.install);

    expect(again.install).not.toBe(first.install);
  });
});
