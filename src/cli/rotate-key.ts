// `backmesh rotate-key --org <org>` (owner spec, 2026-11-10, simplified
// 2026-11-10): the same sign-in `upgrade` uses (GitHub's device flow)
// proves an admin of `org`, mints a new
// install key and writes it into the listener's Secret the same way
// `upgrade` does (`rollListener`, converge.ts), confirms the listener runs on it, then revokes the old key.
//
// Rerun-safe: the Secret also carries `rotatingFrom` (`ROTATING_FROM_ENV`,
// worker.ts) alongside the new key while a rotation is unfinished, naming
// the old install to revoke. The CLI itself keeps no state between runs, so
// a rerun after any partial failure (sign-in, the roll, confirming it, or
// the revoke) reads this marker and resumes the same rotation, rather than
// mis-identifying whichever key is currently live as "the old one". It
// mints a second key only if the roll that would carry the first one's
// marker to the listener never takes effect at all (the listener's own
// environment never shows it, so a rerun can't find it either); the first
// key is then orphaned, unused and unrevoked, never wrongly live. The
// marker is cleared once the recorded install is revoked, by a real roll
// (not just a Secret save), so the listener's own environment drops it
// immediately rather than only on some later, unrelated restart.
//
// Before that fix, the marker lived in the Secret a beat before the
// listener's own environment (read by `exec`) showed it was gone, since a
// Pod only picks up a Secret change on its own restart. A rerun in that
// window saw a stale marker; the Worker tells that apart from a fresh
// revoke (`already: true`), so the resume branch treats "already" as that
// rotation having already finished, and starts a new one from the key
// actually running, instead of reporting success without having rotated
// anything.
//
// Every failure past the precondition checks below (no listener, no key
// yet, before VM Jobs — each its own message) is one of exactly two:
// sign-in, roll or confirm didn't finish, or a confirmed roll's revoke
// didn't.
import type { RunAnycloud } from '../anycloud/binary.js';
import type { anycloudApi } from '../anycloud/client.js';
import { anycloudControl } from '../app/anycloud.js';
import {
  API_URL_ENV,
  workerDeps,
  revokeKey,
  signIn,
  WorkerUnreachable,
  type WorkerDeps,
} from './worker.js';
import { rollListener } from './converge.js';
import { UsageError } from './errors.js';
import { keyFrom, type SignInScopes } from './github-sign-in.js';
import {
  clusterIdOf,
  listenerName,
  readControlPool,
  readOrgId,
} from './installation.js';
import { hostedApi } from './prerequisites.js';
import { readListener } from './status.js';

export interface RotateKeyDeps {
  env: NodeJS.ProcessEnv;
  run: RunAnycloud;
  // For the listener's roll (`deployment upgrade --wait`).
  runLong: RunAnycloud;
  print: (line: string) => void;
  fetch?: typeof globalThis.fetch;
  wait?: (ms: number) => Promise<void>;
  signInScopes?: SignInScopes;
  api?: typeof anycloudApi;
}

export interface RotateKeyOptions {
  org: string;
}

// The confirming read and the revoke call both retry a few times before
// giving up: a listener can take a moment to restart, and a single Worker
// hiccup shouldn't strand a key that's still safe to use.
const RETRY_ATTEMPTS = 3;
const RETRY_WAIT_MS = 5_000;

// Whether `word` (a message's first word) is the org's own name (its
// actual case, e.g. a login like `Acme`, not an ordinary capital), an
// acronym (`URL`, two or more capitals, all upper), a domain or path-like
// token (`api.backmesh.com`, a dot or slash), or a proper noun with an
// internal capital (`GitHub`) — cases where lowercasing the first letter
// would be wrong, unlike an ordinary sentence-initial capital (`The`,
// `Couldn't`, or a lone capitalized word like `A`).
const keepsCase = (word: string, org: string): boolean =>
  word.toLowerCase().startsWith(org.toLowerCase()) ||
  /[./]/.test(word) ||
  (word === word.toUpperCase() && (word.match(/[A-Z]/g)?.length ?? 0) >= 2) ||
  /[A-Z]/.test(word.slice(1));

