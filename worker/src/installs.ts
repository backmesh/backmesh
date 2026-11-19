// Install keys (owner, 2026-11-06). Every backmesh sign-in is GitHub's
// device flow with the backmesh App, which the CLI runs against github.com
// (owner, 2026-11-19); the Worker gets the App's user token once, checks
// its holder can manage the org's self-hosted runners, and mints a key
// bound to the org and install. The token is never stored or logged.
// The CLI stores the key in the listener's Secret; nobody copies it. Only
// its SHA-256 is stored here.
import {
  gitHub,
  GitHubError,
  installationOf,
  installUrl,
  randomHex,
} from './app.js';
import type { D1Database, Env } from './index.js';

export const sha256 = async (text: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');

// A key is `bmk_` + the install ID + 32 random hex digits. Minting for an
// install the org already has replaces its key, so the old one stops working
// (owner, 2026-11-06). A disowned or revoked install stays so; signing in
// for it starts a new install.
export async function mintKey(
  db: D1Database,
  org: number,
  previous?: string,
  now = Date.now(),
) {
  const known =
    previous &&
    (await db
      .prepare(
        'SELECT id FROM installs WHERE id = ? AND org = ? AND disowned = 0 AND revoked = 0',
      )
      .bind(previous, org)
      .first<{ id: string }>());
  const install = known ? known.id : randomHex();
  const key = `bmk_${install}${randomHex()}`;
  await db
    .prepare(
      `INSERT INTO installs (id, org, key_hash, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (id)
       DO UPDATE SET key_hash = ?3`,
    )
    .bind(install, org, await sha256(key), now)
    .run();
  return { install, key };
}

// The install a request's `Authorization: Bearer <key>` names, unless it's
// missing, unknown or replaced; callers refuse a revoked one. The hashes
// compare in constant time.
export async function keyInstall(env: Env, request: Request) {
  const key = request.headers
    .get('Authorization')
    ?.match(/^Bearer (bmk_([0-9a-f]{32})[0-9a-f]{32})$/);
  if (!key) return null;
  const row = await env.DB.prepare(
    'SELECT id, org, key_hash, revoked FROM installs WHERE id = ?',
  )
    .bind(key[2])
    .first<{ id: string; org: number; key_hash: string; revoked: number }>();
  const hash = await sha256(key[1]!);
  let diff = row ? 0 : 1;
  for (let i = 0; i < hash.length; i++) {
    diff |= hash.charCodeAt(i) ^ (row?.key_hash.charCodeAt(i) ?? 0);
  }
  return row && diff === 0
    ? { id: row.id, org: row.org, revoked: row.revoked === 1 }
    : null;
}

// GitHub's answer to the App user token `token` for `path`.
export const asUser = (token: string, path: string) =>
  gitHub(path, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'backmesh',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

// A sign-in the Worker can't use: GitHub refused the token (401), or the
// org's SAML SSO hasn't authorized it (403).
export class SignInRefused extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403,
  ) {
    super(message);
  }
}

// What v0.4.3 and earlier CLIs get at their first step, the device code
// they asked the Worker for (`/v1/installs/device`, `/v1/sign-in`).
export const oldSignIn = () =>
  Response.json(
    {
      error:
        'This backmesh CLI signs in the way backmesh.com no longer takes. Update backmesh (https://backmesh.com/upgrade/) and run the command again.',
    },
    { status: 400 },
  );

// GitHub's 403 when the App user token can't read what the App could: the
// person lacks the right, or the App isn't on the org. A non-member may get
// a 404.
const NOT_ACCESSIBLE = 'Resource not accessible by integration';

// Throws for a refused sign-in: GitHub's 401, or a 403 asking for the org's
// SAML SSO.
function refusedSignIn(res: Response, org: string) {
  if (res.status === 401) {
    throw new SignInRefused('GitHub refused the sign-in; sign in again.', 401);
  }
  if (res.status === 403 && res.headers.has('X-GitHub-SSO')) {
    throw new SignInRefused(
      `Authorize the backmesh sign-in for ${org}'s SAML SSO on GitHub, then sign in again.`,
      403,
    );
  }
}

