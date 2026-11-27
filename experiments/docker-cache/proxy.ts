// The spike's loopback OCI registry for BuildKit's registry cache
// (`--cache-to/--cache-from type=registry,ref=127.0.0.1:4231/<name>:<tag>`),
// over the automatic caches' object store: each request re-reads the job's
// token file, a read looks under `<own|base|default>docker/` in that order,
// and a write goes to own only. Before the token is ready, or on a read-only
// ref, a read misses and a write is accepted and dropped, so the build just
// runs.
//
//   node proxy.mjs <port> <stats file>
//
// Blobs are `docker/blobs/sha256-<hex>`, manifests `docker/manifests/<tag>`
// and `docker/manifests/sha256-<hex>`. Uploads are staged in a file under
// the stats file's directory. SIGTERM or SIGINT writes the stats file.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, openAsBlob } from 'node:fs';
import {
  access,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { pipeline } from 'node:stream/promises';

import type { ReadyFile } from '../../src/cache/format.js';
import {
  openStore,
  read,
  tokenPaths,
  type Store,
} from '../../src/cache/store.js';

const [port = '4231', statsFile = 'docker-cache-proxy.json'] =
  process.argv.slice(2);
const staging = dirname(statsFile);
const DIR = 'docker/';
const MANIFEST_WAIT_MS = 30_000;
const LOOKUP_MS = 20_000;

const stats = {
  started: Date.now(),
  cloud: '',
  // Time a cache import waited for a pending token.
  tokenWaitMs: 0,
  reads: 0,
  hits: 0,
  misses: 0,
  bytesRead: 0,
  writes: 0,
  bytesWritten: 0,
  dropped: 0,
  // Manifests passed over for a missing blob.
  incomplete: 0,
  errors: [] as string[],
  // Each distinct credential, by its hash, and the store requests that
  // succeeded with it.
  tokens: [] as { at: number; id: string; expiresAt: number; ok: number }[],
};
const log = (o: Record<string, unknown>) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );
// The latest ready file, or undefined while there's none. With `waitMs`, a
// pending one is waited for that long.
async function current(waitMs = 0): Promise<ReadyFile | undefined> {
  const start = Date.now();
  for (;;) {
    let f;
    for (const p of tokenPaths(process.env))
      if (!f && (await exists(p))) f = await read(p).catch(() => undefined);
    if (f?.state !== 'pending' || Date.now() - start >= waitMs) {
      stats.tokenWaitMs += Date.now() - start;
      return f?.state === 'ready' ? f : undefined;
    }
    await sleep(500);
  }
}
function noteToken(file: ReadyFile) {
  const id = createHash('sha256')
    .update(JSON.stringify(file.tokens.map((t) => t.credentials)))
    .digest('hex')
    .slice(0, 12);
  let t = stats.tokens.at(-1);
  if (t?.id !== id) {
    t = { at: Date.now(), id, expiresAt: file.expiresAt, ok: 0 };
    stats.tokens.push(t);
    stats.cloud = file.cloud;
    log({ msg: 'token', id, expiresAt: new Date(file.expiresAt) });
  }
  return t;
}

let used: ReadyFile | undefined;
const tokens = async () => {
  used = await current();
  if (!used) throw new Error('no token yet');
  return used;
};
// A local directory in place of the bucket, to try the proxy without a
// cloud: DOCKER_CACHE_LOCAL_STORE=<dir>, with any ready token file.
const local = process.env.DOCKER_CACHE_LOCAL_STORE;
const store: Store = local
  ? {
      async list(prefix) {
        await tokens();
        const dir = join(local, prefix);
        if (!(await exists(dir))) return [];
        return (await readdir(dir)).map((f) => `${prefix}${f}`);
      },
      async get(k) {
        await tokens();
        if (!(await exists(join(local, k)))) throw new Error(`GET ${k}: 404 `);
        return new Response(await readFile(join(local, k)));
      },
      async put(k, body) {
        await tokens();
        await mkdir(dirname(join(local, k)), { recursive: true });
        await writeFile(join(local, k), Buffer.from(await body.arrayBuffer()));
      },
    }
  : openStore(tokens);
