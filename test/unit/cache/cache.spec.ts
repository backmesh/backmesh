import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  truncate,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  entryVersion,
  esc,
  refPrefix,
  unesc,
  type ReadyFile,
} from '../../../src/cache/format.js';
import {
  buildPiece,
  makeParents,
  planPieces,
  restorePiece,
  sh,
  type Member,
} from '../../../src/cache/pieces.js';
import {
  changedSince,
  membersOf,
  snapshot,
  upload,
  writePlan,
  type Plan,
} from '../../../src/cache/snapshot.js';
import {
  findEntry,
  openCache,
  openStore,
  signS3,
  type Store,
} from '../../../src/cache/store.js';
import { memoryStore } from './memory-store.js';

const dirs: string[] = [];
const scratch = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bm-cache-'));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

// The zstd CLI, as the runner image has it: on PATH, or ZSTD_DIR's.
if (process.env.ZSTD_DIR)
  process.env.PATH = `${process.env.ZSTD_DIR}:${process.env.PATH}`;

// A save step's snapshot and its plan, and the members the uploader finds.
async function snap(paths: string[], workspace: string, dir: string) {
  const { roots, at } = await snapshot(paths, dir);
  const plan: Plan = {
    v: 1,
    key: 'k',
    version: 'v1',
    own: 'cache/1/' + '0'.repeat(32) + '/',
    uploadId: 'id1',
    workspace,
    roots,
    at,
    uploader: 'x',
  };
  const cwd = join(dir, 'root', workspace);
  const names = roots.map((r) => relative(workspace, r));
  return { plan, cwd, members: await membersOf(cwd, names) };
}

describe('signS3', () => {
  // AWS's "Example: GET Object" (Signature Version 4, Authenticating
  // Requests: Using the Authorization Header).
  it('matches AWS documentation example signature', () => {
    const headers = signS3(
      'GET',
      new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      { range: 'bytes=0-9' },
      {
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        sessionToken: '',
      },
      'us-east-1',
      new Date('2013-05-24T00:00:00Z'),
      createHash('sha256').update('').digest('hex'),
    );
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });
});

describe('formats', () => {
  it('escapes each byte so prefixes stay prefixes and round-trip', () => {
    for (const key of ['npm-linux-3f2a', 'a/b', '..', 'ключ ü', 'x~y']) {
      expect(unesc(esc(key))).toBe(key);
      expect(esc(key)).toMatch(/^[A-Za-z0-9_~-]+$/);
    }
    expect(esc('a/bc').startsWith(esc('a/b'))).toBe(true);
    expect(esc('..')).not.toContain('.');
  });

  it('hashes a ref to one fixed-length segment', () => {
    expect(refPrefix(42, 'refs/heads/a')).toMatch(
      /^cache\/42\/[0-9a-f]{32}\/$/,
    );
    expect(refPrefix(42, 'refs/heads/a')).not.toBe(
      refPrefix(42, 'refs/heads/a/b'),
    );
  });

  it('versions by paths', () => {
    expect(entryVersion(['a'])).not.toBe(entryVersion(['a', 'b']));
  });
});

describe('planPieces', () => {
  const MiB = 2 ** 20;
  it('splits by file into at most 32 balanced pieces, packed files uncompressed', () => {
    const members: Member[] = [
      { name: 'dir', size: 0, dir: true },
      ...Array.from({ length: 400 }, (_, i) => ({
        name: `f${i}.js`,
        size: 4 * MiB,
      })),
      ...Array.from({ length: 100 }, (_, i) => ({
        name: `b${i}.tar.gz`,
        size: 4 * MiB,
      })),
    ];
    const pieces = planPieces(members);
    expect(pieces.length).toBe(32);
    const raw = pieces.filter((p) => !p.zstd);
    expect(raw.length).toBeGreaterThan(0);
    expect(raw.every((p) => p.members.every((m) => m.endsWith('.gz')))).toBe(
      true,
    );
    expect(
      pieces
        .filter((p) => p.zstd)
        .every((p) => p.members.every((m) => !m.endsWith('.gz'))),
    ).toBe(true);
    expect(pieces[0]!.members[0]).toBe('dir');
    const all = pieces.flatMap((p) => p.members);
    expect(new Set(all).size).toBe(members.length);
    const sizes = pieces.filter((p) => p.zstd).map((p) => p.bytes);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(
      4 * MiB,
    );
  });

  it('uses one piece for a small cache, packed files included', () => {
    const pieces = planPieces([
      { name: 'a', size: 10 },
      { name: 'b.tgz', size: 10 },
    ]);
    expect(pieces).toHaveLength(1);
    expect(pieces[0]!.members.sort()).toEqual(['a', 'b.tgz']);
  });
});