// GitHub failing `path` for another reason than the sign-in, such as a rate
// limit or a suspended installation, with its own message.
async function gitHubFailed(res: Response, path: string) {
  const { message } = (await res.json().catch(() => ({}))) as {
    message?: string;
  };
  return new GitHubError(
    `GitHub ${path}: ${res.status}${message ? ` ${message}` : ''}`,
  );
}

// Who `token` (an App user token) belongs to, the org's ID and current
// login, and whether they can manage the org's self-hosted runners: GitHub
// lists the org's runner groups to a user token only when both the App
// (its Self-hosted runners permission) and the person can: an owner, or a
// member with a role that manages runners, not a plain member. Where the
// App isn't installed GitHub refuses everyone the same way, so that's told
// apart. Any other refusal, such as a rate limit, is GitHub's to report.
// null: no such org. Remembers the org's login, which finds its
// installation. The token is used here and not stored.
export async function runnersAdmin(env: Env, token: string, org: string) {
  const orgPath = `/orgs/${encodeURIComponent(org)}`;
  const [user, found] = await Promise.all([
    asUser(token, '/user'),
    asUser(token, orgPath),
  ]);
  refusedSignIn(user, org);
  refusedSignIn(found, org);
  if (found.status === 404) return null;
  if (!user.ok) throw await gitHubFailed(user, '/user');
  if (!found.ok) throw await gitHubFailed(found, orgPath);
  const { login: who } = (await user.json()) as { login: string };
  const { id, login } = (await found.json()) as { id: number; login: string };
  await rememberLogin(env, id, login);
  const groupsPath = `/orgs/${encodeURIComponent(login)}/actions/runner-groups`;
  const groups = await asUser(token, `${groupsPath}?per_page=1`);
  refusedSignIn(groups, login);
  let can: 'manage' | 'refused' | 'app_not_installed' = 'manage';
  if (!groups.ok) {
    const { message } = (await groups
      .clone()
      .json()
      .catch(() => ({}))) as { message?: string };
    const refused =
      groups.status === 404 ||
      (groups.status === 403 && message === NOT_ACCESSIBLE);
    if (!refused) {
      throw await gitHubFailed(groups, groupsPath);
    }
    can = (await installationOf(env, id)) ? 'refused' : 'app_not_installed';
  }
  return { id, login, user: who, can };
}

// What a refused `runnersAdmin` answers: the App's install link while it
// isn't on the org, else 403 with `doing` (what needed the right).
export function notRunnersAdmin(
  env: Env,
  org: string,
  admin: Awaited<ReturnType<typeof runnersAdmin>>,
  doing: string,
) {
  if (admin?.can === 'app_not_installed') {
    return Response.json(
      { error: 'app_not_installed', install_url: installUrl(env, admin.id) },
      { status: 409 },
    );
  }
  const name = admin?.login ?? org;
  const error = `${doing} needs the right to manage its self-hosted runners: sign in as an owner of ${name}, or a member who manages its self-hosted runners.`;
  return Response.json({ error }, { status: 403 });
}

// Revokes every cue credential (`cue.ts`) bound to the org: rotate-key and
// uninstall end them with the install.
export const forgetCueCredentials = (env: Env, org: number) =>
  env.DB.prepare(
    `DELETE FROM cue_credentials WHERE hash IN (SELECT c.hash FROM
     cue_credentials c, json_each(c.orgs) o WHERE json_extract(o.value, '$.id') = ?)`,
  )
    .bind(org)
    .run();

// The login finds the org's App installation (app.ts).
export const rememberLogin = (env: Env, id: number, login: string) =>
  env.DB.prepare(
    'INSERT INTO orgs (id, login) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET login = excluded.login',
  )
    .bind(id, login)
    .run();

