import { generateKeyPairSync } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appJwt } from '../../../worker/src/app.js';
import type { Env } from '../../../worker/src/index.js';
import worker from '../../../worker/src/index.js';
import { mintKey } from '../../../worker/src/installs.js';
import {
  appKey,
  appPublicKey,
  keyOf,
  limiter,
  ORIGIN,
  testEnv,
  Upstream,
} from './fakes.js';

// What the App holds (owner, 2026-11-19): Actions write is the Worker's
// own, for /v1/rerun.
const ALL = {
  organization_self_hosted_runners: 'write',
  actions: 'write',
  metadata: 'read',
};
// What an install key's token gets: no more than a runner manager's role.
const KEY_TOKEN = {
  organization_self_hosted_runners: 'write',
  actions: 'read',
  metadata: 'read',
};

let env: Env;
let upstream: Upstream;

beforeEach(() => {
  env = testEnv();
  upstream = new Upstream();
  vi.stubGlobal('fetch', upstream.fetch);
});
afterEach(() => vi.unstubAllGlobals());

const call = (path: string, key: string | null, body?: object) =>
  worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: {
        ...(key && { Authorization: `Bearer ${key}` }),
        'CF-Connecting-IP': '203.0.113.7',
        'CF-Ray': 'ray-1',
      },
      body: body && JSON.stringify(body),
    }),
    env,
  );
const mint = async (org: number) => call('/v1/token', await keyOf(env, org));
// The App installed on an org whose login its device sign-in stored.
async function installed(
  org: number,
  installation: {
    id: number;
    login: string;
    permissions: Record<string, string>;
  },
) {
  upstream.installations.set(org, installation);
  await env.DB.prepare(
    'INSERT INTO orgs (id, login) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET login = excluded.login',
  )
    .bind(org, installation.login)
    .run();
}
const auditRows = async () =>
  (await env.DB.prepare('SELECT * FROM audit ORDER BY at').all()).results;

describe('App JWT', () => {
  it('signs RS256 with WebCrypto, and with the next key once set', async () => {
    await installed(11, { id: 7, login: 'acme', permissions: ALL });
    expect((await mint(11)).status).toBe(200);
    const [, claims] = (await appJwt(env, Date.UTC(2026, 10, 6))).split('.');
    expect(JSON.parse(Buffer.from(claims!, 'base64url').toString())).toEqual({
      iat: Date.UTC(2026, 10, 6) / 1000 - 60,
      exp: Date.UTC(2026, 10, 6) / 1000 + 540,
      iss: '1',
    });

    // GitHub has the next key and still the old one; the Worker signs with
    // the next.
    const next = generateKeyPairSync('rsa', { modulusLength: 2048 });
    env.GITHUB_APP_PRIVATE_KEY_NEXT = appKey(next.privateKey);
    upstream.appPublicKey = next.publicKey;
    expect((await mint(11)).status).toBe(200);
    upstream.appPublicKey = appPublicKey;
    expect((await mint(11)).status).toBe(502);
  });
});