// `reaching` (worker.ts) wraps an unreachable Worker with its own "Retry
// when backmesh.com is reachable" sentence, which doesn't fit inside this
// command's own instruction to rerun; its `cause` is the bare detail
// instead. A plain refusal has no cause, so its own message is used as is.
// Embedded after a colon, mid-sentence, so one trailing period is dropped
// and an ordinary sentence-initial capital is lowered to match — unless
// it's the org's own name, which rollListener's own messages start with.
export const reason = (error: unknown, org: string): string => {
  const message =
    error instanceof Error
      ? error.cause instanceof WorkerUnreachable
        ? error.cause.message
        : error.message
      : String(error);
  const trimmed = message.replace(/\.$/, '');
  const spaceAt = trimmed.indexOf(' ');
  const firstWord = spaceAt === -1 ? trimmed : trimmed.slice(0, spaceAt);
  return keepsCase(firstWord, org)
    ? trimmed
    : trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
};

export async function rotateKey(
  deps: RotateKeyDeps,
  { org }: RotateKeyOptions,
) {
  const { print } = deps;
  const wait =
    deps.wait ??
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const { url, api } = await hostedApi(deps, print);
  clusterIdOf(url);
  const name = listenerName(org);
  const { listeners } = await readControlPool(api);
  const listener = listeners.find((l) => l.name === name);
  if (!listener) {
    throw new UsageError(
      `There's no listener for ${org} on ${url}; run \`backmesh install\`.`,
    );
  }
  const running = await readListener(deps.run, name).catch(() => undefined);
  if (!running) {
    throw new Error(
      `${org}'s listener didn't answer, so rotate-key can't read its install key. Run \`backmesh status\`, then try again.`,
    );
  }
  const currentKey = running.installKey;
  if (!currentKey) {
    throw new UsageError(
      `${org}'s installation has no install key yet; run \`backmesh upgrade\` to sign in with GitHub first.`,
    );
  }
  const { runnerImage, runners } = running;
  if (!runnerImage || !runners) {
    throw new UsageError(
      `${org}'s listener is from before backmesh's install key or VM Jobs; run \`backmesh upgrade\` first, then rotate-key.`,
    );
  }
  const worker: WorkerDeps = workerDeps(deps, print);
  const orgId = running.orgId || (await readOrgId(org, deps.fetch, deps.env));
  const control = anycloudControl(api, deps.run);
  const base = {
    name,
    org,
    orgId,
    image: listener.image,
    runnerImage,
    runners,
    cacheCapGb: running.cacheCapGb,
    apiUrl: deps.env[API_URL_ENV],
  };

  const rotationFailed = (cause: unknown) =>
    new Error(
      `Rotation didn't finish: ${reason(cause, org)}. ${org}'s old key still works; run \`backmesh rotate-key --org ${org}\` again.`,
      { cause },
    );

  // One rotation attempt: resuming `resume` (an old install already mid
  // rotation) if given, else minting a fresh one from `currentKey`.
  const attempt = async (resume: string | undefined) => {
    if (resume) {
      // This listener's own environment already shows the key a prior run
      // minted and rolled, so only the revoke is left. Only a token is
      // needed for that, never another key: signing in again for this
      // install would replace a key that's already correctly deployed.
      print(
        `Signing in as an admin of ${org} to finish rotating its install key.`,
      );
      const token = await signIn(
        worker,
        `as an admin of ${org}, to finish rotating its install key`,
      );
      return { newKey: currentKey, oldInstall: resume, token };
    }
    // A key is `bmk_`, the 32-hex install ID, then 32 random hex.
    const oldInstall = currentKey.slice(4, 36);
    print(`Signing in as an admin of ${org} to mint a new install key.`);
    // Never the old key's install ID: a fresh install, so the old key
    // keeps working until it's explicitly revoked below.
    const signed = await keyFrom(org, worker, deps.env, {
      why: `as an admin of ${org}, to replace its install key`,
      scopesOf: deps.signInScopes,
      ignoreSaveSignInError: true,
    });
    print(`Rolling ${org}'s listener onto the new key.`);
    await rollListener(
      base,
      { ...base, installKey: signed.key, rotatingFrom: oldInstall },
      { control, runLong: deps.runLong },
    );
    // Confirmed from the listener's own environment, read fresh, not
    // merely that the roll command exited: the old key is revoked only
    // once the listener itself is on the new one. A single failed or
    // stale read can be a slow restart, so this retries first.
    let confirmed: Awaited<ReturnType<typeof readListener>> | undefined;
    for (let i = 0; i < RETRY_ATTEMPTS; i++) {
      if (i > 0) await wait(RETRY_WAIT_MS);
      confirmed = await readListener(deps.run, name).catch(() => undefined);
      if (
        confirmed?.installKey === signed.key &&
        confirmed.rotatingFrom === oldInstall
      ) {
        break;
      }
    }
    if (
      confirmed?.installKey !== signed.key ||
      confirmed.rotatingFrom !== oldInstall
    ) {
      throw new Error("the listener didn't come up on the new key");
    }
    return { newKey: signed.key, oldInstall, token: signed.token };
  };

  // Revokes `oldInstall`, retrying only a reachability failure; throws
  // message (b) if it never succeeds. Answers whether the Worker had
  // already revoked it (a stale resume, not a fresh revoke).
  const revoke = async (oldInstall: string, newKey: string, token: string) => {
    print(`${org}'s listener runs on the new key; revoking the old install.`);
    let error: unknown;
    for (let i = 0; i < RETRY_ATTEMPTS; i++) {
      if (i > 0) await wait(RETRY_WAIT_MS);
      const outcome = await revokeKey(oldInstall, newKey, token, worker).then(
        (r) => ({ ok: true as const, already: r.already }),
        (e: unknown) => ({ ok: false as const, error: e }),
      );
      if (outcome.ok) return outcome.already;
      error = outcome.error;
      const retryable =
        error instanceof Error &&
        (error.cause instanceof WorkerUnreachable ||
          (error as Error & { workerStatus?: number }).workerStatus === 429);
      if (!retryable) break;
    }
    throw new Error(
      `${org}'s listener is on the new key, but the old key wasn't revoked: ${reason(error, org)}. Run \`backmesh rotate-key --org ${org}\` again to finish.`,
      { cause: error },
    );
  };

  let { newKey, oldInstall, token } = await attempt(running.rotatingFrom).catch(
    (cause: unknown) => {
      throw rotationFailed(cause);
    },
  );
  const already = await revoke(oldInstall, newKey, token);
  if (already && running.rotatingFrom) {
    // The resumed rotation had already finished in an earlier run: the
    // marker was only stale, left behind because the Pod hadn't restarted
    // since that run cleared it. Start a fresh rotation from the key
    // actually running now, instead of reporting success having rotated
    // nothing.
    print(`${org}'s last key rotation finished; starting a new one.`);
    ({ newKey, oldInstall, token } = await attempt(undefined).catch(
      (cause: unknown) => {
        throw rotationFailed(cause);
      },
    ));
    await revoke(oldInstall, newKey, token);
  }
  // Clears the marker with a real roll, not just a Secret save, so the
  // listener's own environment drops it immediately: the one place a
  // rerun (or `upgrade`, which carries the marker through unexamined)
  // reads it from. The revoke above already succeeded, so this rotation
  // is done either way; a failed clearing roll leaves a stale marker for
  // a rerun to find, which the `already` path above already handles, so
  // it's silent rather than reported as part of this rotation's outcome.
  await rollListener(
    base,
    { ...base, installKey: newKey },
    { control, runLong: deps.runLong },
  ).catch(() => {});
  return { org };
}