describe('snapshot, pieces and restore', () => {
  it('restores what was snapshotted, even after the files change', async () => {
    const root = await scratch();
    const workspace = join(root, 'work', 'repo', 'repo');
    const home = join(root, 'home', '.npm');
    await mkdir(join(workspace, 'node_modules', 'empty'), { recursive: true });
    await mkdir(home, { recursive: true });
    await writeFile(
      join(workspace, 'node_modules', 'a.js'),
      'a'.repeat(10_000),
    );
    await writeFile(
      join(workspace, 'node_modules', 'blob.tgz'),
      Buffer.alloc(5000, 7),
    );
    await symlink('a.js', join(workspace, 'node_modules', 'link.js'));
    await writeFile(join(home, 'index'), 'outside the workspace');

    const plan = join(root, 'work', '_backmesh-cache', 'id1');
    await mkdir(plan, { recursive: true });
    const {
      plan: saved,
      cwd,
      members,
    } = await snap([join(workspace, 'node_modules'), home], workspace, plan);
    // A later step replaces a file: the snapshot keeps what was saved.
    await rm(join(workspace, 'node_modules', 'a.js'));
    await writeFile(join(workspace, 'node_modules', 'a.js'), 'changed');
    const files = members.filter((m) => !m.dir);
    expect(await changedSince(cwd, files, saved.at)).toBeUndefined();
    // Only the empty directory is a member.
    expect(members.filter((m) => m.dir).map((m) => m.name)).toEqual([
      'node_modules/empty',
    ]);

    const { store } = memoryStore();
    const pieces = planPieces(members);
    const out = join(plan, 'pieces');
    await mkdir(out);
    const prefix = 'cache/1/x/e/k/v/id1/';
    for (const piece of pieces) {
      await buildPiece(piece, join(plan, 'root', workspace), out);
      await store.put(
        prefix + piece.name,
        new Blob([await readFile(join(out, piece.name))]),
      );
    }
    const manifest = pieces;

    await rm(join(root, 'work', 'repo'), { recursive: true });
    await rm(join(root, 'home'), { recursive: true });
    await mkdir(workspace, { recursive: true });
    await Promise.all(
      manifest.map((p) => restorePiece(store, prefix, p, workspace)),
    );

    expect(
      await readFile(join(workspace, 'node_modules', 'a.js'), 'utf8'),
    ).toBe('a'.repeat(10_000));
    expect(
      (await readFile(join(workspace, 'node_modules', 'blob.tgz'))).length,
    ).toBe(5000);
    expect(
      await readFile(join(workspace, 'node_modules', 'link.js'), 'utf8'),
    ).toBe('a'.repeat(10_000));
    expect(await readFile(join(home, 'index'), 'utf8')).toBe(
      'outside the workspace',
    );
    await expect(
      readFile(join(workspace, 'node_modules', 'empty')),
    ).rejects.toThrow(/EISDIR/);
  });

  it("drains what tar leaves unread at the archive's end, and fails a cut piece", async () => {
    const root = await scratch();
    const src = join(root, 'src');
    await mkdir(src);
    await writeFile(join(src, 'f.txt'), 'hello');
    const out = join(root, 'out');
    await mkdir(out);
    const raw = { name: 'p00.tar', zstd: false, members: ['f.txt'], bytes: 5 };
    await buildPiece(raw, src, out);
    // Trailing zeros past the end blocks, which tar never reads: its stdin
    // closes while they're still being written (live run 43278513454).
    const padded = Buffer.concat([
      await readFile(join(out, 'p00.tar')),
      Buffer.alloc(8 * 2 ** 20),
    ]);
    const { store } = memoryStore();
    await store.put('p/p00.tar', new Blob([padded]));
    const dest = join(root, 'dest');
    await mkdir(dest);
    await restorePiece(store, 'p/', raw, dest);
    expect(await readFile(join(dest, 'f.txt'), 'utf8')).toBe('hello');
    await store.put('p/cut.tar', new Blob([padded.subarray(0, 600)]));
    await expect(
      restorePiece(store, 'p/', { name: 'cut.tar', zstd: false }, dest),
    ).rejects.toThrow();
  });

  it('fails a download cut at a record-aligned member header, which tar alone would call complete', async () => {
    const root = await scratch();
    const src = join(root, 'src');
    await mkdir(src);
    // a's header and data end at 10 MiB, a record boundary.
    await writeFile(join(src, 'a.zip'), Buffer.alloc(10 * 2 ** 20 - 512, 1));
    await writeFile(join(src, 'b.zip'), Buffer.alloc(2 ** 20, 2));
    const out = join(root, 'out');
    await mkdir(out);
    const piece = {
      name: 'p00.tar',
      zstd: false,
      members: ['a.zip', 'b.zip'],
      bytes: 0,
    };
    await buildPiece(piece, src, out);
    const head = (await readFile(join(out, 'p00.tar'))).subarray(
      0,
      10 * 2 ** 20,
    );
    // The body ends there with an error, as a dropped connection does.
    const store: Store = {
      list: async () => [],
      put: async () => {},
      get: async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array(head));
            },
            pull(c) {
              return new Promise((_, fail) =>
                setTimeout(() => {
                  c.error(new Error('connection reset'));
                  fail(new Error('connection reset'));
                }, 300),
              );
            },
          }),
        ),
    };
    const dest = join(root, 'dest');
    await mkdir(dest);
    await expect(
      restorePiece(store, 'p/', { name: 'p00.tar', zstd: false }, dest),
    ).rejects.toThrow(/connection reset/);
  });

  it('round-trips a zstd piece through the zstd CLI', async () => {
    const root = await scratch();
    const src = join(root, 'src');
    await mkdir(src);
    await writeFile(join(src, 'a.js'), 'x'.repeat(100_000));
    const out = join(root, 'out');
    await mkdir(out);
    const piece = {
      name: 'p00.tar.zst',
      zstd: true,
      members: ['a.js'],
      bytes: 0,
    };
    await buildPiece(piece, src, out);
    const { store } = memoryStore();
    const body = await readFile(join(out, piece.name));
    expect(body.length).toBeLessThan(10_000);
    await store.put('p/p00.tar.zst', new Blob([body]));
    const dest = join(root, 'dest');
    await mkdir(dest);
    await restorePiece(store, 'p/', piece, dest);
    expect(await readFile(join(dest, 'a.js'), 'utf8')).toBe(
      'x'.repeat(100_000),
    );
    // A corrupt piece fails zstd's checksum.
    body[body.length - 5]! ^= 0xff;
    await store.put('p/bad.tar.zst', new Blob([body]));
    await expect(
      restorePiece(
        store,
        'p/',
        { name: 'bad.tar.zst', zstd: true },
        join(root, 'dest'),
      ),
    ).rejects.toThrow();
  });
});

