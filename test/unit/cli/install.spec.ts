import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { StepFailed } from '../../../src/anycloud/binary.js';
import type { FeatureTable } from '../../../src/anycloud/features.js';
import { signInScopes } from '../../../src/app/github.js';
import {
  install,
  parseControlPlane,
  parseRunners,
  PUBLIC_REPOS_LINE,
  type InstallDeps,
  type InstallOptions,
} from '../../../src/cli/install.js';
import type { InstallPlan } from '../../../src/cli/plan.js';
import { PlanChanged, UsageError } from '../../../src/cli/errors.js';
import { ANYCLOUD_VERSION } from '../../../src/anycloud/contract.generated.js';
import { connectionName, installTag } from '../../../src/cli/installation.js';
import { parseRoutes } from '../../../src/listener/routes.js';
import { leftoverIdentity } from '../../../src/cli/uninstall.js';
import { fakeGitHub, json } from '../github/fake-github.js';
import { CATALOG, catalogs } from '../runners/fixtures.js';
import { planClasses } from '../../../src/runners/classes.js';
import { RUNNER_REGIONS } from '../../../src/runners/regions.js';
import {
  fakeApi,
  fakeBinary,
  fakeWorker,
  INSTALL_KEY,
  SIGNED_IN,
} from './fakes.js';

const RELEASED: FeatureTable = {
  'release-1': '0.1.0',
  c26: '0.1.0',
  'role-connections': '0.1.0',
  'role-apply': '0.1.0',
  c28: '0.1.0',
  'vm-job-regions': undefined,
};
const OVERRIDE = { BACKMESH_UNSUPPORTED_CI_OVERRIDE: 'anycloud-ci' };
const images = {
  runnerImage: `ghcr.io/backmesh/backmesh-runner@sha256:${'a'.repeat(64)}`,
  listenerImage: `ghcr.io/backmesh/backmesh-listener@sha256:${'b'.repeat(64)}`,
};
const HOSTED = 'https://c1.anycloud.sh';
// Each cloud's connection on HOSTED's control plane, `c1`.
const BM = {
  aws: connectionName('aws', 'c1'),
  gcp: connectionName('gcp', 'c1'),
  azure: connectionName('azure', 'c1'),
};
// backmesh's anycloud state, one per machine.
const stateDir = () => mkdtempSync(join(tmpdir(), 'backmesh-install-'));
const RUNNING = { state: 'running', managementApiUrl: HOSTED, lastError: null };
// GitHub's GET /user for each sign-in: its `x-oauth-scopes`, or a 401 for
// one it doesn't know.
const SIGN_INS: Record<string, string> = {
  gho_x: 'read:org, read:packages',
  gho_saved: 'read:packages, read:org',
  gho_wide: 'read:org, read:packages, repo',
  gho_narrow: 'read:org',
  [SIGNED_IN]: 'read:org, read:packages',
};
// A sign-in GitHub can't check: it answers 503.
const DOWN = 'gho_down';
const github = fakeGitHub({
  'GET https://api.github.com/user': ({ headers }) => {
    const token = headers.get('authorization')!.split(' ')[1]!;
    if (token === DOWN) return json(503, { message: 'Unavailable' })();
    const scopes = SIGN_INS[token];
    return scopes === undefined
      ? json(401, { message: 'Bad credentials' })()
      : json(200, { login: 'octo', id: 1 }, { 'x-oauth-scopes': scopes })();
  },
});

// A terminal on a machine with every login, the pinned binary, a cluster
// that comes up at HOSTED, and backmesh's App installed on the org. `connect`
// stands in for `credentials new --role` at the terminal, recorded in
// `calls`, and `command` for the user's cloud CLIs, whose AWS quotas are
// `quota`, by code in every region or by `<code>@<region>`; a region with
// neither fails to read.
function setUp(
  {
    env = {},
    pools = [] as object[],
    workloads = [] as object[],
    deployments = [] as object[],
    worker = fakeWorker(),
    features = RELEASED,
    tty = true,
    confirm = async () => true,
    // The account `credentials new --role --apply` reports making the role
    // in; the signed-in one unless a test says otherwise.
    roleIn,
    quota = { 'L-34B43A08': '640.0', 'L-1216C47A': '128.0' },
    hosted = false,
    account = { aws: '123456789012', gcp: 'proj-1', azure: 'sub-1' },
    hostedVersion = ANYCLOUD_VERSION,
    answers = [] as string[],
    cacheBuckets,
  }: {
    // bm-aws's cache buckets, when a previous install made them: the
    // connection an installation before 0.4.1 named, which `RUNNERS` records.
    cacheBuckets?: string[];
    env?: NodeJS.ProcessEnv;
    pools?: object[];
    workloads?: object[];
    deployments?: object[];
    worker?: ReturnType<typeof fakeWorker>;
    features?: FeatureTable;
    tty?: boolean;
    confirm?: (question: string) => Promise<boolean>;
    roleIn?: string;
    quota?: Record<string, string>;
    // This machine already targets the hosted API.
    hosted?: boolean;
    // Each cloud CLI's signed-in account; a test may change it mid-run.
    account?: Record<'aws' | 'gcp' | 'azure', string>;
    // The anycloud the hosted API answers `GET /v1/version` with.
    hostedVersion?: string;
    // The terminal's answers to install's questions, in turn.
    answers?: string[];
  } = {},
  binary: Record<string, string> = {},
) {
  let target = hosted ? HOSTED : 'local';
  let reads = 0;
  const created = (
    pools as { name?: string; state?: string; cloudProvider?: string }[]
  ).map((pool) => ({ ...pool }));

  const { run: answer, calls } = fakeBinary({
    'credentials list --json': '[]',
    'vm-types aws us-east-2': JSON.stringify(CATALOG.aws),
    'cluster create backmesh': JSON.stringify({ name: 'backmesh', ...RUNNING }),
    'api token': 't0ken',
    // As `--apply --json` answers once the role is made and saved.
    ...Object.fromEntries(
      (['aws', 'gcp', 'azure'] as const).map((cloud) => [
        `credentials new ${BM[cloud]} --provider ${cloud} --role --apply`,
        JSON.stringify({
          name: BM[cloud],
          cloudProvider: cloud.toUpperCase(),
          kind: 'role',
          account: roleIn ?? account[cloud],
        }),
      ]),
    ),
    ...binary,
  });
  const run = async (args: string[]) => {
    if (args[0] === 'api' && args[1] === 'use') target = args[2]!;
    // As anycloud does: no Deployment on a pool that isn't running.
    const control = created.find((pool) => pool.name === 'bm-control');
    if (
      args[0] === 'deployment' &&
      args[1] === 'create' &&
      control?.state !== 'running'
    ) {
      throw new Error(
        'Node pool "bm-control" is provisioning; wait until it is running',
      );
    }
    // As anycloud 0.1.73 does: `api token` serves hosted APIs only.
    if (args.join(' ') === 'api token' && target === 'local') {
      throw new Error(
        'Failed to get the API token: API access sharing is only available on a hosted API',
      );
    }
    if (args.join(' ') === 'api status --json') {
      const url = target === 'local' ? 'http://localhost:8080' : target;
      void calls.push(args.join(' '));
      return JSON.stringify({ url, healthy: target !== 'local' });
    }
    return answer(args);
  };
  const { api, requests } = fakeApi({
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
    // As anycloud does: a new pool provisions for a while, here two reads.
    'GET /v1/node-pools': () => {
      const nodePools = structuredClone(created);
      for (const pool of created) {
        if (pool.state === 'provisioning' && ++reads >= 2)
          pool.state = 'running';
      }
      return { nodePools };
    },
    'POST /v1/node-pools': (body: string) => {
      const pool = JSON.parse(body) as { credentialName: string };
      const cloudProvider = { [BM.aws]: 'AWS', [BM.gcp]: 'GCP' }[
        pool.credentialName
      ];
      created.push({ ...pool, cloudProvider, state: 'provisioning' });
      return {};
    },
    'GET /v1/workloads': workloads,
    'GET /v1/deployments': { deployments },
  });
  const lines: string[] = [];
  const tokens: [string, string][] = [];
  const refreshable = new Set<string>();
  // Every raw cloud CLI call install makes, through the user's own aws,
  // gcloud or az, separate from `calls` (the anycloud binary).
  const commands: string[] = [];
  const deps: InstallDeps = {
    env: { BACKMESH_ANYCLOUD_DIR: stateDir(), ...env },
    run,
    runLong: run,
    command: async (args) => {
      commands.push(args.join(' '));
      // The account's commercial regions, through the user's aws CLI.
      if (args[0] === 'aws' && args[2] === 'describe-regions') {
        return JSON.stringify({
          Regions: ['us-east-1', 'us-east-2', 'us-west-2', 'eu-west-1'].map(
            (RegionName) => ({
              RegionName,
              OptInStatus: 'opt-in-not-required',
            }),
          ),
        });
      }
      if (args[1] === 'service-quotas') {
        const code = args[args.indexOf('--quota-code') + 1]!;
        const region = args[args.indexOf('--region') + 1]!;
        const value = quota[`${code}@${region}`] ?? quota[code];
        if (value === undefined) throw new Error('OptInRequired');
        return `${value}\n`;
      }
      if (args[0] === 'az' && args[2] === 'list-usage') {
        return JSON.stringify(
          ['lowPriorityCores', 'cores'].map((value) => ({
            name: { value },
            limit: 100,
          })),
        );
      }
      // The new management VM at anycloud 0.1.78's 8,000 IOPS; bm-control's
      // Node is created at the baseline.
      if (args[0] === 'aws' && args[1] === 'ec2') {
        return {
          'describe-instances': JSON.stringify(['vol-api']),
          'describe-volumes': JSON.stringify([
            {
              VolumeId: 'vol-api',
              VolumeType: 'gp3',
              Iops: 8000,
              Throughput: 125,
            },
          ]),
          'modify-volume': '{}',
        }[args[2]!]!;
      }
      if (args[0] === 'aws') return JSON.stringify({ Account: account.aws });
      if (args.join(' ') === 'az account show --output json') {
        return JSON.stringify({ id: account.azure });
      }
      if (args.join(' ') === 'gcloud config get-value project') {
        return `${account.gcp}\n`;
      }
      return '';
    },
    signInScopes: (token) =>
      signInScopes(token, { request: { fetch: github.fetch } }),
    release: async () => images,
    ui: {
      print: (line) => lines.push(line),
      ...(tty && {
        confirm,
        ask: async (question: string) => {
          lines.push(question);
          return answers.shift() ?? '';
        },
      }),
    },
    api: (url, token, _fetch, refresh) => {
      tokens.push([url, token as string]);
      if (refresh) refreshable.add(url);
      return api;
    },
    features,
    retry: { intervalMs: 0 },
    fetch: (async (url: string, init?: RequestInit) =>
      String(url) === `${HOSTED}/v1/version`
        ? Response.json({ version: hostedVersion })
        : worker.fetch(url, init)) as typeof globalThis.fetch,
    wait: async () => {},
  };
  return {
    deps,
    calls,
    commands,
    requests,
    lines,
    tokens,
    refreshable,
    worker,
  };
}

const options: InstallOptions = {
  org: 'acme',
  controlPlane: 'aws:us-east-2',
  yes: true,
};
// A customer at a terminal, who agrees to the plan once when asked.
const asked = { ...options, yes: false };

const tokenFor = (login: string) =>
  Response.json({
    token: 'ghs_1',
    expires_at: '2026-11-06T13:00:00Z',
    permissions: {},
    org: { id: 7, login },
  });

