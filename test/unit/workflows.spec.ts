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

// A fork's pull request must never land on backmesh's own runners, read a
// secret, take an environment or get a token that writes. Its workflow files are its own, so this is
// defense in depth: the guard is the listener, which cancels a fork's run on
// any label but backmesh-public-*.
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
  if?: string;
  run?: string;
  env?: Record<string, string>;
};
type Job = {
  if?: string;
  needs?: string | string[];
  env?: Record<string, string>;
  outputs?: Record<string, string>;
  strategy?: { 'max-parallel'?: number; matrix?: { include?: unknown[] } };
  steps?: Step[];
  'runs-on'?: string;
  uses?: string;
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

// No secret but GITHUB_TOKEN anywhere a job can read one.
const noSecrets = (where: string, value: unknown) =>
  expect(
    JSON.stringify(value ?? null).replaceAll('secrets.GITHUB_TOKEN', ''),
    where,
  ).not.toMatch(/secrets\./);

// The jobs a pull request starts, through local reusable workflows, with the
// runner each lands on.
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
    if (job.uses?.startsWith('./'))
      return started(job.uses.replace(`./${DIR}/`, ''), context);
    // A reusable workflow's own permissions cap what its caller grants.
    const permissions = job.permissions ?? workflow.permissions;
    expect(permissions, where).toBeDefined();
    const writes = Object.values(permissions ?? {}).filter(
      (p) => p !== 'read' && p !== 'none',
    );
    expect(writes, where).toEqual([]);
    const runsOn = job['runs-on'] ?? '';
    const expr = unwrap(runsOn);
    return [
      {
        job: where,
        runsOn: expr === undefined ? runsOn : evaluate(expr, context),
      },
    ];
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
    "run %s's pull request on GitHub's runners only, with no secret, environment or write token",
    (_, context) => {
      const jobs = onPullRequest.flatMap((f) => started(f, context));
      expect(jobs.length).toBeGreaterThan(0);
      for (const { job, runsOn } of jobs)
        expect(runsOn, job).toMatch(/^ubuntu-/);
    },
  );

  it('keep a same-repository pull request on backmesh', () => {
    const jobs = onPullRequest.flatMap((f) => started(f, SAME_REPO));
    for (const { job, runsOn } of jobs) expect(runsOn, job).toBe('backmesh-4');
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

  it('always uninstalls, keeping the App, and always sweeps', () => {
    const steps = e2e.jobs['test-org']!.steps!;
    const step = (name: string) => steps.find((s) => s.name === name)!;
    const uninstall = step('backmesh uninstall');
    const sweep = step('Sweep AWS for anything left');

    expect(uninstall.if).toMatch(/^\$\{\{ always\(\) &&/);
    expect(uninstall.run).toMatch(
      /flags=\(--org "\$ORG" --yes --keep-app --delete-checkpoint-bucket /,
    );
    expect(uninstall.run).toMatch(/backmesh uninstall "\$\{flags\[@\]\}"/);
    expect(sweep.if).toMatch(/^\$\{\{ always\(\) &&/);
    expect(steps.indexOf(sweep)).toBeGreaterThan(steps.indexOf(uninstall));
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
      '--control-plane aws:us-east-2',
    );
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
      runners: [{ cloud: 'azure', regions: ['eastus'] }],
    };
    const matrix = {
      include: [{ label: 'backmesh-4', cloud: 'aws', regions: ['us-east-2'] }],
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
  // is raised: the Azure leg's one job runs on backmesh-2, AWS's on `labels`.
  it("runs the Azure leg's one job on its leg's label, and AWS's labels unchanged", () => {
    const azure = labelMatrix('azure');
    expect(azure.got.include).toEqual([
      expect.objectContaining({
        label: 'backmesh-2',
        cloud: 'azure',
        regions: ['eastus'],
      }),
    ]);
    const aws = labelMatrix('aws');
    expect(aws.got).toEqual(aws.matrix);
  });

  // Our Azure CI app trusts only ci-install's federated subject, so the
  // Azure leg signs in from that environment, reading only its Azure IDs.
  it("signs in to Azure from ci-install's environment and to AWS from e2e's", () => {
    const job = e2e.jobs['test-org']!;
    expect(job.environment).toBe('${{ matrix.environment }}');
    const legs = job.strategy!.matrix!.include as {
      cloud: string;
      environment: string;
    }[];
    expect(legs.map(({ cloud, environment }) => [cloud, environment])).toEqual([
      ['aws', 'e2e'],
      ['azure', 'ci-install'],
    ]);

    const secrets = (text: string) =>
      [...text.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]);
    expect(new Set(secrets(JSON.stringify(job)))).toEqual(
      new Set([
        'AZURE_CLIENT_ID',
        'AZURE_TENANT_ID',
        'AZURE_SUBSCRIPTION_ID',
        'AWS_ROLE_ARN',
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
  // against those listed before the install.
  const run = (before: string, now: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'sweep-'));
    writeFileSync(join(dir, 'groups-before'), before);
    return runStep(sweep.run!, {
      env: { RUNNER_TEMP: dir, CLUSTER_ID: '' },
      commands: { az: `printf '%s' '${now}'` },
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

  it('finds the open issue a run opened by its exact title, else opens it', () => {
    const found = findIssue(
      JSON.stringify([
        { number: 3, title: `${ISSUE} (old)` },
        { number: 7, title: ISSUE },
      ]),
    );
    expect(found.issue).toBe('7');
    expect(found.calls).toMatch(/issue list .*--author app\/github-actions /);
    expect(found.calls).not.toMatch(/issue create/);
    const made = findIssue(JSON.stringify([{ number: 3, title: 'other' }]));
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
    writeFileSync(join(bin, 'curl'), `#!/bin/bash\necho '{"ssh_keys":[]}'\n`);
    chmodSync(join(bin, 'node'), 0o755);
    chmodSync(join(bin, 'curl'), 0o755);
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
    const matrix = { include: [{ label: 'backmesh-4', cloud: 'azure' }] };
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

  it("pushes result.json to the same branch whatever the label jobs did, but doesn't re-create a deleted one", () => {
    const job = labels().jobs.result!;
    expect(job.if).toBe('${{ always() }}');
    expect(job.needs).toEqual(['read', 'labels']);
    expect(job.permissions).toEqual({ contents: 'write' });
    const step = job.steps!.find((s) => s.run?.includes('result.json'))!;
    expect(step.env).toMatchObject({
      CONCLUSION: '${{ needs.labels.result }}',
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