describe('findEntry', () => {
  const version = entryVersion(['node_modules']);
  const entry = async (
    store: Store,
    prefix: string,
    key: string,
    id: string,
    v = version,
  ) =>
    store.put(
      `${prefix}e/${esc(key)}/${v}/${id}/manifest.json`,
      new Blob(['{}']),
    );

  it("follows GitHub's order: own then base then default; exact, then prefix, then restore keys", async () => {
    const { store } = memoryStore();
    const prefixes = {
      own: 'cache/1/own/',
      base: 'cache/1/base/',
      default: 'cache/1/def/',
    };
    await entry(store, prefixes.default, 'npm-abc', 'd1');
    expect(
      await findEntry(store, prefixes, version, 'npm-abc', []),
    ).toMatchObject({ ref: 'default', key: 'npm-abc' });
    await entry(store, prefixes.base, 'npm-old', 'b1');
    expect(
      await findEntry(store, prefixes, version, 'npm-new', ['npm-']),
    ).toMatchObject({ ref: 'base', key: 'npm-old' });
    await entry(store, prefixes.own, 'npm-new-2', 'o1');
    await entry(store, prefixes.own, 'npm-new-3', 'o2');
    expect(
      await findEntry(store, prefixes, version, 'npm-new', ['npm-']),
    ).toMatchObject({
      ref: 'own',
      key: 'npm-new-3',
      prefix: expect.stringMatching(/\/o2\/$/),
    });
    await entry(store, prefixes.own, 'npm-new', 'o3');
    await entry(store, prefixes.own, 'npm-new-4', 'o4');
    expect(
      await findEntry(store, prefixes, version, 'npm-new', []),
    ).toMatchObject({
      key: 'npm-new',
      prefix: expect.stringMatching(/\/o3\/$/),
    });
  });

  it('skips other versions and entries without a manifest', async () => {
    const { store } = memoryStore();
    const prefixes = { own: 'cache/1/own/' };
    await entry(store, prefixes.own, 'k', 'a', entryVersion(['other']));
    await store.put(
      `cache/1/own/e/k/${version}/b/p00.tar.zst`,
      new Blob(['x']),
    );
    expect(await findEntry(store, prefixes, version, 'k', [])).toBeUndefined();
  });
});

