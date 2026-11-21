import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { StatusReport } from '../../../src/cli/status.js';
import { GitHubError } from '../../../src/app/github.js';
import { NeedsPlan, PlanChanged, UsageError } from '../../../src/cli/errors.js';
import { PUBLIC_REPOS_LINE } from '../../../src/cli/install.js';
import { upgrade, type UpgradeDeps } from '../../../src/cli/upgrade.js';
import { runnerGroupName } from '../../../src/github/runner-group.js';
import { parseRoutes } from '../../../src/listener/routes.js';
import { planClasses } from '../../../src/runners/classes.js';
import { awsInRegions, CATALOG, catalogs } from '../runners/fixtures.js';
import {
  fakeApi,
  fakeBinary,
  fakeExec,
  fakeWorker,
  listenerVm,
  githubOrg,
  INSTALL_KEY,
  PUBLIC_REPOS,
  DEVICE,
  GITHUB_TOKEN,
  NEXT_DEVICE,
  SIGNED_IN,
  versionMismatch,
} from './fakes.js';

const HOSTED = 'https://c1.anycloud.sh';
const RELEASE = {
  backmesh: '1.1.0',
  anycloud: '0.1.72',
  runnerImage: `ghcr.io/backmesh/backmesh-runner@sha256:${'a'.repeat(64)}`,
  listenerImage: `ghcr.io/backmesh/backmesh-listener@sha256:${'b'.repeat(64)}`,
};
const OLD_LISTENER = `ghcr.io/backmesh/backmesh-listener@sha256:${'c'.repeat(64)}`;
const STATUS = { warnings: [] } as unknown as StatusReport;
// The classes install plans for aws:us-east-2 (BACKMESH_RUNNERS).
const RUNNERS = JSON.stringify(
  planClasses(
    [{ cloud: 'aws', region: 'us-east-2', credentials: 'bm-aws' }],
    catalogs({ aws: CATALOG.aws }),
    'aws',
  ).classes,
);
// The Worker's status answer for an accepted key.
const ACCEPTED = { org_id: 7 };

const watched = (state: string, lastError: string | null = null) =>
  [
    { healthy: true, release: { upgrade: { state: 'starting' } } },
    { healthy: true, release: { upgrade: { state, lastError } } },
  ]
    .map((line) => JSON.stringify(line))
    .join('\n');

// The control plane's quota status: each region's spot and on-demand
// vCPU limits, as anycloud keys them.
function quotaStatus(
  routes: object,
  limits: Record<string, [spot: number, onDemand: number]>,
) {
  const current = (region: string, resourceKey: string, limit: number) => ({
    cloud: 'AWS',
    kind: 'current',
    region,
    resourceKey,
    resourceName: resourceKey,
    status: 'CURRENT',
    currentLimit: limit,
  });
  (routes as Record<string, unknown>)['GET /v1/quota/status'] = {
    entries: Object.entries(limits).flatMap(([region, [spot, onDemand]]) => [
      current(region, 'aws:l-34b43a08', spot),
      current(region, 'aws:l-1216c47a', onDemand),
    ]),
  };
}

// Each org's listener VM, and what its Secret holds beside the runners.
const VM: Record<string, string> = {
  acme: 'bml-l8u5e-aaaaaa',
  beta: 'bml-8278o-bbbbbb',
};
const TAG: Record<string, string> = { acme: 'l8u5e', beta: '8278o' };
const ORG_ID: Record<string, number> = { acme: 7, beta: 8 };
const GROUP = 'backmesh-l8u5e-k3j9x0';
const TOKEN = 'acapi_service';
// The org's Secret as upgrade saves it for this release.
const secretOf = (org: string, over: Record<string, string> = {}) => ({
  ORG: org,
  ORG_ID: String(ORG_ID[org]),
  BACKMESH_INSTALL: TAG[org]!,
  BACKMESH_LISTENER_IMAGE: RELEASE.listenerImage,
  BACKMESH_RUNNER_GROUP: GROUP,
  ANYCLOUD_API_URL: HOSTED,
  ANYCLOUD_API_TOKEN: TOKEN,
  BACKMESH_RUNNER_IMAGE: RELEASE.runnerImage,
  BACKMESH_INSTALL_KEY: INSTALL_KEY,
  BACKMESH_RUNNERS: RUNNERS,
  ...over,
});
const LISTENING = {
  installed: true,
  broker: null,
  runners: 0,
  cap: 500,
  scaleSets: [],
};
// The values a roll's command writes, base64 in it (`rollCommand`).
const rolledValues = (command: string) => {
  const b64 = /printf %s '([^']*)' \| base64 -d/.exec(command)?.[1];
  if (b64 === undefined) return undefined;
  return Object.fromEntries(
    Buffer.from(b64, 'base64')
      .toString()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const i = line.indexOf('=');
        return [line.slice(0, i), line.slice(i + 1)];
      }),
  );
};

// One listener as `anycloud exec` reaches it: its environment, whether it
// answers, and its `/status`.
interface Host {
  org: string;
  env?: Record<string, string>;
  // The Secret as the VM got it at create (`vm --secret`).
  created?: Record<string, string>;
  up: boolean;
  // A listener that never answers, even started again.
  stuck?: boolean;
  body: object;
}

