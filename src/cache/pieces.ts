// File-split pieces: each piece
// is its own tar, zstd level 1 or stored as is, fetched with its own GET and
// extracted by its own pipeline, so no piece waits on another.
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createZstdDecompress } from 'node:zlib';

import type { Manifest } from './format.js';
import type { Store } from './store.js';

export interface Member {
  // Relative to GITHUB_WORKSPACE, as @actions/cache names members.
  name: string;
  size: number;
  dir?: boolean;
}
export interface PiecePlan {
  name: string;
  zstd: boolean;
  members: string[];
  bytes: number;
}

// Under S3's 5 GiB and Azure's 5,000 MiB single upload, with room for tar's
// headers: past 32 such pieces, a cache gets more.
export const MAX_PIECE = 4.5 * 2 ** 30;
const MIN_PIECE = 8 * 2 ** 20;
// Already compressed: zstd would spend CPU for nothing.
const PACKED =
  /\.(gz|tgz|zst|xz|bz2|lz4|br|7z|zip|jar|war|whl|nupkg|apk|deb|rpm|png|jpe?g|gif|webp|mp[34]|webm|woff2?|pack)$/i;

export function planPieces(members: readonly Member[]): PiecePlan[] {
  const files = members.filter((m) => !m.dir);
  const total = files.reduce((sum, m) => sum + m.size, 0);
  const count = Math.max(
    1,
    Math.min(
      Math.max(32, Math.ceil(total / MAX_PIECE)),
      Math.ceil(total / MIN_PIECE),
      files.length,
    ),
  );
  const packed = files.filter((m) => PACKED.test(m.name));
  const packedBytes = packed.reduce((sum, m) => sum + m.size, 0);
  // Split between the classes by bytes; with no uncompressed piece, packed
  // files ride in the zstd ones.
  const raw =
    packed.length && packed.length < files.length
      ? Math.min(
          count - 1,
          Math.max(1, Math.round((count * packedBytes) / (total || 1))),
        )
      : 0;
  const piece = (zstd: boolean) => ({
    zstd,
    members: [] as string[],
    bytes: 0,
  });
  const groups = [
    ...Array.from({ length: count - raw }, () => piece(true)),
    ...Array.from({ length: raw }, () => piece(false)),
  ];
  // Largest first onto the lightest piece of its class.
  for (const m of [...files].sort((a, b) => b.size - a.size)) {
    const zstd = !raw || !PACKED.test(m.name);
    const g = groups
      .filter((x) => x.zstd === zstd)
      .reduce((a, b) => (b.bytes < a.bytes ? b : a));
    g.members.push(m.name);
    g.bytes += m.size;
  }
  const pieces = groups.filter((g, i) => i === 0 || g.members.length);
  // Empty directories, the only directory members (snapshot.ts).
  pieces[0]!.members.unshift(
    ...members.filter((m) => m.dir).map((m) => m.name),
  );
  return pieces.map((p, i) => ({
    ...p,
    name: `p${String(i).padStart(2, '0')}.tar${p.zstd ? '.zst' : ''}`,
  }));
}

// One shell pipeline (exported for its tests); a stage that fails marks
// stderr, since sh has no pipefail. The marked stage's own error is in the
// message.
const FAIL = 'BMFAIL';
export function sh(script: string, args: string[], stdin: 'pipe' | 'ignore') {
  const child = spawn('sh', ['-c', script, 'sh', ...args], {
    stdio: [stdin, 'ignore', 'pipe'],
  });
  let err = '';
  let failed = false;
  child.stderr!.on('data', (d: Buffer) => {
    // The marker is looked for before the tail is cut: a chunk may carry
    // it and more than the tail's 800 bytes after it.
    err += d.toString();
    failed ||= err.includes(FAIL);
    err = err.slice(-800);
  });
  const done = new Promise<void>((ok, fail) => {
    child.on('error', fail);
    child.on('close', (code) =>
      code === 0 && !failed
        ? ok()
        : fail(new Error(`${args[0]}: ${err.trim()}`)),
    );
  });
  return { child, done };
}

// Writes one piece's archive to `dir/<name>` from the snapshot whose
// workspace is `cwd`. The uploader runs in the runner
// image, which has zstd (whose frames carry a checksum).
export async function buildPiece(
  piece: PiecePlan,
  cwd: string,
  dir: string,
): Promise<void> {
  const list = join(dir, `${piece.name}.list`);
  const out = join(dir, piece.name);
  await writeFile(list, piece.members.map((m) => `${m}\0`).join(''));
  const tar = `tar -c -P --no-recursion --null --verbatim-files-from -C "$2" -T "$3" -f -`;
  const zstd = piece.zstd ? 'zstd -1 -q -c -T1' : 'cat';
  await sh(
    `{ ${tar} || echo ${FAIL} >&2; } | { ${zstd} || echo ${FAIL} >&2; } >"$1"`,
    [out, cwd, list],
    'ignore',
  ).done;
}

let zstdCli: boolean | undefined;

// Streams one piece into its own `tar -x` in `workspace`. tar exits at the
// archive's end blocks with the record's padding still coming (live run
// 43278513454), so `cat` reads the rest: the whole download is still read,
// and a cut or corrupt piece fails zstd or the fetch even where tar alone
// would have called it complete (a clean end at a member's header). zstd
// runs in the pipeline when the image has it, else in Node.
export async function restorePiece(
  store: Store,
  prefix: string,
  piece: Pick<Manifest['pieces'][number], 'name' | 'zstd'>,
  workspace: string,
  // Phase 1's names, relative to the workspace, may leave it; phase 2's
  // can't.
  absolute = true,
): Promise<void> {
  zstdCli ??= spawnSync('zstd', ['--version']).status === 0;
  const body = Readable.fromWeb(
    (await store.get(`${prefix}${piece.name}`)).body! as Parameters<
      typeof Readable.fromWeb
    >[0],
  );
  const decode = piece.zstd && zstdCli ? 'zstd -d -q -c' : 'cat';
  const { child, done } = sh(
    `{ ${decode} || echo ${FAIL} >&2; } | { tar -x ${absolute ? '-P ' : ''}-C "$1" -f - || echo ${FAIL} >&2; cat >/dev/null; }`,
    [workspace],
    'pipe',
  );
  const stages =
    piece.zstd && !zstdCli
      ? [body, createZstdDecompress(), child.stdin!]
      : [body, child.stdin!];
  const results = await Promise.allSettled([
    done,
    pipeline(stages as [Readable, NodeJS.WritableStream]),
  ]);
  const failed = results.find((r) => r.status === 'rejected');
  if (failed) throw failed.reason;
}

// Every directory the files sit in, before the pieces extract at once:
// Debian 12's tar 1.34 gives up on a file whose missing parent another tar
// creates at the same moment (live run 43287351449).
export async function makeParents(
  workspace: string,
  members: readonly string[],
): Promise<void> {
  const dirs = [...new Set(members.map((m) => dirname(resolve(workspace, m))))];
  await Promise.all(dirs.map((d) => mkdir(d, { recursive: true })));
}