describe('openCache', () => {
  const ready: ReadyFile = {
    v: 1,
    state: 'ready',
    cloud: 'aws',
    bucket: 'bm-cache-abc12-us-east-2',
    region: 'us-east-2',
    prefixes: { own: 'cache/1/x/' },
    tokens: [],
    expiresAt: Date.now() + 15 * 60_000,
  };

  it("falls back with no file, and marks a pending file's timeout for later steps", async () => {
    const temp = await scratch();
    expect(
      await openCache({ RUNNER_TEMP: temp, RUNNER_NAME: 'none' }, 0),
    ).toEqual({
      state: 'off',
      reason: 'no token file',
    });
    await writeFile(
      join(temp, '.backmesh-cache'),
      JSON.stringify({ v: 1, state: 'pending' }),
    );
    expect(await openCache({ RUNNER_TEMP: temp }, 0)).toMatchObject({
      reason: 'no token yet',
    });
    await writeFile(join(temp, '.backmesh-cache'), JSON.stringify(ready));
    expect(await openCache({ RUNNER_TEMP: temp }, 0)).toMatchObject({
      reason: 'no token yet',
    });
  });

  it("reads runner-job's copy in RUNNER_TEMP and waits out a pending file", async () => {
    const temp = await scratch();
    const path = join(temp, '.backmesh-cache');
    await writeFile(path, JSON.stringify({ v: 1, state: 'pending' }));
    setTimeout(() => void writeFile(path, JSON.stringify(ready)), 300);
    const opened = await openCache({ RUNNER_TEMP: temp }, 5_000);
    expect(opened).toMatchObject({
      state: 'ready',
      file: { bucket: ready.bucket },
    });
  });
});

describe('openStore', () => {
  const file = (
    cloud: ReadyFile['cloud'],
    credentials: ReadyFile['tokens'][number]['credentials'],
  ): ReadyFile => ({
    v: 1,
    state: 'ready',
    cloud,
    bucket: 'b',
    region: 'us-east-2',
    accountUrl: 'https://acct.blob.core.windows.net/',
    prefixes: { own: 'cache/1/x/' },
    tokens: [
      {
        prefixes: ['cache/1/x/'],
        expiresAt: Date.now() + 900_000,
        credentials,
      },
    ],
    expiresAt: Date.now() + 900_000,
  });
  const capture = (body: string) => {
    const seen: Request[] = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(new Request(input, init));
      return new Response(body);
    };
    return { seen, fetch: fetch as typeof globalThis.fetch };
  };

  it('lists S3 pages through the continuation token', async () => {
    const pages = [
      '<ListBucketResult><Contents><Key>cache/1/x/a</Key><LastModified>2026-11-12T00:00:00.000Z</LastModified><Size>3</Size></Contents><NextContinuationToken>t2</NextContinuationToken></ListBucketResult>',
      '<ListBucketResult><Contents><Key>cache/1/x/b</Key><LastModified>2026-11-12T00:00:01.000Z</LastModified><Size>4</Size></Contents></ListBucketResult>',
    ];
    const seen: Request[] = [];
    const fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      seen.push(new Request(input, init));
      return new Response(pages.shift());
    }) as typeof globalThis.fetch;
    const f = file('aws', {
      accessKeyId: 'A',
      secretAccessKey: 'S',
      sessionToken: 'T',
    });
    const listed = await openStore(async () => f, fetch).list('cache/1/x/');
    expect(listed).toEqual(['cache/1/x/a', 'cache/1/x/b']);
    expect(new URL(seen[1]!.url).searchParams.get('continuation-token')).toBe(
      't2',
    );
    expect(new URL(seen[0]!.url).host).toBe('b.s3.us-east-2.amazonaws.com');
    expect(seen[0]!.headers.get('x-amz-security-token')).toBe('T');
  });

  it('uses the SAS covering the key on Azure and a bearer token on GCS', async () => {
    const azure = capture(
      '<EnumerationResults><Blobs><Blob><Name>cache/1/x/a</Name><Properties><Last-Modified>Thu, 12 Nov 2026 00:00:00 GMT</Last-Modified><Content-Length>5</Content-Length></Properties></Blob></Blobs><NextMarker /></EnumerationResults>',
    );
    const az = openStore(
      async () => file('azure', { sasToken: 'sv=1&sig=s' }),
      azure.fetch,
    );
    expect(await az.list('cache/1/x/')).toEqual(['cache/1/x/a']);
    expect(new URL(azure.seen[0]!.url).searchParams.get('comp')).toBe('list');
    await az.put('cache/1/x/p', new Blob(['abc']));
    const put = azure.seen[1]!;
    expect(put.url).toBe(
      'https://acct.blob.core.windows.net/b/cache/1/x/p?sv=1&sig=s',
    );
    expect(put.headers.get('x-ms-blob-type')).toBe('BlockBlob');
    await expect(az.get('cache/2/other')).rejects.toThrow(/no token covers/);

    // GCS's XML API answers S3's listing.
    const gcs = capture(
      '<ListBucketResult><Contents><Key>cache/1/x/a</Key></Contents></ListBucketResult>',
    );
    const gs = openStore(
      async () => file('gcp', { accessToken: 'tok' }),
      gcs.fetch,
    );
    expect(await gs.list('cache/1/x/')).toEqual(['cache/1/x/a']);
    const url = new URL(gcs.seen[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://storage.googleapis.com/b',
    );
    expect(url.searchParams.get('list-type')).toBe('2');
    expect(gcs.seen[0]!.headers.get('authorization')).toBe('Bearer tok');
  });
});

