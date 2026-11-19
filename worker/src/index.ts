// The backmesh Worker on api.backmesh.com: install keys and telemetry,
// the backmesh App's token broker, the check of the CLI's sign-ins and the
// cue relay.
import { GitHubError, GitHubTimeout } from './app.js';
import {
  cleanup,
  cleanupFinish,
  cleanupRefresh,
  token,
  trimAudit,
} from './broker.js';
import { cue } from './cue.js';
import type { RelayNamespace } from './relay.js';
import {
  createInstall,
  keyInstall,
  revokeInstall,
  SignInRefused,
} from './installs.js';
import { intake, retain } from './telemetry.js';

// The cue relay's Durable Object class, which the runtime finds as an export
// of the Worker's main module (wrangler.jsonc).
export { Relay } from './relay.js';

// The subset of Cloudflare's D1 API the Worker uses.
export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
export interface D1Database {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<unknown[]>;
}

// Cloudflare's rate limiting binding.
export interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1Database;
  // Per client IP for the sign-in routes, and per install for events, status
  // and tokens (wrangler.jsonc). Over the limit answers 429. Cleanup's
  // hourly limit per org counts audit rows (broker.ts):
  // Cloudflare's binding takes only 10- or 60-second periods (external).
  SIGNIN_LIMIT: RateLimit;
  INSTALL_LIMIT: RateLimit;
  TOKEN_LIMIT: RateLimit;
  // One Relay Durable Object per org, for cues (cue.ts).
  RELAY: RelayNamespace;
  // The backmesh App: its ID, URL slug and PKCS#8 private key, and
  // the next key during a rotation, which signs once set. Unset until the
  // App exists, when the broker routes answer 503.
  GITHUB_APP_ID?: string;
  GITHUB_APP_SLUG: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_PRIVATE_KEY_NEXT?: string;
}

async function route(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);
  const tooMany = () =>
    Response.json(
      { error: 'Too many requests; retry later.' },
      { status: 429 },
    );
  const cleanups: Record<string, typeof cleanup> = {
    '/v1/installs/cleanup': cleanup,
    '/v1/installs/cleanup/token': cleanupRefresh,
    '/v1/installs/cleanup/finish': cleanupFinish,
  };
  // A refused key or sign-in counts against the client IP, like sign-ins.
  const refused = async (response: Response) => {
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    return (await env.SIGNIN_LIMIT.limit({ key: ip })).success
      ? response
      : tooMany();
  };
  if (pathname === '/v1/cue' || pathname.startsWith('/v1/cue/')) {
    return cue(request, env, refused);
  }
  const broker = pathname === '/v1/token' || Object.hasOwn(cleanups, pathname);
  if (pathname === '/v1/installs' || Object.hasOwn(cleanups, pathname)) {
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    if (!(await env.SIGNIN_LIMIT.limit({ key: ip })).success) return tooMany();
  }
  if (pathname === '/v1/installs' && request.method === 'POST') {
    return createInstall(request, env);
  }
  if (broker && request.method !== 'POST') {
    return Response.json({ error: 'Use POST.' }, { status: 405 });
  }
  if (broker && !(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY)) {
    const error = 'backmesh App not configured yet.';
    return Response.json({ error }, { status: 503 });
  }
  // An org owner's sign-in, and the install key when there is one.
  if (Object.hasOwn(cleanups, pathname))
    return cleanups[pathname]!(request, env);
  if (
    pathname === '/v1/status' ||
    pathname === '/v1/events' ||
    pathname === '/v1/token' ||
    pathname === '/v1/installs/revoke'
  ) {
    // An install key (installs.ts) names the org and the install.
    const install = await keyInstall(env, request);
    if (!install || install.revoked) {
      console.log(`${pathname} refused: missing, unknown or revoked key`);
      const error =
        'Missing or refused install sign-in; run backmesh upgrade to sign in with GitHub again.';
      return refused(Response.json({ error }, { status: 401 }));
    }
    if (pathname === '/v1/token') {
      if (!(await env.TOKEN_LIMIT.limit({ key: install.id })).success) {
        return tooMany();
      }
      return token(request, env, install);
    }
    if (!(await env.INSTALL_LIMIT.limit({ key: install.id })).success) {
      return tooMany();
    }
    if (pathname === '/v1/events' && request.method === 'POST') {
      return intake(request, env, install);
    }
    if (pathname === '/v1/installs/revoke') {
      if (request.method !== 'POST') {
        return Response.json({ error: 'Use POST.' }, { status: 405 });
      }
      return revokeInstall(request, env, install);
    }
    // The key's org: upgrade checks the key is still accepted.
    return Response.json({ org_id: install.org });
  }
  return Response.json({ error: 'Not found.' }, { status: 404 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return route(request, env).catch((error: unknown) => {
      if (error instanceof GitHubError) {
        return Response.json({ error: error.message }, { status: 502 });
      }
      if (error instanceof GitHubTimeout) {
        return Response.json({ error: error.message }, { status: 504 });
      }
      if (error instanceof SignInRefused) {
        return Response.json(
          { error: error.message },
          { status: error.status },
        );
      }
      throw error;
    });
  },
  async scheduled(_controller: unknown, env: Env): Promise<void> {
    await retain(env.DB);
    await trimAudit(env);
  },
};
