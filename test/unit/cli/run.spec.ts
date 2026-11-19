import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { install } from '../../../src/cli/install.js';
import { PlanChanged } from '../../../src/cli/errors.js';
import { realStatus, runCli } from '../../../src/cli/run.js';
import type { StatusReport } from '../../../src/cli/status.js';
import { upgrade } from '../../../src/cli/upgrade.js';
import { fakeHosted, HOSTED } from './fakes.js';

vi.mock('../../../src/cli/install.js', async (original) => {
  const real = await original<typeof import('../../../src/cli/install.js')>();
  return { ...real, install: vi.fn(real.install) };
});
vi.mock('../../../src/cli/upgrade.js', async (original) => {
  const real = await original<typeof import('../../../src/cli/upgrade.js')>();
  return { ...real, upgrade: vi.fn(real.upgrade) };
});

// The control plane's listeners, for `logs`.
const ACME = { name: 'backmesh-acme', vm: 'bml-l8u5e-abc123' };
let listeners: { name: string; vm?: string; deployment?: string }[] = [ACME];

async function run(...argv: string[]) {
  const output = { stdout: '', stderr: '' };
  const streamLogs = vi.fn(async (_args: string[]) => 3);
  // Install's deps without a terminal: no `confirm`, and nothing may run.
  const never = async () => {
    throw new Error('ran');
  };
  const installDeps = vi.fn(() => ({
    // No saved sign-in, git or network for an install without --org.
    env: { BACKMESH_ANYCLOUD_DIR: '/nonexistent/backmesh-run-spec' },
    run: never,
    runLong: never,
    command: never,
    signInLogin: never,
    release: never,
    ui: { print: () => undefined },
  }));
  const code = await runCli(argv, {
    stdout: (text) => (output.stdout += text),
    stderr: (text) => (output.stderr += text),
    env: {},
    isTTY: false,
    installDeps,
    readStatus: async () => {
      throw new Error('no API');
    },
    upgradeDeps: () => ({
      env: {},
      run: never,
      runLong: never,
      release: never,
      status: never,
      print: () => undefined,
    }),
    uninstallDeps: () => ({
      env: {},
      run: never,
      runLong: never,
      command: never,
      ui: { print: () => undefined },
    }),
    streamLogs,
    listeners: async () => listeners,
    cueDeps: () => ({ env: {}, fetch: never, git: never, signIn: never }),
  });
  return { code, installDeps, streamLogs, ...output };
}