describe('changedSince', () => {
  it('finds a file written in place after the snapshot, through its link', async () => {
    const root = await scratch();
    const workspace = join(root, 'w', 'r', 'r');
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'f'), 'one');
    const plan = join(root, 'w', '_backmesh-cache', 'id');
    await mkdir(plan, { recursive: true });
    const {
      plan: saved,
      cwd,
      members,
    } = await snap([join(workspace, 'f')], workspace, plan);
    await new Promise((r) => setTimeout(r, 5));
    await writeFile(join(workspace, 'f'), 'one more', { flag: 'r+' });
    expect(await changedSince(cwd, members, saved.at)).toBe('f');
  });
});

describe('upload', () => {
  async function planned() {
    const root = await scratch();
    const workspace = join(root, 'w', 'r', 'r');
    await mkdir(join(workspace, 'deps'), { recursive: true });
    for (let i = 0; i < 20; i++)
      await writeFile(
        join(workspace, 'deps', `f${i}.js`),
        `f${i}`.repeat(1000),
      );
    const dir = join(root, 'w', '_backmesh-cache', 'id1');
    await mkdir(dir, { recursive: true });
    const { plan } = await snap([join(workspace, 'deps')], workspace, dir);
    const own = plan.own;
    await writePlan(dir, plan);
    return { workspace, dir, own, plan: join(dir, 'plan.json') };
  }

  it('uploads the pieces, then the manifest last', async () => {
    const { own, plan } = await planned();
    const { store, objects } = memoryStore();
    expect(await upload(plan, async () => store)).toBe('saved');
    const keys = [...objects.keys()];
    expect(keys.at(-1)).toBe(`${own}e/${esc('k')}/v1/id1/manifest.json`);
    const manifest = JSON.parse(objects.get(keys.at(-1)!)!.toString());
    expect(manifest).toMatchObject({
      key: 'k',
      bytes: 20 * 2 * 1000 + 10 * 1000,
    });
    expect(keys.slice(0, -1).sort()).toEqual(
      manifest.pieces
        .map((p: { name: string }) => `${own}e/k/v1/id1/${p.name}`)
        .sort(),
    );
  });

  it('writes no manifest when a file changed in place after the snapshot', async () => {
    const { workspace, plan } = await planned();
    const torn = join(workspace, 'deps', 'f3.js');
    await writeFile(torn, 'torn', { flag: 'r+' });
    // Linux stamps mtimes from a coarse clock, so a write just after the
    // snapshot can read as older than it: date the write past it.
    const later = new Date(Date.now() + 1000);
    await utimes(torn, later, later);
    const { store, objects } = memoryStore();
    expect(await upload(plan, async () => store)).toBe('changed');
    expect([...objects.keys()].some((k) => k.endsWith('manifest.json'))).toBe(
      false,
    );
    expect(await upload(plan, async () => 'no token file')).toBe('off');
  });
});

