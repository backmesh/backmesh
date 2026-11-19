// The GitHub sign-in anycloud needs for the control plane: `cluster create`
// (its owner and DNS name), step 6's `api access add`, and the hosted API's
// token exchange. backmesh's own device flow (`worker.ts`) makes it with the
// backmesh GitHub App, so GitHub's consent screen names backmesh, and it's
// saved where the pinned anycloud reads it first (`resolveGitHubToken` at
// v0.1.72).
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { anycloudPath, readSaved } from '../anycloud/client.js';
import { GitHubError, signInCheck } from '../app/github.js';
import {
  GITHUB_APP_ID,
  signIn,
  signInForKey,
  type WorkerDeps,
} from './worker.js';

/** A sign-in's user, and the Apps it reaches (`signInCheck`). */
export type SignInCheck = (
  token: string,
) => Promise<{ login: string; appIds: number[] }>;

const REJECTED = 'GitHub rejected the sign-in';

// Why the hosted API would refuse `token`, or undefined. It exchanges only
// the backmesh App's user token (`ghu_`, its `--sign-in-apps` list), so any
// other would fail after `cluster create` has started billing. Another
// App's sign-in reaches only that App's installations; one that reaches
// none yet can't be told apart, and the hosted API refuses it at its first
// request.
async function signInProblem(token: string, checkOf: SignInCheck) {
  if (!token.startsWith('ghu_')) {
    return "The GitHub sign-in isn't backmesh's (a GitHub App sign-in), which the control plane needs";
  }
  const who = await checkOf(token).catch((error: unknown) => {
    if (error instanceof GitHubError && error.status === 401) return REJECTED;
    throw new Error("Couldn't check the GitHub sign-in with GitHub. Retry.", {
      cause: error,
    });
  });
  if (typeof who === 'string') return who;
  if (who.appIds.some((id) => String(id) !== GITHUB_APP_ID)) {
    return "The GitHub sign-in is another GitHub App's, which the control plane refuses";
  }
}

// GitHub answered 401 for the saved sign-in: it expired (the backmesh App's
// user tokens last 8 hours; the control plane's own API token outlives it),
// or it was revoked, such as by a newer sign-in past GitHub's ten tokens per
// App and user. `again` says what signs in again.
export const refusedSignIn = (again: string) =>
  `The saved GitHub sign-in expired or was revoked. ${again}`;

// Whether the saved sign-in, else GITHUB_TOKEN, is one the control plane
// takes. A refused GITHUB_TOKEN is a problem for the user to fix; a refused
// saved one goes, so backmesh signs in again, and `print` says why.
export async function checkSignIn(
  env: NodeJS.ProcessEnv,
  checkOf: SignInCheck,
  print: (line: string) => void = () => undefined,
): Promise<{ signedIn: boolean; problems: string[] }> {
  const path = anycloudPath(env, '.token');
  const saved = await readSaved(path);
  const token = saved || env.GITHUB_TOKEN?.trim();
  if (!token) return { signedIn: false, problems: [] };
  const problem = await signInProblem(token, checkOf);
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
    return checkSignIn(env, checkOf, print);
  }
  return {
    signedIn: false,
    problems: [
      `${problem}: a backmesh sign-in lasts 8 hours, so in CI set GITHUB_TOKEN to one made within that time (\`backmesh cue --sign-in\` saves one to ~/.backmesh/anycloud/.token); otherwise unset it and run install again to sign in.`,
    ],
  };
}

// Saves a new backmesh sign-in, readable only by this user, as anycloud
// keeps it. It's checked first, so the hosted API can't refuse it after
// billing started.
export async function saveSignIn(
  env: NodeJS.ProcessEnv,
  token: string,
  checkOf: SignInCheck = signInCheck,
) {
  const problem = await signInProblem(token, checkOf);
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
  (deps: WorkerDeps, checkOf: SignInCheck = signInCheck) =>
  async () => {
    const saved = await readSaved(anycloudPath(deps.env, '.token'));
    const problem =
      saved && (await signInProblem(saved, checkOf).catch(() => undefined));
    if (problem === REJECTED) {
      deps.print(refusedSignIn('backmesh signs in again.'));
    }
    await saveSignIn(deps.env, await signIn(deps), checkOf);
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
    checkOf,
    // `rotate-key`'s own call sets this: caching this machine's own
    // anycloud sign-in is a local convenience, not part of what the key
    // just minted needs to be valid, and that caller has nothing left to
    // retry with, so a failure here must not orphan the key. `upgrade`
    // leaves this unset, so a save failure still surfaces as before.
    ignoreSaveSignInError,
  }: {
    install?: string;
    why?: string;
    checkOf?: SignInCheck;
    ignoreSaveSignInError?: boolean;
  } = {},
): Promise<{ key: string; token: string }> {
  const signed = await signInForKey(org, deps, install, why);
  const saved = await readSaved(anycloudPath(env, '.token'));
  if (!saved && !env.GITHUB_TOKEN?.trim()) {
    const save = saveSignIn(env, signed.token, checkOf);
    await (ignoreSaveSignInError ? save.catch(() => undefined) : save);
  }
  return signed;
}