describe('install', () => {
  it("finishes when the AWS CLI can't read the management VM's disk, and says so", async () => {
    const { deps, commands, lines } = setUp();
    const command = deps.command;
    deps.command = async (args) => {
      if (args[2] === 'describe-instances')
        throw new Error('UnauthorizedOperation');
      return command(args);
    };
    const result = await install(asked, deps);

    expect(result).toMatchObject({ apiUrl: HOSTED });
    expect(commands.some((c) => c.includes('modify-volume'))).toBe(false);
    expect(lines).toContain(
      "Couldn't read the management VM's disk with the AWS CLI, so it keeps its speed; lower its root volume to 3000 IOPS and 125 MiB/s in the EC2 console.",
    );
  });

  it('names the account to sign in to when it finds no management VM', async () => {
    const { deps, commands, lines } = setUp();
    const command = deps.command;
    deps.command = async (args) =>
      args[2] === 'describe-instances' ? '[]' : command(args);
    const result = await install(asked, deps);

    expect(result).toMatchObject({ apiUrl: HOSTED });
    expect(commands.some((c) => c.includes('describe-volumes'))).toBe(false);
    expect(lines).toContain(
      'Found no management VM for c1 in this AWS account and us-east-2, so its disk keeps its speed; sign in to AWS account 123456789012 and lower its root volume to 3000 IOPS and 125 MiB/s in the EC2 console.',
    );
  });

  it("finishes when EC2 refuses to lower the management VM's disk, and says so", async () => {
    const { deps, lines } = setUp();
    const command = deps.command;
    deps.command = async (args) => {
      if (args[2] === 'modify-volume') throw new Error('UnauthorizedOperation');
      return command(args);
    };
    const result = await install(asked, deps);

    expect(result).toMatchObject({ apiUrl: HOSTED });
    expect(lines).toContain(
      "Couldn't lower vol-api from 8000 IOPS and 125 MiB/s; lower it to 3000 IOPS and 125 MiB/s in the EC2 console.",
    );
  });

  it("hands the listener --cache-cap in its Secret, each repository's cache in GB", async () => {
    const { deps, requests } = setUp();
    await install({ ...asked, cacheCapGb: 25 }, deps);
    const secret = requests.find((r) =>
      r.startsWith('PUT /v1/secrets/backmesh-acme '),
    )!;
    expect(JSON.parse(secret.split(' ')[2]!).values).toMatchObject({
      BACKMESH_CACHE_CAP_GB: '25',
    });
  });

  it("runs install's steps in order, making each cloud's role through its CLI", async () => {
    const { deps, calls, commands, requests, lines, tokens, refreshable } =
      setUp();
    const result = await install(asked, deps);

    expect(
      calls.filter(
        (c) => !/^(api status|api token|credentials list|vm-types)/.test(c),
      ),
    ).toEqual([
      // Through the user's cloud CLI, with no local API, after the quotas.
      'cluster create backmesh --cloud aws --region us-east-2 --vm-type t3.large --json',
      `api use ${HOSTED}`,
      // The role's trust names the hosted API, so it comes after create.
      `credentials new ${BM.aws} --provider aws --role --apply --json`,
      'api access add --service-account backmesh-acme',
      expect.stringMatching(
        /^deployment create backmesh-acme ghcr\.io\/backmesh\/backmesh-listener@sha256:b+ --node-pool bm-control --cpus 0\.5 --secret backmesh-acme -e BACKMESH_INSTALL=[a-z0-9]{5} --wait$/,
      ),
    ]);
    // The org, runner image and classes are in a Secret that `upgrade` can
    // change, beside the install key from the sign-in.
    const release = requests.find((r) =>
      r.startsWith('PUT /v1/secrets/backmesh-acme '),
    );
    expect(JSON.parse(release!.split(' ')[2]!)).toEqual({
      values: {
        ORG: 'acme',
        ORG_ID: '7',
        BACKMESH_RUNNER_IMAGE: images.runnerImage,
        BACKMESH_INSTALL_KEY: INSTALL_KEY,
        BACKMESH_RUNNERS: expect.any(String),
      },
    });
    // The cache bucket for the runner region, checked with a test mint.
    expect(requests).toContainEqual(
      expect.stringMatching(
        /^PUT \/v1\/credentials\/bm-aws-lz9d56\/buckets\/bm-cache-[a-z0-9]{5}-us-east-2\?region=us-east-2$/,
      ),
    );
    expect(requests).toContainEqual(
      expect.stringMatching(
        /^POST \/v1\/credentials\/bm-aws-lz9d56\/storage-tokens\?region=us-east-2 /,
      ),
    );
    // bm-control is the only pool: runners are VM Jobs.
    const created = requests.filter(
      (r) => r.startsWith('POST') && !r.includes('/storage-tokens'),
    );
    expect(created.map((r) => JSON.parse(r.split(' ')[2]!))).toEqual([
      expect.objectContaining({
        name: 'bm-control',
        vmTypes: ['t3.small'],
        allowPrivilegedJobs: false,
        minVmCount: 1,
        maxVmCount: 1,
        // gp3's baseline 3,000 IOPS and 125 MiB/s.
        osDiskTier: 'medium',
      }),
    ]);
    expect(result).toMatchObject({
      apiUrl: HOSTED,
      labels: expect.arrayContaining([
        'backmesh-4',
        'backmesh-od-4',
        'backmesh-kvm-4',
        'backmesh-kvm-od-4',
      ]),
    });
    // The only monthly cost is the control plane's; runner VMs bill per use.
    expect(lines).toEqual(
      expect.arrayContaining([
        'aws us-east-2: no VM while idle; while its job runs, a backmesh-4 VM costs about $0.05–0.07 an hour on spot and $0.17–0.23 on demand, plus its disk, and the other sizes scale with their vCPUs',
        'aws us-east-2 quota: 640 spot vCPUs (160 backmesh-4 jobs at once), 128 on-demand vCPUs (32 backmesh-4 jobs at once)',
        'Always on: 2 VMs that run backmesh (t3.large and t3.small) on aws us-east-2, about $86 a month with their disks and addresses.',
      ]),
    );
    // ...which the new control plane's disks then are.
    expect(commands.filter((c) => c.startsWith('aws ec2'))).toEqual([
      'aws ec2 describe-instances --filters Name=tag:Name,Values=anycloud-cluster-c1 Name=instance-state-name,Values=pending,running,stopping,stopped --query Reservations[].Instances[].BlockDeviceMappings[?DeviceName==`/dev/sda1`].Ebs.VolumeId[] --region us-east-2 --output json',
      expect.stringMatching(
        /^aws ec2 describe-volumes --volume-ids vol-api --query /,
      ),
      'aws ec2 modify-volume --volume-id vol-api --iops 3000 --throughput 125 --region us-east-2 --output json',
    ]);
    expect(lines).toContain(
      'Lowered vol-api from 8000 IOPS and 125 MiB/s to 3000 IOPS and 125 MiB/s.',
    );
    expect(lines).toContain(
      'Done. Use `runs-on: backmesh-4` (a 4-vCPU spot VM) in a workflow; other sizes: https://backmesh.com/labels/',
    );
    expect(lines).toContain(
      'Connecting aws with a role connection in account 123456789012, through your aws CLI.',
    );
    // Only the hosted API is called, with its refreshable token.
    expect(new Map(tokens)).toEqual(new Map([[HOSTED, 't0ken']]));
    expect(refreshable).toEqual(new Set([HOSTED]));
  });

  it('generates keys on our CI override, which has no terminal', async () => {
    const { deps, calls } = setUp({ env: OVERRIDE, tty: false });
    await install(options, deps);
    expect(
      calls.filter((c) => /^(cluster|credentials new|deployment)/.test(c)),
    ).toEqual([
      'cluster create backmesh --cloud aws --region us-east-2 --vm-type t3.large --json',
      `credentials new ${BM.aws} --provider aws --profile default --account-id 123456789012 --generate`,
      expect.stringMatching(
        /-e BACKMESH_UNSUPPORTED_CI_OVERRIDE=anycloud-ci --wait$/,
      ),
    ]);
  });

  it('reuses a connected cloud, and names what stopped a role', async () => {
    const reused = setUp(
      {},
      { 'credentials list --json': '[{"name":"bm-aws"}]' },
    );
    await install(asked, reused.deps);
    expect(reused.calls.some((c) => c.includes('--role'))).toBe(false);
    // An installation before 0.4.1 keeps its `bm-<cloud>` connection.
    const pool = reused.requests.find((r) =>
      r.startsWith('POST /v1/node-pools '),
    )!;
    expect(JSON.parse(pool.slice(pool.indexOf('{')))).toMatchObject({
      credentialName: 'bm-aws',
    });

    // anycloud's sign-in failures: a signed-out CLI's actionRequired, and a
    // typed refusal.
    const failing = (stdout: string) => {
      const { deps, calls } = setUp();
      const run = deps.runLong;
      deps.runLong = async (args) => {
        if (!args.includes('--apply')) return run(args);
        calls.push(args.join(' '));
        throw new StepFailed(args, stdout, '', { cause: new Error('exit') });
      };
      return { deps, calls };
    };
    const signedOut = failing(
      '{"actionRequired":{"code":"CLOUD_SIGN_IN_REQUIRED","message":"aws is signed out","command":"aws sso login"}}\n',
    );
    await expect(install(asked, signedOut.deps)).rejects.toThrow(
      "aws's CLI needs a sign-in: run `aws sso login`. Run install again; the control plane stays and is reused.",
    );
    expect(signedOut.calls.some((c) => c.startsWith('api access add'))).toBe(
      false,
    );
    const refused = failing(
      '{"error":{"code":"CLOUD_RIGHTS_MISSING","message":"ops lacks iam:CreateRole"}}\n',
    );
    await expect(install(asked, refused.deps)).rejects.toThrow(
      "aws's role connection wasn't made: credentials new failed: ops lacks iam:CreateRole (CLOUD_RIGHTS_MISSING). Run install again",
    );
  });

  it.each([
    ['gcp', 'gcp:us-central1', ['--project-id', 'proj-1']],
    ['azure', 'azure:westus2', ['--subscription-id', 'sub-1']],
    // AWS takes no flag: anycloud's aws resolves this environment's account.
    ['aws', 'aws:us-east-2', []],
  ] as const)(
    "makes %s's role in the plan's account, with no terminal",
    async (cloud, target, flags) => {
      const { deps, calls } = setUp(
        { tty: false, env: { AWS_PROFILE: 'ops' } },
        {
          'vm-types gcp us-central1': JSON.stringify(CATALOG.gcp),
          'vm-types azure westus2': JSON.stringify(CATALOG.azure),
        },
      );
      const opts = { ...options, controlPlane: target };
      const { planId } = (await install({ ...opts, plan: true }, deps)) as {
        planId: string;
      };
      await install({ ...opts, planId }, deps);
      expect(calls).toContain(
        [
          `credentials new ${BM[cloud]} --provider ${cloud} --role --apply`,
          ...flags,
          '--json',
        ].join(' '),
      );
    },
  );

  it("goes on with Azure's quotas unread when az is refused the usage read", async () => {
    const { deps, calls, lines } = setUp(
      { tty: false },
      { 'vm-types azure westus2': JSON.stringify(CATALOG.azure) },
    );
    const command = deps.command;
    deps.command = async (args) => {
      if (args[0] === 'az' && args[2] === 'list-usage') {
        throw new Error('AuthorizationFailed');
      }
      return command(args);
    };
    const opts = { ...options, controlPlane: 'azure:westus2' };
    const { planId } = (await install({ ...opts, plan: true }, deps)) as {
      planId: string;
    };
    await install({ ...opts, planId }, deps);
    expect(lines).toContain(
      "azure's quotas couldn't be read, so the plan shows them as unread.",
    );
    expect(calls.some((c) => c.startsWith('cluster create'))).toBe(true);
  });

  it('removes a role connection made in another account, so a re-run makes it again', async () => {
    const { deps, calls } = setUp({ roleIn: '210987654321' });
    await expect(install(asked, deps)).rejects.toThrow(
      "aws's CLI made the role in account 210987654321, not 123456789012, which install read and the plan names. The connection is removed. Delete the CloudFormation stack anycloud-role-c1-anycloud-sh it left in account 210987654321 (us-east-2), sign aws in to 123456789012, and run install again.",
    );
    expect(calls).toContain(`credentials delete ${BM.aws}`);
    expect(calls.some((c) => c.startsWith('api access add'))).toBe(false);
  });
  it("removes a saved role connection in another account than the plan's", async () => {
    // A run cut short after anycloud saved it, or whose delete failed.
    const listed = (account: string) => ({
      'credentials list --json': JSON.stringify([
        {
          name: 'bm-aws',
          kind: 'role',
          roleArn: `arn:aws:iam::${account}:role/anycloud-role-Role-1`,
        },
      ]),
    });
    const { deps, calls } = setUp({}, listed('210987654321'));
    await expect(install(asked, deps)).rejects.toThrow(
      "aws's CLI made the role in account 210987654321, not 123456789012",
    );
    expect(calls).toContain('credentials delete bm-aws');
    // One in the plan's account is reused.
    const kept = setUp({}, listed('123456789012'));
    await install(asked, kept.deps);
    expect(kept.calls.some((c) => /^credentials (new|delete)/.test(c))).toBe(
      false,
    );
  });

  it('says the mismatch even when removing the connection fails', async () => {
    const { deps } = setUp({ roleIn: '210987654321' });
    const run = deps.run;
    deps.run = async (args) => {
      if (args[1] === 'delete') throw new Error('API unreachable');
      return run(args);
    };
    await expect(install(asked, deps)).rejects.toThrow(
      `aws's CLI made the role in account 210987654321, not 123456789012, which install read and the plan names. Removing the connection ${BM.aws} failed, so run install again to remove it.`,
    );
  });

  it("stops at a failed cluster create with anycloud's reason, before anything else", async () => {
    const { deps, calls } = setUp();
    const run = deps.runLong;
    deps.runLong = async (args) => {
      if (args[1] !== 'create') return run(args);
      calls.push(args.join(' '));
      // As 0.1.74 fails with --json: exit 1, the error document on stdout.
      throw new StepFailed(
        args,
        '{"error":{"code":"CLOUD_RIGHTS_MISSING","message":"arn:aws:iam::123456789012:user/ops lacks ec2:RunInstances"}}\n',
        '[12:00:00] Using aws account 123456789012 as arn:aws:iam::123456789012:user/ops\n',
        { cause: new Error('exit 1') },
      );
    };
    await expect(install(asked, deps)).rejects.toThrow(
      'cluster create failed: arn:aws:iam::123456789012:user/ops lacks ec2:RunInstances (CLOUD_RIGHTS_MISSING)',
    );
    expect(calls.at(-1)).toMatch(/^cluster create backmesh /);
  });

  it('hands the listener its classes as BACKMESH_RUNNERS in its Secret', async () => {
    const { deps, requests } = setUp({ env: OVERRIDE });
    await install(options, deps);
    const secret = requests.find((r) =>
      r.startsWith('PUT /v1/secrets/backmesh-acme '),
    )!;
    const routes = parseRoutes(
      JSON.parse(secret.split(' ')[2]!).values.BACKMESH_RUNNERS,
    );
    expect(routes).toHaveLength(16);
    expect(routes.find((r) => r.label === 'backmesh-kvm-od-4')).toEqual({
      label: 'backmesh-kvm-od-4',
      code: 'l4',
      cloud: 'aws',
      region: 'us-east-2',
      credentials: BM.aws,
      vcpus: 4,
      spot: false,
      kvm: true,
      vmTypes: ['m8i.xlarge', 'm7i.xlarge'],
      regions: ['us-east-2'],
    });
  });

  it("refuses a region's quota under one backmesh-4 VM, before anything is billed", async () => {
    const { deps, calls } = setUp({
      env: OVERRIDE,
      quota: { 'L-34B43A08': '2.0', 'L-1216C47A': '128.0' },
    });
    await expect(install(options, deps)).rejects.toThrow(
      /Can't run the runners:\n- aws allows 2 spot vCPUs, under one 4-vCPU VM/,
    );
    expect(calls.some((c) => c.startsWith('cluster create'))).toBe(false);
  });

  it('refuses without --yes and without a terminal, before anything runs', async () => {
    const { deps, calls } = setUp({ tty: false });
    await expect(install({ ...options, yes: false }, deps)).rejects.toThrow(
      'pass --yes',
    );
    expect(calls).toEqual([]);
  });

  it('creates nothing when the user declines at the terminal', async () => {
    const confirm = vi.fn(async () => false);
    const { deps, calls } = setUp({ env: OVERRIDE, confirm });
    await expect(install({ ...options, yes: false }, deps)).rejects.toThrow(
      'Install cancelled before anything billed was created',
    );
    expect(confirm).toHaveBeenCalledOnce();
    expect(calls.some((c) => c.startsWith('cluster create'))).toBe(false);
  });

  it('names a label that would start no runners, and asks before going on, no unless yes', async () => {
    // 6 spot vCPUs in us-east-2: under one 8- or 16-vCPU spot runner.
    const confirm = vi.fn(
      async (question: string) => !question.includes('start no runners'),
    );
    const { deps, calls, lines } = setUp({
      env: OVERRIDE,
      confirm,
      quota: { 'L-34B43A08': '6.0', 'L-1216C47A': '128.0' },
    });
    await expect(install({ ...options, yes: false }, deps)).rejects.toThrow(
      'Install cancelled before anything billed was created. Raise the quotas named above, then run install again.',
    );
    expect(lines).toContain(
      "backmesh-8 would start no runners: every runner region's spot quota is under one 8-vCPU runner (us-east-2 6 vCPU); raise L-34B43A08 in us-east-2 to use it.",
    );
    expect(confirm).toHaveBeenCalledWith(
      '4 labels would start no runners until a quota is raised. Install anyway?',
    );
    expect(calls.some((c) => c.startsWith('cluster create'))).toBe(false);
  });

  it('refuses an anycloud without release 1, C26 or role connections', async () => {
    const unreleased = { ...RELEASED, 'release-1': undefined, c26: '9.0.0' };
    await expect(
      install(asked, setUp({ features: unreleased }).deps),
    ).rejects.toThrow('lacks release-1, c26, which backmesh needs');
    // Our CI's override skips none of them.
    await expect(
      install(options, setUp({ env: OVERRIDE, features: unreleased }).deps),
    ).rejects.toThrow('lacks release-1, c26, which');
  });

  describe('prerequisites', () => {
    // A cloud CLI's failure as Node's execFile reports it: the command,
    // then the CLI's own stderr.
    const failed = (args: string[], stderr: string) =>
      new Error(`Command failed: ${args.join(' ')}\n${stderr}`);
    const GCLOUD_STDERR =
      'ERROR: (gcloud.compute.regions.list) The required property [project] is not currently set.';

    // The owner's repro: a gcloud with no project. The run stops at
    // the prerequisites, before any region or quota read prints a fallback.
    it('stops a gcloud with no project at one line, before reading its regions', async () => {
      const { deps, lines } = setUp({ tty: false });
      const command = deps.command;
      const reads: string[] = [];
      deps.command = async (args) => {
        reads.push(args.join(' '));
        if (args.join(' ') === 'gcloud config get-value project') return '\n';
        if (args[1] === 'compute') throw failed(args, GCLOUD_STDERR);
        return command(args);
      };
      const error = await install(
        { ...options, plan: true, controlPlane: 'gcp:us-east4' },
        deps,
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UsageError);
      expect((error as Error).message).toBe(
        'gcloud has no project set: run `gcloud config set project <id>`.',
      );
      expect(reads.some((r) => r.startsWith('gcloud compute'))).toBe(false);
      expect(lines).toEqual([]);
    });

    it("names each failure in one line, and the CLI's own error only with --verbose", async () => {
      const outcome = async (verbose: boolean) => {
        const { deps } = setUp({ env: { AWS_REGION: '' } });
        deps.verbose = verbose;
        deps.command = async (args) => {
          if (args[0] === 'gcloud') {
            throw Object.assign(new Error('spawn gcloud ENOENT'), {
              code: 'ENOENT',
            });
          }
          if (args[0] === 'az') {
            throw failed(
              args,
              "ERROR: Please run 'az login' to setup account.",
            );
          }
          if (args[0] === 'aws') {
            throw failed(
              args,
              'Unable to locate credentials. You can configure credentials by running "aws configure".',
            );
          }
          return '';
        };
        return install(
          { ...asked, runners: ['aws', 'gcp', 'azure'] },
          deps,
        ).catch((e: unknown) => (e as Error).message);
      };
      expect(await outcome(false)).toBe(
        [
          "aws isn't signed in: run `aws sso login`.",
          "gcloud isn't on PATH: install the Google Cloud CLI.",
          "az isn't signed in to a subscription: run `az login`.",
        ].join('\n'),
      );
      expect(await outcome(true)).toBe(
        [
          "aws isn't signed in: run `aws sso login`.",
          '  Command failed: aws sts get-caller-identity --output json',
          '  Unable to locate credentials. You can configure credentials by running "aws configure".',
          "gcloud isn't on PATH: install the Google Cloud CLI.",
          '  spawn gcloud ENOENT',
          "az isn't signed in to a subscription: run `az login`.",
          '  Command failed: az account show --output json',
          "  ERROR: Please run 'az login' to setup account.",
        ].join('\n'),
      );
    });

    it("gives AWS children the target's region unless the user set one", async () => {
      for (const [env, region] of [
        // No region anywhere: anycloud's CloudFormation call gets us-east-2.
        [{}, 'us-east-2'],
        [{ AWS_REGION: 'us-west-2' }, undefined],
        [{ AWS_DEFAULT_REGION: 'us-west-2' }, undefined],
      ] as const) {
        const { deps } = setUp({ env });
        const envs = new Map<string, NodeJS.ProcessEnv | undefined>();
        const { runLong, command } = deps;
        deps.runLong = (args, childEnv) => {
          envs.set(args.slice(0, 3).join(' '), childEnv);
          return runLong(args, childEnv);
        };
        deps.command = (args, childEnv) => {
          envs.set(args.slice(0, 3).join(' '), childEnv);
          return command(args, childEnv);
        };
        await expect(install(asked, deps)).resolves.toBeDefined();
        const want = region ? { AWS_REGION: region } : {};
        expect(envs.get(`credentials new ${BM.aws}`)).toEqual(want);
        expect(envs.get('aws sts get-caller-identity')).toEqual(want);
        // The user's AWS config isn't read or changed.
        expect(
          [...envs.keys()].some((k) => k.startsWith('aws configure')),
        ).toBe(false);
      }
    });
  });

  const control = {
    id: 'p1',
    name: 'bm-control',
    state: 'running',
    allowPrivilegedJobs: false,
    cloudProvider: 'AWS',
    region: 'us-east-2',
  };
  const listener = {
    id: 'd1',
    name: 'backmesh-acme',
    nodePoolId: 'p1',
    managed: false,
    deletedAt: null,
    image: images.listenerImage,
  };
  // The classes install plans for aws:us-east-2, as acme's listener runs
  // them, and its answer to the CLI's probe.
  const RUNNERS = JSON.stringify(
    planClasses(
      [{ cloud: 'aws', region: 'us-east-2', credentials: 'bm-aws' }],
      catalogs({ aws: CATALOG.aws }),
      'aws',
    ).classes,
  );
  const probe = (env: Record<string, string> = {}) => ({
    'exec backmesh-acme': JSON.stringify({
      code: 200,
      env: {
        ORG: 'acme',
        BACKMESH_RUNNER_IMAGE: images.runnerImage,
        BACKMESH_INSTALL_KEY: INSTALL_KEY,
        BACKMESH_RUNNERS: RUNNERS,
        ...env,
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

  it('refuses a bm-control that breaks invariant 3, before step 6', async () => {
    const privileged = setUp({
      env: OVERRIDE,
      pools: [{ ...control, allowPrivilegedJobs: true }],
    });
    await expect(install(options, privileged.deps)).rejects.toThrow(
      'bm-control admits privileged Jobs',
    );
    const shared = setUp({
      env: OVERRIDE,
      pools: [control],
      workloads: [{ id: 'web', workloadType: 'service', nodePoolId: 'p1' }],
      deployments: [
        listener,
        { ...listener, id: 'd2', name: 'api' },
        { ...listener, id: 'd3', managed: true },
      ],
    });
    await expect(install(options, shared.deps)).rejects.toThrow(
      'bm-control runs more than the listeners: Deployment api, Deployment backmesh-acme (managed), workload web',
    );
    expect(shared.calls.some((c) => /^(api access|deployment)/.test(c))).toBe(
      false,
    );
  });

  it("refuses a managed listener's Deployment on bm-control", async () => {
    const managed = setUp({
      env: OVERRIDE,
      pools: [control],
      deployments: [{ ...listener, managed: true }],
    });
    await expect(install(options, managed.deps)).rejects.toThrow(
      'bm-control runs more than the listeners: Deployment backmesh-acme (managed)',
    );
    const unmanaged = setUp(
      {
        env: OVERRIDE,
        pools: [control],
        deployments: [listener],
        hosted: true,
      },
      probe(),
    );
    await expect(install(options, unmanaged.deps)).resolves.toBeDefined();
  });

  it('ignores a deleted Deployment on bm-control', async () => {
    const { deps } = setUp(
      {
        env: OVERRIDE,
        pools: [control],
        deployments: [
          listener,
          { ...listener, id: 'd2', name: 'api', deletedAt: 1 },
        ],
        hosted: true,
      },
      probe(),
    );
    await expect(install(options, deps)).resolves.toBeDefined();
  });

  it("refuses a listener's Deployment on another pool", async () => {
    const { deps, calls } = setUp({
      env: OVERRIDE,
      pools: [control, { id: 'p2', name: 'web', state: 'running' }],
      deployments: [{ ...listener, nodePoolId: 'p2' }],
    });
    await expect(install(options, deps)).rejects.toThrow(
      'A Deployment named backmesh-acme runs outside bm-control, on node pool p2',
    );
    expect(calls.some((c) => c.startsWith('api access add'))).toBe(false);
  });

  describe('adding an org to a control plane', () => {
    const beta = { ...listener, id: 'd2', name: 'backmesh-beta' };
    const adding = (
      confirm?: (question: string) => Promise<boolean>,
      hosted = true,
    ) =>
      setUp({
        env: OVERRIDE,
        pools: [control],
        deployments: [beta],
        tty: !!confirm,
        confirm,
        hosted,
      });
    const planOf = async (deps: InstallDeps) =>
      (await install({ ...options, plan: true }, deps)) as InstallPlan & {
        planId: string;
      };

    it("keeps this machine's control plane, and refuses moving it", async () => {
      const { deps, lines } = adding();
      const plan = await install({ org: 'acme', yes: false, plan: true }, deps);
      expect(plan).toMatchObject({
        controlPlane: { cloud: 'aws', region: 'us-east-2', exists: true },
      });
      expect(lines.some((l) => l.startsWith('The control plane goes'))).toBe(
        false,
      );
      const moved = adding();
      const error = await install(
        { ...options, controlPlane: 'aws:us-east-1', plan: true },
        moved.deps,
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UsageError);
      expect((error as Error).message).toBe(
        "This machine's control plane is on aws us-east-2, and it can't move: pass --control-plane aws:us-east-2, or uninstall it first.",
      );
    });

    it("places a re-run by the control plane's own record, and needs --control-plane without one", async () => {
      // An install that stopped before bm-control: the cluster record says
      // where it runs.
      const binary = {
        'cluster list --json': JSON.stringify([
          { id: 'c1', cloudProvider: 'AWS', region: 'us-west-2' },
        ]),
        'vm-types aws us-west-2': JSON.stringify(CATALOG.aws),
      };
      const recorded = setUp({ env: OVERRIDE, hosted: true }, binary);
      await expect(
        install({ org: 'acme', yes: false, plan: true }, recorded.deps),
      ).resolves.toMatchObject({
        controlPlane: { cloud: 'aws', region: 'us-west-2', exists: true },
      });

      // Neither a record nor bm-control: no default, at a terminal either.
      const unknown = setUp({ env: OVERRIDE, hosted: true });
      const error = await install(
        { org: 'acme', yes: false },
        unknown.deps,
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UsageError);
      expect((error as Error).message).toBe(
        `This machine targets the control plane at ${HOSTED}, and install can't read where it runs: pass --control-plane <cloud>:<region> as it was created.`,
      );
      expect(unknown.calls.some((c) => c.startsWith('cluster create'))).toBe(
        false,
      );
      await expect(
        install(
          { ...options, plan: true },
          setUp({ env: OVERRIDE, hosted: true }).deps,
        ),
      ).resolves.toMatchObject({ controlPlane: { region: 'us-east-2' } });
    });

    it('folds the same-owner check into the plan, which --plan-id agrees to', async () => {
      const { deps, calls, requests, lines } = adding();
      const plan = await planOf(deps);
      expect(plan.controlPlane).toMatchObject({
        exists: true,
        sharedWith: ['beta'],
      });
      expect(plan.sameOwner).toMatch(
        /^acme joins the control plane of beta\. .* must have the same owner\.$/,
      );
      expect(lines).toContain(plan.sameOwner);
      const result = await install({ ...options, planId: plan.planId }, deps);

      // The joining org gets its own cache bucket, and nothing else.
      expect(requests.filter((r) => r.startsWith('POST'))).toEqual([
        expect.stringMatching(
          /^POST \/v1\/credentials\/bm-aws-lz9d56\/storage-tokens/,
        ),
      ]);
      expect(calls.filter((c) => /^(api access|deployment)/.test(c))).toEqual([
        'api access add --service-account backmesh-acme',
        expect.stringMatching(/^deployment create backmesh-acme /),
      ]);
      expect(
        requests.filter((r) => r.startsWith('PUT /v1/secrets/backmesh-')),
      ).toEqual([expect.stringMatching(/^PUT \/v1\/secrets\/backmesh-acme /)]);
      // The tag is the org's, not the cluster's alone.
      expect((result as { install: string }).install).toBe(installTag('c1', 7));
      expect((result as { install: string }).install).not.toBe(
        installTag('c1', 8),
      );
      expect(lines).toContain(
        "Adding acme to beta's control plane: the plan says they have one owner.",
      );
    });

    it("stops before its registration when the plan didn't show the other orgs", async () => {
      // This machine had no target, so the plan saw a new control plane;
      // `cluster create` resumed beta's.
      const { deps, calls } = adding(undefined, false);
      const plan = await planOf(deps);
      expect(plan.sameOwner).toBeNull();
      const error = await install(
        { ...options, planId: plan.planId },
        deps,
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PlanChanged);
      expect((error as Error).message).toMatch(
        /^This control plane runs backmesh for beta, which the plan didn't show\./,
      );
      expect(calls.some((c) => /^(api access|deployment)/.test(c))).toBe(false);
    });

    it('takes no same-owner agreement from --yes alone, on our CI override', async () => {
      // The plan this run read shows beta, but nobody agreed to it.
      const { deps, calls } = adding();
      await expect(install(options, deps)).rejects.toThrow(PlanChanged);
      expect(calls.some((c) => /^(api access|deployment)/.test(c))).toBe(false);
    });

    it('asks at a terminal when the plan missed them, and creates nothing on a no', async () => {
      const questions: string[] = [];
      // Yes to the plan, no to the same-owner question it couldn't show.
      const no = adding(
        async (question) => questions.push(question) === 1,
        false,
      );
      await expect(install(asked, no.deps)).rejects.toThrow(
        "acme wasn't added: separate owners use separate installations.",
      );
      expect(questions).toEqual([
        'Proceed?',
        expect.stringMatching(
          /^acme joins the control plane of beta\..* Do they\?$/,
        ),
      ]);
      // A plan that shows them asks once, the same-owner question included.
      const once: string[] = [];
      const yes = adding(async (question) => (once.push(question), true));
      await expect(install(asked, yes.deps)).resolves.toMatchObject({
        org: 'acme',
      });
      expect(once).toEqual([
        'Do they all have the same owner, and should install create these resources in your clouds?',
      ]);
    });

    it('asks nothing on a re-run for an org already on it, whatever its case', async () => {
      const { deps, calls, worker } = setUp(
        {
          env: { ...OVERRIDE, GITHUB_TOKEN: 'gho_x' },
          pools: [control],
          deployments: [beta, listener],
          hosted: true,
        },
        probe(),
      );
      await install({ ...options, org: 'ACME' }, deps);
      // Its running listener keeps its key: no new sign-in.
      expect(worker.calls).not.toContain('POST /v1/installs/device');
      expect(worker.calls).not.toContain('POST /v1/installs');
      expect(calls.some((c) => c.startsWith('deployment create'))).toBe(false);
    });
  });

  it('changes nothing on a re-run of the plan the listener already runs', async () => {
    const asked: string[] = [];
    const { deps, calls, commands, requests, lines } = setUp(
      {
        env: OVERRIDE,
        pools: [control],
        deployments: [listener],
        hosted: true,
        cacheBuckets: ['bm-cache-l8u5e-us-east-2'],
        confirm: async (question) => {
          asked.push(question);
          return true;
        },
      },
      probe(),
    );
    const plan = await install({ ...options, plan: true }, deps);
    expect(plan).toMatchObject({
      current: expect.stringMatching(/^[0-9a-f]{12}$/),
      changes: {
        added: [],
        removed: [],
        labelsAdded: [],
        labelsRemoved: [],
        labelsChanged: [],
        regions: [],
      },
    });
    await install({ ...options, yes: false }, deps);
    // Nothing to agree to, so nothing is asked.
    expect(asked).toEqual([]);
    // The routes' `bm-aws`, from before 0.4.1, is the connection install
    // keeps, here made again since the hosted API lists none.
    expect(
      calls
        .filter((c) => c.startsWith('credentials new'))
        .map((c) => c.split(' ')[2]),
    ).toEqual(['bm-aws']);
    expect(requests.filter((r) => /^(POST|PUT)/.test(r))).toEqual([]);
    expect(calls.some((c) => c.startsWith('deployment'))).toBe(false);
    expect(lines).toContain(
      "No changes: acme's listener already runs this plan.",
    );
    // Its disks are left as they are.
    expect(commands.filter((c) => c.startsWith('aws ec2'))).toEqual([]);
  });

  it("rolls a re-run that only reorders a label's VM types, with no consent asked", async () => {
    // Simulates an org installed before the VM type reorder: its
    // backmesh-kvm-4 listed m7i before m8i.
    const before = (
      JSON.parse(RUNNERS) as { label: string; vmTypes: string[] }[]
    ).map((c) =>
      c.label === 'backmesh-kvm-4'
        ? { ...c, vmTypes: [...c.vmTypes].reverse() }
        : c,
    );
    const asked: string[] = [];
    const { deps, requests, lines } = setUp(
      {
        env: OVERRIDE,
        pools: [control],
        deployments: [listener],
        hosted: true,
        cacheBuckets: ['bm-cache-l8u5e-us-east-2'],
        confirm: async (question) => {
          asked.push(question);
          return true;
        },
      },
      probe({ BACKMESH_RUNNERS: JSON.stringify(before) }),
    );
    const plan = await install({ ...options, plan: true }, deps);
    // Same types, so no consent is needed.
    expect(plan).toMatchObject({ changes: { labelsChanged: [] } });
    // `--plan` itself says a reorder is coming, not the misleading "No
    // changes" line, even though it can't yet know the account-allowed
    // narrowing.
    expect(lines).toContain('VM type order updated; no consent needed.');
    expect(lines).not.toContain(
      "No changes: acme's listener already runs this plan.",
    );
    const planLines = [...lines];
    await install({ ...options, yes: false }, deps);
    expect(asked).toEqual([]);
    // Says a reorder is happening, not the misleading "No changes" line a
    // true no-op re-run gets (below).
    expect(lines).toContain('VM type order updated; no consent needed.');
    expect(lines).not.toContain(
      "No changes: acme's listener already runs this plan.",
    );
    expect(lines).toContain("Rolling acme's listener with the new settings.");
    // Exactly once per call — the real run's early, optimistic check
    // doesn't also print it, only its later, narrowed one.
    const realLines = lines.slice(planLines.length);
    const say = (ls: string[]) =>
      ls.filter((l) => l === 'VM type order updated; no consent needed.')
        .length;
    expect(say(planLines)).toBe(1);
    expect(say(realLines)).toBe(1);
    const secret = requests.find((r) =>
      r.startsWith('PUT /v1/secrets/backmesh-acme '),
    )!;
    const runners = JSON.parse(
      JSON.parse(secret.split(' ')[2]!).values.BACKMESH_RUNNERS,
    ) as { label: string; vmTypes: string[] }[];
    // The Secret gets this release's order, even though nothing needed consent.
    expect(runners.find((r) => r.label === 'backmesh-kvm-4')?.vmTypes).toEqual([
      'm8i.xlarge',
      'm7i.xlarge',
    ]);
  });

  it('changes the cache cap on a re-run: in the plan and its ID, then the Secret and a roll', async () => {
    const rerun = (env: Record<string, string> = {}) =>
      setUp(
        {
          env: OVERRIDE,
          pools: [control],
          deployments: [listener],
          hosted: true,
          cacheBuckets: ['bm-cache-l8u5e-us-east-2'],
        },
        probe(env),
      );
    const before = await install({ ...options, plan: true }, rerun().deps);
    const { deps, calls, requests, lines } = rerun();
    const plan = await install(
      { ...options, cacheCapGb: 25, plan: true },
      deps,
    );
    expect(plan).toMatchObject({ cacheCapGb: 25 });
    expect('planId' in plan && 'planId' in before && plan.planId).not.toBe(
      'planId' in before && before.planId,
    );
    expect(lines).toContain(
      'Cache: each repository keeps up to 25 GB in each region.',
    );

    await install({ ...options, cacheCapGb: 25 }, deps);
    const secret = requests.find((r) =>
      r.startsWith('PUT /v1/secrets/backmesh-acme '),
    )!;
    expect(JSON.parse(secret.split(' ')[2]!).values).toMatchObject({
      BACKMESH_CACHE_CAP_GB: '25',
    });
    expect(calls).toContainEqual(
      expect.stringMatching(/^deployment upgrade backmesh-acme /),
    );

    // A later re-run without --cache-cap keeps it, and changes nothing; nor
    // does one whose Secret holds no positive number, read as the default.
    for (const cap of ['25', 'abc', '-5']) {
      const kept = rerun({ BACKMESH_CACHE_CAP_GB: cap });
      await install(options, kept.deps);
      expect(
        kept.requests.filter((r) => r.startsWith('PUT /v1/secrets/')),
        cap,
      ).toEqual([]);
      expect(
        kept.calls.some((c) => c.startsWith('deployment')),
        cap,
      ).toBe(false);
    }
  });

  it('adds and keeps the public labels with --public-repos, and retires them with --no-public-repos', async () => {
    const rerun = (env: Record<string, string> = {}) =>
      setUp(
        {
          env: OVERRIDE,
          pools: [control],
          deployments: [listener],
          hosted: true,
          cacheBuckets: ['bm-cache-l8u5e-us-east-2'],
        },
        probe(env),
      );
    const secretRunners = (requests: string[]): string =>
      JSON.parse(
        requests
          .find((r) => r.startsWith('PUT /v1/secrets/backmesh-acme '))!
          .split(' ')[2]!,
      ).values.BACKMESH_RUNNERS;
    const runnersOf = (requests: string[]) =>
      parseRoutes(secretRunners(requests));
    const on = rerun();
    await install({ ...options, publicRepos: true }, on.deps);
    expect(on.lines).toContain(PUBLIC_REPOS_LINE);
    expect(on.lines).toContain(
      'New labels: backmesh-public-2, backmesh-public-4.',
    );
    const routes = runnersOf(on.requests);
    expect(
      routes.filter((r) => r.public).map(({ label, code }) => [label, code]),
    ).toEqual([
      ['backmesh-public-2', 'c2'],
      ['backmesh-public-4', 'c4'],
    ]);

    // A re-run without the flag keeps them, and changes nothing.
    const json = secretRunners(on.requests);
    const kept = rerun({ BACKMESH_RUNNERS: json });
    await install(options, kept.deps);
    expect(
      kept.requests.filter((r) => r.startsWith('PUT /v1/secrets/')),
    ).toEqual([]);

    // --no-public-repos retires them like any removed class.
    const off = rerun({ BACKMESH_RUNNERS: json });
    await install({ ...options, publicRepos: false }, off.deps);
    expect(off.lines).not.toContain(PUBLIC_REPOS_LINE);
    expect(
      runnersOf(off.requests)
        .filter((r) => r.public)
        .map(({ label, retiring }) => [label, retiring]),
    ).toEqual([
      ['backmesh-public-2', true],
      ['backmesh-public-4', true],
    ]);
  });

  it('adds a cloud to a running listener: the plan shows it, then the Secret and a roll', async () => {
    const binary = { 'vm-types gcp us-east4': JSON.stringify(CATALOG.gcp) };
    const rerun = () =>
      setUp(
        {
          env: OVERRIDE,
          pools: [control],
          deployments: [listener],
          hosted: true,
        },
        { ...probe(), ...binary },
      );
    const added = { ...options, runners: ['aws', 'gcp'] };
    const { deps, calls, requests, lines } = rerun();
    const plan = await install({ ...added, plan: true }, deps);
    expect(plan).toMatchObject({
      changes: {
        added: ['gcp'],
        removed: [],
        labelsRemoved: [],
        labelsChanged: [],
        labelsAdded: expect.arrayContaining(['backmesh-gcp-4']),
      },
    });
    expect(lines).toContain("acme's runners add gcp us-east4.");
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^New labels: backmesh-gcp-2, /),
      ]),
    );

    await install(added, deps);
    const secret = requests.find((r) =>
      r.startsWith('PUT /v1/secrets/backmesh-acme '),
    )!;
    const { values } = JSON.parse(secret.split(' ')[2]!) as {
      values: Record<string, string>;
    };
    expect(values).toMatchObject({
      ORG: 'acme',
      BACKMESH_RUNNER_IMAGE: images.runnerImage,
      BACKMESH_INSTALL_KEY: INSTALL_KEY,
    });
    const labels = parseRoutes(values.BACKMESH_RUNNERS!).map((r) => r.label);
    // The home cloud's labels stay plain.
    expect(labels).toEqual(
      expect.arrayContaining(['backmesh-4', 'backmesh-gcp-4']),
    );
    expect(calls).toContain(
      `deployment upgrade backmesh-acme --image ${images.listenerImage} --secret backmesh-acme --cpus 0.5 --wait`,
    );
    expect(calls.some((c) => c.startsWith('deployment create'))).toBe(false);
    expect(lines).toContain("Rolling acme's listener with the new settings.");
    // The saved control plane answered, so this re-run never ran `cluster
    // create` or anything else on its cloud: adding gcp needed only gcp's
    // vm-types read and its role connection.
    expect(calls.some((c) => c.startsWith('cluster create'))).toBe(false);
    expect(calls).toContain(`api use ${HOSTED}`);
  });

  it('reuses an answering saved control plane, touching no aws command at all', async () => {
    // An aws control plane, `bm-control` running: adding gcp runners alone
    // (not aws, which this run doesn't name) should need no aws command,
    // neither through the anycloud binary nor the user's own aws CLI.
    const binary = { 'vm-types gcp us-east4': JSON.stringify(CATALOG.gcp) };
    const { deps, calls, commands, requests } = setUp(
      {
        env: OVERRIDE,
        pools: [control],
        deployments: [listener],
        hosted: true,
      },
      { ...probe(), ...binary },
    );
    await install({ ...options, runners: ['gcp'] }, deps);

    expect(calls.some((c) => c.startsWith('cluster create'))).toBe(false);
    expect(calls.some((c) => / aws\b|-aws\b/.test(c))).toBe(false);
    expect(commands.some((c) => c.startsWith('aws '))).toBe(false);
    expect(calls).toContain(`api use ${HOSTED}`);
    expect(
      calls.some(
        (c) =>
          c.includes(`credentials new ${BM.gcp}`) && c.includes('--generate'),
      ),
    ).toBe(true);
    // The runners still rolled with gcp added.
    const secret = requests.find((r) =>
      r.startsWith('PUT /v1/secrets/backmesh-acme '),
    )!;
    const labels = parseRoutes(
      (
        JSON.parse(secret.split(' ')[2]!) as {
          values: { BACKMESH_RUNNERS: string };
        }
      ).values.BACKMESH_RUNNERS,
    ).map((r) => r.label);
    expect(labels).toEqual(expect.arrayContaining(['backmesh-gcp-4']));
  });

  it("connects a reused control plane's cloud when its bm-control pool is still missing", async () => {
    // A first install whose `cluster create` finished but whose aws role
    // connection failed: the API answers and its record is named `backmesh`,
    // but aws's connection and `bm-control` don't exist. The re-run reuses the
    // cluster, yet still connects aws, since step 7 creates `bm-control`
    // with that connection.
    const binary = { 'vm-types gcp us-east4': JSON.stringify(CATALOG.gcp) };
    const { deps, calls, requests } = setUp(
      { env: OVERRIDE, hosted: true },
      {
        ...binary,
        'cluster list --json': JSON.stringify([
          {
            id: 'c1',
            name: 'backmesh',
            cloudProvider: 'AWS',
            region: 'us-east-2',
          },
        ]),
      },
    );
    await install({ ...options, runners: ['gcp'] }, deps);

    expect(calls.some((c) => c.startsWith('cluster create'))).toBe(false);
    expect(calls.some((c) => c.startsWith(`credentials new ${BM.aws}`))).toBe(
      true,
    );
    const pool = requests.find((r) => r.startsWith('POST /v1/node-pools '))!;
    expect(JSON.parse(pool.slice(pool.indexOf('{')))).toMatchObject({
      name: 'bm-control',
      credentialName: BM.aws,
      region: 'us-east-2',
    });
  });

  it("keeps today's path for a targeted API that isn't recognizably backmesh's own", async () => {
    // Answering, and its location known (a cluster record this machine's
    // target resolves to), but named for something else entirely and
    // without a `bm-control`: this machine's active target may be the
    // user's own, unrelated anycloud cluster, so install never reuses it,
    // and everything runs as it did before this change, aws CLI included.
    const { deps, calls, commands } = setUp(
      { env: OVERRIDE, hosted: true },
      {
        'cluster list --json': JSON.stringify([
          {
            id: 'c1',
            name: 'staging',
            cloudProvider: 'AWS',
            region: 'us-east-2',
          },
        ]),
      },
    );
    await install(options, deps);
    expect(calls.some((c) => c.startsWith('cluster create'))).toBe(true);
    expect(commands.some((c) => c.startsWith('aws '))).toBe(true);
  });

  it('never reuses a control plane whose location is unknown', async () => {
    // Answering, but with neither `bm-control` nor a `cluster list` record:
    // install can't tell where it runs, let alone that it's its own, so
    // --control-plane still names where to create or resume one, as before.
    const { deps, calls } = setUp({ env: OVERRIDE, hosted: true });
    await install({ ...options, controlPlane: 'aws:us-east-2' }, deps);
    expect(calls.some((c) => c.startsWith('cluster create'))).toBe(true);
  });

  it('creates the control plane as before with no saved API, or one that never answers', async () => {
    // No saved API: a fresh machine, today's unconditional `cluster create`.
    const fresh = setUp({ env: OVERRIDE });
    await install(options, fresh.deps);
    expect(fresh.calls.some((c) => c.startsWith('cluster create'))).toBe(true);

    // A saved API that never answers stops install before it reaches
    // `cluster create`, exactly as it did before this change: a non-answering
    // control plane is never silently treated as gone.
    const down = setUp({ env: OVERRIDE, hosted: true });
    const fetch = down.deps.fetch!;
    down.deps.fetch = (async (url: string, init?: RequestInit) => {
      if (String(url) === `${HOSTED}/v1/version`)
        throw new Error('fetch failed');
      return fetch(url, init);
    }) as typeof globalThis.fetch;
    await expect(install(options, down.deps)).rejects.toThrow(
      `The control plane at ${HOSTED} didn't answer; retry, or run \`backmesh status\`.`,
    );
    expect(down.calls.some((c) => c.startsWith('cluster create'))).toBe(false);
  });

  it("carries an unfinished rotate-key rotation's marker through a reinstall's roll, never dropping it", async () => {
    const rotatingFrom = 'cd'.repeat(16);
    const binary = { 'vm-types gcp us-east4': JSON.stringify(CATALOG.gcp) };
    const { deps, requests } = setUp(
      {
        env: OVERRIDE,
        pools: [control],
        deployments: [listener],
        hosted: true,
      },
      { ...probe({ BACKMESH_ROTATING_FROM: rotatingFrom }), ...binary },
    );
    const added = { ...options, runners: ['aws', 'gcp'] };

    await install(added, deps);

    const secret = requests.find((r) =>
      r.startsWith('PUT /v1/secrets/backmesh-acme '),
    )!;
    const { values } = JSON.parse(secret.split(' ')[2]!) as {
      values: Record<string, string>;
    };
    expect(values.BACKMESH_ROTATING_FROM).toBe(rotatingFrom);
  });

  it('counts a label whose VM types change as a change, and rolls', async () => {
    const older = (JSON.parse(RUNNERS) as { vmTypes: string[] }[]).map(
      (route, i) =>
        i ? route : { ...route, vmTypes: route.vmTypes.slice(0, 1) },
    );
    const { deps, calls } = setUp(
      {
        env: OVERRIDE,
        pools: [control],
        deployments: [listener],
        hosted: true,
      },
      probe({ BACKMESH_RUNNERS: JSON.stringify(older) }),
    );
    const plan = (await install(
      { ...options, plan: true },
      deps,
    )) as InstallPlan;
    expect(plan.changes?.labelsChanged).toEqual(['backmesh-2']);
    await install(options, deps);
    expect(calls.some((c) => c.startsWith('deployment upgrade'))).toBe(true);
  });

  it('refuses a plan agreed to before the listener changed', async () => {
    const { deps } = setUp(
      {
        env: OVERRIDE,
        pools: [control],
        deployments: [listener],
        hosted: true,
      },
      probe(),
    );
    const { planId } = (await install({ ...options, plan: true }, deps)) as {
      planId: string;
    };
    // Another install or an upgrade rolled it since.
    const moved = setUp(
      {
        env: OVERRIDE,
        pools: [control],
        deployments: [listener],
        hosted: true,
      },
      probe({
        BACKMESH_RUNNERS: JSON.stringify(
          (JSON.parse(RUNNERS) as unknown[]).slice(1),
        ),
      }),
    );
    await expect(
      install({ ...options, yes: true, planId }, moved.deps),
    ).rejects.toThrow(PlanChanged);
    expect(moved.calls.some((c) => c.startsWith('deployment'))).toBe(false);
  });

  it("refuses a re-run over a listener on another release: that's upgrade's", async () => {
    const { deps, calls } = setUp(
      {
        env: OVERRIDE,
        pools: [control],
        deployments: [listener],
        hosted: true,
      },
      probe({
        BACKMESH_RUNNER_IMAGE: 'ghcr.io/backmesh/backmesh-runner@sha256:old',
      }),
    );
    await expect(install({ ...options, plan: true }, deps)).rejects.toThrow(
      "acme's listener runs another backmesh release than this one: run `backmesh upgrade` first, then install again.",
    );
    expect(calls.some((c) => c.startsWith('deployment'))).toBe(false);
  });

  it("stops when the org's listener appears after a plan that didn't show it", async () => {
    // This machine targeted no control plane, and `cluster create` resumed
    // one where acme's listener runs.
    const { deps, calls } = setUp(
      { env: OVERRIDE, pools: [control], deployments: [listener] },
      probe(),
    );
    await expect(install(options, deps)).rejects.toThrow(PlanChanged);
    expect(calls.some((c) => c.startsWith('deployment'))).toBe(false);
  });

  it("keeps a deployed listener's install key, with no new sign-in", async () => {
    const { deps, worker } = setUp(
      {
        env: { ...OVERRIDE, GITHUB_TOKEN: 'gho_x' },
        pools: [control],
        deployments: [listener],
        hosted: true,
      },
      probe(),
    );
    await install(options, deps);
    // No sign-in; the App check, then the plan lookup after install.
    expect(worker.calls).toEqual(['POST /v1/token']);

    // Signed out, it signs in for the control plane alone: the key stays.
    delete deps.env.GITHUB_TOKEN;
    await install(options, deps);
    const signIns = () =>
      worker.calls.filter(
        (c) => c.startsWith('POST /v1/') && c !== 'POST /v1/token',
      );
    expect(signIns()).toEqual(['POST /v1/installs/device', 'POST /v1/sign-in']);
    const saved = join(deps.env.BACKMESH_ANYCLOUD_DIR!, '.token');
    expect(readFileSync(saved, 'utf8').trim()).toBe(SIGNED_IN);
  });

  it('stops at a failed bm-control before deploying the listener', async () => {
    const { deps, calls } = setUp({
      env: OVERRIDE,
      pools: [{ ...control, state: 'failed', lastError: 'No capacity' }],
    });
    await expect(install(options, deps)).rejects.toThrow(
      'bm-control failed: No capacity. Fix the cause and run install again, which replaces it.',
    );
    expect(calls.some((c) => c.startsWith('deployment create'))).toBe(false);
  });

  it("signs in once with backmesh's GitHub sign-in, which the control plane uses", async () => {
    // Nothing saved and no GITHUB_TOKEN: the key's sign-in is also the
    // control plane's, saved where anycloud reads it, and no anycloud login.
    const fresh = setUp({ env: OVERRIDE });
    const dir = fresh.deps.env.BACKMESH_ANYCLOUD_DIR!;
    await install(options, fresh.deps);
    expect(readFileSync(join(dir, '.token'), 'utf8').trim()).toBe(SIGNED_IN);
    expect(statSync(join(dir, '.token')).mode & 0o777).toBe(0o600);
    expect(fresh.worker.calls.filter((c) => c.startsWith('POST'))).toEqual([
      'POST /v1/installs/device',
      'POST /v1/installs',
      'POST /v1/token',
    ]);
    expect(fresh.worker.bodies).toEqual([
      { org: 'acme', device_code: 'dev-3584e1' },
    ]);
    expect(fresh.calls.some((c) => c.startsWith('login'))).toBe(false);

    // A sign-in GitHub granted more scopes than asked (every scope the user
    // ever gave the OAuth App) stops before anything billed.
    const union = setUp({ env: OVERRIDE });
    union.deps.signInScopes = async () => [
      'read:enterprise',
      'read:org',
      'read:packages',
    ];
    await expect(install(options, union.deps)).rejects.toThrow(
      'has the scopes read:enterprise, read:org, read:packages',
    );
    expect(union.calls.some((c) => c.startsWith('cluster'))).toBe(false);
    const unionDir = union.deps.env.BACKMESH_ANYCLOUD_DIR!;
    expect(existsSync(join(unionDir, '.token'))).toBe(false);

    // A usable GITHUB_TOKEN, as in CI, is kept: nothing is saved over it.
    const ci = setUp({ env: { ...OVERRIDE, GITHUB_TOKEN: 'gho_x' } });
    await install(options, ci.deps);
    const ciDir = ci.deps.env.BACKMESH_ANYCLOUD_DIR!;
    expect(existsSync(join(ciDir, '.token'))).toBe(false);

    // The hosted API refuses a PAT, an Actions token, or an OAuth sign-in
    // with other scopes, so install does before anything is billed.
    for (const [token, message] of [
      ['github_pat_x', "The GitHub sign-in isn't an OAuth token"],
      ['ghs_x', "The GitHub sign-in isn't an OAuth token"],
      ['gho_wide', 'has the scopes read:org, read:packages, repo'],
      ['gho_narrow', 'has the scopes read:org, but'],
      ['gho_revoked', 'GitHub rejected the sign-in: in CI, set GITHUB_TOKEN'],
      [DOWN, "Couldn't check the GitHub sign-in with GitHub. Retry"],
    ]) {
      const refused = setUp({ env: { ...OVERRIDE, GITHUB_TOKEN: token } });
      await expect(install(options, refused.deps)).rejects.toThrow(message);
      expect(refused.calls.some((c) => c.startsWith('cluster'))).toBe(false);
    }

    // anycloud reads the saved sign-in over GITHUB_TOKEN, and so does the check.
    const saved = setUp({ env: { ...OVERRIDE, GITHUB_TOKEN: 'ghs_x' } });
    const savedDir = saved.deps.env.BACKMESH_ANYCLOUD_DIR!;
    writeFileSync(join(savedDir, '.token'), 'gho_saved');
    await install(options, saved.deps);
    // One GitHub can't check stays.
    writeFileSync(join(savedDir, '.token'), DOWN);
    await expect(install(options, saved.deps)).rejects.toThrow('Retry');
    expect(readFileSync(join(savedDir, '.token'), 'utf8')).toBe(DOWN);

    // A saved one the control plane would refuse is replaced by a new
    // backmesh sign-in, never by anycloud's.
    for (const token of ['github_pat_saved', 'gho_wide', 'gho_revoked']) {
      const stale = setUp({ env: OVERRIDE });
      const staleDir = stale.deps.env.BACKMESH_ANYCLOUD_DIR!;
      writeFileSync(join(staleDir, '.token'), token, { mode: 0o644 });
      await install(options, stale.deps);
      // Only GitHub's refusal is called revoked.
      expect(
        stale.lines.includes(
          `GitHub revoked the saved sign-in. Install signs in again.`,
        ),
      ).toBe(token === 'gho_revoked');
      expect(readFileSync(join(staleDir, '.token'), 'utf8').trim()).toBe(
        SIGNED_IN,
      );
      // Rewritten, not overwritten in place: the old file's mode is gone.
      expect(statSync(join(staleDir, '.token')).mode & 0o777).toBe(0o600);
    }
    // With a usable GITHUB_TOKEN, a revoked saved one goes for it.
    const ciRevoked = setUp({ env: { ...OVERRIDE, GITHUB_TOKEN: 'gho_x' } });
    const ciSaved = ciRevoked.deps.env.BACKMESH_ANYCLOUD_DIR!;
    writeFileSync(join(ciSaved, '.token'), 'gho_revoked');
    await install(options, ciRevoked.deps);
    expect(ciRevoked.lines).toContain(
      `GitHub revoked the saved sign-in. Install uses GITHUB_TOKEN.`,
    );
    expect(existsSync(join(ciSaved, '.token'))).toBe(false);
  });

  it('generates from a named operator, which anycloud needs without a TTY', async () => {
    const aws = setUp({ env: { ...OVERRIDE, AWS_PROFILE: 'ci' } });
    await install(options, aws.deps);
    expect(aws.calls).toContain(
      `credentials new ${BM.aws} --provider aws --profile ci --account-id 123456789012 --generate`,
    );

    const gcp = setUp(
      { env: OVERRIDE },
      { 'vm-types gcp us-central1': JSON.stringify(CATALOG.gcp) },
    );
    const command = gcp.deps.command;
    gcp.deps.command = async (args) =>
      ({
        'gcloud config get-value account': 'ci@p1.iam.gserviceaccount.com\n',
        'gcloud config get-value project': 'p1\n',
      })[args.join(' ')] ?? command(args);
    await install({ ...options, controlPlane: 'gcp:us-central1' }, gcp.deps);
    expect(gcp.calls).toContain(
      `credentials new ${BM.gcp} --provider gcp --gcloud-account ci@p1.iam.gserviceaccount.com --project-id p1 --generate`,
    );
    // Only AWS's disks have provisioned speed to lower.
    expect(gcp.commands.filter((c) => c.startsWith('aws ec2'))).toEqual([]);
    const pool = gcp.requests.find((r) =>
      r.startsWith('POST /v1/node-pools '),
    )!;
    expect(JSON.parse(pool.slice(pool.indexOf('{')))).not.toHaveProperty(
      'osDiskTier',
    );
  });

  // anycloud 0.1.73's refusals: its own for AWS and Azure, and the IAM
  // API's 409 for GCP, after `credentials new`'s prefix.
  const EXISTS = {
    aws: `AWS user anycloud-${BM.aws} already exists; select a new credential name.`,
    gcp: `GCP request failed (HTTP 409, ALREADY_EXISTS). Check the selected operator, project, enabled APIs, and permissions. Inspect GCP project p1, service account anycloud-${BM.gcp}@p1.iam.gserviceaccount.com, invocation 1 (unique ID unknown) for manual reconciliation; resources were retained and no uncertain mutation was retried.`,
    azure: `Azure identity "anycloud-${BM.azure}" already exists. Please use a different name or delete every matching application and service principal.`,
  };
  it.each(['aws', 'gcp', 'azure'] as const)(
    "stops over an earlier installation's %s identity, with what deletes it",
    async (cloud) => {
      const { deps } = setUp(
        { env: OVERRIDE },
        {
          'vm-types gcp us-central1': JSON.stringify(CATALOG.gcp),
          'vm-types azure westus2': JSON.stringify(CATALOG.azure),
        },
      );
      const run = deps.runLong;
      deps.runLong = async (args) => {
        if (args[0] === 'credentials' && args[1] === 'new') {
          throw new Error(
            `credentials new failed: ✗ Failed to add credentials: ${EXISTS[cloud]}`,
          );
        }
        return run(args);
      };
      const region = {
        aws: 'us-east-2',
        gcp: 'us-central1',
        azure: 'westus2',
      };
      const error = await install(
        { ...options, controlPlane: `${cloud}:${region[cloud]}` },
        deps,
      ).catch((e: Error) => e);
      expect(String(error)).toContain(
        `${cloud}'s identity anycloud-${BM[cloud]} is left from an earlier install on this control plane`,
      );
      // Uninstall's command.
      const commands = (error as Error).message.split('\n').slice(1);
      expect(commands).toEqual(
        leftoverIdentity(cloud, BM[cloud]).split('\n').slice(1),
      );
      expect(commands).toHaveLength(1);
    },
  );

  it("relays any other failure to generate, and another cloud's refusal", async () => {
    const { deps } = setUp({ env: OVERRIDE });
    const run = deps.runLong;
    deps.runLong = async (args) => {
      if (args[1] !== 'new') return run(args);
      throw new Error(`credentials new failed: ${EXISTS.azure}`);
    };
    await expect(install(options, deps)).rejects.toThrow(
      `credentials new failed: ${EXISTS.azure}`,
    );
  });

  it('signs in with a device code, then waits for an org owner to install the App before anything changes', async () => {
    const notInstalled = Response.json(
      {
        error: 'app_not_installed',
        install_url:
          'https://github.com/apps/backmesh/installations/new/permissions?target_id=7',
      },
      { status: 409 },
    );
    const worker = fakeWorker({
      tokens: [
        notInstalled,
        Response.json({ error: 'rate limited' }, { status: 429 }),
        notInstalled,
        new TypeError('fetch failed'),
        tokenFor('acme'),
      ],
    });
    const { deps, calls, lines } = setUp({ env: OVERRIDE, worker });
    const waits: number[] = [];
    deps.wait = async (ms) => void waits.push(ms);
    await install(options, deps);
    expect(worker.calls.filter((c) => c === 'POST /v1/token')).toHaveLength(5);
    expect(waits.filter((ms) => ms === 15_000)).toHaveLength(4);
    // GitHub's device code, then GitHub's own App install link, once: no
    // backmesh page between them.
    expect(
      lines.filter(
        (line) => line.includes('https://') && !line.startsWith('Done.'),
      ),
    ).toEqual([
      'Sign in with GitHub once, as an admin of acme, so backmesh can connect to it: open https://github.com/login/device and enter ABCD-1234.',
      'An owner of acme installs the backmesh GitHub App: open https://github.com/apps/backmesh/installations/new/permissions?target_id=7 and click Install. Waiting for it.',
    ]);
    expect(lines).toContain(
      "Couldn't reach backmesh.com (api.backmesh.com didn't answer); waiting for it.",
    );
    expect(calls.some((c) => c.startsWith('cluster create'))).toBe(true);
  });

  it.each([
    [
      Response.json({ error: 'unknown key' }, { status: 401 }),
      /refused the install key \(unknown key\)\. Run `backmesh upgrade`/,
    ],
    [tokenFor('evil'), /minted a token for evil, not acme/],
  ])(
    'stops before anything changes when the broker refuses',
    async (answer, message) => {
      const worker = fakeWorker({ tokens: [answer] });
      const { deps, calls } = setUp({ env: OVERRIDE, worker });
      await expect(install(options, deps)).rejects.toThrow(message);
      expect(calls.some((c) => c.startsWith('cluster create'))).toBe(false);
    },
  );

  describe('--plan and --plan-id', () => {
    const planned = async (deps: InstallDeps, opts: InstallOptions = options) =>
      (await install({ ...opts, plan: true }, deps)) as InstallPlan & {
        planId: string;
      };

    it('prints the plan with no sign-in, and creates nothing', async () => {
      // No terminal, no override and no --yes: a plan needs none of them.
      const { deps, calls, requests, worker, lines } = setUp({ tty: false });
      const plan = await planned(deps, { ...options, yes: false });

      expect(plan.planId).toMatch(/^p-[0-9a-f]{12}$/);
      expect(plan).toMatchObject({
        org: 'acme',
        orgId: 7,
        clouds: [
          { cloud: 'aws', region: 'us-east-2', account: '123456789012' },
        ],
        controlPlane: {
          cloud: 'aws',
          managementVm: 't3.large',
          controlVm: 't3.small',
          monthlyUsd: 86,
          exists: false,
          sharedWith: [],
        },
        sameOwner: null,
      });
      expect(plan.classes.map((c) => c.label)).toContain('backmesh-4');
      expect(lines).toEqual(
        expect.arrayContaining([
          ...plan.rates,
          ...plan.quotas,
          expect.stringMatching(
            /^Always on: 2 VMs that run backmesh \(t3\.large and/,
          ),
        ]),
      );
      expect(worker.calls.filter((c) => c.startsWith('POST'))).toEqual([]);
      expect(requests).toEqual([]);
      expect(calls.filter((c) => !/^(api status|vm-types)/.test(c))).toEqual(
        [],
      );
    });

    it('runs the plan --plan-id names, and refuses a changed one before signing in', async () => {
      const first = setUp();
      const { planId } = await planned(first.deps);
      // The same inputs give the same ID on another run.
      expect((await planned(setUp().deps)).planId).toBe(planId);

      const agreed = setUp();
      await expect(
        install({ ...options, planId }, agreed.deps),
      ).resolves.toMatchObject({ org: 'acme' });

      // Signed in to another AWS account since: another plan.
      const moved = setUp();
      const command = moved.deps.command;
      moved.deps.command = async (args) =>
        args[0] === 'aws' && args[1] === 'sts'
          ? JSON.stringify({ Account: '210987654321' })
          : command(args);
      const error = await install({ ...options, planId }, moved.deps).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(PlanChanged);
      expect((error as Error).message).toMatch(
        new RegExp(
          `^The plan changed since ${planId}; it's p-[0-9a-f]{12} now\\.`,
        ),
      );
      expect(moved.worker.calls.filter((c) => c.startsWith('POST'))).toEqual(
        [],
      );
      expect(moved.calls.some((c) => c.startsWith('cluster create'))).toBe(
        false,
      );
    });

    it.each([
      ['aws', 'aws:us-east-2', '210987654321'],
      ['gcp', 'gcp:us-central1', 'proj-2'],
      ['azure', 'azure:westus2', 'sub-2'],
    ] as const)(
      "names %s's billed account, and another one changes the plan",
      async (cloud, target, other) => {
        const catalogs = {
          'vm-types gcp us-central1': JSON.stringify(CATALOG.gcp),
          'vm-types azure westus2': JSON.stringify(CATALOG.azure),
        };
        const opts = { ...options, controlPlane: target };
        const plan = await planned(setUp({}, catalogs).deps, opts);
        const signedIn = { aws: '123456789012', gcp: 'proj-1', azure: 'sub-1' };
        expect(plan.clouds).toEqual([
          { cloud, region: target.split(':')[1], account: signedIn[cloud] },
        ]);
        const moved = setUp(
          { account: { ...signedIn, [cloud]: other } },
          catalogs,
        );
        expect((await planned(moved.deps, opts)).planId).not.toBe(plan.planId);
      },
    );

    it('gives the same ID to the flags the plan spells out', async () => {
      const binary = { 'vm-types aws us-east-1': JSON.stringify(CATALOG.aws) };
      const defaulted = await planned(setUp({}, binary).deps, {
        org: 'acme',
        yes: false,
      });
      const { controlPlane, runners } = defaulted;
      const spelled = await planned(setUp({}, binary).deps, {
        org: 'acme',
        yes: false,
        controlPlane: `${controlPlane.cloud}:${controlPlane.region}`,
        runners: runners.map((r) => r.cloud),
      });
      expect(spelled.planId).toBe(defaulted.planId);
    });

    it('keeps the ID when only the quota numbers move', async () => {
      const { planId } = await planned(setUp().deps);
      const used = setUp({
        quota: { 'L-34B43A08': '600.0', 'L-1216C47A': '100.0' },
      });
      expect((await planned(used.deps)).planId).toBe(planId);
    });

    it("hashes the runners' regions, which multiRegion widens from the anchor to every candidate", async () => {
      const narrow = await planned(setUp().deps);
      expect(narrow.runners).toEqual([
        { cloud: 'aws', regions: ['us-east-2'] },
      ]);
      const features = { ...RELEASED, 'vm-job-regions': '0.1.0' };
      const binary = Object.fromEntries(
        RUNNER_REGIONS.aws.map((region) => [
          `vm-types aws ${region}`,
          JSON.stringify(CATALOG.aws),
        ]),
      );
      const wide = await planned(setUp({ features }, binary).deps);
      // Home (the control plane's own region) first, then the rest of
      // RUNNER_REGIONS.aws in order.
      expect(wide.classes[0]?.regions).toEqual([
        'us-east-2',
        'us-east-1',
        'us-west-2',
      ]);
      expect(wide.planId).not.toBe(narrow.planId);
    });

    it("never runs runners in the control plane's own region when that region isn't a RUNNER_REGIONS candidate", async () => {
      // us-west-1 lacks m7a (regions.spec.ts), so it's excluded from
      // RUNNER_REGIONS.aws; putting the control plane there must not leak
      // it into the runner catalog or classes.
      expect(RUNNER_REGIONS.aws).not.toContain('us-west-1');
      const features = { ...RELEASED, 'vm-job-regions': '0.1.0' };
      const binary = Object.fromEntries(
        RUNNER_REGIONS.aws.map((region) => [
          `vm-types aws ${region}`,
          JSON.stringify(CATALOG.aws),
        ]),
      );
      const plan = await planned(setUp({ features }, binary).deps, {
        ...options,
        controlPlane: 'aws:us-west-1',
      });
      expect(plan.classes[0]?.regions).toEqual(RUNNER_REGIONS.aws);
      expect(plan.classes[0]?.regions).not.toContain('us-west-1');
    });

    it('stops before billing when an account changes while the human signs in', async () => {
      const { planId } = await planned(setUp().deps);
      const account = { aws: '123456789012', gcp: 'proj-1', azure: 'sub-1' };
      const { deps, calls, worker } = setUp({ account });
      // The sign-in is the wait: another shell switches accounts.
      const fetch = deps.fetch!;
      deps.fetch = (async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/v1/installs')) {
          account.aws = '210987654321';
        }
        return fetch(url, init);
      }) as typeof globalThis.fetch;
      await expect(install({ ...options, planId }, deps)).rejects.toThrow(
        PlanChanged,
      );
      expect(worker.calls).toContain('POST /v1/installs');
      expect(calls.some((c) => c.startsWith('cluster create'))).toBe(false);
    });

    it('stops a plan it cannot read the hosted control plane for', async () => {
      const { deps } = setUp({ hosted: true }, { 'api token': '' });
      deps.api = () => {
        throw new Error('401');
      };
      await expect(planned(deps)).rejects.toThrow(
        "Couldn't read the control plane this machine uses",
      );
    });

    it('takes --yes only with --plan-id, but for our CI override', async () => {
      const { deps, calls } = setUp();
      await expect(install(options, deps)).rejects.toThrow(
        'Pass --plan-id with --yes',
      );
      expect(calls).toEqual([]);
      await expect(
        install(options, setUp({ env: OVERRIDE }).deps),
      ).resolves.toMatchObject({ org: 'acme' });
    });
  });

  it('parses --control-plane as <cloud>:<region>', () => {
    expect(parseControlPlane('gcp:us-central1')).toEqual({
      cloud: 'gcp',
      region: 'us-central1',
      credentials: '',
    });
    for (const bad of ['aws', 'aws:', 'aws:us-east-1,us-east-2', 'a:b:c']) {
      expect(() => parseControlPlane(bad)).toThrow(UsageError);
    }
    expect(() => parseControlPlane('oracle:x')).toThrow(
      'expected one of aws, gcp, azure',
    );
  });

  it('parses --runners, anchoring a bare cloud on the control plane or US East', () => {
    const controlPlane = { cloud: 'aws', region: 'us-east-2' } as const;
    // None: the control plane's cloud, with its default regions.
    expect(parseRunners([], controlPlane)).toEqual([
      { cloud: 'aws', region: 'us-east-2', credentials: '' },
    ]);
    expect(parseRunners(['aws', 'gcp', 'azure'], controlPlane)).toEqual([
      { cloud: 'aws', region: 'us-east-2', credentials: '' },
      { cloud: 'gcp', region: 'us-east4', credentials: '' },
      { cloud: 'azure', region: 'eastus', credentials: '' },
    ]);
    expect(() => parseRunners(['oracle'], controlPlane)).toThrow(
      'expected one of aws, gcp, azure',
    );
    expect(() => parseRunners(['azure:westus2'], controlPlane)).toThrow(
      'takes a cloud only, not a region',
    );
    expect(() => parseRunners(['aws', 'aws'], controlPlane)).toThrow(
      'is given twice',
    );
  });

  it('plans the defaults without --control-plane, and needs it without a terminal', async () => {
    const plan = setUp(
      {},
      { 'vm-types aws us-east-1': JSON.stringify(CATALOG.aws) },
    );
    const result = await install(
      { org: 'acme', yes: false, plan: true },
      plan.deps,
    );
    expect(plan.lines).toContain(
      "The control plane goes on aws us-east-1, near GitHub's US East, the first signed-in of aws, gcp, azure; pass --control-plane <cloud>:<region> to choose another.",
    );
    expect(result).toMatchObject({
      controlPlane: { cloud: 'aws', region: 'us-east-1' },
      runners: [{ cloud: 'aws', regions: ['us-east-1'] }],
      clouds: [{ cloud: 'aws', region: 'us-east-1' }],
    });

    // One signed-in CLI is the control plane's cloud, unremarked.
    const gcp = setUp(
      {},
      { 'vm-types gcp us-east4': JSON.stringify(CATALOG.gcp) },
    );
    const command = gcp.deps.command;
    gcp.deps.command = async (args) =>
      args[0] === 'gcloud' ? command(args) : Promise.reject(new Error('no'));
    await expect(
      install({ org: 'acme', yes: false, plan: true }, gcp.deps),
    ).resolves.toMatchObject({
      controlPlane: { cloud: 'gcp', region: 'us-east4' },
    });
    expect(gcp.lines).toContain(
      "The control plane goes on gcp us-east4, near GitHub's US East; pass --control-plane <cloud>:<region> to choose another.",
    );

    // Our CI's override has no terminal either.
    const { deps, calls } = setUp({ tty: false, env: OVERRIDE });
    const error = await install({ org: 'acme', yes: true }, deps).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toMatch(
      /^Pass --control-plane <cloud>:<region>/,
    );
    // Only the read of which control plane this machine targets.
    expect(calls).toEqual(['api status --json']);
  });

  it('asks for each missing choice at a terminal, its default filled in', async () => {
    const binary = {
      'vm-types gcp us-east1': JSON.stringify(CATALOG.gcp),
      'vm-types aws us-east-1': JSON.stringify(CATALOG.aws),
    };
    const { deps, lines, calls, requests } = setUp(
      {
        env: OVERRIDE,
        answers: ['gcp', 'us-east1', 'gcp,aws'],
      },
      binary,
    );
    const { org } = await install({ org: 'acme', yes: false }, deps);
    expect(org).toBe('acme');
    // The answers are the placement: gcp us-east1, and runners on GCP and
    // AWS, each in its one fixed anchor region (regions are never asked
    // for, owner, 2026-11-13).
    expect(calls).toContain(
      'cluster create backmesh --cloud gcp --region us-east1 --vm-type e2-standard-2 --json',
    );
    const routes = parseRoutes(
      JSON.parse(
        requests
          .find((r) => r.startsWith('PUT /v1/secrets/backmesh-acme '))!
          .split(' ')[2]!,
      ).values.BACKMESH_RUNNERS,
    );
    expect(routes.find((r) => r.label === 'backmesh-4')?.regions).toEqual([
      'us-east1',
    ]);
    expect(routes.find((r) => r.label === 'backmesh-aws-4')?.regions).toEqual([
      'us-east-1',
    ]);
    expect(lines.filter((l) => l.endsWith(']'))).toEqual([
      'Control plane cloud (aws, gcp, azure)? [aws]',
      'Control plane region on gcp? [us-east4]',
      'Runner clouds? [gcp]',
    ]);

    // Defaults taken with Enter; a given flag isn't asked.
    const enter = setUp(
      { env: OVERRIDE },
      { 'vm-types aws us-east-1': JSON.stringify(CATALOG.aws) },
    );
    await install({ org: 'acme', yes: false, runners: ['aws'] }, enter.deps);
    expect(enter.lines.filter((l) => l.endsWith(']'))).toEqual([
      'Control plane cloud (aws, gcp, azure)? [aws]',
      'Control plane region on aws? [us-east-1]',
    ]);

    // A machine that targets a control plane is asked only about runners,
    // as for a second org.
    const second = setUp({
      env: OVERRIDE,
      pools: [
        {
          id: 'p1',
          name: 'bm-control',
          state: 'running',
          allowPrivilegedJobs: false,
          cloudProvider: 'AWS',
          region: 'us-east-2',
        },
      ],
      hosted: true,
      answers: [''],
    });
    await install({ org: 'acme', yes: false }, second.deps);
    expect(second.lines.filter((l) => l.endsWith(']'))).toEqual([
      'Runner clouds? [aws]',
    ]);

    // A bad answer stops at once, as its flag would.
    const bad = setUp({ env: OVERRIDE, answers: ['oracle'] });
    await expect(
      install({ org: 'acme', yes: false }, bad.deps),
    ).rejects.toThrow('expected one of aws, gcp, azure');
    expect(bad.lines.filter((l) => l.endsWith(']'))).toHaveLength(1);

    // --yes and --plan never ask.
    for (const flags of [{ yes: true }, { yes: false, plan: true }]) {
      const quiet = setUp(
        { env: OVERRIDE },
        { 'vm-types aws us-east-1': JSON.stringify(CATALOG.aws) },
      );
      await install({ org: 'acme', ...flags }, quiet.deps);
      expect(quiet.lines.some((l) => l.endsWith(']'))).toBe(false);
    }
  });

  it('connects the control plane cloud though its runners are elsewhere, and prefixes theirs', async () => {
    const { deps, calls, requests } = setUp(
      { env: OVERRIDE },
      { 'vm-types gcp us-east4': JSON.stringify(CATALOG.gcp) },
    );
    await install({ ...options, runners: ['gcp'] }, deps);
    expect(
      calls
        .filter((c) => c.startsWith('credentials new'))
        .map((c) => c.split(' ')[2]),
    ).toEqual([BM.aws, BM.gcp]);
    const secret = requests.find((r) =>
      r.startsWith('PUT /v1/secrets/backmesh-acme '),
    )!;
    const routes = parseRoutes(
      JSON.parse(secret.split(' ')[2]!).values.BACKMESH_RUNNERS,
    );
    expect(routes.every((r) => r.cloud === 'gcp')).toBe(true);
    expect(routes.map((r) => r.label)).toContain('backmesh-gcp-4');
  });

  it("says when this control plane can't take a region list yet", async () => {
    const { deps, lines } = setUp();
    await install({ ...options, plan: true }, deps);
    expect(lines).toContain(
      "aws's runners stay in us-east-2: this control plane can't take a region list yet.",
    );
    const features = { ...RELEASED, 'vm-job-regions': '0.1.0' };
    const binary = Object.fromEntries(
      RUNNER_REGIONS.aws.map((region) => [
        `vm-types aws ${region}`,
        JSON.stringify(CATALOG.aws),
      ]),
    );
    const wide = setUp({ features }, binary);
    await install({ ...options, plan: true }, wide.deps);
    expect(wide.lines.some((l) => l.includes('stay in'))).toBe(false);
  });

  it("refuses --public-repos without runners on the control plane's cloud", async () => {
    const { deps, calls } = setUp(
      { env: OVERRIDE },
      { 'vm-types gcp us-east4': JSON.stringify(CATALOG.gcp) },
    );
    await expect(
      install({ ...options, runners: ['gcp'], publicRepos: true }, deps),
    ).rejects.toThrow(
      "--public-repos needs runners on the control plane's cloud, aws",
    );
    expect(calls.some((c) => c.startsWith('cluster create'))).toBe(false);
  });

  it('refuses a --runners value with a region: regions are fixed, not chosen', async () => {
    const { deps, calls } = setUp({ env: OVERRIDE });
    await expect(
      install({ ...options, runners: ['aws:us-east-2'] }, deps),
    ).rejects.toThrow('takes a cloud only, not a region');
    // Only the read of which control plane this machine targets.
    expect(calls).toEqual(['api status --json']);
  });

  describe('with VM Job region lists', () => {
    const features = { ...RELEASED, 'vm-job-regions': '0.1.0' };
    const binary = Object.fromEntries(
      RUNNER_REGIONS.aws.map((region) => [
        `vm-types aws ${region}`,
        JSON.stringify(CATALOG.aws),
      ]),
    );
    const quota = {
      'L-34B43A08': '704',
      'L-1216C47A': '160',
    };
    const routesOf = (requests: string[]) =>
      parseRoutes(
        JSON.parse(
          requests
            .find((r) => r.startsWith('PUT /v1/secrets/backmesh-acme '))!
            .split(' ')[2]!,
        ).values.BACKMESH_RUNNERS,
      );

    it('plans the runners in every fixed candidate region, with their quotas summed', async () => {
      const { deps, requests, lines } = setUp(
        { env: OVERRIDE, features, quota },
        binary,
      );
      await install(options, deps);
      expect(lines).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /^aws us-east-2, us-east-1 and us-west-2: .* about \$/,
          ),
          'aws us-east-2, us-east-1 and us-west-2 quota: 2112 spot vCPUs (528 backmesh-4 jobs at once), 480 on-demand vCPUs (120 backmesh-4 jobs at once)',
        ]),
      );
      const four = routesOf(requests).find((r) => r.label === 'backmesh-4')!;
      expect(four).toMatchObject({
        region: 'us-east-2',
        regions: ['us-east-2', 'us-east-1', 'us-west-2'],
      });
    });

    it('keeps the single anchor region while this control plane takes no list', async () => {
      const { deps, requests } = setUp({ env: OVERRIDE, quota: {} }, binary);
      await install(options, deps);
      const four = routesOf(requests).find((r) => r.label === 'backmesh-4')!;
      expect(four.regions).toEqual(['us-east-2']);
    });

    it('refuses a resumed control plane older than the pin', async () => {
      const { deps, calls } = setUp(
        { env: OVERRIDE, features, quota, hostedVersion: '0.1.72' },
        binary,
      );
      await expect(install(options, deps)).rejects.toThrow(
        'This control plane is behind this backmesh; run `backmesh upgrade`, then install again.',
      );
      expect(calls.some((c) => c.startsWith('deployment create'))).toBe(false);
    });
  });
});
