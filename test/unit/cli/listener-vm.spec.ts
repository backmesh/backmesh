import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { anycloudExec } from '../../../src/anycloud/client.js';
import {
  createListenerVm,
  inListener,
  listenerVmId,
  listListenerVms,
  rollCommand,
  startCommand,
  loggedScaleSetIds,
} from '../../../src/cli/listener-vm.js';
import { fakeApi, fakeBinary } from './fakes.js';
import { fakeExec, listenerVm } from './fakes.js';

// The exec route's answer: newline-delimited events, as the API streams them.
const events = (...lines: object[]) =>
  new Response(lines.map((line) => `${JSON.stringify(line)}\n`).join(''), {
    headers: { 'content-type': 'application/x-ndjson' },
  });
const b64 = (text: string) => Buffer.from(text).toString('base64');

describe('anycloudExec', () => {
  it('posts the command, never in argv, and collects its output and exit code', async () => {
    const sent: { url: string; body: unknown; auth: string | null }[] = [];
    const exec = anycloudExec('https://c1.anycloud.sh', 't0ken', (async (
      url: string,
      init: RequestInit,
    ) => {
      sent.push({
        url,
        body: JSON.parse(String(init.body)),
        auth: new Headers(init.headers).get('authorization'),
      });
      return events(
        { type: 'heartbeat' },
        { type: 'stdout', data: b64('hel') },
        { type: 'stdout', data: b64('lo') },
        { type: 'stderr', data: b64('warn') },
        { type: 'exit', code: 3 },
      );
    }) as unknown as typeof fetch);
    expect(await exec('bml-l8u5e-abc123', 'echo hello')).toEqual({
      code: 3,
      stdout: 'hello',
      stderr: 'warn',
    });
    expect(sent).toEqual([
      {
        url: 'https://c1.anycloud.sh/v1/workloads/bml-l8u5e-abc123/exec',
        body: { command: 'echo hello' },
        auth: 'Bearer t0ken',
      },
    ]);
  });

  it('refreshes a refused token once, and names the API refusal', async () => {
    const bearers: string[] = [];
    const exec = anycloudExec(
      'https://c1.anycloud.sh',
      'old',
      (async (_: string, init: RequestInit) => {
        const bearer = new Headers(init.headers).get('authorization')!;
        bearers.push(bearer);
        if (bearer === 'Bearer old') return new Response('', { status: 401 });
        return Response.json(
          { message: 'Workload or Deployment not found' },
          { status: 404 },
        );
      }) as unknown as typeof fetch,
      async () => 'new',
    );
    await expect(exec('bml-x', 'true')).rejects.toThrow(
      'anycloud exec bml-x failed: Workload or Deployment not found',
    );
    expect(bearers).toEqual(['Bearer old', 'Bearer new']);
  });

  it('keeps a character split across two events whole, and names a stream it can’t read', async () => {
    const euro = Buffer.from('€');
    const exec = (body: string | Response) =>
      anycloudExec('https://c1.anycloud.sh', 't', (async () =>
        typeof body === 'string'
          ? new Response(body)
          : body) as unknown as typeof fetch);
    expect(
      (
        await exec(
          events(
            { type: 'stdout', data: euro.subarray(0, 1).toString('base64') },
            { type: 'stdout', data: euro.subarray(1).toString('base64') },
            { type: 'exit', code: 0 },
          ),
        )('v', 'true')
      ).stdout,
    ).toBe('€');
    await expect(exec('<html>proxy</html>\n')('v', 'true')).rejects.toThrow(
      'anycloud exec v answered with something else.',
    );
  });

  it('names the control plane when the connection drops', async () => {
    // Bun's fetch error, which says nothing of where it went.
    const reset = new Error(
      'ECONNRESET: The socket connection was closed unexpectedly.',
    );
    const exec = (response: () => Promise<Response>) =>
      anycloudExec('https://c1.anycloud.sh', 't', response as typeof fetch);
    await expect(
      exec(() => Promise.reject(reset))('v', 'true'),
    ).rejects.toThrow(
      "anycloud exec v couldn't reach https://c1.anycloud.sh: ECONNRESET: The socket connection was closed unexpectedly.",
    );
    const cut = new Response(
      new ReadableStream({ pull: (controller) => controller.error(reset) }),
    );
    await expect(exec(async () => cut)('v', 'true')).rejects.toThrow(
      "anycloud exec v couldn't reach https://c1.anycloud.sh: ECONNRESET",
    );
  });

  it('fails on an error event or a stream with no exit', async () => {
    const answer = (response: () => Response) =>
      anycloudExec('https://c1.anycloud.sh', 't', (async () =>
        response()) as unknown as typeof fetch);
    await expect(
      answer(() => events({ type: 'error', error: 'host unreachable' }))(
        'v',
        'true',
      ),
    ).rejects.toThrow('anycloud exec v failed: host unreachable');
    await expect(
      answer(() => events({ type: 'stdout', data: b64('x') }))('v', 'true'),
    ).rejects.toThrow('ended without an exit code');
  });
});

