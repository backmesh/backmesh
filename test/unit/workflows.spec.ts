import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

import { deriveRefs } from '../../src/listener/cache.js';
import { RUNNER_REGIONS } from '../../src/runners/regions.js';

// A fork's pull request must never land on backmesh's private runners, read a
// secret, take an environment or get a token that writes. ci.yml dogfoods the
// public labels for forks; every other workflow sends them to GitHub's runners.
// Its workflow files are its own, so this is defense in depth: the guard is the
// listener, which cancels a fork's run on any label but backmesh-ubuntu-2404-public-*.
const DIR = '.github/workflows';
const TRIGGERS = [
  'push',
  'pull_request',
  'schedule',
  'workflow_dispatch',
  'workflow_call',
];

type Permissions = Record<string, string>;
type Step = {
  id?: string;
  name?: string;
  uses?: string;
  with?: Record<string, string>;
  if?: string;
  run?: string;
  env?: Record<string, string>;
};
type Job = {
  if?: string;
  needs?: string | string[];
  env?: Record<string, string>;
  outputs?: Record<string, string>;
  strategy?: {
    'max-parallel'?: number;
    matrix?: { include?: unknown[] } & Record<string, unknown>;
  };
  steps?: Step[];
  'runs-on'?: string;
  uses?: string;
  with?: Record<string, unknown>;
  environment?: unknown;
  secrets?: unknown;
  permissions?: Permissions;
};
type Workflow = {
  on: Record<string, unknown>;
  concurrency?: unknown;
  env?: unknown;
  defaults?: unknown;
  permissions?: Permissions;
  jobs: Record<string, Job>;
};
// GitHub's null is a deleted head repository's.
type Context = Record<string, string | null>;

const read = (file: string): Workflow =>
  load(readFileSync(`${DIR}/${file}`, 'utf8')) as Workflow;

const pullRequest = (head: string | null): Context => ({
  'github.event.pull_request.head.repo.full_name': head,
  'github.event_name': 'pull_request',
  'github.repository': 'backmesh/backmesh',
  'github.ref': 'refs/pull/1/merge',
});
const FORK = pullRequest('outsider/backmesh');
const GONE = pullRequest(null);
const SAME_REPO = pullRequest('backmesh/backmesh');

// The expression subset our runs-on and job ifs use: context names, strings,
// ==, !=, &&, || (which return an operand, as JavaScript's do), parentheses and
// startsWith. Anything else throws, so a new form fails here until added.
function evaluate(expression: string, context: Context): unknown {
  let expr = expression;
  for (const [name, v] of Object.entries(context).sort(
    ([a], [b]) => b.length - a.length,
  )) {
    expr = expr.replaceAll(name, JSON.stringify(v));
  }
  // Repository variables are unset here: runs-on's defaults are what it tests.
  expr = expr.replace(/\bvars\.[A-Z_]+/g, "''");
  expr = expr.replaceAll('!=', '!==').replace(/([^!=])==/g, '$1===');
  const startsWith = (s: string, prefix: string) => s.startsWith(prefix);
  return new Function('startsWith', `'use strict'; return (${expr});`)(
    startsWith,
  );
}

// Runs a step's script as Actions does (bash -eo pipefail), with `env` and,
// for each of `commands`, a stub on PATH whose body is that shell.
function runStep(
  script: string,
  {
    env = {},
    commands = {},
  }: {
    env?: Record<string, string>;
    commands?: Record<string, string>;
  },
) {
  const bin = mkdtempSync(join(tmpdir(), 'step-'));
  for (const [name, body] of Object.entries(commands)) {
    writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  return spawnSync('bash', ['-eo', 'pipefail', '-c', script], {
    env: { ...process.env, ...env, PATH: `${bin}:${process.env.PATH}` },
    encoding: 'utf8',
  });
}

// A release binary's stub that fails unless the job's token reached it as
// GH_TOKEN, for GitHub's rate limit, and not as GITHUB_TOKEN, which backmesh
// would take for the control plane's sign-in, or as ISSUE_TOKEN.
const jobToken = (name: string, body: string) =>
  `[[ \${GH_TOKEN:-} == t0k && -z \${GITHUB_TOKEN:-}\${ISSUE_TOKEN:-} ]] || { echo "${name} didn't get the job's token as GH_TOKEN only" >&2; exit 9; }\n${body}`;
// with-sign-in.sh runs its command without the token (spec below).
const signedIn = (run: string) =>
  run.replace('test/e2e/with-sign-in.sh ', 'env -u ISSUE_TOKEN ');

const unwrap = (value: string) => value.match(/^\$\{\{(.*)\}\}$/s)?.[1];

// The GCP leg's role connection IDs, as e2e.yml's test-org job sets them in
// run 9's first attempt.
const ROLE_IDS = {
  ANYCLOUD_ROLE_POOL: 'bm-e2e-9-1',
  ANYCLOUD_ROLE_SERVICE_ACCOUNT: 'bm-e2e-9-1',
  ANYCLOUD_ROLE_CUSTOM_ROLE: 'backmeshE2e',
};

// No secret but GITHUB_TOKEN anywhere a job can read one.
const noSecrets = (where: string, value: unknown) =>
  expect(
    JSON.stringify(value ?? null).replaceAll('secrets.GITHUB_TOKEN', ''),
    where,
  ).not.toMatch(/secrets\./);

// A reusable workflow's inputs as `inputs.<name>`: its caller's `with`, or
// their defaults.
function inputsOf(workflow: Workflow, given: Record<string, unknown> = {}) {
  const declared = ((
    workflow.on.workflow_call as { inputs?: Record<string, unknown> } | null
  )?.inputs ?? {}) as Record<string, { default?: unknown }>;
  return Object.fromEntries(
    Object.entries(declared).map(([name, { default: d }]) => [
      `inputs.${name}`,
      String(given[name] ?? d ?? ''),
    ]),
  );
}

// A job's matrix legs, each as `matrix.<key>`: the one-key lists our
// workflows use, given in place or as `fromJSON(inputs.<name>)`.
function legs(job: Job, context: Context): Context[] {
  const matrix = Object.entries(job.strategy?.matrix ?? {}).filter(
    ([key]) => key !== 'include',
  );
  if (!matrix.length) return [{}];
  expect(matrix.length).toBe(1);
  const [key, value] = matrix[0]!;
  const input = /^fromJSON\((inputs\.[\w-]+)\)$/.exec(
    unwrap(String(value))?.trim() ?? '',
  )?.[1];
  const values = (
    input ? JSON.parse(context[input] ?? 'null') : value
  ) as string[];
  return values.map((v) => ({ [`matrix.${key}`]: v }));
}

// The jobs a pull request starts, through local reusable workflows, with the
// runner each lands on: a matrix job's legs each name theirs.
function started(
  file: string,
  context: Context,
  workflow = read(file),
): { job: string; runsOn: unknown }[] {
  noSecrets(file, { env: workflow.env, defaults: workflow.defaults });
  return Object.entries(workflow.jobs).flatMap(([name, job]) => {
    const where = `${file} ${name}`;
    if (job.if !== undefined && !evaluate(unwrap(job.if) ?? job.if, context))
      return [];
    noSecrets(where, job);
    expect(job.secrets, where).toBeUndefined();
    expect(job.environment, where).toBeUndefined();
    if (job.uses?.startsWith('./')) {
      const called = job.uses.replace(`./${DIR}/`, '');
      return started(called, {
        ...context,
        ...inputsOf(read(called), job.with),
      });
    }
    // A reusable workflow's own permissions cap what its caller grants.
    const permissions = job.permissions ?? workflow.permissions;
    expect(permissions, where).toBeDefined();
    const writes = Object.values(permissions ?? {}).filter(
      (p) => p !== 'read' && p !== 'none',
    );
    expect(writes, where).toEqual([]);
    const runsOn = job['runs-on'] ?? '';
    const expr = unwrap(runsOn);
    return legs(job, context).map((leg) => ({
      job: [where, ...Object.values(leg)].join(' '),
      runsOn:
        expr === undefined ? runsOn : evaluate(expr, { ...context, ...leg }),
    }));
  });
}

const workflows = readdirSync(DIR).filter((f) => f.endsWith('.yml'));
const onPullRequest = workflows.filter((f) => 'pull_request' in read(f).on);

describe('the workflows', () => {
  it('listen to no event an outsider can trigger but pull_request', () => {
    for (const file of workflows) {
      expect(
        Object.keys(read(file).on).filter((t) => !TRIGGERS.includes(t)),
        file,
      ).toEqual([]);
    }
  });

  it.each([
    ['a fork', FORK],
    ['a deleted fork', GONE],
  ])(
    "run %s's pull request on backmesh-ubuntu-2404-public-4vcpu in ci.yml and GitHub's runners elsewhere",
    (_, context) => {
      const jobs = onPullRequest.flatMap((f) => started(f, context));
      expect(jobs.some(({ job }) => job.startsWith('ci.yml '))).toBe(true);
      for (const { job, runsOn } of jobs) {
        if (job.startsWith('ci.yml '))
          expect(runsOn, job).toBe('backmesh-ubuntu-2404-public-4vcpu');
        else expect(runsOn, job).toMatch(/^ubuntu-/);
      }
    },
  );

  // A GitHub-hosted runner's shared IP soon spends the 60 anonymous API
  // reads an hour, and GitHub then answers 403.
  it("read GitHub's SSH host keys with the job's token", () => {
    const steps = workflows.flatMap((f) =>
      Object.values(read(f).jobs).flatMap((job) =>
        (job.steps ?? [])
          .filter((step) => step.run?.includes('known_hosts'))
          .map((step) => ({ where: `${f} ${step.name}`, step })),
      ),
    );
    expect(steps.length).toBeGreaterThan(0);
    for (const { where, step } of steps) {
      expect(step.run, where).not.toContain('api.github.com');
      expect(step.run, where).toContain(
        `gh api meta --jq '.ssh_keys[] | "github.com " + .' >>~/.ssh/known_hosts`,
      );
      expect(step.env?.GH_TOKEN, where).toBe('${{ github.token }}');
    }
  });

  // backmesh's runners are x86-64: an arm64 image builds on GitHub's arm64
  // runner, free for a public repository.
  it('keep a same-repository pull request on backmesh, and build arm64 on ubuntu-24.04-arm', () => {
    const jobs = onPullRequest.flatMap((f) => started(f, SAME_REPO));
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.map(({ job }) => job)).toContain('image.yml build linux/arm64');
    for (const { job, runsOn } of jobs) {
      expect(runsOn, job).toBe(
        job.endsWith(' linux/arm64')
          ? 'ubuntu-24.04-arm'
          : 'backmesh-ubuntu-2404-4vcpu',
      );
    }
  });
});

