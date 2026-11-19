// The staging Worker holds the production App's key and runs rc code, so it
// serves only the test orgs STAGING_ORGS names: an install, uninstall's
// cleanup, a cue sign-in or an install key's token for any other org is
// refused before GitHub is asked.
import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../worker/src/index.js';
import worker from '../../../worker/src/index.js';
import { mintKey, rememberLogin } from '../../../worker/src/installs.js';
import { ORIGIN, testEnv, Upstream } from './fakes.js';

const ALL = {
  organization_self_hosted_runners: 'write',
  actions: 'write',
  checks: 'write',
  metadata: 'read',
};

let env: Env;
let upstream: Upstream;

beforeEach(() => {
  env = { ...testEnv(), STAGING_ORGS: 'backmesh-e2e,backmesh-dryrun' };
  upstream = new Upstream();
  vi.stubGlobal('fetch', upstream.fetch);
  // cue.ts caches memberships; nothing here should reach it.
  vi.stubGlobal('caches', {
    default: { match: async () => undefined, put: async () => {} },
  });
  upstream.memberships.set('alice', [
    { id: 11, login: 'acme', role: 'admin' },
    { id: 21, login: 'Backmesh-Dryrun', role: 'admin' },
  ]);
  upstream.installations.set(21, {
    id: 9,
    login: 'Backmesh-Dryrun',
    permissions: ALL,
  });
});
afterEach(() => vi.unstubAllGlobals());

const call = (
  path: string,
  init: { key?: string; body?: object; token?: string } = {},
) =>
  worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: init.body || init.key ? 'POST' : 'GET',
      headers: {
        ...((init.key || init.token) && {
          Authorization: `Bearer ${init.key ?? init.token}`,
        }),
        'CF-Connecting-IP': '203.0.113.7',
      },
      body: init.body && JSON.stringify(init.body),
    }),
    env,
  );

describe('the staging Worker', () => {
  it('refuses an install, a cleanup and a cue sign-in for any other org, before GitHub', async () => {
    const refused = [
      await call('/v1/installs', {
        body: { org: 'acme', device_code: 'alice' },
      }),
      await call('/v1/installs/cleanup', {
        body: { org: 'acme', device_code: 'alice' },
      }),
      await call('/v1/cue/keys?org=acme', { token: 'token-alice' }),
    ];
    for (const res of refused) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: 'This backmesh Worker serves only its test orgs, not acme.',
      });
    }
    expect(upstream.calls).toEqual([]);
  });

  it("refuses a token for another org's key", async () => {
    await rememberLogin(env, 11, 'acme');
    const { key } = await mintKey(env.DB, 11);
    const res = await call('/v1/token', { key });
    expect(res.status).toBe(403);
    expect(upstream.calls).toEqual([]);
  });

  it('serves its test orgs, whatever their case', async () => {
    const signedIn = await call('/v1/installs', {
      body: { org: 'Backmesh-Dryrun', device_code: 'alice' },
    });
    expect(signedIn.status).toBe(200);
    const { key } = (await signedIn.json()) as { key: string };
    expect(await (await call('/v1/token', { key })).json()).toMatchObject({
      token: 'ghs_9',
    });
  });

  it('is set for staging only', () => {
    const config = readFileSync('worker/wrangler.jsonc', 'utf8');
    const staging = config.slice(config.indexOf('"staging": {'));
    expect(staging).toContain('"STAGING_ORGS": "backmesh-e2e,backmesh-dryrun"');
    // Nowhere else: production serves every org.
    expect(config.split('STAGING_ORGS')).toHaveLength(2);
  });
});
