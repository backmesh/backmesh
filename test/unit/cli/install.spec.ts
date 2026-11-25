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
import { signInCheck } from '../../../src/app/github.js';
import {
  install,
  noArmLine,
  parseControlPlane,
  parseRunners,
  ON_DEMAND_FALLBACK_LINE,
  PUBLIC_REPOS_LINE,
  type InstallDeps,
  type InstallOptions,
} from '../../../src/cli/install.js';
import type { InstallPlan } from '../../../src/cli/plan.js';
import { PlanChanged, UsageError } from '../../../src/cli/errors.js';
import { ANYCLOUD_VERSION } from '../../../src/anycloud/contract.generated.js';
import { connectionName, installTag } from '../../../src/cli/installation.js';
import { runnerGroupName } from '../../../src/github/runner-group.js';
import { parseRoutes } from '../../../src/listener/routes.js';
import { leftoverIdentity } from '../../../src/cli/uninstall.js';
import { fakeGitHub, json } from '../github/fake-github.js';
import { CATALOG, catalogs } from '../runners/fixtures.js';
import { planClasses } from '../../../src/runners/classes.js';
import { RUNNER_REGIONS } from '../../../src/runners/regions.js';
import {
  fakeApi,
  fakeBinary,
  fakeExec,
  fakeWorker,
  INSTALL_KEY,
  listenerVm,
  PUBLIC_REPOS,
  SIGNED_IN,
} from './fakes.js';

