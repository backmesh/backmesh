// Install keys (owner, 2026-11-06). `backmesh install` signs an org admin in
// with GitHub's device flow, proxied here. The sign-in asks for read:org, for
// the admin check, and read:packages: with exactly those, the same token is
// the one anycloud's hosted API exchanges, so it goes back to the user who
// signed in, for the control plane. The Worker never stores or logs
// it. It mints a key bound to the org and install.
// The CLI stores the key in the listener's Secret; nobody copies it. Only
// its SHA-256 is stored here.
import { GITHUB_TIMEOUT_MS, GitHubError, randomHex } from './app.js';
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

const github = async (path: string, form: Record<string, string>) =>
  (await (
    await fetch(`https://github.com${path}`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: new URLSearchParams(form),
    })
  ).json()) as Record<string, unknown>;

// POST /v1/installs/device: GitHub's device code for the CLI to show.
export async function deviceCode(env: Env, scope = 'read:org') {
  const answer = await github('/login/device/code', {
    client_id: env.GITHUB_CLIENT_ID,
    scope,
  });
  if (typeof answer.device_code !== 'string') {
    const error = `GitHub refused the sign-in: ${String(answer.error_description ?? answer.error)}`;
    return Response.json({ error }, { status: 502 });
  }
  return Response.json(answer);
}

// The user's token once they finish the device sign-in, or the answer to
// send: 202 while it's pending, 400 when GitHub refuses it (denied, expired,
// or a code already used). The caller uses the token once and drops it.
export async function deviceToken(env: Env, device_code: string) {
  const answer = await github('/login/oauth/access_token', {
    client_id: env.GITHUB_CLIENT_ID,
    device_code,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });
  if (
    answer.error === 'authorization_pending' ||
    answer.error === 'slow_down'
  ) {
    return Response.json(
      { pending: true, slow_down: answer.error === 'slow_down' },
      { status: 202 },
    );
  }
  if (typeof answer.access_token !== 'string') {
    const error = `GitHub sign-in failed: ${String(answer.error_description ?? answer.error)}`;
    return Response.json({ error }, { status: 400 });
  }
  return answer.access_token;
}

// An org whose OAuth app access restrictions, the default for a new org,
// haven't approved backmesh's sign-in: GitHub answers 403. `command`
// is what the user runs again.
export class AppRestricted extends Error {
  constructor(org: string, command: string) {
    super(
      `${org} restricts third-party apps. Run ${command} again, and on GitHub's sign-in page click Grant next to ${org} if you're an org owner, or Request if not. An org owner then approves the request at https://github.com/organizations/${org}/settings/oauth_application_policy, and you run ${command} once more.`,
    );
  }
}

// The user's membership of the org, from a device sign-in's token (read:org):
// null when GitHub shows none (it answers 404 to a non-member), 'expired'
// when it refuses the token, 'sso' when the org's SAML SSO hasn't authorized
// it. An org that restricts OAuth apps throws AppRestricted. The token is
// used here and not stored.
export async function orgMembership(
  token: string,
  org: string,
  command = 'install',
) {
  const res = await fetch(
    `https://api.github.com/user/memberships/orgs/${encodeURIComponent(org)}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'backmesh',
      },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    },
  );
  if (res.status === 401) return 'expired';
  if (res.status === 404) return null;
  if (res.status === 403 && res.headers.has('X-GitHub-SSO')) return 'sso';
  // A 403 says why: an SSO-unauthorized token, the org's OAuth app access
  // restrictions, or a spent rate limit.
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 403 && /OAuth App access restrictions/.test(body)) {
      throw new AppRestricted(org, command);
    }
    throw new GitHubError(
      `GitHub /user/memberships/orgs: ${res.status} ${body}`,
    );
  }
  return (await res.json()) as {
    role: string;
    state: string;
    organization: { id: number; login: string };
    user: { id: number; login: string };
  };
}

// The org's ID and current login, and the user's login, when the device
// sign-in's user is an active admin of the org, else null.
export async function orgAdmin(token: string, org: string, command?: string) {
  const membership = await orgMembership(token, org, command);
  if (membership === 'expired' || membership === 'sso') {
    throw new GitHubError(`GitHub /user/memberships/orgs: ${membership}`);
  }
  return membership?.role === 'admin' && membership.state === 'active'
    ? { ...membership.organization, user: membership.user.login }
    : null;
}

// The login finds the org's App installation (app.ts).
export const rememberLogin = (env: Env, id: number, login: string) =>
  env.DB.prepare(
    'INSERT INTO orgs (id, login) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET login = excluded.login',
  )
    .bind(id, login)
    .run();

// POST /v1/sign-in { device_code }: the GitHub token alone, for a CLI whose
// installation already has its key and needs only the control plane's
// sign-in. Nothing is checked or minted.
export async function relaySignIn(request: Request, env: Env) {
  const { device_code } = (await request.json().catch(() => ({}))) as {
    device_code?: unknown;
  };
  if (typeof device_code !== 'string') {
    return Response.json({ error: 'device_code is required' }, { status: 400 });
  }
  const token = await deviceToken(env, device_code);
  return token instanceof Response
    ? token
    : Response.json({ github_token: token });
}

// POST /v1/installs { org, device_code, install? }: 202 while the user
// hasn't finished, then the key and the token once they have, if they're an
// admin of the org. `install`, the install's ID when signing in again, gets
// a new key.
export async function createInstall(request: Request, env: Env) {
  const { org, device_code, install } = (await request
    .json()
    .catch(() => ({}))) as {
    org?: unknown;
    device_code?: unknown;
    install?: unknown;
  };
  if (typeof org !== 'string' || typeof device_code !== 'string') {
    return Response.json(
      { error: 'org and device_code are required' },
      { status: 400 },
    );
  }
  const token = await deviceToken(env, device_code);
  if (token instanceof Response) return token;
  // Checked here, returned to the signer, and never stored.
  const admin = await orgAdmin(token, org);
  if (!admin) {
    const error = `Creating a backmesh install for ${org} needs its admin role.`;
    return Response.json({ error }, { status: 403 });
  }
  const { id, login } = admin;
  await rememberLogin(env, id, login);
  const previous = typeof install === 'string' ? install : undefined;
  return Response.json({
    org_id: id,
    org: login,
    ...(await mintKey(env.DB, id, previous)),
    github_token: token,
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
  const admin = await orgAdmin(github_token, org.login, 'rotate-key');
  if (!admin || admin.id !== bearer.org) {
    return Response.json(
      { error: `Revoking an install needs ${org.login}'s admin role.` },
      { status: 403 },
    );
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
  return Response.json({ revoked: true });
}
