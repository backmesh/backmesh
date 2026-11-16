import { readdirSync, readFileSync } from 'node:fs';
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
type Job = {
  if?: string;
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
// ==, !=, &&, || (which return an operand, as JavaScript's do), parentheses and
// startsWith. Anything else throws, so a new form fails here until added.
function evaluate(expression: string, context: Context): unknown {
  let expr = expression;
  for (const [name, v] of Object.entries(context).sort(
    ([a], [b]) => b.length - a.length,
  )) {
    expr = expr.replaceAll(name, JSON.stringify(v));
  }
  expr = expr.replaceAll('!=', '!==').replace(/([^!=])==/g, '$1===');
  const startsWith = (s: string, prefix: string) => s.startsWith(prefix);
  return new Function('startsWith', `'use strict'; return (${expr});`)(
    startsWith,
  );
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