describe('backmesh CLI', () => {
  it("streams an org's listener's log, or a runner's by name", async () => {
    // A VM's own log is anycloud's keepalive: the listener's is its
    // container's.
    const listener = await run('logs', '--org', 'Acme');
    expect(listener.streamLogs).toHaveBeenCalledWith([
      'exec',
      'bml-l8u5e-abc123',
      'docker logs --tail 1000 backmesh-listener',
    ]);
    // The stream's exit code is the command's.
    expect(listener.code).toBe(3);
    const runner = await run('logs', 'bm0a1b2-4x-k3j9x0qz', '-f');
    expect(runner.streamLogs).toHaveBeenCalledWith([
      'logs',
      'bm0a1b2-4x-k3j9x0qz',
      '--follow',
    ]);
    // Only a runner's name reaches the control plane.
    const other = await run('logs', 'some-service');
    expect(other.code).toBe(2);
    expect(other.streamLogs).not.toHaveBeenCalled();
    expect(other.stderr).toContain("some-service isn't a runner name");
    // One or the other.
    const both = await run('logs', 'bm0a1b2-4x-k3j9x0qz', '--org', 'acme');
    expect(both.code).toBe(2);
    expect(both.stderr).toContain('not both');
    // Without either, the only listener's, and a usage error with several.
    expect((await run('logs', '-f')).streamLogs).toHaveBeenCalledWith([
      'exec',
      'bml-l8u5e-abc123',
      'docker logs --tail 1000 --follow backmesh-listener',
    ]);
    // One `upgrade` hasn't moved off its Deployment yet.
    listeners = [{ name: 'backmesh-beta', deployment: 'backmesh-beta' }];
    expect((await run('logs')).streamLogs).toHaveBeenCalledWith([
      'logs',
      'backmesh-beta',
    ]);
    // Mid-move, the Deployment still runs.
    listeners = [
      {
        name: 'backmesh-beta',
        vm: 'bml-q2w3e-abc123',
        deployment: 'backmesh-beta',
      },
    ];
    expect((await run('logs')).streamLogs).toHaveBeenCalledWith([
      'logs',
      'backmesh-beta',
    ]);
    listeners = [ACME, { name: 'backmesh-beta', vm: 'bml-q2w3e-abc123' }];
    const several = await run('logs');
    expect(several.code).toBe(2);
    expect(several.stderr).toContain('this control plane runs 2 listeners');
    const none = await run('logs', '--org', 'gamma');
    expect(none.code).toBe(2);
    expect(none.stderr).toContain("There's no listener for gamma");
    listeners = [ACME];
  });

  it('prints the package version', async () => {
    const { version } = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    );
    expect(await run('--version')).toMatchObject({
      code: 0,
      stdout: `${version}\n`,
    });
    expect(JSON.parse((await run('--version', '--json')).stdout)).toEqual({
      version,
    });
  });

  it('never prompts without a terminal: uninstall needs --yes there', async () => {
    const result = await run('uninstall', '--json');
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: { code: 'usage', message: expect.stringContaining('--yes') },
    });
    expect((await run('upgrade', '--to', 'v2')).code).toBe(2);
  });

  it('exits 0 when the upgrade applied, though its status warns', async () => {
    const status: StatusReport = {
      api: {
        url: 'https://c1.anycloud.sh',
        version: '0.2.0',
        missingFeatures: [],
      },
      orgs: [],
      warnings: ['a warning'],
    };
    vi.mocked(upgrade).mockResolvedValueOnce({
      controlPlane: { from: '0.2.0', to: '0.2.0', upgraded: false },
      listeners: [{ org: 'acme', image: 'l', rolled: false }],
      runnerImage: 'r',
      status,
    });
    const result = await run('upgrade', '--json');
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: { warnings: ['a warning'] },
    });
  });

  it('exits 2 on an unknown command or flag', async () => {
    expect((await run('deploy')).code).toBe(2);
    expect((await run('status', '--bogus')).code).toBe(2);
    expect((await run()).code).toBe(2);
    expect(
      (await run('install', '--control-plane', 'aws:us-east-2')).stderr,
    ).toMatch(/--org/);
  });

  it('without --org or a terminal, names the command with --org', async () => {
    vi.mocked(install).mockClear();
    const result = await run('install', '--runners', 'aws', '--json');
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toEqual({
      error: {
        code: 'usage',
        message:
          'Pass --org: install asks which org only at a terminal, without --yes. Run: backmesh install --org <org> --runners aws --json --plan',
      },
    });
    expect(install).not.toHaveBeenCalled();
  });

  it('hands install --org as given, picking no org', async () => {
    vi.mocked(install).mockRejectedValueOnce(new Error('stop'));
    await run('install', '--org', 'Acme', '--plan');
    expect(vi.mocked(install).mock.lastCall![0]).toMatchObject({
      org: 'Acme',
      plan: true,
    });
  });

  it('reports a usage error as JSON with --json', async () => {
    const result = await run('install', '--json');
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: { code: 'usage' },
    });
  });

  it('never prompts without a terminal: install needs --yes there', async () => {
    const result = await run(
      'install',
      '--org',
      'acme',
      '--control-plane',
      'aws:us-east-2',
      '--json',
    );
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: { code: 'usage', message: expect.stringContaining('--yes') },
    });
  });

  it('keeps install’s result when the closing status fails', async () => {
    vi.mocked(install).mockResolvedValueOnce({
      apiUrl: 'https://c1.anycloud.sh',
      org: 'acme',
      install: 'abcde',
      labels: [],
    });
    const result = await run(
      ...[
        'install',
        '--org',
        'acme',
        '--control-plane',
        'aws:us-east-2',
        '--yes',
      ],
      '--json',
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      apiUrl: 'https://c1.anycloud.sh',
      status: { error: 'no API' },
    });
  });

  it('takes --cache-cap as a positive number of GB, and refuses anything else', async () => {
    vi.mocked(install).mockResolvedValueOnce({
      apiUrl: 'https://c1.anycloud.sh',
      org: 'acme',
      install: 'abcde',
      labels: [],
    });
    const args = [
      'install',
      '--org',
      'acme',
      '--control-plane',
      'aws:us-east-2',
      '--yes',
    ];
    await run(...args, '--cache-cap', '2.5');
    expect(vi.mocked(install).mock.lastCall![0]).toMatchObject({
      cacheCapGb: 2.5,
    });
    vi.mocked(install).mockClear();
    for (const bad of ['-5', '0', 'abc', '10GB']) {
      const result = await run(...args, `--cache-cap=${bad}`);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('a positive number of GB');
    }
    expect(install).not.toHaveBeenCalled();
  });

  it('takes no --connect or --device: every sign-in is a GitHub device code', async () => {
    for (const argv of [
      ['install', '--org', 'acme'],
      ['upgrade'],
      ['rotate-key', '--org', 'acme'],
      ['uninstall', '--yes'],
      ['cue', '--sign-in'],
      ['status'],
      ['logs'],
    ]) {
      for (const flag of ['--connect', '--device']) {
        const result = await run(...argv, flag);
        expect(result.code, `${argv[0]} ${flag}`).toBe(2);
      }
    }
  });

  it('hands upgrade its --runners', async () => {
    vi.mocked(upgrade).mockRejectedValueOnce(new Error('stop'));
    await run('upgrade', '--runners', 'aws', '--runners', 'gcp');
    expect(vi.mocked(upgrade).mock.lastCall![1]).toMatchObject({
      runners: ['aws', 'gcp'],
      yes: false,
    });
  });

  it('prints the plan alone, and how to agree to it, for --plan', async () => {
    const plan = {
      planId: 'p-0123456789ab',
      org: 'acme',
      controlPlane: { cloud: 'aws', region: 'us-east-2' },
      runners: [
        { cloud: 'aws', regions: ['us-east-2', 'us-east-1'] },
        { cloud: 'gcp', regions: ['us-east4', 'us-east1'] },
      ],
    };
    vi.mocked(install)
      .mockResolvedValueOnce(plan as never)
      .mockResolvedValueOnce(plan as never);
    const args = [
      'install',
      '--org',
      'acme',
      '--control-plane',
      'aws:us-east-2',
    ];
    const json = await run(...args, '--plan', '--json');
    expect(json.code).toBe(0);
    // Only the plan on stdout: no closing status.
    expect(JSON.parse(json.stdout)).toEqual(plan);
    expect(vi.mocked(install).mock.lastCall![0]).toMatchObject({
      plan: true,
      yes: false,
    });
    const text = await run(...args, '--plan');
    expect(text.stdout).toBe(
      'Plan p-0123456789ab. To create it: backmesh install --org acme --control-plane aws:us-east-2 --runners aws --runners gcp --yes --plan-id p-0123456789ab\n',
    );
  });

  it('names a changed plan in --json, with the usage exit code', async () => {
    vi.mocked(install).mockRejectedValueOnce(
      new PlanChanged('The plan changed since p-0; it is p-1 now.'),
    );
    const result = await run(
      ...['install', '--org', 'acme', '--control-plane', 'aws:us-east-2'],
      ...['--yes', '--plan-id', 'p-0', '--json'],
    );
    expect(vi.mocked(install).mock.lastCall![0]).toMatchObject({
      yes: true,
      planId: 'p-0',
    });
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: { code: 'plan_changed' },
    });
  });

  it("names each cause of a failure, with an API error's status", async () => {
    const refusal = Object.assign(new Error('Input validation failed'), {
      status: 400,
      data: { values: 'secret' },
    });
    vi.mocked(install).mockRejectedValueOnce(
      new Error('Saving the App key failed.', { cause: refusal }),
    );
    const result = await run(
      ...[
        'install',
        '--org',
        'acme',
        '--control-plane',
        'aws:us-east-2',
        '--yes',
      ],
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'Saving the App key failed.\nCaused by: Input validation failed (HTTP 400)',
    );
    expect(result.stderr).not.toContain('secret');
  });

  it("refreshes status's stale hosted API token", async () => {
    const fake = fakeHosted();
    const io = { stdout: () => {}, stderr: () => {}, env: {}, isTTY: false };
    // The fake's `[]` answers aren't a status; only the token matters here.
    await realStatus(io, undefined, fake.run, fake.fetch).catch(
      () => undefined,
    );
    expect(fake.calls.filter((c) => c === `login ${HOSTED}`)).toHaveLength(1);
    expect(fake.bearers.slice(-1)).toEqual(['acapi_new']);
  });
});