describe("e2e.yml's test-org run", () => {
  const e2e = read('e2e.yml');
  const runs = (version: string) =>
    Object.entries(e2e.jobs)
      .filter(
        ([, job]) =>
          job.if === undefined ||
          /cancelled\(\)/.test(job.if) ||
          evaluate(unwrap(job.if)!, { 'inputs.version': version }),
      )
      .map(([name]) => name);

  it("runs only on a dispatch with a version, and our org's members only without", () => {
    expect(runs('')).not.toContain('test-org');
    expect(runs('')).toContain('label');
    expect(runs('v0.4.3-rc.1')).toContain('test-org');
    expect(runs('v0.4.3-rc.1')).not.toContain('label');
    expect(e2e.jobs.stop!.if).toMatch(/&& !inputs\.version/);
  });

  // A test org's installation makes its subscription's one anycloud-role
  // setup, so every version run, on any org, queues behind the last.
  it('runs one version run at a time, whatever its org', () => {
    const { group } = e2e.concurrency as { group: string };
    const [, expr] = group.match(/^e2e-\$\{\{(.*)\}\}$/)!;
    const of = (org: string, version: string) =>
      evaluate(expr!, { 'inputs.org': org, 'inputs.version': version });
    expect(of('backmesh-dryrun', 'v0.4.3-rc.1')).toBe(
      of('another-test-org', 'v0.4.3'),
    );
    expect(of('backmesh', '')).toBe('backmesh');
    expect(of('backmesh-dryrun', 'v0.4.3')).not.toBe(of('backmesh', ''));
  });

  it('always uninstalls, keeping the App, and always sweeps', () => {
    const steps = e2e.jobs['test-org']!.steps!;
    const step = (name: string) => steps.find((s) => s.name === name)!;
    const uninstall = step('backmesh uninstall');
    const roles = step("Delete the role connection's setup");
    const sweep = step('Sweep AWS for anything left');
    const gcp = step('Sweep GCP for anything left');

    expect(uninstall.if).toMatch(/^\$\{\{ always\(\) &&/);
    expect(uninstall.run).toMatch(
      /flags=\(--org "\$ORG" --yes --keep-app --delete-checkpoint-bucket /,
    );
    expect(uninstall.run).toMatch(/\$bm uninstall "\$\{flags\[@\]\}"/);
    // After an upgrade that didn't move the control plane, the release that
    // installed it uninstalls it, unless both pin one anycloud: then the
    // release under test does, which knows its own labels.
    expect(uninstall.run).toMatch(/bm=backmesh-from/);
    expect(uninstall.run).toContain('$FROM_ANYCLOUD != "$VERSION_ANYCLOUD"');
    expect(step("Install the release's backmesh and anycloud").run).toContain(
      'echo "VERSION_ANYCLOUD=$anycloud" >>"$GITHUB_ENV"',
    );
    expect(sweep.if).toMatch(/^\$\{\{ always\(\) &&/);
    expect(roles.if).toBe(uninstall.if);
    expect(steps.indexOf(roles)).toBe(steps.indexOf(uninstall) + 1);
    expect(steps.indexOf(sweep)).toBeGreaterThan(steps.indexOf(roles));
    expect(gcp.if).toBe("${{ always() && steps.gcp.outcome == 'success' }}");
    expect(steps.indexOf(gcp)).toBeGreaterThan(steps.indexOf(roles));
  });

  // The customer path: install connects each cloud with a role connection
  // through its CLI, so neither leg needs Microsoft Graph or an IAM user.
  it('installs without our CI override, and reads nothing through Microsoft Graph', () => {
    const job = JSON.stringify(e2e.jobs['test-org']);
    expect(job).not.toContain('BACKMESH_UNSUPPORTED_CI_OVERRIDE');
    expect(job).not.toMatch(/\baz ad\b/);
  });
});

describe("release.yml's Worker deploy", () => {
  const release = read('release.yml');
  const SETUP = 'node worker/scripts/setup.ts --apply';
  const deploys = Object.entries(release.jobs).filter(([, job]) =>
    job.steps?.some((s) => s.run?.includes(SETUP)),
  );
  const none: Job = {};
  const [name, deploy] = deploys[0] ?? ['', none];
  const needs = (job: string): string[] =>
    [release.jobs[job]!.needs ?? []].flat().flatMap((n) => [n, ...needs(n)]);

  it("deploys backmesh-billing with the publish environment's Cloudflare token, as worker-setup.yml does", () => {
    expect(deploys.map(([n]) => n)).toHaveLength(1);
    expect(deploy.environment).toBe('publish');
    const step = deploy.steps!.find((s) => s.run?.includes(SETUP))!;
    const { MODE: _, ...setup } = read(
      'worker-setup.yml',
    ).jobs.setup!.steps!.find((s) =>
      s.run?.includes('worker/scripts/setup.ts'),
    )!.env!;
    const { RC: _rc, ...env } = step.env!;
    expect(env).toEqual(setup);
    expect(step.env!.CLOUDFLARE_API_TOKEN).toBe(
      '${{ secrets.CLOUDFLARE_API_TOKEN }}',
    );
  });

  // The step's own script, with node stubbed to print the setup it runs.
  const setupOf = (rc: 'true' | 'false') => {
    const step = deploy.steps!.find((s) => s.run?.includes(SETUP))!;
    const out = runStep(step.run!, {
      env: { RC: rc },
      commands: { node: 'echo "$@"' },
    });
    expect(step.env!.RC).toBe('${{ needs.check.outputs.rc }}');
    return out.stdout.trim();
  };

  it('deploys production on a release, and staging only on an rc', () => {
    expect(deploy.if).toBeUndefined();
    expect(setupOf('false')).toBe('worker/scripts/setup.ts --apply');
    expect(setupOf('true')).toBe('worker/scripts/setup.ts --apply --staging');
  });

  it('deploys after the checks and builds, and before anything publishes', () => {
    expect(needs(name)).toEqual(expect.arrayContaining(['check', 'matrix']));
    for (const job of ['release', 'public', 'cache-action', 'homebrew']) {
      expect(needs(job), job).toContain(name);
    }
    // Neither an rc nor a release publishes after a failed deploy: with no
    // `if`, GitHub runs a job only when every job it needs succeeded.
    expect(release.jobs.release!.needs).toContain(name);
    expect(release.jobs.release!.if).toBeUndefined();
  });
});

describe("e2e.yml's Worker and Azure checks", () => {
  const e2e = read('e2e.yml');

  // The plan's step that reads the release, run for `version`.
  const target = (version: string) => {
    const step = e2e.jobs.plan!.steps!.find((s) => s.id === 'pinned')!;
    const dir = mkdtempSync(join(tmpdir(), 'plan-'));
    const out = join(dir, 'output');
    writeFileSync(out, '');
    expect(
      runStep(step.run!, { env: { VERSION: version, GITHUB_OUTPUT: out } })
        .status,
    ).toBe(0);
    return /^api-url=(.*)$/m.exec(readFileSync(out, 'utf8'))?.[1];
  };

  it('targets the staging Worker for an rc and production for a release', () => {
    expect(target('v1.2.3-rc.1')).toBe('https://api-staging.backmesh.com');
    expect(target('v1.2.3')).toBe('https://api.backmesh.com');
    expect(e2e.jobs.plan!.outputs!['api-url']).toBe(
      '${{ steps.pinned.outputs.api-url }}',
    );
    // The version check, and every CLI call of the fresh install.
    for (const job of ['worker', 'test-org']) {
      expect(e2e.jobs[job]!.env?.BACKMESH_API_URL, job).toBe(
        '${{ needs.plan.outputs.api-url }}',
      );
    }
  });

  it("fails unless the target Worker runs the one built from the tag's commit, before and after the install", () => {
    const CHECK = 'test/e2e/worker-commit.sh';
    const check = e2e.jobs.worker!.steps!.find((s) => s.run === CHECK)!;
    // Two rcs share staging: test-org rechecks once it's done.
    const last = e2e.jobs['test-org']!.steps!.at(-1)!;
    expect(last.run).toBe(CHECK);
    expect(last.if).toBe('${{ always() }}');
    const want = 'a'.repeat(40);
    const run = (answer: string) =>
      runStep(check.run!, {
        env: {
          VERSION: 'v1.2.3-rc.1',
          GITHUB_REPOSITORY: 'backmesh/backmesh',
          BACKMESH_API_URL: 'https://api-staging.backmesh.com',
        },
        // gh answers the tag's commit, curl what the Worker says, if asked
        // the target's /v1/version.
        commands: {
          gh: `echo ${want}`,
          curl: `[[ " $* " == *" https://api-staging.backmesh.com/v1/version "* ]] || exit 7\n${answer}`,
        },
      });
    expect(run(`echo '{"commit":"${want}"}'`).status).toBe(0);
    const other = run(`echo '{"commit":"${'b'.repeat(40)}"}'`);
    expect(other.status).toBe(1);
    expect(other.stdout).toContain(
      `api-staging.backmesh.com runs the Worker built from ${'b'.repeat(40)}, not v1.2.3-rc.1's ${want}`,
    );
    // A Worker without /v1/version, as v0.4.3's: curl -f fails.
    expect(run('exit 22').status).toBe(1);
  });

  // v0.4.3's install under --yes refuses to pick a control plane: each leg
  // names its own, and Azure's is centralus, where our subscription offers
  // both control-plane sizes.
  it('installs fresh on Azure too, one leg at a time, with its control plane named', () => {
    const job = e2e.jobs['test-org']!;
    expect(job.strategy!['max-parallel']).toBe(1);
    expect(job.strategy!.matrix!.include).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cloud: 'azure',
          placement: '--runners azure',
          'control-plane-region': 'centralus',
        }),
      ]),
    );
    const { args } = labelMatrix('azure');
    expect(args).toHaveLength(2);
    for (const call of args) {
      expect(call).toContain('--control-plane azure:centralus');
    }
    expect(labelMatrix('aws').args[1]).toContain(
      '--control-plane aws:us-west-2',
    );
  });

  // anycloud finds a GCP cluster by name in the whole project (the guard
  // below), so any region would do: us-central1, where GCP's runners go too.
  it('installs fresh on GCP too, with its control plane in us-central1', () => {
    expect(e2e.jobs['test-org']!.strategy!.matrix!.include).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cloud: 'gcp',
          placement: '--runners gcp',
          'control-plane-region': 'us-central1',
        }),
      ]),
    );
    const { args } = labelMatrix('gcp');
    expect(args).toHaveLength(2);
    for (const call of args) {
      expect(call).toContain('--runners gcp --control-plane gcp:us-central1');
    }
  });

  // The install step's own script, for a leg, up to the sign-in: backmesh
  // stubbed to print a plan with Azure's runner regions.
  const labelMatrix = (cloud: string) => {
    const job = e2e.jobs['test-org']!;
    const leg = (
      job.strategy!.matrix!.include as Record<string, string | undefined>[]
    ).find((l) => l.cloud === cloud)!;
    const step = job.steps!.find((s) => s.id === 'install')!;
    expect(step.env!.LABEL).toBe('${{ matrix.label }}');
    expect(step.env!.GH_TOKEN).toBe('${{ github.token }}');
    const dir = mkdtempSync(join(tmpdir(), 'install-'));
    const env = join(dir, 'env');
    writeFileSync(env, '');
    const plan = {
      planId: 'p1',
      controlPlane: { cloud, region: 'eastus' },
      runners: [
        { cloud: 'azure', regions: ['eastus'] },
        { cloud: 'gcp', regions: ['us-central1', 'us-east1'] },
      ],
    };
    const matrix = {
      include: [
        {
          label: 'backmesh-ubuntu-2404-4vcpu',
          cloud: 'aws',
          regions: ['us-east-2'],
        },
      ],
    };
    const args = join(dir, 'args');
    const out = runStep(signedIn(step.run!), {
      env: {
        GITHUB_TOKEN: '',
        GH_TOKEN: 't0k',
        ISSUE_TOKEN: 't0k',
        CLOUD: cloud,
        PLACEMENT: leg.placement!,
        LABEL: leg.label ?? '',
        CONTROL_PLANE_REGION: leg['control-plane-region'] ?? '',
        MATRIX: JSON.stringify(matrix),
        GITHUB_ENV: env,
      },
      commands: {
        backmesh: jobToken(
          'backmesh',
          `echo "$*" >>${args}\necho '${JSON.stringify(plan)}'`,
        ),
      },
    });
    expect(out.status, out.stderr).toBe(0);
    const line = /^LABEL_MATRIX=(.*)$/m.exec(readFileSync(env, 'utf8'))![1]!;
    return {
      matrix,
      got: JSON.parse(line) as typeof matrix,
      args: readFileSync(args, 'utf8').trim().split('\n'),
    };
  };

  // Our Azure CI subscription has 3 spot vCPUs per region until its quota
  // is raised: the Azure leg's one job runs on backmesh-ubuntu-2404-2vcpu, AWS's on `labels`.
  it("runs the Azure leg's one job on its leg's label, and AWS's labels unchanged", () => {
    const azure = labelMatrix('azure');
    expect(azure.got.include).toEqual([
      expect.objectContaining({
        label: 'backmesh-ubuntu-2404-2vcpu',
        cloud: 'azure',
        regions: ['eastus'],
      }),
    ]);
    const aws = labelMatrix('aws');
    expect(aws.got).toEqual(aws.matrix);
  });

  // GCP's control plane makes it the home cloud, whose labels are plain.
  it("runs the GCP leg's one job on backmesh-ubuntu-2404-4vcpu in the plan's GCP regions", () => {
    expect(labelMatrix('gcp').got.include).toEqual([
      expect.objectContaining({
        label: 'backmesh-ubuntu-2404-4vcpu',
        cloud: 'gcp',
        regions: ['us-central1', 'us-east1'],
        kvm: false,
        gpu: false,
      }),
    ]);
  });

  // Both legs sign in from the e2e environment: AWS as its role, Azure as
  // its own managed identity (e2e-azure-identity.yml), so neither waits for
  // ci-install's reviewer.
  it("signs in to every cloud from e2e's environment", () => {
    const job = e2e.jobs['test-org']!;
    expect(job.environment).toBe('e2e');

    const secrets = (text: string) =>
      [...text.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]);
    expect(new Set(secrets(JSON.stringify(job)))).toEqual(
      new Set([
        'AZURE_CLIENT_ID',
        'AZURE_TENANT_ID',
        'AZURE_SUBSCRIPTION_ID',
        'AWS_ROLE_ARN',
        'GCP_WORKLOAD_IDENTITY_PROVIDER',
        'GCP_SERVICE_ACCOUNT',
        'GCP_PROJECT_ID',
        'E2E_TEST_ORG_DEPLOY_KEY',
      ]),
    );
    // Each cloud's secrets only in its own leg.
    const only = (cloud: string, names: RegExp) => {
      for (const [key, value] of Object.entries(job.env!)) {
        if (names.test(value)) {
          expect(value, key).toMatch(
            new RegExp(`^\\$\\{\\{ matrix\\.cloud == '${cloud}' && `),
          );
        }
      }
      for (const step of job.steps!) {
        if (names.test(JSON.stringify({ ...step, if: undefined }))) {
          expect(step.if, step.name ?? step.id).toBe(
            `matrix.cloud == '${cloud}'`,
          );
        }
      }
    };
    only('azure', /secrets\.AZURE_/);
    only('aws', /secrets\.AWS_/);
    only('gcp', /secrets\.GCP_/);
    expect(job.env!.AZURE_SUBSCRIPTION_ID).toBe(
      "${{ matrix.cloud == 'azure' && secrets.AZURE_SUBSCRIPTION_ID || '' }}",
    );
  });
});

