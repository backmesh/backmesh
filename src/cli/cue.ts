// `backmesh cue`: warns the org's listener that a push is
// coming, so the planner starts the push's first wave, and `--cancel` drops
// that again. The repo, branch, lead and which of the two are sealed on this
// machine to the listener's keys; api.backmesh.com relays the ciphertext and
// sees the org, the GitHub user and the time.
// It never fails a push: past 3 s, or on any refusal or outage, it says why
// and exits 0, and the push's jobs start as they would without it.
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { z } from 'zod';

import { anycloudPath, readSaved } from '../anycloud/client.js';
import {
  coalesceHash,
  MAX_LEAD_S,
  MIN_LEAD_S,
  sealCue,
  CUE_FORMAT,
  CUE_FORMATS,
  type CueFormat,
  validBranch,
  validRepo,
  type PublicKey,
} from '../cue/seal.js';
import { API_URL_ENV } from './worker.js';

export const CUE_TIMEOUT_MS = 3_000;

export interface CueDeps {
  env: NodeJS.ProcessEnv;
  fetch: typeof globalThis.fetch;
  // `git` in the working directory; resolves with its trimmed stdout.
  git: (args: string[], signal: AbortSignal) => Promise<string>;
  // A device sign-in, saved where anycloud reads it (`--sign-in`).
  signIn: () => Promise<void>;
  now?: () => number;
}

export interface CueOptions {
  repo?: string;
  branch?: string;
  // Seconds until the push; required but for a cancel.
  inS?: number;
  // Drops the branch's cue instead (`--cancel`).
  cancel?: boolean;
  signIn: boolean;
}

export type CueOutcome =
  | 'sent'
  | 'coalesced'
  | 'no listener'
  | 'not signed in'
  | 'signed in'
  | 'refused'
  | 'too soon'
  | 'unavailable';

const keySchema = z.object({
  kid: z.string(),
  pub: z.string(),
  formats: z.array(z.number().int()).optional(),
});

// The format to seal for a listener's key: the newest that both this CLI
// seals and the listener opens, or undefined when there's none. A key with no
// formats is from a listener before formats (rc.6 and earlier), which opens
// format 1 only (rc.4's only for a lead of 90 s or more, its minimum).
function formatFor({ formats = [1] }: PublicKey): CueFormat | undefined {
  return CUE_FORMATS.filter((f) => formats.includes(f)).at(-1);
}
const keysSchema = z.object({
  org_id: z.number(),
  login: z.string(),
  keys: z.array(keySchema),
});
// A push's tag and salt (`coalesceHash`), random per repo and branch and
// kept 10 minutes from the first cue, the relay's limit window: the relay
// counts a tag's cues as one push and links nothing across tags.
const PUSH_MS = 600_000;
// A cue whose push time is up to 45 s later than the branch's live cue's
// (still ahead, and not pushed since) is skipped: the runners planned for
// it still wait for a push that much later, well under the 180 s idle
// window a ready cued runner gets, less the push's way to
// the listener. Any other cue is sent: an earlier one starts the runners not
// started yet sooner, and a later one moves them later.
const LATER_MS = 45_000;
// A push within this of its cue came with it, as a cue at push time: well
// under the shortest lead, MIN_LEAD_S, so a cue pushed on time isn't late.
const LATE_PUSH_S = 10;
const pushSchema = z.object({
  tag: z.string(),
  salt: z.string(),
  until: z.number(),
});
// The org's listener keys and the signed-in login, kept between runs so a
// cue needs one request; a 409 or any answer's keys refresh them, and none
// are fetched again. The pushes are kept across a refresh.
const cacheSchema = z.object({
  base: z.string(),
  org: z.string(),
  token: z.string(), // SHA-256 of the sign-in it was fetched with
  org_id: z.number(),
  login: z.string(),
  keys: z.array(keySchema),
  pushes: z.record(z.string(), pushSchema).default({}),
  // Each branch's live cue: when it was sent and its push time, while that's
  // ahead; kept apart from the tag, which goes 10 minutes after the
  // branch's first cue.
  live: z
    .record(z.string(), z.object({ sent: z.number(), eta: z.number() }))
    .default({}),
  // The last cue sent, to tell its sender next time if the push came right
  // after it.
  last: z
    .object({ repo: z.string(), branch: z.string(), at: z.number() })
    .optional(),
});
type Cache = z.infer<typeof cacheSchema>;

export const GITHUB_REMOTE =
  /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/;

