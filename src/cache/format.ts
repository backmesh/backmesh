// The cache's shared formats: the token file
// the listener writes and the action reads, and entry names.
import { createHash } from 'node:crypto';

export type RefLabel = 'own' | 'base' | 'default';

export interface CacheToken {
  prefixes: string[];
  expiresAt: number;
  credentials:
    | { accessKeyId: string; secretAccessKey: string; sessionToken: string }
    | { accessToken: string }
    | { sasToken: string };
}

// The Secret key `BACKMESH_CACHE`, one JSON line; `own` is missing for a
// read-only ref.
export type CacheFile =
  | { v: 1; state: 'pending' }
  | { v: 1; state: 'off'; reason: string }
  | {
      v: 1;
      state: 'ready';
      cloud: 'aws' | 'gcp' | 'azure';
      bucket: string;
      region?: string;
      accountUrl?: string;
      prefixes: Partial<Record<RefLabel, string>>;
      tokens: CacheToken[];
      expiresAt: number;
      // The job, from GitHub's message: its workflow file without the ref
      // and its display name.
      job?: { workflow: string; name: string };
    };
export type ReadyFile = Extract<CacheFile, { state: 'ready' }>;

export interface Manifest {
  v: 1;
  key: string;
  bytes: number;
  pieces: { name: string; zstd: boolean; members: string[] }[];
}

export const SECRET_KEY = 'BACKMESH_CACHE';
export const secretName = (runner: string) => `_bm-cache-${runner}`;
export const bucketName = (install: string, region: string) =>
  `bm-cache-${install}-${region}`;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
// The ref hashed to one fixed-length segment, so `a/` never covers `a/b`.
export const refPrefix = (repoId: number, ref: string) =>
  `cache/${repoId}/${sha(ref).slice(0, 32)}/`;
// The paths as given and the format: a changed one is a miss.
export const entryVersion = (paths: readonly string[]) =>
  sha([...paths, 'backmesh-pieces-1'].join('|')).slice(0, 32);

// Each byte on its own: `A–Z a–z 0–9 _ -` stay, any other is `~XX`, so an
// escaped key's prefixes are exactly its keys' prefixes.
export const esc = (key: string) =>
  [...Buffer.from(key)]
    .map((b) =>
      /[\w-]/.test(String.fromCharCode(b))
        ? String.fromCharCode(b)
        : `~${b.toString(16).toUpperCase().padStart(2, '0')}`,
    )
    .join('');
export const unesc = (seg: string) =>
  Buffer.from(
    seg
      .match(/~[0-9A-F]{2}|./g)!
      .map((p) =>
        p.length === 3 ? parseInt(p.slice(1), 16) : p.charCodeAt(0),
      ),
  ).toString();
// The automatic caches' keys, which
// backmesh/cache refuses to save; `esc` keeps them as they are.
export const AUTO_PREFIX = 'bm-auto-';
export const AUTO_RECORD = `${AUTO_PREFIX}job-`;
// Object keys stop at 1,024 bytes.
export const MAX_ESCAPED_KEY = 700;
