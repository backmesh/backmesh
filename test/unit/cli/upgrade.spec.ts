import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { StatusReport } from '../../../src/cli/status.js';
import { GitHubError } from '../../../src/app/github.js';
import { NeedsPlan, PlanChanged, UsageError } from '../../../src/cli/errors.js';
import { upgrade, type UpgradeDeps } from '../../../src/cli/upgrade.js';
import { parseRoutes } from '../../../src/listener/routes.js';
import { planClasses } from '../../../src/runners/classes.js';
import { awsInRegions, CATALOG, catalogs } from '../runners/fixtures.js';
import {
  fakeApi,
  fakeBinary,
  fakeWorker,
  githubOrg,
  INSTALL_KEY,
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

function setUp({
  version = '0.1.70',
  image = OLD_LISTENER,
  runnerImage = 'ghcr.io/backmesh/backmesh-runner@sha256:old',
  watch = watched('running'),
  keyStatus = Response.json(ACCEPTED),
  installs,
  // 'down' answers nothing; 'no-key' is a listener from before install keys.
  listener,
  // A second org's listener on the same control plane.
  beta = false,
  // The listener's BACKMESH_RUNNERS; null: one from before VM Jobs.
  runners = RUNNERS as string | null,
  // The install region's catalog.
  catalog = CATALOG.aws,
  // An unfinished `rotate-key` rotation's marker, already on the listener.
  rotatingFrom,
  // bm-aws's cache buckets, when an install made them.
  cacheBuckets,
}: {
  cacheBuckets?: string[];
  catalog?: typeof CATALOG.aws;
  beta?: boolean;
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
} = {}) {
  const probe = (org: string) =>
    JSON.stringify({
      code: 200,
      env: {
        ORG: org,
        BACKMESH_RUNNER_IMAGE: RELEASE.runnerImage,
        BACKMESH_INSTALL_KEY: INSTALL_KEY,
        ...(runners !== null && { BACKMESH_RUNNERS: runners }),
        ...(rotatingFrom && { BACKMESH_ROTATING_FROM: rotatingFrom }),
      },
      body: {
        installed: true,
        broker: null,
        runners: 0,
        cap: 500,
        scaleSets: [],
      },
    });
  const binary = fakeBinary({
    'vm-types aws us-east-2': JSON.stringify(catalog),
    'vm-types aws us-east-1': JSON.stringify(CATALOG.aws),
    'vm-types aws us-west-2': JSON.stringify(CATALOG.aws),
    'vm-types gcp us-central1': JSON.stringify(CATALOG.gcp),
    ...(beta && { 'exec backmesh-beta': probe('beta') }),
    'api status --json': JSON.stringify({ url: HOSTED }),
    'api token': 't0ken',
    'api status --watch --json': watch,
    'exec backmesh':
      listener === 'down'
        ? ''
        : JSON.stringify({
            code: 200,
            env: {
              ORG: 'acme',
              ...(runnerImage !== null && {
                BACKMESH_RUNNER_IMAGE: runnerImage,
              }),
              ...(listener === 'no-key'
                ? {}
                : { BACKMESH_INSTALL_KEY: INSTALL_KEY }),
              ...(runners !== null && { BACKMESH_RUNNERS: runners }),
              ...(rotatingFrom && { BACKMESH_ROTATING_FROM: rotatingFrom }),
            },
            body: {
              installed: true,
              broker: null,
              runners: 0,
              cap: 500,
              scaleSets: [],
            },
          }),
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
    // The binary's reads through the hosted API (`exec`, `cluster list`).
    const refused = ['exec', 'cluster'].includes(args[0]!) && refusal();
    if (refused) {
      throw new Error(((await refused.json()) as { message: string }).message);
    }
    return out;
  };
  const routes = {
    'GET /v1/node-pools': {
      nodePools: [
        {
          id: 'np-1',
          name: 'bm-control',
          state: 'running',
          allowPrivilegedJobs: false,
          cloudProvider: 'AWS',
          region: 'us-east-2',
        },
      ],
    },
    'GET /v1/deployments': {
      deployments: [
        {
          name: 'backmesh-acme',
          managed: false,
          nodePoolId: 'np-1',
          deletedAt: null,
          image,
        },
        ...(beta
          ? [
              {
                name: 'backmesh-beta',
                managed: false,
                nodePoolId: 'np-1',
                deletedAt: null,
                image: OLD_LISTENER,
              },
            ]
          : []),
      ],
    },
    'GET /v1/workloads': [],
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
    'PUT /v1/secrets/backmesh-acme': {},
    'PUT /v1/secrets/backmesh-beta': {},
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
  });
  const deps: UpgradeDeps = {
    // No saved anycloud files, whatever this machine holds.
    env: { BACKMESH_ANYCLOUD_DIR: mkdtempSync(join(tmpdir(), 'backmesh-')) },
    signInScopes: async () => ['read:org', 'read:packages'],
    run,
    runLong: run,
    release: async () => RELEASE,
    status: async () => STATUS,
    print: (line) => lines.push(line),
    // An older client's reads go to the same routes with its header.
    api: (_url, _token, _fetch, _refresh, clientVersion) =>
      clientVersion ? fakeApi(routes, refusal, clientVersion).api : api,
    fetch: async (url, init) =>
      String(url).startsWith('https://api.backmesh.com/')
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
      c28: undefined,
    },
  };
  return { deps, calls, requests, lines, worker, routes };
}