describe("e2e.yml's Azure sweep", () => {
  const e2e = read('e2e.yml');
  const sweep = e2e.jobs['test-org']!.steps!.find(
    (s) => s.name === 'Sweep Azure for anything left',
  )!;

  // Without the control plane's ID: the anycloud groups az lists now,
  // against those listed before the install; `role` answers az's reads of
  // the role connection's setup.
  const run = (
    before: string,
    now: string,
    role: Record<string, string> = {},
    guard = 'success',
  ) => {
    const dir = mkdtempSync(join(tmpdir(), 'sweep-'));
    writeFileSync(join(dir, 'groups-before'), before);
    return runStep(sweep.run!, {
      env: {
        RUNNER_TEMP: dir,
        CLUSTER_ID: '',
        AZURE_SUBSCRIPTION_ID: 's-1',
        ROLE_GUARD: guard,
      },
      commands: {
        az: `case "$1 $2" in
  "group list") printf '%s' '${now}' ;;
  "group exists") echo ${role.group ?? 'false'} ;;
  "deployment sub") printf '%s' '${role.deployment ?? ''}' ;;
  "role definition") [[ " $* " == *" --name Anycloud role connection s-1 --scope /subscriptions/s-1 "* ]] || exit 7
    printf '%s' '${role.definition ?? ''}' ;;
  *) exit 8 ;;
esac`,
      },
    });
  };

  it('passes when nothing new exists, empty lists included', () => {
    for (const [before, now] of [
      ['', ''],
      ['', '\n'],
      ['anycloud-old\n', 'anycloud-old\n'],
    ] as const) {
      const out = run(before, now);
      expect(out.status, JSON.stringify([before, now])).toBe(0);
      expect(out.stdout).not.toContain('::error');
    }
  });

  it('fails naming a resource group made during the run, and nothing empty', () => {
    const out = run('anycloud-old\n', 'anycloud-old\nanycloud-new\n');
    expect(out.status).toBe(1);
    expect(out.stdout.match(/^::error.*$/gm)).toEqual([
      '::error title=Left in Azure::resource-group:anycloud-new',
    ]);
  });

  // After the guard refused, the setup there is another's.
  it("doesn't name the role connection's setup when the guard refused", () => {
    expect(sweep.env?.ROLE_GUARD).toBe('${{ steps.role-guard.outcome }}');
    const out = run(
      '',
      '',
      { group: 'true', deployment: 'anycloud-role\n', definition: 'd-1\n' },
      'failure',
    );
    expect(out.status, out.stdout).toBe(0);
  });

  // The guard found none before the install.
  it("fails naming the role connection's setup while any of it is there", () => {
    const out = run('', '', {
      group: 'true',
      deployment: 'anycloud-role\n',
      definition: 'd-1\n',
    });
    expect(out.status).toBe(1);
    expect(out.stdout.match(/^::error.*$/gm)).toEqual([
      '::error title=Left in Azure::deployment:anycloud-role',
      '::error title=Left in Azure::resource-group:anycloud-role',
      '::error title=Left in Azure::role-definition:d-1',
    ]);
  });
});