// The repo and branch from git when not given.
async function target(
  opts: CueOptions,
  git: CueDeps['git'],
  signal: AbortSignal,
) {
  const quiet = (args: string[]) => git(args, signal).catch(() => '');
  const [remote, head] = await Promise.all([
    opts.repo ?? quiet(['remote', 'get-url', 'origin']),
    opts.branch ?? quiet(['rev-parse', '--abbrev-ref', 'HEAD']),
  ]);
  return {
    repo: opts.repo ?? GITHUB_REMOTE.exec(remote)?.[1],
    branch: head,
  };
}

// Whether the branch has a PR: some `refs/pull/<n>/head` at the branch's
// remote head, read with the user's own git credentials, as GitHub keeps
// each PR's head there. backmesh's sign-in can't read a private repo's PRs,
// and asking costs no new permission. A closed PR whose branch hasn't moved
// since reads as one, as does a branch at the same commit as another
// branch's PR. `?` when git can't answer in time.
const PR_CHECK_MS = 1_500;
async function prFlag(
  branch: string,
  git: CueDeps['git'],
  signal: AbortSignal,
): Promise<'y' | 'n' | '?'> {
  const refs = await git(
    ['ls-remote', 'origin', `refs/heads/${branch}`, 'refs/pull/*/head'],
    AbortSignal.any([signal, AbortSignal.timeout(PR_CHECK_MS)]),
  ).catch(() => undefined);
  if (refs === undefined) return '?';
  const lines = refs.split('\n').map((line) => line.split('\t'));
  const head = lines.find(([, ref]) => ref === `refs/heads/${branch}`)?.[0];
  return head &&
    lines.some(([sha, ref]) => sha === head && ref?.startsWith('refs/pull/'))
    ? 'y'
    : 'n';
}

// The seconds after `since` (ms) that git logged pushes of the branch to
// origin, oldest first: git logs each push to the branch's remote-tracking
// ref. The CLI doesn't see a push itself, so it reads them at the next cue.
async function pushesSince(
  branch: string,
  since: number,
  git: CueDeps['git'],
  signal: AbortSignal,
) {
  const log = await git(
    [
      'reflog',
      'show',
      '--date=unix',
      '--format=%gd%x09%gs',
      `refs/remotes/origin/${branch}`,
    ],
    signal,
  ).catch(() => '');
  const sinceS = Math.floor(since / 1000);
  return log
    .split('\n')
    .flatMap((line) => {
      const [, at, subject] = /@\{(\d+)\}\t(.*)$/.exec(line) ?? [];
      const after = Number(at) - sinceS;
      return subject?.startsWith('update by push') && after >= 0 ? [after] : [];
    })
    .reverse();
}

// The relay's own cue credential (owner, 2026-11-19): App sign-ins last 8
// hours, so cue trades one for it (`/v1/cue/sign-in`, 30 days) and sends
// GitHub nothing after. Saved beside the sign-in it was traded for.
const CREDENTIAL = 'backmesh-cue-credential';
const credentialSchema = z.object({
  credential: z.string().regex(/^bmc_[0-9a-f]{64}$/),
});