describe('listListenerVms', () => {
  it("lists each org's running VM, else its last ended one while its Secret remains", async () => {
    const { api, requests } = fakeApi({
      'GET /v1/workloads': [
        listenerVm('acme', 'bml-l8u5e-old001', { state: 'terminated' }),
        listenerVm('acme', 'bml-l8u5e-abc123'),
        listenerVm('beta', 'bml-q2w3e-lost01', {
          state: 'failed',
          startedAt: 2,
        }),
        listenerVm('beta', 'bml-q2w3e-lost00', {
          state: 'failed',
          startedAt: 1,
        }),
        // Someone terminated it: lost too, while its Secret remains.
        listenerVm('zeta', 'bml-z1z1z-term01', { state: 'terminated' }),
        // Its Secret is gone: uninstalled.
        listenerVm('gone', 'bml-z9z9z-dead01', { state: 'failed' }),
        // Not a listener's ID.
        listenerVm('acme', 'dev-box'),
      ],
      'GET /v1/secrets': [
        { name: 'backmesh-acme' },
        { name: 'backmesh-beta' },
        { name: 'backmesh-zeta' },
      ],
    });
    const vm = (id: string, lost: boolean) => ({
      id,
      name: `backmesh-${{ l: 'acme', q: 'beta', z: 'zeta' }[id[4]!]}`,
      org: { l: 'acme', q: 'beta', z: 'zeta' }[id[4]!],
      cloud: 'aws',
      region: 'us-east-1',
      vmType: 't3.small',
      lost,
      others: [],
    });
    expect(await listListenerVms(api)).toEqual([
      vm('bml-l8u5e-abc123', false),
      vm('bml-q2w3e-lost01', true),
      vm('bml-z1z1z-term01', true),
    ]);
    // Running VMs on their own first, so ended ones can't page them out.
    expect(requests.slice(0, 2)).toEqual([
      'GET /v1/workloads?workloadType=vm&stateClass=terminatable&limit=1000',
      'GET /v1/workloads?workloadType=vm&limit=1000',
    ]);
  });

  it("names an org's other running VMs, and reads no Secrets while every VM runs", async () => {
    const { api, requests } = fakeApi({
      'GET /v1/workloads': [
        listenerVm('acme', 'bml-l8u5e-abc123'),
        listenerVm('acme', 'bml-l8u5e-def456'),
      ],
    });
    expect(await listListenerVms(api)).toMatchObject([
      { id: 'bml-l8u5e-abc123', others: ['bml-l8u5e-def456'] },
    ]);
    expect(requests.some((r) => r.startsWith('GET /v1/secrets'))).toBe(false);
  });

  it('finds a running VM that the newest 1,000 VMs page out', async () => {
    const ended = Array.from({ length: 1000 }, (_, i) =>
      listenerVm('beta', `bml-q2w3e-${String(i).padStart(6, '0')}`, {
        state: 'terminated',
      }),
    );
    const { api } = fakeApi({ 'GET /v1/secrets': [] }, (request) => {
      const { pathname, searchParams } = new URL(request.url);
      if (pathname !== '/v1/workloads') return undefined;
      return Response.json(
        searchParams.get('stateClass')
          ? [listenerVm('acme', 'bml-l8u5e-abc123')]
          : ended,
      );
    });
    expect(await listListenerVms(api)).toMatchObject([
      { id: 'bml-l8u5e-abc123', lost: false },
    ]);
  });
});