const rolledAny = (calls: string[]) =>
  calls.some((c) => c.startsWith('deployment upgrade'));
const mutations = (calls: string[]) =>
  calls.filter((c) =>
    /^(api upgrade|api status --watch|deployment|node-pool)/.test(c),
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
    writeFileSync(join(dir, '.token'), 'gho_revoked\n');
    deps.signInScopes = async (token) => {
      if (token === 'gho_revoked')
        throw new GitHubError(401, 'Bad credentials');
      return ['read:org', 'read:packages'];
    };
    const run = deps.run;
    const logins: string[] = [];
    deps.run = async (args) => {
      if (args[0] !== 'login') return run(args);
      logins.push(args.join(' '));
      if (readFileSync(join(dir, '.token'), 'utf8').startsWith('gho_revoked')) {
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
      `GitHub revoked the saved sign-in. backmesh signs in again.`,
    );
    expect(readFileSync(join(dir, '.token'), 'utf8')).toBe(`${SIGNED_IN}\n`);
  });

  it("upgrades the API, then rolls the listener with this release's classes", async () => {
    const { deps, calls, requests } = setUp();
    const result = await upgrade(deps);

    expect(mutations(calls)).toEqual([
      'api upgrade',
      'api status --watch --json',
      `deployment upgrade backmesh-acme --image ${RELEASE.listenerImage} --secret backmesh-acme --cpus 0.5 --wait`,
    ]);
    expect(requests).toContain(
      `PUT /v1/secrets/backmesh-acme ${JSON.stringify({ values: { ORG: 'acme', ORG_ID: '7', BACKMESH_RUNNER_IMAGE: RELEASE.runnerImage, BACKMESH_INSTALL_KEY: INSTALL_KEY, BACKMESH_RUNNERS: RUNNERS } })}`,
    );
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
      'Upgrade cancelled; nothing changed. Raise the quotas named above, then run upgrade again.',
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
    expect(mutations(moved.calls)).toContain('api upgrade');
    expect(rolledAny(moved.calls)).toBe(false);
  });

  it("upgrades an older API first, checks every org's key, then rolls each org's listener in turn", async () => {
    const { deps, calls, requests } = setUp({ beta: true });
    const result = await upgrade(deps);

    expect(
      calls
        .filter((c) => /^(exec|api upgrade|deployment|node-pool)/.test(c))
        .map((c) => c.split(' node -e')[0]),
    ).toEqual([
      // An older API reads nothing for this release's client until it moves.
      'api upgrade',
      'exec backmesh-acme',
      'exec backmesh-beta',
      `deployment upgrade backmesh-acme --image ${RELEASE.listenerImage} --secret backmesh-acme --cpus 0.5 --wait`,
      `deployment upgrade backmesh-beta --image ${RELEASE.listenerImage} --secret backmesh-beta --cpus 0.5 --wait`,
    ]);
    expect(requests).toContain(
      `PUT /v1/secrets/backmesh-beta ${JSON.stringify({ values: { ORG: 'beta', ORG_ID: '8', BACKMESH_RUNNER_IMAGE: RELEASE.runnerImage, BACKMESH_INSTALL_KEY: INSTALL_KEY, BACKMESH_RUNNERS: RUNNERS } })}`,
    );
    expect(result.listeners).toEqual([
      { org: 'acme', image: RELEASE.listenerImage, rolled: true },
      { org: 'beta', image: RELEASE.listenerImage, rolled: true },
    ]);
  });

  it("stops at the first org whose roll fails, before the next org's", async () => {
    const { deps, calls } = setUp({ beta: true });
    const { runLong } = deps;
    deps.runLong = async (args) => {
      if (args[2] === 'backmesh-acme' && args.includes(RELEASE.listenerImage)) {
        throw new Error('roll failed');
      }
      return runLong(args);
    };
    await expect(upgrade(deps)).rejects.toThrow("acme's listener's roll");
    expect(calls.some((c) => c.includes('upgrade backmesh-beta'))).toBe(false);
  });

  it("refuses before changing anything when an org's listener doesn't answer", async () => {
    const { deps, calls } = setUp({ version: RELEASE.anycloud, beta: true });
    const run = deps.run;
    deps.run = async (args) => {
      if (args[0] === 'exec' && args[1] === 'backmesh-beta')
        throw new Error('down');
      return run(args);
    };
    await expect(upgrade(deps)).rejects.toThrow(
      "beta's listener didn't answer",
    );
    expect(mutations(calls)).toEqual([]);
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
    expect(mutations(calls)).toEqual([
      `deployment upgrade backmesh-acme --image ${RELEASE.listenerImage} --secret backmesh-acme --cpus 0.5 --wait`,
    ]);
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
    expect(mutations(calls)).toEqual([
      `deployment upgrade backmesh-acme --image ${RELEASE.listenerImage} --secret backmesh-acme --cpus 0.5 --wait`,
    ]);
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
      expect(mutations(calls)).toContain(
        `deployment upgrade backmesh-acme --image ${RELEASE.listenerImage} --secret backmesh-acme --cpus 0.5 --wait`,
      );

      // --plan-id alone still asks, and needs a terminal for it.
      const alone = twoToOne();
      await expect(upgrade(alone.deps, { planId })).rejects.toThrow(NeedsPlan);
      expect(mutations(alone.calls)).toEqual([]);
    });

    it('asks nothing when only the release moves', async () => {
      const { deps, calls } = setUp();
      await upgrade(deps);
      expect(mutations(calls)).toContain('api upgrade');
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
      ...mutations(calls).filter((c) => !c.startsWith('deployment upgrade')),
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
      'Upgrade cancelled; nothing changed.',
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
    expect(calls.some((c) => c.startsWith('deployment upgrade'))).toBe(false);
  });

  it('rolls back to the old image when the roll fails', async () => {
    const { deps, calls, requests } = setUp({ version: '0.1.72' });
    const run = deps.runLong;
    deps.runLong = async (args) => {
      if (args.includes(RELEASE.listenerImage)) {
        throw new Error('rollout timed out');
      }
      return run(args);
    };
    await expect(upgrade(deps)).rejects.toThrow(
      `failed, and it's back on ${OLD_LISTENER}. Run upgrade again.`,
    );
    expect(calls).toContain(
      `deployment upgrade backmesh-acme --image ${OLD_LISTENER} --secret backmesh-acme --cpus 0.5 --wait`,
    );
    // The old listener gets its own runner image back, before its roll.
    const release = requests.filter((r) =>
      r.startsWith('PUT /v1/secrets/backmesh-acme'),
    );
    expect(release.at(-1)).toContain(
      '"BACKMESH_RUNNER_IMAGE":"ghcr.io/backmesh/backmesh-runner@sha256:old"',
    );
  });

  // rollListener's restore must still run when only the runners (classes)
  // changed and the image didn't: converge.ts's "nothing to restore"
  // no-op check (added for rotate-key, whose two calls never change the
  // image, runner image or classes together) must not also skip a real
  // prior state `upgrade` has to roll back to.
  it('rolls back to the old runners when the roll fails and only the runners changed, with the image unchanged', async () => {
    const { deps, requests } = setUp({
      version: '0.1.72',
      image: RELEASE.listenerImage,
      runnerImage: RELEASE.runnerImage,
      runners: twoRegions(),
    });
    deps.confirm = async () => true;
    const run = deps.runLong;
    let rolls = 0;
    deps.runLong = async (args) => {
      if (args.join(' ').startsWith('deployment upgrade backmesh-acme')) {
        rolls++;
        // Only the first (forward) roll fails; the restore attempt, which
        // rolls to the very same image, succeeds.
        if (rolls === 1) throw new Error('rollout timed out');
      }
      return run(args);
    };

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
    const { deps, requests } = setUp({ version: '0.1.72', runnerImage: null });
    const run = deps.runLong;
    deps.runLong = async (args) => {
      if (args.includes(RELEASE.listenerImage)) throw new Error('timed out');
      return run(args);
    };
    await expect(upgrade(deps)).rejects.toThrow(`it's back on ${OLD_LISTENER}`);
    const release = requests.filter((r) =>
      r.startsWith('PUT /v1/secrets/backmesh-acme'),
    );
    // Its built-in runner image applies again; the org stays.
    expect(release.at(-1)).toBe(
      `PUT /v1/secrets/backmesh-acme ${JSON.stringify({ values: { ORG: 'acme', ORG_ID: '7', BACKMESH_INSTALL_KEY: INSTALL_KEY, BACKMESH_RUNNERS: RUNNERS } })}`,
    );
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
  const rolled = (calls: string[]) =>
    calls.some((c) => c.startsWith('deployment upgrade backmesh'));

  it('signs an older install in once, saves the new key and rolls', async () => {
    const { deps, calls, requests, worker } = setUp({
      ...current,
      listener: 'no-key',
    });

    await upgrade(deps);

    expect(worker.calls).toEqual([
      'POST /v1/installs/device',
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
          github_token: SIGNED_IN,
        }),
      ],
    });
  const replaced = `bmk_${'cd'.repeat(16)}${'ef'.repeat(16)}`;

  it('signs in again for a refused key, saves the replacement and rolls', async () => {
    const { deps, calls, requests, worker } = refusedKey();

    await upgrade(deps);

    expect(worker.bodies).toEqual([
      { org: 'acme', device_code: 'dev-3584e1', install: 'ab'.repeat(16) },
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
    writeFileSync(token, 'gho_owner\n');
    await upgrade(saved.deps);
    expect(readFileSync(token, 'utf8')).toBe('gho_owner\n');

    const ci = refusedKey();
    ci.deps.env.GITHUB_TOKEN = 'gho_ci';
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
      expect(calls.findIndex((c) => c === 'api upgrade')).toBeLessThan(
        calls.findIndex((c) => c.startsWith('exec')),
      );
      expect(mutations(calls)).toContain(
        `deployment upgrade backmesh-acme --image ${RELEASE.listenerImage} --secret backmesh-acme --cpus 0.5 --wait`,
      );
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
      const { deps, calls, routes } = setUp();
      (
        routes['GET /v1/deployments'] as { deployments: unknown[] }
      ).deployments = [];
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
        'api upgrade',
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
      expect(again.calls).not.toContain('api upgrade');
      expect(result).toMatchObject({ controlPlane: { upgraded: false } });
      expect(mutations(again.calls)).toContain(
        `deployment upgrade backmesh-acme --image ${RELEASE.listenerImage} --secret backmesh-acme --cpus 0.5 --wait`,
      );
    });

    it('leaves the new API with the old listener when a later check refuses', async () => {
      const { deps, calls } = setUp({ listener: 'down' });
      await expect(upgrade(deps)).rejects.toThrow(
        "acme's listener didn't answer",
      );
      expect(mutations(calls)).toEqual([
        'api upgrade',
        'api status --watch --json',
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
        'api upgrade',
        'api status --watch --json',
      ]);
    });
  });

  it("refuses when the listener doesn't answer, changing nothing", async () => {
    const { deps, calls, requests } = setUp({
      version: RELEASE.anycloud,
      listener: 'down',
    });

    await expect(upgrade(deps)).rejects.toThrow();
    expect(mutations(calls)).toEqual([]);
    expect(requests.filter((r) => !r.startsWith('GET'))).toEqual([]);
  });
});
