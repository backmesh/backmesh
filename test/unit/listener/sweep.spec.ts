import { describe, expect, it } from 'vitest';

import {
  capBytes,
  planSweep,
  sweepBuckets,
  type Listed,
} from '../../../src/listener/sweep.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = 100 * DAY;
const REF = 'cache/7/' + 'a'.repeat(32) + '/';
const OTHER = 'cache/8/' + 'b'.repeat(32) + '/';

// An entry's objects: a manifest and `n` pieces of `size` bytes each.
function entry(
  ref: string,
  id: string,
  at: number,
  size = 1,
  n = 2,
  manifest = true,
  key = 'npm',
): Listed[] {
  const prefix = `${ref}e/${key}/v1/${id}/`;
  return [
    ...Array.from({ length: n }, (_, i) => ({
      key: `${prefix}p0${i}.tar.zst`,
      size,
      modified: at,
    })),
    ...(manifest
      ? [{ key: `${prefix}manifest.json`, size: 0, modified: at }]
      : []),
  ];
}

describe('planSweep', () => {
  it('deletes an entry 7 days after its creation, manifest first', () => {
    const objects = [
      ...entry(REF, 'old-1', NOW - 8 * DAY),
      ...entry(REF, 'new-1', NOW - DAY),
    ];
    expect(planSweep(objects, NOW)).toEqual([
      `${REF}e/npm/v1/old-1/manifest.json`,
      `${REF}e/npm/v1/old-1/p00.tar.zst`,
      `${REF}e/npm/v1/old-1/p01.tar.zst`,
    ]);
  });

  it('deletes leftovers: pieces with no manifest, a manifest with no pieces, unknown objects', () => {
    const objects = [
      { key: `${REF}r/miss-0123456789ab`, size: 0, modified: NOW - 8 * DAY },
      ...entry(REF, 'crashed', NOW - 2 * DAY, 1, 2, false),
      ...entry(REF, 'uploading', NOW - 60_000, 1, 2, false),
      ...entry(REF, 'empty', NOW - DAY, 1, 0),
      { key: 'cache/stray', size: 5, modified: NOW - 2 * DAY },
    ];
    expect(planSweep(objects, NOW).sort()).toEqual(
      [
        `${REF}r/miss-0123456789ab`,
        `${REF}e/npm/v1/crashed/p00.tar.zst`,
        `${REF}e/npm/v1/crashed/p01.tar.zst`,
        `${REF}e/npm/v1/empty/manifest.json`,
        'cache/stray',
      ].sort(),
    );
  });

  it("evicts the oldest past each repository's own cap, never one made in the last hour", () => {
    const objects = [
      ...entry(REF, 'a-1', NOW - 3 * DAY, 30),
      ...entry(REF, 'b-1', NOW - 2 * DAY, 30),
      ...entry(REF, 'c-1', NOW - 30 * 60_000, 30),
      ...entry(OTHER, 'x-1', NOW - 5 * DAY, 20),
    ];
    // Repo 7 holds 180 bytes against a 50-byte cap: a-1 then b-1 go, but
    // c-1, made within the hour, stays though still over it.
    expect(planSweep(objects, NOW, 50)).toEqual([
      `${REF}e/npm/v1/a-1/manifest.json`,
      `${REF}e/npm/v1/a-1/p00.tar.zst`,
      `${REF}e/npm/v1/a-1/p01.tar.zst`,
      `${REF}e/npm/v1/b-1/manifest.json`,
      `${REF}e/npm/v1/b-1/p00.tar.zst`,
      `${REF}e/npm/v1/b-1/p01.tar.zst`,
    ]);
  });

  it("evicts the automatic entries past the cap before an older one of the user's", () => {
    const auto = (id: string, at: number) =>
      entry(REF, id, NOW - at, 30, 2, true, 'bm-auto-npm-x64-s-l');
    const objects = [
      ...entry(REF, 'user-1', NOW - 5 * DAY, 30),
      ...entry(REF, 'job-1', NOW - 6 * DAY, 1, 1, true, 'bm-auto-job-h'),
      ...auto('auto-2', DAY),
      ...entry(REF, 'auto-1', NOW - 2 * DAY, 30, 2, true, 'bm-auto-tool-n'),
    ];
    // 181 bytes against a 70-byte cap: both automatic entries go, oldest
    // first; the user's entry and the older job record stay.
    expect(
      planSweep(objects, NOW, 70).filter((k) => k.endsWith('manifest.json')),
    ).toEqual([
      `${REF}e/bm-auto-tool-n/v1/auto-1/manifest.json`,
      `${REF}e/bm-auto-npm-x64-s-l/v1/auto-2/manifest.json`,
    ]);
  });

  it("evicts other refs' automatic entries before the default branch's, and an older instance within the hour", () => {
    const key = 'bm-auto-yarn-x64-s-l';
    const objects = [
      ...entry(OTHER, 'main-1', NOW - 3 * DAY, 30, 2, true, key),
      ...entry(REF, 'pr-1', NOW - 40 * 60_000, 30, 2, true, key),
      ...entry(REF, 'pr-2', NOW - 20 * 60_000, 30, 2, true, key),
    ];
    // Ref OTHER is the default branch; both are repository 8's here.
    const pr = REF.replace('cache/7/', 'cache/8/');
    const all = objects.map((o) => ({ ...o, key: o.key.replace(REF, pr) }));
    // 180 bytes against a 120-byte cap: pr-1 goes though made within the
    // hour, since pr-2 is newer; pr-2, the newest, and the older default
    // branch line stay.
    expect(
      planSweep(all, NOW, 120, new Set([OTHER])).filter((k) =>
        k.endsWith('manifest.json'),
      ),
    ).toEqual([`${pr}e/${key}/v1/pr-1/manifest.json`]);
  });

  it('deletes an older instance of the same key once the newer one is an hour old', () => {
    const objects = [
      // Upload IDs start with their time, so a later ID is a newer upload,
      // whenever its manifest landed.
      ...entry(REF, '1-old', NOW - 2 * HOUR),
      ...entry(REF, '2-new', NOW - 4 * DAY),
      ...entry(OTHER, '1-old', NOW - 4 * DAY),
      ...entry(OTHER, '2-new', NOW - 30 * 60_000),
    ];
    // The other repository's newer instance is too new to replace its old.
    expect(
      planSweep(objects, NOW).filter((k) => k.endsWith('manifest.json')),
    ).toEqual([`${REF}e/npm/v1/1-old/manifest.json`]);
  });
});