// A subscription holds one role connection setup, anycloud-role, so one
// there before the leg's install is another's: install would take it over,
// and the cleanup would delete it.
describe("e2e.yml's Azure leg, alone in its subscription's role connection", () => {
  const job = read('e2e.yml').jobs['test-org']!;
  const steps = job.steps!;
  const guard = steps.find((s) => s.id === 'role-guard')!;
  const run = (group: string, deployments: string) =>
    runStep(guard.run!, {
      commands: {
        az: `case "$1 $2" in
  "group exists") [[ " $* " == *" --name anycloud-role "* ]] || exit 7; echo ${group} ;;
  "deployment sub") printf '%s' '${deployments}' ;;
  *) exit 8 ;;
esac`,
      },
    });

  it('fails before install while the subscription has a role connection', () => {
    expect(guard.if).toBe("matrix.cloud == 'azure'");
    expect(steps.indexOf(guard)).toBeGreaterThan(
      steps.findIndex((s) => s.id === 'azure'),
    );
    expect(steps.indexOf(guard)).toBeLessThan(
      steps.findIndex((s) => s.id === 'install'),
    );
    expect(run('false', '').status).toBe(0);
    expect(run('true', '').status).toBe(1);
    expect(run('false', 'anycloud-role\n').status).toBe(1);
    expect(run('false', '').stdout).not.toContain('::error');
    // It says how to delete one the cleanup didn't.
    expect(run('true', '').stdout).toMatch(
      /^::error title=A role connection in the subscription::.*az group delete --name anycloud-role.*az role definition delete .*az deployment sub delete --name anycloud-role/m,
    );
  });

  it("doesn't uninstall or delete a role connection after it refuses", () => {
    for (const name of [
      'backmesh uninstall',
      "Delete the role connection's setup",
    ]) {
      const step = steps.find((s) => s.name === name)!;
      const runs = (guarded: string) =>
        evaluate(unwrap(step.if!)!.replace('always()', 'true'), {
          'steps.bin.outcome': 'success',
          'steps.guard.outcome': 'skipped',
          'steps.role-guard.outcome': guarded,
          'steps.gcp-guard.outcome': 'skipped',
        });
      expect(runs('failure'), name).toBe(false);
      expect(runs('success'), name).toBe(true);
    }
  });
});

// Uninstall leaves each role connection's setup, which trusts only the
// deleted control plane, and says so; the leg deletes what anycloud's
// `credentials delete --apply` would have.
describe("e2e.yml's role connection cleanup", () => {
  const step = read('e2e.yml').jobs['test-org']!.steps!.find(
    (s) => s.name === "Delete the role connection's setup",
  )!;
  const run = (
    env: Record<string, string>,
    commands: Record<string, string>,
  ) => {
    const dir = mkdtempSync(join(tmpdir(), 'roles-'));
    const calls = join(dir, 'calls');
    const out = runStep(step.run!, {
      env,
      commands: Object.fromEntries(
        Object.entries(commands).map(([name, body]) => [
          name,
          `echo "${name} $*" >>${calls}\n${body}`,
        ]),
      ),
    });
    expect(out.status, out.stderr).toBe(0);
    return existsSync(calls)
      ? readFileSync(calls, 'utf8').trim().split('\n')
      : [];
  };

  it("deletes the AWS leg's stack, named for its control plane, in its region", () => {
    const env = {
      CLOUD: 'aws',
      CONTROL_PLANE_REGION: 'us-west-2',
      ORG_ID: '7',
    };
    expect(run({ ...env, CLUSTER_ID: 'k3x9q2' }, { aws: '' })).toEqual([
      'aws cloudformation delete-stack --region us-west-2 --stack-name anycloud-role-k3x9q2-anycloud-sh',
      'aws cloudformation wait stack-delete-complete --region us-west-2 --stack-name anycloud-role-k3x9q2-anycloud-sh',
    ]);
    // No control plane, no role connection.
    expect(run({ ...env, CLUSTER_ID: '' }, { aws: 'exit 9' })).toEqual([]);
  });

  it("deletes the Azure leg's identity's assignments, its group, the role and the deployment", () => {
    const env = { CLOUD: 'azure', AZURE_SUBSCRIPTION_ID: 's-1' };
    const az = (group: string) => `case "$1 $2 $3" in
  "group exists "*) echo ${group} ;;
  "identity show "*) echo p-1 ;;
  "role assignment list") echo a-1; echo a-2 ;;
  "role definition list") echo d-1 ;;
  "deployment sub list") echo anycloud-role ;;
esac`;
    expect(run(env, { az: az('true') })).toEqual([
      'az group exists --name anycloud-role',
      'az identity show --resource-group anycloud-role --name anycloud-role --query principalId --output tsv',
      "az role assignment list --scope /subscriptions/s-1 --fill-principal-name false --query [?principalId == 'p-1'].id --output tsv",
      'az role assignment delete --ids a-1 a-2',
      'az group delete --name anycloud-role --yes',
      'az role definition list --name Anycloud role connection s-1 --scope /subscriptions/s-1 --query [].name --output tsv',
      'az role definition delete --name Anycloud role connection s-1 --scope /subscriptions/s-1',
      "az deployment sub list --query [?name == 'anycloud-role'].name --output tsv",
      'az deployment sub delete --name anycloud-role',
    ]);
    // Without the group, its identity's assignments went with it.
    expect(run(env, { az: az('false') })).not.toContainEqual(
      expect.stringMatching(/^az (identity|role assignment|group delete)/),
    );
    // Without the identity, the group still goes; a role still assigned
    // stays, for the sweep to name.
    const partial = run(env, {
      az: az('true')
        .replace('echo p-1', 'exit 3')
        .replace('esac', '  "role definition delete") exit 1 ;;\nesac'),
    });
    expect(partial).not.toContainEqual(
      expect.stringMatching(/^az role assignment/),
    );
    expect(partial).toContain('az group delete --name anycloud-role --yes');
    expect(partial).toContain('az deployment sub delete --name anycloud-role');
  });

  // The run's own pool and service account (ROLE_IDS below): its pool's
  // providers, the pool, the account's grant of the custom role, the
  // account. The custom role stays for the next run.
  it("deletes the GCP leg's pool, its providers, its account's grant and its account", () => {
    const env = { CLOUD: 'gcp', ...ROLE_IDS };
    const role = 'projects/p-1/roles/backmeshE2e';
    const account = 'bm-e2e-9-1@p-1.iam.gserviceaccount.com';
    const policy = JSON.stringify({
      bindings: [
        { role, members: [`serviceAccount:${account}`] },
        { role: 'roles/viewer', members: ['user:someone@example.com'] },
      ],
    });
    const gcloud = (left: boolean) => `case "$1 $2 $3 $4" in
  "config get-value project "*) echo p-1 ;;
  "iam workload-identity-pools list "*) ${left ? 'echo other; echo bm-e2e-9-1' : 'echo other'} ;;
  "iam workload-identity-pools providers list") echo anycloud-api ;;
  "projects get-iam-policy p-1 "*) echo '${left ? policy : '{}'}' ;;
  "iam service-accounts list "*) ${left ? `echo ${account}` : 'true'} ;;
esac`;
    const pool = '--workload-identity-pool=bm-e2e-9-1 --location=global';
    expect(run(env, { gcloud: gcloud(true) })).toEqual([
      'gcloud config get-value project',
      'gcloud iam workload-identity-pools list --location=global --format=value(name.basename())',
      `gcloud iam workload-identity-pools providers list ${pool} --format=value(name.basename())`,
      `gcloud iam workload-identity-pools providers delete anycloud-api ${pool} --quiet`,
      'gcloud iam workload-identity-pools delete bm-e2e-9-1 --location=global --quiet',
      'gcloud projects get-iam-policy p-1 --format=json',
      `gcloud projects remove-iam-policy-binding p-1 --member=serviceAccount:${account} --role=${role} --all --quiet`,
      `gcloud iam service-accounts list --filter=email=${account} --format=value(email)`,
      `gcloud iam service-accounts delete ${account} --quiet`,
    ]);
    // Nothing there: only reads.
    expect(run(env, { gcloud: gcloud(false) })).not.toContainEqual(
      expect.stringMatching(/ (delete|remove-iam-policy-binding) /),
    );
  });
});