function setUp({
  version = '0.1.70',
  image = OLD_LISTENER,
  runnerImage = 'ghcr.io/backmesh/backmesh-runner@sha256:old',
  watch = watched('running'),
  keyStatus = Response.json(ACCEPTED),
  installs,
  // 'down' answers nothing, even started again; 'no-key' is a listener
  // from before install keys.
  listener,
  // A second org's listener on the same control plane.
  beta = false,
  // beta's listener is still a Deployment on `bm-control` too.
  betaMoves = false,
  // The listener's BACKMESH_RUNNERS; null: one from before VM Jobs.
  runners = RUNNERS as string | null,
  // The install region's catalog.
  catalog = CATALOG.aws,
  // An unfinished `rotate-key` rotation's marker, already on the listener.
  rotatingFrom,
  // bm-aws's cache buckets, when an install made them.
  cacheBuckets,
  // Where acme's listener runs: its VM, a VM anycloud found gone, still
  // a Deployment on `bm-control` (one from before its VM), or that
  // Deployment with the VM a stopped move made, its listener not started.
  host = 'vm',
  // acme's listener's `/status` beyond its defaults.
  body = {},
}: {
  cacheBuckets?: string[];
  catalog?: typeof CATALOG.aws;
  beta?: boolean;
  betaMoves?: boolean;
  runners?: string | null;
  installs?: (Response | Error)[];
  listener?: 'down' | 'no-key';
  version?: string;
  image?: string;
  // null: a listener from before the release Secret.
  runnerImage?: string | null;
  watch?: string;
  keyStatus?: Response | Error | (Response | Error)[];
  rotatingFrom?: string;
  host?: 'vm' | 'lost' | 'deployment' | 'both';
  body?: object;
} = {}) {
  const envOf = (org: string, mine: boolean): Record<string, string> => ({
    ORG: org,
    ...(mine
      ? {
          ...(runnerImage !== null && { BACKMESH_RUNNER_IMAGE: runnerImage }),
          ...(listener !== 'no-key' && { BACKMESH_INSTALL_KEY: INSTALL_KEY }),
        }
      : {
          BACKMESH_RUNNER_IMAGE: RELEASE.runnerImage,
          BACKMESH_INSTALL_KEY: INSTALL_KEY,
        }),
    ...(runners !== null && { BACKMESH_RUNNERS: runners }),
    ...(rotatingFrom && { BACKMESH_ROTATING_FROM: rotatingFrom }),
    // A Deployment's image is its own, and it has no runner group or token.
    ...(!(mine ? host === 'deployment' || host === 'both' : betaMoves) && {
      BACKMESH_LISTENER_IMAGE: mine ? image : OLD_LISTENER,
      BACKMESH_RUNNER_GROUP: GROUP,
      ANYCLOUD_API_TOKEN: TOKEN,
    }),
  });
  const hosts = new Map<string, Host>();
  const onDeployment = host === 'deployment' || host === 'both';
  const acmeId = onDeployment ? 'dep-acme' : VM.acme!;
  hosts.set(acmeId, {
    org: 'acme',
    env: host === 'lost' ? undefined : envOf('acme', true),
    up: host !== 'lost' && listener !== 'down',
    stuck: listener === 'down',
    body: { ...LISTENING, ...body },
  });
  if (host === 'both') {
    hosts.set(VM.acme!, { org: 'acme', up: false, body: LISTENING });
  }
  if (beta) {
    hosts.set(betaMoves ? 'dep-beta' : VM.beta!, {
      org: 'beta',
      env: envOf('beta', false),
      up: true,
      body: LISTENING,
    });
  }
  // Each org's Secret as last saved; a lost VM's was saved before it.
  const secrets: Record<string, Record<string, string>> = {
    ...(host === 'lost' && { 'backmesh-acme': envOf('acme', true) }),
  };
  const workloads: object[] = [
    ...(host === 'vm' || host === 'both'
      ? [listenerVm('acme', VM.acme!)]
      : host === 'lost'
        ? [
            // Whatever size its install took there.
            listenerVm('acme', VM.acme!, {
              state: 'failed',
              region: 'us-east-2',
              vmType: 't3.medium',
            }),
          ]
        : []),
    ...(beta && !betaMoves ? [listenerVm('beta', VM.beta!)] : []),
  ];
  const deployment = (org: string) => ({
    id: `dep-${org}`,
    name: `backmesh-${org}`,
    managed: false,
    nodePoolId: 'np-1',
    deletedAt: null as number | null,
    image: org === 'acme' ? image : OLD_LISTENER,
  });
  const deployments = [
    ...(onDeployment ? [deployment('acme')] : []),
    ...(beta && betaMoves ? [deployment('beta')] : []),
  ];
  const binary = fakeBinary({
    'vm-types aws us-east-2': JSON.stringify(catalog),
    'vm-types aws us-east-1': JSON.stringify(CATALOG.aws),
    'vm-types aws us-west-2': JSON.stringify(CATALOG.aws),
    'vm-types gcp us-central1': JSON.stringify(CATALOG.gcp),
    'api status --json': JSON.stringify({ url: HOSTED }),
    'api token': 't0ken',
    'api status --watch --json': watch,
    'api access add --service': JSON.stringify({ token: 'acapi_issued' }),
    'api token rotate --service': JSON.stringify({ token: 'acapi_rotated' }),
    'credentials list --json': JSON.stringify([{ name: 'bm-aws' }]),
  });
  // The API serves `version` until `api upgrade`, and refuses this
  // release's client on every read before then if it's older.
  let served = version;
  // A request at the served version is taken, as is any once it's this
  // release's.
  const refusal = (request?: Request) =>
    served === RELEASE.anycloud ||
    request?.headers.get('anycloud-client-version') === served
      ? undefined
      : versionMismatch(RELEASE.anycloud, served);
  const { calls } = binary;
  const run = async (args: string[]) => {
    const out = await binary.run(args);
    if (args[0] === 'api' && args[1] === 'upgrade') served = RELEASE.anycloud;
    // The binary's reads through the hosted API (`cluster list`).
    const refused = args[0] === 'cluster' && refusal();
    if (refused) {
      throw new Error(((await refused.json()) as { message: string }).message);
    }
    if (args[0] === 'vm') {
      const id = args[args.indexOf('--id') + 1]!;
      const secret = args[args.indexOf('--secret') + 1]!;
      const org = secret.replace('backmesh-', '');
      hosts.set(id, {
        org,
        created: secrets[secret],
        up: false,
        body: LISTENING,
      });
      workloads.push(listenerVm(org, id));
    }
    if (args[0] === 'deployment' && args[1] === 'delete') {
      for (const d of deployments) if (d.id === args[2]) d.deletedAt = 1;
    }
    return out;
  };
  // Hooks a test sets: a roll's values that fail, a start that fails.
  const hooks: {
    roll?: (values: Record<string, string>) => boolean;
  } = {};
  // `anycloud exec`'s route, as each listener answers it; recorded in
  // `calls` as `status <id>`, `roll <id>` or `start <id>`.
  const { exec } = fakeExec((id, command) => {
    const refused = refusal();
    if (refused) return new Error('Client/API version mismatch.');
    const target = hosts.get(id);
    if (!target) return new Error(`Workload or Deployment not found`);
    const values = rolledValues(command);
    if (values) {
      calls.push(`roll ${id}`);
      if (hooks.roll?.(values))
        return { code: 1, stdout: '', stderr: 'Error: rollout failed\n' };
      target.env = values;
      target.up = !target.stuck;
      return '';
    }
    if (command.startsWith('set -e')) {
      calls.push(`start ${id}`);
      target.env ??= target.created;
      target.up = !target.stuck;
      return '';
    }
    calls.push(`status ${id}`);
    if (!target.up) {
      return { code: 1, stdout: '', stderr: 'Error: No such container\n' };
    }
    return JSON.stringify({ code: 200, env: target.env, body: target.body });
  });
  const routes = {
    'GET /v1/node-pools': {
      nodePools: deployments.length
        ? [
            {
              id: 'np-1',
              name: 'bm-control',
              state: 'running',
              allowPrivilegedJobs: false,
              cloudProvider: 'AWS',
              region: 'us-east-2',
            },
          ]
        : [],
    },
    'GET /v1/deployments': () => ({ deployments }),
    'GET /v1/workloads': () => workloads,
    'GET /v1/secrets': () =>
      Object.keys(secrets).map((name) => ({
        name,
        createdAt: 1,
        updatedAt: 1,
      })),
    ...(cacheBuckets && {
      'GET /v1/credentials/bm-aws/buckets': {
        buckets: cacheBuckets.map((name) => ({
          name,
          region: null,
          createdAt: null,
        })),
        nextCursor: null,
      },
    }),
    'PUT /v1/secrets/backmesh-acme': (body: string) => {
      secrets['backmesh-acme'] = JSON.parse(body).values;
      return {};
    },
    'PUT /v1/secrets/backmesh-beta': (body: string) => {
      secrets['backmesh-beta'] = JSON.parse(body).values;
      return {};
    },
  };
  const { api, requests } = fakeApi(routes, refusal);
  const lines: string[] = [];
  // The broker mints each org's token in turn, as its App is installed.
  const token = (login: string) =>
    Response.json({
      token: 'ghs_1',
      expires_at: '2026-11-06T13:00:00Z',
      permissions: {},
      org: { id: 7, login },
    });
  const worker = fakeWorker({
    status: Array.isArray(keyStatus) ? keyStatus : [keyStatus],
    installs,
    tokens: beta ? [token('acme'), token('beta')] : [token('acme')],
    // The first code expires before anyone enters it.
    codes: [Response.json(DEVICE), Response.json(NEXT_DEVICE)],
    polls: [Response.json({ error: 'expired_token' }), GITHUB_TOKEN],
  });
  const deps: UpgradeDeps = {
    // No saved anycloud files, whatever this machine holds.
    env: { BACKMESH_ANYCLOUD_DIR: mkdtempSync(join(tmpdir(), 'backmesh-')) },
    signInCheck: async () => ({ login: 'octocat', appIds: [] }),
    run,
    runLong: run,
    release: async () => RELEASE,
    status: async () => STATUS,
    print: (line) => lines.push(line),
    // An older client's reads go to the same routes with its header.
    api: (_url, _token, _fetch, _refresh, clientVersion) =>
      clientVersion ? fakeApi(routes, refusal, clientVersion).api : api,
    exec: () => exec,
    fetch: async (url, init) =>
      /^https:\/\/(api(-staging)?\.backmesh\.com|github\.com)\//.test(
        String(url),
      )
        ? worker.fetch(url, init)
        : String(url).startsWith('https://api.github.com/')
          ? githubOrg(new URL(String(url)).pathname)
          : Response.json({ version: served }),
    wait: async () => {},
    // `version`'s default is the release before RELEASE.anycloud.
    previous: '0.1.70',
    features: {
      'release-1': '0.1.0',
      c26: '0.1.0',
      'role-connections': '0.1.0',
      'role-apply': '0.1.0',
      'vm-job-regions': undefined,
      'service-tokens': '0.1.0',
      c28: undefined,
    },
  };
  return {
    deps,
    calls,
    requests,
    lines,
    worker,
    routes,
    hooks,
    hosts,
    workloads,
    secrets,
  };
}

const ROLL = `roll ${VM.acme}`;
const rolledAny = (calls: string[]) => calls.some((c) => c.startsWith('roll '));
const mutations = (calls: string[]) =>
  calls.filter((c) =>
    /^(api upgrade|api status --watch|api access|api token rotate|deployment|node-pool|vm |roll |start )/.test(
      c,
    ),
  );
