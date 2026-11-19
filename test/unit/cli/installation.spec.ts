import { describe, expect, it } from 'vitest';

import {
  clusterIdOf,
  installTag,
  listenerName,
  orgOfListener,
  readControlPool,
  readInstallation,
  readOrgId,
} from '../../../src/cli/installation.js';
import { fakeApi, githubOrg, listenerVm } from './fakes.js';

describe('the installation’s identity', () => {
  it('takes the cluster ID from the hosted API’s URL', () => {
    expect(clusterIdOf('https://c0ffee-12.anycloud.sh')).toBe('c0ffee-12');
    expect(() => clusterIdOf('http://localhost:8080')).toThrow(
      'has no backmesh installation',
    );
  });

  it('derives a stable 5-character tag from the cluster and the org', () => {
    expect(installTag('c1', 7)).toMatch(/^[a-z0-9]{5}$/);
    expect(installTag('c1', 7)).toBe(installTag('c1', 7));
    expect(installTag('c1', 7)).not.toBe(installTag('c2', 7));
    // Two orgs on one control plane get different sessions.
    expect(installTag('c1', 7)).not.toBe(installTag('c1', 8));
  });

  it("reads an org's numeric ID from GitHub's public org read", async () => {
    const urls: string[] = [];
    const fetch = (async (url: string) => {
      urls.push(url);
      return githubOrg(new URL(url).pathname);
    }) as unknown as typeof globalThis.fetch;
    expect(await readOrgId('Acme', fetch, {})).toBe(7);
    expect(urls).toEqual(['https://api.github.com/orgs/Acme']);
    await expect(readOrgId('nobody', fetch, {})).rejects.toThrow(
      'GitHub has no org named nobody.',
    );
  });

  it('sends GITHUB_TOKEN, else GH_TOKEN, to GitHub when set', async () => {
    const auth: (string | undefined)[] = [];
    const fetch = (async (url: string, init?: RequestInit) => {
      auth.push((init?.headers as Record<string, string>).authorization);
      return githubOrg(new URL(url).pathname);
    }) as unknown as typeof globalThis.fetch;
    await readOrgId('Acme', fetch, { GITHUB_TOKEN: 'ghu_a', GH_TOKEN: 'b' });
    await readOrgId('Acme', fetch, { GH_TOKEN: 'b' });
    await readOrgId('Acme', fetch, {});
    expect(auth).toEqual(['Bearer ghu_a', 'Bearer b', undefined]);
  });

  it('says when GitHub’s rate limit stopped the read', async () => {
    const answer = (
      status: number,
      headers: Record<string, string> = {},
      body = '{}',
    ) =>
      (async () =>
        new Response(body, {
          status,
          headers,
        })) as unknown as typeof globalThis.fetch;
    const primary = { 'x-ratelimit-remaining': '0' };
    await expect(readOrgId('Acme', answer(403, primary), {})).rejects.toThrow(
      "GitHub's API rate limit stopped the read of Acme's ID (HTTP 403). Set GITHUB_TOKEN to raise it, or retry once it resets.",
    );
    await expect(
      readOrgId('Acme', answer(429, primary), { GH_TOKEN: 'b' }),
    ).rejects.toThrow(
      "GitHub's API rate limit stopped the read of Acme's ID (HTTP 429). Retry once it resets.",
    );
    // A secondary limit leaves reads remaining.
    for (const fetch of [
      answer(403, { 'retry-after': '60', 'x-ratelimit-remaining': '4000' }),
      answer(
        403,
        {},
        '{"message":"You have exceeded a secondary rate limit."}',
      ),
    ]) {
      await expect(
        readOrgId('Acme', fetch, { GITHUB_TOKEN: 'ghu_a' }),
      ).rejects.toThrow(
        "GitHub's API rate limit stopped the read of Acme's ID (HTTP 403). Retry once it resets.",
      );
    }
    await expect(readOrgId('Acme', answer(403), {})).rejects.toThrow(
      "GitHub didn't return Acme's ID (HTTP 403).",
    );
  });

  it('retries anonymously once when GitHub rejects the token', async () => {
    for (const status of [401, 403]) {
      const auth: (string | undefined)[] = [];
      const fetch = (async (url: string, init?: RequestInit) => {
        const token = (init?.headers as Record<string, string>).authorization;
        auth.push(token);
        return token
          ? Response.json({ message: 'Bad credentials' }, { status })
          : githubOrg(new URL(url).pathname);
      }) as unknown as typeof globalThis.fetch;
      expect(await readOrgId('Acme', fetch, { GH_TOKEN: 'stale' })).toBe(7);
      expect(auth).toEqual(['Bearer stale', undefined]);
    }
    const limited = (async (_url: string, init?: RequestInit) =>
      (init?.headers as Record<string, string>).authorization
        ? new Response('{}', { status: 401 })
        : new Response('{}', {
            status: 403,
            headers: { 'x-ratelimit-remaining': '0' },
          })) as unknown as typeof globalThis.fetch;
    await expect(
      readOrgId('Acme', limited, { GITHUB_TOKEN: 'stale' }),
    ).rejects.toThrow(
      '(HTTP 403). Replace the GITHUB_TOKEN or GH_TOKEN that GitHub rejected, or retry once it resets.',
    );
  });

  it('names each org’s listener by its lower-cased login', () => {
    expect(listenerName('Acme')).toBe('backmesh-acme');
    expect(orgOfListener('backmesh-acme')).toBe('acme');
    expect(orgOfListener('backmesh')).toBeUndefined();
    expect(orgOfListener('web')).toBeUndefined();
    // Only what a GitHub login can be.
    expect(orgOfListener('backmesh-a-b')).toBe('a-b');
    for (const name of [
      'backmesh--a',
      'backmesh-a-',
      `backmesh-${'a'.repeat(40)}`,
    ]) {
      expect(orgOfListener(name)).toBeUndefined();
    }
  });
});