// The JSON body of a sign-in call, or a Response refusing a missing field.
export async function signInBody(request: Request, fields: string[]) {
  const body = ((await request.json().catch(() => null)) ?? {}) as Record<
    string,
    unknown
  >;
  const missing = fields.filter((f) => typeof body[f] !== 'string' || !body[f]);
  if (missing.length) {
    const error = `${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} required`;
    return Response.json({ error }, { status: 400 });
  }
  return body as Record<string, string | undefined>;
}

// POST /v1/installs { org, github_token, install? }: a key, when the
// token's holder can manage the org's runners. `install`, the install's ID
// when signing in again, gets a new key.
export async function createInstall(request: Request, env: Env) {
  const body = await signInBody(request, ['org', 'github_token']);
  if (body instanceof Response) return body;
  const { org, github_token, install } = body as {
    org: string;
    github_token: string;
    install?: unknown;
  };
  const admin = await runnersAdmin(env, github_token, org);
  if (admin?.can !== 'manage') {
    return notRunnersAdmin(
      env,
      org,
      admin,
      `Creating a backmesh install for ${admin?.login ?? org}`,
    );
  }
  const previous = typeof install === 'string' ? install : undefined;
  return Response.json({
    org_id: admin.id,
    org: admin.login,
    ...(await mintKey(env.DB, admin.id, previous)),
  });
}

// POST /v1/installs/revoke { install, github_token }, with another of the
// org's install keys as the bearer (`backmesh rotate-key`'s last step, once
// the new key's listener is confirmed). An install
// key alone isn't enough (a leaked key could otherwise revoke the fresh one
// rotate-key just minted): `github_token` must be the same admin sign-in
// `signInForKey` returned with the bearer key, checked fresh against GitHub,
// same as `createInstall`. The bearer can't revoke its own install:
// `rotate-key` mints a fresh one first, precisely so the old one stays live
// until this call.
export async function revokeInstall(
  request: Request,
  env: Env,
  bearer: { id: string; org: number },
) {
  const { install, github_token } = (await request
    .json()
    .catch(() => ({}))) as {
    install?: unknown;
    github_token?: unknown;
  };
  if (typeof install !== 'string' || !/^[0-9a-f]{32}$/.test(install)) {
    return Response.json(
      { error: 'install must be an install ID' },
      {
        status: 400,
      },
    );
  }
  if (typeof github_token !== 'string' || !github_token) {
    return Response.json(
      { error: 'github_token is required' },
      {
        status: 400,
      },
    );
  }
  if (install === bearer.id) {
    return Response.json(
      { error: "An install key can't revoke its own install." },
      { status: 403 },
    );
  }
  const org = await env.DB.prepare('SELECT login FROM orgs WHERE id = ?')
    .bind(bearer.org)
    .first<{ login: string }>();
  if (!org?.login) {
    return Response.json(
      { error: "This org's login isn't known yet; sign in again." },
      { status: 403 },
    );
  }
  const admin = await runnersAdmin(env, github_token, org.login);
  if (admin?.can !== 'manage' || admin.id !== bearer.org) {
    const error = `Revoking an install needs the right to manage ${org.login}'s self-hosted runners.`;
    return Response.json({ error }, { status: 403 });
  }
  const row = await env.DB.prepare(
    'SELECT org, revoked FROM installs WHERE id = ?',
  )
    .bind(install)
    .first<{ org: number; revoked: number }>();
  if (!row || row.org !== bearer.org) {
    return Response.json(
      { error: 'That install belongs to another org.' },
      { status: 403 },
    );
  }
  // Already revoked: a rerun of whatever revoked it the first time, not a
  // fresh one. The caller (`rotate-key`'s resume branch) tells its own
  // marker apart from a stale one this way, rather than from `revoked`
  // alone, which is also true the instant this call below finishes.
  if (row.revoked) {
    return Response.json({ revoked: true, already: true });
  }
  await env.DB.prepare('UPDATE installs SET revoked = 1 WHERE id = ?')
    .bind(install)
    .run();
  await forgetCueCredentials(env, bearer.org);
  return Response.json({ revoked: true });
}
