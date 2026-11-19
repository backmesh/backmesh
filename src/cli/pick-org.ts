// `backmesh install` without `--org` (owner, 2026-11-13): this repo's
// GitHub remote's org, confirmed, else one of the user's orgs backmesh's
// GitHub App is on, from their GitHub sign-in: an App user token lists no
// memberships without the Members permission, which the App doesn't ask
// for, only the App's installations the user reaches. Without a terminal nothing prompts: the error names
// the orgs and the command to run. `--plan` signs in to nothing, so it lists
// orgs only with a saved sign-in.
import { z } from 'zod';

import { anycloudPath, readSaved } from '../anycloud/client.js';
import { signInAgain, type SignInCheck } from './github-sign-in.js';
import { GITHUB_REMOTE } from './cue.js';
import { UsageError } from './errors.js';
import type { InstallUi } from './install.js';
import { readOrgId } from './installation.js';
import { workerDeps } from './worker.js';

export interface PickOrgDeps {
  env: NodeJS.ProcessEnv;
  ui: InstallUi;
  signInCheck: SignInCheck;
  // This checkout's `git`, rejecting outside one.
  git?: (args: string[]) => Promise<string>;
  fetch?: typeof globalThis.fetch;
  wait?: (ms: number) => Promise<void>;
}

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

const installationsSchema = z.object({
  installations: z.array(
    z.object({
      account: z.object({ login: z.string(), type: z.string() }).nullable(),
    }),
  ),
});

// The orgs whose installation of the App `token` reaches, or undefined when
// GitHub refuses it. Its first 100 are enough.
async function appOrgs(token: string, fetch: typeof globalThis.fetch) {
  const response = await fetch(
    'https://api.github.com/user/installations?per_page=100',
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
  return installationsSchema
    .parse(await response.json())
    .installations.flatMap(({ account }) =>
      account?.type === 'Organization' ? [account.login] : [],
    );
}

// The saved sign-in, else GITHUB_TOKEN, as long as GitHub takes it.
async function savedAppOrgs(deps: PickOrgDeps) {
  const fetch = deps.fetch ?? globalThis.fetch;
  for (const token of [
    await readSaved(anycloudPath(deps.env, '.token')),
    deps.env.GITHUB_TOKEN?.trim(),
  ]) {
    const orgs = token ? await appOrgs(token, fetch) : undefined;
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
  let mine = await savedAppOrgs(deps);
  if (ask && !mine && !plan) {
    await signInAgain(workerDeps(deps, print), deps.signInCheck)();
    mine = await savedAppOrgs(deps);
    if (!mine) throw new Error('GitHub refused the new sign-in. Retry.');
  }
  // A personal account's repos can't use backmesh. The org's owner needn't
  // have the App on it yet: install's sign-in checks they can manage its
  // runners.
  const guess =
    owner &&
    (mine?.find((o) => o.toLowerCase() === owner.toLowerCase()) ??
      (await readOrgId(owner, deps.fetch, deps.env).then(
        () => owner,
        () => undefined,
      )));
  if (!ask) throw new UsageError(noTerminal(argv, mine, guess));
  const verb = plan ? 'Planning' : 'Installing';
  if (guess) {
    const answer = await ask(
      `${verb} for ${guess} (from this repo's remote). Continue? [Y/n]`,
    );
    if (!/^no?$/i.test(answer)) return guess;
  }
  if (!mine) {
    throw new UsageError(
      `Pass --org <org>: --plan signs in to nothing, so it can't list your GitHub orgs. Run: ${again(argv)}`,
    );
  }
  const orgs = mine.filter((o) => o !== guess);
  const other = guess ? 'other ' : '';
  if (!orgs.length) {
    throw new UsageError(
      `backmesh's GitHub App is on none of your ${other}orgs, so install can't list them. Name the org: ${again(argv)}`,
    );
  }
  if (orgs.length === 1) {
    print(
      `${verb} for ${orgs[0]}, the only ${other}org of yours backmesh's GitHub App is on.`,
    );
    return orgs[0]!;
  }
  print("Your orgs backmesh's GitHub App is on:");
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
  mine: string[] | undefined,
  guess: string | undefined,
) {
  // Without a terminal, install runs only a plan or `--yes`.
  const argv = given.some((a) => a === '--plan' || a === '--yes')
    ? given
    : [...given, '--plan'];
  const lead =
    'Pass --org: install asks which org only at a terminal, without --yes.';
  const known = mine
    ? mine.length
      ? ` backmesh's GitHub App is on your orgs ${mine.join(', ')}.`
      : " backmesh's GitHub App is on none of your orgs yet."
    : guess
      ? ` This repo's remote is the org ${guess}'s.`
      : '';
  return `${lead}${known} Run: ${again(argv, guess ?? (mine?.length === 1 ? mine[0] : undefined))}`;
}