describe('sweepBuckets', () => {
  it('lists every page, deletes the plan, and goes on past a failed bucket', async () => {
    const deleted: string[] = [];
    const logs: Record<string, unknown>[] = [];
    const pages = [
      {
        entries: entry(REF, 'old-1', NOW - 8 * DAY)
          .slice(0, 1)
          .map((o) => ({
            kind: 'object' as const,
            key: o.key,
            sizeBytes: o.size,
            lastModifiedAt: o.modified,
          })),
        nextCursor: 'c2',
      },
      {
        entries: entry(REF, 'old-1', NOW - 8 * DAY)
          .slice(1)
          .map((o) => ({
            kind: 'object' as const,
            key: o.key,
            sizeBytes: o.size,
            lastModifiedAt: o.modified,
          })),
        nextCursor: null,
      },
    ];
    const api = {
      listBucketObjects: async ({
        params,
      }: {
        params: { bucketName: string };
      }) => {
        if (params.bucketName === 'broken') throw new Error('403');
        return pages.shift()!;
      },
      deleteBucketObject: async ({
        query,
      }: {
        query: { remotePath: string };
      }) => void deleted.push(query.remotePath),
    };
    await sweepBuckets(
      api as unknown as Parameters<typeof sweepBuckets>[0],
      [
        { credentialName: 'bm-aws', bucket: 'broken', region: 'us-east-1' },
        {
          credentialName: 'bm-aws',
          bucket: 'bm-cache-abc12-us-east-2',
          region: 'us-east-2',
        },
      ],
      (entry) => logs.push(entry),
      10e9,
      NOW,
    );
    expect(deleted).toHaveLength(3);
    expect(deleted[0]).toMatch(/manifest\.json$/);
    expect(logs.map((l) => l.msg)).toEqual([
      'cache sweep failed',
      'cache swept',
    ]);
  });
});

describe('capBytes', () => {
  it("reads install's --cache-cap, in GB, with 10 GB by default", () => {
    expect(capBytes({ BACKMESH_CACHE_CAP_GB: '2' })).toBe(2e9);
    expect(capBytes({})).toBe(10e9);
  });
});
