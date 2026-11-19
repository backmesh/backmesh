// The cue relay's routes. `backmesh cue` trades its App sign-in, which must
// reach the org's App installation, for a cue credential once; the listener
// connects with its install key. Each
// is forwarded to the org's Relay Durable Object (relay.ts) with only what
// the Worker vouches for.
//   POST /v1/cue/sign-in            a 30-day cue credential for a sign-in
//   GET  /v1/cue/keys?org=<login>   the org's listener keys, and the login
//   POST /v1/cue { org, tag, hash, sealed: [{ kid, enc, ct }] }
//   GET  /v1/cue/connect            the listener's WebSocket
import type { Env } from './index.js';
import { GitHubError, randomHex } from './app.js';
import { asUser, keyInstall, notServed, sha256 } from './installs.js';

declare const caches: {
  default: {
    match(key: string): Promise<Response | undefined>;
    put(key: string, response: Response): Promise<void>;
  };
};

interface Member {
  id: number;
  login: string;
  org_id: number;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

// The signed-in user and the orgs whose installation of the App the user's
// App token reaches: GitHub lists an installation to a user token when the
// user can access one of its repositories, an outside collaborator included
// and a member with no repository not. That's a gate against abuse, not the
// authority: the listener acts on a cue only for a user GitHub says can
// push to its repository. `/user/memberships` would need the App's Members
// permission, which it doesn't ask for.
async function reached(token: string) {
  const [user, installs] = await Promise.all([
    asUser(token, '/user'),
    asUser(token, '/user/installations?per_page=100'),
  ]);
  if (user.status === 401 || installs.status === 401) return 'expired';
  const sso = (r: Response) =>
    r.status === 403 && r.headers.has('X-GitHub-SSO');
  if (sso(user)) return 'sso';
  if (!user.ok) throw new GitHubError(`GitHub /user: ${user.status}`);
  const { id, login } = (await user.json()) as { id: number; login: string };
  // The user is known even when an org's SAML SSO holds the list back.
  if (sso(installs)) return { id, login, orgs: [], sso: true };
  if (!installs.ok) {
    throw new GitHubError(`GitHub /user/installations: ${installs.status}`);
  }
  const { installations } = (await installs.json()) as {
    installations: { account: { id: number; login: string } | null }[];
  };
  const orgs = installations.flatMap(({ account }) =>
    account ? [{ id: account.id, login: account.login }] : [],
  );
  return { id, login, orgs, sso: false };
}

const memberOf = (
  who: { id: number; login: string; orgs: { id: number; login: string }[] },
  org: string,
): Member | null => {
  const found = who.orgs.find(
    (o) => o.login.toLowerCase() === org.toLowerCase(),
  );
  return found ? { id: who.id, login: who.login, org_id: found.id } : null;
};

async function orgMember(token: string, org: string) {
  const who = await reached(token);
  if (typeof who === 'string') return who;
  return who.sso ? 'sso' : memberOf(who, org);
}

const CREDENTIAL_TTL = 30 * 86_400_000;
const KEPT = 10;
const credentialExpired = () =>
  json({ error: 'Cue sign-in expired; run `backmesh cue --sign-in`.' }, 401);

// POST /v1/cue/sign-in, with a fresh App sign-in as the bearer: a cue
// credential (`bmc_` and 64 hex digits) for 30 days, bound to the user and
// the orgs the sign-in reached, so cue sends GitHub nothing after. Only its
// hash is kept.
async function credential(request: Request, env: Env) {
  const token = request.headers
    .get('Authorization')
    ?.match(/^Bearer (\S{1,512})$/)?.[1];
  if (!token) return json({ error: 'Sign in with GitHub.' }, 401);
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  if (!(await env.SIGNIN_LIMIT.limit({ key: ip })).success) {
    return json({ error: 'Too many requests; retry later.' }, 429);
  }
  const { revoke } = ((await request.json().catch(() => null)) ?? {}) as {
    revoke?: unknown;
  };
  const who = await reached(token);
  if (who === 'expired') {
    return json({ error: 'GitHub sign-in expired; sign in again.' }, 401);
  }
  // An explicit `cue --sign-in` (`revoke`) revokes the user's other
  // credentials, copies included, before anything can refuse the trade; a
  // CLI's own trade adds one, so two machines don't revoke each other's.
  const revoked = revoke === true && typeof who !== 'string';
  if (revoked) {
    await env.DB.prepare('DELETE FROM cue_credentials WHERE user_id = ?')
      .bind(who.id)
      .run();
  }
  // `code` tells the CLI which refusal it is.
  if (who === 'sso' || who.sso) {
    const error =
      "Authorize the backmesh sign-in for your org's SAML SSO on GitHub, then sign in again.";
    return json({ error, code: 'sso', revoked }, 403);
  }
  if (!who.orgs.length) {
    const error =
      "None of your orgs' repositories that backmesh's GitHub App is on is open to you.";
    return json({ error, code: 'no_org', revoked }, 403);
  }
  const issued = `bmc_${randomHex()}${randomHex()}`;
  const expires = Date.now() + CREDENTIAL_TTL;
  // The user's newest 10 are kept.
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO cue_credentials (hash, user_id, login, orgs, expires_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(
      await sha256(issued),
      who.id,
      who.login,
      JSON.stringify(who.orgs),
      expires,
    ),
    env.DB.prepare(
      `DELETE FROM cue_credentials WHERE user_id = ?1 AND hash NOT IN
       (SELECT hash FROM cue_credentials WHERE user_id = ?1
        ORDER BY expires_at DESC LIMIT ${KEPT})`,
    ).bind(who.id),
  ]);
  return json({
    credential: issued,
    login: who.login,
    expires_at: new Date(expires).toISOString(),
  });
}

