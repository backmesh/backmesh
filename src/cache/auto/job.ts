// The automatic caches' shared parts:
// the job record, the keys, and what a job used, as the restorer and the
// saver both read them.
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { basename, isAbsolute, join, normalize, relative } from 'node:path';

import { z } from 'zod';

import {
  AUTO_PREFIX,
  AUTO_RECORD,
  entryVersion,
  esc,
  type ReadyFile,
  type RefLabel,
} from '../format.js';
import { read, type Store, type Tokens } from '../store.js';

export const PMS = ['npm', 'yarn', 'berry', 'pnpm'] as const;
export type Pm = (typeof PMS)[number];
// Each package manager's default cache under HOME, and its lockfiles.
export const PM_DIRS: Record<Pm, string> = {
  npm: '.npm/_cacache',
  yarn: '.cache/yarn/v6',
  berry: '.yarn/berry/cache',
  pnpm: '.local/share/pnpm/store',
};
const PM_LOCKS: Record<Pm, string[]> = {
  npm: ['package-lock.json', 'npm-shrinkwrap.json'],
  yarn: ['yarn.lock'],
  berry: ['yarn.lock'],
  pnpm: ['pnpm-lock.yaml'],
};
const LOCKS = new Set(Object.values(PM_LOCKS).flat());

// A record is the job's to write, so its fields are checked: a tool
// is three plain path segments, a key its manager's shape.
const segment = z
  .string()
  .regex(/^[^/\0]+$/)
  .refine((s) => s !== '.' && s !== '..');
const tool = z.object({ tool: segment, version: segment, arch: segment });
export type Tool = z.infer<typeof tool>;
const dep = z
  .object({
    pm: z.enum(PMS),
    key: z.string(),
    base: z.number(),
    reset: z.boolean().optional(),
  })
  .refine((d) =>
    new RegExp(`^${AUTO_PREFIX}${d.pm}-\\w+-[0-9a-f]{16}-[0-9a-f]{32}$`).test(
      d.key,
    ),
  );
export const recordSchema = z.object({
  v: z.literal(1),
  tools: z.array(tool),
  deps: z.array(dep),
  aside: z.array(z.enum(PMS)),
  off: z.boolean().optional(),
  container: z.boolean().optional(),
});
export type JobRecord = z.infer<typeof recordSchema>;
export const RECORD_FILE = 'record.json';
export const RECORD_VERSION = entryVersion(['bm-auto-job']);

// The job-completed hook's environment (runner-job job_facts).
export const factsSchema = z.object({
  PATH: z.string(),
  HOME: z.string(),
  GITHUB_JOB: z.string(),
  GITHUB_REPOSITORY: z.string(),
  GITHUB_WORKSPACE: z.string(),
  RUNNER_TOOL_CACHE: z.string(),
});
export type Facts = z.infer<typeof factsSchema>;

// What the restorer found, for the saver: the record, and each package
// manager's entry, with when it was made and when it landed (epoch ms).
export interface Restored {
  record?: { data: JobRecord; ref: RefLabel; at: number };
  deps: Partial<
    Record<Pm, { ref: RefLabel; key: string; at: number; landed: number }>
  >;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export const recordKey = (job: { workflow: string; name: string }) =>
  `${AUTO_RECORD}${sha(`${job.workflow}\n${job.name}`).slice(0, 32)}`;
export const toolKey = (imageOs: string, t: Tool) =>
  `${AUTO_PREFIX}tool-${imageOs}-${t.tool}-${t.version}-${t.arch}`;
export const toolDir = (cache: string, t: Tool) =>
  join(cache, t.tool, t.version, t.arch);
// A dependency key's line, `bm-auto-<pm>-<arch>-<set>-`, for a prefix match.
export const lineOf = (key: string) => key.slice(0, -32);
// An instance's creation: its upload ID starts with the time in base 36.
export const createdAt = (prefix: string) =>
  parseInt(prefix.split('/').at(-2)!.split('-')[0]!, 36);

// The tool-cache directories `PATH` names, each exactly
// `<cache>/<tool>/<version>/<arch>`.
export function toolsOf(path: string, cache: string): Tool[] {
  const tools = new Map<string, Tool>();
  for (const entry of path.split(':')) {
    if (!isAbsolute(entry)) continue;
    const parts = relative(cache, normalize(entry)).split('/');
    const t = tool.safeParse({
      tool: parts[0],
      version: parts[1],
      arch: parts[2],
    });
    if (parts[0] !== '..' && t.success)
      tools.set(parts.slice(0, 3).join('/'), t.data);
  }
  return [...tools.values()];
}

// The lockfiles the job installed: with a `node_modules` or Yarn's
// `.pnp.cjs` beside them, at most four levels down, outside `node_modules`
// and `.git`. Relative to the workspace, sorted.
export async function installedLocks(workspace: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    const names = await readdir(join(workspace, dir)).catch(() => []);
    const installed = names.some(
      (n) => n === 'node_modules' || n === '.pnp.cjs',
    );
    for (const name of names) {
      const path = join(dir, name);
      if (installed && LOCKS.has(name)) found.push(path);
      if (depth >= 4 || name === 'node_modules' || name === '.git') continue;
      const info = await lstat(join(workspace, path)).catch(() => undefined);
      if (info?.isDirectory()) await walk(path, depth + 1);
    }
  };
  await walk('', 0);
  return found.sort();
}

// `bm-auto-<pm>-<arch>-<set>-<lock>`: the set hashes the manager's
// installed lockfiles' paths, the lock their paths and contents.
export async function depKey(
  pm: Pm,
  arch: string,
  workspace: string,
  locks: readonly string[],
): Promise<string | undefined> {
  const mine = locks.filter((l) => PM_LOCKS[pm].includes(basename(l)));
  if (!mine.length) return undefined;
  const lock = createHash('sha256');
  for (const l of mine)
    lock
      .update(`${l}\0`)
      .update(await readFile(join(workspace, l)))
      .update('\0');
  const set = sha(mine.join('\n')).slice(0, 16);
  return `${AUTO_PREFIX}${pm}-${arch}-${set}-${lock.digest('hex').slice(0, 32)}`;
}

// The token file's latest `ready` at each request.
export const tokensFrom =
  (path: string, file: ReadyFile): Tokens =>
  async () => {
    const now = await read(path);
    return now.state === 'ready' ? now : file;
  };

// An entry's instances in one ref, by upload ID, and whether each is
// complete (has its manifest).
export async function instances(
  store: Store,
  ref: string,
  version: string,
  key: string,
): Promise<Map<string, boolean>> {
  const at = `${ref}e/${esc(key)}/${version}/`;
  const found = new Map<string, boolean>();
  for (const k of await store.list(at)) {
    const [id, object] = k.slice(at.length).split('/');
    if (id) found.set(id, found.get(id) || object === 'manifest.json');
  }
  return found;
}