// Our production control plane is a cluster named backmesh in us-east-2 of
// the e2e's AWS account, and anycloud finds a cluster by name per region:
// v0.5.0-rc.3's e2e (run 44634950328) resumed it there.
describe("e2e.yml's AWS leg, away from our production control plane", () => {
  const e2e = read('e2e.yml');
  const job = e2e.jobs['test-org']!;
  const aws = (
    job.strategy!.matrix!.include as Record<string, string | undefined>[]
  ).find((l) => l.cloud === 'aws')!;
  const guard = job.steps!.find((s) => s.id === 'guard')!;

  it('puts its control plane in us-west-2, a region its labels and sweep cover', () => {
    expect(aws['control-plane-region']).toBe('us-west-2');
    const labels = (
      e2e.on.workflow_dispatch as {
        inputs: Record<string, { default: string }>;
      }
    ).inputs.labels!.default;
    for (const entry of labels.trim().split(/\s+/)) {
      expect(entry.split(':')[1]!.split(','), entry).toContain('us-west-2');
    }
  });

  // describe-stacks lists no deleted stack.
  const stack = (name: string, value: string) => ({
    StackName: name,
    Tags: [{ Key: 'anycloud_cluster_name', Value: value }],
  });
  const run = (answer: string) =>
    runStep(guard.run!, {
      env: { CONTROL_PLANE_REGION: 'us-west-2' },
      commands: {
        aws: `[[ " $* " == *" cloudformation describe-stacks --region us-west-2 "* ]] || exit 7\n${answer}`,
      },
    });

  it("fails before install while the leg's region has a backmesh cluster", () => {
    expect(guard.if).toBe("matrix.cloud == 'aws'");
    const steps = job.steps!;
    expect(steps.indexOf(guard)).toBeGreaterThan(
      steps.findIndex((s) => s.id === 'aws'),
    );
    expect(steps.indexOf(guard)).toBeLessThan(
      steps.findIndex((s) => s.id === 'install'),
    );

    const other = JSON.stringify({
      Stacks: [stack('anycloud-other', 'other'), { StackName: 'untagged' }],
    });
    expect(run(`echo '${other}'`).status).toBe(0);
    expect(run(`echo '{"Stacks":[]}'`).status).toBe(0);
    const ours = JSON.stringify({
      Stacks: [stack('anycloud-backmesh-1', 'backmesh')],
    });
    const out = run(`echo '${ours}'`);
    expect(out.status).toBe(1);
    expect(out.stdout).toContain('anycloud-backmesh-1');
    // An unreadable region is refused too.
    expect(run('exit 255').status).not.toBe(0);
  });

  // Uninstall would act on the backmesh cluster the guard found.
  it("doesn't uninstall after the guard refuses the region", () => {
    const uninstall = job.steps!.find((s) => s.name === 'backmesh uninstall')!;
    const runs = (guarded: string) =>
      evaluate(unwrap(uninstall.if!)!.replace('always()', 'true'), {
        'steps.bin.outcome': 'success',
        'steps.guard.outcome': guarded,
        'steps.role-guard.outcome': 'skipped',
        'steps.gcp-guard.outcome': 'skipped',
      });
    expect(runs('failure')).toBe(false);
    expect(runs('success')).toBe(true);
    expect(runs('skipped')).toBe(true);
  });
});

// GCP keeps a deleted workload identity pool's ID for 30 days, so each run's
// role connection gets a pool and service account of its own, through the
// IDs anycloud's setup script reads; its custom role is every run's.
describe("e2e.yml's GCP leg, alone in its project", () => {
  const e2e = read('e2e.yml');
  const job = e2e.jobs['test-org']!;
  const steps = job.steps!;
  const guard = steps.find((s) => s.id === 'gcp-guard')!;

  it('names its role connection for the run', () => {
    expect(job.env).toMatchObject({
      ANYCLOUD_ROLE_POOL:
        'bm-e2e-${{ github.run_id }}-${{ github.run_attempt }}',
      ANYCLOUD_ROLE_SERVICE_ACCOUNT:
        'bm-e2e-${{ github.run_id }}-${{ github.run_attempt }}',
      ANYCLOUD_ROLE_CUSTOM_ROLE: 'backmeshE2e',
    });
  });

  // gcloud's answers: the anycloud- service accounts (JSON), the active
  // pools and the project's policy (JSON).
  const run = (accounts: unknown[], pools: string, policy: unknown) =>
    runStep(guard.run!, {
      env: ROLE_IDS,
      commands: {
        gcloud: `case "$1 $2 $3" in
  "config get-value project") echo p-1 ;;
  "iam service-accounts list") [[ " $* " == *" --filter=email~^anycloud- --format=json "* ]] || exit 7; echo '${JSON.stringify(accounts)}' ;;
  "iam workload-identity-pools list") printf '%s' '${pools}' ;;
  "projects get-iam-policy p-1") echo '${JSON.stringify(policy)}' ;;
  *) exit 8 ;;
esac`,
      },
    });
  const account = (description: string) => ({
    email: 'anycloud-1@p-1.iam.gserviceaccount.com',
    description,
  });

  // anycloud finds a GCP cluster by name in the whole project, by its
  // service account's description, and install would resume it.
  it("fails before install while the project has a backmesh cluster or an earlier run's role connection", () => {
    expect(guard.if).toBe("matrix.cloud == 'gcp'");
    expect(steps.indexOf(guard)).toBeGreaterThan(
      steps.findIndex((s) => s.id === 'gcp'),
    );
    expect(steps.indexOf(guard)).toBeLessThan(
      steps.findIndex((s) => s.id === 'install'),
    );
    const other = account('anycloud_cluster=c-2 anycloud_cluster_name=other');
    const clean = run([other, {}], 'anycloud\n', {
      bindings: [{ role: 'roles/viewer', members: ['user:a@example.com'] }],
    });
    expect(clean.status, clean.stdout + clean.stderr).toBe(0);
    expect(clean.stdout).not.toContain('::error');
    expect(run([], '', {}).status).toBe(0);

    const cluster = run(
      [account('anycloud_cluster=c-1 anycloud_cluster_name=backmesh')],
      '',
      {},
    );
    expect(cluster.status).toBe(1);
    expect(cluster.stdout).toContain(
      'service-account:anycloud-1@p-1.iam.gserviceaccount.com',
    );
    const pool = run([], 'bm-e2e-8-1\n', {});
    expect(pool.status).toBe(1);
    expect(pool.stdout).toContain('pool:bm-e2e-8-1');
    const grant = run([], '', {
      bindings: [
        {
          role: 'projects/p-1/roles/backmeshE2e',
          members: ['serviceAccount:bm-e2e-8-1@p-1.iam.gserviceaccount.com'],
        },
      ],
    });
    expect(grant.status).toBe(1);
    expect(grant.stdout).toContain(
      'binding:projects/p-1/roles/backmeshE2e:serviceAccount:bm-e2e-8-1@p-1.iam.gserviceaccount.com',
    );
  });

  it("doesn't uninstall or delete a role connection after it refuses", () => {
    for (const name of [
      'backmesh uninstall',
      "Delete the role connection's setup",
    ]) {
      const step = steps.find((s) => s.name === name)!;
      const runs = (guarded: string) =>
        evaluate(unwrap(step.if!)!.replace('always()', 'true'), {
          'steps.bin.outcome': 'success',
          'steps.guard.outcome': 'skipped',
          'steps.role-guard.outcome': 'skipped',
          'steps.gcp-guard.outcome': guarded,
        });
      expect(runs('failure'), name).toBe(false);
      expect(runs('success'), name).toBe(true);
    }
  });
});

