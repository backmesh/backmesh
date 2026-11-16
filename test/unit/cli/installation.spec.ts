import { describe, expect, it } from 'vitest';

import {
  clusterIdOf,
  installTag,
  listenerName,
  orgOfListener,
  readControlPool,
  readOrgId,
} from '../../../src/cli/installation.js';
import { fakeApi, githubOrg } from './fakes.js';

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
    expect(await readOrgId('Acme', fetch)).toBe(7);
    expect(urls).toEqual(['https://api.github.com/orgs/Acme']);
    await expect(readOrgId('nobody', fetch)).rejects.toThrow(
      'GitHub has no org named nobody.',
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
