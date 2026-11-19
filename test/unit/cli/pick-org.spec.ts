import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { UsageError } from '../../../src/cli/errors.js';
import { pickOrg } from '../../../src/cli/pick-org.js';

// GitHub: its device flow, which signs in as `ghu_new`; the orgs each
// token reaches the backmesh App's installation on (undefined answers 401;
// an App user token lists no memberships without the Members permission);
// and which logins are orgs.
function fakeFetch(
  installs: Record<string, string[]>,
  orgs: string[],
  calls: string[],
) {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url === 'https://github.com/login/device/code') {
      return Response.json({
        device_code: 'd',
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        interval: 0,
        expires_in: 900,
      });
    }
    if (url === 'https://github.com/login/oauth/access_token') {
      return Response.json({ access_token: 'ghu_new' });
    }
    const token = new Headers(init?.headers)
      .get('authorization')
      ?.replace('Bearer ', '');
    if (url.startsWith('https://api.github.com/user/memberships/orgs')) {
      return Response.json([]);
    }
    if (url.startsWith('https://api.github.com/user/installations')) {
      const reached = installs[token!];
      if (!reached) return new Response(null, { status: 401 });
      const installations = reached.map((login, i) => ({
        id: i + 1,
        app_slug: 'backmesh',
        account: { login, type: 'Organization' },
      }));
      return Response.json({
        total_count: installations.length,
        installations,
      });
    }
    const org = /\/orgs\/([^/]+)$/.exec(url)?.[1];
    if (org) {
      return orgs.includes(org)
        ? Response.json({ id: 7 })
        : new Response(null, { status: 404 });
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof globalThis.fetch;
}

async function pick({
  argv = ['install'],
  plan = false,
  terminal = true,
  saved,
  installs = {},
  orgs = [],
  remotes = '',
  answers = [],
}: {
  argv?: string[];
  plan?: boolean;
  terminal?: boolean;
  saved?: string;
  installs?: Record<string, string[]>;
  orgs?: string[];
  remotes?: string;
  answers?: string[];
}) {
  const dir = mkdtempSync(join(tmpdir(), 'backmesh-pick-org-'));
  if (saved) writeFileSync(join(dir, '.token'), `${saved}\n`);
  const lines: string[] = [];
  const asked: string[] = [];
  const calls: string[] = [];
  const result = await pickOrg(argv, plan, {
    env: { BACKMESH_ANYCLOUD_DIR: dir },
    ui: {
      print: (line) => lines.push(line),
      ...(terminal && {
        ask: async (question: string) => {
          asked.push(question);
          return answers.shift() ?? '';
        },
      }),
    },
    signInCheck: async () => ({ login: 'octocat', appIds: [] }),
    git: async (args) => {
      expect(args).toEqual(['remote', '-v']);
      if (!remotes) throw new Error('not a git repository');
      return remotes;
    },
    fetch: fakeFetch(installs, orgs, calls),
    wait: async () => undefined,
  }).catch((error: unknown) => error);
  const token = (() => {
    try {
      return readFileSync(join(dir, '.token'), 'utf8').trim();
    } catch {
      return undefined;
    }
  })();
  return { result, lines, asked, calls, token };
}

const APP = ['acme', 'beta', 'gamma'];
const ORIGIN = [
  'upstream\tgit@github.com:other/tool.git (fetch)',
  'origin\thttps://github.com/acme/app.git (fetch)',
  'origin\thttps://github.com/acme/app.git (push)',
].join('\n');
const signedIn = (calls: string[]) =>
  calls.some((c) => c.startsWith('https://github.com/login/'));

