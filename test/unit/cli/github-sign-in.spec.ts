import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { GitHubError, signInScopes } from '../../../src/app/github.js';
import { saveSignIn, signInAgain } from '../../../src/cli/github-sign-in.js';

// Spies on all four console methods @octokit/rest's default logger can
// reach (its own request-log plugin uses only `info` and `error`), and
// counts calls to each.
function spyOnConsole() {
  const calls = { debug: 0, info: 0, warn: 0, error: 0 };
  const methods = (['debug', 'info', 'warn', 'error'] as const).map((name) =>
    vi.spyOn(console, name).mockImplementation(() => {
      calls[name]++;
    }),
  );
  return { calls, restore: () => methods.forEach((m) => m.mockRestore()) };
}

describe('saveSignIn', () => {
  it('leaves no temporary token when it can’t replace the saved one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'backmesh-sign-in-'));
    // A directory where the token goes: the rename fails.
    mkdirSync(join(dir, '.token'));
    await expect(
      saveSignIn({ BACKMESH_ANYCLOUD_DIR: dir }, 'gho_x', async () => [
        'read:org',
        'read:packages',
      ]),
    ).rejects.toThrow();
    expect(readdirSync(dir)).toEqual(['.token']);
  });
});

describe('signInAgain', () => {
  // The Worker's device flow, answering at once.
  const fetch = (async (url: string) =>
    url.endsWith('/v1/installs/device')
      ? Response.json({
          device_code: 'd',
          user_code: 'ABCD-1234',
          verification_uri: 'https://github.com/login/device',
          interval: 0,
          expires_in: 900,
        })
      : Response.json({ github_token: 'gho_new' })) as typeof globalThis.fetch;
  // GitHub answers 401 for a revoked token, and can't check `gho_down`.
  const scopes = async (token: string) => {
    if (token === 'gho_revoked') throw new GitHubError(401, 'Bad credentials');
    if (token === 'gho_down') throw new GitHubError(403, 'rate limited');
    if (token === 'gho_wide') return ['read:org', 'read:packages', 'repo'];
    return ['read:org', 'read:packages'];
  };
  const again = async (saved: string | undefined) => {
    const dir = mkdtempSync(join(tmpdir(), 'backmesh-sign-in-'));
    if (saved) writeFileSync(join(dir, '.token'), `${saved}\n`);
    const lines: string[] = [];
    await signInAgain(
      {
        env: { BACKMESH_ANYCLOUD_DIR: dir },
        fetch,
        print: (l) => lines.push(l),
        wait: async () => {},
      },
      scopes,
    )();
    expect(readFileSync(join(dir, '.token'), 'utf8')).toBe('gho_new\n');
    return { said: lines.filter((l) => l.includes('revoked')) };
  };

  it('says GitHub revoked the saved sign-in only when GitHub answers 401', async () => {
    const { said } = await again('gho_revoked');
    expect(said).toEqual([
      `GitHub revoked the saved sign-in. backmesh signs in again.`,
    ]);
    // A working one (as for \`cue --sign-in\`), one GitHub couldn't check,
    // one with other scopes, one that isn't an OAuth sign-in, or none is
    // replaced without a word.
    for (const saved of [
      'gho_ok',
      'gho_down',
      'gho_wide',
      'ghs_x',
      undefined,
    ]) {
      expect((await again(saved)).said).toEqual([]);
    }
  });
});

