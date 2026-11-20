import { ORPCError } from '@orpc/client';
import { describe, expect, it } from 'vitest';

import {
  allowedRegions,
  deleteCacheBuckets,
  ensureCacheBuckets,
} from '../../../src/cli/cache-buckets.js';
import type { Route } from '../../../src/listener/routes.js';
import { ROUTE } from '../listener/fakes.js';

// Each credential's own buckets; `foreign` names ones another account holds,
// which create adopts but the listing never shows.
function fakeApi(
  owned: Record<string, string[]>,
  foreign: string[] = [],
  broken: string[] = [],
) {
  const calls: string[] = [];
  const api = {
    listBuckets: async ({ params }: { params: { credentialName: string } }) => {
      const c = params.credentialName;
      if (broken.includes(c)) throw new Error('refused');
      if (!(c in owned)) throw new ORPCError('NOT_FOUND', { status: 404 });
      return {
        buckets: owned[c]!.map((name) => ({
          name,
          region: null,
          createdAt: null,
        })),
        nextCursor: null,
      };
    },
    createBucket: async ({
      params,
    }: {
      params: { credentialName: string; bucketName: string };
    }) => {
      calls.push(`create ${params.bucketName}`);
      if (!foreign.includes(params.bucketName))
        owned[params.credentialName]!.push(params.bucketName);
    },
    deleteBucket: async ({
      params,
    }: {
      params: { credentialName: string; bucketName: string };
    }) => {
      calls.push(`delete ${params.bucketName}`);
      owned[params.credentialName] = owned[params.credentialName]!.filter(
        (b) => b !== params.bucketName,
      );
    },
    mintStorageTokens: async ({
      body,
    }: {
      body: { grants: { bucket: string }[] };
    }) => {
      calls.push(`mint ${body.grants[0]!.bucket}`);
      return { cloud: 'AWS', region: 'us-east-2', tokens: [] };
    },
  };
  return {
    api: api as unknown as Parameters<typeof ensureCacheBuckets>[0],
    calls,
    owned,
  };
}
const route = (cloud: Route['cloud'], regions: string[]): Route => ({
  ...ROUTE,
  cloud,
  credentials: `bm-${cloud}`,
  regions,
});

describe('cache buckets', () => {
  it('creates and test-mints only missing buckets', async () => {
    const { api, calls } = fakeApi({ 'bm-aws': ['bm-cache-abc12-us-east-2'] });
    const lines: string[] = [];
    await ensureCacheBuckets(
      api,
      'abc12',
      [route('aws', ['us-east-2', 'us-west-2'])],
      (l) => lines.push(l),
    );
    expect(calls).toEqual([
      'create bm-cache-abc12-us-west-2',
      'mint bm-cache-abc12-us-west-2',
    ]);
    expect(lines).toEqual([
      'Created the cache bucket bm-cache-abc12-us-west-2.',
    ]);
  });

  it('refuses a bucket another account holds', async () => {
    const { api } = fakeApi({ 'bm-aws': [] }, ['bm-cache-abc12-us-east-2']);
    await expect(
      ensureCacheBuckets(api, 'abc12', [route('aws', ['us-east-2'])], () => {}),
    ).rejects.toThrow(/bm-cache-abc12-us-east-2 belongs to another account/);
  });

  it('deletes every bucket at uninstall, going on past a cloud it can not read', async () => {
    const { api, owned } = fakeApi(
      {
        'bm-aws': ['bm-cache-abc12-us-east-2'],
        'bm-gcp': ['bm-cache-abc12-us-east1'],
        'bm-azure': [],
      },
      [],
      ['bm-gcp'],
    );
    const lines: string[] = [];
    await deleteCacheBuckets(
      api,
      'abc12',
      new Map([
        ['aws', { connection: 'bm-aws' }],
        ['gcp', { connection: 'bm-gcp' }],
      ] as const),
      (l) => lines.push(l),
    );
    expect(owned['bm-aws']).toEqual([]);
    expect(lines[0]).toBe('Deleted the cache bucket bm-cache-abc12-us-east-2.');
    expect(lines[1]).toMatch(
      /^Couldn't remove the cache buckets through bm-gcp .*bm-cache-abc12-<region> in gcp/,
    );
    // Only the clouds install connected.
    expect(lines).toHaveLength(2);
  });
});

