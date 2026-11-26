// The spike's loopback WebDAV server for sccache (SCCACHE_WEBDAV_ENDPOINT),
// over the automatic caches' object store: each request re-reads the job's
// token file, a GET reads `<own|base|default>sccache/<path>` in that order,
// and a PUT writes own only. Before the token is ready, or on a read-only
// ref, a GET misses and a PUT is dropped, so rustc just runs.
//
//   node proxy.mjs <port> <stats file>
//
// SIGTERM or SIGINT writes the stats file: requests, hits, bytes, and each
// token change with the requests that succeeded after it.
import { createHash } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';

import type { ReadyFile } from '../../src/cache/format.js';
import { openStore, read, tokenPaths } from '../../src/cache/store.js';

const [port = '4230', statsFile = 'sccache-proxy.json'] = process.argv.slice(2);
const DIR = 'sccache/';
// Not 4226: that's sccache's own server's port.

const stats = {
  started: Date.now(),
  cloud: '',
  gets: 0,
  hits: 0,
  misses: 0,
  bytesRead: 0,
  puts: 0,
  bytesWritten: 0,
  dropped: 0,
  errors: [] as string[],
  // Each distinct credential, by its hash, and the requests that succeeded
  // with it.
  tokens: [] as { at: number; id: string; expiresAt: number; ok: number }[],
};
const log = (o: Record<string, unknown>) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );
// The latest ready file, or undefined while there's none.
async function current(): Promise<ReadyFile | undefined> {
  for (const p of tokenPaths(process.env))
    if (await exists(p)) {
      const f = await read(p).catch(() => undefined);
      return f?.state === 'ready' ? f : undefined;
    }
  return undefined;
}
// The credential a request used, noted when it changes.
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

// This process's writes, by path, with their sizes.
const written = new Map<string, number>();
let used: ReadyFile | undefined;
const store = openStore(async () => {
  used = await current();
  if (!used) throw new Error('no token yet');
  return used;
});
const status = (e: unknown) =>
  Number(/: (\d{3}) /.exec(String((e as Error).message))?.[1] ?? 0);

async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return new Blob(chunks);
}

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url!, 'http://x').pathname)
    .replace(/^\/+/, '')
    .replace(/\.\./g, '');
  const file = await current();
  try {
    if (req.method === 'GET' || req.method === 'HEAD') {
      stats.gets++;
      if (file)
        for (const at of new Set(
          [file.prefixes.own, file.prefixes.base, file.prefixes.default].filter(
            Boolean,
          ),
        ))
          try {
            const r = await store.get(`${at}${DIR}${path}`);
            const data = Buffer.from(await r.arrayBuffer());
            noteToken(used!).ok++;
            stats.hits++;
            stats.bytesRead += data.length;
            res.writeHead(200, { 'content-length': data.length });
            return res.end(req.method === 'HEAD' ? undefined : data);
          } catch (e) {
            // A missing object: 404, or 403 where the token can't list.
            if (status(e) !== 404 && status(e) !== 403) throw e;
            noteToken(used!).ok++;
          }
      stats.misses++;
      res.writeHead(404);
      return res.end();
    }
    if (req.method === 'PUT') {
      const data = await body(req);
      written.set(path, data.size);
      if (!file?.prefixes.own) {
        stats.dropped++;
        res.writeHead(201);
        return res.end();
      }
      await store.put(`${file.prefixes.own}${DIR}${path}`, data);
      noteToken(used!).ok++;
      stats.puts++;
      stats.bytesWritten += data.size;
      res.writeHead(201);
      return res.end();
    }
    // OpenDAL makes each parent directory before a write: an object store
    // has none, so every collection exists.
    if (req.method === 'MKCOL') {
      res.writeHead(201);
      return res.end();
    }
    // OpenDAL also reads a file's metadata back after writing it: the
    // proxy's own writes are the only files it answers for.
    if (req.method === 'PROPFIND') {
      const dir = !path || path.endsWith('/');
      const size = written.get(path);
      if (!dir && size === undefined) {
        res.writeHead(404);
        return res.end();
      }
      const prop = dir
        ? '<D:resourcetype><D:collection/></D:resourcetype>'
        : `<D:resourcetype/><D:getcontentlength>${size}</D:getcontentlength>`;
      res.writeHead(207, { 'content-type': 'application/xml' });
      return res.end(
        `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>/${path}</D:href><D:propstat><D:prop>${prop}<D:getlastmodified>${new Date().toUTCString()}</D:getlastmodified></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`,
      );
    }
    res.writeHead(405);
    res.end();
  } catch (e) {
    const msg = `${req.method} ${path}: ${(e as Error).message}`;
    if (stats.errors.length < 50) stats.errors.push(msg);
    log({ msg: 'error', error: msg });
    // A failed read is a miss; a failed write is dropped.
    if (req.method === 'PUT') stats.dropped++;
    else stats.misses++;
    res.writeHead(req.method === 'PUT' ? 201 : 404);
    res.end();
  }
}).listen(Number(port), '127.0.0.1', () => log({ msg: 'listening', port }));

for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, async () => {
    await writeFile(statsFile, `${JSON.stringify(stats, null, 2)}\n`);
    process.exit(0);
  });
