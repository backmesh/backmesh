// The backmesh GitHub App: the App JWT, each org's
// installation, and installation tokens for the token broker. The App's key
// is a Worker secret; only the Worker signs with it.
import type { Env } from './index.js';

const HOUR = 3_600_000;

// The four permissions the App asks for. A token asks for these,
// narrowed to what the installation grants.
const WANTED: Record<string, 'read' | 'write'> = {
  organization_self_hosted_runners: 'write',
  actions: 'write',
  checks: 'write',
  metadata: 'read',
};

export const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const encode = (value: object) =>
  base64url(new TextEncoder().encode(JSON.stringify(value)));

// Imported once per isolate and key. WebCrypto imports PKCS#8 only, which
// Worker setup converts GitHub's PKCS#1 PEM to.
const keys = new Map<string, ReturnType<typeof crypto.subtle.importKey>>();
function signingKey(pem: string) {
  let key = keys.get(pem);
  if (!key) {
    const der = Uint8Array.from(
      atob(pem.replace(/-----[A-Z ]+-----|\s/g, '')),
      (c) => c.charCodeAt(0),
    );
    key = crypto.subtle.importKey(
      'pkcs8',
      der,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    // A failed import isn't kept, so a fixed secret works on the next call.
    key.catch(() => keys.delete(pem));
    keys.set(pem, key);
  }
  return key;
}

// An App JWT: RS256, issued 60 s back for clock drift, valid for 9 of
// GitHub's 10 allowed minutes (external). The next key signs once it's set,
// which is how the key rotates.
export async function appJwt(
  env: Pick<
    Env,
    'GITHUB_APP_ID' | 'GITHUB_APP_PRIVATE_KEY' | 'GITHUB_APP_PRIVATE_KEY_NEXT'
  >,
  now = Date.now(),
) {
  const pem = env.GITHUB_APP_PRIVATE_KEY_NEXT || env.GITHUB_APP_PRIVATE_KEY;
  if (!env.GITHUB_APP_ID || !pem) {
    throw new Error('backmesh App not configured yet.');
  }
  const seconds = Math.floor(now / 1000);
  const data = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iat: seconds - 60,
    exp: seconds + 540,
    iss: env.GITHUB_APP_ID,
  })}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    await signingKey(pem),
    new TextEncoder().encode(data),
  );
  return `${data}.${base64url(new Uint8Array(signature))}`;
}

// A GitHub call gives up after this long.
export const GITHUB_TIMEOUT_MS = 30_000;

export const randomHex = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');

// GitHub failing a call the Worker needs; answered as 502.
export class GitHubError extends Error {}

export async function app(env: Env, path: string, init: RequestInit = {}) {
  return fetch(`https://api.github.com${path}`, {
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${await appJwt(env)}`,
      'User-Agent': 'backmesh',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
}

// The org's installation of the App, or null when it isn't installed. A
// cached row older than an hour is read again by its ID, so a permission an
// owner approves since is used and a rename is followed; without one, the
// org's login from its device sign-in finds it. Either way account.id must be
// the key's org, so a renamed or reused login can't redirect a key to
// another org.
export async function installationOf(env: Env, org: number, now = Date.now()) {
  const row = await env.DB.prepare(
    'SELECT id, login, permissions, checked_at FROM installations WHERE org = ?',
  )
    .bind(org)
    .first<{
      id: number;
      login: string;
      permissions: string;
      checked_at: number;
    }>();
  if (row && row.checked_at > now - HOUR) {
    return {
      ...row,
      permissions: JSON.parse(row.permissions) as Record<string, string>,
    };
  }
  const known = await env.DB.prepare('SELECT login FROM orgs WHERE id = ?')
    .bind(org)
    .first<{ login: string | null }>();
  const paths = [
    row && `/app/installations/${row.id}`,
    known?.login && `/orgs/${encodeURIComponent(known.login)}/installation`,
  ];
  for (const path of paths) {
    if (!path) continue;
    const res = await app(env, path);
    if (res.status === 404) continue;
    if (!res.ok) throw new GitHubError(`GitHub ${path}: ${res.status}`);
    const found = (await res.json()) as {
      id: number;
      account: { id: number; login: string } | null;
      permissions: Record<string, string>;
    };
    if (found.account?.id !== org) continue;
    const { id, permissions } = found;
    const { login } = found.account;
    await env.DB.prepare(
      'INSERT OR REPLACE INTO installations VALUES (?, ?, ?, ?, ?)',
    )
      .bind(org, id, login, JSON.stringify(permissions), now)
      .run();
    return { id, login, permissions };
  }
  await forget(env, org);
  return null;
}
export const forget = (env: Env, org: number) =>
  env.DB.prepare('DELETE FROM installations WHERE org = ?').bind(org).run();

// The wanted permissions, each at most at the level the installation grants.
export function narrowed(granted: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(WANTED).flatMap(([name, level]) => {
      const has = granted[name];
      if (has !== 'read' && has !== 'write') return [];
      return [[name, level === 'write' && has === 'write' ? 'write' : 'read']];
    }),
  );
}

// An installation token for the org, or null when the App isn't installed
// there. A 404 or 422 from the mint (the installation is gone or grants less
// than the cache says) drops the cache row and looks it up once more.
// `permissions`, when given, is asked for exactly instead of the narrowed
// four.
export async function mintToken(
  env: Env,
  org: number,
  permissions?: Record<string, string>,
) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const installation = await installationOf(env, org);
    if (!installation) return null;
    const res = await app(
      env,
      `/app/installations/${installation.id}/access_tokens`,
      {
        method: 'POST',
        body: JSON.stringify({
          permissions: permissions ?? narrowed(installation.permissions),
        }),
      },
    );
    if (res.status === 404 || res.status === 422) {
      await forget(env, org);
      continue;
    }
    if (!res.ok) {
      // A suspended installation answers 403.
      console.log(`token for org ${org}: GitHub answered ${res.status}`);
      throw new GitHubError(`GitHub refused a token: ${res.status}`);
    }
    const minted = (await res.json()) as {
      token: string;
      expires_at: string;
      permissions: Record<string, string>;
    };
    const { token, expires_at } = minted;
    const { id, login } = installation;
    const answer = {
      token,
      expires_at,
      permissions: minted.permissions,
      org: { id: org, login },
    };
    return { answer, installation: id };
  }
  throw new GitHubError('GitHub refused a token for a fresh installation.');
}

export const installUrl = (env: Env, org: number) =>
  `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new/permissions?target_id=${org}`;
