// The cue relay's routes. `backmesh cue` signs in
// with the GitHub token of its device sign-in (read:org), which must be an
// active member of the org; the listener connects with its install key. Each
// is forwarded to the org's Relay Durable Object (relay.ts) with only what
// the Worker vouches for.
//   GET  /v1/cue/keys?org=<login>   the org's listener keys
//   POST /v1/cue { org, tag, hash, sealed: [{ kid, enc, ct }] }
//   GET  /v1/cue/connect            the listener's WebSocket
import type { Env } from './index.js';
import { keyInstall, orgMembership, sha256 } from './installs.js';

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

// The signed-in user's active membership of the org, cached five minutes
// (per colo) by the token's hash, under the Worker's own origin (the Cache
// API keeps only its zone's URLs). A miss asks GitHub only when `admit`
// does, else answers 'limited'. 'expired' when GitHub refuses the token;
// any other failure throws (GitHubError, a 502) and isn't cached.
export async function cueMember(
  origin: string,
  token: string,
  org: string,
  admit: () => Promise<boolean>,
): Promise<Member | null | 'expired' | 'sso' | 'limited'> {
  const key = `${origin}/v1/cue/membership/${await sha256(token)}/${encodeURIComponent(org.toLowerCase())}`;
  const cached = await caches.default.match(key);
  if (cached) return (await cached.json()) as Member | null | 'sso';
  if (!(await admit())) return 'limited';
  const m = await orgMembership(token, org, 'cue');
  if (m === 'expired') return m;
  const member =
    m === 'sso'
      ? m
      : m?.state === 'active'
        ? { id: m.user.id, login: m.user.login, org_id: m.organization.id }
        : null;
  await caches.default.put(
    key,
    Response.json(member, { headers: { 'Cache-Control': 'max-age=300' } }),
  );
  return member;
}

// Each GitHub check counts against the client IP's sign-in limit, so a
// flood of made-up tokens can't pass through to GitHub.
async function signIn(request: Request, env: Env, org: unknown) {
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
  return member ?? json({ error: `Not a member of ${org}.` }, 403);
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
  if (pathname === '/v1/cue/keys' && request.method === 'GET') {
    const member = await signIn(request, env, searchParams.get('org'));
    if (member instanceof Response) return member;
    const res = await relay(env, member.org_id, '/keys', {});
    const { keys } = (await res.json()) as { keys: unknown };
    return json({ org_id: member.org_id, keys });
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
    const member = await signIn(request, env, body?.org);
    if (member instanceof Response) return member;
    const user = JSON.stringify({ id: member.id, login: member.login });
    return relay(env, member.org_id, '/cue', { 'x-user': user }, text);
  }
  return json({ error: 'Not found.' }, 404);
}