describe("e2e.yml's GCP sweep", () => {
  const sweep = read('e2e.yml').jobs['test-org']!.steps!.find(
    (s) => s.name === 'Sweep GCP for anything left',
  )!;
  const ID = 'k3x9q2';
  // sweepNames('k3x9q2', 7).
  const ACCOUNT = 'anycloud-ba26a2c1754e69e04996@p-1.iam.gserviceaccount.com';
  const ROLE_ACCOUNT = 'bm-e2e-9-1@p-1.iam.gserviceaccount.com';

  // gcloud's answers, by command; each list is filtered as the step asks
  // (checked), so each answer is what that filter would leave.
  // roleAccount lists until `roleGoneAfter` lists of it, if given; sleep is
  // stubbed, so IAM's lag costs the test no time.
  const run = (
    clusterId: string,
    left: Record<string, string> = {},
    roleGoneAfter?: number,
  ) =>
    runStep(sweep.run!, {
      env: { ...ROLE_IDS, CLUSTER_ID: clusterId, ORG_ID: '7' },
      commands: {
        sleep: 'true',
        gcloud: `filter="name=anycloud-cluster-${ID} OR labels.anycloud_cluster=${ID} OR labels.anycloud_owner_api=e304b862e42fae86c367148fe8147c06"
has() { local want=$1; shift; [[ " $* " == *" $want "* ]]; }
case "$1 $2 $3" in
  "config get-value project") echo p-1 ;;
  "compute instances list") has "--filter=$filter" "$@" || exit 7; printf '%s' '${left.instances ?? ''}' ;;
  "compute disks list") has "--filter=$filter" "$@" || exit 7; printf '%s' '${left.disks ?? ''}' ;;
  "compute firewall-rules list") has "--filter=name~^anycloud-cluster-${ID}-" "$@" || exit 7; printf '%s' '${left.firewalls ?? ''}' ;;
  "storage buckets list") printf '%s' '${left.buckets ?? 'someone-elses\n'}' ;;
  "iam service-accounts list")
    if has --filter=email~^anycloud- "$@"; then echo '${left.named ?? '[]'}'
    elif has "--filter=email~^anycloud-ba26a2c1754e69e04996@" "$@"; then printf '%s' '${left.account ?? ''}'
    elif has "--filter=email~^bm-e2e-9-1@" "$@"; then
      lists=$(dirname "$0")/role-lists; echo x >>"$lists"
      ${roleGoneAfter === undefined ? '' : `(( $(wc -l <"$lists") > ${roleGoneAfter} )) && exit 0`}
      printf '%s' '${left.roleAccount ?? ''}'
    else exit 7; fi ;;
  "iam workload-identity-pools list") printf '%s' '${left.pools ?? 'anycloud\n'}' ;;
  "projects get-iam-policy p-1") echo '${left.policy ?? '{"bindings":[{"role":"roles/viewer","members":["user:a@example.com"]}]}'}' ;;
  *) exit 8 ;;
esac`,
      },
    });

  it('passes when nothing of the run is left', () => {
    for (const id of [ID, '']) {
      const out = run(id);
      expect(out.status, out.stdout + out.stderr).toBe(0);
      expect(out.stdout).not.toContain('::error');
    }
  });

  it("waits for IAM's list to drop the just-deleted role account", () => {
    const out = run(ID, { roleAccount: `${ROLE_ACCOUNT}\n` }, 2);
    expect(out.status, out.stdout + out.stderr).toBe(0);
    expect(out.stdout).not.toContain('::error');
  });

  it('fails naming everything left of the installation and its role connection', () => {
    const out = run(ID, {
      instances: `anycloud-cluster-${ID}\n`,
      disks: 'runner-1\n',
      firewalls: `anycloud-cluster-${ID}-k8s\n`,
      buckets: `someone-elses\n${ID}\n`,
      account: `${ACCOUNT}\n`,
      roleAccount: `${ROLE_ACCOUNT}\n`,
      pools: 'anycloud\nbm-e2e-9-1\n',
      policy: JSON.stringify({
        bindings: [
          {
            role: 'roles/compute.instanceAdmin.v1',
            members: [`deleted:serviceAccount:${ACCOUNT}?uid=1`],
          },
          {
            role: 'projects/p-1/roles/backmeshE2e',
            members: [`serviceAccount:${ROLE_ACCOUNT}`],
          },
        ],
      }),
    });
    expect(out.status).toBe(1);
    expect(out.stdout.match(/^::error.*$/gm)).toEqual(
      [
        `binding:projects/p-1/roles/backmeshE2e:serviceAccount:${ROLE_ACCOUNT}`,
        `binding:roles/compute.instanceAdmin.v1:deleted:serviceAccount:${ACCOUNT}?uid=1`,
        `bucket:${ID}`,
        'disk:runner-1',
        `firewall-rule:anycloud-cluster-${ID}-k8s`,
        `instance:anycloud-cluster-${ID}`,
        'pool:bm-e2e-9-1',
        `service-account:${ACCOUNT}`,
        `service-account:${ROLE_ACCOUNT}`,
      ].map((what) => `::error title=Left in GCP::${what}`),
    );
  });

  it("fails naming the cache buckets by this installation's prefix", () => {
    const cache = /CACHE_PREFIX=(\S+)/.exec(
      spawnSync('node', ['test/e2e/sweep-names.ts'], {
        env: { ...process.env, CLUSTER_ID: ID, ORG_ID: '7' },
        encoding: 'utf8',
      }).stdout,
    )![1]!;
    const out = run(ID, { buckets: `${cache}us-central1\nx${cache}\n` });
    expect(out.stdout.match(/^::error.*$/gm)).toEqual([
      `::error title=Left in GCP::bucket:${cache}us-central1`,
    ]);
  });

  // Without the control plane's ID: its service account, made first and
  // deleted last, which the guard found none of before.
  it("fails naming a backmesh cluster's service account when the run has no control plane ID", () => {
    const out = run('', {
      named: JSON.stringify([
        {
          email: ACCOUNT,
          description: `anycloud_cluster=${ID} anycloud_cluster_name=backmesh`,
        },
        { email: 'anycloud-2@p-1.iam.gserviceaccount.com' },
      ]),
    });
    expect(out.status).toBe(1);
    expect(out.stdout.match(/^::error.*$/gm)).toEqual([
      `::error title=Left in GCP::service-account:${ACCOUNT}`,
    ]);
  });
});

