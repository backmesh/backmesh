// `backmesh install` without `--org` (owner, 2026-11-13): this repo's
// GitHub remote's org, confirmed, else one the user is an admin of, from
// their GitHub sign-in. Without a terminal nothing prompts: the error names
// the orgs and the command to run. `--plan` signs in to nothing, so it lists
// orgs only with a saved sign-in.
import { z } from 'zod';

import { anycloudPath, readSaved } from '../anycloud/client.js';
import { signInAgain, type SignInScopes } from './github-sign-in.js';
import { GITHUB_REMOTE } from './cue.js';
import { UsageError } from './errors.js';
import type { InstallUi } from './install.js';
import { readOrgId } from './installation.js';
import { workerDeps } from './worker.js';

export interface PickOrgDeps {
  env: NodeJS.ProcessEnv;
  ui: InstallUi;
  signInScopes: SignInScopes;
  // This checkout's `git`, rejecting outside one.
  git?: (args: string[]) => Promise<string>;
  fetch?: typeof globalThis.fetch;
  wait?: (ms: number) => Promise<void>;
}

const NEW_ORG = 'https://github.com/account/organizations/new';

// The owner of `origin`'s GitHub repo, else of the first GitHub remote's.
async function remoteOwner(git: PickOrgDeps['git']) {
  const lines = (await git?.(['remote', '-v']).catch(() => '')) ?? '';
  const remotes = lines.split('\n').map((line) => line.split(/\s+/));
  const origin = remotes.filter(([name]) => name === 'origin');
  for (const [, url = ''] of [...origin, ...remotes]) {
    const repo = GITHUB_REMOTE.exec(url)?.[1];
    if (repo) return repo.split('/')[0]!;
  }
}

const membershipsSchema = z.array(
  z.object({
    role: z.string(),
    organization: z.object({ login: z.string() }),
  }),
);

// The orgs `token` is an admin of, or undefined when GitHub refuses it, such
// as a GITHUB_TOKEN without read:org. Its first 100 memberships are enough.
async function adminOrgs(token: string, fetch: typeof globalThis.fetch) {
  const response = await fetch(
    'https://api.github.com/user/memberships/orgs?state=active&per_page=100',
    {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
      },
    },
  );
  if (response.status === 401 || response.status === 403) return undefined;
  if (!response.ok) {
    throw new Error(
      `GitHub didn't list your orgs (HTTP ${response.status}). Retry, or pass --org <org>.`,
    );
  }
  return membershipsSchema
    .parse(await response.json())
    .filter((m) => m.role === 'admin')
    .map((m) => m.organization.login);
}

// The saved sign-in, else GITHUB_TOKEN, as long as GitHub takes it.
async function savedAdminOrgs(deps: PickOrgDeps) {
  const fetch = deps.fetch ?? globalThis.fetch;
  for (const token of [
    await readSaved(anycloudPath(deps.env, '.token')),
    deps.env.GITHUB_TOKEN?.trim(),
  ]) {
    const orgs = token ? await adminOrgs(token, fetch) : undefined;
    if (orgs) return orgs;
  }
}

/**
 * The org for `backmesh install` without `--org`. `argv` is the command as
 * given, for the error that shows it again with `--org`.
 */
export async function pickOrg(
  argv: readonly string[],
  plan: boolean,
  deps: PickOrgDeps,
): Promise<string> {
  // `--yes` asks nothing, as without a terminal.
  const ask = argv.includes('--yes') ? undefined : deps.ui.ask;
  const { print } = deps.ui;
  const owner = await remoteOwner(deps.git);
  let admins = await savedAdminOrgs(deps);
  if (ask && !admins && !plan) {
    await signInAgain(workerDeps(deps, print), deps.signInScopes)();
    admins = await savedAdminOrgs(deps);
    if (!admins) throw new Error('GitHub refused the new sign-in. Retry.');
  }
  // A personal account's repos can't use backmesh, nor an org the user
  // doesn't admin.
  const guess =
    owner &&
    (admins
      ? admins.find((a) => a.toLowerCase() === owner.toLowerCase())
      : await readOrgId(owner, deps.fetch, deps.env).then(
          () => owner,
          () => undefined,
        ));
  if (!ask) throw new UsageError(noTerminal(argv, admins, guess));
  const verb = plan ? 'Planning' : 'Installing';
  if (guess) {
    const answer = await ask(
      `${verb} for ${guess} (from this repo's remote). Continue? [Y/n]`,
    );
    if (!/^no?$/i.test(answer)) return guess;
  }
  if (!admins) {
    throw new UsageError(
      `Pass --org <org>: --plan signs in to nothing, so it can't list your GitHub orgs. Run: ${again(argv)}`,
    );
  }
  const orgs = admins.filter((o) => o !== guess);
  if (!orgs.length) {
    throw new UsageError(
      `You're an admin of no ${admins.length ? 'other ' : ''}GitHub org. backmesh runs on an org's repositories: create one at ${NEW_ORG}, or ask an org's admin to run install.`,
    );
  }
  if (orgs.length === 1) {
    const other = guess ? 'other ' : '';
    print(`${verb} for ${orgs[0]}, the only ${other}org you're an admin of.`);
    return orgs[0]!;
  }
  print("Orgs you're an admin of:");
  orgs.forEach((org, i) => print(`  ${i + 1}. ${org}`));
  for (let tries = 0; tries < 3; tries++) {
    const answer = await ask(`Which org? [1-${orgs.length}]`);
    const org = orgs[Number(answer) - 1];
    if (/^\d+$/.test(answer) && org) return org;
  }
  throw new UsageError(`No org picked. Run: ${again(argv)}`);
}

// The command again, with `--org` after `install`.
function again(argv: readonly string[], org = '<org>') {
  const at = argv.indexOf('install') + 1;
  return [
    'backmesh',
    ...argv.slice(0, at),
    '--org',
    org,
    ...argv.slice(at),
  ].join(' ');
}

function noTerminal(
  given: readonly string[],
  admins: string[] | undefined,
  guess: string | undefined,
) {
  // Without a terminal, install runs only a plan or `--yes`.
  const argv = given.some((a) => a === '--plan' || a === '--yes')
    ? given
    : [...given, '--plan'];
  const lead =
    'Pass --org: install asks which org only at a terminal, without --yes.';
  if (admins && !admins.length) {
    return `${lead} You're an admin of no GitHub org; backmesh runs on an org's repositories: create one at ${NEW_ORG}. Then run: ${again(argv)}`;
  }
  const known = admins
    ? ` You're an admin of ${admins.join(', ')}.`
    : guess
      ? ` This repo's remote is the org ${guess}'s.`
      : '';
  return `${lead}${known} Run: ${again(argv, guess ?? (admins?.length === 1 ? admins[0] : undefined))}`;
}
