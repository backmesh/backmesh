import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  workerDeps,
  finishCleanup,
  refreshCleanupToken,
  signInForCleanup,
} from '../../../src/cli/worker.js';
import { removeFromGitHub } from '../../../src/cli/cleanup.js';
import type { Env } from '../../../worker/src/index.js';
import worker from '../../../worker/src/index.js';
import { mintKey, rememberLogin } from '../../../worker/src/installs.js';
import { limiter, ORIGIN, testEnv, Upstream } from '../worker/fakes.js';
import { fakeOrg, GROUP } from './fakes.js';

// The CLI's side of uninstall's cleanup against the real Worker,
// whose GitHub is faked, and an org's GitHub as the cleanup token sees it.
let env: Env;
let upstream: Upstream;

beforeEach(() => {
  env = testEnv();
  upstream = new Upstream();
  vi.stubGlobal('fetch', upstream.fetch);
  // The device sign-in's user is an admin of acme, which has the App.
  upstream.memberships.set('device', [
    { id: 11, login: 'acme', role: 'admin' },
  ]);
  upstream.installations.set(11, {
    id: 7,
    login: 'acme',
    permissions: {
      organization_self_hosted_runners: 'write',
      actions: 'write',
      checks: 'write',
      metadata: 'read',
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

function setUp(org = fakeOrg()) {
  const lines: string[] = [];
  const calls: string[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).startsWith(ORIGIN)) {
      calls.push(new URL(String(url)).pathname);
      return worker.fetch(new Request(url, init), env);
    }
    // GitHub's device flow, from the same fake GitHub as the Worker's.
    if (new URL(String(url)).host === 'github.com') {
      return upstream.fetch(url as string, init);
    }
    return org.fetch(url, init);
  }) as typeof globalThis.fetch;
  const print = (line: string) => lines.push(line);
  const client = workerDeps(
    { env: { BACKMESH_API_URL: ORIGIN }, fetch, wait: async () => {} },
    print,
  );
  const github = { print, fetch, sleep: async () => undefined };
  return { client, github, lines, org, calls };
}

describe("uninstall's cleanup", () => {
  it("signs in once, removes only backmesh's runners, scale sets and group, then finishes", async () => {
    upstream.devicePending = 1;
    const { client, github, lines, org, calls } = setUp();
    // On-demand scale sets go too, on one cloud or several.
    org.sets.set('backmesh-od-4', 3);
    org.sets.set('backmesh-gcp-od-16', 4);

    const cleanup = await signInForCleanup('acme', undefined, client);
    const remaining = await removeFromGitHub(
      cleanup.org.login,
      cleanup.token!,
      github,
    );
    const app = await finishCleanup(cleanup.cleanup_id!, client);

    // GitHub's device flow on github.com, then one call with its token.
    expect(calls).toEqual([
      '/v1/installs/cleanup',
      '/v1/installs/cleanup/finish',
    ]);
    expect(
      upstream.calls.filter((c) => c.startsWith('POST github.com/')),
    ).toEqual([
      'POST github.com/login/device/code',
      'POST github.com/login/oauth/access_token',
      'POST github.com/login/oauth/access_token',
    ]);
    expect(upstream.mints).toEqual([
      { organization_self_hosted_runners: 'write' },
    ]);
    expect(remaining).toEqual([]);
    expect(org.sets.size).toBe(0);
    // Another org runner whose name starts with bm stays.
    expect([...org.runners.values()]).toEqual(['build-box', 'bmaster-ci']);
    // The shared group from before per-install names stays.
    expect([...org.groups.values()]).toEqual(['Default', 'backmesh']);
    expect(app).toEqual({ removed: true, still_used_by: [] });
    expect(upstream.installations.has(11)).toBe(false);
    // Every GitHub call but the Actions service's own exchange uses the
    // cleanup token, which is never printed.
    const rest = org.calls.filter(
      (c) =>
        c.url.host === 'api.github.com' &&
        c.url.pathname !== '/actions/runner-registration',
    );
    expect(new Set(rest.map((c) => c.headers.get('authorization')))).toEqual(
      new Set(['token ghs_7']),
    );
    expect(lines).toEqual([
      expect.stringMatching(
        /^Sign in with GitHub as an admin of acme, so backmesh removes itself from acme: open https:\/\/github\.com\/login\/device and enter ABCD-1234 \(it expires at \d\d:\d\d UTC\)\.$/,
      ),
    ]);
  });

  it('sends the install key, so its own listener does not refuse the cleanup', async () => {
    await rememberLogin(env, 11, 'acme');
    const own = await mintKey(env.DB, 11);
    await worker.fetch(
      new Request(`${ORIGIN}/v1/token`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${own.key}` },
      }),
      env,
    );
    const { client } = setUp();

    await expect(signInForCleanup('acme', undefined, client)).rejects.toThrow(
      `${own.install} (last token `,
    );
    await expect(
      signInForCleanup('acme', own.key, client),
    ).resolves.toMatchObject({ token: 'ghs_7' });
  });

  it('stops at a 429 and says to retry later', async () => {
    env.SIGNIN_LIMIT = limiter(0);
    const { client, calls } = setUp();

    await expect(signInForCleanup('acme', undefined, client)).rejects.toThrow(
      'Too many requests; retry later.',
    );
    expect(calls).toEqual(['/v1/installs/cleanup']);
  });

  it('re-mints with the cleanup_id', async () => {
    const { client } = setUp();
    const cleanup = await signInForCleanup('acme', undefined, client);

    expect(await refreshCleanupToken(cleanup.cleanup_id!, client)).toEqual({
      token: 'ghs_7',
      expires_at: '2026-11-06T13:00:00Z',
      org: { id: 11, login: 'acme' },
    });
  });

  it('answers what GitHub still lists, and prints the first failure', async () => {
    const sticky = setUp(fakeOrg({ stickyRunner: true }));

    expect(await removeFromGitHub('acme', 'ghs_7', sticky.github)).toEqual([
      'runner bm0a1b2-a4-k3j9x0qz',
      `runner group ${GROUP}`,
    ]);

    const down = setUp();
    down.github.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof globalThis.fetch;
    const left = await removeFromGitHub('acme', 'ghs_7', down.github);
    expect(left).toEqual([expect.stringMatching(/^GitHub cleanup: /)]);
    expect(down.lines).toEqual([
      expect.stringMatching(/^GitHub cleanup failed \(.*\); retrying\.$/),
    ]);
  });
});