// Nobody can read a running job's annotations or log through GitHub's API,
// so each device code is also a comment on an open issue that GitHub
// notifies the owner of: only the leg, the code, its expiry and the run.
describe("e2e.yml's sign-in codes", () => {
  const e2e = read('e2e.yml');
  const job = e2e.jobs['test-org']!;
  const ISSUE = 'e2e sign-in codes';

  // gh answers `open` to the list, else fails it, and opens issue 42.
  const findIssue = (
    open?: string,
    create = 'echo https://github.com/backmesh/backmesh/issues/42',
  ) => {
    const step = job.steps!.find((s) => s.name === 'The sign-in codes issue')!;
    const dir = mkdtempSync(join(tmpdir(), 'issue-'));
    const env = join(dir, 'env');
    const calls = join(dir, 'calls');
    writeFileSync(env, '');
    expect(step.env!.GH_TOKEN).toBe('${{ github.token }}');
    const out = runStep(step.run!, {
      env: {
        TITLE: step.env!.TITLE!,
        GITHUB_ENV: env,
        GITHUB_REPOSITORY: 'backmesh/backmesh',
      },
      commands: {
        gh: `echo "$*" >>${calls}
case "$2" in
  list) ${open === undefined ? 'exit 1' : `echo '${open}'`} ;;
  create) ${create} ;;
esac`,
      },
    });
    expect(out.status, out.stderr).toBe(0);
    return {
      issue: /^SIGN_IN_ISSUE=(.*)$/m.exec(readFileSync(env, 'utf8'))?.[1],
      calls: readFileSync(calls, 'utf8'),
      stdout: out.stdout,
    };
  };

  // gh's --author finds no app's issue, so every leg opened another
  // (#42-#60): the run's issues are told apart by the author gh's JSON
  // names, and the oldest is the one every run uses.
  it('finds the oldest open issue a run opened by its exact title, else opens it', () => {
    const bot = { login: 'app/github-actions' };
    const found = findIssue(
      JSON.stringify([
        { number: 9, title: ISSUE, author: bot },
        { number: 3, title: `${ISSUE} (old)`, author: bot },
        { number: 2, title: ISSUE, author: { login: 'someone' } },
        { number: 7, title: ISSUE, author: bot },
      ]),
    );
    expect(found.issue).toBe('7');
    expect(found.calls).toMatch(/issue list .*--json number,title,author/);
    expect(found.calls).not.toMatch(/--author/);
    expect(found.calls).not.toMatch(/issue create/);
    const made = findIssue(
      JSON.stringify([
        { number: 3, title: 'other', author: bot },
        { number: 4, title: ISSUE, author: { login: 'someone' } },
      ]),
    );
    expect(made.issue).toBe('42');
    expect(made.calls).toMatch(
      new RegExp(`issue create --repo backmesh/backmesh --title ${ISSUE} `),
    );
  });

  it("warns, and leaves the codes to the annotations, when it can't find or open the issue", () => {
    for (const failed of [findIssue(), findIssue('[]', 'exit 1')]) {
      expect(failed.issue).toBeUndefined();
      expect(failed.stdout).toContain(
        `::warning::Couldn't find or open the "${ISSUE}" issue`,
      );
    }
  });

  // A shared runner's IP soon spends GitHub's 60 anonymous reads an hour,
  // so the binaries read GitHub with the job's token (accepted risk: it
  // writes issues, and they hold the leg's cloud credentials already).
  it("gives the release's binaries the job's token as GH_TOKEN only", () => {
    const step = (name: string) => job.steps!.find((s) => s.name === name)!;
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    mkdirSync(join(home, '.anycloud'));
    writeFileSync(join(home, '.anycloud', 'api-url'), '');
    const env = join(home, 'env');
    writeFileSync(env, '');
    const commands = {
      backmesh: jobToken('backmesh', ''),
      anycloud: jobToken(
        'anycloud',
        `echo '{"url":"https://abc123.anycloud.sh"}'`,
      ),
      curl: '',
      gh: '[[ $GH_TOKEN == t0k ]] && echo 12345',
    };
    const base = {
      HOME: home,
      GITHUB_ENV: env,
      ORG: 'backmesh-dryrun',
      GITHUB_TOKEN: '',
      GH_TOKEN: 't0k',
    };
    for (const name of [
      'backmesh install',
      'The control plane',
      'backmesh uninstall',
    ]) {
      expect(step(name).env!.GH_TOKEN, name).toBe('${{ github.token }}');
      expect(step(name).env!.GITHUB_TOKEN, name).toBeUndefined();
    }
    const plane = runStep(step('The control plane').run!, {
      env: base,
      commands,
    });
    expect(plane.status, plane.stderr).toBe(0);
    expect(readFileSync(env, 'utf8')).toBe('ORG_ID=12345\nCLUSTER_ID=abc123\n');
    for (const name of ['backmesh install', 'backmesh uninstall']) {
      expect(step(name).env!.ISSUE_TOKEN, name).toBe('${{ github.token }}');
    }
    const uninstall = runStep(signedIn(step('backmesh uninstall').run!), {
      env: { ...base, ISSUE_TOKEN: 't0k' },
      commands,
    });
    expect(uninstall.status, uninstall.stderr).toBe(0);
  });

  it('posts each code with its leg, expiry and run, and nothing else from the log', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sign-in-'));
    const calls = join(dir, 'calls');
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'gh'),
      `#!/bin/bash\necho "token=$GH_TOKEN $*" >>${calls}\ncat >>${calls}\necho >>${calls}\n`,
    );
    chmodSync(join(bin, 'gh'), 0o755);
    const command = [
      'echo "secret-ish detail"',
      'echo "child sees ${ISSUE_TOKEN:-no token}"',
      'echo "Sign in with GitHub once, as an owner of backmesh-dryrun: open https://github.com/login/device and enter ABCD-1234 (it expires at 05:45 UTC)."',
      'echo "Sign in with GitHub to approve the control plane: open https://github.com/login/device and enter WXYZ-9876."',
    ].join('; ');
    const out = spawnSync('test/e2e/with-sign-in.sh', ['bash', '-c', command], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        ORG: 'backmesh-dryrun',
        CLOUD: 'azure',
        ISSUE_TOKEN: 't0k',
        SIGN_IN_ISSUE: '7',
        GITHUB_REPOSITORY: 'backmesh/backmesh',
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_RUN_ID: '99',
        GITHUB_STEP_SUMMARY: join(dir, 'summary'),
      },
      encoding: 'utf8',
    });
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toContain('child sees no token');
    const posted = readFileSync(calls, 'utf8');
    const comments = posted.split(/^token=/m).filter(Boolean);
    expect(comments).toHaveLength(2);
    const expiry = String.raw`before \d{2}:\d{2} UTC`;
    expect(comments[0]).toMatch(
      new RegExp(
        String.raw`^t0k issue comment 7 --repo backmesh/backmesh --body-file -\n` +
          String.raw`\*\*azure\*\* leg, \`bash -c\`: enter \`ABCD-1234\` at https://github\.com/login/device ${expiry}\. ` +
          String.raw`Run: https://github\.com/backmesh/backmesh/actions/runs/99\n\n$`,
      ),
    );
    expect(comments[1]).toContain('`WXYZ-9876`');
    expect(posted).not.toMatch(/secret-ish|child sees|Sign in with|approve/);
  }, 20_000);
});

// The test org's runners take jobs only from its own repositories: e2e.yml
// pushes run.json to a run/<nonce> branch of its e2e repository with a
// write deploy key, whose push starts labels.yml there (a copy of it is
// test/e2e/test-org/labels.yml), and reads back the result.json that
// labels.yml pushes to the same branch.
describe("the test org's label run", () => {
  const e2e = read('e2e.yml');
  const labels = () =>
    load(readFileSync('test/e2e/test-org/labels.yml', 'utf8')) as Workflow;

  it('is started by a deploy-key push, with no dispatch token', () => {
    expect(readFileSync(`${DIR}/e2e.yml`, 'utf8')).not.toContain(
      'DISPATCH_TOKEN',
    );
    const step = e2e.jobs['test-org']!.steps!.find(
      (s) => s.name === "The label member on the test org's runners",
    )!;
    expect(step.env!.DEPLOY_KEY).toBe('${{ secrets.E2E_TEST_ORG_DEPLOY_KEY }}');
    expect(step.run).toContain(`trap 'rm -f "$key"' EXIT`);
    expect(step.run).toMatch(
      /GIT_SSH_COMMAND="ssh -i \$key -o IdentitiesOnly=yes" node test\/e2e\/run-test-org-labels\.ts/,
    );
  });

  // GitHub cancels a step by signalling its shell, not the shell's children.
  it("hands a cancel to the run's script, and removes the key only once the script is done", async () => {
    const step = e2e.jobs['test-org']!.steps!.find(
      (s) => s.name === "The label member on the test org's runners",
    )!;
    const dir = mkdtempSync(join(tmpdir(), 'cancel-'));
    const key = join(dir, 'test-org-key');
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    // node: marks itself started, and on SIGINT records whether the key is
    // still there, as the script's branch delete needs it.
    writeFileSync(
      join(bin, 'node'),
      `#!/bin/bash
exec ${process.execPath} -e '
const fs = require("fs");
process.on("SIGINT", () => {
  fs.writeFileSync("${dir}/cleanup", fs.existsSync("${key}") ? "key present" : "key gone");
  process.exit(130);
});
fs.writeFileSync("${dir}/started", String(process.pid));
setInterval(() => {}, 1000);
'
`,
    );
    writeFileSync(join(bin, 'gh'), '#!/bin/bash\n');
    chmodSync(join(bin, 'node'), 0o755);
    chmodSync(join(bin, 'gh'), 0o755);
    const shell = spawn('bash', ['-eo', 'pipefail', '-c', step.run!], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        HOME: dir,
        RUNNER_TEMP: dir,
        DEPLOY_KEY: 'k',
      },
      stdio: 'ignore',
    });
    const exited = new Promise<number | null>((resolve) =>
      shell.on('exit', (code) => resolve(code)),
    );
    while (!existsSync(join(dir, 'started'))) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    shell.kill('SIGINT');
    const code = await Promise.race([
      exited,
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 5000)),
    ]);
    if (code === 'hung') {
      process.kill(
        Number(readFileSync(join(dir, 'started'), 'utf8')),
        'SIGKILL',
      );
      shell.kill('SIGKILL');
    }
    expect(code).not.toBe('hung');
    expect(code).not.toBe(0);
    expect(readFileSync(join(dir, 'cleanup'), 'utf8')).toBe('key present');
    expect(existsSync(key)).toBe(false);
  }, 15_000);

  it("runs on a push to run/** only, and calls e2e-labels.yml with run.json's matrix and ref", () => {
    expect(labels().on).toEqual({ push: { branches: ['run/**'] } });
    expect(labels().permissions).toEqual({});
    // One run at a time: a leg's queued label jobs never reach the next's.
    expect(labels().concurrency).toEqual({
      group: 'labels',
      'cancel-in-progress': true,
    });
    const dir = mkdtempSync(join(tmpdir(), 'run-'));
    const matrix = {
      include: [{ label: 'backmesh-ubuntu-2404-4vcpu', cloud: 'azure' }],
    };
    writeFileSync(
      join(dir, 'run.json'),
      JSON.stringify({ matrix, ref: 'a'.repeat(40), nonce: 'n1' }, null, 2),
    );
    const out = join(dir, 'output');
    writeFileSync(out, '');
    const step = labels().jobs.read!.steps!.find((s) => s.id === 'run')!;
    expect(
      runStep(`cd ${dir}\n${step.run!}`, { env: { GITHUB_OUTPUT: out } })
        .status,
    ).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe(
      `matrix=${JSON.stringify(matrix)}\nref=${'a'.repeat(40)}\n`,
    );
    // Only a commit: run.json's ref is checked out on the test org's runners.
    writeFileSync(
      join(dir, 'run.json'),
      JSON.stringify({ matrix, ref: 'main', nonce: 'n1' }),
    );
    expect(
      runStep(`cd ${dir}\n${step.run!}`, { env: { GITHUB_OUTPUT: out } })
        .status,
    ).not.toBe(0);
    expect(labels().jobs.read!.outputs).toEqual({
      matrix: '${{ steps.run.outputs.matrix }}',
      ref: '${{ steps.run.outputs.ref }}',
    });
    expect(labels().jobs.labels).toMatchObject({
      needs: 'read',
      uses: 'backmesh/backmesh/.github/workflows/e2e-labels.yml@main',
      with: {
        matrix: '${{ needs.read.outputs.matrix }}',
        ref: '${{ needs.read.outputs.ref }}',
      },
    });
  });

  // GitHub names a job by the workflow file that defines it: a reusable
  // workflow from another repository gets the cache read-only.
  it('saves to the cache in labels.yml itself, on its run/<nonce> branch', () => {
    const path = '.github/workflows/labels.yml';
    const own = (jobWorkflowRef: string) =>
      deriveRefs(
        {
          eventName: 'push',
          jobWorkflowRef,
          ownerName: 'backmesh-dryrun',
          repositoryName: 'e2e',
        },
        {
          repoId: 1,
          path,
          headBranch: 'run/n1',
          headRepository: 'backmesh-dryrun/e2e',
          pullRequests: [],
          defaultBranch: 'main',
        },
      ).own;
    expect(own(`backmesh-dryrun/e2e/${path}@refs/heads/run/n1`)).toBe(
      'refs/heads/run/n1',
    );
    const called = labels().jobs.labels!.uses!.replace(/@main$/, '');
    expect(own(`${called}@refs/heads/main`)).toBeUndefined();
    expect(labels().jobs['warm-1']).toBeDefined();
    expect(
      Object.keys(read('e2e-labels.yml').jobs).filter((j) =>
        j.startsWith('warm'),
      ),
    ).toEqual([]);
  });

  it("pushes result.json to the same branch whatever the label jobs did, but doesn't re-create a deleted one", () => {
    const job = labels().jobs.result!;
    expect(job.if).toBe('${{ always() }}');
    expect(job.needs).toEqual([
      'read',
      'labels',
      ...Object.keys(labels().jobs).filter((j) => j.startsWith('warm-')),
    ]);
    expect(job.permissions).toEqual({ contents: 'write' });
    const step = job.steps!.find((s) => s.run?.includes('result.json'))!;
    expect(step.env).toMatchObject({
      CONCLUSION:
        "${{ needs.labels.result != 'success' && needs.labels.result || contains(needs.*.outputs.hit, 'true') && 'success' || contains(needs.*.result, 'cancelled') && 'cancelled' || 'failure' }}",
    });
    const dir = mkdtempSync(join(tmpdir(), 'result-'));
    const out = runStep(`cd ${dir}\n${step.run!}`, {
      env: {
        CONCLUSION: 'failure',
        URL: 'https://github.com/backmesh-dryrun/e2e/actions/runs/7',
        GITHUB_REF: 'refs/heads/run/n1',
        GITHUB_SHA: 'b'.repeat(40),
      },
      commands: { git: `echo "$*" >>${dir}/git.log` },
    });
    expect(out.status).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'))).toEqual({
      conclusion: 'failure',
      url: 'https://github.com/backmesh-dryrun/e2e/actions/runs/7',
    });
    expect(readFileSync(join(dir, 'git.log'), 'utf8')).toMatch(
      new RegExp(
        `^add result\\.json\n.* commit .*\npush --force-with-lease=refs/heads/run/n1:${'b'.repeat(40)} origin HEAD:refs/heads/run/n1\n$`,
      ),
    );
  });
});