const RELEASED: FeatureTable = {
  'release-1': '0.1.0',
  c26: '0.1.0',
  'role-connections': '0.1.0',
  'role-apply': '0.1.0',
  c28: '0.1.0',
  'vm-job-regions': undefined,
  'service-tokens': '0.1.0',
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
// The sign-ins GitHub knows; GET /user answers 401 for any other.
const SIGN_INS = new Set([
  'ghu_x',
  'ghu_saved',
  'gho_oauth',
  'ghu_other_app',
  SIGNED_IN,
]);
// The App installations each sign-in reaches, by App ID: another App's
// sign-in reaches its own App's.
const REACHES: Record<string, number[]> = { ghu_other_app: [999] };
// A sign-in GitHub can't check: it answers 503.
const DOWN = 'ghu_down';
const github = fakeGitHub({
  'GET https://api.github.com/user': ({ headers }) => {
    const token = headers.get('authorization')!.split(' ')[1]!;
    if (token === DOWN) return json(503, { message: 'Unavailable' })();
    return SIGN_INS.has(token)
      ? json(200, { login: 'octo', id: 1 })()
      : json(401, { message: 'Bad credentials' })();
  },
  'GET https://api.github.com/user/installations': ({ headers }) => {
    const token = headers.get('authorization')!.split(' ')[1]!;
    if (token === DOWN) return json(503, { message: 'Unavailable' })();
    const apps = REACHES[token] ?? [5622376];
    return json(200, {
      total_count: apps.length,
      installations: apps.map((app_id, id) => ({ id, app_id })),
    })();
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
    workloads = [] as object[],
    // Listener VMs already on the control plane.
    vms = [] as object[],
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
    restricted = {},
    families = {},
    groups = [],
    stacks = [],
    serviceAccounts = [],
  }: {
    // The Azure sizes this subscription may not create, by region (`skus`).
    restricted?: Record<string, string[]>;
    // Azure's family quotas, and `cores` when given, by region: `az vm
    // list-usage`'s limit and what's in use.
    families?: Record<string, Record<string, [number, number]>>;
    // The resource groups of Azure control planes named `backmesh`.
    groups?: { id: string; location: string }[];
    // The tags of the account's `anycloud-` CloudFormation stacks in the
    // region asked.
    stacks?: { Key: string; Value: string }[][];
    // The project's `anycloud-` service accounts' descriptions.
    serviceAccounts?: { email?: string; description?: string }[];
    // bm-aws's cache buckets, when a previous install made them: the
    // connection an installation before 0.4.1 named, which `RUNNERS` records.
    cacheBuckets?: string[];
    env?: NodeJS.ProcessEnv;
    workloads?: object[];
    vms?: object[];
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
  const listed = [...vms];

  const { run: answer, calls } = fakeBinary({
    'credentials list --json': '[]',
    'vm-types aws us-east-2': JSON.stringify(CATALOG.aws),
    'api create backmesh': JSON.stringify({ name: 'backmesh', ...RUNNING }),
    'api token': 't0ken',
    // A control plane with listener VMs has its own cluster record, which
    // says where it runs.
    ...(vms.length && {
      'cluster list --json': JSON.stringify([
        {
          id: 'c1',
          name: 'backmesh',
          cloudProvider: 'AWS',
          region: 'us-east-2',
        },
      ]),
    }),
    'api access add --service backmesh-acme --json': JSON.stringify({
      token: 'acapi_svc',
    }),
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
    // A new listener VM, listed from then on.
    if (args[0] === 'vm') {
      const org = args[args.indexOf('--secret') + 1]!.slice(9);
      listed.push(listenerVm(org, args[args.indexOf('--id') + 1]!));
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
    'GET /v1/workloads': () => [...workloads, ...listed],
  });
  // `anycloud exec`: the listener's probe answers as `exec backmesh-acme`
  // in `binary` says (`probe`), else as a new listener; the start and roll
  // print nothing, and are recorded in `calls` as `start <vm>` and
  // `roll <vm>`.
  const { exec, calls: execs } = fakeExec((id, command) => {
    if (command.startsWith('docker exec backmesh-listener')) {
      return (
        binary['exec backmesh-acme'] ??
        JSON.stringify({ code: 200, body: {}, env: {} })
      );
    }
    calls.push(`${command.includes('| base64 -d') ? 'roll' : 'start'} ${id}`);
    return '';
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
      if (args.slice(0, 3).join(' ') === 'az group list') {
        return JSON.stringify(groups);
      }
      if (args.slice(0, 3).join(' ') === 'aws cloudformation describe-stacks') {
        return JSON.stringify(stacks);
      }
      if (args.slice(0, 3).join(' ') === 'gcloud iam service-accounts') {
        return JSON.stringify(serviceAccounts);
      }
      if (args[0] === 'az' && args[2] === 'list-skus') {
        return skus(restricted);
      }
      if (args[0] === 'az' && args[2] === 'list-usage') {
        const region = args[args.indexOf('--location') + 1]!;
        // A region's own entries first: they may override the totals.
        return JSON.stringify([
          ...Object.entries(families[region] ?? {}).map(
            ([value, [limit, currentValue]]) => ({
              name: { value },
              limit,
              currentValue,
            }),
          ),
          ...['lowPriorityCores', 'cores'].map((value) => ({
            name: { value },
            limit: 100,
            currentValue: 0,
          })),
        ]);
      }
      // The new management VM at anycloud 0.1.78's 8,000 IOPS.
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
    signInCheck: (token) =>
      signInCheck(token, { request: { fetch: github.fetch } }),
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
    exec: () => exec,
    features,
    fetch: (async (url: string, init?: RequestInit) =>
      String(url) === `${HOSTED}/v1/version`
        ? Response.json({ version: hostedVersion })
        : worker.fetch(url, init)) as typeof globalThis.fetch,
    wait: async () => {},
  };
  return {
    deps,
    calls,
    execs,
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

  it('points the listener at the Worker install signed in through', async () => {
    const values = async (env: NodeJS.ProcessEnv) => {
      const { deps, requests } = setUp({ env });
      await install(asked, deps);
      const secret = requests.find((r) =>
        r.startsWith('PUT /v1/secrets/backmesh-acme '),
      )!;
      return JSON.parse(secret.split(' ')[2]!).values as Record<string, string>;
    };
    // The staging Worker's install key is unknown to production's.
    expect(
      await values({ BACKMESH_API_URL: 'https://api-staging.backmesh.com' }),
    ).toMatchObject({ BACKMESH_API_URL: 'https://api-staging.backmesh.com' });
    expect(await values({})).not.toHaveProperty('BACKMESH_API_URL');
  });

  it("runs install's steps in order, making each cloud's role through its CLI", async () => {
    const {
      deps,
      calls,
      commands,
      execs,
      requests,
      lines,
      tokens,
      refreshable,
    } = setUp();
    // The VM's create, its Secret saved before it, and each exec, in order.
    const steps: string[] = [];
    const saved = () =>
      requests.some((r) => r.startsWith('PUT /v1/secrets/backmesh-acme '));
    const { runLong } = deps;
    deps.runLong = async (args, env) => {
      if (args[0] === 'vm') steps.push(saved() ? 'secret' : 'none', 'vm');
      return runLong(args, env);
    };
    const exec = deps.exec!;
    deps.exec = (...args) => {
      const e = exec(...args);
      return async (id, command) => (
        steps.push(command.split('\n')[0]!.slice(0, 11)),
        e(id, command)
      );
    };
    const result = await install(asked, deps);

    expect(
      calls.filter(
        (c) => !/^(api status|api token|credentials list|vm-types)/.test(c),
      ),
    ).toEqual([
      // Through the user's cloud CLI, with no local API, after the quotas.
      'api create backmesh --cloud aws --region us-east-2 --vm-type t3.large --sign-in-apps 5622376 --json',
      `api use ${HOSTED}`,
      // The role's trust names the hosted API, so it comes after create.
      `credentials new ${BM.aws} --provider aws --role --apply --json`,
      'api access add --service backmesh-acme --json',
      expect.stringMatching(
        /^vm mirror\.gcr\.io\/library\/docker:29-cli@sha256:[0-9a-f]{64} --id bml-[a-z0-9]{5}-[a-z0-9]{6} --credentials bm-aws-lz9d56 --region us-east-2 --vm-type t3\.small --secret backmesh-acme --wait$/,
      ),
      expect.stringMatching(/^start bml-/),
    ]);
    // The token (above), then the Secret, then the VM, its start, and the
    // probe it answers.
    expect(steps).toEqual(['secret', 'vm', 'set -e', 'docker exec']);
    const vm = calls.find((c) => c.startsWith('vm '))!.split(' ')[3]!;
    expect(execs.map(([id, command]) => [id, command.split('\n')[0]])).toEqual([
      [vm, 'set -e'],
      [vm, expect.stringMatching(/^docker exec backmesh-listener node -e /)],
    ]);
    // Everything the listener reads is in its Secret: `upgrade` changes it,
    // and a VM `upgrade` creates again starts from it.
    const release = requests.find((r) =>
      r.startsWith('PUT /v1/secrets/backmesh-acme '),
    );
    const tag = installTag('c1', 7);
    expect(JSON.parse(release!.split(' ')[2]!)).toEqual({
      values: {
        ORG: 'acme',
        ORG_ID: '7',
        BACKMESH_INSTALL: tag,
        BACKMESH_LISTENER_IMAGE: images.listenerImage,
        BACKMESH_RUNNER_GROUP: runnerGroupName(tag, vm),
        ANYCLOUD_API_URL: HOSTED,
        ANYCLOUD_API_TOKEN: 'acapi_svc',
        BACKMESH_RUNNER_IMAGE: images.runnerImage,
        BACKMESH_INSTALL_KEY: INSTALL_KEY,
        BACKMESH_RUNNERS: expect.any(String),
      },
    });
    expect(vm).toMatch(new RegExp(`^bml-${tag}-`));
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
    // No node pool: the listener has its VM, and runners are VM Jobs.
    expect(
      requests.filter(
        (r) => r.startsWith('POST') && !r.includes('/storage-tokens'),
      ),
    ).toEqual([]);
    expect(result).toMatchObject({
      apiUrl: HOSTED,
      labels: expect.arrayContaining([
        'backmesh-ubuntu-2404-4vcpu',
        'backmesh-ubuntu-2404-od-4vcpu',
        'backmesh-ubuntu-2404-kvm-4vcpu',
        'backmesh-ubuntu-2404-kvm-od-4vcpu',
      ]),
    });
    // The only monthly cost is the control plane's; runner VMs bill per use.
    expect(lines).toEqual(
      expect.arrayContaining([
        'aws us-east-2: no VM while idle; while its job runs, a backmesh-ubuntu-2404-4vcpu VM costs about $0.05–0.07 an hour on spot and $0.17–0.24 on demand, plus its disk, and the other sizes scale with their vCPUs',
        'aws us-east-2 quota: 640 spot vCPUs (160 backmesh-ubuntu-2404-4vcpu jobs at once), 128 on-demand vCPUs (32 backmesh-ubuntu-2404-4vcpu jobs at once)',
        "Always on: the control plane's VM (t3.large) on aws us-east-2, about $69 a month with its disk and address.",
        "Always on: acme's listener VM (t3.small) on aws us-east-2, about $17 a month with its disk and address.",
        ON_DEMAND_FALLBACK_LINE,
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
    expect(lines.slice(-2)).toEqual([
      'Labels for runs-on: backmesh-ubuntu-2404-2vcpu, backmesh-ubuntu-2404-4vcpu, backmesh-ubuntu-2404-8vcpu, backmesh-ubuntu-2404-16vcpu, backmesh-ubuntu-2404-od-2vcpu, backmesh-ubuntu-2404-od-4vcpu, backmesh-ubuntu-2404-od-8vcpu, backmesh-ubuntu-2404-od-16vcpu, backmesh-ubuntu-2404-kvm-2vcpu, backmesh-ubuntu-2404-kvm-4vcpu, backmesh-ubuntu-2404-kvm-8vcpu, backmesh-ubuntu-2404-kvm-16vcpu, backmesh-ubuntu-2404-kvm-od-2vcpu, backmesh-ubuntu-2404-kvm-od-4vcpu, backmesh-ubuntu-2404-kvm-od-8vcpu, backmesh-ubuntu-2404-kvm-od-16vcpu, backmesh-ubuntu-2404-gpu-t4, backmesh-ubuntu-2404-gpu-od-t4, backmesh-ubuntu-2404-highmem-2vcpu, backmesh-ubuntu-2404-highmem-4vcpu, backmesh-ubuntu-2404-highmem-8vcpu, backmesh-ubuntu-2404-highmem-16vcpu, backmesh-ubuntu-2404-highmem-od-2vcpu, backmesh-ubuntu-2404-highmem-od-4vcpu, backmesh-ubuntu-2404-highmem-od-8vcpu, backmesh-ubuntu-2404-highmem-od-16vcpu, backmesh-ubuntu-2404-arm-2vcpu, backmesh-ubuntu-2404-arm-4vcpu, backmesh-ubuntu-2404-arm-8vcpu, backmesh-ubuntu-2404-arm-16vcpu, backmesh-ubuntu-2404-arm-od-2vcpu, backmesh-ubuntu-2404-arm-od-4vcpu, backmesh-ubuntu-2404-arm-od-8vcpu, backmesh-ubuntu-2404-arm-od-16vcpu, backmesh-ubuntu-2404-arm-highmem-2vcpu, backmesh-ubuntu-2404-arm-highmem-4vcpu, backmesh-ubuntu-2404-arm-highmem-8vcpu, backmesh-ubuntu-2404-arm-highmem-16vcpu, backmesh-ubuntu-2404-arm-highmem-od-2vcpu, backmesh-ubuntu-2404-arm-highmem-od-4vcpu, backmesh-ubuntu-2404-arm-highmem-od-8vcpu, backmesh-ubuntu-2404-arm-highmem-od-16vcpu (aws\'s carry no "aws-": it runs the control plane).',
      'Done. Use `runs-on: backmesh-ubuntu-2404-4vcpu` (a 4-vCPU spot VM) in a workflow; other sizes: https://backmesh.com/labels/',
    ]);
    expect(lines).toContain(
      'Connecting aws with a role connection in account 123456789012, through your aws CLI.',
    );
    // Only the hosted API is called, with its refreshable token.
    expect(new Map(tokens)).toEqual(new Map([[HOSTED, 't0ken']]));
    expect(refreshable).toEqual(new Set([HOSTED]));
  });

  it('generates keys on our CI override, which has no terminal', async () => {
    const { deps, calls, requests } = setUp({ env: OVERRIDE, tty: false });
    await install(options, deps);
    expect(
      calls.filter((c) => /^(api create|credentials new|vm )/.test(c)),
    ).toEqual([
      'api create backmesh --cloud aws --region us-east-2 --vm-type t3.large --sign-in-apps 5622376 --json',
      `credentials new ${BM.aws} --provider aws --profile default --account-id 123456789012 --generate`,
      expect.stringMatching(/^vm .* --secret backmesh-acme --wait$/),
    ]);
    // The override reaches the listener through its Secret.
    const secret = requests.find((r) =>
      r.startsWith('PUT /v1/secrets/backmesh-acme '),
    )!;
    expect(JSON.parse(secret.split(' ')[2]!).values).toMatchObject(OVERRIDE);
  });

  it('reuses a connected cloud, and names what stopped a role', async () => {
    const reused = setUp(
      {},
      { 'credentials list --json': '[{"name":"bm-aws"}]' },
    );
    await install(asked, reused.deps);
    expect(reused.calls.some((c) => c.includes('--role'))).toBe(false);
    // An installation before 0.4.1 keeps its `bm-<cloud>` connection.
    expect(reused.calls).toContainEqual(
      expect.stringMatching(/^vm .* --credentials bm-aws --region us-east-2 /),
    );

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
    // GCP's propagation retry is GCP's alone.
    const aws = failing(
      '{"error":{"code":"CLOUD_RIGHTS_MISSING","message":"invalid_target"}}\n',
    );
    await expect(install(asked, aws.deps)).rejects.toThrow(
      "aws's role connection wasn't made: credentials new failed: invalid_target",
    );
    expect(aws.calls.filter((c) => c.includes('--apply'))).toHaveLength(1);
  });

  // GCP refuses a token at a workload identity provider it made seconds
  // before (rc.9's e2e), until the provider propagates.
  describe("GCP's propagation of a new provider", () => {
    const invalidTarget =
      '{"error":{"code":"CLOUD_RIGHTS_MISSING","message":"Role connection \\"bm-gcp\\" was not saved: GCP refused the token at projects/420243425029/locations/global/workloadIdentityPools/anycloud/providers/anycloud-api. (Error code invalid_target: The target service indicated by the \\"audience\\" parameters is invalid.)"}}\n';
    const gcp = async (refusals: number) => {
      const { deps, calls, lines } = setUp(
        { tty: false },
        { 'vm-types gcp us-central1': JSON.stringify(CATALOG.gcp) },
      );
      const waits: number[] = [];
      deps.wait = async (ms) => {
        waits.push(ms);
      };
      const runLong = deps.runLong;
      let left = refusals;
      deps.runLong = async (args, env) => {
        if (args.includes('--apply') && left-- > 0) {
          calls.push(args.join(' '));
          throw new StepFailed(args, invalidTarget, '', {
            cause: new Error('exit'),
          });
        }
        return runLong(args, env);
      };
      const opts = { ...options, controlPlane: 'gcp:us-central1' };
      const { planId } = (await install({ ...opts, plan: true }, deps)) as {
        planId: string;
      };
      const applies = () =>
        calls.filter((c) => c.startsWith('credentials new')).length;
      return {
        result: install({ ...opts, planId }, deps),
        applies,
        waits,
        lines,
      };
    };

    it('makes the role again until GCP takes the token', async () => {
      const { result, applies, waits, lines } = await gcp(3);
      await result;
      expect(applies()).toBe(4);
      expect(waits.filter((ms) => ms >= 10_000)).toHaveLength(3);
      expect(lines).toContain(
        "GCP doesn't take the new role's token yet, as a new workload identity provider takes a minute or two to propagate; trying again in 10s.",
      );
    });

    it('gives up after about two minutes, with the reason', async () => {
      const { result, applies, waits } = await gcp(Infinity);
      await expect(result).rejects.toThrow(
        /^gcp's role connection wasn't made: GCP still refused the new role's token after 2 minutes: credentials new failed: .*invalid_target.*\. Run install again; the control plane stays and is reused\.$/,
      );
      const waited = waits
        .filter((ms) => ms >= 10_000)
        .reduce((a, b) => a + b, 0);
      expect(waited).toBe(120_000);
      expect(applies()).toBe(5);
    });
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
    expect(calls.some((c) => c.startsWith('api create'))).toBe(true);
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

  it("stops at a failed api create with anycloud's reason, before anything else", async () => {
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
      /^api create failed: arn:aws:iam::123456789012:user\/ops lacks ec2:RunInstances \(CLOUD_RIGHTS_MISSING\)$/,
    );
    expect(calls.at(-1)).toMatch(/^api create backmesh /);
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
    expect(routes).toHaveLength(42);
    expect(
      routes.find((r) => r.label === 'backmesh-ubuntu-2404-kvm-od-4vcpu'),
    ).toEqual({
      label: 'backmesh-ubuntu-2404-kvm-od-4vcpu',
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

  it("refuses a region's quota under one backmesh-ubuntu-2404-4vcpu VM, before anything is billed", async () => {
    const { deps, calls } = setUp({
      env: OVERRIDE,
      quota: { 'L-34B43A08': '2.0', 'L-1216C47A': '128.0' },
    });
    await expect(install(options, deps)).rejects.toThrow(
      /Can't run the runners:\n- aws allows 2 spot vCPUs, under one 4-vCPU VM/,
    );
    expect(calls.some((c) => c.startsWith('api create'))).toBe(false);
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
    expect(calls.some((c) => c.startsWith('api create'))).toBe(false);
  });

  it('names a label that would start no runners, and asks before going on, no unless yes', async () => {
    // 6 spot vCPUs in us-east-2: under one 8- or 16-vCPU spot runner,
    // high-memory, arm64 or not, which share the quota.
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
      "backmesh-ubuntu-2404-8vcpu would start no runners: every runner region's spot quota is under one 8-vCPU runner (us-east-2 6 vCPU); raise L-34B43A08 in us-east-2 to use it.",
    );
    expect(confirm).toHaveBeenCalledWith(
      '10 labels would start no runners until a quota is raised. Install anyway?',
    );
    expect(calls.some((c) => c.startsWith('api create'))).toBe(false);
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
    // The listener's VM needs service tokens (anycloud phase 2a).
    await expect(
      install(
        asked,
        setUp({ features: { ...RELEASED, 'service-tokens': undefined } }).deps,
      ),
    ).rejects.toThrow('lacks service-tokens, which backmesh needs');
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

  // acme's listener on its own VM.
  const VM = 'bml-l8u5e-abc123';
  const acmeVm = listenerVm('acme', VM, { region: 'us-east-2' });
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
        BACKMESH_LISTENER_IMAGE: images.listenerImage,
        BACKMESH_RUNNER_GROUP: 'backmesh-l8u5e-k3j9x0',
        ANYCLOUD_API_TOKEN: 'acapi_svc',
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

  it('refuses an org with two listener VMs, before step 6', async () => {
    const { deps, calls } = setUp(
      {
        env: OVERRIDE,
        workloads: [listenerVm('acme', 'bml-l8u5e-def456')],
        vms: [acmeVm],
        hosted: true,
      },
      probe(),
    );
    await expect(install(options, deps)).rejects.toThrow(
      `Each org must have one listener VM:\n- acme has more than one listener VM: bml-l8u5e-def456, ${VM}`,
    );
    expect(calls.some((c) => /^(api access|vm |roll )/.test(c))).toBe(false);
  });

  describe('adding an org to a control plane', () => {
    const beta = listenerVm('beta', 'bml-q2w3e-beta00', {
      region: 'us-east-2',
    });
    const adding = (
      confirm?: (question: string) => Promise<boolean>,
      hosted = true,
    ) =>
      setUp({
        env: OVERRIDE,
        vms: [beta],
        tty: !!confirm,
        confirm,
        hosted,
      });
    const planOf = async (deps: InstallDeps) =>
      (await install({ ...options, plan: true }, deps)) as InstallPlan & {
        planId: string;
      };

    it("takes --control-plane-id naming this machine's control plane", async () => {
      const { deps, calls } = adding();
      const own = { ...options, controlPlaneId: 'c1' };
      const { planId } = (await install({ ...own, plan: true }, deps)) as {
        planId: string;
      };
      await install({ ...own, planId }, deps);
      expect(calls.some((c) => c.startsWith('api create'))).toBe(false);
    });

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
      // An install that stopped before its listener: the cluster record
      // says where it runs.
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

      // No record: no default, at a terminal either.
      const unknown = setUp({ env: OVERRIDE, hosted: true });
      const error = await install(
        { org: 'acme', yes: false },
        unknown.deps,
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UsageError);
      expect((error as Error).message).toBe(
        `This machine targets the control plane at ${HOSTED}, and install can't read where it runs: pass --control-plane <cloud>:<region> as it was created.`,
      );
      expect(unknown.calls.some((c) => c.startsWith('api create'))).toBe(false);
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
      expect(calls.filter((c) => /^(api access|vm )/.test(c))).toEqual([
        'api access add --service backmesh-acme --json',
        expect.stringMatching(/^vm .* --secret backmesh-acme --wait$/),
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
      // `api create` resumed beta's.
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
      expect(calls.some((c) => /^(api access|vm |roll )/.test(c))).toBe(false);
    });

    it('takes no same-owner agreement from --yes alone, on our CI override', async () => {
      // The plan this run read shows beta, but nobody agreed to it.
      const { deps, calls } = adding();
      await expect(install(options, deps)).rejects.toThrow(PlanChanged);
      expect(calls.some((c) => /^(api access|vm |roll )/.test(c))).toBe(false);
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
          env: { ...OVERRIDE, GITHUB_TOKEN: 'ghu_x' },
          vms: [beta, acmeVm],
          hosted: true,
        },
        probe(),
      );
      await install({ ...options, org: 'ACME' }, deps);
      // Its running listener keeps its key: no new sign-in.
      expect(worker.signIns()).toEqual([]);
      expect(worker.calls).not.toContain('POST /v1/installs');
      expect(calls.some((c) => c.startsWith('vm '))).toBe(false);
    });
  });

  it('changes nothing on a re-run of the plan the listener already runs', async () => {
    const asked: string[] = [];
    const { deps, calls, commands, requests, lines } = setUp(
      {
        env: OVERRIDE,
        vms: [acmeVm],
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
      // The listener keeps its VM: nothing new always on.
      listener: null,
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
    expect(calls.some((c) => /^(vm |roll )/.test(c))).toBe(false);
    expect(lines).toContain(
      "No changes: acme's listener already runs this plan.",
    );
    // Its disks are left as they are.
    expect(commands.filter((c) => c.startsWith('aws ec2'))).toEqual([]);
  });

  it("rolls a re-run that only reorders a label's VM types, with no consent asked", async () => {
    // Simulates an org installed before the VM type reorder: its
    // backmesh-ubuntu-2404-kvm-4vcpu listed m7i before m8i.
    const before = (
      JSON.parse(RUNNERS) as { label: string; vmTypes: string[] }[]
    ).map((c) =>
      c.label === 'backmesh-ubuntu-2404-kvm-4vcpu'
        ? { ...c, vmTypes: [...c.vmTypes].reverse() }
        : c,
    );
    const asked: string[] = [];
    const { deps, requests, lines } = setUp(
      {
        env: OVERRIDE,
        vms: [acmeVm],
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
    expect(
      runners.find((r) => r.label === 'backmesh-ubuntu-2404-kvm-4vcpu')
        ?.vmTypes,
    ).toEqual(['m8i.xlarge', 'm7i.xlarge']);
  });

  it('changes the cache cap on a re-run: in the plan and its ID, then the Secret and a roll', async () => {
    const rerun = (env: Record<string, string> = {}) =>
      setUp(
        {
          env: OVERRIDE,
          vms: [acmeVm],
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
    expect(calls).toContainEqual(`roll ${VM}`);

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
        kept.calls.some((c) => /^(vm |roll )/.test(c)),
        cap,
      ).toBe(false);
    }
  });

  it('adds and keeps the public labels with --public-repos, and retires them with --no-public-repos', async () => {
    const rerun = (env: Record<string, string> = {}) =>
      setUp(
        {
          env: OVERRIDE,
          vms: [acmeVm],
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
      'New labels: backmesh-ubuntu-2404-public-2vcpu, backmesh-ubuntu-2404-public-4vcpu.',
    );
    const routes = runnersOf(on.requests);
    expect(
      routes.filter((r) => r.public).map(({ label, code }) => [label, code]),
    ).toEqual([
      ['backmesh-ubuntu-2404-public-2vcpu', 'c2'],
      ['backmesh-ubuntu-2404-public-4vcpu', 'c4'],
    ]);

    // A re-run without the flag keeps them, and changes nothing.
    const json = secretRunners(on.requests);
    const kept = rerun({ BACKMESH_RUNNERS: json });
    await install(options, kept.deps);
    expect(
      kept.requests.filter((r) => r.startsWith('PUT /v1/secrets/')),
    ).toEqual([]);

    // --no-public-repos retires them like any removed class.
    // The plan then names the org's public repositories that can't use
    // the runners.
    const off = rerun({ BACKMESH_RUNNERS: json });
    PUBLIC_REPOS.acme = ['acme/site', 'acme/docs'];
    try {
      await install({ ...options, publicRepos: false }, off.deps);
    } finally {
      delete PUBLIC_REPOS.acme;
    }
    expect(off.lines).not.toContain(PUBLIC_REPOS_LINE);
    expect(off.lines).toContain(
      "acme: 2 public repositories (such as acme/site) can't use these runners, and their jobs wait at GitHub. `backmesh install --org acme --public-repos` adds backmesh-ubuntu-2404-public-2vcpu and backmesh-ubuntu-2404-public-4vcpu for them to use.",
    );
    expect(
      runnersOf(off.requests)
        .filter((r) => r.public)
        .map(({ label, retiring }) => [label, retiring]),
    ).toEqual([
      ['backmesh-ubuntu-2404-public-2vcpu', true],
      ['backmesh-ubuntu-2404-public-4vcpu', true],
    ]);
  });

  it('adds a cloud to a running listener: the plan shows it, then the Secret and a roll', async () => {
    const binary = { 'vm-types gcp us-east4': JSON.stringify(CATALOG.gcp) };
    const rerun = () =>
      setUp(
        {
          env: OVERRIDE,
          vms: [acmeVm],
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
        labelsAdded: expect.arrayContaining(['backmesh-gcp-ubuntu-2404-4vcpu']),
      },
    });
    expect(lines).toContain("acme's runners add gcp us-east4.");
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^New labels: backmesh-gcp-ubuntu-2404-2vcpu, /),
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
      expect.arrayContaining([
        'backmesh-ubuntu-2404-4vcpu',
        'backmesh-gcp-ubuntu-2404-4vcpu',
      ]),
    );
    expect(calls).toContain(`roll ${VM}`);
    expect(calls.some((c) => c.startsWith('vm '))).toBe(false);
    expect(lines).toContain("Rolling acme's listener with the new settings.");
    // The saved control plane answered, so this re-run never ran `cluster
    // create` or anything else on its cloud: adding gcp needed only gcp's
    // vm-types read and its role connection.
    expect(calls.some((c) => c.startsWith('api create'))).toBe(false);
    expect(calls).toContain(`api use ${HOSTED}`);
  });

  it('reuses an answering saved control plane, touching no aws command at all', async () => {
    // An aws control plane with acme's listener: adding gcp runners alone
    // (not aws, which this run doesn't name) should need no aws command,
    // neither through the anycloud binary nor the user's own aws CLI.
    const binary = { 'vm-types gcp us-east4': JSON.stringify(CATALOG.gcp) };
    const { deps, calls, commands, requests } = setUp(
      {
        env: OVERRIDE,
        vms: [acmeVm],
        hosted: true,
      },
      { ...probe(), ...binary },
    );
    await install({ ...options, runners: ['gcp'] }, deps);

    expect(calls.some((c) => c.startsWith('api create'))).toBe(false);
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
    expect(labels).toEqual(
      expect.arrayContaining(['backmesh-gcp-ubuntu-2404-4vcpu']),
    );
  });

  it("connects a reused control plane's cloud while it has no listener yet", async () => {
    // A first install whose `api create` finished but whose aws role
    // connection failed: the API answers and its record is named `backmesh`,
    // but aws's connection and the listener's VM don't exist. The re-run
    // reuses the cluster, yet still connects aws, since step 7 creates the
    // listener's VM with that connection.
    const binary = { 'vm-types gcp us-east4': JSON.stringify(CATALOG.gcp) };
    const { deps, calls } = setUp(
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

    expect(calls.some((c) => c.startsWith('api create'))).toBe(false);
    expect(calls.some((c) => c.startsWith(`credentials new ${BM.aws}`))).toBe(
      true,
    );
    expect(calls).toContainEqual(
      expect.stringMatching(
        new RegExp(`^vm .* --credentials ${BM.aws} --region us-east-2 `),
      ),
    );
  });

  it("keeps today's path for a targeted API that isn't recognizably backmesh's own", async () => {
    // Answering, and its location known (a cluster record this machine's
    // target resolves to), but named for something else entirely and
    // without a listener: this machine's active target may be the
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
    expect(calls.some((c) => c.startsWith('api create'))).toBe(true);
    expect(commands.some((c) => c.startsWith('aws '))).toBe(true);
  });

  it('never reuses a control plane whose location is unknown', async () => {
    // Answering, but with neither a listener nor a `cluster list` record:
    // install can't tell where it runs, let alone that it's its own, so
    // --control-plane still names where to create or resume one, as before.
    const { deps, calls } = setUp({ env: OVERRIDE, hosted: true });
    await install({ ...options, controlPlane: 'aws:us-east-2' }, deps);
    expect(calls.some((c) => c.startsWith('api create'))).toBe(true);
  });

  it('creates the control plane as before with no saved API, or one that never answers', async () => {
    // No saved API: a fresh machine, today's unconditional `api create`.
    const fresh = setUp({ env: OVERRIDE });
    await install(options, fresh.deps);
    expect(fresh.calls.some((c) => c.startsWith('api create'))).toBe(true);

    // A saved API that never answers stops install before it reaches
    // `api create`, exactly as it did before this change: a non-answering
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
    expect(down.calls.some((c) => c.startsWith('api create'))).toBe(false);
  });

  it("carries an unfinished rotate-key rotation's marker through a reinstall's roll, never dropping it", async () => {
    const rotatingFrom = 'cd'.repeat(16);
    const binary = { 'vm-types gcp us-east4': JSON.stringify(CATALOG.gcp) };
    const { deps, requests } = setUp(
      {
        env: OVERRIDE,
        vms: [acmeVm],
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
        vms: [acmeVm],
        hosted: true,
      },
      probe({ BACKMESH_RUNNERS: JSON.stringify(older) }),
    );
    const plan = (await install(
      { ...options, plan: true },
      deps,
    )) as InstallPlan;
    expect(plan.changes?.labelsChanged).toEqual(['backmesh-ubuntu-2404-2vcpu']);
    await install(options, deps);
    expect(calls.some((c) => c.startsWith('roll '))).toBe(true);
  });

  it('refuses a plan agreed to before the listener changed', async () => {
    const { deps } = setUp(
      {
        env: OVERRIDE,
        vms: [acmeVm],
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
        vms: [acmeVm],
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
    expect(moved.calls.some((c) => /^(vm |roll )/.test(c))).toBe(false);
  });

  it("refuses a re-run over a listener on another release: that's upgrade's", async () => {
    const { deps, calls } = setUp(
      {
        env: OVERRIDE,
        vms: [acmeVm],
        hosted: true,
      },
      probe({
        BACKMESH_RUNNER_IMAGE: 'ghcr.io/backmesh/backmesh-runner@sha256:old',
      }),
    );
    await expect(install({ ...options, plan: true }, deps)).rejects.toThrow(
      "acme's listener runs another backmesh release than this one: run `backmesh upgrade` first, then install again.",
    );
    expect(calls.some((c) => /^(vm |roll )/.test(c))).toBe(false);
  });

  it("stops when the org's listener appears after a plan that didn't show it", async () => {
    // This machine targeted no control plane, and `api create` resumed
    // one where acme's listener runs.
    const { deps, calls } = setUp(
      { env: OVERRIDE, workloads: [acmeVm] },
      probe(),
    );
    await expect(install(options, deps)).rejects.toThrow(PlanChanged);
    expect(calls.some((c) => /^(vm |roll )/.test(c))).toBe(false);
  });

  it("keeps a deployed listener's install key, with no new sign-in", async () => {
    const { deps, worker } = setUp(
      {
        env: { ...OVERRIDE, GITHUB_TOKEN: 'ghu_x' },
        vms: [acmeVm],
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
    // GitHub's device flow alone: the Worker isn't part of it.
    expect(signIns()).toEqual([]);
    expect(worker.signIns()).toHaveLength(1);
    const saved = join(deps.env.BACKMESH_ANYCLOUD_DIR!, '.token');
    expect(readFileSync(saved, 'utf8').trim()).toBe(SIGNED_IN);
  });

  it('stops at a listener that fails to start, naming why, once its VM is made', async () => {
    const { deps, calls } = setUp({ env: OVERRIDE });
    const exec = deps.exec!;
    deps.exec = (...args) => {
      const e = exec(...args);
      return async (id, command) =>
        command.startsWith('set -e')
          ? { code: 1, stdout: '', stderr: 'Error: manifest unknown\n' }
          : e(id, command);
    };
    await expect(install(options, deps)).rejects.toThrow(
      /^acme's listener start on bml-[a-z0-9]{5}-[a-z0-9]{6} failed: Error: manifest unknown\.$/,
    );
    expect(calls.filter((c) => c.startsWith('vm '))).toHaveLength(1);
  });

  it('stops when the new listener never answers', async () => {
    const { deps } = setUp({ env: OVERRIDE });
    const exec = deps.exec!;
    deps.exec = (...args) => {
      const e = exec(...args);
      return async (id, command) =>
        command.startsWith('docker exec')
          ? { code: 1, stdout: '', stderr: 'No such container' }
          : e(id, command);
    };
    await expect(install(options, deps)).rejects.toThrow(
      /^acme's listener didn't start on bml-/,
    );
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
      'POST github.com/login/device/code',
      'POST github.com/login/oauth/access_token',
      'POST /v1/installs',
      'POST /v1/token',
    ]);
    expect(fresh.worker.bodies).toEqual([
      { org: 'acme', github_token: SIGNED_IN },
    ]);
    expect(fresh.calls.some((c) => c.startsWith('login'))).toBe(false);

    // A usable GITHUB_TOKEN, as in CI, is kept: nothing is saved over it.
    const ci = setUp({ env: { ...OVERRIDE, GITHUB_TOKEN: 'ghu_x' } });
    await install(options, ci.deps);
    const ciDir = ci.deps.env.BACKMESH_ANYCLOUD_DIR!;
    expect(existsSync(join(ciDir, '.token'))).toBe(false);

    // The hosted API takes only a GitHub App's sign-in: it refuses a PAT, an
    // Actions token, or an OAuth sign-in such as backmesh's before v0.4.4,
    // so install does before anything is billed.
    for (const [token, message] of [
      ['github_pat_x', "The GitHub sign-in isn't backmesh's"],
      ['ghs_x', "The GitHub sign-in isn't backmesh's"],
      ['gho_oauth', "The GitHub sign-in isn't backmesh's"],
      // Another App's user token: its installations name that App.
      ['ghu_other_app', "The GitHub sign-in is another GitHub App's"],
      // A sign-in lasts 8 hours, so CI needs one made within that time.
      [
        'ghu_revoked',
        'GitHub rejected the sign-in: a backmesh sign-in lasts 8 hours, so in CI set GITHUB_TOKEN',
      ],
      [DOWN, "Couldn't check the GitHub sign-in with GitHub. Retry"],
    ]) {
      const refused = setUp({ env: { ...OVERRIDE, GITHUB_TOKEN: token } });
      await expect(install(options, refused.deps)).rejects.toThrow(message);
      expect(refused.calls.some((c) => c.startsWith('api create'))).toBe(false);
    }

    // anycloud reads the saved sign-in over GITHUB_TOKEN, and so does the check.
    const saved = setUp({ env: { ...OVERRIDE, GITHUB_TOKEN: 'ghs_x' } });
    const savedDir = saved.deps.env.BACKMESH_ANYCLOUD_DIR!;
    writeFileSync(join(savedDir, '.token'), 'ghu_saved');
    await install(options, saved.deps);
    // One GitHub can't check stays.
    writeFileSync(join(savedDir, '.token'), DOWN);
    const again = setUp({
      env: {
        ...OVERRIDE,
        GITHUB_TOKEN: 'ghs_x',
        BACKMESH_ANYCLOUD_DIR: savedDir,
      },
    });
    await expect(install(options, again.deps)).rejects.toThrow('Retry');
    expect(readFileSync(join(savedDir, '.token'), 'utf8')).toBe(DOWN);

    // A saved one the control plane would refuse is replaced by a new
    // backmesh sign-in, never by anycloud's.
    for (const token of ['github_pat_saved', 'gho_oauth', 'ghu_revoked']) {
      const stale = setUp({ env: OVERRIDE });
      const staleDir = stale.deps.env.BACKMESH_ANYCLOUD_DIR!;
      writeFileSync(join(staleDir, '.token'), token, { mode: 0o644 });
      await install(options, stale.deps);
      // Only GitHub's refusal is called revoked.
      expect(
        stale.lines.includes(
          `The saved GitHub sign-in expired or was revoked. Install signs in again.`,
        ),
      ).toBe(token === 'ghu_revoked');
      expect(readFileSync(join(staleDir, '.token'), 'utf8').trim()).toBe(
        SIGNED_IN,
      );
      // Rewritten, not overwritten in place: the old file's mode is gone.
      expect(statSync(join(staleDir, '.token')).mode & 0o777).toBe(0o600);
    }
    // With a usable GITHUB_TOKEN, a revoked saved one goes for it.
    const ciRevoked = setUp({ env: { ...OVERRIDE, GITHUB_TOKEN: 'ghu_x' } });
    const ciSaved = ciRevoked.deps.env.BACKMESH_ANYCLOUD_DIR!;
    writeFileSync(join(ciSaved, '.token'), 'ghu_revoked');
    await install(options, ciRevoked.deps);
    expect(ciRevoked.lines).toContain(
      `The saved GitHub sign-in expired or was revoked. Install uses GITHUB_TOKEN.`,
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
    // anycloud generates each identity with the VM Job network's rights.
    for (const { lines } of [aws, gcp]) {
      expect(lines.some((l) => l.includes('key connection'))).toBe(false);
    }
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
      expect.stringMatching(
        /^Sign in with GitHub once, as an owner of acme, so backmesh can connect to it: open https:\/\/github\.com\/login\/device and enter ABCD-1234 \(it expires at \d\d:\d\d UTC\)\.$/,
      ),
      'An owner of acme installs the backmesh GitHub App: open https://github.com/apps/backmesh/installations/new/permissions?target_id=7 and click Install. Waiting for it.',
    ]);
    expect(lines).toContain(
      "Couldn't reach backmesh.com (api.backmesh.com didn't answer); waiting for it.",
    );
    expect(calls.some((c) => c.startsWith('api create'))).toBe(true);
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
      expect(calls.some((c) => c.startsWith('api create'))).toBe(false);
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
          monthlyUsd: 69,
          exists: false,
          sharedWith: [],
        },
        listener: {
          cloud: 'aws',
          region: 'us-east-2',
          vmType: 't3.small',
          monthlyUsd: 17,
        },
        sameOwner: null,
      });
      expect(plan.classes.map((c) => c.label)).toContain(
        'backmesh-ubuntu-2404-4vcpu',
      );
      expect(lines).toEqual(
        expect.arrayContaining([
          ...plan.rates,
          ...plan.quotas,
          expect.stringMatching(
            /^Always on: the control plane's VM \(t3\.large\)/,
          ),
          expect.stringMatching(/^Always on: acme's listener VM \(t3\.small\)/),
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
      expect(moved.calls.some((c) => c.startsWith('api create'))).toBe(false);
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
        RUNNER_REGIONS.us.aws.map((region) => [
          `vm-types aws ${region}`,
          JSON.stringify(CATALOG.aws),
        ]),
      );
      const wide = await planned(setUp({ features }, binary).deps);
      // Home (the control plane's own region) first, then the rest of
      // RUNNER_REGIONS.us.aws in order.
      expect(wide.classes[0]?.regions).toEqual([
        'us-east-2',
        'us-east-1',
        'us-west-2',
      ]);
      expect(wide.planId).not.toBe(narrow.planId);
    });

    it("never runs runners in the control plane's own region when that region isn't a RUNNER_REGIONS candidate", async () => {
      // us-west-1 lacks m7a (regions.spec.ts), so it's excluded from
      // RUNNER_REGIONS.us.aws; putting the control plane there must not leak
      // it into the runner catalog or classes.
      expect(RUNNER_REGIONS.us.aws).not.toContain('us-west-1');
      const features = { ...RELEASED, 'vm-job-regions': '0.1.0' };
      const binary = Object.fromEntries(
        RUNNER_REGIONS.us.aws.map((region) => [
          `vm-types aws ${region}`,
          JSON.stringify(CATALOG.aws),
        ]),
      );
      const plan = await planned(setUp({ features }, binary).deps, {
        ...options,
        controlPlane: 'aws:us-west-1',
      });
      expect(plan.classes[0]?.regions).toEqual(RUNNER_REGIONS.us.aws);
      expect(plan.classes[0]?.regions).not.toContain('us-west-1');
    });

    it("plans --runner-geo eu's regions, anchored on the control plane's, and refuses a geo it doesn't know", async () => {
      const features = { ...RELEASED, 'vm-job-regions': '0.1.0' };
      const binary = Object.fromEntries(
        RUNNER_REGIONS.eu.aws.map((region) => [
          `vm-types aws ${region}`,
          JSON.stringify(CATALOG.aws),
        ]),
      );
      const plan = await planned(setUp({ features }, binary).deps, {
        ...options,
        controlPlane: 'aws:eu-west-1',
        runnerGeo: 'eu',
      });
      expect(plan.runners).toEqual([
        { cloud: 'aws', regions: ['eu-west-1', 'eu-central-1'] },
      ]);
      expect(plan.classes.every((c) => c.regions[0] === 'eu-west-1')).toBe(
        true,
      );
      await expect(
        planned(setUp({ features }, binary).deps, {
          ...options,
          runnerGeo: 'asia',
        }),
      ).rejects.toThrow('--runner-geo asia: expected one of us, eu');
    });

    it('starts --runner-region first, refuses one outside the geo, and keeps it on a re-run', async () => {
      const features = { ...RELEASED, 'vm-job-regions': '0.1.0' };
      const binary = Object.fromEntries(
        RUNNER_REGIONS.eu.aws.map((region) => [
          `vm-types aws ${region}`,
          JSON.stringify(CATALOG.aws),
        ]),
      );
      const eu = {
        ...options,
        controlPlane: 'aws:eu-central-1',
        runnerGeo: 'eu',
      };
      const { deps, lines } = setUp({ features }, binary);
      const plan = await planned(deps, {
        ...eu,
        runnerRegions: ['aws:eu-west-1'],
      });
      expect(plan.runners).toEqual([
        {
          cloud: 'aws',
          regions: ['eu-west-1', 'eu-central-1'],
          preferred: 'eu-west-1',
        },
      ]);
      expect(plan.classes.every((c) => c.preferred)).toBe(true);
      expect(lines).toContain(
        "aws's runners start in eu-west-1 first, for its cache, and in eu-central-1 only when aws refuses them there.",
      );
      expect(plan.planId).not.toBe(
        (await planned(setUp({ features }, binary).deps, eu)).planId,
      );
      for (const [value, message] of [
        [
          'aws:us-east-1',
          "--runner-region aws:us-east-1: not one of aws's eu runner regions: eu-central-1, eu-west-1.",
        ],
        ['gcp:europe-west4', "gcp isn't a runner cloud here (aws)"],
      ]) {
        await expect(
          planned(setUp({ features }, binary).deps, {
            ...eu,
            runnerRegions: [value!],
          }),
        ).rejects.toThrow(message);
      }
    });

    it("refuses --runner-geo eu when this control plane can't take a region list and the runners would stay in the US", async () => {
      await expect(
        planned(setUp().deps, { ...options, runnerGeo: 'eu' }),
      ).rejects.toThrow(
        "--runner-geo eu: aws's runners would stay in us-east-2, outside the geo",
      );
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
      expect(calls.some((c) => c.startsWith('api create'))).toBe(false);
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
    // --runner-geo eu anchors another cloud near Amsterdam.
    expect(parseRunners(['aws', 'gcp'], controlPlane, 'eu')).toEqual([
      { cloud: 'aws', region: 'us-east-2', credentials: '' },
      { cloud: 'gcp', region: 'europe-west4', credentials: '' },
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
      'api create backmesh --cloud gcp --region us-east1 --vm-type e2-standard-2 --sign-in-apps 5622376 --json',
    );
    const routes = parseRoutes(
      JSON.parse(
        requests
          .find((r) => r.startsWith('PUT /v1/secrets/backmesh-acme '))!
          .split(' ')[2]!,
      ).values.BACKMESH_RUNNERS,
    );
    expect(
      routes.find((r) => r.label === 'backmesh-ubuntu-2404-4vcpu')?.regions,
    ).toEqual(['us-east1']);
    expect(
      routes.find((r) => r.label === 'backmesh-aws-ubuntu-2404-4vcpu')?.regions,
    ).toEqual(['us-east-1']);
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
    const second = setUp(
      {
        env: OVERRIDE,
        hosted: true,
        answers: [''],
      },
      {
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
    expect(routes.map((r) => r.label)).toContain(
      'backmesh-gcp-ubuntu-2404-4vcpu',
    );
  });

  it("says when this control plane can't take a region list yet", async () => {
    const { deps, lines } = setUp();
    await install({ ...options, plan: true }, deps);
    expect(lines).toContain(
      "aws's runners stay in us-east-2: this control plane can't take a region list yet.",
    );
    const features = { ...RELEASED, 'vm-job-regions': '0.1.0' };
    const binary = Object.fromEntries(
      RUNNER_REGIONS.us.aws.map((region) => [
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
    expect(calls.some((c) => c.startsWith('api create'))).toBe(false);
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
      RUNNER_REGIONS.us.aws.map((region) => [
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
          'aws us-east-2, us-east-1 and us-west-2 quota: 2112 spot vCPUs (528 backmesh-ubuntu-2404-4vcpu jobs at once), 480 on-demand vCPUs (120 backmesh-ubuntu-2404-4vcpu jobs at once)',
        ]),
      );
      const four = routesOf(requests).find(
        (r) => r.label === 'backmesh-ubuntu-2404-4vcpu',
      )!;
      expect(four).toMatchObject({
        region: 'us-east-2',
        regions: ['us-east-2', 'us-east-1', 'us-west-2'],
      });
    });

    it('keeps the single anchor region while this control plane takes no list', async () => {
      const { deps, requests } = setUp({ env: OVERRIDE, quota: {} }, binary);
      await install(options, deps);
      const four = routesOf(requests).find(
        (r) => r.label === 'backmesh-ubuntu-2404-4vcpu',
      )!;
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
      expect(calls.some((c) => c.startsWith('vm '))).toBe(false);
    });
  });
});

// `az vm list-skus --all --resource-type virtualMachines` as Azure
// documents it (learn.microsoft.com, "Resolve errors for SKU not
// available"), projected as install's `--query` does: each size's entry per
// region, with a `Location` restriction, `NotAvailableForSubscription`,
// where `restricted` says the subscription may not create it.
function skus(restricted: Record<string, string[]>) {
  return JSON.stringify(
    Object.keys(FAMILY).flatMap((name) =>
      RUNNER_REGIONS.us.azure.map((location) => ({
        name,
        family: FAMILY[name],
        locations: [location],
        restrictions: (restricted[name] ?? []).includes(location)
          ? [
              {
                reasonCode: 'NotAvailableForSubscription',
                restrictionInfo: { locations: [location], zones: null },
                type: 'Location',
                values: [location],
              },
            ]
          : [],
      })),
    ),
  );
}
const FAMILY: Record<string, string> = {
  Standard_D2s_v5: 'standardDSv5Family',
  Standard_D2as_v5: 'standardDASv5Family',
  Standard_D2s_v4: 'standardDSv4Family',
  Standard_B2s: 'standardBSFamily',
  Standard_B2als_v2: 'standardBasv2Family',
  Standard_B2ls_v2: 'standardBsv2Family',
  Standard_B2as_v2: 'standardBasv2Family',
  Standard_B2s_v2: 'standardBsv2Family',
};
const LISTENER_SIZES = [
  'Standard_B2s',
  'Standard_B2als_v2',
  'Standard_B2ls_v2',
  'Standard_B2as_v2',
  'Standard_B2s_v2',
  'Standard_D2as_v5',
  'Standard_D2s_v5',
  'Standard_D2s_v4',
];
// Install's one read: the control plane's sizes, then the listener's
// others.
const SKU_QUERY = `[?${[
  'Standard_D2s_v5',
  'Standard_D2as_v5',
  'Standard_D2s_v4',
  ...LISTENER_SIZES.slice(0, 5),
]
  .map((s) => `name=='${s}'`)
  .join(
    ' || ',
  )}].{name:name,family:family,locations:locations,restrictions:restrictions}`;
const CONTROL_SIZES = [
  'Standard_D2s_v5',
  'Standard_D2as_v5',
  'Standard_D2s_v4',
];
// Each of `sizes` refused in `regions`.
const refusedAll = (sizes: readonly string[], regions: readonly string[]) =>
  Object.fromEntries(sizes.map((size) => [size, [...regions]]));
// A subscription refused every size install takes in three regions.
const SPONSORSHIP = refusedAll(LISTENER_SIZES, [
  'eastus',
  'eastus2',
  'westus2',
]);

describe("install's always-on VM sizes on Azure", () => {
  const binary = Object.fromEntries(
    RUNNER_REGIONS.us.azure.map((r) => [
      `vm-types azure ${r}`,
      JSON.stringify(CATALOG.azure),
    ]),
  );
  // A machine with no control plane, signed in to a subscription that
  // `restricted` adds to the sponsorship's restrictions.
  const azure = (
    restricted: Record<string, string[]> = {},
    more: Parameters<typeof setUp>[0] = {},
  ) => {
    const set = setUp(
      { tty: false, restricted: { ...SPONSORSHIP, ...restricted }, ...more },
      binary,
    );
    const { runLong } = set.deps;
    // Each `api delete`'s environment.
    const envs: (NodeJS.ProcessEnv | undefined)[] = [];
    set.deps.runLong = async (args, env) => {
      if (args[1] === 'delete') envs.push(env);
      return runLong(args, env);
    };
    return { ...set, envs };
  };
  const planned = async (opts: InstallOptions, deps: InstallDeps) => {
    const plan = (await install(
      { ...opts, plan: true },
      deps,
    )) as InstallPlan & {
      planId: string;
    };
    return { plan, run: () => install({ ...opts, planId: plan.planId }, deps) };
  };
  const eastus = { ...options, controlPlane: 'azure:eastus' };
  // Azure's capacity refusal, as `api create --json` relays it.
  const CAPACITY = (region: string) =>
    `{"error":{"code":"UNEXPECTED","message":"az deployment group create failed: (SkuNotAvailable) The requested VM size for resource 'Following SKUs have failed for Capacity Restrictions: Standard_D2s_v5' is currently not available in location '${region}'. Please try another size or deploy to a different location or zones. See https://aka.ms/azureskunotavailable for details."}}\n`;
  // A create that fails in `region` with `stdout`, Azure's capacity refusal
  // by default, after the progress `api create` prints on stderr for a
  // new cluster or a resumed one.
  const refusedIn = (
    deps: InstallDeps,
    calls: string[],
    region: string,
    started = 'Creating cluster backmesh (ID: backmesh-1763553600000-x7k2p9)',
    stdout = CAPACITY(region),
  ) => {
    const { runLong } = deps;
    deps.runLong = async (args, env) => {
      if (/^(api create|vm) /.test(args.join(' ')) && args.includes(region)) {
        calls.push(args.join(' '));
        throw new StepFailed(
          args,
          stdout,
          `   [12:00:00 PM] Using azure account sub-1 as ops@example.com\n   [12:00:01 PM] ${started}\n   [12:00:02 PM] Deploying the management VM in ${region}\n`,
          { cause: new Error('exit 1') },
        );
      }
      return runLong(args, env);
    };
  };
  const steps = (calls: string[]) =>
    calls.filter((c) => /^(api (create|delete)|vm )/.test(c));

  it('names a restricted size before any sign-in, and places the VMs where every size is offered', async () => {
    const { deps, lines, worker, commands } = azure();
    const { plan } = await planned(eastus, deps);
    // One read for every region: each `az vm list-skus` downloads Azure's
    // whole catalog, which one per region at once starved a hosted runner.
    expect(commands.filter((c) => c.startsWith('az vm list-skus'))).toEqual([
      `az vm list-skus --all --resource-type virtualMachines --query ${SKU_QUERY} --output json`,
    ]);
    expect(lines.filter((l) => l.startsWith("Azure won't create"))).toEqual([
      "Azure won't create the control plane's VM in eastus for this subscription in any of its sizes: Standard_D2s_v5 (NotAvailableForSubscription), Standard_D2as_v5 (NotAvailableForSubscription), Standard_D2s_v4 (NotAvailableForSubscription).",
      "Azure won't create acme's listener VM in eastus for this subscription in any of its sizes: Standard_B2s (NotAvailableForSubscription), Standard_B2als_v2 (NotAvailableForSubscription), Standard_B2ls_v2 (NotAvailableForSubscription), Standard_B2as_v2 (NotAvailableForSubscription), Standard_B2s_v2 (NotAvailableForSubscription), Standard_D2as_v5 (NotAvailableForSubscription), Standard_D2s_v5 (NotAvailableForSubscription), Standard_D2s_v4 (NotAvailableForSubscription).",
    ]);
    expect(plan).toMatchObject({
      controlPlane: { region: 'centralus', exists: false },
      listener: { region: 'centralus', vmType: 'Standard_B2s' },
    });
    expect(plan.alwaysOnRegions?.map((r) => r.region)).toEqual([
      'centralus',
      'northcentralus',
      'southcentralus',
      'westcentralus',
      'westus',
      'westus3',
    ]);
    expect(worker.calls).toEqual([]);
  });

  it('stops before any sign-in when no region offers a VM any of its sizes', async () => {
    const { deps, worker } = azure(
      refusedAll(CONTROL_SIZES, RUNNER_REGIONS.us.azure),
    );
    const error = await install({ ...eastus, plan: true }, deps).catch(
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toMatch(
      /control plane's VM in eastus .*: Standard_D2s_v5 \(NotAvailableForSubscription\)[\s\S]*No Azure region install tries/,
    );
    expect(worker.calls).toEqual([]);
  });

  it("takes the listener's next size where Azure refuses Standard_B2s in every region, as some offers do", async () => {
    const { deps, lines, calls } = azure({
      ...refusedAll(LISTENER_SIZES, []),
      Standard_B2s: RUNNER_REGIONS.us.azure,
    });
    const { plan, run } = await planned(eastus, deps);
    expect(plan).toMatchObject({
      controlPlane: { region: 'eastus', managementVm: 'Standard_D2s_v5' },
      listener: {
        region: 'eastus',
        vmType: 'Standard_B2als_v2',
        monthlyUsd: 29,
      },
    });
    expect(plan.alwaysOnRegions?.[0]).toEqual({
      region: 'eastus',
      managementVm: 'Standard_D2s_v5',
      listenerVm: 'Standard_B2als_v2',
    });
    expect(lines).toContain(
      "Always on: acme's listener VM (Standard_B2als_v2) on azure eastus, about $29 a month with its disk and address.",
    );
    await run();
    expect(steps(calls)).toEqual([
      'api create backmesh --cloud azure --region eastus --vm-type Standard_D2s_v5 --sign-in-apps 5622376 --json',
      expect.stringContaining(
        '--region eastus --vm-type Standard_B2als_v2 --secret backmesh-acme --wait',
      ),
    ]);
  });

  it("takes the control plane's next size where Azure refuses Standard_D2s_v5", async () => {
    const { deps, lines } = azure({
      Standard_D2s_v5: RUNNER_REGIONS.us.azure,
    });
    const { plan } = await planned(eastus, deps);
    expect(plan).toMatchObject({
      controlPlane: {
        region: 'centralus',
        managementVm: 'Standard_D2as_v5',
        monthlyUsd: 72,
      },
      listener: { region: 'centralus', vmType: 'Standard_B2s' },
    });
    expect(lines).toContain(
      "Always on: the control plane's VM (Standard_D2as_v5) on azure centralus, about $72 a month with its disk and address.",
    );
  });

  it("names a later region's sizes where they differ, and creates the listener at its size there", async () => {
    const { deps, lines, calls } = azure({
      Standard_B2s: ['eastus', 'eastus2', 'westus2', 'northcentralus'],
    });
    refusedIn(deps, calls, 'centralus');
    const { plan, run } = await planned(eastus, deps);
    expect(plan.alwaysOnRegions?.slice(0, 2)).toEqual([
      {
        region: 'centralus',
        managementVm: 'Standard_D2s_v5',
        listenerVm: 'Standard_B2s',
      },
      {
        region: 'northcentralus',
        managementVm: 'Standard_D2s_v5',
        listenerVm: 'Standard_B2als_v2',
      },
    ]);
    expect(lines).toContain(
      "If Azure has no capacity or quota for the control plane's VM in centralus when install creates it, install tries northcentralus (acme's listener VM Standard_B2als_v2, about $29 a month), southcentralus, westcentralus, westus, westus3, in turn.",
    );
    await run();
    expect(steps(calls).at(-1)).toContain(
      '--region northcentralus --vm-type Standard_B2als_v2 --secret backmesh-acme --wait',
    );
  });

  it("takes each VM's next offered size where its family has no quota, reading each region's usage once", async () => {
    // A new subscription: no DSv5 quota in centralus, and the B-series one
    // used up.
    const { deps, commands } = azure(
      {},
      {
        families: {
          centralus: {
            standardDSv5Family: [0, 0],
            standardBSFamily: [10, 9],
          },
        },
      },
    );
    const { plan } = await planned(
      { ...options, controlPlane: 'azure:centralus' },
      deps,
    );
    expect(plan.alwaysOnRegions?.[0]).toEqual({
      region: 'centralus',
      managementVm: 'Standard_D2as_v5',
      listenerVm: 'Standard_B2als_v2',
    });
    const reads = commands.filter((c) => c.startsWith('az vm list-usage'));
    expect(reads).toHaveLength(new Set(reads).size);
  });

  it('counts both VMs against the regional vCPUs they share', async () => {
    const { deps, lines } = azure(
      {},
      { families: { centralus: { cores: [5, 2] } } },
    );
    const { plan } = await planned(
      { ...options, controlPlane: 'azure:centralus' },
      deps,
    );
    expect(lines).toContain(
      "Azure's cores quota in centralus has 3 vCPUs free (limit 5), under the 4 for the control plane's VM (Standard_D2s_v5) and acme's listener VM (Standard_B2s).",
    );
    expect(plan.controlPlane.region).not.toBe('centralus');
  });

  it("says which regions' quotas it couldn't read, and takes them to have room", async () => {
    const { deps, lines } = azure();
    const { command } = deps;
    deps.command = async (args, env) => {
      if (args[2] === 'list-usage' && args.includes('northcentralus')) {
        throw new Error('AuthorizationFailed');
      }
      return command(args, env);
    };
    const { plan } = await planned(eastus, deps);
    expect(lines).toContain(
      "Azure's vCPU quotas couldn't be read in northcentralus, so the plan takes them to have room for the control plane's VM and acme's listener VM.",
    );
    expect(plan.alwaysOnRegions?.map((r) => r.region)).toContain(
      'northcentralus',
    );
  });

  it('stops before any sign-in, naming the quota, when no region has room', async () => {
    const { deps, worker } = azure(
      {},
      {
        families: Object.fromEntries(
          RUNNER_REGIONS.us.azure.map((r) => [
            r,
            {
              standardDSv5Family: [0, 0],
              standardDASv5Family: [0, 0],
              standardDSv4Family: [0, 0],
            },
          ]),
        ),
      },
    );
    const error = (await install(
      { ...options, controlPlane: 'azure:centralus', plan: true },
      deps,
    ).catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toMatch(
      /standardDSv5Family quota in centralus has 0 vCPUs free[\s\S]*with quota for it\..* Or raise Azure's standardDSv5Family vCPU quota in one of those regions\.$/,
    );
    expect(worker.calls).toEqual([]);
  });

  it.each([
    '(QuotaExceeded) Operation could not be completed as it results in exceeding approved standardDSv5Family Cores quota.',
    // A sponsorship subscription's regional vCPUs.
    '(OperationNotAllowed) Operation could not be completed as it results in exceeding approved Total Regional Cores quota.',
  ])(
    'deletes what a quota-refused api create started and tries the next region: %s',
    async (refusal) => {
      const { deps, calls } = azure();
      refusedIn(
        deps,
        calls,
        'centralus',
        undefined,
        `{"error":{"code":"UNEXPECTED","message":"az deployment group create failed: ${refusal} Location: centralus, Current Limit: 0, Current Usage: 0, Additional Required: 2"}}\n`,
      );
      await (await planned(eastus, deps)).run();
      expect(steps(calls)).toEqual([
        expect.stringContaining(
          'api create backmesh --cloud azure --region centralus ',
        ),
        expect.stringMatching(/^api delete .* --region centralus /),
        expect.stringContaining(
          'api create backmesh --cloud azure --region northcentralus ',
        ),
        expect.stringContaining(
          '--region northcentralus --vm-type Standard_B2s',
        ),
      ]);
    },
  );

  it('deletes what a capacity-refused api create started and tries the next region, signing in once', async () => {
    const { deps, calls, worker, envs } = azure();
    refusedIn(deps, calls, 'centralus');
    await (await planned(eastus, deps)).run();
    const id = 'backmesh-1763553600000-x7k2p9';
    expect(steps(calls)).toEqual([
      'api create backmesh --cloud azure --region centralus --vm-type Standard_D2s_v5 --sign-in-apps 5622376 --json',
      `api delete ${id} --cloud azure --region centralus --delete-vms --delete-buckets --confirm ${id} --json`,
      'api create backmesh --cloud azure --region northcentralus --vm-type Standard_D2s_v5 --sign-in-apps 5622376 --json',
      expect.stringContaining(
        '--region northcentralus --vm-type Standard_B2s --secret backmesh-acme --wait',
      ),
    ]);
    // Its API never answered, so delete goes on without it.
    expect(envs).toEqual([{ API_URL: `https://${id}.anycloud.sh` }]);
    expect(worker.signIns()).toHaveLength(1);
  });

  it('never deletes a resumed cluster that Azure refuses for capacity', async () => {
    const { deps, calls } = azure();
    refusedIn(
      deps,
      calls,
      'centralus',
      'Resuming cluster backmesh (ID: backmesh-1763553600000-x7k2p9)',
    );
    await expect((await planned(eastus, deps)).run()).rejects.toThrow(
      'SkuNotAvailable',
    );
    expect(steps(calls)).toEqual([
      'api create backmesh --cloud azure --region centralus --vm-type Standard_D2s_v5 --sign-in-apps 5622376 --json',
    ]);
  });

  it('leaves a new cluster that failed for another reason as it is', async () => {
    const { deps, calls } = azure();
    refusedIn(
      deps,
      calls,
      'centralus',
      undefined,
      '{"error":{"code":"API_NOT_READY","message":"The API at https://backmesh-1763553600000-x7k2p9.anycloud.sh did not answer within 25 minutes"}}\n',
    );
    await expect((await planned(eastus, deps)).run()).rejects.toThrow(
      'API_NOT_READY',
    );
    expect(steps(calls)).toEqual([
      'api create backmesh --cloud azure --region centralus --vm-type Standard_D2s_v5 --sign-in-apps 5622376 --json',
    ]);
  });

  it('resumes a control plane named backmesh that --control-plane-id names, where it exists', async () => {
    const { deps, calls, commands, lines } = azure(
      {},
      {
        groups: [
          { id: 'backmesh-1763553600000-x7k2p9', location: 'northcentralus' },
        ],
      },
    );
    const { plan, run } = await planned(
      { ...eastus, controlPlaneId: 'backmesh-1763553600000-x7k2p9' },
      deps,
    );
    expect(commands).toContain(
      'az group list --tag anycloud_cluster_name=backmesh --query [].{id:tags.anycloud_cluster,location:location} --output json',
    );
    expect(plan).toMatchObject({
      controlPlane: { region: 'northcentralus' },
      listener: { region: 'northcentralus' },
      alwaysOnRegions: [{ region: 'northcentralus' }],
    });
    // One region's sizes alone, which Azure filters.
    expect(commands.filter((c) => c.startsWith('az vm list-skus'))).toEqual([
      `az vm list-skus --all --location northcentralus --resource-type virtualMachines --query ${SKU_QUERY} --output json`,
    ]);
    expect(lines).toContain(
      'Install resumes the control plane backmesh-1763553600000-x7k2p9 in azure northcentralus.',
    );
    await run();
    expect(steps(calls)[0]).toBe(
      'api create backmesh --cloud azure --region northcentralus --vm-type Standard_D2s_v5 --sign-in-apps 5622376 --json',
    );
  });

  it('stops before any sign-in on two control planes named backmesh, or none it can read', async () => {
    const two = azure(
      {},
      {
        groups: [
          { id: 'backmesh-1763553600000-x7k2p9', location: 'northcentralus' },
          { id: 'backmesh-1763640000000-q4w5e6', location: 'westus' },
        ],
      },
    );
    await expect(install({ ...eastus, plan: true }, two.deps)).rejects.toThrow(
      'This Azure subscription has 2 control planes named backmesh: backmesh-1763553600000-x7k2p9 in northcentralus, backmesh-1763640000000-q4w5e6 in westus.',
    );
    const unread = azure();
    const { command } = unread.deps;
    unread.deps.command = async (args, env) => {
      if (args.slice(0, 3).join(' ') === 'az group list') {
        throw new Error('AuthorizationFailed');
      }
      return command(args, env);
    };
    await expect(
      install({ ...eastus, plan: true }, unread.deps),
    ).rejects.toThrow(
      "azure couldn't list this Azure subscription's control planes, so install can't tell whether one named backmesh exists.",
    );
    expect([...two.worker.calls, ...unread.worker.calls]).toEqual([]);
  });

  it("names no other region for a control plane that exists where its size isn't offered", async () => {
    const { deps } = azure(
      {},
      {
        groups: [{ id: 'backmesh-1763553600000-x7k2p9', location: 'eastus' }],
      },
    );
    const error = (await install(
      {
        ...eastus,
        controlPlaneId: 'backmesh-1763553600000-x7k2p9',
        plan: true,
      },
      deps,
    ).catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(
      /No Azure region install tries \(eastus\) .* Delete the control plane named backmesh in eastus, or use another subscription\.$/,
    );
    expect(error.message).not.toContain('--control-plane');
  });

  it("prints the exact labels, unprefixed on Azure's control plane, and ends on the largest one the quotas start a runner for", async () => {
    // A sponsorship subscription's 3 spot vCPUs in each region.
    const spot = (limit: number) =>
      Object.fromEntries(
        RUNNER_REGIONS.us.azure.map((r) => [
          r,
          { lowPriorityCores: [limit, 0] },
        ]),
      ) as Record<string, Record<string, [number, number]>>;
    const features = { ...RELEASED, 'vm-job-regions': '0.1.0' };
    const { deps, lines } = azure({}, { families: spot(3), features });
    const { run } = await planned(eastus, deps);
    const labels = lines.filter((l) => l.startsWith('Labels for runs-on: '));
    expect(labels[0]).toMatch(
      /^Labels for runs-on: backmesh-ubuntu-2404-2vcpu, backmesh-ubuntu-2404-4vcpu, .*backmesh-ubuntu-2404-gpu-t4, backmesh-ubuntu-2404-gpu-od-t4, backmesh-ubuntu-2404-highmem-2vcpu, .*backmesh-ubuntu-2404-highmem-od-16vcpu \(azure's carry no "azure-": it runs the control plane\)\.$/,
    );
    expect(labels[0]).not.toContain('backmesh-azure-');
    expect(lines).toContainEqual(
      expect.stringMatching(
        / spot vCPUs \(0 backmesh-ubuntu-2404-4vcpu jobs at once/,
      ),
    );
    lines.length = 0;
    await run();
    expect(lines.slice(-2)).toEqual([
      labels[0],
      'Done. Use `runs-on: backmesh-ubuntu-2404-2vcpu` (a 2-vCPU spot VM) in a workflow; other sizes: https://backmesh.com/labels/',
    ]);
    const none = azure({}, { families: spot(1), features });
    await (await planned(eastus, none.deps)).run();
    expect(none.lines.at(-1)).toBe(
      'Done, but no spot label up to 4 vCPUs starts a runner until a quota the plan named is raised. Sizes: https://backmesh.com/labels/',
    );
  });

  it("reads Azure's sizes again once, with a longer timeout, and stops the plan before any sign-in when they can't be read", async () => {
    const set = azure();
    const { command } = set.deps;
    const timeouts: (number | undefined)[] = [];
    // `execFile`'s errors: a kill at the timeout, or az's own on stderr.
    const failed = (more: object) =>
      Object.assign(
        new Error(
          `Command failed: az vm list-skus --all --resource-type virtualMachines`,
        ),
        { stderr: '', killed: false, ...more },
      );
    let failures: Error[] = [failed({ killed: true })];
    set.deps.command = async (args, env, timeout) => {
      if (args[2] === 'list-skus') {
        timeouts.push(timeout);
        const failure = failures.shift();
        if (failure) throw failure;
      }
      return command(args, env, timeout);
    };
    // A slow catalog read answers the second time.
    const { plan } = await planned(eastus, set.deps);
    expect(timeouts).toEqual([180_000, 180_000]);
    expect(plan.alwaysOnRegions?.[0]?.region).toBe('centralus');
    const stopped = async (twice: Error[]) => {
      failures = twice;
      const error = (await install({ ...eastus, plan: true }, set.deps).catch(
        (e: unknown) => e,
      )) as Error;
      expect(error).toBeInstanceOf(UsageError);
      return error.message;
    };
    expect(
      await stopped([failed({ killed: true }), failed({ killed: true })]),
    ).toBe(
      "Azure's VM sizes couldn't be read with `az vm list-skus` (it timed out after 3 minutes, twice), so the plan can't tell which region this subscription may create the control plane's VM and acme's listener VM in. Check that `az` answers, then run install again.",
    );
    expect(
      await stopped([
        failed({ killed: true }),
        failed({
          stderr:
            "WARNING: ...\nERROR: (AuthorizationFailed) The client 'ops@example.com' does not have authorization\n\n",
        }),
      ]),
    ).toContain(
      "`az vm list-skus` (ERROR: (AuthorizationFailed) The client 'ops@example.com' does not have authorization), so",
    );
    expect(await stopped([failed({}), failed({})])).toContain(
      '`az vm list-skus` (Command failed: az vm list-skus --all --resource-type virtualMachines), so',
    );
    expect(set.worker.calls).toEqual([]);
  });

  it("checks only a new listener's size on an existing control plane, and never retries it", async () => {
    // beta's AWS control plane; acme adds Azure runners, so its listener
    // goes on Azure's anchor, eastus, where the sponsorship refuses B2s.
    const { deps, calls, lines } = azure(
      {},
      {
        hosted: true,
        vms: [listenerVm('beta', 'bml-q2w3e-beta00', { region: 'us-east-2' })],
      },
    );
    const { plan, run } = await planned(
      { ...options, runners: ['azure'] },
      deps,
    );
    expect(plan).toMatchObject({
      controlPlane: { cloud: 'aws', exists: true },
      listener: { cloud: 'azure', region: 'centralus' },
      alwaysOnRegions: [{ region: 'centralus', listenerVm: 'Standard_B2s' }],
    });
    // Its VM isn't read, so the plan names no size for it.
    expect(plan.controlPlane).not.toHaveProperty('managementVm');
    expect(lines.some((l) => l.startsWith('If Azure has no capacity'))).toBe(
      false,
    );
    refusedIn(deps, calls, 'centralus');
    await expect(run()).rejects.toThrow('SkuNotAvailable');
    expect(steps(calls)).toEqual([
      expect.stringMatching(
        /^vm .* --region centralus --vm-type Standard_B2s /,
      ),
    ]);
  });

  it("stops before any sign-in when AWS's on-demand quota is under the always-on VMs", async () => {
    const { deps, worker } = setUp(
      {
        tty: false,
        quota: {
          'L-34B43A08': '640.0',
          'L-1216C47A': '128.0',
          'L-1216C47A@us-east-2': '2.0',
        },
      },
      { 'vm-types gcp us-east4': JSON.stringify(CATALOG.gcp) },
    );
    // GCP's runners: AWS's quota is read for the always-on VMs alone.
    const error = (await install(
      { ...options, runners: ['gcp'], plan: true },
      deps,
    ).catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toBe(
      `AWS allows 2 on-demand vCPUs in us-east-2, under the 4 for the control plane's VM (t3.large) and acme's listener VM (t3.small): raise EC2 "Running On-Demand Standard (A, C, D, H, I, M, R, T, Z) instances" (L-1216C47A) in us-east-2.`,
    );
    expect(worker.calls).toEqual([]);
  });

  it("goes on, saying so, when AWS's on-demand quota can't be read for the always-on VMs", async () => {
    const { deps, lines, commands } = setUp(
      { tty: false, quota: {} },
      { 'vm-types gcp us-east4': JSON.stringify(CATALOG.gcp) },
    );
    await install({ ...options, runners: ['gcp'], plan: true }, deps);
    expect(lines).toContain(
      "AWS's L-1216C47A quota couldn't be read in us-east-2, so the plan takes it to have room for the control plane's VM and acme's listener VM.",
    );
    // L-1216C47A alone: the runners' other quotas aren't the VMs'.
    expect(commands.filter((c) => c.startsWith('aws service-quotas'))).toEqual([
      expect.stringContaining('--quota-code L-1216C47A '),
    ]);
  });

  it("leaves another cloud's failed create as it is", async () => {
    const { deps, calls } = setUp({ tty: false });
    const { runLong } = deps;
    deps.runLong = async (args, env) => {
      if (args[1] === 'create') {
        calls.push(args.join(' '));
        throw new StepFailed(
          args,
          '{"error":{"code":"UNEXPECTED","message":"CREATE_FAILED: We currently do not have sufficient t3.large capacity in the Availability Zone you requested (us-east-2a). (InsufficientInstanceCapacity)"}}\n',
          '   [12:00:01 PM] Creating cluster backmesh (ID: backmesh-1763553600000-x7k2p9)\n',
          { cause: new Error('exit 1') },
        );
      }
      return runLong(args, env);
    };
    await expect((await planned(options, deps)).run()).rejects.toThrow(
      'InsufficientInstanceCapacity',
    );
    expect(steps(calls)).toEqual([
      'api create backmesh --cloud aws --region us-east-2 --vm-type t3.large --sign-in-apps 5622376 --json',
    ]);
  });
});

describe("a control plane named backmesh that this machine doesn't use", () => {
  const ID = 'backmesh-1763553600000-x7k2p9';
  const stack = (id: string, name = 'backmesh') => [
    { Key: 'anycloud_cluster', Value: id },
    { Key: 'anycloud_cluster_name', Value: name },
  ];
  const refused = async (
    opts: InstallOptions,
    more: Parameters<typeof setUp>[0],
    binary: Record<string, string> = {},
  ) => {
    const { deps, worker, calls } = setUp({ tty: false, ...more }, binary);
    const error = (await install({ ...opts, plan: true }, deps).catch(
      (e: unknown) => e,
    )) as Error;
    // Before any sign-in, and before anything is created.
    expect(worker.calls).toEqual([]);
    expect(calls.some((c) => c.startsWith('api create'))).toBe(false);
    expect(error).toBeInstanceOf(UsageError);
    return error.message;
  };

  it("refuses AWS's in the region, naming it and both ways forward", async () => {
    const { deps, commands } = setUp({ tty: false });
    await install({ ...options, plan: true }, deps);
    expect(commands).toContain(
      "aws cloudformation describe-stacks --region us-east-2 --query Stacks[?starts_with(StackName,'anycloud-')].Tags --output json",
    );
    expect(
      await refused(options, {
        stacks: [stack('other-1', 'prod'), stack(ID)],
      }),
    ).toBe(
      `A control plane named backmesh already exists in this AWS account's us-east-2: ${ID}. This machine doesn't use it, so it may be another installation's. If it isn't yours, pass --control-plane aws:<another region> to create a separate one. If it's yours, such as from another machine or an install that stopped, pass --control-plane-id ${ID} to resume it.`,
    );
  });

  it("refuses Azure's in the subscription and GCP's in the project, naming another subscription or project", async () => {
    const azure = await refused(
      { ...options, controlPlane: 'azure:eastus' },
      { groups: [{ id: ID, location: 'westus' }] },
      { 'vm-types azure eastus': JSON.stringify(CATALOG.azure) },
    );
    expect(azure).toContain(
      `already exists in this Azure subscription: ${ID} in westus.`,
    );
    expect(azure).toContain(
      "If it isn't yours, use another subscription to create a separate one, as backmesh names one control plane per subscription.",
    );
    const gcp = await refused(
      { ...options, controlPlane: 'gcp:us-east4' },
      {
        serviceAccounts: [
          { description: 'anycloud_cluster=c9 anycloud_cluster_name=prod' },
          {
            description: `anycloud_cluster=${ID} anycloud_cluster_name=backmesh anycloud_bucket=${ID}`,
          },
        ],
      },
      { 'vm-types gcp us-east4': JSON.stringify(CATALOG.gcp) },
    );
    expect(gcp).toContain(`already exists in this GCP project: ${ID}.`);
    expect(gcp).toContain(`pass --control-plane-id ${ID} to resume it.`);
  });

  it('names the delete command for one that holds no VM, as an install that stopped leaves', async () => {
    const stopped = async (
      opts: InstallOptions,
      more: Parameters<typeof setUp>[0],
      binary: Record<string, string>,
    ) => {
      const { deps, worker } = setUp({ tty: false, ...more }, binary);
      const { command } = deps;
      const lists: string[] = [];
      deps.command = async (args, env, timeout) => {
        const line = args.join(' ');
        if (
          /^(az vm list |aws ec2 describe-instances|gcloud compute instances list)/.test(
            line,
          )
        ) {
          lists.push(line);
          return '[]';
        }
        return command(args, env, timeout);
      };
      const error = (await install({ ...opts, plan: true }, deps).catch(
        (e: unknown) => e,
      )) as Error;
      expect(worker.calls).toEqual([]);
      expect(error).toBeInstanceOf(UsageError);
      return { message: error.message, lists };
    };
    const azure = await stopped(
      { ...options, controlPlane: 'azure:eastus' },
      { groups: [{ id: ID, location: 'eastus' }] },
      { 'vm-types azure eastus': JSON.stringify(CATALOG.azure) },
    );
    expect(azure.lists).toEqual([
      `az vm list --resource-group anycloud-${ID} --query [].name --output json`,
    ]);
    expect(azure.message).toBe(
      `A control plane named backmesh already exists in this Azure subscription: ${ID} in eastus. It holds no VM, so it's from an install that stopped, and this machine doesn't use it. If you don't need it, delete it with \`az group delete --name anycloud-${ID}\`, then run install again; to resume it, pass --control-plane-id ${ID}. If it isn't yours, use another subscription to create a separate one, as backmesh names one control plane per subscription.`,
    );
    const aws = await stopped(options, { stacks: [stack(ID)] }, {});
    expect(aws.lists).toEqual([
      `aws ec2 describe-instances --region us-east-2 --filters Name=tag:Name,Values=anycloud-cluster-${ID} Name=instance-state-name,Values=pending,running,stopping,stopped --query Reservations[].Instances[].InstanceId --output json`,
    ]);
    expect(aws.message).toContain(
      `delete it with \`aws cloudformation delete-stack --stack-name anycloud-${ID} --region us-east-2\``,
    );
    const gcp = await stopped(
      { ...options, controlPlane: 'gcp:us-east4' },
      {
        serviceAccounts: [
          {
            email: 'anycloud-0123@proj.iam.gserviceaccount.com',
            description: `anycloud_cluster=${ID} anycloud_cluster_name=backmesh`,
          },
        ],
      },
      { 'vm-types gcp us-east4': JSON.stringify(CATALOG.gcp) },
    );
    expect(gcp.lists).toEqual([
      `gcloud compute instances list --filter=name=anycloud-cluster-${ID} --format=json(name)`,
    ]);
    expect(gcp.message).toContain(
      `delete what it left with \`gcloud iam service-accounts delete anycloud-0123@proj.iam.gserviceaccount.com\` and \`gcloud compute firewall-rules delete anycloud-cluster-${ID}-k8s anycloud-cluster-${ID}-api\`, and its checkpoint bucket, if any, with \`gcloud storage rm --recursive gs://${ID}\``,
    );
  });

  it("resumes the one --control-plane-id names, and refuses an ID it didn't find", async () => {
    const { deps, calls, lines } = setUp({
      env: OVERRIDE,
      stacks: [stack(ID)],
    });
    await install({ ...options, controlPlaneId: ID }, deps);
    expect(lines).toContain(`Install resumes the control plane ${ID}.`);
    expect(calls).toContainEqual(
      expect.stringMatching(
        /^api create backmesh --cloud aws --region us-east-2 /,
      ),
    );
    expect(
      await refused(
        { ...options, controlPlaneId: 'backmesh-ubuntu-2404-2vcpu' },
        {
          stacks: [stack(ID)],
        },
      ),
    ).toBe(
      `--control-plane-id backmesh-ubuntu-2404-2vcpu: this AWS account's us-east-2 has ${ID} named backmesh, not that one.`,
    );
    expect(
      await refused(
        { ...options, controlPlaneId: 'backmesh-ubuntu-2404-2vcpu' },
        {},
      ),
    ).toBe(
      "--control-plane-id backmesh-ubuntu-2404-2vcpu: this AWS account's us-east-2 has no control plane named backmesh, not that one.",
    );
  });

  it("stops on two named backmesh, or a cloud CLI that can't list them, on AWS and GCP too", async () => {
    expect(
      await refused(options, {
        stacks: [stack(ID), stack('backmesh-ubuntu-2404-2vcpu')],
      }),
    ).toBe(
      `This AWS account's us-east-2 has 2 control planes named backmesh: ${ID} in us-east-2, backmesh-ubuntu-2404-2vcpu in us-east-2. install can't tell which to resume: delete the ones you don't use, then run install again.`,
    );
    const gcp = { ...options, controlPlane: 'gcp:us-east4' };
    const binary = { 'vm-types gcp us-east4': JSON.stringify(CATALOG.gcp) };
    expect(
      await refused(
        gcp,
        {
          serviceAccounts: [ID, 'backmesh-ubuntu-2404-2vcpu'].map((id) => ({
            description: `anycloud_cluster=${id} anycloud_cluster_name=backmesh`,
          })),
        },
        binary,
      ),
    ).toMatch(/^This GCP project has 2 control planes named backmesh: /);
    for (const [opts, cli, more] of [
      [options, 'aws cloudformation', {}],
      [gcp, 'gcloud iam', binary],
    ] as const) {
      const { deps, worker } = setUp({ tty: false }, more);
      const { command } = deps;
      deps.command = async (args, env) => {
        if (args.join(' ').startsWith(cli)) throw new Error('AccessDenied');
        return command(args, env);
      };
      await expect(install({ ...opts, plan: true }, deps)).rejects.toThrow(
        /couldn't list this (AWS account's us-east-2|GCP project)'s control planes, so install can't tell whether one named backmesh exists\./,
      );
      expect(worker.calls).toEqual([]);
    }
  });

  it('resumes the one this machine targets with no flag', async () => {
    const { deps, calls } = setUp({
      env: OVERRIDE,
      hosted: true,
      stacks: [stack('c1')],
    });
    await install(options, deps);
    expect(calls).toContainEqual(
      expect.stringMatching(/^api create backmesh /),
    );
  });

  it('names --control-plane-id in a failed api create that started one', async () => {
    const { deps } = setUp({ env: OVERRIDE });
    const { runLong } = deps;
    deps.runLong = async (args, env) => {
      if (args[1] !== 'create') return runLong(args, env);
      throw new StepFailed(
        args,
        '{"error":{"code":"API_NOT_READY","message":"The API did not answer within 25 minutes"}}\n',
        `   [12:00:01 PM] Creating cluster backmesh (ID: ${ID})\n`,
        { cause: new Error('exit 1') },
      );
    };
    await expect(install(options, deps)).rejects.toThrow(
      `(API_NOT_READY)\nTo resume it, run install again with --control-plane-id ${ID}.`,
    );
  });
});

describe("install's arm64 line", () => {
  it('says why a cloud gets no arm64 labels', () => {
    const target = { region: 'us-east-2', credentials: 'bm' };
    expect(noArmLine({ ...target, cloud: 'aws' }, ['us-east-2'])).toBe(
      'aws us-east-2 offers no m8g or m7g, so aws gets no arm64 labels.',
    );
    expect(
      noArmLine({ ...target, cloud: 'gcp' }, ['us-east4', 'us-east1']),
    ).toBe(
      'gcp us-east4 and us-east1 offer no c4a or t2a, so gcp gets no arm64 labels.',
    );
    expect(noArmLine({ ...target, cloud: 'azure' }, ['eastus'])).toBe(
      'azure gets no arm64 labels: anycloud boots its arm64 image on AWS and GCP only.',
    );
  });
});
