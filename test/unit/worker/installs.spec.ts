// `POST /v1/installs/revoke` (`backmesh rotate-key`'s last step): one other
// install of the bearer key's own org, by ID, with that org's admin GitHub
// token checked fresh against GitHub — an install key alone isn't enough, since
// a leaked key could otherwise revoke the fresh one rotation just minted.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../worker/src/index.js';
import worker from '../../../worker/src/index.js';
import { mintKey, rememberLogin } from '../../../worker/src/installs.js';
import { ORIGIN, testEnv, Upstream } from './fakes.js';

let env: Env;
let upstream: Upstream;

beforeEach(() => {
  env = testEnv();
  upstream = new Upstream();
  vi.stubGlobal('fetch', upstream.fetch);
  // The App is on acme: a user token's runner-groups read says who manages
  // its runners.
  upstream.installations.set(7, { id: 70, login: 'acme', permissions: {} });
});
afterEach(() => vi.unstubAllGlobals());

// Remembers an org's login the way `createInstall` does, so
// `revokeInstall` can look it up from the bearer key's numeric org ID.
const remember = (id: number, login: string) => rememberLogin(env, id, login);

const call = (key: string, body: unknown) =>
  worker.fetch(
    new Request(`${ORIGIN}/v1/installs/revoke`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
    env,
  );

const statusCall = (key: string) =>
  worker.fetch(
    new Request(`${ORIGIN}/v1/status`, {
      headers: { Authorization: `Bearer ${key}` },
    }),
    env,
  );

// A cue credential bound to the org, as `/v1/cue/sign-in` keeps one.
const cueCredential = (org: number, login: string) =>
  env.DB.prepare(
    'INSERT INTO cue_credentials (hash, user_id, login, orgs, expires_at) VALUES (?, 1, ?, ?, ?)',
  )
    .bind(
      `hash-${org}`,
      'alice',
      JSON.stringify([{ id: org, login }]),
      Date.now() + 86_400_000,
    )
    .run();
const cueCredentials = async () =>
  (await env.DB.prepare('SELECT hash FROM cue_credentials').all()).results;

describe('POST /v1/installs/revoke', () => {
  it("revokes the org's cue credentials with the old install", async () => {
    await remember(7, 'acme');
    upstream.memberships.set('alice', [
      { id: 7, login: 'acme', role: 'admin' },
    ]);
    await cueCredential(7, 'acme');
    await cueCredential(8, 'globex');
    const { install: oldInstall } = await mintKey(env.DB, 7);
    const { key: newKey } = await mintKey(env.DB, 7);

    const res = await call(newKey, {
      install: oldInstall,
      github_token: 'token-alice',
    });

    expect(res.status).toBe(200);
    expect(await cueCredentials()).toEqual([{ hash: 'hash-8' }]);
  });

  it("revokes another install of the bearer's own org when its admin token checks out, which then gets 401", async () => {
    await remember(7, 'acme');
    upstream.memberships.set('alice', [
      { id: 7, login: 'acme', role: 'admin' },
    ]);
    const { key: oldKey, install: oldInstall } = await mintKey(env.DB, 7);
    const { key: newKey } = await mintKey(env.DB, 7);

    const res = await call(newKey, {
      install: oldInstall,
      github_token: 'token-alice',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: true });
    expect((await statusCall(oldKey)).status).toBe(401);
    // The new key, having revoked the old one, still works.
    expect((await statusCall(newKey)).status).toBe(200);
  });

  it('answers already: true for an install already revoked, without erroring', async () => {
    await remember(7, 'acme');
    upstream.memberships.set('alice', [
      { id: 7, login: 'acme', role: 'admin' },
    ]);
    const { install: oldInstall } = await mintKey(env.DB, 7);
    const { key: newKey } = await mintKey(env.DB, 7);
    const first = await call(newKey, {
      install: oldInstall,
      github_token: 'token-alice',
    });
    expect(await first.json()).toEqual({ revoked: true });

    const second = await call(newKey, {
      install: oldInstall,
      github_token: 'token-alice',
    });

    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ revoked: true, already: true });
  });

  it("refuses when the github_token isn't an admin of the key's org", async () => {
    await remember(7, 'acme');
    // A member, not an admin.
    upstream.memberships.set('alice', [
      { id: 7, login: 'acme', role: 'member' },
    ]);
    const { install: oldInstall } = await mintKey(env.DB, 7);
    const { key: newKey } = await mintKey(env.DB, 7);

    const res = await call(newKey, {
      install: oldInstall,
      github_token: 'token-alice',
    });

    expect(res.status).toBe(403);
  });

  it("refuses when the github_token has no membership in the key's org at all", async () => {
    await remember(7, 'acme');
    upstream.memberships.set('alice', []);
    const { install: oldInstall } = await mintKey(env.DB, 7);
    const { key: newKey } = await mintKey(env.DB, 7);

    const res = await call(newKey, {
      install: oldInstall,
      github_token: 'token-alice',
    });

    expect(res.status).toBe(403);
  });

  it('refuses a missing github_token', async () => {
    await remember(7, 'acme');
    const { install: oldInstall } = await mintKey(env.DB, 7);
    const { key: newKey } = await mintKey(env.DB, 7);

    expect((await call(newKey, { install: oldInstall })).status).toBe(400);
  });

  it("refuses to revoke the bearer's own install, even with a valid admin token", async () => {
    await remember(7, 'acme');
    upstream.memberships.set('alice', [
      { id: 7, login: 'acme', role: 'admin' },
    ]);
    const { key, install } = await mintKey(env.DB, 7);

    const res = await call(key, {
      install,
      github_token: 'token-alice',
    });

    expect(res.status).toBe(403);
    expect((await statusCall(key)).status).toBe(200);
  });

  it("refuses another org's install", async () => {
    await remember(7, 'acme');
    upstream.memberships.set('alice', [
      { id: 7, login: 'acme', role: 'admin' },
    ]);
    const { key: mine } = await mintKey(env.DB, 7);
    const { key: theirs, install: theirInstall } = await mintKey(env.DB, 8);

    const res = await call(mine, {
      install: theirInstall,
      github_token: 'token-alice',
    });

    expect(res.status).toBe(403);
    expect((await statusCall(theirs)).status).toBe(200);
  });

  it('refuses an unknown install ID', async () => {
    await remember(7, 'acme');
    upstream.memberships.set('alice', [
      { id: 7, login: 'acme', role: 'admin' },
    ]);
    const { key } = await mintKey(env.DB, 7);

    expect(
      (
        await call(key, {
          install: 'f'.repeat(32),
          github_token: 'token-alice',
        })
      ).status,
    ).toBe(403);
  });

  it('refuses a malformed install ID', async () => {
    const { key } = await mintKey(env.DB, 7);

    expect(
      (await call(key, { install: 'not-an-id', github_token: 'token-alice' }))
        .status,
    ).toBe(400);
  });

  it('refuses a revoked bearer key, like /v1/status', async () => {
    const { key, install } = await mintKey(env.DB, 7);
    await env.DB.prepare('UPDATE installs SET revoked = 1 WHERE id = ?')
      .bind(install)
      .run();

    expect(
      (await call(key, { install, github_token: 'token-alice' }))?.status,
    ).toBe(401);
  });

  it('refuses a missing or unknown bearer key', async () => {
    expect(
      (
        await call(`bmk_${'a'.repeat(64)}`, {
          install: 'a'.repeat(32),
          github_token: 'token-alice',
        })
      ).status,
    ).toBe(401);
  });

  it('refuses GET', async () => {
    const { key } = await mintKey(env.DB, 7);

    const res = await worker.fetch(
      new Request(`${ORIGIN}/v1/installs/revoke`, {
        headers: { Authorization: `Bearer ${key}` },
      }),
      env,
    );

    expect(res.status).toBe(405);
  });

  it("refuses when the stored login's admin belongs to a different org ID (a renamed-login collision)", async () => {
    // acme's stored login is now GitHub's org 99, not 7: alice admins org 99
    // under that login, not the bearer key's org.
    await remember(7, 'acme');
    upstream.memberships.set('alice', [
      { id: 99, login: 'acme', role: 'admin' },
    ]);
    const { install: oldInstall } = await mintKey(env.DB, 7);
    const { key: newKey } = await mintKey(env.DB, 7);

    const res = await call(newKey, {
      install: oldInstall,
      github_token: 'token-alice',
    });

    expect(res.status).toBe(403);
  });

  it("answers 502 when GitHub's runner-groups check fails, revoking nothing", async () => {
    await remember(7, 'acme');
    upstream.memberships.set('alice', [
      { id: 7, login: 'acme', role: 'admin' },
    ]);
    upstream.failing.set('/orgs/acme/actions/runner-groups', 500);
    const { key: oldKey, install: oldInstall } = await mintKey(env.DB, 7);
    const { key: newKey } = await mintKey(env.DB, 7);

    const res = await call(newKey, {
      install: oldInstall,
      github_token: 'token-alice',
    });

    expect(res.status).toBe(502);
    expect((await statusCall(oldKey)).status).toBe(200);
  });
});
