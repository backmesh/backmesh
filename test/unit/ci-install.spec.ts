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