describe('POST /v1/token', () => {
  it('answers 503 on the broker routes until the App is configured', async () => {
    const key = await keyOf(env, 11);
    delete env.GITHUB_APP_ID;
    delete env.GITHUB_APP_PRIVATE_KEY;

    for (const path of [
      '/v1/token',
      '/v1/installs/cleanup',
      '/v1/installs/cleanup/token',
      '/v1/installs/cleanup/finish',
    ]) {
      const res = await call(path, key, { device_code: 'dc', org: 'acme' });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        error: 'backmesh App not configured yet.',
      });
    }
    expect(upstream.calls).toEqual([]);
  });

  it('refuses a missing, unknown or revoked key', async () => {
    const key = await keyOf(env, 11);
    await env.DB.prepare('UPDATE installs SET revoked = 1').run();

    for (const bearer of [null, `bmk_${'0'.repeat(64)}`, key]) {
      expect((await call('/v1/token', bearer)).status).toBe(401);
    }
    expect(upstream.calls).toEqual([]);
  });

  it('finds the App through the login the sign-in stored', async () => {
    upstream.memberships.set('alice', [
      { id: 11, login: 'acme', role: 'admin' },
    ]);
    upstream.installations.set(11, { id: 7, login: 'acme', permissions: ALL });
    const signedIn = await call('/v1/installs', null, {
      org: 'acme',
      github_token: 'token-alice',
    });
    const { key } = (await signedIn.json()) as { key: string };

    const res = await call('/v1/token', key);

    expect(await res.json()).toMatchObject({ token: 'ghs_7' });
  });

  it('answers 409 with the install link until the App is installed', async () => {
    const res = await mint(11);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'app_not_installed',
      install_url:
        'https://github.com/apps/backmesh/installations/new/permissions?target_id=11',
    });
  });

  it("mints for the key's own org only, matched on account.id", async () => {
    // Org 12 now holds the login org 11 signed in with.
    await installed(11, { id: 7, login: 'acme', permissions: ALL });
    upstream.installations.delete(11);
    upstream.installations.set(12, { id: 8, login: 'acme', permissions: ALL });
    expect((await mint(11)).status).toBe(409);
    expect(upstream.mints).toEqual([]);

    await installed(11, { id: 7, login: 'acme-old', permissions: ALL });
    const res = await mint(11);

    expect(await res.json()).toEqual({
      token: 'ghs_7',
      expires_at: '2026-11-06T13:00:00Z',
      permissions: KEY_TOKEN,
      installation_permissions: ALL,
      org: { id: 11, login: 'acme-old' },
    });
  });

  it("mints a key's token with Self-hosted runners write, Actions read and Metadata only", async () => {
    await installed(11, { id: 7, login: 'acme', permissions: ALL });

    const res = await mint(11);

    expect(upstream.mints).toEqual([KEY_TOKEN]);
    // And what the installation grants the App, so the listener can say
    // when an owner hasn't accepted Actions write for backmesh.com.
    expect(await res.json()).toMatchObject({
      permissions: KEY_TOKEN,
      installation_permissions: ALL,
    });
  });

  it("reads the installation again when its cached grant isn't Actions write, so an owner's acceptance shows", async () => {
    await installed(11, {
      id: 7,
      login: 'acme',
      permissions: { ...ALL, actions: 'read' },
    });
    expect(await (await mint(11)).json()).toMatchObject({
      installation_permissions: { actions: 'read' },
    });
    upstream.installations.get(11)!.permissions.actions = 'write';

    expect(await (await mint(11)).json()).toMatchObject({
      installation_permissions: { actions: 'write' },
    });
  });

  it('asks only for those, narrowed to what the installation grants', async () => {
    await installed(11, {
      id: 7,
      login: 'acme',
      permissions: {
        organization_self_hosted_runners: 'write',
        actions: 'read',
        metadata: 'read',
        contents: 'write',
      },
    });

    const res = await mint(11);

    const narrowed = {
      organization_self_hosted_runners: 'write',
      actions: 'read',
      metadata: 'read',
    };
    expect(upstream.mints).toEqual([narrowed]);
    expect(await res.json()).toMatchObject({ permissions: narrowed });
  });

  it('caches the installation, and looks it up again after a 404 from the mint', async () => {
    await installed(11, { id: 7, login: 'acme', permissions: ALL });
    await mint(11);
    await mint(11);
    const lookups = () =>
      upstream.calls.filter((c) => c.endsWith('/orgs/acme/installation'));
    expect(lookups()).toHaveLength(1);

    // Uninstalled and installed again: a new installation ID.
    upstream.installations.set(11, { id: 9, login: 'acme', permissions: ALL });
    const res = await mint(11);

    expect(await res.json()).toMatchObject({ token: 'ghs_9' });
    expect(lookups()).toHaveLength(2);
  });

  it('reads the cached installation again by ID after an hour, following a rename and new permissions', async () => {
    await installed(11, {
      id: 7,
      login: 'acme',
      permissions: { ...ALL, actions: 'read' },
    });
    await mint(11);
    await env.DB.prepare('UPDATE installations SET checked_at = 0').run();
    upstream.installations.set(11, {
      id: 7,
      login: 'acme-renamed',
      permissions: ALL,
    });

    const res = await mint(11);

    expect(await res.json()).toMatchObject({
      permissions: KEY_TOKEN,
      org: { id: 11, login: 'acme-renamed' },
    });
    expect(upstream.calls).toContain('GET api.github.com/app/installations/7');
  });

  it('writes an audit row per mint, without the token', async () => {
    await installed(11, { id: 7, login: 'acme', permissions: ALL });
    await mint(11);

    const rows = await auditRows();
    expect(rows).toEqual([
      expect.objectContaining({
        action: 'token',
        outcome: 'ok',
        org: 11,
        installation: 7,
        permissions: JSON.stringify(KEY_TOKEN),
        expires_at: '2026-11-06T13:00:00Z',
        ip: '203.0.113.7',
        ray: 'ray-1',
      }),
    ]);
    expect(JSON.stringify(rows)).not.toContain('ghs_');
  });

  it('answers 429 over 10 a minute per install', async () => {
    await installed(11, { id: 7, login: 'acme', permissions: ALL });
    env.TOKEN_LIMIT = limiter(1);

    expect((await mint(11)).status).toBe(200);
    expect((await mint(11)).status).toBe(429);
    expect((await mint(12)).status).toBe(409);
  });

  it('trims audit rows after 90 days on the daily cron', async () => {
    await env.DB.prepare(
      "INSERT INTO audit (at, action, outcome) VALUES (?, 'token', 'ok'), (?, 'token', 'ok')",
    )
      .bind(Date.now() - 91 * 86_400_000, Date.now() - 89 * 86_400_000)
      .run();

    await worker.scheduled({ cron: '17 3 * * *' }, env);

    expect(await auditRows()).toHaveLength(1);
  });
});