describe('allowedRegions', () => {
  it('skips a region a 403 denies, naming it, and keeps the rest', async () => {
    const { api } = fakeApi({ 'bm-aws': [] });
    api.mintStorageTokens = (async ({
      query,
    }: {
      query: { region: string };
    }) => {
      if (query.region === 'us-west-2')
        throw new ORPCError('FORBIDDEN', { status: 403 });
      return { cloud: 'AWS', region: query.region, tokens: [] };
    }) as typeof api.mintStorageTokens;
    const lines: string[] = [];
    const allowed = await allowedRegions(
      api,
      'abc12',
      'bm-aws',
      ['us-east-2', 'us-west-2'],
      (l) => lines.push(l),
    );
    expect(allowed).toEqual(['us-east-2']);
    expect(lines).toEqual([
      "Skipping us-west-2: your organization's policy denies it, or the credential lacks permission there.",
    ]);
  });

  it('retries once after a transient mint failure, without recreating the bucket or losing the region', async () => {
    const { api, calls } = fakeApi({ 'bm-aws': [] });
    let mints = 0;
    api.mintStorageTokens = (async ({
      body,
    }: {
      body: { grants: { bucket: string }[] };
    }) => {
      calls.push(`mint ${body.grants[0]!.bucket}`);
      if (++mints === 1) throw new Error('503 Service Unavailable');
      return { cloud: 'AWS', region: 'us-east-2', tokens: [] };
    }) as typeof api.mintStorageTokens;
    const allowed = await allowedRegions(
      api,
      'abc12',
      'bm-aws',
      ['us-east-2'],
      () => {},
    );
    expect(allowed).toEqual(['us-east-2']);
    // Created once (not retried): only the mint, which partly failed, redoes.
    expect(calls).toEqual([
      'create bm-cache-abc12-us-east-2',
      'mint bm-cache-abc12-us-east-2',
      'mint bm-cache-abc12-us-east-2',
    ]);
  });

  it('skips and names the region when the retry turns up a 403, not the first try', async () => {
    const { api } = fakeApi({ 'bm-aws': [] });
    let mints = 0;
    api.mintStorageTokens = (async ({
      query,
    }: {
      query: { region: string };
    }) => {
      if (query.region !== 'us-east-2')
        return { cloud: 'AWS', region: query.region, tokens: [] };
      if (++mints === 1) throw new Error('503 Service Unavailable');
      throw new ORPCError('FORBIDDEN', { status: 403 });
    }) as typeof api.mintStorageTokens;
    const lines: string[] = [];
    const allowed = await allowedRegions(
      api,
      'abc12',
      'bm-aws',
      ['us-east-2', 'us-west-2'],
      (l) => lines.push(l),
    );
    expect(allowed).toEqual(['us-west-2']);
    expect(lines).toEqual([
      "Skipping us-east-2: your organization's policy denies it, or the credential lacks permission there.",
    ]);
  });

  it('stops naming the region after a transient failure retries and still fails', async () => {
    const { api } = fakeApi({ 'bm-aws': [] });
    api.mintStorageTokens = (async () => {
      throw new Error('timeout');
    }) as typeof api.mintStorageTokens;
    await expect(
      allowedRegions(api, 'abc12', 'bm-aws', ['us-east-2'], () => {}),
    ).rejects.toThrow(
      "Couldn't check whether bm-aws can use us-east-2: timeout. Run this again.",
    );
  });

  it("doesn't retry, or wrap the message, when the bucket belongs to another account", async () => {
    const { api, calls } = fakeApi({ 'bm-aws': [] }, [
      'bm-cache-abc12-us-east-2',
    ]);
    await expect(
      allowedRegions(api, 'abc12', 'bm-aws', ['us-east-2'], () => {}),
    ).rejects.toThrow(/^The cache bucket .* belongs to another account/);
    expect(calls).toEqual(['create bm-cache-abc12-us-east-2']);
  });

  it('refuses only when every candidate is denied, and checks nothing for an empty list', async () => {
    const api = {
      listBuckets: () => {
        throw new Error("shouldn't be called");
      },
    } as unknown as Parameters<typeof allowedRegions>[0];
    expect(await allowedRegions(api, 'abc12', 'bm-aws', [], () => {})).toEqual(
      [],
    );
    const { api: denyAll } = fakeApi({ 'bm-aws': [] });
    denyAll.mintStorageTokens = (async () => {
      throw new ORPCError('FORBIDDEN', { status: 403 });
    }) as typeof denyAll.mintStorageTokens;
    await expect(
      allowedRegions(denyAll, 'abc12', 'bm-aws', ['us-east-2'], () => {}),
    ).rejects.toThrow(
      "bm-aws isn't allowed to use any of its runner regions (us-east-2). Check its permissions, then run this again.",
    );
  });
});
