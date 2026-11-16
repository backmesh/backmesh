import { vi } from 'vitest';

import { anycloudApi } from '../../../src/anycloud/client.js';
import {
  adminRoutes,
  fakeGitHub,
  json,
  SERVICE,
  type Call,
} from '../github/fake-github.js';

// anycloud's rule for every Secret value (`secrets-schemas.ts:13-17` at v0.1.72).
export const refusesValue = (method: string, pathname: string, body: string) =>
  method === 'PUT' &&
  pathname.startsWith('/v1/secrets/') &&
  Object.values(
    (JSON.parse(body) as { values: Record<string, string> }).values,
  ).some((value) => /[\r\n\0]/.test(value));

// An anycloud API whose routes answer `METHOD /v1/path` with fixed JSON (or
// a function of the request body), recording each request as `METHOD
// path?query body`.
// The cache's bucket routes (`cache-buckets.ts`), for any test that doesn't
// name them: buckets made by `createBucket` are the account's own, and a
// mint answers with no tokens.
function cacheBucketRoutes() {
  const owned = new Set<string>();
  return (method: string, pathname: string): Response => {
    const m =
      /^\/v1\/credentials\/[^/]+\/(buckets|storage-tokens)(?:\/([^/]+))?$/.exec(
        pathname,
      );
    if (!m) return new Response(null, { status: 404 });
    if (m[1] === 'storage-tokens')
      return Response.json({ cloud: 'AWS', region: 'us-east-2', tokens: [] });
    if (method === 'PUT') owned.add(m[2]!);
    if (method === 'DELETE') owned.delete(m[2]!);
    if (method === 'GET' && !m[2])
      return Response.json({
        buckets: [...owned].map((name) => ({
          name,
          region: null,
          createdAt: null,
        })),
        nextCursor: null,
      });
    return new Response(null, { status: 204 });
  };
}

export function fakeApi(
  routes: Record<string, unknown>,
  // An answer that replaces the route's, such as an older API's refusal.
  refuse?: (request: Request) => Response | undefined,
  // The client header, when not this release's.
  clientVersion?: string,
) {
  const requests: string[] = [];
  const cacheBuckets = cacheBucketRoutes();
  const api = anycloudApi(
    'https://c1.anycloud.sh',
    't0ken',
    async (req) => {
      const request = req instanceof Request ? req : new Request(req);
      const { pathname, search } = new URL(request.url);
      const body = await request.text();
      requests.push(`${request.method} ${pathname}${search} ${body}`.trim());
      const refused = refuse?.(request);
      if (refused) return refused;
      const route = `${request.method} ${pathname}`;
      if (refusesValue(request.method, pathname, body)) {
        return Response.json(
          { message: 'Input validation failed' },
          { status: 400 },
        );
      }
      if (!(route in routes)) return cacheBuckets(request.method, pathname);
      const answer = routes[route];
      return Response.json(
        typeof answer === 'function' ? answer(body) : (answer ?? {}),
        { status: request.method === 'POST' ? 202 : 200 },
      );
    },
    undefined,
    clientVersion,
  );
  return { api, requests };
}

// The anycloud binary: answers by the longest matching argument prefix and
// records every call.
export function fakeBinary(answers: Record<string, string>) {
  const calls: string[] = [];
  const run = async (args: string[]) => {
    const line = args.join(' ');
    calls.push(line);
    const key = Object.keys(answers)
      .filter((prefix) => line.startsWith(prefix))
      .sort((a, b) => b.length - a.length)[0];
    return key === undefined ? '' : answers[key]!;
  };
  return { run, calls };
}

export const HOSTED = 'https://c1.anycloud.sh';