describe("uninstall's cleanup", () => {
  beforeEach(async () => {
    await installed(11, { id: 7, login: 'acme', permissions: ALL });
    upstream.memberships.set('alice', [
      { id: 11, login: 'acme', role: 'admin' },
      { id: 12, login: 'acme-labs', role: 'admin' },
    ]);
    upstream.memberships.set('bob', [
      { id: 11, login: 'acme', role: 'member' },
    ]);
  });
  // The sign-in: a user's App token, with the install key when the CLI
  // could read it.
  const cleanup = (user: string, org = 'acme', key: string | null = null) =>
    call('/v1/installs/cleanup', key, { github_token: `token-${user}`, org });
  const signedIn = async (key: string | null = null) =>
    (await (await cleanup('alice', 'acme', key)).json()) as {
      token: string | null;
      cleanup_id: string;
    };
  const finish = (cleanup_id: string) =>
    call('/v1/installs/cleanup/finish', null, { cleanup_id });
  const refresh = (cleanup_id: string) =>
    call('/v1/installs/cleanup/token', null, { cleanup_id });
  // An install whose listener minted a token in the last hour.
  const live = async (org = 11) => {
    const minted = await mintKey(env.DB, org);
    expect((await call('/v1/token', minted.key)).status).toBe(200);
    upstream.mints = [];
    return minted;
  };

  it("mints a runners-only token for the owner's org", async () => {
    const res = await cleanup('alice');

    expect(await res.json()).toEqual({
      token: 'ghs_7',
      expires_at: '2026-11-06T13:00:00Z',
      org: { id: 11, login: 'acme' },
      cleanup_id: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(upstream.mints).toEqual([
      { organization_self_hosted_runners: 'write' },
    ]);
    // The user's token goes to GitHub only.
    expect(JSON.stringify(await auditRows())).not.toContain('token-alice');
  });

  it('refuses a member who is not an admin, and an org the admin has no role in', async () => {
    const asBob = await cleanup('bob');
    const otherOrg = await cleanup('alice', 'globex');

    expect(asBob.status).toBe(403);
    expect(otherOrg.status).toBe(403);
    expect(upstream.mints).toEqual([]);
  });

  it("mints only for the installation whose account.id is the admin's org", async () => {
    // acme-labs (12) has no installation of its own; another account's
    // installation answers for its login.
    upstream.installations.set(13, {
      id: 8,
      login: 'acme-labs',
      permissions: ALL,
    });

    const res = await cleanup('alice', 'acme-labs');

    expect(await res.json()).toMatchObject({
      token: null,
      org: { id: 12, login: 'acme-labs' },
    });
    expect(upstream.mints).toEqual([]);
  });

  it('refuses with 409 while another install of the org minted a token in the last hour', async () => {
    const other = await live();

    const res = await cleanup('alice');

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining(
        'run uninstall again an hour after the latest token listed',
      ),
      live: [{ install: other.install, last_token_at: expect.any(String) }],
    });
    expect(upstream.mints).toEqual([]);

    // A revoked install isn't live.
    await env.DB.prepare('UPDATE installs SET revoked = 1').run();
    expect((await cleanup('alice')).status).toBe(200);
  });

  it("leaves the sender's own key working when a sibling install or the limit refuses", async () => {
    const own = await live();
    await live();

    expect((await cleanup('alice', 'acme', own.key)).status).toBe(409);
    expect((await call('/v1/token', own.key)).status).toBe(200);
    await env.DB.prepare(
      "INSERT INTO audit (at, action, outcome, org) VALUES (?, 'cleanup', 'ok', 11), (?, 'cleanup', 'ok', 11), (?, 'cleanup', 'ok', 11), (?, 'cleanup', 'ok', 11), (?, 'cleanup', 'ok', 11)",
    )
      .bind(Date.now(), Date.now(), Date.now(), Date.now(), Date.now())
      .run();
    expect((await cleanup('alice', 'acme', own.key)).status).toBe(429);
    expect((await call('/v1/token', own.key)).status).toBe(200);
    // Neither refusal kept a cleanup.
    expect(
      (await env.DB.prepare('SELECT * FROM cleanups').all()).results,
    ).toEqual([]);
  });

  it("doesn't count the uninstalling install's own mint, and revokes its key", async () => {
    const own = await live();

    const res = await cleanup('alice', 'acme', own.key);

    expect(res.status).toBe(200);
    expect((await call('/v1/token', own.key)).status).toBe(401);
    // A rerun with the revoked key works.
    expect((await cleanup('alice', 'acme', own.key)).status).toBe(200);
  });

  it("refuses another org's or an unknown install key", async () => {
    const theirs = await mintKey(env.DB, 12);

    for (const key of [theirs.key, `bmk_${'0'.repeat(64)}`]) {
      expect((await cleanup('alice', 'acme', key)).status).toBe(403);
    }
    expect((await call('/v1/token', theirs.key)).status).not.toBe(401);
    expect(upstream.mints).toEqual([]);
  });

  it('re-mints with the cleanup_id, without a second sign-in', async () => {
    const { cleanup_id } = await signedIn();

    const res = await refresh(cleanup_id);

    expect(await res.json()).toMatchObject({ token: 'ghs_7' });
    expect(upstream.mints).toHaveLength(2);
    expect((await refresh('f'.repeat(64))).status).toBe(401);
  });

  it("finishes by deleting the org's installation and revoking every key", async () => {
    const idle = await mintKey(env.DB, 11);
    const { cleanup_id } = await signedIn();

    const res = await finish(cleanup_id);

    expect(await res.json()).toEqual({ removed: true, still_used_by: [] });
    expect(upstream.installations.has(11)).toBe(false);
    expect(upstream.calls).toContain(
      'DELETE api.github.com/app/installations/7',
    );
    expect((await call('/v1/token', idle.key)).status).toBe(401);
    // Once only.
    expect((await finish(cleanup_id)).status).toBe(401);
    expect((await refresh(cleanup_id)).status).toBe(401);
  });

  it('keeps the installation while another install has gone live since', async () => {
    const { cleanup_id } = await signedIn();
    const other = await live();

    const res = await finish(cleanup_id);

    expect(await res.json()).toEqual({
      removed: false,
      still_used_by: [other.install],
    });
    expect(upstream.installations.has(11)).toBe(true);
    expect((await call('/v1/token', other.key)).status).toBe(200);
  });

  it('counts an installation already gone as removed', async () => {
    const { cleanup_id } = await signedIn();
    upstream.installations.delete(11);

    expect(await (await finish(cleanup_id)).json()).toEqual({
      removed: true,
      still_used_by: [],
    });
  });

  it('expires a cleanup after 3 hours, and the cron deletes it', async () => {
    const { cleanup_id } = await signedIn();
    await env.DB.prepare('UPDATE cleanups SET expires_at = ?')
      .bind(Date.now() - 1)
      .run();

    expect((await finish(cleanup_id)).status).toBe(401);
    await worker.scheduled({ cron: '17 3 * * *' }, env);
    expect(
      (await env.DB.prepare('SELECT * FROM cleanups').all()).results,
    ).toEqual([]);
  });

  it('writes an audit row for every completed or refused call, without a token', async () => {
    upstream.revoked.add('dave');
    const { cleanup_id } = await signedIn();
    await cleanup('bob');
    await cleanup('dave');
    await call('/v1/installs/cleanup', null, { org: 'acme' });
    await finish(cleanup_id);

    const rows = await auditRows();
    expect(rows).toEqual([
      expect.objectContaining({
        action: 'cleanup',
        outcome: 'ok',
        install: null,
        org: 11,
        installation: 7,
        permissions: JSON.stringify({
          organization_self_hosted_runners: 'write',
        }),
        expires_at: '2026-11-06T13:00:00Z',
        ip: '203.0.113.7',
        ray: 'ray-1',
      }),
      expect.objectContaining({ outcome: 'not_admin', org: 11 }),
      expect.objectContaining({ outcome: 'signin_failed' }),
      expect.objectContaining({ outcome: 'bad_request' }),
      expect.objectContaining({
        action: 'uninstall',
        outcome: 'ok',
        org: 11,
        installation: 7,
      }),
    ]);
    expect(JSON.stringify(rows)).not.toContain('ghs_');
    expect(JSON.stringify(rows)).not.toContain(cleanup_id);
  });

  it('allows 5 admin-checked calls an hour per org, re-mints included', async () => {
    for (let i = 0; i < 6; i++) {
      expect((await cleanup('bob')).status).toBe(403);
    }
    const other = await live();
    for (let i = 0; i < 2; i++) {
      expect((await cleanup('alice')).status).toBe(409);
    }
    await env.DB.prepare('UPDATE installs SET revoked = 1 WHERE id = ?')
      .bind(other.install)
      .run();
    const { cleanup_id } = await signedIn();
    expect((await refresh(cleanup_id)).status).toBe(200);
    expect((await cleanup('alice')).status).toBe(200);
    upstream.mints = [];

    expect((await cleanup('alice')).status).toBe(429);
    expect((await refresh(cleanup_id)).status).toBe(429);
    expect(upstream.mints).toEqual([]);
    expect((await cleanup('alice', 'acme-labs')).status).toBe(200);
  });

  it('answers 429 over SIGNIN_LIMIT per client IP', async () => {
    env.SIGNIN_LIMIT = limiter(1);

    expect((await cleanup('alice')).status).toBe(200);
    expect((await cleanup('alice')).status).toBe(429);
  });
});
