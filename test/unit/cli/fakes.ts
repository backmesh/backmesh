import { vi } from 'vitest';

import {
  anycloudApi,
  type AnycloudExec,
  type ExecResult,
} from '../../../src/anycloud/client.js';
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

// An org's listener VM as `GET /v1/workloads` lists it.
export const listenerVm = (
  org: string,
  id: string,
  {
    state = 'running',
    startedAt = 0,
    cloudProvider = 'AWS',
    region = 'us-east-1',
    vmType = 't3.small',
  } = {},
) => ({
  id,
  workloadType: 'vm',
  state,
  startedAt,
  cloudProvider,
  region,
  vmType,
  secretNames: [`backmesh-${org}`],
});

// `anycloud exec`'s API route: `answer` gives each call's output, or its
// result with an exit code, or throws; every call is recorded.
export function fakeExec(
  answer: (id: string, command: string) => string | ExecResult | Error,
) {
  const calls: [string, string][] = [];
  const exec: AnycloudExec = async (id, command) => {
    calls.push([id, command]);
    const reply = answer(id, command);
    if (reply instanceof Error) throw reply;
    return typeof reply === 'string'
      ? { code: 0, stdout: reply, stderr: '' }
      : reply;
  };
  return { exec, calls };
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
// GitHub's public `GET /orgs/{org}/repos?type=public`: none unless a test
// sets some, and deletes them after.
export const PUBLIC_REPOS: Record<string, string[]> = {};
export const githubOrg = (path: string) => {
  const [org = '', repos] = path.replace('/orgs/', '').toLowerCase().split('/');
  if (repos === 'repos') {
    return Response.json(
      (PUBLIC_REPOS[org] ?? []).map((full_name) => ({
        full_name,
        archived: full_name.endsWith('-archived'),
      })),
    );
  }
  return org in ORG_IDS
    ? Response.json({ login: org, id: ORG_IDS[org] })
    : Response.json({ message: 'Not Found' }, { status: 404 });
};

export const INSTALL_KEY = `bmk_${'ab'.repeat(32)}`;
// GitHub's answer to the device code request.
export const DEVICE = {
  device_code: 'dev-3584e1',
  user_code: 'ABCD-1234',
  verification_uri: 'https://github.com/login/device',
  interval: 5,
  expires_in: 900,
};

// The backmesh App's user token, from its device sign-in.
export const SIGNED_IN = 'ghu_signedin';
// A later code, after the first expired.
export const NEXT_DEVICE = {
  ...DEVICE,
  device_code: 'dev-2',
  user_code: 'WXYZ-5678',
};
// GitHub's answer to a token poll once the person has signed in.
export const GITHUB_TOKEN = Response.json({
  access_token: SIGNED_IN,
  token_type: 'bearer',
  scope: '',
});

// GitHub's device flow on github.com, then the Worker's routes. `codes`
// answers each device code request and `polls` each token poll, in turn;
// `installs` each `POST /v1/installs` and `status` each `GET /v1/status`;
// every list repeats its last. An Error answer is a connection failure, and
// a function answer is called with the request's signal.
type Answer = Response | Error | ((signal?: AbortSignal) => Promise<Response>);
export function fakeWorker({
  status = [Response.json({ org_id: 7 })] as Answer[],
  installs = [
    Response.json({
      org_id: 7,
      org: 'acme',
      install: 'i1',
      key: INSTALL_KEY,
    }),
  ] as Answer[],
  codes = [Response.json(DEVICE)] as Answer[],
  polls = [GITHUB_TOKEN] as Answer[],
  // The token broker's answers: a token for acme unless told otherwise.
  tokens = [
    Response.json({
      token: 'ghs_1',
      expires_at: '2026-11-06T13:00:00Z',
      permissions: {},
      org: { id: 7, login: 'acme' },
    }),
  ] as Answer[],
  // Uninstall's cleanup: the sign-in's answers, the re-mints and the finish.
  cleanups = [
    Response.json({
      token: 'ghs_7',
      expires_at: '2100-01-01T00:00:00Z',
      org: { id: 7, login: 'acme' },
      cleanup_id: 'c'.repeat(64),
    }),
  ] as Answer[],
  refreshes = [
    Response.json({
      token: 'ghs_8',
      expires_at: '2100-01-01T00:00:00Z',
      org: { id: 7, login: 'acme' },
    }),
  ] as Answer[],
  finishes = [Response.json({ removed: true, still_used_by: [] })] as Answer[],
  // `backmesh rotate-key`'s last step.
  revokes = [Response.json({ revoked: true })] as Answer[],
} = {}) {
  const calls: string[] = [];
  // What each `POST /v1/installs` and `/v1/installs/cleanup*` sent.
  const bodies: Record<string, unknown>[] = [];
  // Each form sent to GitHub's device flow: the device code requests and
  // the token polls.
  const github: {
    path: string;
    form: Record<string, string>;
    at: number;
  }[] = [];
  // Where in `calls` each sign-in finished: the token poll GitHub answered
  // with a token.
  const signedIn: number[] = [];
  // Each `POST /v1/installs/revoke`'s bearer key and install ID.
  const revoked: {
    key: string | undefined;
    install: unknown;
    token: unknown;
  }[] = [];
  const next = async (answers: Answer[], signal?: AbortSignal | null) => {
    const answer = answers.length > 1 ? answers.shift() : answers[0];
    if (typeof answer === 'function') return answer(signal ?? undefined);
    if (answer instanceof Error) throw answer;
    return answer?.clone();
  };
  const fetch = async (url: string | URL | Request, init: RequestInit = {}) => {
    const { host, pathname: path } = new URL(String(url));
    // GitHub's public org read (`readOrgId`).
    if (host === 'api.github.com') return githubOrg(path);
    calls.push(
      `${init.method ?? 'GET'} ${host === 'github.com' ? host : ''}${path}`,
    );
    if (host === 'github.com') {
      const form = Object.fromEntries(new URLSearchParams(String(init.body)));
      github.push({ path, form, at: Date.now() });
      const answers = path === '/login/device/code' ? codes : polls;
      const answer = (await next(answers, init.signal))!;
      const json = (await answer
        .clone()
        .json()
        .catch(() => ({}))) as { access_token?: string };
      if (json.access_token) signedIn.push(calls.length - 1);
      return answer;
    }
    const body = init.body && JSON.parse(String(init.body));
    if (path === '/v1/installs' || path.startsWith('/v1/installs/cleanup')) {
      bodies.push(body);
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
    const answers: Record<string, Answer[]> = {
      '/v1/installs': installs,
      '/v1/token': tokens,
      '/v1/installs/cleanup': cleanups,
      '/v1/installs/cleanup/token': refreshes,
      '/v1/installs/cleanup/finish': finishes,
      '/v1/installs/revoke': revokes,
    };
    const answer = await next(answers[path] ?? status, init.signal);
    // The cleanup's sign-in answers for the org it was asked about.
    if (path === '/v1/installs/cleanup' && answer?.ok && body?.org) {
      const json = (await answer.json()) as { org?: { login: string } };
      if (json.org) json.org.login = body.org;
      return Response.json(json);
    }
    return answer ?? new Response('', { status: 500 });
  };
  // The codes GitHub was asked for, and the token polls, in order.
  const signIns = () => github.filter((g) => g.path === '/login/device/code');
  const tokenPolls = () =>
    github.filter((g) => g.path === '/login/oauth/access_token');
  return {
    fetch,
    calls,
    bodies,
    github,
    signIns,
    tokenPolls,
    signedIn,
    revoked,
  };
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
  // Scale sets in the shared group from before per-install names, whose
  // Actions service ID is 50.
  const legacySets = new Map<string, number>();
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
    legacySets,
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
        const id = (
          url.searchParams.get('runnerGroupId') === '50' ? legacySets : sets
        ).get(name);
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
      [`DELETE ${API}/runners/104`]: removeRunner(104),
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

// The user's cloud CLIs, holding anycloud's generated identities by name,
// each with an access key and its policy or grants, and marked as
// `--generate` marks them unless `unmarked`. A command naming `refuse` is
// denied.
export function fakeCloud(
  names: string[],
  { unmarked = false, refuse }: { unmarked?: boolean; refuse?: string } = {},
) {
  const calls: string[] = [];
  const live = new Set(names);
  const absent = (line: string, why: string) =>
    new Error(`Command failed: ${line}\n${why}`);
  const command = async ([cli, ...args]: string[]) => {
    const line = [cli, ...args].join(' ');
    calls.push(line);
    if (refuse && line.includes(refuse)) {
      throw new Error(`Command failed: ${line}\nAccessDenied: not allowed`);
    }
    if (cli === 'aws') {
      const [, verb, , name = ''] = args;
      if (!live.has(name)) {
        throw absent(line, 'An error occurred (NoSuchEntity) when calling');
      }
      if (verb === 'delete-user') live.delete(name);
      return JSON.stringify(
        {
          'list-user-tags': {
            Tags: unmarked ? [] : [{ Key: 'anycloud:generation-id' }],
          },
          'list-access-keys': { AccessKeyMetadata: [{ AccessKeyId: 'AK1' }] },
          'list-user-policies': { PolicyNames: ['AnycloudAccess'] },
          'list-attached-user-policies': { AttachedPolicies: [] },
        }[verb!] ?? {},
      );
    }
    if (cli === 'gcloud') {
      if (args[0] === 'config') return 'p1\n';
      if (args[0] === 'projects') return '';
      const name = args[3]!.split('@')[0]!;
      if (!live.has(name)) throw absent(line, 'NOT_FOUND: Unknown');
      if (args[2] === 'delete') live.delete(name);
      return JSON.stringify({
        description: unmarked ? 'mine' : 'AnyCloud credential generation 1',
      });
    }
    if (args[0] === 'account') return 'sub-1\n';
    if (args[0] === 'role') return '';
    if (args[2] === 'delete') {
      live.delete(args[4]!.replace(/^app-/, ''));
      return '';
    }
    const name = args[4]!;
    return JSON.stringify(
      live.has(name)
        ? [
            {
              appId: `app-${name}`,
              tags: unmarked
                ? []
                : [
                    'AnycloudManaged',
                    `AnycloudCredentialName:${name.replace(/^anycloud-/, '')}`,
                  ],
            },
          ]
        : [],
    );
  };
  return { command, calls, live };
}
