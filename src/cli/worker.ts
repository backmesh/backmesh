// The CLI's calls to backmesh.com: the install key, sign-ins and
// uninstall's cleanup. Every sign-in is GitHub's device flow with the
// backmesh GitHub App (owner, 2026-11-19), run here against github.com: an
// org owner signs in, and the Worker checks the App's user token once and
// mints the key, which goes straight into the release Secret and is never
// shown. GitHub Apps aren't subject to an org's OAuth app policy. When the
// App isn't on the org yet, the sign-in prints GitHub's App install link
// and waits for it.
import { z } from 'zod';

export const INSTALL_KEY_ENV = 'BACKMESH_INSTALL_KEY';
// Set alongside the install key while `backmesh rotate-key` has minted a
// replacement but not yet revoked the install it's replacing; cleared once
// revoked. A rerun that finds it resumes that same rotation (the recorded
// old install) instead of starting another and orphaning this one.
export const ROTATING_FROM_ENV = 'BACKMESH_ROTATING_FROM';
export const API_URL_ENV = 'BACKMESH_API_URL';
const API_URL = 'https://api.backmesh.com';

export interface WorkerDeps {
  env: NodeJS.ProcessEnv;
  fetch: typeof globalThis.fetch;
  print: (line: string) => void;
  wait?: (ms: number) => Promise<void>;
}

export const workerDeps = (
  deps: Pick<WorkerDeps, 'env' | 'wait'> & {
    fetch?: WorkerDeps['fetch'];
  },
  print: WorkerDeps['print'],
): WorkerDeps => ({
  env: deps.env,
  fetch: deps.fetch ?? globalThis.fetch,
  print,
  wait: deps.wait,
});

// Each request to GitHub or the Worker gives up after this long: GitHub's
// token endpoint has taken 8 s and more (backmesh#31).
const REQUEST_MS = 30_000;

// The Worker didn't answer, answered 5xx, or broke its contract.
export class WorkerUnreachable extends Error {}

const baseOf = (env: NodeJS.ProcessEnv) => env[API_URL_ENV] ?? API_URL;

async function call<T>(
  deps: WorkerDeps,
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit = {},
  timeoutMs = REQUEST_MS,
) {
  const host = new URL(baseOf(deps.env)).host;
  const res = await deps
    .fetch(`${baseOf(deps.env)}${path}`, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    })
    .catch(() => {
      throw new WorkerUnreachable(`${host} didn't answer`);
    });
  const body: unknown = await res.json().catch(() => undefined);
  // The Worker's own reason, such as GitHub's refusal, when it gives one.
  const reason = z.object({ error: z.string() }).safeParse(body).data?.error;
  if (res.status >= 500) {
    const why = reason ? `: ${reason}` : '';
    throw new WorkerUnreachable(`${host} answered ${res.status}${why}`);
  }
  if (!res.ok) {
    return {
      status: res.status,
      error: reason ?? `answered ${res.status}`,
      body,
    };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new WorkerUnreachable(`${host} gave an unexpected answer`);
  }
  return { data: parsed.data };
}

// The backmesh App's client ID, which is public: the device flow needs no
// secret.
export const GITHUB_APP_CLIENT_ID = 'Iv23li6e0q0gl3GOQ9ny';
// The App's ID, the one App whose user tokens the hosted API exchanges,
// and the flag of `api create` and `api upgrade` that names it.
export const GITHUB_APP_ID = '5622376';
export const GITHUB_APPS_FLAG = '--sign-in-apps';
// A sign-in waits this long for someone to enter a code, with a fresh code
// whenever one expires: an agent's human may be away for a while.
const SIGN_IN_MS = 6 * 3_600_000;
const SIGN_IN_HOURS = SIGN_IN_MS / 3_600_000;

const deviceSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  interval: z.number(),
  expires_in: z.number(),
});
const installSchema = z.object({ key: z.string().regex(/^bmk_[0-9a-f]{64}$/) });
// GitHub's refusal, such as `device_flow_disabled`, or a poll's state.
const refusalSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});
const pollSchema = z.object({ access_token: z.string() }).or(refusalSchema);
const refused = (answer: z.infer<typeof refusalSchema>) =>
  new Error(
    `GitHub refused the sign-in: ${answer.error_description ?? answer.error}`,
  );

const sleep = (deps: WorkerDeps) =>
  deps.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