// The test org's warm hit: a later job restores what a job saved, which
// its runner uploads after the job. Each region has its own bucket and a
// label's runners land in any of its regions, so the jobs run in turn until
// one lands where an earlier one saved.
describe("labels.yml's cache warm hit", () => {
  const { jobs } = load(
    readFileSync('test/e2e/test-org/labels.yml', 'utf8'),
  ) as Workflow;
  const warm = Object.keys(jobs).filter((j) => j.startsWith('warm-'));
  const steps = jobs['warm-1']!.steps!;
  const named = (prefix: string) =>
    steps.find((s) => s.name?.startsWith(prefix))!;
  const run = (
    step: Step,
    env: Record<string, string>,
    commands: Record<string, string> = {},
  ) => {
    const dir = mkdtempSync(join(tmpdir(), 'warm-'));
    const out = join(dir, 'output');
    const result = runStep(`cd ${dir}\n${step.run!}`, {
      env: { GITHUB_OUTPUT: out, ...env },
      commands: { sleep: 'echo x >>sleeps', ...commands },
    });
    const count = (file: string) =>
      existsSync(join(dir, file))
        ? readFileSync(join(dir, file), 'utf8').split('\n').length - 1
        : 0;
    const output = existsSync(out) ? readFileSync(out, 'utf8') : '';
    return {
      ...result,
      output,
      blob: existsSync(join(dir, 'warm/blob')),
      calls: count('calls'),
      sleeps: count('sleeps'),
    };
  };
  // The token file says `$STATE`, or `pending` for its first `$PENDING` reads.
  const ready = (env: Record<string, string>) =>
    run(named('The cache token'), env, {
      jq: `case $2 in
        .state) echo x >>reads; if (($(wc -l <reads) <= \${PENDING:-0})); then echo pending; else echo "$STATE"; fi ;;
        .bucket) echo b-east ;; *) echo "{}" ;; esac`,
    });
  // The job in `bucket` after jobs that saved to `saved`; the restore writes
  // the blob on its `$HIT`th call.
  const restore = (bucket: string, saved: string[][], hit = 0) =>
    run(
      named('The job restores'),
      {
        BUCKET: bucket,
        HIT: String(hit),
        NEEDS: JSON.stringify({
          read: { outputs: { matrix: '{}' } },
          ...Object.fromEntries(
            saved.map((s, i) => [
              `warm-${i + 1}`,
              { outputs: { saved: JSON.stringify(s) } },
            ]),
          ),
        }),
      },
      {
        node: 'echo x >>calls; if [[ $(wc -l <calls) == "$HIT" ]]; then mkdir -p warm; echo blob >warm/blob; fi',
      },
    );

  it('runs in turn on the same label, one job more than any cloud has regions', () => {
    expect(warm).toHaveLength(
      Math.max(...Object.values(RUNNER_REGIONS.us).map((r) => r.length)) + 1,
    );
    expect(jobs['warm-1']!.needs).toBe('read');
    for (const [i, name] of warm.entries()) {
      const job = jobs[name]!;
      expect(job['runs-on']).toBe(jobs['warm-1']!['runs-on']);
      expect(job.steps).toEqual(steps);
      expect(job.outputs).toEqual({
        saved: '${{ steps.warm.outputs.saved }}',
        hit: '${{ steps.warm.outputs.hit }}',
      });
      if (i === 0) continue;
      expect(job.needs).toEqual(['read', warm[i - 1]]);
      expect(job.if).toBe(`\${{ needs.${warm[i - 1]}.outputs.hit != 'true' }}`);
    }
    // A save keys and restores the same entry, and leaves the runner a plan.
    const save = steps.find((s) => s.uses === './cache/save')!;
    expect(named('The job restores').env!.INPUT_KEY).toBe(save.with!.key);
    expect(named('The job restores').env!.INPUT_PATH).toBe(save.with!.path);
    expect(save.if).toBe("${{ steps.warm.outputs.hit != 'true' }}");
    expect(steps.at(-1)!.if).toBe(save.if);
    expect(steps.at(-1)!.run).toContain('_backmesh-cache/*/plan.json');
  });

  it("waits for a pending token, and fails on one that isn't ready", () => {
    expect(ready({ STATE: 'ready', PENDING: '3' })).toMatchObject({
      status: 0,
      sleeps: 3,
      output: 'bucket=b-east\n',
    });
    expect(ready({ STATE: 'off' }).status).toBe(1);
    expect(ready({ STATE: 'pending' })).toMatchObject({
      status: 1,
      sleeps: 60,
    });
  });

  it('saves in a region no earlier job saved to, adding its bucket', () => {
    expect(restore('b-east', [])).toMatchObject({
      status: 0,
      calls: 0,
      blob: true,
      output: 'saved=["b-east"]\n',
    });
    expect(restore('b-west', [['b-east']])).toMatchObject({
      status: 0,
      calls: 0,
      blob: true,
      output: 'saved=["b-east","b-west"]\n',
    });
  });

  it('restores in a region an earlier job saved to, retrying while the upload lands, and fails without one', () => {
    expect(
      restore('b-east', [['b-east'], ['b-east', 'b-west']], 3),
    ).toMatchObject({
      status: 0,
      calls: 3,
      output: 'hit=true\n',
    });
    const missed = restore('b-east', [['b-east']]);
    expect(missed).toMatchObject({ status: 1, calls: 20, output: '' });
    expect(missed.stdout).toContain('::error::the save never reached b-east');
  });
});
