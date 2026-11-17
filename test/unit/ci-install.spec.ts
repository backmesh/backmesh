import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

type Step = { name?: string; run?: string };
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
}) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-install-'));
  const anycloud = join(dir, 'anycloud');
  writeFileSync(anycloud, `#!/bin/sh\necho "$@" >>"${dir}/calls"\n`);
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
    ['null for the org', '{"anycloud-sh": null}'],
    ['a number for the org', '{"anycloud-sh": 5}'],
  ])('stops when the variable is %s, even for install', (_, URLS) => {
    const r = run({ URLS });
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      "::error::ANYCLOUD_API_URLS isn't a JSON object of org to URL",
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

  it("refuses a URL that isn't a hosted API's", () => {
    const r = run({
      URLS: JSON.stringify({ 'anycloud-sh': 'http://localhost:8080' }),
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("isn't a hosted API URL");
    expect(r.env).toBe('');
  });
});
