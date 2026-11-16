import { Octokit } from '@octokit/rest';

import type { Fetch } from '../../../src/github/retry.js';

// A hand-written stand-in for GitHub and the Actions service. Bodies follow
// actions/scaleset `types.go` at 258f2c7b and GitHub's REST docs.

export interface Call {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
}

type Handler = (call: Call) => Response | Promise<Response>;

export function fakeGitHub(routes: Record<string, Handler | Handler[]>) {
  const calls: Call[] = [];
  const queues = new Map(
    Object.entries(routes).map(([key, value]) => [
      key,
      Array.isArray(value) ? [...value] : value,
    ]),
  );
  const fetch: Fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const text = typeof init?.body === 'string' ? init.body : undefined;
    const call: Call = {
      method,
      url,
      headers: new Headers(init?.headers),
      body: text ? JSON.parse(text) : undefined,
    };
    calls.push(call);
    const route = queues.get(`${method} ${url.origin}${url.pathname}`);
    const handler = Array.isArray(route) ? route.shift() : route;
    if (!handler) throw new Error(`no route for ${method} ${url}`);
    const response = await handler(call);
    // A constructed Response has no URL; Octokit's paginator reads it.
    Object.defineProperty(response, 'url', { value: url.href });
    return response;
  };
  return { fetch, calls };
}

export const json =
  (status: number, body: unknown, headers = {}) =>
  () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });

export const empty = (status: number) => () => new Response(null, { status });

// An unsigned JWT with an expiry, like the Actions service's admin token.
export function adminJwt(expSeconds: number): string {
  const part = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256' })}.${part({ exp: expSeconds })}.sig`;
}

export const SERVICE = 'https://pipelines.actions.example/abc';

// The routes every Actions service call needs first: the org registration
// token, then its exchange for the service URL and admin token.
export function adminRoutes(expSeconds = 4_102_444_800) {
  return {
    'POST https://api.github.com/orgs/acme/actions/runners/registration-token':
      json(201, { token: 'REG', expires_at: '2100-01-01T00:00:00Z' }),
    'POST https://api.github.com/actions/runner-registration': json(200, {
      url: SERVICE,
      token: adminJwt(expSeconds),
      token_schema: 'OAuthAccessToken',
    }),
  };
}

export const octokitFor = (fetch: Fetch) =>
  new Octokit({ auth: 'ghs_installation', request: { fetch } });