describe('the VM commands', () => {
  it('takes a new 16-character ID each time, within anycloud’s 28', () => {
    const id = listenerVmId('l8u5e');
    expect(id).toMatch(/^bml-l8u5e-[a-z0-9]{6}$/);
    expect(listenerVmId('l8u5e')).not.toBe(id);
  });

  // The commands run under a real shell, with a `docker` that records its
  // arguments, so the env file's contents are checked end to end.
  const shell = (command: string, env: Record<string, string> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'bm-vm-'));
    try {
      const bin = join(dir, 'bin');
      execFileSync('mkdir', ['-p', bin]);
      execFileSync('sh', [
        '-c',
        `printf '%s\\n' '#!/bin/sh' 'echo "$*" >> ${dir}/docker.log' > ${bin}/docker; chmod +x ${bin}/docker`,
      ]);
      execFileSync('sh', ['-c', command.replaceAll('/workspace', dir)], {
        env: { PATH: `${bin}:${process.env.PATH}`, ...env },
      });
      return {
        file: readFileSync(join(dir, 'backmesh/listener.env'), 'utf8'),
        docker: readFileSync(join(dir, 'docker.log'), 'utf8')
          .trim()
          .split('\n'),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("starts the listener from the VM's environment, its Secret at create", () => {
    const { file, docker } = shell(startCommand(), {
      ORG: 'acme',
      BACKMESH_LISTENER_IMAGE: 'ghcr.io/backmesh/backmesh-listener@sha256:11',
      ANYCLOUD_API_TOKEN: 'acsvc_1',
      // The Worker's URL, which an rc's e2e sets for staging.
      BACKMESH_API_URL: 'https://api-staging.backmesh.com',
      HOME: '/root',
    });
    expect(file.split('\n').filter(Boolean).sort()).toEqual([
      'ANYCLOUD_API_TOKEN=acsvc_1',
      'BACKMESH_API_URL=https://api-staging.backmesh.com',
      'BACKMESH_LISTENER_IMAGE=ghcr.io/backmesh/backmesh-listener@sha256:11',
      'ORG=acme',
    ]);
    expect(docker).toEqual([
      'pull -q ghcr.io/backmesh/backmesh-listener@sha256:11',
      // SIGTERM, so the old listener deletes its sessions, then removal.
      'stop -t 60 backmesh-listener',
      'rm -f backmesh-listener',
      expect.stringMatching(
        /^run -d --name backmesh-listener --restart=always .*--env-file \S+\/backmesh\/listener\.env ghcr\.io\/backmesh\/backmesh-listener@sha256:11$/,
      ),
    ]);
  });

  it('refuses a value that spans lines, which the env file can’t hold', () => {
    expect(() => rollCommand({ ORG: 'acme', BAD: 'a\nb' })).toThrow(
      "The listener's BAD spans lines.",
    );
  });

  it('writes a roll’s values whole, quotes and all, and restarts on them', () => {
    const runners = JSON.stringify([{ label: "it's", regions: ['a b'] }]);
    const { file, docker } = shell(
      rollCommand({
        ORG: 'acme',
        BACKMESH_RUNNERS: runners,
        BACKMESH_LISTENER_IMAGE: 'img@sha256:22',
      }),
    );
    expect(file).toBe(
      `ORG=acme\nBACKMESH_RUNNERS=${runners}\nBACKMESH_LISTENER_IMAGE=img@sha256:22\n`,
    );
    expect(docker[0]).toBe('pull -q img@sha256:22');
    // The values are base64 in the command, never parsed by a shell.
    expect(rollCommand({ K: 'acsvc_secret' })).not.toContain('acsvc_secret');
  });

  it('keeps the last roll’s env file when the listener starts again', () => {
    const roll = rollCommand({ ORG: 'acme', BACKMESH_LISTENER_IMAGE: 'i@1' });
    const { file } = shell(`${roll}\n${startCommand()}`, {
      ORG: 'stale',
      BACKMESH_LISTENER_IMAGE: 'i@0',
    });
    expect(file).toBe('ORG=acme\nBACKMESH_LISTENER_IMAGE=i@1\n');
  });

  it("runs a script in the listener's container", () => {
    expect(inListener(`console.log('x')`)).toBe(
      `docker exec backmesh-listener node -e 'console.log('\\''x'\\'')'`,
    );
  });

  it('creates the VM with the Secret, then starts the listener', async () => {
    const { run, calls } = fakeBinary({});
    const { exec, calls: execs } = fakeExec(() => '');
    await createListenerVm(
      'acme',
      'bml-l8u5e-abc123',
      {
        cloud: 'gcp',
        region: 'us-east1',
        credentials: 'bm-gcp-000001',
        vmType: 'e2-small',
      },
      { exec, runLong: run },
    );
    expect(calls).toEqual([
      expect.stringMatching(
        /^vm mirror\.gcr\.io\/library\/docker:29-cli@sha256:[0-9a-f]{64} --id bml-l8u5e-abc123 --credentials bm-gcp-000001 --region us-east1 --vm-type e2-small --secret backmesh-acme --wait$/,
      ),
    ]);
    expect(execs).toEqual([['bml-l8u5e-abc123', startCommand()]]);
  });

  it('names a failed start by its last stderr line', async () => {
    const { run } = fakeBinary({});
    const { exec } = fakeExec(() => ({
      code: 1,
      stdout: '',
      stderr: 'pulling\nError: manifest unknown\n',
    }));
    await expect(
      createListenerVm(
        'acme',
        'bml-l8u5e-abc123',
        {
          cloud: 'aws',
          region: 'us-east-1',
          credentials: 'bm-aws',
          vmType: 't3.small',
        },
        { exec, runLong: run },
      ),
    ).rejects.toThrow(
      "acme's listener start on bml-l8u5e-abc123 failed: Error: manifest unknown.",
    );
  });
});

describe('loggedScaleSetIds', () => {
  it("reads each scale set's newest ID from the listener's log", async () => {
    const line = (name: string, scaleSetId: number) =>
      JSON.stringify({ time: 't', msg: 'scale set ready', scaleSetId, name });
    const { exec, calls } = fakeExec(() =>
      [
        line('backmesh-4', 2),
        'not json',
        line('backmesh-4', 9),
        line('backmesh-2', 1),
      ].join('\n'),
    );
    expect(await loggedScaleSetIds(exec, 'bml-x')).toEqual(
      new Map([
        ['backmesh-4', 9],
        ['backmesh-2', 1],
      ]),
    );
    expect(calls[0]?.[1]).toMatch(/^docker logs backmesh-listener /);
  });

  it("fails when the log can't be read", async () => {
    const { exec } = fakeExec(() => ({
      code: 1,
      stdout: '',
      stderr: 'Error: No such container\n',
    }));
    await expect(loggedScaleSetIds(exec, 'bml-x')).rejects.toThrow(
      'No such container',
    );
  });
});
