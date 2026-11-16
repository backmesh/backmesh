import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { UsageError } from '../../../src/cli/errors.js';
import { pickOrg } from '../../../src/cli/pick-org.js';

// GitHub and the Worker's device flow: each token's memberships (undefined
// answers 401), and which logins are orgs.
function fakeFetch(
  memberships: Record<string, Record<string, string>>,
  orgs: string[],
  calls: string[],
) {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/v1/installs/device')) {
      return Response.json({
        device_code: 'd',
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        interval: 0,
        expires_in: 900,
      });
    }
    if (url.endsWith('/v1/sign-in')) {
      return Response.json({ github_token: 'gho_new' });
    }
    if (url.startsWith('https://api.github.com/user/memberships/orgs')) {
      const token = new Headers(init?.headers)
        .get('authorization')!
        .replace('Bearer ', '');
      const roles = memberships[token];
      if (!roles) return new Response(null, { status: 401 });
      if (token === 'gho_noscope') return new Response(null, { status: 403 });
      return Response.json(
        Object.entries(roles).map(([login, role]) => ({
          role,
          state: 'active',
          organization: { login },
        })),
      );
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
  memberships = {},
  orgs = [],
  remotes = '',
  answers = [],
}: {
  argv?: string[];
  plan?: boolean;
  terminal?: boolean;
  saved?: string;
  memberships?: Record<string, Record<string, string>>;
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
    signInScopes: async () => ['read:org', 'read:packages'],
    git: async (args) => {
      expect(args).toEqual(['remote', '-v']);
      if (!remotes) throw new Error('not a git repository');
      return remotes;
    },
    fetch: fakeFetch(memberships, orgs, calls),
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

const ADMIN = { acme: 'admin', beta: 'admin', gamma: 'admin', club: 'member' };
const ORIGIN = [
  'upstream\tgit@github.com:other/tool.git (fetch)',
  'origin\thttps://github.com/acme/app.git (fetch)',
  'origin\thttps://github.com/acme/app.git (push)',
].join('\n');

describe('pickOrg', () => {
  it("installs for this repo's org when the user accepts it", async () => {
    const out = await pick({
      saved: 'gho_saved',
      memberships: { gho_saved: ADMIN },
      remotes: ORIGIN,
    });
    expect(out.result).toBe('acme');
    expect(out.asked).toEqual([
      "Installing for acme (from this repo's remote). Continue? [Y/n]",
    ]);
    // The saved sign-in lists the orgs: no device code.
    expect(out.calls.some((c) => c.includes('/v1/'))).toBe(false);
  });

  it("takes the first GitHub remote when origin isn't GitHub's", async () => {
    const out = await pick({
      saved: 'gho_saved',
      memberships: { gho_saved: { other: 'admin' } },
      remotes: [
        'origin\tgit@gitlab.com:acme/app.git (fetch)',
        'mirror\tssh://git@github.com/other/app (fetch)',
      ].join('\n'),
    });
    expect(out.result).toBe('other');
  });

  it("offers the other orgs when the user declines the repo's", async () => {
    const out = await pick({
      saved: 'gho_saved',
      memberships: { gho_saved: ADMIN },
      remotes: ORIGIN,
      answers: ['n', 'x', '3', '2'],
    });
    expect(out.result).toBe('gamma');
    // The declined org and orgs where the user is only a member aren't listed.
    expect(out.lines).toEqual([
      "Orgs you're an admin of:",
      '  1. beta',
      '  2. gamma',
    ]);
    expect(out.asked.slice(1)).toEqual([
      'Which org? [1-2]',
      'Which org? [1-2]',
      'Which org? [1-2]',
    ]);
    const other = await pick({
      saved: 'gho_saved',
      memberships: { gho_saved: { acme: 'admin', beta: 'admin' } },
      remotes: ORIGIN,
      answers: ['n'],
    });
    expect(other.result).toBe('beta');
    expect(other.lines).toEqual([
      "Installing for beta, the only other org you're an admin of.",
    ]);
    const declined = await pick({
      saved: 'gho_saved',
      memberships: { gho_saved: { acme: 'admin' } },
      remotes: ORIGIN,
      answers: ['no'],
    });
    expect(declined.result).toBeInstanceOf(UsageError);
    expect((declined.result as Error).message).toContain(
      "You're an admin of no other GitHub org.",
    );
  });

  it('signs in first without a saved sign-in, then picks the only admin org', async () => {
    // The repo is a personal account's, so it isn't offered.
    const out = await pick({
      memberships: { gho_new: { beta: 'admin', club: 'member' } },
      remotes: 'origin\tgit@github.com:alice/dotfiles.git (fetch)',
    });
    expect(out.result).toBe('beta');
    expect(out.asked).toEqual([]);
    expect(out.lines).toEqual([
      'Sign in with GitHub for your backmesh installation: open https://github.com/login/device and enter ABCD-1234.',
      "Installing for beta, the only org you're an admin of.",
    ]);
    // The sign-in is the control plane's, which install then reuses.
    expect(out.token).toBe('gho_new');
  });

  it('signs in again when GitHub refuses the saved sign-in', async () => {
    for (const saved of ['gho_revoked', 'gho_noscope']) {
      const out = await pick({
        saved,
        memberships: { gho_noscope: {}, gho_new: { beta: 'admin' } },
      });
      expect(out.result).toBe('beta');
      expect(out.token).toBe('gho_new');
    }
  });

  it('says backmesh runs on orgs when the user admins none', async () => {
    const out = await pick({
      saved: 'gho_saved',
      memberships: { gho_saved: { club: 'member' } },
    });
    expect(out.result).toBeInstanceOf(UsageError);
    expect((out.result as Error).message).toBe(
      "You're an admin of no GitHub org. backmesh runs on an org's repositories: create one at https://github.com/account/organizations/new, or ask an org's admin to run install.",
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
    expect(guessed.calls.some((c) => c.includes('/v1/'))).toBe(false);
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
    expect(declined.calls.some((c) => c.includes('/v1/'))).toBe(false);
    // A saved sign-in still lists them.
    const saved = await pick({
      argv: ['install', '--plan'],
      plan: true,
      saved: 'gho_saved',
      memberships: { gho_saved: { beta: 'admin' } },
    });
    expect(saved.result).toBe('beta');
  });

  it('prompts for nothing without a terminal, naming the orgs and the command', async () => {
    const listed = await pick({
      argv: ['--json', 'install', '--runners', 'aws', '--cache-cap', '25'],
      terminal: false,
      saved: 'gho_saved',
      memberships: { gho_saved: ADMIN },
    });
    expect(listed.result).toBeInstanceOf(UsageError);
    expect((listed.result as Error).message).toBe(
      "Pass --org: install asks which org only at a terminal, without --yes. You're an admin of acme, beta, gamma. Run: backmesh --json install --org <org> --runners aws --cache-cap 25 --plan",
    );
    // The repo's org, or the only one, fills the command in.
    const repo = await pick({
      argv: ['install', '--plan'],
      terminal: false,
      saved: 'gho_saved',
      memberships: { gho_saved: ADMIN },
      remotes: ORIGIN,
    });
    expect((repo.result as Error).message).toBe(
      "Pass --org: install asks which org only at a terminal, without --yes. You're an admin of acme, beta, gamma. Run: backmesh install --org acme --plan",
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
    expect(unsigned.calls.some((c) => c.includes('/v1/'))).toBe(false);
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
    expect(yes.calls.some((c) => c.includes('/v1/'))).toBe(false);
    const none = await pick({
      terminal: false,
      saved: 'gho_saved',
      memberships: { gho_saved: {} },
    });
    expect((none.result as Error).message).toBe(
      "Pass --org: install asks which org only at a terminal, without --yes. You're an admin of no GitHub org; backmesh runs on an org's repositories: create one at https://github.com/account/organizations/new. Then run: backmesh install --org <org> --plan",
    );
  });
});