// A form POST to github.com's device flow, or undefined when GitHub didn't
// answer, answered 5xx or rate-limited it (429): the caller waits and asks
// again. Any other answer GitHub gives without a reason ends the sign-in.
async function github<T>(
  deps: WorkerDeps,
  path: string,
  form: Record<string, string>,
  schema: z.ZodType<T>,
) {
  const res = await deps
    .fetch(`https://github.com${path}`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(REQUEST_MS),
    })
    .catch(() => undefined);
  if (!res || res.status >= 500 || res.status === 429) return undefined;
  const answer = schema.safeParse(await res.json().catch(() => undefined));
  if (!answer.success) {
    throw new Error(`GitHub refused the sign-in: HTTP ${res.status}`);
  }
  return answer.data;
}

// GitHub's device flow with the backmesh App: prints the code and when it
// expires, then polls GitHub every interval until someone signs in. Plain
// lines, no prompt: CI runs this unattended and someone enters the code
// from the job log. A poll GitHub doesn't answer is asked again, a code
// that expires is replaced by a fresh one, and only a denial or
// SIGN_IN_MS without a sign-in ends it. The device code is a credential,
// so it's never printed. Answers the App's user token (`ghu_`).
async function deviceSignIn(deps: WorkerDeps, why: string): Promise<string> {
  const wait = sleep(deps);
  const deadline = Date.now() + SIGN_IN_MS;
  while (Date.now() < deadline) {
    const device = await github(
      deps,
      '/login/device/code',
      { client_id: GITHUB_APP_CLIENT_ID },
      deviceSchema.or(refusalSchema),
    );
    if (!device) {
      await wait(5_000);
      continue;
    }
    if ('error' in device) throw refused(device);
    const expires = Date.now() + device.expires_in * 1000;
    const at = new Date(expires).toISOString().slice(11, 16);
    deps.print(
      `Sign in with GitHub ${why}: open ${device.verification_uri} and enter ${device.user_code} (it expires at ${at} UTC).`,
    );
    let interval = device.interval;
    while (Date.now() < Math.min(expires, deadline)) {
      await wait(interval * 1000);
      const answer = await github(
        deps,
        '/login/oauth/access_token',
        {
          client_id: GITHUB_APP_CLIENT_ID,
          device_code: device.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        },
        pollSchema,
      );
      if (!answer) continue;
      // With the App's token expiry on, GitHub also answers a refresh token,
      // which only the App's client secret redeems: it's left unread, and an
      // expired sign-in signs in again.
      if ('access_token' in answer) return answer.access_token;
      if (answer.error === 'authorization_pending') continue;
      if (answer.error === 'slow_down') interval += 5;
      else if (answer.error === 'expired_token') break;
      else if (answer.error === 'access_denied') {
        throw new Error('The GitHub sign-in was denied.');
      } else throw refused(answer);
    }
  }
  throw new Error(
    `Nobody finished the GitHub sign-in in ${SIGN_IN_HOURS} hours. Run the command again for a new code.`,
  );
}

// The Worker's 409 when the App isn't on the org, polled every 15 seconds
// for an hour while an org owner clicks Install.
const notInstalledSchema = z.object({ install_url: z.string() });
const APP_POLL_MS = 15_000;
const APP_POLLS = 240;
const installAppLine = (org: string, link?: string) =>
  `An owner of ${org} installs the backmesh GitHub App: open ${link ?? 'https://github.com/apps/backmesh'} and click Install. Waiting for it.`;
const appMissing = (org: string) =>
  `The backmesh GitHub App isn't installed on ${org} after an hour. Install it and run install again.`;

// Tries of a sign-in's one Worker call while the Worker is unreachable or
// failing, WORKER_RETRY_MS apart: the token stays good, so a blip doesn't
// cost the sign-in.
const WORKER_TRIES = 5;
const WORKER_RETRY_MS = 10_000;

// The Worker's answer to `send`, which carries a sign-in's token. A 429
// waits and asks again; the App not yet on the org (409 app_not_installed)
// prints GitHub's install link once and asks again every APP_POLL_MS for an
// hour, with the same token. Any other refusal throws its reason.
async function withSignIn<T>(
  deps: WorkerDeps,
  org: string,
  send: () => ReturnType<typeof call<T>>,
): Promise<T> {
  const wait = sleep(deps);
  let failures = 0;
  let linked = false;
  for (let attempt = 1; attempt <= APP_POLLS; attempt++) {
    const answer = await send().catch((error: unknown) => {
      if (!(error instanceof WorkerUnreachable)) throw error;
      if (++failures >= WORKER_TRIES) throw error;
      return undefined;
    });
    if (answer?.data) return answer.data;
    const link = notInstalledSchema.safeParse(answer?.body).data?.install_url;
    if (answer?.status === 409 && link) {
      if (!linked) deps.print(installAppLine(org, link));
      linked = true;
    } else if (answer && answer.status !== 429) {
      throw new Error(answer.error);
    }
    await wait(answer ? APP_POLL_MS : WORKER_RETRY_MS);
  }
  throw new Error(appMissing(org));
}