// The values each PUT of `name`'s Secret saved.
const saved = (requests: string[], name = 'backmesh-acme') =>
  requests
    .filter((r) => r.startsWith(`PUT /v1/secrets/${name} `))
    .map(
      (r) =>
        (
          JSON.parse(r.slice(r.indexOf(' {'))) as {
            values: Record<string, string>;
          }
        ).values,
    );

describe('upgrade', () => {
  it('signs in again when the hosted API refuses its token, as status and uninstall do', async () => {
    const { deps, lines } = setUp();
    const api = deps.api!;
    let refresh: ((refusal: unknown) => Promise<string>) | undefined;
    deps.api = (...args) => {
      refresh = args[3];
      return api(...args);
    };
    // anycloud's login relays a device code until backmesh has signed in.
    const dir = deps.env.BACKMESH_ANYCLOUD_DIR!;
    writeFileSync(join(dir, '.token'), 'ghu_revoked\n');
    deps.signInCheck = async (token) => {
      if (token === 'ghu_revoked')
        throw new GitHubError(401, 'Bad credentials');
      return { login: 'octocat', appIds: [] };
    };
    const run = deps.run;
    const logins: string[] = [];
    deps.run = async (args) => {
      if (args[0] !== 'login') return run(args);
      logins.push(args.join(' '));
      if (readFileSync(join(dir, '.token'), 'utf8').startsWith('ghu_revoked')) {
        throw Object.assign(new Error('Command failed: anycloud login'), {
          stdout: `${JSON.stringify({ actionRequired: { code: 'GITHUB_SIGN_IN_REQUIRED' } })}\n`,
        });
      }
      return '';
    };
    await upgrade(deps);
    // The fake API never refuses, so the refusal is handed in.
    await refresh!(undefined);
    expect(logins).toEqual([`login ${HOSTED}`, `login ${HOSTED}`]);
    expect(lines).toContain(
      `The saved GitHub sign-in expired or was revoked. backmesh signs in again.`,
    );
    expect(readFileSync(join(dir, '.token'), 'utf8')).toBe(`${SIGNED_IN}\n`);
  });

  it('keeps the listener on the Worker the CLI signs in through', async () => {
    const { deps, requests } = setUp();
    deps.env.BACKMESH_API_URL = 'https://api-staging.backmesh.com';
    await upgrade(deps);
    const secret = requests.find((r) =>
      r.startsWith('PUT /v1/secrets/backmesh-acme '),
    )!;
    expect(JSON.parse(secret.split(' ')[2]!).values).toMatchObject({
      BACKMESH_API_URL: 'https://api-staging.backmesh.com',
    });
  });

  it("upgrades the API, then rolls the listener with this release's classes", async () => {
    const { deps, calls, requests, hosts } = setUp();
    const result = await upgrade(deps);

    expect(mutations(calls)).toEqual([
      'api upgrade --sign-in-apps 5622376',
      'api status --watch --json',
      ROLL,
    ]);
    // The Secret, then the same values written to the VM.
    expect(saved(requests)).toEqual([secretOf('acme')]);
    expect(hosts.get(VM.acme!)!.env).toEqual(secretOf('acme'));
    // A listener from before the cache gets its region's bucket, checked
    // with a test mint.
    expect(requests.filter((r) => /^(POST|PUT \/v1\/cred)/.test(r))).toEqual([
      'PUT /v1/credentials/bm-aws/buckets/bm-cache-l8u5e-us-east-2?region=us-east-2',
      `POST /v1/credentials/bm-aws/storage-tokens?region=us-east-2 ${JSON.stringify({ lifetimeSeconds: 60, grants: [{ bucket: 'bm-cache-l8u5e-us-east-2', prefix: 'cache/', mode: 'read' }] })}`,
    ]);
    expect(result).toMatchObject({
      controlPlane: { from: '0.1.70', to: '0.1.72', upgraded: true },
      listeners: [{ org: 'acme', rolled: true }],
      status: STATUS,
    });
  });

  it('says a cancel came after it started a listener again', async () => {
    const { deps, routes, hosts } = setUp({
      version: RELEASE.anycloud,
      image: RELEASE.listenerImage,
      runnerImage: RELEASE.runnerImage,
    });
    quotaStatus(routes, { 'us-east-2': [2, 2] });
    hosts.get(VM.acme!)!.up = false;
    deps.confirm = async () => false;
    await expect(upgrade(deps)).rejects.toThrow(
      "Upgrade cancelled after acme's listener started again, with no other listener changed; raise the quotas named above",
    );
  });

  it('names a label that would start no runners, and asks before anything changes, no unless yes', async () => {
    const { deps, calls, lines, routes } = setUp({
      version: RELEASE.anycloud,
      image: RELEASE.listenerImage,
      runnerImage: RELEASE.runnerImage,
    });
    const tight = { 'us-east-2': [2, 2] as [number, number] };
    quotaStatus(routes, tight);
    const confirm = vi.fn(async () => false);
    deps.confirm = confirm;
    await expect(upgrade(deps)).rejects.toThrow(
      'Upgrade cancelled before anything changed. Raise the quotas named above, then run `backmesh upgrade` again.',
    );
    expect(lines).toContain(
      "acme: backmesh-4 would start no runners: every runner region's spot quota is under one 4-vCPU runner (us-east-2 2 vCPU); raise L-34B43A08 in us-east-2 to use it.",
    );
    expect(confirm).toHaveBeenCalledOnce();
    expect(mutations(calls)).toEqual([]);
    // Without a terminal it says so and goes on.
    const plain = setUp({
      version: RELEASE.anycloud,
      image: RELEASE.listenerImage,
      runnerImage: RELEASE.runnerImage,
    });
    quotaStatus(plain.routes, tight);
    await upgrade(plain.deps);
    expect(plain.lines.some((l) => l.includes('would start no runners'))).toBe(
      true,
    );
    // `--yes` at a terminal doesn't ask either.
    const yes = setUp({
      version: RELEASE.anycloud,
      image: RELEASE.listenerImage,
      runnerImage: RELEASE.runnerImage,
    });
    quotaStatus(yes.routes, tight);
    const unasked = vi.fn(async () => false);
    yes.deps.confirm = unasked;
    await upgrade(yes.deps, { yes: true });
    expect(unasked).not.toHaveBeenCalled();
    // After the control plane moved, the cancel says so.
    const moved = setUp();
    quotaStatus(moved.routes, tight);
    moved.deps.confirm = async (q) => q === 'Proceed?';
    await expect(upgrade(moved.deps)).rejects.toThrow(
      'Upgrade cancelled after the control plane updated, with no listener changed; raise the quotas named above, then run `backmesh upgrade` again.',
    );
    expect(mutations(moved.calls)).toContain(
      'api upgrade --sign-in-apps 5622376',
    );
    expect(rolledAny(moved.calls)).toBe(false);
  });

  it("upgrades an older API first, checks every org's key, then rolls each org's listener in turn", async () => {
    const { deps, calls, requests } = setUp({ beta: true });
    const result = await upgrade(deps);

    const order = calls.filter((c) => /^(status|api upgrade|roll)/.test(c));
    // An older API reads nothing for this release's client until it moves.
    expect(order[0]).toBe('api upgrade --sign-in-apps 5622376');
    // Every org is read once before any roll; each roll is then read again.
    expect(order.slice(1)).toEqual([
      `status ${VM.acme}`,
      `status ${VM.beta}`,
      ROLL,
      `status ${VM.acme}`,
      `roll ${VM.beta}`,
      `status ${VM.beta}`,
    ]);
    expect(saved(requests, 'backmesh-beta')).toEqual([secretOf('beta')]);
    expect(result.listeners).toEqual([
      { org: 'acme', image: RELEASE.listenerImage, rolled: true },
      { org: 'beta', image: RELEASE.listenerImage, rolled: true },
    ]);
  });

  it("stops at the first org whose roll fails, before the next org's", async () => {
    const { deps, calls, hooks } = setUp({ beta: true });
    hooks.roll = (values) =>
      values.ORG === 'acme' &&
      values.BACKMESH_LISTENER_IMAGE === RELEASE.listenerImage;
    await expect(upgrade(deps)).rejects.toThrow("acme's listener's roll");
    expect(calls).not.toContain(`roll ${VM.beta}`);
  });

  it("starts a listener that doesn't answer again, and refuses before any roll when it still doesn't", async () => {
    const { deps, calls, hosts } = setUp({
      version: RELEASE.anycloud,
      beta: true,
    });
    Object.assign(hosts.get(VM.beta!)!, { up: false, stuck: true });
    await expect(upgrade(deps)).rejects.toThrow(
      `beta's listener didn't start on ${VM.beta}.`,
    );
    expect(mutations(calls)).toEqual([`start ${VM.beta}`]);

    // One that answers once started goes on as any other.
    const restarted = setUp({ version: RELEASE.anycloud, beta: true });
    restarted.hosts.get(VM.beta!)!.up = false;
    await upgrade(restarted.deps);
    expect(mutations(restarted.calls)).toEqual([
      `start ${VM.beta}`,
      ROLL,
      `roll ${VM.beta}`,
    ]);
    expect(restarted.lines).toContain(
      `Starting beta's listener on ${VM.beta} again.`,
    );
  });

  it('changes nothing when the API, the images and the classes already match', async () => {
    const { deps, calls, requests } = setUp({
      version: '0.1.72',
      image: RELEASE.listenerImage,
      runnerImage: RELEASE.runnerImage,
      cacheBuckets: ['bm-cache-l8u5e-us-east-2'],
    });
    const result = await upgrade(deps);
    expect(mutations(calls)).toEqual([]);
    expect(requests.filter((r) => !r.startsWith('GET'))).toEqual([]);
    expect(result).toMatchObject({
      controlPlane: { upgraded: false },
      listeners: [{ org: 'acme', rolled: false }],
    });
  });

  it("keeps an install's public classes (install --public-repos)", async () => {
    const withPublic = JSON.stringify(
      planClasses(
        [{ cloud: 'aws', region: 'us-east-2', credentials: 'bm-aws' }],
        catalogs({ aws: CATALOG.aws }),
        'aws',
        true,
      ).classes,
    );
    const { deps, calls, requests } = setUp({
      version: '0.1.72',
      image: RELEASE.listenerImage,
      runnerImage: RELEASE.runnerImage,
      runners: withPublic,
      cacheBuckets: ['bm-cache-l8u5e-us-east-2'],
    });
    await upgrade(deps);
    expect(mutations(calls)).toEqual([]);
    expect(requests.filter((r) => !r.startsWith('GET'))).toEqual([]);
  });

  // Our own installs gain them this way: install refuses a re-run's
  // sign-in that upgrade takes.
  it('adds the public classes with --public-repos, and names the public repos that need them', async () => {
    PUBLIC_REPOS.acme = ['acme/site'];
    try {
      const { deps, lines, secrets } = setUp({
        version: '0.1.72',
        image: RELEASE.listenerImage,
        runnerImage: RELEASE.runnerImage,
        cacheBuckets: ['bm-cache-l8u5e-us-east-2'],
      });
      await upgrade(deps, { plan: true });
      expect(lines).toContain(
        "acme: 1 public repository (such as acme/site) can't use these runners, and their jobs wait at GitHub. `backmesh upgrade --public-repos` adds backmesh-public-2 and backmesh-public-4 for them to use.",
      );
      lines.length = 0;
      const plan = await upgrade(deps, { plan: true, publicRepos: true });
      expect(lines).toContain(PUBLIC_REPOS_LINE);
      expect(lines.join('\n')).not.toContain('public repository (such as');
      expect(lines.join('\n')).toContain('backmesh-public-4');
      await upgrade(deps, {
        publicRepos: true,
        yes: true,
        planId: 'planId' in plan ? plan.planId : '',
      });
      const publicRoutes = () =>
        parseRoutes(secrets['backmesh-acme']!.BACKMESH_RUNNERS!)
          .filter((r) => r.public)
          .map(({ label, retiring }) => [label, !!retiring]);
      expect(publicRoutes()).toEqual([
        ['backmesh-public-2', false],
        ['backmesh-public-4', false],
      ]);

      // --no-public-repos retires them like any dropped class.
      const off = await upgrade(deps, { plan: true, publicRepos: false });
      await upgrade(deps, {
        publicRepos: false,
        yes: true,
        planId: 'planId' in off ? off.planId : '',
      });
      expect(publicRoutes()).toEqual([
        ['backmesh-public-2', true],
        ['backmesh-public-4', true],
      ]);
    } finally {
      delete PUBLIC_REPOS.acme;
    }
  });

  it("rolls a current listener whose classes this release's catalog changes", async () => {
    const stale = JSON.parse(RUNNERS) as { vmTypes: string[] }[];
    stale[0]!.vmTypes = ['m5.large'];
    const { deps, calls, requests } = setUp({
      version: '0.1.72',
      image: RELEASE.listenerImage,
      runnerImage: RELEASE.runnerImage,
      runners: JSON.stringify(stale),
    });
    // A label's new VM types are a change to the runners: it asks first.
    const asked: string[] = [];
    deps.confirm = async (question) => {
      asked.push(question);
      return true;
    };
    const result = await upgrade(deps);
    expect(asked).toEqual(['Proceed?']);
    expect(mutations(calls)).toEqual([ROLL]);
    expect(
      requests.findLast((r) => r.startsWith('PUT /v1/secrets/')),
    ).toContain(JSON.stringify(RUNNERS).slice(1, -1));
    expect(result.listeners).toEqual([
      { org: 'acme', image: RELEASE.listenerImage, rolled: true },
    ]);
  });

  it('rolls on a VM type reorder alone, with no consent asked', async () => {
    // Same types as RUNNERS, reversed order: a reorder like the release's own
    // GCP and AWS-KVM ones, with nothing added or removed.
    const reordered = (
      JSON.parse(RUNNERS) as { label: string; vmTypes: string[] }[]
    ).map((c) =>
      c.label === 'backmesh-4'
        ? { ...c, vmTypes: [...c.vmTypes].reverse() }
        : c,
    );
    const { deps, calls, requests, lines } = setUp({
      version: '0.1.72',
      image: RELEASE.listenerImage,
      runnerImage: RELEASE.runnerImage,
      runners: JSON.stringify(reordered),
      cacheBuckets: ['bm-cache-l8u5e-us-east-2'],
    });
    const asked: string[] = [];
    deps.confirm = async (question) => {
      asked.push(question);
      return true;
    };
    // `--plan` itself says a reorder is coming too, not nothing, even
    // though it can't yet know the account-allowed narrowing.
    await upgrade(deps, { plan: true });
    expect(lines).toContain("acme's VM type order updated; no consent needed.");
    expect(
      lines.filter(
        (l) => l === "acme's VM type order updated; no consent needed.",
      ),
    ).toHaveLength(1);
    lines.length = 0;
    const result = await upgrade(deps);
    expect(asked).toEqual([]);
    // Printed exactly once by the real run too (its later, narrowed
    // check), not also by its early, optimistic one.
    expect(
      lines.filter(
        (l) => l === "acme's VM type order updated; no consent needed.",
      ),
    ).toHaveLength(1);
    expect(mutations(calls)).toEqual([ROLL]);
    expect(
      requests.findLast((r) => r.startsWith('PUT /v1/secrets/')),
    ).toContain(JSON.stringify(RUNNERS).slice(1, -1));
    expect(result.listeners).toEqual([
      { org: 'acme', image: RELEASE.listenerImage, rolled: true },
    ]);
  });

  const twoRegions = () =>
    JSON.stringify(
      planClasses(
        [{ cloud: 'aws', region: 'us-east-2', credentials: 'bm-aws' }],
        new Map([
          [
            'aws',
            new Map([
              ['us-east-2', CATALOG.aws],
              ['us-west-2', CATALOG.aws],
            ]),
          ],
        ]),
        'aws',
      ).classes,
    );

  describe('the plan, when the runners change', () => {
    // multiRegion is off by default (RELEASED's 'vm-job-regions':
    // undefined): an org on two regions narrows to its anchor alone, with
    // no --runners needed, since regions are never chosen on the command
    // line (owner, 2026-11-13).
    const twoToOne = () =>
      setUp({
        version: RELEASE.anycloud,
        image: RELEASE.listenerImage,
        runnerImage: RELEASE.runnerImage,
        runners: twoRegions(),
      });

    it('prints it before any sign-in or change', async () => {
      const { deps, calls, worker, lines } = twoToOne();
      const plan = await upgrade(deps, { plan: true });
      expect(plan).toMatchObject({
        planId: expect.stringMatching(/^p-[0-9a-f]{12}$/),
        anycloud: { from: '0.1.72', to: '0.1.72' },
        orgs: [{ org: 'acme', changes: { regions: [{ cloud: 'aws' }] } }],
      });
      expect(lines).toEqual(
        expect.arrayContaining(["acme's aws runners leave us-west-2."]),
      );
      expect(worker.calls).toEqual([]);
      expect(mutations(calls)).toEqual([]);
    });

    it('needs the agreement without a terminal, and changes nothing before it', async () => {
      const { deps, calls, worker } = twoToOne();
      const error = await upgrade(deps).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NeedsPlan);
      expect((error as NeedsPlan).code).toBe('needs_plan');
      expect(worker.calls).toEqual([]);
      expect(mutations(calls)).toEqual([]);

      // --yes alone isn't an agreement to a plan.
      await expect(upgrade(twoToOne().deps, { yes: true })).rejects.toThrow(
        'pass --plan-id with --yes',
      );

      // At a terminal, a no stops it.
      const declined = twoToOne();
      declined.deps.confirm = async () => false;
      await expect(upgrade(declined.deps)).rejects.toThrow(
        'Upgrade cancelled before anything changed.',
      );
      expect(mutations(declined.calls)).toEqual([]);
    });

    it('applies the plan --plan-id names, and refuses another', async () => {
      const { planId } = (await upgrade(twoToOne().deps, {
        plan: true,
      })) as { planId: string };
      const { deps, calls } = twoToOne();
      await upgrade(deps, { yes: true, planId });
      expect(mutations(calls)).toContain(ROLL);

      // --plan-id alone still asks, and needs a terminal for it.
      const alone = twoToOne();
      await expect(upgrade(alone.deps, { planId })).rejects.toThrow(NeedsPlan);
      expect(mutations(alone.calls)).toEqual([]);
    });

    it('asks nothing when only the release moves', async () => {
      const { deps, calls } = setUp();
      await upgrade(deps);
      expect(mutations(calls)).toContain('api upgrade --sign-in-apps 5622376');
    });
  });

  it("keeps every label named when the control plane's cloud has no runners", async () => {
    const prefixed = JSON.stringify(
      planClasses(
        [{ cloud: 'aws', region: 'us-east-2', credentials: 'bm-aws' }],
        catalogs({ aws: CATALOG.aws }),
        undefined,
      ).classes,
    );
    const { deps, calls } = setUp({
      runners: prefixed,
      image: RELEASE.listenerImage,
      runnerImage: RELEASE.runnerImage,
      version: RELEASE.anycloud,
    });
    const result = await upgrade(deps);
    expect(result.listeners?.[0]?.rolled).toBe(false);
    expect(rolledAny(calls)).toBe(false);
  });

  it('refuses a --runners value with a region: regions are fixed, not chosen', async () => {
    const { deps, calls, worker } = setUp();
    await expect(upgrade(deps, { runners: ['aws:us-east-2'] })).rejects.toThrow(
      'takes a cloud only, not a region',
    );
    expect(worker.calls).toEqual([]);
    expect(mutations(calls)).toEqual([]);
  });

  it("refuses --runners for a cloud the runners don't use, before any sign-in", async () => {
    const { deps, calls, worker } = setUp({ version: RELEASE.anycloud });
    const error = await upgrade(deps, { runners: ['gcp'] }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toBe(
      "acme's runners don't use gcp: `backmesh install` adds a cloud.",
    );
    expect(mutations(calls)).toEqual([]);
    expect(worker.calls).toEqual([]);
  });

  describe('a cloud --runners leaves out', () => {
    // aws, the control plane's cloud, and gcp, as install plans them.
    const awsAndGcp = JSON.stringify(
      planClasses(
        [
          { cloud: 'aws', region: 'us-east-2', credentials: 'bm-aws' },
          { cloud: 'gcp', region: 'us-central1', credentials: 'bm-gcp' },
        ],
        catalogs({ aws: CATALOG.aws, gcp: CATALOG.gcp }),
        'aws',
      ).classes,
    );
    const labelsOf = (cloud: string) =>
      parseRoutes(awsAndGcp)
        .filter((r) => r.cloud === cloud)
        .map((r) => r.label);
    const both = () =>
      setUp({
        version: RELEASE.anycloud,
        image: RELEASE.listenerImage,
        runnerImage: RELEASE.runnerImage,
        runners: awsAndGcp,
      });
    const routesPut = (requests: string[]) =>
      parseRoutes(
        JSON.parse(
          requests
            .find((r) => r.startsWith('PUT /v1/secrets/backmesh-acme '))!
            .split(' ')[2]!,
        ).values.BACKMESH_RUNNERS,
      );
    // Anything but a read of the control pool, or the listener's roll.
    const controlPlaneChanges = (calls: string[], requests: string[]) => [
      ...mutations(calls).filter((c) => !c.startsWith('roll ')),
      ...requests.filter(
        (r) => /node-pools|cluster/.test(r) && !r.startsWith('GET '),
      ),
    ];

    it('shows the removal in the plan, and changes nothing', async () => {
      const { deps, calls, worker } = both();
      const plan = await upgrade(deps, {
        runners: ['aws'],
        plan: true,
      });
      expect(plan).toMatchObject({
        orgs: [
          {
            org: 'acme',
            changes: {
              added: [],
              removed: ['gcp'],
              labelsAdded: [],
              labelsRemoved: labelsOf('gcp'),
            },
          },
        ],
      });
      expect(labelsOf('gcp').length).toBeGreaterThan(0);
      expect(worker.calls).toEqual([]);
      expect(mutations(calls)).toEqual([]);
    });

    it('drains its labels once the plan is agreed, keeping the others', async () => {
      const options = { runners: ['aws'] };
      // Without a terminal, the removal needs the plan.
      const unagreed = both();
      await expect(upgrade(unagreed.deps, options)).rejects.toThrow(NeedsPlan);
      expect(mutations(unagreed.calls)).toEqual([]);

      const { planId } = (await upgrade(both().deps, {
        ...options,
        plan: true,
      })) as { planId: string };
      const { deps, calls, requests } = both();
      await upgrade(deps, { ...options, yes: true, planId });
      const routes = routesPut(requests);
      // gcp's classes retire: their scale sets drain, then go.
      expect(
        routes.filter((r) => r.cloud === 'gcp').map((r) => r.label),
      ).toEqual(labelsOf('gcp'));
      expect(
        routes.filter((r) => r.cloud === 'gcp').every((r) => r.retiring),
      ).toBe(true);
      expect(routes.filter((r) => !r.retiring).map((r) => r.label)).toEqual(
        labelsOf('aws'),
      );
      expect(rolledAny(calls)).toBe(true);
      expect(controlPlaneChanges(calls, requests)).toEqual([]);
    });

    it("drains the control plane's cloud's runners without touching the control plane", async () => {
      const { planId } = (await upgrade(both().deps, {
        runners: ['gcp'],
        plan: true,
      })) as { planId: string; orgs: unknown[] };
      const { deps, calls, requests } = both();
      await upgrade(deps, { runners: ['gcp'], yes: true, planId });
      const routes = routesPut(requests);
      expect(
        routes.filter((r) => r.cloud === 'aws').every((r) => r.retiring),
      ).toBe(true);
      // gcp's labels keep their names: aws stays the control plane's cloud.
      expect(routes.filter((r) => !r.retiring).map((r) => r.label)).toEqual(
        labelsOf('gcp'),
      );
      expect(controlPlaneChanges(calls, requests)).toEqual([]);
    });

    // The public labels are the control plane's cloud's, as install's.
    it("refuses --public-repos without runners on the control plane's cloud", async () => {
      await expect(
        upgrade(both().deps, { runners: ['gcp'], publicRepos: true }),
      ).rejects.toThrow(
        "--public-repos needs runners on the control plane's cloud",
      );
    });

    it('keeps every cloud without --runners', async () => {
      const { deps } = both();
      const plan = await upgrade(deps, { plan: true });
      expect(plan).toMatchObject({
        orgs: [{ changes: { removed: [], labelsRemoved: [] } }],
      });
      const applied = both();
      await upgrade(applied.deps);
      expect(rolledAny(applied.calls)).toBe(false);
      expect(mutations(applied.calls)).toEqual([]);
    });
  });

  it("checks the quotas of the regions it's upgrading to, before any sign-in", async () => {
    const { deps, lines, routes } = setUp({
      version: RELEASE.anycloud,
      image: RELEASE.listenerImage,
      runnerImage: RELEASE.runnerImage,
      runners: twoRegions(),
      listener: 'no-key',
    });
    // us-east-2 fits no runner, us-west-2 fits them all.
    const limits = {
      'us-east-2': [2, 2] as [number, number],
      'us-west-2': [400, 400] as [number, number],
    };
    quotaStatus(routes, limits);
    // Yes to the runner change, no to the quota question. multiRegion is
    // off by default: the runners narrow to us-east-2 alone, which fits
    // no runner.
    const confirm = vi.fn(async (q: string) => q === 'Proceed?');
    deps.confirm = confirm;
    await expect(upgrade(deps)).rejects.toThrow(
      'Upgrade cancelled before anything changed.',
    );
    expect(
      lines.some((l) => l.includes('backmesh-4 would start no runners')),
    ).toBe(true);
    // Asked before the sign-in an install without a key needs.
    expect(lines.some((l) => l.includes('so upgrade asks for it now'))).toBe(
      false,
    );
    // With multiRegion on, the runners keep both; us-west-2 fits: nothing
    // to ask.
    const both = setUp({
      version: RELEASE.anycloud,
      image: RELEASE.listenerImage,
      runnerImage: RELEASE.runnerImage,
      runners: twoRegions(),
    });
    both.deps.features = {
      ...both.deps.features!,
      'vm-job-regions': '0.1.0',
      'service-tokens': '0.1.0',
    };
    quotaStatus(both.routes, limits);
    both.deps.confirm = confirm;
    await upgrade(both.deps);
    expect(confirm.mock.calls.filter(([q]) => q !== 'Proceed?')).toHaveLength(
      1,
    );
  });

  describe('with VM Job region lists', () => {
    // An install from before fixed regions: one region, though the
    // others offer the same types too (owner, 2026-11-13).
    const wide = () =>
      setUp({
        version: '0.1.72',
        image: RELEASE.listenerImage,
        runnerImage: RELEASE.runnerImage,
        catalog: awsInRegions({ 'us-east-1': 1, 'us-west-2': 1 }),
      });
    const regions = (deps: UpgradeDeps) => {
      deps.features = { ...deps.features!, 'vm-job-regions': '0.1.0' };
    };

    it('widens to every fixed candidate region once this control plane takes a list', async () => {
      const { deps, calls, lines } = wide();
      regions(deps);
      deps.confirm = async () => true;
      const result = await upgrade(deps);
      expect(calls).toContain('vm-types aws us-west-2 --details --json');
      expect(lines).toContain("acme's aws runners add us-east-1, us-west-2.");
      expect(result.listeners?.[0]?.rolled).toBe(true);
    });

    it('stays on the single anchor region without that feature, no --runners needed', async () => {
      const { deps, calls, lines } = wide();
      const result = await upgrade(deps);
      expect(calls).not.toContain('vm-types aws us-west-2 --details --json');
      expect(lines.some((l) => l.includes('runners add'))).toBe(false);
      expect(result.listeners?.[0]?.rolled).toBe(false);
    });
  });

  it('refuses a listener from before VM Jobs before any sign-in or change', async () => {
    // No classes and no install key: the refusal comes before the key's sign-in.
    const { deps, calls, requests, lines } = setUp({
      version: RELEASE.anycloud,
      runners: null,
      listener: 'no-key',
    });
    await expect(upgrade(deps)).rejects.toThrow(
      "acme's listener has no labels, so it's from before VM Jobs. Run `backmesh uninstall`, then `backmesh install`.",
    );
    expect(lines).toEqual([]);
    expect(mutations(calls)).toEqual([]);
    expect(requests.filter((r) => !r.startsWith('GET'))).toEqual([]);
  });

  it('refuses a local API before reading its token', async () => {
    const { deps, calls } = setUp();
    const run = deps.run;
    deps.run = async (args) =>
      args.join(' ') === 'api status --json'
        ? JSON.stringify({ url: 'http://localhost:8080' })
        : run(args);
    await expect(upgrade(deps)).rejects.toThrow(/has no backmesh installation/);
    expect(mutations(calls)).toEqual([]);
  });

  it('refuses an API newer than this release pins', async () => {
    const { deps, calls } = setUp({ version: '0.2.0' });
    await expect(upgrade(deps)).rejects.toThrow(/ahead of this backmesh/);
    expect(mutations(calls)).toEqual([]);
  });

  it('leaves the old listener when the API upgrade fails', async () => {
    const { deps, calls } = setUp({
      watch: watched('failed', 'chart refused'),
    });
    await expect(upgrade(deps)).rejects.toThrow(
      'The control plane upgrade failed: chart refused; run `backmesh upgrade` again.',
    );
    expect(rolledAny(calls)).toBe(false);
  });

  it('rolls back to the old image when the roll fails', async () => {
    const { deps, calls, requests, hooks, hosts } = setUp({
      version: '0.1.72',
    });
    hooks.roll = (values) =>
      values.BACKMESH_LISTENER_IMAGE === RELEASE.listenerImage;
    await expect(upgrade(deps)).rejects.toThrow(
      `failed, and it's back on ${OLD_LISTENER}. Run upgrade again.`,
    );
    expect(mutations(calls)).toEqual([ROLL, ROLL]);
    // The old listener gets its own image and runner image back.
    const old = {
      BACKMESH_LISTENER_IMAGE: OLD_LISTENER,
      BACKMESH_RUNNER_IMAGE: 'ghcr.io/backmesh/backmesh-runner@sha256:old',
    };
    expect(saved(requests).at(-1)).toEqual(secretOf('acme', old));
    expect(hosts.get(VM.acme!)!.env).toEqual(secretOf('acme', old));
  });

  // rollListener's restore must still run when only the runners (classes)
  // changed and the image didn't: converge.ts's "nothing to restore"
  // no-op check (added for rotate-key, whose two calls never change the
  // image, runner image or classes together) must not also skip a real
  // prior state `upgrade` has to roll back to.
  it('rolls back to the old runners when the roll fails and only the runners changed, with the image unchanged', async () => {
    const { deps, requests, hooks } = setUp({
      version: '0.1.72',
      image: RELEASE.listenerImage,
      runnerImage: RELEASE.runnerImage,
      runners: twoRegions(),
    });
    deps.confirm = async () => true;
    let rolls = 0;
    // Only the first (forward) roll fails; the restore attempt, which
    // rolls to the very same image, succeeds.
    hooks.roll = () => ++rolls === 1;

    await expect(upgrade(deps)).rejects.toThrow(
      `failed, and it's back on ${RELEASE.listenerImage}. Run upgrade again.`,
    );

    expect(rolls).toBe(2);
    // The Secret rolls back to the old runners (both regions), not the
    // narrowed one the failed roll attempted.
    const secret = requests
      .filter((r) => r.startsWith('PUT /v1/secrets/backmesh-acme '))
      .at(-1)!;
    const routes = parseRoutes(
      JSON.parse(secret.split(' ')[2]!).values.BACKMESH_RUNNERS,
    );
    expect(routes[0]).toMatchObject({ regions: ['us-east-2', 'us-west-2'] });
  });

  it('rolls a listener from before the release Secret back without a runner image', async () => {
    const { deps, requests, hooks } = setUp({
      version: '0.1.72',
      runnerImage: null,
    });
    hooks.roll = (values) =>
      values.BACKMESH_LISTENER_IMAGE === RELEASE.listenerImage;
    await expect(upgrade(deps)).rejects.toThrow(`it's back on ${OLD_LISTENER}`);
    // Its built-in runner image applies again; the org stays.
    const { BACKMESH_RUNNER_IMAGE: _, ...restored } = secretOf('acme', {
      BACKMESH_LISTENER_IMAGE: OLD_LISTENER,
    });
    expect(saved(requests).at(-1)).toEqual(restored);
  });

  it.each([
    ['accepted', Response.json(ACCEPTED)],
    ['unreachable', new TypeError('fetch failed')],
    ['answering 500', new Response('', { status: 500 })],
    ['malformed', Response.json({ state: 'paid' })],
  ])(
    'proceeds with no new sign-in when the key check is %s',
    async (_, keyStatus) => {
      const { deps, calls, worker } = setUp({ keyStatus });

      await upgrade(deps);

      expect(mutations(calls)).toHaveLength(3);
      expect(worker.calls).toEqual(['GET /v1/status', 'POST /v1/token']);
    },
  );

  const savedKey = (requests: string[]) => {
    const saved = requests.find((r) =>
      r.startsWith('PUT /v1/secrets/backmesh-acme'),
    );
    return JSON.parse(saved!.split(' ')[2]!).values.BACKMESH_INSTALL_KEY;
  };

  // Images already current: only the new key makes the roll.
  const current = {
    image: RELEASE.listenerImage,
    runnerImage: RELEASE.runnerImage,
  };
  const rolled = rolledAny;

  it('signs an older install in once, saves the new key and rolls', async () => {
    const { deps, calls, requests, worker } = setUp({
      ...current,
      listener: 'no-key',
    });

    await upgrade(deps);

    expect(worker.calls).toEqual([
      // The first code expires before anyone enters it.
      'POST github.com/login/device/code',
      'POST github.com/login/oauth/access_token',
      'POST github.com/login/device/code',
      'POST github.com/login/oauth/access_token',
      'POST /v1/installs',
      'GET /v1/status',
      'POST /v1/token',
    ]);
    expect(savedKey(requests)).toBe(INSTALL_KEY);
    expect(rolled(calls)).toBe(true);
  });

  it("carries an unfinished rotate-key rotation's marker through its own roll, never dropping it", async () => {
    const rotatingFrom = 'cd'.repeat(16);
    const { deps, requests, calls } = setUp({ rotatingFrom });

    await upgrade(deps);

    expect(rolled(calls)).toBe(true);
    const saved = requests.find((r) =>
      r.startsWith('PUT /v1/secrets/backmesh-acme'),
    );
    expect(
      JSON.parse(saved!.split(' ')[2]!).values.BACKMESH_ROTATING_FROM,
    ).toBe(rotatingFrom);
  });

  // The Worker may answer with another install (a disowned one gets a new
  // ID); the CLI saves whatever key it returns.
  const refusedKey = () =>
    setUp({
      ...current,
      keyStatus: [
        Response.json({ error: 'unknown key' }, { status: 401 }),
        Response.json(ACCEPTED),
      ],
      installs: [
        Response.json({
          install: 'cd'.repeat(16),
          key: replaced,
        }),
      ],
    });
  const replaced = `bmk_${'cd'.repeat(16)}${'ef'.repeat(16)}`;

  it('signs in again for a refused key, on a fresh code once the first expires, saves the replacement and rolls', async () => {
    const { deps, calls, requests, worker } = refusedKey();

    await upgrade(deps);

    expect(worker.signIns()).toHaveLength(2);
    expect(worker.bodies).toEqual([
      { org: 'acme', github_token: SIGNED_IN, install: 'ab'.repeat(16) },
    ]);
    expect(savedKey(requests)).toBe(replaced);
    expect(rolled(calls)).toBe(true);
    // With no sign-in saved, the key's sign-in is the control plane's too.
    const saved = join(deps.env.BACKMESH_ANYCLOUD_DIR!, '.token');
    expect(readFileSync(saved, 'utf8').trim()).toBe(SIGNED_IN);
  });

  it("keeps the control plane's sign-in when one is saved or GITHUB_TOKEN is set", async () => {
    const saved = refusedKey();
    const token = join(saved.deps.env.BACKMESH_ANYCLOUD_DIR!, '.token');
    writeFileSync(token, 'ghu_owner\n');
    await upgrade(saved.deps);
    expect(readFileSync(token, 'utf8')).toBe('ghu_owner\n');

    const ci = refusedKey();
    ci.deps.env.GITHUB_TOKEN = 'ghu_ci';
    await upgrade(ci.deps);
    const ciToken = join(ci.deps.env.BACKMESH_ANYCLOUD_DIR!, '.token');
    expect(existsSync(ciToken)).toBe(false);

    // A blank GITHUB_TOKEN is no sign-in: the key's is saved.
    const blank = refusedKey();
    blank.deps.env.GITHUB_TOKEN = ' ';
    await upgrade(blank.deps);
    const blankToken = join(blank.deps.env.BACKMESH_ANYCLOUD_DIR!, '.token');
    expect(readFileSync(blankToken, 'utf8').trim()).toBe(SIGNED_IN);
  });

  it("refuses an older install's upgrade when backmesh.com can't be reached, changing nothing", async () => {
    const { deps, calls, requests } = setUp({
      version: RELEASE.anycloud,
      listener: 'no-key',
      installs: [new TypeError('fetch failed')],
    });

    await expect(upgrade(deps)).rejects.toThrow(/reachable/);
    expect(mutations(calls)).toEqual([]);
    expect(requests.filter((r) => !r.startsWith('GET'))).toEqual([]);
  });

  describe('from an older control plane', () => {
    // The API reads nothing for this release's client until it moves.
    it('moves the API before any read, then plans and rolls', async () => {
      // The fakes refuse every read before `api upgrade`, as 0.1.73 does.
      const { deps, calls } = setUp();
      await upgrade(deps);
      expect(
        calls.findIndex((c) => c === 'api upgrade --sign-in-apps 5622376'),
      ).toBeLessThan(calls.findIndex((c) => c.startsWith('status')));
      expect(mutations(calls)).toContain(ROLL);
    });

    it("can't plan, and changes nothing", async () => {
      const { deps, calls, worker } = setUp();
      const error = await upgrade(deps, { plan: true }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(UsageError);
      expect((error as Error).message).toMatch(
        /`--plan` works only after it updates/,
      );
      const planned = setUp();
      await expect(
        upgrade(planned.deps, { yes: true, planId: 'p-000000000000' }),
      ).rejects.toThrow(PlanChanged);
      expect([...mutations(calls), ...mutations(planned.calls)]).toEqual([]);
      expect(worker.calls).toEqual([]);
    });

    it('refuses one more than a release behind before moving it', async () => {
      // Its listeners' anycloud would be outside the new API's client window.
      const { deps, calls, worker } = setUp({ version: '0.1.69' });
      const error = await upgrade(deps).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UsageError);
      expect((error as Error).message).toMatch(
        /too old for this backmesh to upgrade/,
      );
      expect(mutations(calls)).toEqual([]);
      expect(worker.calls).toEqual([]);
    });

    it('refuses a control plane with no backmesh listener before moving it', async () => {
      const { deps, calls, workloads } = setUp();
      workloads.length = 0;
      await expect(upgrade(deps)).rejects.toThrow("There's no listener on");
      expect(mutations(calls)).toEqual([]);
    });

    it('says the API moved when the runner change is declined, and a re-run finishes without moving it again', async () => {
      const twoToOne = () =>
        setUp({
          image: RELEASE.listenerImage,
          runnerImage: RELEASE.runnerImage,
          runners: twoRegions(),
        });
      const { deps, calls } = twoToOne();
      deps.confirm = async () => false;
      await expect(upgrade(deps)).rejects.toThrow(
        'Upgrade cancelled after the control plane updated, with no listener changed',
      );
      expect(mutations(calls)).toEqual([
        'api upgrade --sign-in-apps 5622376',
        'api status --watch --json',
      ]);

      // A fresh setup whose control plane has moved already.
      const again = twoToOne();
      const run = again.deps.run;
      let moved = false;
      again.deps.run = async (args) => {
        if (!moved) {
          moved = true;
          await run(['api', 'upgrade']);
          again.calls.length = 0;
        }
        return run(args);
      };
      again.deps.confirm = async () => true;
      const result = await upgrade(again.deps);
      expect(again.calls).not.toContain('api upgrade --sign-in-apps 5622376');
      expect(result).toMatchObject({ controlPlane: { upgraded: false } });
      expect(mutations(again.calls)).toContain(ROLL);
    });

    it('leaves the new API with the old listener when a later check refuses', async () => {
      const { deps, calls } = setUp({ listener: 'down' });
      await expect(upgrade(deps)).rejects.toThrow(
        `acme's listener didn't start on ${VM.acme}.`,
      );
      expect(mutations(calls)).toEqual([
        'api upgrade --sign-in-apps 5622376',
        'api status --watch --json',
        `start ${VM.acme}`,
      ]);
    });

    it('asks before changing the runners only after the API moves', async () => {
      const { deps, calls } = setUp({
        image: RELEASE.listenerImage,
        runnerImage: RELEASE.runnerImage,
        runners: twoRegions(),
      });
      await expect(upgrade(deps)).rejects.toThrow(NeedsPlan);
      expect(mutations(calls)).toEqual([
        'api upgrade --sign-in-apps 5622376',
        'api status --watch --json',
      ]);
    });
  });

  it("refuses when the listener doesn't answer even started again, changing nothing else", async () => {
    const { deps, calls, requests } = setUp({
      version: RELEASE.anycloud,
      listener: 'down',
    });

    await expect(upgrade(deps)).rejects.toThrow("didn't start");
    expect(mutations(calls)).toEqual([`start ${VM.acme}`]);
    expect(requests.filter((r) => !r.startsWith('GET'))).toEqual([]);
  });

  describe("a listener's VM", () => {
    const current = {
      version: RELEASE.anycloud,
      image: RELEASE.listenerImage,
      runnerImage: RELEASE.runnerImage,
      cacheBuckets: ['bm-cache-l8u5e-us-east-2'],
    };

    it('moves a listener off bm-control: its VM first, the Deployment stopped before it starts, then bm-control goes', async () => {
      const { deps, calls, requests, lines, hosts } = setUp({
        version: RELEASE.anycloud,
        host: 'deployment',
      });
      const result = await upgrade(deps);
      const moves = mutations(calls);
      const id = /--id (bml-l8u5e-[a-z0-9]{6})/.exec(moves.join('\n'))?.[1];
      expect(moves).toEqual([
        'api access add --service backmesh-acme --json',
        expect.stringMatching(
          new RegExp(
            `^vm \\S+ --id ${id} --credentials bm-aws --region us-east-2 --vm-type t3.small --secret backmesh-acme --wait$`,
          ),
        ),
        // In standby while the Deployment still runs, then taking jobs.
        `roll ${id}`,
        'deployment delete dep-acme',
        `roll ${id}`,
        'api access remove --service-account backmesh-acme',
        'node-pool delete np-1',
      ]);
      // Read in its Pod, where it still was.
      expect(calls.indexOf('status dep-acme')).toBeGreaterThanOrEqual(0);
      // Its runner group keeps the Deployment's name, so its scale sets
      // stay; the new token is the one just issued.
      const values = secretOf('acme', {
        BACKMESH_RUNNER_GROUP: runnerGroupName('l8u5e', 'dep-acme'),
        ANYCLOUD_API_TOKEN: 'acapi_issued',
      });
      expect(saved(requests)).toEqual([values]);
      expect(hosts.get(id!)!.env).toEqual(values);
      expect(lines).toContain(
        "acme's listener moves from bm-control to its own t3.small VM, about $17 a month, and bm-control, about the same, is deleted.",
      );
      expect(result.listeners).toEqual([
        { org: 'acme', image: RELEASE.listenerImage, rolled: true },
      ]);
      // The plan names the move.
      const plan = setUp({ version: RELEASE.anycloud, host: 'deployment' });
      expect(await upgrade(plan.deps, { plan: true })).toMatchObject({
        orgs: [{ org: 'acme', moves: true }],
      });
      expect(mutations(plan.calls)).toEqual([]);
    });

    it('finishes a move that stopped after making the VM: reads the Deployment, then rolls the VM it made', async () => {
      const { deps, calls, hosts } = setUp({
        version: RELEASE.anycloud,
        host: 'both',
      });
      await upgrade(deps);
      expect(calls).toContain('status dep-acme');
      expect(mutations(calls)).toEqual([
        'api access add --service backmesh-acme --json',
        `roll ${VM.acme}`,
        'deployment delete dep-acme',
        `roll ${VM.acme}`,
        'api access remove --service-account backmesh-acme',
        'node-pool delete np-1',
      ]);
      expect(hosts.get(VM.acme!)!.env).toMatchObject({
        BACKMESH_RUNNER_GROUP: runnerGroupName('l8u5e', 'dep-acme'),
      });
    });

    it("keeps the Deployment running when the VM's listener can't use its token in standby", async () => {
      const { deps, calls, hooks, hosts } = setUp({
        version: RELEASE.anycloud,
        host: 'deployment',
      });
      hooks.roll = (values) => {
        // The control plane refuses the new token.
        if (values.BACKMESH_STANDBY) {
          for (const [id, h] of hosts) {
            if (id.startsWith('bml-')) {
              h.body = {
                ...h.body,
                anycloud: {
                  since: '2026-11-18T06:00:00.000Z',
                  error: 'HTTP 401: {}',
                },
              };
            }
          }
        }
        return false;
      };
      await expect(upgrade(deps)).rejects.toThrow(
        /can't use the control plane \(HTTP 401: \{\}\), so its Deployment keeps running/,
      );
      expect(calls.filter((c) => c.startsWith('deployment'))).toEqual([]);
      expect(calls).not.toContain('node-pool delete np-1');
    });

    it('takes a listener a stopped move left in standby out of it, with nothing else to change', async () => {
      const { deps, calls, hosts } = setUp({ ...current });
      const acme = hosts.get(VM.acme!)!;
      acme.env = { ...acme.env, BACKMESH_STANDBY: '1' };
      await upgrade(deps);
      // The move's last step too.
      expect(mutations(calls)).toEqual([
        ROLL,
        'api access remove --service-account backmesh-acme',
      ]);
      expect(acme.env).not.toHaveProperty('BACKMESH_STANDBY');
    });

    it('asks before moving several orgs, with the VMs’ total cost', async () => {
      const { deps, calls, lines } = setUp({
        version: RELEASE.anycloud,
        host: 'deployment',
        beta: true,
        betaMoves: true,
      });
      await expect(upgrade(deps)).rejects.toThrow(NeedsPlan);
      expect(lines).toContain(
        "acme, beta's listeners move from bm-control to t3.small VMs of their own: about $34 a month in all, instead of bm-control's one Node at about $17, which is deleted.",
      );
      expect(mutations(calls)).toEqual([]);
    });

    it('refuses --plan and --plan-id while a listener must start again first, changing nothing', async () => {
      for (const host of ['lost', 'vm'] as const) {
        const { deps, calls, hosts } = setUp({ ...current, host });
        if (host === 'vm') hosts.get(VM.acme!)!.up = false;
        await expect(upgrade(deps, { plan: true })).rejects.toThrow(
          host === 'lost'
            ? `acme's listener VM ${VM.acme} is gone, so \`--plan\` works only after upgrade starts it again`
            : `acme's listener on ${VM.acme} isn't answering, so \`--plan\``,
        );
        await expect(
          upgrade(deps, { yes: true, planId: 'p-000000000000' }),
        ).rejects.toThrow(PlanChanged);
        expect(mutations(calls)).toEqual([]);
      }
    });

    it('creates a lost VM again from the Secret, where it was and at its size, and reads it there', async () => {
      const { deps, calls, lines, hosts } = setUp({
        ...current,
        host: 'lost',
      });
      const result = await upgrade(deps);
      const moves = mutations(calls);
      const id = /--id (bml-l8u5e-[a-z0-9]{6})/.exec(moves.join('\n'))?.[1];
      expect(id).not.toBe(VM.acme);
      expect(moves).toEqual([
        expect.stringMatching(
          new RegExp(
            `^vm \\S+ --id ${id} --credentials bm-aws --region us-east-2 --vm-type t3.medium --secret backmesh-acme --wait$`,
          ),
        ),
        `start ${id}`,
      ]);
      expect(lines).toContain(
        `acme's listener VM ${VM.acme} is gone; creating ${id} on aws us-east-2.`,
      );
      // Its listener starts from the Secret it was created with.
      expect(hosts.get(id!)!.env).toMatchObject({ ORG: 'acme' });
      expect(result.listeners).toEqual([
        { org: 'acme', image: RELEASE.listenerImage, rolled: false },
      ]);
    });

    it('issues a new service token when the control plane refuses the old one, and rolls it in', async () => {
      const { deps, calls, requests } = setUp({
        ...current,
        body: {
          anycloud: { since: '2026-11-05T11:00:00.000Z', error: 'HTTP 401' },
        },
      });
      const result = await upgrade(deps);
      expect(mutations(calls)).toEqual([
        'api token rotate --service backmesh-acme --json',
        ROLL,
      ]);
      expect(saved(requests)).toEqual([
        secretOf('acme', { ANYCLOUD_API_TOKEN: 'acapi_rotated' }),
      ]);
      expect(result.listeners).toEqual([
        { org: 'acme', image: RELEASE.listenerImage, rolled: true },
      ]);
    });
  });
});