describe('signInScopes (the real GitHub client)', () => {
  it("doesn't print @octokit/rest's own request-log line, on success or a 401", async () => {
    const { calls, restore } = spyOnConsole();
    try {
      const ok = (async () =>
        Response.json(
          {},
          { headers: { 'x-oauth-scopes': 'read:org, read:packages' } },
        )) as typeof globalThis.fetch;
      await expect(
        signInScopes('gho_ok', { request: { fetch: ok } }),
      ).resolves.toEqual(['read:org', 'read:packages']);
      const revoked = (async () =>
        Response.json(
          { message: 'Bad credentials' },
          { status: 401, headers: { 'x-github-request-id': 'DA94:1234' } },
        )) as typeof globalThis.fetch;
      await expect(
        signInScopes('gho_revoked', { request: { fetch: revoked } }),
      ).rejects.toMatchObject({ status: 401 });
    } finally {
      restore();
    }
    // Neither `GET /user - 200 with id … in …ms` nor the `401` line printed
    // (@octokit/plugin-request-log's `info` and `error`); no other console
    // output either.
    expect(calls).toEqual({ debug: 0, info: 0, warn: 0, error: 0 });
  });

  it('still prints a real warning, such as a deprecated endpoint', async () => {
    const { calls, restore } = spyOnConsole();
    const deprecated = (async () =>
      Response.json(
        {},
        {
          headers: {
            'x-oauth-scopes': 'read:org, read:packages',
            deprecation: 'true',
            sunset: 'Wed, 11 Nov 2026 00:00:00 GMT',
            link: '<https://docs.github.com/deprecation>; rel="deprecation"',
          },
        },
      )) as typeof globalThis.fetch;
    try {
      await expect(
        signInScopes('gho_ok', { request: { fetch: deprecated } }),
      ).resolves.toEqual(['read:org', 'read:packages']);
    } finally {
      restore();
    }
    // The request-log line stays quiet; @octokit/request's own deprecation
    // warning (unrelated to that plugin) still reaches the real `console.warn`.
    expect(calls).toEqual({ debug: 0, info: 0, warn: 1, error: 0 });
  });

  it("reports a 500 as saveSignIn's own message, with no request-log line", async () => {
    const { calls, restore } = spyOnConsole();
    const dir = mkdtempSync(join(tmpdir(), 'backmesh-sign-in-'));
    const outage = (async () =>
      Response.json(
        { message: 'Internal Server Error' },
        { status: 500 },
      )) as typeof globalThis.fetch;
    let error: unknown;
    try {
      await saveSignIn({ BACKMESH_ANYCLOUD_DIR: dir }, 'gho_down', (token) =>
        signInScopes(token, { request: { fetch: outage } }),
      ).catch((e: unknown) => {
        error = e;
      });
    } finally {
      restore();
    }
    expect((error as Error).message).toContain(
      "Couldn't check the GitHub sign-in with GitHub. Retry.",
    );
    expect(calls).toEqual({ debug: 0, info: 0, warn: 0, error: 0 });
  });
});

describe('signInAgain, with the real GitHub client', () => {
  it('prints only the friendly line on a 401: no raw request log on stdout or stderr', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'backmesh-sign-in-'));
    writeFileSync(join(dir, '.token'), 'gho_revoked\n');
    const { calls, restore } = spyOnConsole();
    const lines: string[] = [];
    // The backmesh Worker's device flow, answering at once.
    const backmeshFetch = (async (url: string) =>
      url.endsWith('/v1/installs/device')
        ? Response.json({
            device_code: 'd',
            user_code: 'ABCD-1234',
            verification_uri: 'https://github.com/login/device',
            interval: 0,
            expires_in: 900,
          })
        : Response.json({
            github_token: 'gho_new',
          })) as typeof globalThis.fetch;
    // GitHub: 401 for the revoked token being checked, fine for the fresh
    // one `saveSignIn` checks right after.
    const githubFetch = (async (_url: string | URL, init?: RequestInit) =>
      new Headers(init?.headers).get('Authorization') === 'token gho_revoked'
        ? Response.json(
            { message: 'Bad credentials' },
            { status: 401, headers: { 'x-github-request-id': 'DA94:1234' } },
          )
        : Response.json(
            {},
            { headers: { 'x-oauth-scopes': 'read:org, read:packages' } },
          )) as typeof globalThis.fetch;
    try {
      await signInAgain(
        {
          env: { BACKMESH_ANYCLOUD_DIR: dir },
          fetch: backmeshFetch,
          print: (l) => lines.push(l),
          wait: async () => {},
        },
        (token) => signInScopes(token, { request: { fetch: githubFetch } }),
      )();
    } finally {
      restore();
    }
    // `signIn` also prints its own device-code instruction; only the
    // revoked-sign-in line matters here, and no raw request-log line.
    expect(lines.filter((l) => l.includes('revoked'))).toEqual([
      'GitHub revoked the saved sign-in. backmesh signs in again.',
    ]);
    expect(readFileSync(join(dir, '.token'), 'utf8')).toBe('gho_new\n');
    expect(calls).toEqual({ debug: 0, info: 0, warn: 0, error: 0 });
  });
});
