import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

import { GITHUB_APP_ID } from '../../src/cli/worker.js';

type Step = { name?: string; if?: string; run?: string };
const workflow = load(
  readFileSync('.github/workflows/ci-install.yml', 'utf8'),
) as { jobs: { install: { steps: Step[] } } };
const signIn = workflow.jobs.install.steps.find(
  (step) => step.name === "Sign in to the org's control plane",
)?.run;

const URL = 'https://backmesh-1-abcd.anycloud.sh';

// Runs the step as Actions does (bash -eo pipefail), with a stub anycloud
// that records its arguments.
function run(env: {
  URLS?: string;
  ORG?: string;
  MODE?: string;
  FRESH?: string;
  LOGIN_FAILS?: string;
}) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-install-'));
  const anycloud = join(dir, 'anycloud');
  writeFileSync(
    anycloud,
    `#!/bin/sh\necho "$@" >>"${dir}/calls"\n[ -z "$LOGIN_FAILS" ] || { echo 'device code ABCD-1234'; exit 1; }\n`,
  );
  chmodSync(anycloud, 0o755);
  writeFileSync(join(dir, 'env'), '');
  writeFileSync(join(dir, 'calls'), '');
  const result = spawnSync('bash', ['-eo', 'pipefail', '-c', signIn ?? ''], {
    encoding: 'utf8',
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      GITHUB_ENV: join(dir, 'env'),
      ORG: 'anycloud-sh',
      MODE: 'install',
      FRESH: 'false',
      URLS: '',
      ...env,
    },
  });
  return {
    code: result.status,
    out: result.stdout,
    env: readFileSync(join(dir, 'env'), 'utf8'),
    calls: readFileSync(join(dir, 'calls'), 'utf8'),
  };
}

describe("ci-install.yml's sign-in to the org's control plane", () => {
  it('points anycloud at the org named in any case, and signs in to it', () => {
    const r = run({
      URLS: JSON.stringify({ 'AnyCloud-SH': URL }),
      ORG: 'Anycloud-sh',
    });
    expect(r.code).toBe(0);
    expect(r.env).toBe(`API_URL=${URL}\n`);
    expect(r.calls).toBe(`login ${URL}\n`);
  });

  it.each([
    ['unset', ''],
    ['not JSON', 'nope'],
    ['not an object', '[1]'],
    ['two keys for one org', '{"anycloud-sh": "a", "Anycloud-SH": "b"}'],
  ])('stops when the variable is %s, even for install', (_, URLS) => {
    const r = run({ URLS });
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      "::error::ANYCLOUD_API_URLS isn't a JSON object of distinct orgs to URLs",
    );
    expect(r.calls).toBe('');
  });

  it('stops on an org the variable leaves out unless install says fresh', () => {
    const urls = JSON.stringify({ backmesh: URL });
    expect(run({ URLS: urls }).out).toContain(
      'names no control plane for anycloud-sh',
    );
    expect(run({ URLS: urls, MODE: 'diagnose', FRESH: 'true' }).code).toBe(1);
    const fresh = run({ URLS: urls, FRESH: 'true' });
    expect(fresh.code).toBe(0);
    expect(fresh.env).toBe('');
    expect(fresh.calls).toBe('');
  });

  it('refuses fresh for an org that has a control plane', () => {
    const r = run({
      URLS: JSON.stringify({ 'anycloud-sh': URL }),
      FRESH: 'true',
    });
    expect(r.code).toBe(1);
    expect(r.calls).toBe('');
  });

  it.each([
    ['an http URL', 'http://localhost:8080'],
    ['empty', ''],
    ['null', null],
    ['a number', 5],
  ])(
    "refuses an org's value that's %s, and fresh can't skip it",
    (_, value) => {
      const URLS = JSON.stringify({ 'anycloud-sh': value });
      const r = run({ URLS });
      expect(r.code).toBe(1);
      expect(r.out).toContain("isn't a hosted API URL");
      expect(r.env).toBe('');
      expect(run({ URLS, FRESH: 'true' }).code).toBe(1);
    },
  );

  it("stops when the sign-in is refused, showing anycloud's prompt", () => {
    const r = run({
      URLS: JSON.stringify({ 'anycloud-sh': URL }),
      LOGIN_FAILS: '1',
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('device code ABCD-1234');
    expect(r.out).toContain("::error::ANYCLOUD_GITHUB_TOKEN couldn't sign in");
  });
});

describe("ci-install.yml's upgrade plan", () => {
  const steps = workflow.jobs.install.steps;
  const step = (name: string) => steps.find((s) => s.name === name)!;
  const move = step('Move the control plane to the pinned anycloud');

  // Runs `script` as Actions does, with stubs for anycloud, backmesh and
  // curl that record their arguments.
  function runStub(script: string, env: Record<string, string> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'ci-install-'));
    const stub = (name: string, body: string) => {
      writeFileSync(
        join(dir, name),
        `#!/bin/sh\necho "${name} $*" >>"${dir}/calls"\n${body}\n`,
      );
      chmodSync(join(dir, name), 0o755);
    };
    stub('anycloud', `[ "$1 $2" != "api status" ] || echo '{"url":"${URL}"}'`);
    stub('backmesh', `echo '{"planId":"p1"}'`);
    stub('curl', `echo '{"version":"'"$ANYCLOUD_VERSION"'"}'`);
    writeFileSync(join(dir, 'summary'), '');
    writeFileSync(join(dir, 'calls'), '');
    const result = spawnSync('bash', ['-eo', 'pipefail', '-c', script], {
      encoding: 'utf8',
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        RUNNER_TEMP: dir,
        GITHUB_STEP_SUMMARY: join(dir, 'summary'),
        ANYCLOUD_VERSION: '0.1.79',
        CLOUDS: 'aws gcp',
        ...env,
      },
    });
    return {
      code: result.status,
      calls: readFileSync(join(dir, 'calls'), 'utf8'),
      summary: readFileSync(join(dir, 'summary'), 'utf8'),
    };
  }

  // `backmesh upgrade --plan` reads only a control plane on its own
  // anycloud, so the plan moves an older one first, as upgrade would, with
  // backmesh's App in the list of sign-ins it exchanges.
  it('moves the control plane first, accepting sign-ins from the App backmesh embeds', () => {
    expect(move.if).toBe(
      "inputs.mode == 'uninstall' || (inputs.mode == 'upgrade' && inputs.plan)",
    );
    const r = runStub(move.run!, {
      BACKMESH_APP_ID: (
        workflow.jobs.install as unknown as { env: Record<string, string> }
      ).env.BACKMESH_APP_ID!,
    });
    expect(r.code).toBe(0);
    expect(r.calls).toContain(
      `anycloud api upgrade --sign-in-apps ${GITHUB_APP_ID}\n`,
    );
  });

  it('prints the plan and changes no listener', () => {
    const plan = step('backmesh upgrade --plan');
    expect(plan.if).toBe("inputs.mode == 'upgrade' && inputs.plan");
    expect(step('backmesh upgrade').if).toBe(
      "inputs.mode == 'upgrade' && !inputs.plan",
    );
    expect(steps.indexOf(move)).toBeLessThan(steps.indexOf(plan));
    const r = runStub(plan.run!);
    expect(r.code).toBe(0);
    expect(r.calls).toBe(
      'backmesh upgrade --runners aws --runners gcp --plan --json\n',
    );
    expect(r.summary).toContain('{"planId":"p1"}');
  });
});