// The credential for `token`, a fresh App sign-in; undefined when the relay
// refuses that sign-in, 'no org' when it reaches none of the App's
// installations.
async function trade(
  deps: CueDeps,
  base: string,
  token: string,
  signal: AbortSignal,
) {
  const res = await deps.fetch(`${base}/v1/cue/sign-in`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  if (res.status === 401) return undefined;
  if (res.status === 403) return 'no org';
  if (!res.ok) throw new Error(`backmesh.com answered ${res.status}`);
  return credentialSchema.parse(await res.json()).credential;
}
const NO_ORG =
  "Your GitHub sign-in reaches none of the orgs backmesh's GitHub App is on, so there's no org to cue. Nothing was sent.";

export async function cue(
  opts: CueOptions,
  deps: CueDeps,
): Promise<{ outcome: CueOutcome; message: string }> {
  const done = (outcome: CueOutcome, message: string) => ({ outcome, message });
  const { inS } = opts;
  const range = `${MIN_LEAD_S} to ${MAX_LEAD_S}`;
  const given = deps.env.BACKMESH_CUE_TOKEN?.trim() || undefined;
  const base = deps.env[API_URL_ENV] ?? 'https://api.backmesh.com';
  const credentialPath = anycloudPath(deps.env, CREDENTIAL);
  // The saved sign-in traded for a credential, saved; the relay's answer
  // otherwise.
  const tradeSaved = async (signal: AbortSignal) => {
    const signedIn = await readSaved(anycloudPath(deps.env, '.token'));
    const traded = signedIn
      ? await trade(deps, base, signedIn, signal)
      : undefined;
    if (traded && traded !== 'no org') await save(credentialPath, traded);
    return traded;
  };
  // A new sign-in is traded for a new credential at once, which revokes the
  // earlier ones; one that can't be traded now is at the next cue.
  const signIn = async () => {
    await deps.signIn();
    await rm(credentialPath, { force: true });
    await tradeSaved(AbortSignal.timeout(30_000)).catch(() => undefined);
  };
  if (opts.signIn && given) {
    return done(
      'refused',
      'BACKMESH_CUE_TOKEN is set, so cue uses it and a sign-in here would go unused; unset it to sign in. Nothing was sent.',
    );
  }
  if (inS === undefined && !opts.cancel) {
    // `--sign-in` alone: just sign in and save it, as `backmesh cue
    // --sign-in` once (below) tells a signed-out user to run. Neither --in
    // nor --cancel is implied, so nothing is sent.
    if (opts.signIn) {
      await signIn();
      return done('signed in', 'Signed in. Nothing was sent.');
    }
    return done(
      'refused',
      `Pass --in <seconds>, ${range}, when you start your checks before a push, or --cancel.`,
    );
  }
  if (inS !== undefined && opts.cancel) {
    return done('refused', '--cancel takes no --in.');
  }
  if (
    inS !== undefined &&
    !(Number.isInteger(inS) && inS >= 0 && inS <= MAX_LEAD_S)
  ) {
    return done('refused', `--in takes whole seconds, up to ${MAX_LEAD_S}.`);
  }
  if (opts.signIn) await signIn();
  // A quick follow-up push (owner, 2026-11-09): nothing to start early,
  // and not a mistake, so nothing is sent, counted or cached.
  if (inS !== undefined && inS < MIN_LEAD_S) {
    return done(
      'too soon',
      `A push in under ${MIN_LEAD_S} s is too soon for runners to start early, so nothing was sent.`,
    );
  }
  // From here, at most 3 s in all.
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), CUE_TIMEOUT_MS);
  const { signal } = timeout;
  try {
    // A sandbox's agent can't finish a sign-in, so a human gives it a cue
    // credential (or a sign-in) in BACKMESH_CUE_TOKEN, sent as it is.
    // Otherwise the saved credential, else the saved sign-in traded for one.
    const fromFile = !given && (await readSaved(credentialPath));
    const token = given ?? (fromFile || (await tradeSaved(signal)));
    if (token === 'no org') return done('refused', NO_ORG);
    if (!token) {
      return done(
        'not signed in',
        'Not signed in; run `backmesh cue --sign-in` once, or set BACKMESH_CUE_TOKEN where no one can sign in. Nothing was sent.',
      );
    }
    const { repo, branch } = await target(opts, deps.git, signal);
    if (!repo || !validRepo(repo)) {
      return done(
        'refused',
        "Couldn't tell the GitHub repo from this checkout's origin remote; pass --repo owner/name.",
      );
    }
    if (branch === 'HEAD') {
      return done(
        'refused',
        opts.branch
          ? "HEAD isn't a branch name; pass --branch <branch>."
          : 'HEAD is detached, so there is no branch to cue; pass --branch <branch>.',
      );
    }
    if (!validBranch(branch)) {
      return done(
        'refused',
        "Couldn't tell the branch from this checkout; pass --branch <branch>.",
      );
    }
    const org = repo.split('/')[0]!;
    // Only this checkout's origin can say; a cancel needs no flag. Asked
    // alongside the keys and the skip check, and dropped on a skip.
    const prCheck = new AbortController();
    const pr: Promise<'y' | 'n' | '?'> =
      opts.repo || opts.cancel
        ? Promise.resolve('?')
        : prFlag(branch, deps.git, AbortSignal.any([signal, prCheck.signal]));
    const sent = (credential: string) =>
      send({
        pr,
        prCheck,
        deps,
        base,
        org,
        repo,
        branch,
        token: credential,
        given: given !== undefined,
        signal,
        opts,
      });
    const { status, ...result } = await sent(token);
    // A saved credential the relay refuses (expired or revoked), or that
    // doesn't reach the org (traded before the org's App was on it), is
    // traded again from the saved sign-in, once.
    if (!fromFile || (status !== 401 && status !== 403)) return result;
    await rm(credentialPath, { force: true });
    const fresh = await tradeSaved(signal);
    if (fresh === 'no org') return done('refused', NO_ORG);
    if (!fresh) return result;
    const { status: _, ...again } = await sent(fresh);
    return again;
  } catch (error) {
    const why = signal.aborted
      ? `no answer in ${CUE_TIMEOUT_MS / 1000} s`
      : String((error as Error).message ?? error);
    return done(
      'unavailable',
      `Couldn't reach backmesh.com (${why}); the push goes ahead as usual.`,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function send(c: {
  deps: CueDeps;
  base: string;
  org: string;
  repo: string;
  branch: string;
  pr: Promise<'y' | 'n' | '?'>;
  prCheck: AbortController;
  token: string;
  given: boolean;
  signal: AbortSignal;
  opts: CueOptions;
}): Promise<{ outcome: CueOutcome; message: string; status?: number }> {
  const { deps, base, org, repo, branch, signal } = c;
  const auth = { Authorization: `Bearer ${c.token}` };
  const tokenHash = createHash('sha256').update(c.token).digest('hex');
  const cachePath = anycloudPath(deps.env, 'backmesh-cue.json');
  const refused = (status: number, body: unknown) => {
    const error = z.object({ error: z.string() }).safeParse(body).data?.error;
    if (status >= 500) throw new Error(`backmesh.com answered ${status}`);
    // GitHub's 401 for the sign-in, directly or through the Worker. A saved
    // file stays for `--sign-in` to replace; a given token is the human's.
    if (status === 401) {
      return {
        outcome: 'not signed in' as const,
        message: c.given
          ? 'backmesh.com refused BACKMESH_CUE_TOKEN; replace it with a current backmesh cue credential. Nothing was sent.'
          : 'The saved cue credential expired or was revoked. Run `backmesh cue --sign-in` to sign in again. Nothing was sent.',
        status,
      };
    }
    return {
      outcome: 'refused' as const,
      message: `backmesh.com refused the cue (${error ?? status}).`,
      status,
    };
  };

  const saved = await readSaved(cachePath);
  let cache: Cache | undefined;
  try {
    cache = cacheSchema.safeParse(JSON.parse(saved)).data;
  } catch {
    // None yet, or unreadable: fetched again.
  }
  if (
    !cache?.keys.length ||
    cache.base !== base ||
    cache.org.toLowerCase() !== org.toLowerCase() ||
    cache.token !== tokenHash
  ) {
    const keys = await deps.fetch(
      `${base}/v1/cue/keys?org=${encodeURIComponent(org)}`,
      { headers: auth, signal },
    );
    const body: unknown = await keys.json().catch(() => undefined);
    if (!keys.ok) return refused(keys.status, body);
    cache = {
      base,
      org,
      token: tokenHash,
      ...keysSchema.parse(body),
      pushes: cache?.pushes ?? {},
      live: cache?.live ?? {},
      last: cache?.last,
    };
  }

  const { inS, cancel } = c.opts;
  const now = deps.now?.() ?? Date.now();
  const eta = cancel
    ? 'drop'
    : `in ${Math.round((now + inS! * 1000) / 30_000)}`;
  // Only this checkout's git log says when its pushes were.
  const ours = !c.opts.repo;
  const name = `${repo.toLowerCase()} ${branch}`;
  // A push since the branch's tag was made starts a new one: the relay
  // would otherwise coalesce the next push's cue with the last one's.
  const tagged = cache.pushes[name];
  const pushedSinceTag =
    ours &&
    tagged !== undefined &&
    (await pushesSince(branch, tagged.until - PUSH_MS, deps.git, signal))
      .length > 0;
  const pushes = Object.fromEntries(
    Object.entries(cache.pushes).filter(
      ([n, p]) => p.until > now && !(n === name && pushedSinceTag),
    ),
  );
  const push = (pushes[name] ??= {
    tag: randomBytes(16).toString('hex'),
    salt: randomBytes(16).toString('hex'),
    until: now + PUSH_MS,
  });
  const live = Object.fromEntries(
    Object.entries(cache.live).filter(([, l]) => l.eta > now),
  );
  cache = { ...cache, pushes, live };
  // Checked before this cue replaces it.
  const last = cache.last;
  const late =
    ours && last?.repo.toLowerCase() === repo.toLowerCase()
      ? (await pushesSince(last.branch, last.at, deps.git, signal)).find(
          (after) => after <= LATE_PUSH_S,
        )
      : undefined;
  const lateNote =
    late === undefined
      ? ''
      : `\nYour last cue on ${last!.branch} came ${late ? `${late} s` : 'under a second'} before its push, too late to start runners. Run \`backmesh cue --in <seconds>\` as its own command when you start your checks.`;
  // Said once, whatever this cue's outcome.
  if (late !== undefined) cache = { ...cache, last: undefined };
  const pushAt = cancel ? undefined : now + inS! * 1000;
  // A push since the live cue was sent took its runners.
  const held = ours ? live[name] : undefined;
  const liveCue =
    held && !(await pushesSince(branch, held.sent, deps.git, signal)).length
      ? held
      : undefined;
  if (
    pushAt !== undefined &&
    liveCue &&
    pushAt >= liveCue.eta &&
    pushAt <= liveCue.eta + LATER_MS
  ) {
    c.prCheck.abort();
    await save(cachePath, cache).catch(() => undefined);
    const inSoon = Math.round((liveCue.eta - now) / 1000);
    return {
      outcome: 'coalesced' as const,
      message: `Already cued ${repo} ${branch} for a push in about ${inSoon} s, close to this estimate, so nothing was sent.${lateNote}`,
    };
  }
  const hash = coalesceHash(push.salt, eta);
  const fields = {
    repo,
    branch,
    user: cache.login,
    kind: cancel ? ('drop' as const) : ('push' as const),
    pr: await c.pr,
    lead_s: inS ?? MAX_LEAD_S,
  };
  const what = cancel ? `the cue for ${repo} ${branch}` : `${repo} ${branch}`;
  let result: { outcome: CueOutcome; message: string } | undefined;
  // A 409 means the cached keys went with a restarted listener: reseal once.
  for (let attempt = 0; attempt < 2 && !result; attempt++) {
    const keys: PublicKey[] = cache.keys;
    if (keys.length === 0) {
      result = {
        outcome: 'no listener',
        message: `No backmesh listener for ${org} is connected; nothing was sent.`,
      };
      break;
    }
    // A listener that opens none of this CLI's formats would refuse the cue
    // unseen: say why instead, and send nothing (cue never fails a push).
    const readable = keys.flatMap((key) => {
      const format = formatFor(key);
      return format === undefined ? [] : [{ key, format }];
    });
    if (!readable.length) {
      // Fetch the keys afresh next time: the listener may be upgraded by then.
      cache = { ...cache, keys: [] };
      const newest = Math.max(...keys.flatMap((k) => k.formats ?? []));
      result = {
        outcome: 'refused',
        message:
          newest > CUE_FORMAT
            ? `Your backmesh CLI is too old for ${org}'s listener: update it. Nothing was sent.`
            : `${org}'s listener is too old for this backmesh CLI: ask its admin to run \`backmesh upgrade\`. Nothing was sent.`,
      };
      break;
    }
    const sealed = await Promise.all(
      readable.map(({ key, format }) =>
        sealCue(cache!.org_id, key, fields, now, format),
      ),
    );
    const res = await deps.fetch(`${base}/v1/cue`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ org, tag: push.tag, hash, sealed }),
      signal,
    });
    const body: unknown = await res.json().catch(() => undefined);
    const fresh = z.object({ keys: z.array(keySchema) }).safeParse(body).data;
    if (fresh) cache = { ...cache, keys: fresh.keys };
    if (res.status === 409) continue;
    if (res.status === 202) {
      result = {
        outcome: 'sent',
        message: cancel ? `Cancelled ${what}.` : `Cued ${what}.`,
      };
    } else if (res.ok) {
      result = {
        outcome: 'coalesced',
        message: cancel
          ? `Already cancelled ${what}.`
          : `Already cued ${what}.`,
      };
    } else {
      result = refused(res.status, body);
    }
  }
  if (result && ['sent', 'coalesced'].includes(result.outcome)) {
    if (pushAt === undefined) delete live[name];
    else live[name] = { sent: now, eta: pushAt };
    if (pushAt !== undefined)
      cache = { ...cache, last: { repo, branch, at: now } };
  }
  if (result && lateNote)
    result = { ...result, message: result.message + lateNote };
  // Only a shortcut: a cache that can't be written costs a request next time.
  await save(cachePath, cache).catch(() => undefined);
  return (
    result ?? {
      outcome: 'no listener' as const,
      message: `No backmesh listener for ${org} took the cue; nothing was sent.`,
    }
  );
}

// Readable only by this user, written whole.
async function save(path: string, content: Cache | string) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  const text =
    typeof content === 'string' ? `${content}\n` : JSON.stringify(content);
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, path).catch(async (error: unknown) => {
    await rm(temporary, { force: true });
    throw error;
  });
}