// A hosted API and the anycloud binary as 0.1.73 has them. The API admits
// only the account's current token and answers any other with a 401
// (`api-authentication.ts:186-190`), or GITHUB_SIGN_IN_REQUIRED while the
// GitHub sign-in it holds for the account is stale (`rpc/base.ts:160-170`).
// `api token` prints the saved token, however stale (`hostedApiBearer`).
// `login <url>` exchanges the GitHub sign-in, which stores it and returns
// the account's current token, and saves that (`exchangeApiToken` in
// `api-tokens.ts`); it fails for an account that lost access, and without a
// sign-in it relays a device code on stdout and exits 1
// (`exitWithActionRequired`), until `signIn` saves backmesh's. `rotates` rotates the token elsewhere again
// right after `login`. `GET /v1/version` needs no token; other requests
// answer `[]`.
export function fakeHosted({
  // 'relay-denied': relays until backmesh signs in, then access is denied.
  login = 'ok' as 'ok' | 'denied' | 'relay' | 'relay-denied',
  staleSignIn = false,
  rotates = false,
} = {}) {
  const state = { current: 'acapi_new', saved: 'acapi_old', staleSignIn };
  if (staleSignIn) state.saved = state.current;
  const calls: string[] = [];
  const bearers: string[] = [];
  let signedIn = false;
  const signIn = vi.fn(async () => {
    signedIn = true;
  });
  const run = async (args: string[]) => {
    const line = args.join(' ');
    calls.push(line);
    if (line === 'api status --json') return JSON.stringify({ url: HOSTED });
    if (line === 'api token') return `${state.saved}\n`;
    if (line === `login ${HOSTED}`) {
      if (login === 'denied')
        throw new Error('Login failed: API access denied');
      if (login === 'relay-denied' && signedIn) {
        throw new Error('Login failed: API access denied');
      }
      if (login.startsWith('relay') && !signedIn) {
        throw Object.assign(new Error('Command failed: anycloud login'), {
          stdout: `${JSON.stringify({ actionRequired: { code: 'GITHUB_SIGN_IN_REQUIRED', message: 'Enter code ABCD-1234 at https://github.com/login/device.' } })}\n`,
        });
      }
      state.saved = state.current;
      state.staleSignIn = false;
      if (rotates) state.current = 'acapi_newer';
      return '';
    }
    return '';
  };
  const refuse = (code: string, status: number, message: string) =>
    Response.json({ defined: true, code, status, message }, { status });
  const fetch = async (request: Request | string | URL) => {
    if (!(request instanceof Request))
      return Response.json({ version: '0.1.73' });
    const bearer = request.headers.get('authorization')!;
    bearers.push(bearer.replace('Bearer ', ''));
    if (bearer !== `Bearer ${state.current}`) {
      return refuse(
        'UNAUTHORIZED',
        401,
        `This API token was rotated or removed: run \`anycloud login ${HOSTED}\` for the current one.`,
      );
    }
    if (state.staleSignIn) {
      return refuse(
        'GITHUB_SIGN_IN_REQUIRED',
        403,
        `GitHub rejected your sign-in. Run \`anycloud login ${HOSTED}\`, then retry.`,
      );
    }
    return Response.json([]);
  };
  return {
    state,
    calls,
    bearers,
    run,
    signIn,
    fetch: fetch as typeof globalThis.fetch,
  };
}

// GitHub's public `GET /orgs/{org}`: each org's numeric ID.
export const ORG_IDS: Record<string, number> = { acme: 7, beta: 8 };
export const githubOrg = (path: string) => {
  const org = path.replace('/orgs/', '').toLowerCase();
  return org in ORG_IDS
    ? Response.json({ login: org, id: ORG_IDS[org] })
    : Response.json({ message: 'Not Found' }, { status: 404 });
};

export const INSTALL_KEY = `bmk_${'ab'.repeat(32)}`;
const DEVICE = {
  device_code: 'dev-3584e1',
  user_code: 'ABCD-1234',
  verification_uri: 'https://github.com/login/device',
  interval: 5,
  expires_in: 900,
};

// The token backmesh's GitHub sign-in returns.
export const SIGNED_IN = 'gho_signedin';

