// The cache's daily sweep, through the
// API with the install's own connection, so no job holds a delete right:
// entries 7 days after their creation, the oldest past each repository's cap,
// and leftovers. Nothing is read but the listing.
import type { AnycloudApi } from '../anycloud/client.js';
import { AUTO_PREFIX, AUTO_RECORD, bucketName } from '../cache/format.js';
import type { Log } from '../github/retry.js';
import type { Route } from './routes.js';

const DAY = 24 * 3_600_000;
// Each repository's cache per bucket: 10 GB unless install set it.
export const CACHE_CAP_ENV = 'BACKMESH_CACHE_CAP_GB';
export const capBytes = (env: NodeJS.ProcessEnv) => {
  const gb = Number(env[CACHE_CAP_ENV]);
  return (gb > 0 ? gb : 10) * 1e9;
};

export interface Listed {
  key: string;
  size: number;
  modified: number;
}

// `cache/<repo>/<ref>/e/<key>/<version>/<upload-id>/<object>`.
const ENTRY =
  /^((cache\/\d+\/)[0-9a-f]{32}\/e\/([^/]+)\/[^/]+\/)([^/]+)\/(.+)$/;
const HOUR = 3_600_000;

// The keys to delete, each entry's manifest before its pieces. `defaults`:
// the default branches' ref prefixes the listener has seen.
export function planSweep(
  objects: readonly Listed[],
  now: number,
  cap = capBytes({}),
  defaults: ReadonlySet<string> = new Set(),
): string[] {
  const entries = new Map<
    string,
    {
      repo: string;
      // Its ref, key and version.
      line: string;
      // Its upload ID, which starts with its start time (store.ts).
      id: string;
      // Past the cap, lower goes first.
      tier: number;
      manifest?: Listed;
      pieces: Listed[];
      bytes: number;
    }
  >();
  const out: string[] = [];
  for (const o of objects) {
    const m = ENTRY.exec(o.key);
    // Anything outside an entry, after a day.
    if (!m) {
      if (now - o.modified > DAY) out.push(o.key);
      continue;
    }
    const prefix = o.key.slice(0, -m[5]!.length);
    // Automatic entries, other refs' before the default branch's, then the
    // user's and the job records: a
    // record is a few KB, and its job's whole restore. An escaped key keeps
    // `bm-auto-` as it is (format.ts).
    const auto =
      m[3]!.startsWith(AUTO_PREFIX) && !m[3]!.startsWith(AUTO_RECORD);
    const ref = m[1]!.slice(0, m[1]!.indexOf('/e/') + 1);
    const e = entries.get(prefix) ?? {
      repo: m[2]!,
      line: m[1]!,
      id: m[4]!,
      tier: auto ? Number(defaults.has(ref)) : 2,
      pieces: [],
      bytes: 0,
    };
    if (m[5] === 'manifest.json') e.manifest = o;
    else e.pieces.push(o);
    e.bytes += o.size;
    entries.set(prefix, e);
  }
  const drop = (e: { manifest?: Listed; pieces: Listed[] }) =>
    out.push(
      ...(e.manifest ? [e.manifest.key] : []),
      ...e.pieces.map((p) => p.key),
    );
  const kept = new Map<string, number>();
  const live = [];
  for (const e of entries.values()) {
    const newest = Math.max(0, ...e.pieces.map((p) => p.modified));
    if (!e.manifest) {
      // Pieces a crashed or running upload left: after a day.
      if (now - newest > DAY) drop(e);
      else kept.set(e.repo, (kept.get(e.repo) ?? 0) + e.bytes);
    } else if (!e.pieces.length || now - e.manifest.modified > 7 * DAY) drop(e);
    else live.push(e);
  }
  // A restore reads only an entry's newest instance, by upload ID as
  // findEntry orders them: an older one goes once the newer is an hour old.
  const newest = new Map<string, (typeof live)[number]>();
  for (const e of live) {
    const n = newest.get(e.line);
    if (!n || e.id > n.id) newest.set(e.line, e);
  }
  const current = live.filter((e) => {
    const n = newest.get(e.line)!;
    const old = e !== n && now - n.manifest!.modified >= HOUR;
    if (old) drop(e);
    return !old;
  });
  for (const e of current) kept.set(e.repo, (kept.get(e.repo) ?? 0) + e.bytes);
  // Past the cap by tier, then oldest first; never the newest instance made
  // in the last hour.
  for (const e of current.sort(
    (a, b) => a.tier - b.tier || a.manifest!.modified - b.manifest!.modified,
  )) {
    const { modified } = e.manifest!;
    const fresh = now - modified < HOUR && e === newest.get(e.line);
    if (kept.get(e.repo)! <= cap || fresh) continue;
    drop(e);
    kept.set(e.repo, kept.get(e.repo)! - e.bytes);
  }
  return out;
}

export interface SweptBucket {
  credentialName: string;
  bucket: string;
  region: string;
}

// Each route region's bucket, once.
export const cacheBuckets = (
  install: string,
  routes: readonly Route[],
): SweptBucket[] => [
  ...new Map(
    routes.flatMap((r) =>
      r.regions.map((region) => {
        const bucket = bucketName(install, region);
        return [
          bucket,
          { credentialName: r.credentials, bucket, region },
        ] as const;
      }),
    ),
  ).values(),
];

export async function sweepBuckets(
  api: Pick<AnycloudApi, 'listBucketObjects' | 'deleteBucketObject'>,
  buckets: readonly SweptBucket[],
  log: Log,
  cap = capBytes(process.env),
  now = Date.now(),
  defaults: ReadonlySet<string> = new Set(),
): Promise<void> {
  for (const { credentialName, bucket, region } of buckets) {
    const params = { credentialName, bucketName: bucket };
    try {
      const objects: Listed[] = [];
      let cursor: string | undefined;
      do {
        const query = {
          region,
          prefix: 'cache/',
          recursive: 'true' as const,
          ...(cursor && { cursor }),
        };
        const page = await api.listBucketObjects({ params, query });
        for (const e of page.entries)
          if (e.kind === 'object')
            objects.push({
              key: e.key,
              size: e.sizeBytes ?? 0,
              modified: e.lastModifiedAt ?? now,
            });
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      const doomed = planSweep(objects, now, cap, defaults);
      for (const remotePath of doomed)
        await api.deleteBucketObject({ params, query: { region, remotePath } });
      const bytes = objects.reduce((sum, o) => sum + o.size, 0);
      log({
        msg: 'cache swept',
        bucket,
        objects: objects.length,
        bytes,
        deleted: doomed.length,
      });
    } catch (error) {
      log({ msg: 'cache sweep failed', bucket, error: String(error) });
    }
  }
}