// Names the Worker in an outage, which isn't a refusal.
async function reaching<T>(what: string, request: () => Promise<T>) {
  try {
    return await request();
  } catch (error) {
    if (!(error instanceof WorkerUnreachable)) throw error;
    throw new Error(
      `Couldn't reach backmesh.com for ${what} (${error.message}). Retry when backmesh.com is reachable.`,
      { cause: error },
    );
  }
}

// A new install key from an org owner's GitHub sign-in, which the Worker
// checks can manage the org's runners, and that sign-in's token. `install`
// names the installation whose key it replaces, so the old key stops
// working. The listener doesn't start without a key, so a Worker that stays
// unreachable stops here. `why` overrides the default prompt for a caller
// whose purpose isn't `install`'s or `upgrade`'s, such as `rotate-key`'s.
export function signInForKey(
  org: string,
  deps: WorkerDeps,
  install?: string,
  why = `once, as an owner of ${org}, so backmesh can connect to it`,
): Promise<{ key: string; token: string }> {
  return reaching('the GitHub sign-in', async () => {
    const token = await deviceSignIn(deps, why);
    const { key } = await withSignIn(deps, org, () =>
      call(deps, '/v1/installs', installSchema, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org, github_token: token, install }),
      }),
    );
    return { key, token };
  });
}

// `backmesh rotate-key`'s last step: revokes `install`
// (the old key's install ID, `oldKey.slice(4, 36)`) with the new key that
// replaced it, once the listener is confirmed to run on it. Never call this
// before that: a revoked key with nothing to replace it would strand the
// listener. `token` is the same admin sign-in `signInForKey` returned with
// the new key: the Worker checks it's still an admin of the key's org, so a
// leaked key alone can't revoke the install that just replaced it.
// `already`: the install was revoked before this call, by an earlier one
// (`rotate-key`'s resume branch tells its own unfinished rotation apart
// from a stale marker this way: see rotate-key.ts).
export function revokeKey(
  install: string,
  key: string,
  token: string,
  deps: WorkerDeps,
): Promise<{ already: boolean }> {
  return reaching('revoking the old install key', async () => {
    const answer = await call(
      deps,
      '/v1/installs/revoke',
      z.object({ revoked: z.literal(true), already: z.boolean().optional() }),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({ install, github_token: token }),
      },
    );
    if (!answer.data) {
      // `workerStatus` (as `src/listener/telemetry.ts`'s own calls carry it):
      // a 429 is worth retrying, same as the Worker being unreachable.
      throw Object.assign(
        new Error(`backmesh refused to revoke the old key: ${answer.error}`),
        { workerStatus: answer.status },
      );
    }
    return { already: answer.data.already ?? false };
  });
}

// A GitHub sign-in for the control plane alone, with no key: when the saved
// one is missing or refused and the installation already has its key.
// GitHub's device flow alone; the Worker isn't part of it.
export const signIn = (
  deps: WorkerDeps,
  why = 'for your backmesh installation',
): Promise<string> => deviceSignIn(deps, why);

// Uninstall's cleanup. The token is null when the App
// isn't installed on the org: nothing of backmesh's is left at GitHub.
// `live`: the org's other installs that got a token in the last hour, for
// an install-only cleanup, which leaves the rest of the org to them.
const cleanupTokenSchema = z.object({
  token: z.string().nullable(),
  expires_at: z.string().nullable(),
  org: z.object({ id: z.number(), login: z.string() }),
  live: z
    .array(z.object({ install: z.string(), last_token_at: z.string() }))
    .optional(),
});
// No cleanup where the App isn't installed: nothing of backmesh's is at
// GitHub to remove, and nothing for the Worker to finish.
const cleanupSchema = cleanupTokenSchema.extend({
  cleanup_id: z.string().nullable(),
});
export type Cleanup = z.infer<typeof cleanupSchema>;

// The cleanup call checks the sign-in, revokes the key and mints a token:
// up to six GitHub calls in a row at the Worker's 7 s each.
const CLEANUP_MS = 60_000;