// The cue credential's user in the org, asking GitHub nothing. 'expired'
// for a malformed, unknown or expired one.
async function credentialMember(env: Env, issued: string, org: string) {
  if (!/^bmc_[0-9a-f]{64}$/.test(issued)) return 'expired';
  const row = await env.DB.prepare(
    'SELECT user_id, login, orgs, expires_at FROM cue_credentials WHERE hash = ?',
  )
    .bind(await sha256(issued))
    .first<{
      user_id: number;
      login: string;
      orgs: string;
      expires_at: number;
    }>();
  if (!row || row.expires_at <= Date.now()) return 'expired';
  const orgs = JSON.parse(row.orgs) as { id: number; login: string }[];
  return memberOf({ id: row.user_id, login: row.login, orgs }, org);
}

// The signed-in member of the org, cached five minutes (per colo) by the
// token's hash, under the Worker's own origin (the Cache API keeps only its
// zone's URLs). A miss asks GitHub only when `admit` does, else answers
// 'limited'. 'expired' when GitHub refuses the token; any other failure
// throws (GitHubError, a 502) and isn't cached.
export async function cueMember(
  origin: string,
  token: string,
  org: string,
  admit: () => Promise<boolean>,
): Promise<Member | null | 'expired' | 'sso' | 'limited'> {
  const key = `${origin}/v1/cue/membership/${await sha256(token)}/${encodeURIComponent(org.toLowerCase())}`;
  const cached = await caches.default.match(key);
  if (cached) return (await cached.json()) as Member | null;
  if (!(await admit())) return 'limited';
  const member = await orgMember(token, org);
  if (member === 'expired' || member === 'sso') return member;
  await caches.default.put(
    key,
    Response.json(member, { headers: { 'Cache-Control': 'max-age=300' } }),
  );
  return member;
}

// Each GitHub check counts against the client IP's sign-in limit, so a
// flood of made-up tokens can't pass through to GitHub.
async function signIn(
  request: Request,
  env: Env,
  org: unknown,
  refused: (response: Response) => Promise<Response>,
) {
  const { origin } = new URL(request.url);
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const admit = async () => (await env.SIGNIN_LIMIT.limit({ key: ip })).success;
  const token = request.headers
    .get('Authorization')
    ?.match(/^Bearer (\S{1,512})$/)?.[1];
  if (!token) return json({ error: 'Sign in with GitHub.' }, 401);
  if (typeof org !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(org)) {
    return json({ error: 'Name the org.' }, 400);
  }
  const other = notServed(env, org);
  if (other) return other;
  // A cue credential asks GitHub nothing; an App sign-in still works.
  if (token.startsWith('bmc_')) {
    // A refused credential counts against the client IP, as a refused
    // install key does.
    const member = await credentialMember(env, token, org);
    if (member === 'expired') return refused(credentialExpired());
    const error = `None of ${org}'s repositories that backmesh's GitHub App is on is open to you.`;
    return member ?? json({ error }, 403);
  }
  const member = await cueMember(origin, token, org, admit);
  if (member === 'limited') {
    return json({ error: 'Too many requests; retry later.' }, 429);
  }
  if (member === 'expired') {
    return json({ error: 'GitHub sign-in expired; sign in again.' }, 401);
  }
  if (member === 'sso') {
    const error = `Authorize the backmesh sign-in for ${org}'s SAML SSO on GitHub, then sign in again.`;
    return json({ error }, 403);
  }
  const error = `None of ${org}'s repositories that backmesh's GitHub App is on is open to you.`;
  return member ?? json({ error }, 403);
}

const relay = (
  env: Env,
  org: number,
  path: string,
  headers: Record<string, string>,
  body?: string,
) =>
  env.RELAY.get(env.RELAY.idFromName(String(org))).fetch(
    new Request(`https://relay${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body,
    }),
  );

// The cue routes' answer. `refused` counts a refused install key against
// the client IP, and answers 429 instead once that's over its limit.
export async function cue(
  request: Request,
  env: Env,
  refused: (response: Response) => Promise<Response>,
): Promise<Response> {
  const { pathname, searchParams } = new URL(request.url);
  if (pathname === '/v1/cue/connect') {
    const install = await keyInstall(env, request);
    if (!install || install.revoked) {
      return refused(json({ error: 'Install key refused.' }, 401));
    }
    if (request.headers.get('Upgrade') !== 'websocket') {
      return json({ error: 'Expected a WebSocket.' }, 426);
    }
    if (!(await env.INSTALL_LIMIT.limit({ key: install.id })).success) {
      return json({ error: 'Too many requests; retry later.' }, 429);
    }
    return relay(env, install.org, '/connect', {
      Upgrade: 'websocket',
      'x-install': install.id,
    });
  }
  if (pathname === '/v1/cue/sign-in' && request.method === 'POST') {
    return credential(request, env);
  }
  if (pathname === '/v1/cue/keys' && request.method === 'GET') {
    const member = await signIn(request, env, searchParams.get('org'), refused);
    if (member instanceof Response) return member;
    const res = await relay(env, member.org_id, '/keys', {});
    const { keys } = (await res.json()) as { keys: unknown };
    return json({ org_id: member.org_id, login: member.login, keys });
  }
  if (pathname === '/v1/cue' && request.method === 'POST') {
    const text = await request.text();
    if (text.length > 16_384) return json({ error: 'Too large.' }, 413);
    let body: { org?: unknown };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      return json({ error: 'Malformed cue.' }, 400);
    }
    const member = await signIn(request, env, body?.org, refused);
    if (member instanceof Response) return member;
    const user = JSON.stringify({ id: member.id, login: member.login });
    return relay(env, member.org_id, '/cue', { 'x-user': user }, text);
  }
  return json({ error: 'Not found.' }, 404);
}
