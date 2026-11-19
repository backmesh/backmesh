// The Worker's side of every sign-in: the CLI signs in with the backmesh
// App's device flow on github.com and sends the Worker the App's user token
// once. The Worker's authority check is whether that token can list the
// org's runner groups (the App's Self-hosted runners permission), and every
// GitHub call it makes answers within a bounded time.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../worker/src/index.js';
import worker from '../../../worker/src/index.js';
import { mintKey } from '../../../worker/src/installs.js';
import { ORIGIN, testEnv, Upstream } from './fakes.js';

let env: Env;
let upstream: Upstream;

const RUNNERS = { organization_self_hosted_runners: 'write' };

beforeEach(() => {
  env = testEnv();
  upstream = new Upstream();
  vi.stubGlobal('fetch', upstream.fetch);
  upstream.installations.set(11, {
    id: 7,
    login: 'acme',
    permissions: RUNNERS,
  });
  upstream.memberships.set('alice', [{ id: 11, login: 'acme', role: 'admin' }]);
  upstream.memberships.set('bob', [{ id: 11, login: 'acme', role: 'member' }]);
  upstream.memberships.set('carol', [
    { id: 12, login: 'globex', role: 'admin' },
  ]);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const post = (path: string, body: unknown, key?: string) =>
  worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key && { Authorization: `Bearer ${key}` }),
      },
      body: JSON.stringify(body),
    }),
    env,
  );
const install = (github_token: string, org = 'acme', extra = {}) =>
  post('/v1/installs', { org, github_token, ...extra });

describe('POST /v1/installs', () => {
  it("returns a key for a token whose holder manages the org's runners", async () => {
    const res = await install('token-alice');

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      org_id: 11,
      org: 'acme',
      install: expect.stringMatching(/^[0-9a-f]{32}$/),
      key: expect.stringMatching(/^bmk_[0-9a-f]{64}$/),
    });
    // The authority check is the runner groups, with the user's own token.
    expect(upstream.calls).toContain(
      'GET api.github.com/orgs/acme/actions/runner-groups',
    );
    const status = await worker.fetch(
      new Request(`${ORIGIN}/v1/status`, {
        headers: { Authorization: `Bearer ${String(body.key)}` },
      }),
      env,
    );
    expect(await status.json()).toEqual({ org_id: 11 });
    // Neither the key nor the token is stored.
    const stored = JSON.stringify(
      (await env.DB.prepare('SELECT * FROM installs').all()).results,
    );
    expect(stored).not.toContain(String(body.key));
    expect(stored).not.toContain('token-alice');
  });

  it('replaces the key of the install it names', async () => {
    const first = (await (await install('token-alice')).json()) as {
      install: string;
    };
    const again = (await (
      await install('token-alice', 'acme', { install: first.install })
    ).json()) as { install: string };

    expect(first.install).toMatch(/^[0-9a-f]{32}$/);
    expect(again.install).toBe(first.install);
  });

  it.each([
    ['a plain member', 'token-bob'],
    ['an admin of another org', 'token-carol'],
  ])(
    "answers 403 to %s, who can't manage the org's runners",
    async (_, token) => {
      const res = await install(token);

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error:
          'Creating a backmesh install for acme needs the right to manage its self-hosted runners: sign in as an owner of acme.',
      });
      expect(
        (await env.DB.prepare('SELECT * FROM installs').all()).results,
      ).toEqual([]);
    },
  );

  it("answers 409 with the install link while the App isn't on the org", async () => {
    upstream.installations.delete(11);

    const res = await install('token-alice');

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'app_not_installed',
      install_url:
        'https://github.com/apps/backmesh/installations/new/permissions?target_id=11',
    });
  });

  it('answers 401 when GitHub refuses the token', async () => {
    upstream.revoked.add('alice');

    const res = await install('token-alice');

    expect(res.status).toBe(401);
  });

  it('refuses the device_code form an older CLI sends', async () => {
    const res = await post('/v1/installs', {
      org: 'acme',
      device_code: 'alice',
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: expect.stringContaining('Update backmesh'),
    });
    expect(upstream.calls).toEqual([]);
  });

  it.each(['/v1/installs/device', '/v1/sign-in'])(
    'no longer serves %s',
    async (path) => {
      expect((await post(path, { device_code: 'alice' })).status).toBe(404);
      expect(upstream.calls).toEqual([]);
    },
  );

  it.each([
    '/orgs/acme',
    '/orgs/acme/actions/runner-groups',
    '/orgs/acme/installation',
  ])(
    'answers 504 with a clear error within 30 s when GitHub never answers %s',
    async (path) => {
      upstream.installations.delete(11);
      upstream.silent.add(path);
      // Fake timeouts and clock; the App JWT's signing runs in real time.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
        const controller = new AbortController();
        setTimeout(
          () =>
            controller.abort(
              new DOMException('The operation timed out.', 'TimeoutError'),
            ),
          ms,
        );
        return controller.signal;
      });
      const start = Date.now();
      let answered: Response | undefined;
      void install('token-alice').then((r) => (answered = r));

      while (!answered && Date.now() - start < 120_000) {
        await new Promise((resolve) => setImmediate(resolve));
        await vi.advanceTimersToNextTimerAsync();
      }

      expect(answered?.status).toBe(504);
      expect(await answered!.json()).toEqual({
        error: expect.stringMatching(/^GitHub didn't answer .* in 10 s/),
      });
      expect(Date.now() - start).toBeLessThanOrEqual(30_000);
    },
  );
});

describe('the same check everywhere', () => {
  it("refuses uninstall's cleanup to a member, and its old device_code form", async () => {
    const member = await post('/v1/installs/cleanup', {
      org: 'acme',
      github_token: 'token-bob',
    });
    const old = await post('/v1/installs/cleanup', {
      org: 'acme',
      device_code: 'alice',
    });
    const owner = await post('/v1/installs/cleanup', {
      org: 'acme',
      github_token: 'token-alice',
    });

    expect(member.status).toBe(403);
    expect(old.status).toBe(400);
    expect(owner.status).toBe(200);
    expect(await owner.json()).toMatchObject({
      org: { id: 11 },
      token: 'ghs_7',
    });
  });

  it("refuses rotate-key's revoke to a member", async () => {
    await post('/v1/installs', { org: 'acme', github_token: 'token-alice' });
    const { install: old } = await mintKey(env.DB, 11);
    const { key } = await mintKey(env.DB, 11);

    const member = await post(
      '/v1/installs/revoke',
      { install: old, github_token: 'token-bob' },
      key,
    );
    const owner = await post(
      '/v1/installs/revoke',
      { install: old, github_token: 'token-alice' },
      key,
    );

    expect(member.status).toBe(403);
    expect(owner.status).toBe(200);
  });
});