// The Worker's install and status routes. `installs` answers
// each `POST /v1/installs` poll in turn and `status` each `GET /v1/status`,
// both repeating the last. An Error answer is a connection failure.
export function fakeWorker({
  status = [Response.json({ org_id: 7 })] as (Response | Error)[],
  installs = [
    Response.json({
      org_id: 7,
      org: 'acme',
      install: 'i1',
      key: INSTALL_KEY,
      github_token: SIGNED_IN,
    }),
  ] as (Response | Error)[],
  signIns = [Response.json({ github_token: SIGNED_IN })] as (
    Response | Error
  )[],
  device = Response.json(DEVICE) as Response | Error,
  // The token broker's answers: a token for acme unless told otherwise.
  tokens = [
    Response.json({
      token: 'ghs_1',
      expires_at: '2026-11-06T13:00:00Z',
      permissions: {},
      org: { id: 7, login: 'acme' },
    }),
  ] as (Response | Error)[],
  // Uninstall's cleanup: the sign-in's answers, the re-mints and the finish.
  cleanups = [
    Response.json({
      token: 'ghs_7',
      expires_at: '2100-01-01T00:00:00Z',
      org: { id: 7, login: 'acme' },
      cleanup_id: 'c'.repeat(64),
    }),
  ] as (Response | Error)[],
  refreshes = [
    Response.json({
      token: 'ghs_8',
      expires_at: '2100-01-01T00:00:00Z',
      org: { id: 7, login: 'acme' },
    }),
  ] as (Response | Error)[],
  finishes = [Response.json({ removed: true, still_used_by: [] })] as (
    Response | Error
  )[],
  // `backmesh rotate-key`'s last step.
  revokes = [Response.json({ revoked: true })] as (Response | Error)[],
} = {}) {
  const calls: string[] = [];
  // What each `POST /v1/installs` and `/v1/installs/cleanup*` sent.
  const bodies: Record<string, unknown>[] = [];
  // What each `POST /v1/installs/device` sent: which scopes it asks for.
  const devices: Record<string, unknown>[] = [];
  // Each `POST /v1/installs/revoke`'s bearer key and install ID.
  const revoked: {
    key: string | undefined;
    install: unknown;
    token: unknown;
  }[] = [];
  const next = (answers: (Response | Error)[]) => {
    const answer = answers.length > 1 ? answers.shift() : answers[0];
    return answer instanceof Response ? answer.clone() : answer;
  };
  const fetch = async (url: string | URL | Request, init: RequestInit = {}) => {
    const { host, pathname: path } = new URL(String(url));
    // GitHub's public org read (`readOrgId`).
    if (host === 'api.github.com') return githubOrg(path);
    const body = init.body && JSON.parse(String(init.body));
    calls.push(`${init.method ?? 'GET'} ${path}`);
    if (path === '/v1/installs' || path.startsWith('/v1/installs/cleanup')) {
      bodies.push(body);
    }
    if (path === '/v1/installs/device') {
      devices.push(JSON.parse(String(init.body)));
    }
    if (path === '/v1/installs/revoke') {
      revoked.push({
        key: (init.headers as Record<string, string>)?.Authorization?.replace(
          'Bearer ',
          '',
        ),
        install: body?.install,
        token: body?.github_token,
      });
    }
    const answers: Record<string, (Response | Error)[]> = {
      '/v1/installs/device': [device],
      '/v1/installs': installs,
      '/v1/token': tokens,
      '/v1/installs/cleanup': cleanups,
      '/v1/installs/cleanup/token': refreshes,
      '/v1/installs/cleanup/finish': finishes,
      '/v1/sign-in': signIns,
      '/v1/installs/revoke': revokes,
    };
    const answer = next(answers[path] ?? status);
    if (answer instanceof Error) throw answer;
    // The cleanup's sign-in answers for the org it was asked about.
    if (path === '/v1/installs/cleanup' && answer?.ok && body?.org) {
      const json = (await answer.json()) as { org?: { login: string } };
      if (json.org) json.org.login = body.org;
      return Response.json(json);
    }
    return answer ?? new Response('', { status: 500 });
  };
  return { fetch, calls, bodies, devices, revoked };
}

