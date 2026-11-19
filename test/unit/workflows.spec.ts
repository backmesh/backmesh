import { spawnSync } from 'node:child_process';
import {
  chmodSync,
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
  name?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
};
type Job = {
  if?: string;
  needs?: string | string[];
  env?: Record<string, string>;
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
// ==, !=, !, &&, || (which return an operand, as JavaScript's do), parentheses,
// startsWith and cancelled() (a run not cancelled). Anything else throws, so a new form fails here until added.
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
  return new Function(
    'startsWith',
    'cancelled',
    `'use strict'; return (${expr});`,
  )(startsWith, () => false);
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
  const runs = (job: string, context: Context) => {
    const { if: condition } = release.jobs[job]!;
    return (
      condition === undefined ||
      !!evaluate(unwrap(condition) ?? condition, context)
    );
  };
  const final = { 'needs.check.outputs.rc': 'false' };
  const rc = { 'needs.check.outputs.rc': 'true' };

  it("deploys backmesh-billing with the publish environment's Cloudflare token, as worker-setup.yml does", () => {
    expect(deploys.map(([n]) => n)).toHaveLength(1);
    expect(deploy.environment).toBe('publish');
    const step = deploy.steps!.find((s) => s.run?.includes(SETUP))!;
    const { MODE: _, ...setup } = read(
      'worker-setup.yml',
    ).jobs.setup!.steps!.find((s) =>
      s.run?.includes('worker/scripts/setup.ts'),
    )!.env!;
    expect(step.env).toEqual(setup);
    expect(step.env!.CLOUDFLARE_API_TOKEN).toBe(
      '${{ secrets.CLOUDFLARE_API_TOKEN }}',
    );
  });

  it('deploys on a release, never on an rc', () => {
    expect(runs(name, final)).toBe(true);
    expect(runs(name, rc)).toBe(false);
  });

  it('deploys after the checks and builds, and before anything publishes', () => {
    expect(needs(name)).toEqual(expect.arrayContaining(['check', 'matrix']));
    for (const job of ['release', 'public', 'cache-action', 'homebrew']) {
      expect(needs(job), job).toContain(name);
    }
    // An rc publishes without it; a release whose deploy failed doesn't.
    const after = (result: string, context: Context) =>
      runs('release', {
        ...context,
        'needs.matrix.result': 'success',
        [`needs.${name}.result`]: result,
      });
    expect(after('skipped', rc)).toBe(true);
    expect(after('success', final)).toBe(true);
    expect(after('failure', final)).toBe(false);
  });
});

describe("e2e.yml's production and Azure checks", () => {
  const e2e = read('e2e.yml');

  it("fails unless api.backmesh.com runs the Worker built from the tag's commit", () => {
    const steps = Object.values(e2e.jobs).flatMap((job) => job.steps ?? []);
    const check = steps.find((s) =>
      s.run?.includes('https://api.backmesh.com/v1/version'),
    )!;
    const want = 'a'.repeat(40);
    const run = (answer: string) =>
      runStep(check.run!, {
        env: { VERSION: 'v1.2.3', GITHUB_REPOSITORY: 'backmesh/backmesh' },
        // gh answers the tag's commit, curl what the Worker says.
        commands: { gh: `echo ${want}`, curl: answer },
      });
    expect(run(`echo '{"commit":"${want}"}'`).status).toBe(0);
    const other = run(`echo '{"commit":"${'b'.repeat(40)}"}'`);
    expect(other.status).toBe(1);
    expect(other.stdout).toContain(`not v1.2.3's ${want}`);
    // A Worker without /v1/version, as v0.4.3's: curl -f fails.
    expect(run('exit 22').status).toBe(1);
  });

  it('installs fresh on Azure too, one leg at a time, with no control plane named', () => {
    const job = e2e.jobs['test-org']!;
    expect(job.strategy!['max-parallel']).toBe(1);
    expect(job.strategy!.matrix!.include).toEqual(
      expect.arrayContaining([
        { cloud: 'azure', placement: '--runners azure' },
      ]),
    );
    // Our Azure CI subscription, as ci-install.yml signs in to.
    expect(job.env).toMatchObject({
      AZURE_SUBSCRIPTION_ID: '${{ secrets.AZURE_SUBSCRIPTION_ID }}',
    });
  });

  it('always sweeps Azure, last, for what the run made', () => {
    const steps = e2e.jobs['test-org']!.steps!;
    const sweep = steps.find(
      (s) => s.name === 'Sweep Azure for anything left',
    )!;
    expect(sweep.if).toMatch(/^\$\{\{ always\(\) &&/);
    expect(steps.indexOf(sweep)).toBe(steps.length - 1);
    for (const what of [
      'groups-before',
      'az group exists',
      'anycloud_cluster=$CLUSTER_ID',
      'anycloud_owner_api=$OWNER_API',
      'az ad app list --display-name "$AZURE_APP"',
      '$CACHE_PREFIX',
    ]) {
      expect(sweep.run, what).toContain(what);
    }
  });
});