// Uninstall's one sign-in: an owner of `org` signs in, and the Worker
// answers a runners-only token for an hour and the `cleanup_id` that
// re-mints it and finishes. `key`, the install key when the listener's
// Secret is readable, has the Worker revoke that install first, so its own
// last token doesn't count as a live listener, and asks for an install-only
// cleanup while another install of the org is live. A 429 (the client's or the
// org's hourly limit) is waited out with the same sign-in, as install's is;
// any other refusal stops.
export function signInForCleanup(
  org: string,
  key: string | undefined,
  deps: WorkerDeps,
): Promise<Cleanup> {
  return reaching('the GitHub sign-in', async () => {
    const token = await deviceSignIn(
      deps,
      `as an owner of ${org}, so backmesh removes itself from ${org}`,
    );
    return withSignIn(deps, org, async () => {
      const answer = await call(
        deps,
        '/v1/installs/cleanup',
        cleanupSchema,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(key && { Authorization: `Bearer ${key}` }),
          },
          body: JSON.stringify({
            org,
            github_token: token,
            ...(key && { install_only: true }),
          }),
        },
        CLEANUP_MS,
      );
      const live = cleanupTokenSchema.shape.live.safeParse(
        (answer.body as { live?: unknown } | undefined)?.live,
      ).data;
      if (answer.status === 409 && live?.length) {
        throw new LiveInstalls(answer.error!, live);
      }
      return answer;
    });
  });
}

// The Worker's refusal of a keyless cleanup while another install of the
// org got a token in the last hour.
export class LiveInstalls extends Error {
  constructor(
    message: string,
    readonly live: { install: string; last_token_at: string }[],
  ) {
    super(message);
  }
}

async function cleanupCall<T>(
  deps: WorkerDeps,
  path: string,
  schema: z.ZodType<T>,
  cleanupId: string,
  extra: object = {},
) {
  const answer = await reaching('the uninstall', () =>
    call(deps, path, schema, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cleanup_id: cleanupId, ...extra }),
    }),
  );
  if (!answer.data) throw new Error(answer.error);
  return answer.data;
}

// A fresh token without a second sign-in, when the first is half spent.
export const refreshCleanupToken = (cleanupId: string, deps: WorkerDeps) =>
  cleanupCall(
    deps,
    '/v1/installs/cleanup/token',
    cleanupTokenSchema,
    cleanupId,
    { install_only: true },
  );

// Uninstall's last step: the Worker removes backmesh's App from the org and
// revokes its install keys, unless another install of the org still uses it.
// `keepApp` revokes the keys only.
export const finishCleanup = (
  cleanupId: string,
  deps: WorkerDeps,
  keepApp = false,
) =>
  cleanupCall(
    deps,
    '/v1/installs/cleanup/finish',
    z.object({ removed: z.boolean(), still_used_by: z.array(z.string()) }),
    cleanupId,
    keepApp ? { keep_app: true } : {},
  );

// Whether the Worker still accepts the install key: false on its 401
// (revoked or replaced), for a new sign-in. Any other failure is left to
// `waitForApp`, which uses the key next.
export async function keyAccepted(key: string, deps: WorkerDeps) {
  const answer = await call(
    deps,
    '/v1/status',
    z.object({ org_id: z.number() }),
    { headers: { Authorization: `Bearer ${key}` } },
  ).catch(() => undefined);
  return answer?.status !== 401;
}

const tokenSchema = z.object({ org: z.object({ login: z.string() }) });

// Before the listener starts, the broker must mint a token for the org, so
// the App is installed there. Its 409 carries the install
// link, printed once; a 429 or an unreachable Worker is waited out. The
// mint says it's a check, so uninstall doesn't take it for a running
// listener's.
export async function waitForApp(org: string, key: string, deps: WorkerDeps) {
  const wait =
    deps.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let linked = false;
  let unreachable: string | undefined;
  for (let attempt = 1; attempt <= APP_POLLS; attempt++) {
    if (attempt > 1) await wait(APP_POLL_MS);
    const answer = await call(deps, '/v1/token', tokenSchema, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ purpose: 'check' }),
    }).catch((error: unknown) => {
      if (!(error instanceof WorkerUnreachable)) throw error;
      if (!unreachable) {
        deps.print(
          `Couldn't reach backmesh.com (${error.message}); waiting for it.`,
        );
      }
      unreachable = error.message;
      return undefined;
    });
    if (answer) unreachable = undefined;
    if (answer?.data) {
      if (answer.data.org.login.toLowerCase() === org.toLowerCase()) return;
      throw new Error(
        `backmesh.com minted a token for ${answer.data.org.login}, not ${org}; run install again.`,
      );
    }
    if (answer?.status === 409 && !linked) {
      linked = true;
      const link = notInstalledSchema.safeParse(answer.body).data?.install_url;
      deps.print(installAppLine(org, link));
    } else if (
      answer?.error &&
      answer.status !== 409 &&
      answer.status !== 429
    ) {
      throw new Error(
        `backmesh.com refused the install key (${answer.error}). Run \`backmesh upgrade\` to sign in again if a listener runs, then install again.`,
      );
    }
  }
  throw new Error(
    unreachable
      ? `Couldn't reach backmesh.com for an hour (${unreachable}). Run install again when it's reachable.`
      : appMissing(org),
  );
}