// An org's GitHub as uninstall's cleanup token sees it: the group of acme's
// install on c1 (tag l8u5e) with two of its scale sets, two backmesh runners
// from two installs, and the org's own runners, default group and the
// shared `backmesh` group from before per-install names, which stay. `stickyRunner`
// keeps the first runner listed, as GitHub can while it sees a job.
export const GROUP = 'backmesh-l8u5e-k3j9x0';

export function fakeOrg({ stickyRunner = false } = {}) {
  const API = 'https://api.github.com/orgs/acme/actions';
  const SCALE_SETS = `${SERVICE}/_apis/runtime/runnerscalesets`;
  const sets = new Map([
    ['backmesh-4', 1],
    ['backmesh-aws-8', 2],
  ]);
  const runners = new Map([
    [100, 'bm0a1b2-a4-k3j9x0qz'],
    [101, 'bmzz999-c8-aaaaaaaa'],
    [102, 'build-box'],
    [103, 'bmaster-ci'],
  ]);
  const groups = new Map([
    [1, 'Default'],
    [3, GROUP],
    [5, 'backmesh'],
  ]);
  const removeSet = (id: number) => () => {
    for (const [name, set] of sets) if (set === id) sets.delete(name);
    return new Response(null, { status: 204 });
  };
  const removeRunner = (id: number) => () => {
    if (!stickyRunner || id !== 100) runners.delete(id);
    return new Response(null, { status: 204 });
  };
  return {
    sets,
    runners,
    groups,
    ...fakeGitHub({
      ...adminRoutes(),
      [`GET ${SERVICE}/_apis/runtime/runnergroups/`]: ({ url }: Call) => {
        const name = url.searchParams.get('groupName');
        const value = [...groups]
          .filter(([, group]) => group === name)
          .map(([id]) => ({ id: id * 10, name }));
        return json(200, { count: value.length, value })();
      },
      [`GET ${SCALE_SETS}`]: ({ url }: Call) => {
        const name = url.searchParams.get('name')!;
        const id = sets.get(name);
        const value = id ? [{ id, name, runnerGroupId: 30 }] : [];
        return json(200, { count: value.length, value })();
      },
      [`DELETE ${SCALE_SETS}/1`]: removeSet(1),
      [`DELETE ${SCALE_SETS}/2`]: removeSet(2),
      // The on-demand sets a test adds.
      [`DELETE ${SCALE_SETS}/3`]: removeSet(3),
      [`DELETE ${SCALE_SETS}/4`]: removeSet(4),
      [`GET ${API}/runners`]: () =>
        json(200, {
          total_count: runners.size,
          runners: [...runners].map(([id, name]) => ({ id, name })),
        })(),
      [`DELETE ${API}/runners/100`]: removeRunner(100),
      [`DELETE ${API}/runners/101`]: removeRunner(101),
      [`GET ${API}/runner-groups`]: () =>
        json(200, {
          total_count: groups.size,
          runner_groups: [...groups].map(([id, name]) => ({ id, name })),
        })(),
      [`DELETE ${API}/runner-groups/3`]: () => {
        groups.delete(3);
        return new Response(null, { status: 204 });
      },
    }),
  };
}

// An older anycloud API's answer to a newer client on any procedure but
// `api upgrade` and the token exchange: it takes only its own release and
// the one before it (`api-version.ts` `clientWindowVersionCheck`, v0.1.73).
export const versionMismatch = (client: string, served: string) =>
  Response.json(
    {
      defined: true,
      code: 'CLIENT_VERSION_MISMATCH',
      status: 400,
      message: `Client/API version mismatch. Client version ${client} must exactly match API version ${served}.`,
    },
    { status: 400 },
  );