describe('makeParents', () => {
  it("makes every member's directory, outside the workspace too", async () => {
    const root = await scratch();
    const workspace = join(root, 'w', 'r', 'r');
    await makeParents(workspace, [
      'a/b/c.js',
      'a/d.js',
      '../../../home/.npm/x',
      'top.js',
    ]);
    for (const dir of [
      join(workspace, 'a', 'b'),
      join(root, 'home', '.npm'),
      workspace,
    ])
      expect((await lstat(dir)).isDirectory()).toBe(true);
  });
});

describe('sh', () => {
  it('fails on the marker, split across stderr chunks or followed by more output', async () => {
    const split = sh(
      'printf BMF >&2; sleep 0.2; printf AIL >&2',
      ['split'],
      'ignore',
    );
    await expect(split.done).rejects.toThrow(/^split:/);
    // One write, so one chunk: the marker, then more than the 800-byte tail.
    const buried = sh("printf 'BMFAIL\\n%05000d' 0 >&2", ['buried'], 'ignore');
    await expect(buried.done).rejects.toThrow(/^buried:/);
    await expect(
      sh('echo fine >&2', ['ok'], 'ignore').done,
    ).resolves.toBeUndefined();
  });
});

describe('upload, its other ends', () => {
  async function planned(files: Record<string, number>) {
    const root = await scratch();
    const workspace = join(root, 'w', 'r', 'r');
    await mkdir(join(workspace, 'deps'), { recursive: true });
    for (const [name, size] of Object.entries(files)) {
      await writeFile(join(workspace, 'deps', name), '');
      await truncate(join(workspace, 'deps', name), size);
    }
    const dir = join(root, 'w', '_backmesh-cache', 'id1');
    await mkdir(dir, { recursive: true });
    const { plan } = await snap([join(workspace, 'deps')], workspace, dir);
    await writePlan(dir, plan);
    return { workspace, plan: join(dir, 'plan.json') };
  }

  it('saves nothing with a piece over 4.5 GiB, before building any', async () => {
    // Sparse: 5 GiB by size, nothing on disk.
    const { plan } = await planned({ 'huge.bin.gz': 5 * 2 ** 30 });
    const { store, objects } = memoryStore();
    expect(await upload(plan, async () => store)).toBe('too-large');
    expect(objects.size).toBe(0);
  });

  it('writes no manifest when a file is written in place while the pieces are built', async () => {
    const { workspace, plan } = await planned({ 'a.js': 1000, 'b.js': 1000 });
    const { store, objects } = memoryStore();
    const writing: Store = {
      ...store,
      async put(key, body) {
        await new Promise((r) => setTimeout(r, 5));
        await writeFile(join(workspace, 'deps', 'a.js'), 'torn', {
          flag: 'r+',
        });
        await store.put(key, body);
      },
    };
    expect(await upload(plan, async () => writing)).toBe('changed');
    expect(objects.size).toBeGreaterThan(0);
    expect([...objects.keys()].some((k) => k.endsWith('manifest.json'))).toBe(
      false,
    );
  });
});

describe('openStore, at its deadline', () => {
  it('ends a request that never answers', async () => {
    const hang = ((_: unknown, init?: RequestInit) =>
      new Promise((_, fail) =>
        init?.signal?.addEventListener('abort', () =>
          fail(init.signal!.reason),
        ),
      )) as typeof fetch;
    const file: ReadyFile = {
      v: 1,
      state: 'ready',
      cloud: 'gcp',
      bucket: 'b',
      prefixes: { own: 'cache/1/x/' },
      tokens: [
        {
          prefixes: ['cache/1/x/'],
          expiresAt: 0,
          credentials: { accessToken: 't' },
        },
      ],
      expiresAt: 0,
    };
    const store = openStore(async () => file, hang, AbortSignal.timeout(100));
    await expect(store.get('cache/1/x/p00.tar')).rejects.toThrow();
  });
});