const status = (e: unknown) =>
  Number(/: (\d{3}) /.exec(String((e as Error).message))?.[1] ?? 0);
const key = (ref: string) => ref.replace(':', '-');

// Own, then base, then default; own alone for `own`.
const refs = (file: ReadyFile | undefined, own = false) =>
  file
    ? [
        ...new Set(
          (own
            ? [file.prefixes.own]
            : [file.prefixes.own, file.prefixes.base, file.prefixes.default]
          ).filter((p): p is string => !!p),
        ),
      ]
    : [];
// The object under the first of `at` that has it, or undefined.
async function find(at: string[], name: string) {
  for (const ref of at)
    try {
      const res = await store.get(`${ref}${DIR}${name}`);
      noteToken(used!).ok++;
      return res;
    } catch (e) {
      // A missing object: 404, or 403 where the token can't list.
      if (status(e) !== 404 && status(e) !== 403) throw e;
      noteToken(used!).ok++;
    }
  return undefined;
}
// BuildKit waits on a registry that doesn't answer, so a lookup that takes
// longer than this is a miss.
const within = <T>(ms: number, p: Promise<T>) =>
  Promise.race([p, sleep(ms).then(() => undefined)]);
// The first ref's manifest whose blobs are all there: BuildKit fails the
// build when an imported manifest's blob is missing, as one swept before its
// manifest would be.
async function findManifest(at: string[], name: string) {
  for (const ref of at) {
    const res = await find([ref], name);
    if (!res) continue;
    const body = Buffer.from(await res.arrayBuffer());
    const m = JSON.parse(body.toString()) as {
      mediaType?: string;
      config?: { digest: string };
      layers?: { digest: string }[];
    };
    const blobs = new Set(await store.list(`${ref}${DIR}blobs/`));
    const missing = [m.config, ...(m.layers ?? [])].filter(
      (d) => !d || !blobs.has(`${ref}${DIR}blobs/${key(d.digest)}`),
    ).length;
    if (!missing) return { body, type: m.mediaType };
    stats.incomplete++;
    log({ msg: 'incomplete manifest', ref, missing });
  }
  return undefined;
}
// Written under own, or dropped without one.
async function save(file: ReadyFile | undefined, name: string, body: Blob) {
  if (!file?.prefixes.own) return void stats.dropped++;
  await store.put(`${file.prefixes.own}${DIR}${name}`, body);
  noteToken(used!).ok++;
  stats.writes++;
  stats.bytesWritten += body.size;
}

// Upload sessions: their staged file.
const uploads = new Map<string, string>();
const BLOB = /^\/v2\/(.+)\/blobs\/(sha256:[0-9a-f]{64})$/;
const UPLOAD = /^\/v2\/(.+)\/blobs\/uploads\/([^/]*)$/;
const MANIFEST = /^\/v2\/(.+)\/manifests\/([^/]+)$/;

createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://x');
  const path = url.pathname;
  const file = await current();
  let m: RegExpExecArray | null;
  try {
    if (path === '/v2/' || path === '/v2') {
      res.writeHead(200, { 'docker-distribution-api-version': 'registry/2.0' });
      return res.end();
    }
    if (
      (m = BLOB.exec(path)) &&
      (req.method === 'GET' || req.method === 'HEAD')
    ) {
      stats.reads++;
      // An export's HEAD before its upload counts own's copy only, so own's
      // manifests never need another ref's blobs.
      const found = await within(
        LOOKUP_MS,
        find(refs(file, req.method === 'HEAD'), `blobs/${key(m[2]!)}`),
      );
      if (!found) {
        stats.misses++;
        res.writeHead(404);
        return res.end();
      }
      stats.hits++;
      const size = found.headers.get('content-length');
      res.writeHead(200, {
        'docker-content-digest': m[2]!,
        'content-type': 'application/octet-stream',
        ...(size && { 'content-length': size }),
      });
      if (req.method === 'HEAD') {
        await found.body?.cancel();
        return res.end();
      }
      stats.bytesRead += Number(size ?? 0);
      return await pipeline(Readable.fromWeb(found.body as never), res);
    }
    if ((m = UPLOAD.exec(path))) {
      const name = m[1]!;
      let id = m[2]!;
      if (req.method === 'POST' && !id) {
        id = randomUUID();
        uploads.set(id, join(staging, `upload-${id}`));
        await writeFile(uploads.get(id)!, '');
      }
      const staged = uploads.get(id);
      if (!staged) {
        res.writeHead(404);
        return res.end();
      }
      await pipeline(req, createWriteStream(staged, { flags: 'a' }));
      const digest = url.searchParams.get('digest');
      if (req.method === 'PUT' || (req.method === 'POST' && digest)) {
        uploads.delete(id);
        const hash = createHash('sha256');
        await pipeline(createReadStream(staged), hash);
        if (`sha256:${hash.digest('hex')}` !== digest) {
          await rm(staged, { force: true });
          res.writeHead(400);
          return res.end();
        }
        await save(file, `blobs/${key(digest)}`, await openAsBlob(staged));
        await rm(staged, { force: true });
        res.writeHead(201, {
          location: `/v2/${name}/blobs/${digest}`,
          'docker-content-digest': digest,
        });
        return res.end();
      }
      const { size } = await stat(staged);
      res.writeHead(202, {
        location: `/v2/${name}/blobs/uploads/${id}`,
        'docker-upload-uuid': id,
        range: `0-${Math.max(size - 1, 0)}`,
      });
      return res.end();
    }
    if ((m = MANIFEST.exec(path))) {
      const ref = m[2]!;
      if (req.method === 'PUT') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = Buffer.concat(chunks);
        const digest = `sha256:${createHash('sha256').update(body).digest('hex')}`;
        // By tag for the next build's import, by digest for the index's own
        // reads.
        for (const at of new Set([ref, digest]))
          await save(file, `manifests/${key(at)}`, new Blob([body]));
        res.writeHead(201, {
          location: `/v2/${m[1]}/manifests/${digest}`,
          'docker-content-digest': digest,
        });
        return res.end();
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        stats.reads++;
        // A build's import reads its manifest first, once: a miss there
        // makes the whole build cold, so it waits for a pending token.
        const ready = file ?? (await current(MANIFEST_WAIT_MS));
        const found = await within(
          LOOKUP_MS,
          findManifest(refs(ready), `manifests/${key(ref)}`),
        );
        if (!found) {
          stats.misses++;
          res.writeHead(404);
          return res.end();
        }
        stats.hits++;
        const { body } = found;
        stats.bytesRead += body.length;
        const type = found.type ?? 'application/vnd.oci.image.index.v1+json';
        res.writeHead(200, {
          'content-type': type,
          'content-length': body.length,
          'docker-content-digest': `sha256:${createHash('sha256').update(body).digest('hex')}`,
        });
        return res.end(req.method === 'HEAD' ? undefined : body);
      }
    }
    res.writeHead(405);
    res.end();
  } catch (e) {
    const msg = `${req.method} ${path}: ${(e as Error).message}`;
    if (stats.errors.length < 50) stats.errors.push(msg);
    log({ msg: 'error', error: msg });
    // A failed read is a miss; a failed write fails, and BuildKit's
    // `ignore-error=true` carries on.
    if (req.method === 'GET' || req.method === 'HEAD') stats.misses++;
    if (!res.headersSent)
      res.writeHead(req.method === 'HEAD' || req.method === 'GET' ? 404 : 500);
    res.end();
  }
}).listen(Number(port), '127.0.0.1', () => log({ msg: 'listening', port }));

for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, async () => {
    await writeFile(statsFile, `${JSON.stringify(stats, null, 2)}\n`);
    process.exit(0);
  });
