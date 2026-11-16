// The GitHub sign-in anycloud needs for the control plane: `cluster create`
// (its owner and DNS name), step 6's `api access add`, and the hosted API's
// token exchange. backmesh's own device flow (`worker.ts`) mints it, so
// GitHub's consent screen names backmesh, and it's saved where the
// pinned anycloud reads it first (`resolveGitHubToken` at v0.1.72).
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { anycloudPath, readSaved } from '../anycloud/client.js';
import { GitHubError, signInScopes } from '../app/github.js';
import { signIn, signInForKey, type WorkerDeps } from './worker.js';

// The only scopes a hosted API exchanges, and what backmesh's sign-in asks
// for (`GITHUB_LOGIN_SCOPES`, `api-access-domain.ts:251-271` at v0.1.72).
const LOGIN_SCOPES = ['read:org', 'read:packages'];

/** The scopes GitHub granted a token (`signInScopes`). */
export type SignInScopes = (token: string) => Promise<string[]>;

const REJECTED = 'GitHub rejected the sign-in';

// Why the hosted API would refuse `token`, or undefined. It exchanges only
// an OAuth sign-in (`gho_`) with exactly LOGIN_SCOPES, so any other would
// fail after `cluster create` has started billing.
async function signInProblem(token: string, scopesOf: SignInScopes) {
  if (!token.startsWith('gho_')) {
    return "The GitHub sign-in isn't an OAuth token, which the control plane needs";
  }
  const scopes = await scopesOf(token).catch((error: unknown) => {
    if (error instanceof GitHubError && error.status === 401) return error;
    throw new Error("Couldn't check the GitHub sign-in with GitHub. Retry.", {
      cause: error,
    });
  });
  if (scopes instanceof GitHubError) return REJECTED;
  const exact =
    scopes.length === LOGIN_SCOPES.length &&
    LOGIN_SCOPES.every((scope) => scopes.includes(scope));
  if (!exact) {
    return `The GitHub sign-in has the scopes ${scopes.join(', ') || 'none'}, but the control plane takes only ${LOGIN_SCOPES.join(' and ')}`;
  }
}

// GitHub answered 401 for the saved sign-in: it was revoked, such as by a
// newer sign-in past GitHub's ten tokens per OAuth App, user and scopes. An
// OAuth App's token doesn't expire. `again` says what signs in again.
export const refusedSignIn = (again: string) =>
  `GitHub revoked the saved sign-in. ${again}`;

// Whether the saved sign-in, else GITHUB_TOKEN, is one the control plane
// takes. A refused GITHUB_TOKEN is a problem for the user to fix; a refused
// saved one goes, so backmesh signs in again, and `print` says why.
export async function checkSignIn(
  env: NodeJS.ProcessEnv,
  scopesOf: SignInScopes,
  print: (line: string) => void = () => undefined,
): Promise<{ signedIn: boolean; problems: string[] }> {
  const path = anycloudPath(env, '.token');
  const saved = await readSaved(path);
  const token = saved || env.GITHUB_TOKEN?.trim();
  if (!token) return { signedIn: false, problems: [] };
  const problem = await signInProblem(token, scopesOf);
  if (!problem) return { signedIn: true, problems: [] };
  if (saved) {
    if (problem === REJECTED) {
      print(
        refusedSignIn(
          env.GITHUB_TOKEN?.trim()
            ? 'Install uses GITHUB_TOKEN.'
            : 'Install signs in again.',
        ),
      );
    }
    await rm(path, { force: true });
    return checkSignIn(env, scopesOf, print);
  }
  return {
    signedIn: false,
    problems: [
      `${problem}: in CI, set GITHUB_TOKEN to a backmesh GitHub sign-in with exactly ${LOGIN_SCOPES.join(' and ')}; otherwise unset it and run install again to sign in.`,
    ],
  };
}

// Saves a new backmesh sign-in, readable only by this user, as anycloud
// keeps it. It's checked first: GitHub could grant a token more scopes than
// asked, which the hosted API would refuse after billing started.
export async function saveSignIn(
  env: NodeJS.ProcessEnv,
  token: string,
  scopesOf: SignInScopes = signInScopes,
) {
  const problem = await signInProblem(token, scopesOf);
  if (problem) {
    throw new Error(
      `${problem}. Nothing was created; report this to backmesh support.`,
    );
  }
  // A new file renamed over the old, as anycloud writes it (`writePrivate`
  // at v0.1.72): an existing file's mode doesn't carry over, and a reader
  // never sees it half written.
  const path = anycloudPath(env, '.token');
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${token}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

// A fresh sign-in, for `tokenRefresh` when the hosted API needs one and for
// `cue --sign-in`. It says so when GitHub answers 401 for the saved one; a
// working one, or one GitHub couldn't check, is replaced without a word.
export const signInAgain =
  (deps: WorkerDeps, scopesOf: SignInScopes = signInScopes) =>
  async () => {
    const saved = await readSaved(anycloudPath(deps.env, '.token'));
    const problem =
      saved && (await signInProblem(saved, scopesOf).catch(() => undefined));
    if (problem === REJECTED) {
      deps.print(refusedSignIn('backmesh signs in again.'));
    }
    await saveSignIn(deps.env, await signIn(deps), scopesOf);
  };

/**
 * A new install key from an org admin's sign-in (`signInForKey`), shared by
 * `upgrade` and `rotate-key`: the sign-in's token becomes the control
 * plane's own saved sign-in only when there's no other (the saved one, or
 * `GITHUB_TOKEN`, is the account the hosted API already knows). Returns the
 * token too, which `rotate-key` needs again to authorize revoking the old
 * install.
 */
export async function keyFrom(
  org: string,
  deps: WorkerDeps,
  env: NodeJS.ProcessEnv,
  {
    install,
    why,
    scopesOf,
    // `rotate-key`'s own call sets this: caching this machine's own
    // anycloud sign-in is a local convenience, not part of what the key
    // just minted needs to be valid, and that caller has nothing left to
    // retry with, so a failure here must not orphan the key. `upgrade`
    // leaves this unset, so a save failure still surfaces as before.
    ignoreSaveSignInError,
  }: {
    install?: string;
    why?: string;
    scopesOf?: SignInScopes;
    ignoreSaveSignInError?: boolean;
  } = {},
): Promise<{ key: string; token: string }> {
  const signed = await signInForKey(org, deps, install, why);
  const saved = await readSaved(anycloudPath(env, '.token'));
  if (!saved && !env.GITHUB_TOKEN?.trim()) {
    const save = saveSignIn(env, signed.token, scopesOf);
    await (ignoreSaveSignInError ? save.catch(() => undefined) : save);
  }
  return signed;
}