describe('pickOrg', () => {
  it("installs for this repo's org when the user accepts it, the App on it or not", async () => {
    const out = await pick({
      saved: 'ghu_saved',
      installs: { ghu_saved: [] },
      orgs: ['acme'],
      remotes: ORIGIN,
    });
    expect(out.result).toBe('acme');
    expect(out.asked).toEqual([
      "Installing for acme (from this repo's remote). Continue? [Y/n]",
    ]);
    // The saved sign-in lists the orgs: no device code.
    expect(signedIn(out.calls)).toBe(false);
  });

  it("takes the first GitHub remote when origin isn't GitHub's", async () => {
    const out = await pick({
      saved: 'ghu_saved',
      installs: { ghu_saved: [] },
      orgs: ['other'],
      remotes: [
        'origin\tgit@gitlab.com:acme/app.git (fetch)',
        'mirror\tssh://git@github.com/other/app (fetch)',
      ].join('\n'),
    });
    expect(out.result).toBe('other');
  });

  it("offers the user's orgs the App is on when they decline the repo's", async () => {
    const out = await pick({
      saved: 'ghu_saved',
      installs: { ghu_saved: APP },
      orgs: ['acme'],
      remotes: ORIGIN,
      answers: ['n', 'x', '3', '2'],
    });
    expect(out.result).toBe('gamma');
    // The declined org isn't listed.
    expect(out.lines).toEqual([
      "Your orgs backmesh's GitHub App is on:",
      '  1. beta',
      '  2. gamma',
    ]);
    expect(out.asked.slice(1)).toEqual([
      'Which org? [1-2]',
      'Which org? [1-2]',
      'Which org? [1-2]',
    ]);
    const other = await pick({
      saved: 'ghu_saved',
      installs: { ghu_saved: ['acme', 'beta'] },
      orgs: ['acme'],
      remotes: ORIGIN,
      answers: ['n'],
    });
    expect(other.result).toBe('beta');
    expect(other.lines).toEqual([
      "Installing for beta, the only other org of yours backmesh's GitHub App is on.",
    ]);
    const declined = await pick({
      saved: 'ghu_saved',
      installs: { ghu_saved: ['acme'] },
      orgs: ['acme'],
      remotes: ORIGIN,
      answers: ['no'],
    });
    expect(declined.result).toBeInstanceOf(UsageError);
    expect((declined.result as Error).message).toBe(
      "backmesh's GitHub App is on none of your other orgs, so install can't list them. Name the org: backmesh install --org <org>",
    );
  });

  it("signs in with the App's device flow without a saved sign-in, then lists the orgs from its installations", async () => {
    // The repo is a personal account's, so it isn't offered.
    const out = await pick({
      installs: { ghu_new: ['beta'] },
      remotes: 'origin\tgit@github.com:alice/dotfiles.git (fetch)',
    });
    expect(out.result).toBe('beta');
    expect(out.asked).toEqual([]);
    expect(out.lines).toEqual([
      expect.stringMatching(
        /^Sign in with GitHub for your backmesh installation: open https:\/\/github\.com\/login\/device and enter ABCD-1234 \(it expires at \d\d:\d\d UTC\)\.$/,
      ),
      "Installing for beta, the only org of yours backmesh's GitHub App is on.",
    ]);
    // An App user token's memberships list is empty: never read.
    expect(out.calls.some((c) => c.includes('/user/memberships'))).toBe(false);
    // The sign-in is the control plane's, which install then reuses.
    expect(out.token).toBe('ghu_new');
  });

  it('signs in again when GitHub refuses the saved sign-in', async () => {
    const out = await pick({
      saved: 'ghu_revoked',
      installs: { ghu_new: ['beta'] },
    });
    expect(out.result).toBe('beta');
    expect(out.token).toBe('ghu_new');
  });

  it("asks for the org when the App is on none of the user's orgs", async () => {
    const out = await pick({
      saved: 'ghu_saved',
      installs: { ghu_saved: [] },
    });
    expect(out.result).toBeInstanceOf(UsageError);
    expect((out.result as Error).message).toBe(
      "backmesh's GitHub App is on none of your orgs, so install can't list them. Name the org: backmesh install --org <org>",
    );
  });

  it('signs in to nothing for --plan: only the repo guess, else --org', async () => {
    const guessed = await pick({
      argv: ['install', '--plan'],
      plan: true,
      orgs: ['acme'],
      remotes: ORIGIN,
    });
    expect(guessed.result).toBe('acme');
    expect(guessed.asked).toEqual([
      "Planning for acme (from this repo's remote). Continue? [Y/n]",
    ]);
    expect(signedIn(guessed.calls)).toBe(false);
    expect(guessed.token).toBeUndefined();
    const declined = await pick({
      argv: ['install', '--plan', '--runners', 'aws'],
      plan: true,
      orgs: ['acme'],
      remotes: ORIGIN,
      answers: ['n'],
    });
    expect((declined.result as Error).message).toBe(
      "Pass --org <org>: --plan signs in to nothing, so it can't list your GitHub orgs. Run: backmesh install --org <org> --plan --runners aws",
    );
    expect(signedIn(declined.calls)).toBe(false);
    // A saved sign-in still lists them.
    const saved = await pick({
      argv: ['install', '--plan'],
      plan: true,
      saved: 'ghu_saved',
      installs: { ghu_saved: ['beta'] },
    });
    expect(saved.result).toBe('beta');
  });

  it('prompts for nothing without a terminal, naming the orgs and the command', async () => {
    const listed = await pick({
      argv: ['--json', 'install', '--runners', 'aws', '--cache-cap', '25'],
      terminal: false,
      saved: 'ghu_saved',
      installs: { ghu_saved: APP },
    });
    expect(listed.result).toBeInstanceOf(UsageError);
    expect((listed.result as Error).message).toBe(
      "Pass --org: install asks which org only at a terminal, without --yes. backmesh's GitHub App is on your orgs acme, beta, gamma. Run: backmesh --json install --org <org> --runners aws --cache-cap 25 --plan",
    );
    // The repo's org, or the only one, fills the command in.
    const repo = await pick({
      argv: ['install', '--plan'],
      terminal: false,
      saved: 'ghu_saved',
      installs: { ghu_saved: APP },
      orgs: ['acme'],
      remotes: ORIGIN,
    });
    expect((repo.result as Error).message).toBe(
      "Pass --org: install asks which org only at a terminal, without --yes. backmesh's GitHub App is on your orgs acme, beta, gamma. Run: backmesh install --org acme --plan",
    );
    // No sign-in without a terminal: the repo's org, when it is one.
    const unsigned = await pick({
      argv: ['install', '--yes', '--plan-id', 'p-1'],
      terminal: false,
      orgs: ['acme'],
      remotes: ORIGIN,
    });
    expect((unsigned.result as Error).message).toBe(
      "Pass --org: install asks which org only at a terminal, without --yes. This repo's remote is the org acme's. Run: backmesh install --org acme --yes --plan-id p-1",
    );
    expect(signedIn(unsigned.calls)).toBe(false);
    // --yes asks nothing at a terminal either, and signs in to nothing.
    const yes = await pick({
      argv: ['install', '--yes', '--plan-id', 'p-1'],
      remotes: ORIGIN,
      orgs: ['acme'],
    });
    expect((yes.result as Error).message).toContain(
      'Run: backmesh install --org acme --yes --plan-id p-1',
    );
    expect(yes.asked).toEqual([]);
    expect(signedIn(yes.calls)).toBe(false);
    const none = await pick({
      terminal: false,
      saved: 'ghu_saved',
      installs: { ghu_saved: [] },
    });
    expect((none.result as Error).message).toBe(
      "Pass --org: install asks which org only at a terminal, without --yes. backmesh's GitHub App is on none of your orgs yet. Run: backmesh install --org <org> --plan",
    );
  });
});
