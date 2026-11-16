// Save after the job: the save
// step hard-links the paths into the work directory with a plan, and the
// runner uploads them after the job with this same checkout's uploader.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

import { esc, type Manifest } from './format.js';
import { buildPiece, MAX_PIECE, planPieces, type Member } from './pieces.js';
import { openCache, openStore, type Store } from './store.js';

export interface Plan {
  v: 1;
  key: string;
  version: string;
  own: string;
  uploadId: string;
  // GITHUB_WORKSPACE as the save step saw it.
  workspace: string;
  // The paths snapshotted, absolute, under `root/` in the plan's directory.
  roots: string[];
  // When the links were done.
  at: number;
  // The uploader, relative to the work directory.
  uploader: string;
}

export const PLANS_DIR = '_backmesh-cache';
export const newUploadId = () =>
  `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
// The workspace is `_work/<repo>/<repo>`, or `/__w/<repo>/<repo>` in a job
// container, which mounts `_work` there.
export const workDir = (workspace: string) => resolve(workspace, '../..');

// GNU cp links each path (absolute, as the patterns matched) under
// `dir/root`, mirroring its absolute path. A path it can't link whole
// (another filesystem, such as a `container:` job's own, or a root-owned file
// Ubuntu's protected_hardlinks refuses) is copied. A path inside another, or
// holding the snapshots, is skipped.
export async function snapshot(paths: readonly string[], dir: string) {
  const under = (p: string, q: string) => p === q || p.startsWith(`${q}/`);
  const plans = dirname(dir);
  const roots = [...new Set(paths)].filter(
    (p, _, all) =>
      !all.some((q) => q !== p && under(p, q)) &&
      !under(p, plans) &&
      !under(plans, p),
  );
  let copied = 0;
  for (const path of roots) {
    const to = join(dir, 'root', path);
    await mkdir(dirname(to), { recursive: true });
    if (spawnSync('cp', ['-al', '--', path, to]).status === 0) continue;
    await rm(to, { recursive: true, force: true });
    const cp = spawnSync('cp', ['-a', '--reflink=auto', '--', path, to], {
      encoding: 'utf8',
    });
    if (cp.status !== 0) throw new Error(`cp ${path}: ${cp.stderr.trim()}`);
    copied++;
  }
  return { roots, copied, at: Date.now() };
}

// The files, symlinks and empty directories under `cwd`'s `roots`, named
// relative to `cwd`, without those `skip` names. tar makes every other
// directory as a file's parent, so no tar extracts a directory another is
// writing into (live run 43283107083).
export async function membersOf(
  cwd: string,
  roots: readonly string[],
  skip = (_name: string) => false,
): Promise<Member[]> {
  const members: Member[] = [];
  const walk = async (name: string): Promise<void> => {
    if (skip(name)) return;
    const info = await lstat(join(cwd, name)).catch(() => undefined);
    if (info?.isDirectory()) {
      const children = await readdir(join(cwd, name));
      if (!children.length) members.push({ name, size: 0, dir: true });
      for (const child of children) await walk(join(name, child));
    } else if (info?.isFile() || info?.isSymbolicLink())
      members.push({ name, size: info.isFile() ? info.size : 0 });
  };
  for (const root of roots) await walk(root);
  return members;
}

// The first file modified after `at`: written in place, so maybe torn. Not
// ctime, which unlinking a snapshot's original path also moves.
export async function changedSince(
  cwd: string,
  files: readonly Member[],
  at: number,
) {
  for (const m of files) {
    const info = await lstat(join(cwd, m.name)).catch(() => undefined);
    if (!info || info.mtimeMs > at) return m.name;
  }
  return undefined;
}

// Builds the pieces from `cwd` into `out` and uploads them under `prefix`,
// then the manifest, so an entry without one is never read. A file changed
// since `at`, before or while the pieces were read, saves nothing.
export async function putEntry(
  store: Store,
  prefix: string,
  key: string,
  cwd: string,
  members: readonly Member[],
  at: number,
  out: string,
): Promise<{ result: 'saved' | 'changed' | 'too-large'; detail: string }> {
  const files = members.filter((m) => !m.dir);
  const changed = async () => {
    const name = await changedSince(cwd, files, at);
    return (
      name && {
        result: 'changed' as const,
        detail: ` file=${JSON.stringify(name)}`,
      }
    );
  };
  const before = await changed();
  if (before) return before;
  const pieces = planPieces(members);
  // GCS would take it; S3 and Azure refuse a single upload past 5 GiB.
  if (pieces.some((p) => p.bytes > MAX_PIECE))
    return { result: 'too-large', detail: '' };
  await mkdir(out, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await Promise.all(
    pieces.map(async (p) => {
      await buildPiece(p, cwd, out);
      await store.put(
        `${prefix}${p.name}`,
        await openAsBlob(join(out, p.name)),
      );
    }),
  );
  const after = await changed();
  if (after) return after;
  const bytes = files.reduce((sum, m) => sum + m.size, 0);
  const manifest: Manifest = {
    v: 1,
    key,
    bytes,
    pieces: pieces.map(({ bytes: _, ...p }) => p),
  };
  await store.put(
    `${prefix}manifest.json`,
    new Blob([JSON.stringify(manifest)]),
  );
  return { result: 'saved', detail: ` bytes=${bytes} pieces=${pieces.length}` };
}

export const writePlan = (dir: string, plan: Plan) =>
  writeFile(join(dir, 'plan.json'), JSON.stringify(plan));

async function runnerStore(): Promise<Store | string> {
  const opened = await openCache(process.env, 0);
  return opened.state === 'ready' ? openStore(opened.tokens) : opened.reason;
}

// Runs after the job (runner-job): builds and uploads the pieces, then the
// manifest, so an entry without one is never read. Logs one line in the
// runner Job's log and returns its result; never throws.
export async function upload(
  planPath: string,
  storeOf = runnerStore,
): Promise<string> {
  const started = Date.now();
  const line = (result: string, detail = '') => {
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(
      `backmesh-cache-upload result=${result} seconds=${seconds}${detail}`,
    );
    return result;
  };
  try {
    const dir = dirname(planPath);
    const plan = JSON.parse(await readFile(planPath, 'utf8')) as Plan;
    const store = await storeOf();
    if (typeof store === 'string')
      return line('off', ` reason=${JSON.stringify(store)}`);
    // The snapshot mirrors absolute paths under `root/`.
    const cwd = join(dir, 'root', plan.workspace);
    const roots = plan.roots.map((r) => relative(plan.workspace, r));
    const members = await membersOf(cwd, roots);
    const prefix = `${plan.own}e/${esc(plan.key)}/${plan.version}/${plan.uploadId}/`;
    const { result, detail } = await putEntry(
      store,
      prefix,
      plan.key,
      cwd,
      members,
      plan.at,
      join(dir, 'pieces'),
    );
    return line(result, detail);
  } catch (error) {
    return line(
      'failed',
      ` error=${JSON.stringify(String(error)).slice(0, 300)}`,
    );
  }
}
