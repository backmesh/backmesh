// The CLI's calls to backmesh.com: the install key, sign-ins and
// uninstall's cleanup. Every sign-in is GitHub's device flow (owner,
// 2026-11-12): an org admin signs in once during install, and the Worker
// mints the key, which goes straight into the release Secret and is never
// shown. When the App isn't on the org yet, install prints GitHub's App
// install link and waits (`waitForApp`).
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

// The Worker didn't answer, answered 5xx, or broke its contract.
export class WorkerUnreachable extends Error {}

const baseOf = (env: NodeJS.ProcessEnv) => env[API_URL_ENV] ?? API_URL;

async function call<T>(
  deps: WorkerDeps,
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit = {},
) {
  const host = new URL(baseOf(deps.env)).host;
  const res = await deps
    .fetch(`${baseOf(deps.env)}${path}`, {
      ...init,
      signal: AbortSignal.timeout(10_000),
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

const deviceSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  interval: z.number(),
  expires_in: z.number(),
});
// GitHub's OAuth token for the user who signed in: `read:org` for the
// Worker's admin check and `read:packages`, the scopes anycloud's hosted API
// exchanges, so the same sign-in serves both.
const githubToken = z.string().regex(/^gho_\w+$/);
const pendingSchema = z.object({
  pending: z.literal(true),
  slow_down: z.boolean().optional(),
});
const installSchema = z.union([
  z.object({
    key: z.string().regex(/^bmk_[0-9a-f]{64}$/),
    github_token: githubToken,
  }),
  pendingSchema,
]);
const signInSchema = z.union([
  z.object({ github_token: githubToken }),
  pendingSchema,
]);

// GitHub's device flow through the Worker (`/v1/installs/device`): prints
// the code, then calls `poll` with the device code every interval until it
// answers. Plain lines, no prompt: CI runs this unattended and someone enters
// the code from the job log. The device code is a credential, so it's never
// printed. `poll` answers undefined while the sign-in is pending, and
// `slow_down` or a 429 waits longer.
async function deviceFlow<T>(
  deps: WorkerDeps,
  why: string,
  poll: (deviceCode: string) => Promise<T | 'pending' | 'slow_down'>,
  // A sign-in the CLI keeps for the control plane, which asks GitHub
  // for read:packages too.
  controlPlane = false,
): Promise<T> {
  const wait =
    deps.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const device = await call(deps, '/v1/installs/device', deviceSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ control_plane: controlPlane }),
  });
  if (!device.data) throw new Error(`backmesh refused: ${device.error}`);
  const { device_code, user_code, verification_uri } = device.data;
  deps.print(
    `Sign in with GitHub ${why}: open ${verification_uri} and enter ${user_code}.`,
  );
  let interval = device.data.interval;
  const expires = Date.now() + device.data.expires_in * 1000;
  for (;;) {
    await wait(interval * 1000);
    if (Date.now() > expires) throw new Error('The sign-in code expired.');
    const answer = await poll(device_code);
    if (answer === 'slow_down') interval += 5;
    else if (answer !== 'pending') return answer;
  }
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

// A new install key from an org admin's one-time GitHub sign-in, which the
// Worker checks for the admin role, and that sign-in's token. `install`
// names the installation whose key it replaces, so the old key stops
// working. The listener doesn't start without a key, so an
// unreachable Worker stops here. `why` overrides the default prompt for a
// caller whose purpose isn't `install`'s or `upgrade`'s, such as
// `rotate-key`'s.
export function signInForKey(
  org: string,
  deps: WorkerDeps,
  install?: string,
  why = `once, as an admin of ${org}, so backmesh can connect to it`,
): Promise<{ key: string; token: string }> {
  return reaching('the GitHub sign-in', () =>
    deviceFlow(
      deps,
      why,
      async (device_code) => {
        const answer = await call(deps, '/v1/installs', installSchema, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ org, device_code, install }),
        });
        // 403: not an org admin; 400: the code expired or was denied.
        if (answer.status === 429) return 'slow_down';
        if (!answer.data) throw new Error(answer.error);
        if ('key' in answer.data) {
          return { key: answer.data.key, token: answer.data.github_token };
        }
        return answer.data.slow_down ? 'slow_down' : 'pending';
      },
      true,
    ),
  );
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
export function signIn(
  deps: WorkerDeps,
  why = 'for your backmesh installation',
): Promise<string> {
  return reaching('the GitHub sign-in', () =>
    deviceFlow(
      deps,
      why,
      async (device_code) => {
        const answer = await call(deps, '/v1/sign-in', signInSchema, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_code }),
        });
        if (answer.status === 429) return 'slow_down';
        if (!answer.data) throw new Error(answer.error);
        if ('github_token' in answer.data) return answer.data.github_token;
        return answer.data.slow_down ? 'slow_down' : 'pending';
      },
      true,
    ),
  );
}

// Uninstall's cleanup. The token is null when the App
// isn't installed on the org: nothing of backmesh's is left at GitHub.
const cleanupTokenSchema = z.object({
  token: z.string().nullable(),
  expires_at: z.string().nullable(),
  org: z.object({ id: z.number(), login: z.string() }),
});
const cleanupSchema = z.union([
  cleanupTokenSchema.extend({ cleanup_id: z.string() }),
  z.object({ pending: z.literal(true), slow_down: z.boolean().optional() }),
]);
export type Cleanup = z.infer<typeof cleanupTokenSchema> & {
  cleanup_id: string;
};

// Uninstall's one sign-in: an admin of `org` signs in, and the Worker
// answers a runners-only token for an hour and the `cleanup_id` that
// re-mints it and finishes. `key`, the install key when the listener's
// Secret is readable, has the Worker revoke that install first, so its own
// last token doesn't count as a live listener. Any refusal stops, a 429
// included: the Worker's reason says to retry later.
export function signInForCleanup(
  org: string,
  key: string | undefined,
  deps: WorkerDeps,
): Promise<Cleanup> {
  return reaching('the GitHub sign-in', () =>
    deviceFlow(
      deps,
      `as an admin of ${org}, so backmesh removes itself from ${org}`,
      async (device_code) => {
        const answer = await call(deps, '/v1/installs/cleanup', cleanupSchema, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(key && { Authorization: `Bearer ${key}` }),
          },
          body: JSON.stringify({ device_code, org }),
        });
        if (!answer.data) throw new Error(answer.error);
        if ('pending' in answer.data) {
          return answer.data.slow_down ? 'slow_down' : 'pending';
        }
        return answer.data;
      },
    ),
  );
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
const notInstalledSchema = z.object({ install_url: z.string() });
// Install's 15-second poll for an hour: an org owner clicks Install.
const APP_POLL_MS = 15_000;
const APP_POLLS = 240;

// Before the listener starts, the broker must mint a token for the org, so
// the App is installed there. Its 409 carries the install
// link, printed once; a 429 or an unreachable Worker is waited out.
export async function waitForApp(org: string, key: string, deps: WorkerDeps) {
  const wait =
    deps.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let linked = false;
  let unreachable: string | undefined;
  for (let attempt = 1; attempt <= APP_POLLS; attempt++) {
    if (attempt > 1) await wait(APP_POLL_MS);
    const answer = await call(deps, '/v1/token', tokenSchema, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
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
      deps.print(
        `An owner of ${org} installs the backmesh GitHub App: open ${link ?? 'https://github.com/apps/backmesh'} and click Install. Waiting for it.`,
      );
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
      : `The backmesh GitHub App isn't installed on ${org} after an hour. Install it and run install again.`,
  );
}