describe('readControlPool (invariant 3)', () => {
  const pool = (id: string, name: string) => ({
    id,
    name,
    state: 'running',
    allowPrivilegedJobs: false,
  });
  const deployment = (name: string, nodePoolId: string, managed = false) => ({
    id: name,
    name,
    nodePoolId,
    managed,
    deletedAt: null,
  });
  const read = (deployments: object[]) =>
    readControlPool(
      fakeApi({
        'GET /v1/node-pools': {
          nodePools: [pool('p1', 'bm-control'), pool('p2', 'web')],
        },
        'GET /v1/deployments': { deployments },
        'GET /v1/workloads': [],
      }).api,
    );

  it('admits every org’s listener on bm-control and nothing else', async () => {
    const control = await read([
      deployment('backmesh-beta', 'p1'),
      deployment('backmesh-acme', 'p1'),
    ]);
    expect(control.listeners.map((d) => d.name)).toEqual([
      'backmesh-acme',
      'backmesh-beta',
    ]);
    expect(control.problems).toEqual([]);
  });

  it('flags another Deployment there, and a listener elsewhere', async () => {
    const control = await read([
      deployment('backmesh-acme', 'p1'),
      deployment('web', 'p1'),
      deployment('backmesh-beta', 'p1', true),
      deployment('backmesh-gamma', 'p2'),
    ]);
    expect(control.listeners.map((d) => d.name)).toEqual(['backmesh-acme']);
    expect(control.problems).toEqual([
      'A Deployment named backmesh-gamma runs outside bm-control, on node pool p2',
      'bm-control runs more than the listeners: Deployment web, Deployment backmesh-beta (managed)',
    ]);
  });
});

describe('readInstallation', () => {
  it("lists each org's listener on its VM, one still on bm-control, and one mid-move with both", async () => {
    const deployment = (name: string) => ({
      id: `dep-${name}`,
      name,
      nodePoolId: 'p1',
      managed: false,
      deletedAt: null,
    });
    const { api } = fakeApi({
      'GET /v1/node-pools': {
        nodePools: [
          {
            id: 'p1',
            name: 'bm-control',
            state: 'running',
            allowPrivilegedJobs: false,
          },
        ],
      },
      'GET /v1/deployments': {
        deployments: [deployment('backmesh-beta'), deployment('backmesh-zeta')],
      },
      'GET /v1/workloads': [
        listenerVm('acme', 'bml-l8u5e-abc123'),
        listenerVm('acme', 'bml-l8u5e-def456'),
        listenerVm('zeta', 'bml-q2w3e-abc123'),
      ],
    });
    const { orgs, problems } = await readInstallation(api);
    expect(problems).toEqual([
      'acme has more than one listener VM: bml-l8u5e-abc123, bml-l8u5e-def456; two listeners contend for its runner group, so terminate all but one',
    ]);
    expect(
      orgs.map(({ name, vm, deployment }) => [name, vm?.id, deployment?.id]),
    ).toEqual([
      ['backmesh-acme', 'bml-l8u5e-abc123', undefined],
      ['backmesh-beta', undefined, 'dep-backmesh-beta'],
      ['backmesh-zeta', 'bml-q2w3e-abc123', 'dep-backmesh-zeta'],
    ]);
  });
});
