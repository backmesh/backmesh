// The automatic caches' saver: run by runner-job as root after the job's own
// saves, it uploads the tools and package-manager caches the job used that no
// ref it reads holds, straight from their directories, then the job's record.
import { lstat, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { entryVersion, esc, type Manifest, type RefLabel } from '../format.js';
import type { Member } from '../pieces.js';
import { membersOf, newUploadId, PLANS_DIR, putEntry } from '../snapshot.js';
import { openStore, read, type Store } from '../store.js';
import { scanJob } from './aside.js';
import {
  createdAt,
  depKey,
  factsSchema,
  installedLocks,
  instances,
  PM_DIRS,
  PMS,
  RECORD_FILE,
  RECORD_VERSION,
  recordKey,
  toolDir,
  toolKey,
  toolsOf,
  tokensFrom,
  type Facts,
  type JobRecord,
  type Restored,
} from './job.js';

const DAY = 24 * 3_600_000;
// An upload this recent without its manifest is another job's, still going.
const CLAIM_MS = 10 * 60_000;
// corepack enable's links into Node's `bin`, left out of its entry.
const SHIMS = new Set(['bin/yarn', 'bin/yarnpkg', 'bin/pnpm', 'bin/pnpx']);

export interface SaveJob {
  store: Store;
  prefixes: Partial<Record<RefLabel, string>>;
  own: string;
  job: { workflow: string; name: string };
  facts: Facts;
  restored: Restored;
  imageOs: string;
  arch: string;
  // The runner's work directory: its downloaded actions, and room for the
  // pieces as they're built.
  work: string;
  log: (text: string) => void;
  now?: number;
}

// A file under a tool changed after its marker: not a directory, whose
// change time a new link moves, nor Python's bytecode caches.
async function changedAfter(
  dir: string,
  members: readonly Member[],
  marker: number,
) {
  for (const m of members) {
    if (m.dir || m.name.includes('__pycache__/')) continue;
    const info = await lstat(join(dir, m.name)).catch(() => undefined);
    if (!info || info.ctimeMs > marker) return m.name;
  }
  return undefined;
}

// Saves what the job used and writes its record; returns the record.
export async function saveJob(s: SaveJob): Promise<JobRecord> {
  const now = s.now ?? Date.now();
  const f = s.facts;
  const record: JobRecord = { v: 1, tools: [], deps: [], aside: [] };
  // A complete entry in any ref it reads (unless `refresh`), or another
  // job's upload under way in its own.
  const held = async (key: string, dir: string, refresh = false) => {
    const version = entryVersion([dir]);
    const refs = new Set([s.own, s.prefixes.base, s.prefixes.default]);
    for (const ref of refs) {
      if (!ref) continue;
      const found = await instances(s.store, ref, version, key);
      for (const [id, complete] of found)
        if (
          complete
            ? !refresh || now - createdAt(`${id}/`) < 3 * DAY
            : ref === s.own && now - createdAt(`${id}/`) < CLAIM_MS
        )
          return true;
    }
    return false;
  };
  const put = async (key: string, dir: string, members: Member[]) => {
    const id = newUploadId();
    const prefix = `${s.own}e/${esc(key)}/${entryVersion([dir])}/${id}/`;
    const out = join(s.work, PLANS_DIR, `auto-${id}`);
    try {
      await s.store.put(`${prefix}claim`, new Blob([]));
      const { result, detail } = await putEntry(
        s.store,
        prefix,
        key,
        dir,
        members,
        now,
        out,
      );
      s.log(`result=${result} key=${key}${detail}`);
    } catch (error) {
      // One entry's failure leaves the others and the record.
      s.log(
        `result=failed key=${key} error=${JSON.stringify(String(error)).slice(0, 300)}`,
      );
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  };

  const scan = f.PATH.split(':').some((p) => p.startsWith('/__t/'))
    ? 'container'
    : await scanJob(
        f.GITHUB_WORKSPACE,
        f.GITHUB_REPOSITORY,
        s.job.workflow,
        f.GITHUB_JOB,
        join(s.work, '_actions'),
      );
  if (scan === 'container') record.container = true;
  // Unreadable, so its opt-out can't be seen: off.
  else if (!scan || scan.off) record.off = true;
  else {
    for (const t of toolsOf(f.PATH, f.RUNNER_TOOL_CACHE)) {
      const dir = toolDir(f.RUNNER_TOOL_CACHE, t);
      const marker = await lstat(`${dir}.complete`).catch(() => undefined);
      if (!marker || !(await lstat(dir).catch(() => undefined))?.isDirectory())
        continue;
      record.tools.push(t);
      const key = toolKey(s.imageOs, t);
      if (await held(key, dir)) continue;
      const members = await membersOf(dir, ['.'], (n) => SHIMS.has(n));
      const changed = await changedAfter(dir, members, marker.ctimeMs);
      if (changed)
        s.log(`result=changed key=${key} file=${JSON.stringify(changed)}`);
      else await put(key, dir, members);
    }
    const locks = await installedLocks(f.GITHUB_WORKSPACE);
    for (const pm of PMS) {
      const dir = join(f.HOME, PM_DIRS[pm]);
      // A lockfile it can't read, such as a dangling link: not saved.
      const key = await depKey(pm, s.arch, f.GITHUB_WORKSPACE, locks).catch(
        () => undefined,
      );
      if (!key || !(await readdir(dir).catch(() => [])).length) continue;
      if (scan.aside.has(pm)) {
        record.aside.push(pm);
        continue;
      }
      const prior = s.restored.deps[pm];
      // A line's base is its cold save's size: a save after
      // no restore starts a line.
      const was = s.restored.record?.data.deps.find((d) => d.pm === pm);
      const refresh =
        prior?.key === key &&
        prior.ref === 'own' &&
        s.own === s.prefixes.default &&
        now - prior.at > 3 * DAY;
      const skip = await held(key, dir, refresh);
      // A walk of a large cache is slow: only when its size or files count.
      const members = skip && prior && was ? [] : await membersOf(dir, ['.']);
      const bytes = members.reduce((sum, m) => sum + m.size, 0);
      const dep: JobRecord['deps'][number] = {
        pm,
        key,
        base: prior && was ? was.base : bytes,
      };
      record.deps.push(dep);
      if (skip) continue;
      if (prior && prior.key !== key && bytes > 2 * dep.base) {
        dep.reset = true;
        s.log(`result=reset key=${key} bytes=${bytes} base=${dep.base}`);
      } else await put(key, dir, members);
    }
  }

  // Last, after the uploads; it names what the job used, so an entry not
  // saved is a miss next time. A record in use is written again before the
  // 7-day sweep.
  const last = s.restored.record;
  const same = last && JSON.stringify(last.data) === JSON.stringify(record);
  if (same && !(last.ref === 'own' && now - last.at > 3 * DAY)) return record;
  const key = recordKey(s.job);
  const prefix = `${s.own}e/${esc(key)}/${RECORD_VERSION}/${newUploadId()}/`;
  const body = JSON.stringify(record);
  await s.store.put(`${prefix}${RECORD_FILE}`, new Blob([body]));
  const manifest: Manifest = {
    v: 1,
    key,
    bytes: body.length,
    pieces: [{ name: RECORD_FILE, zstd: false, members: [] }],
  };
  await s.store.put(
    `${prefix}manifest.json`,
    new Blob([JSON.stringify(manifest)]),
  );
  s.log(`result=recorded key=${key}`);
  return record;
}

// `auto-cache.mjs save`: logs one line per entry in the runner Job's log;
// never throws.
export async function save(
  tokenPath: string,
  state: string,
  work: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const log = (text: string) => console.log(`backmesh-cache-auto ${text}`);
  try {
    const file = await read(tokenPath).catch(() => undefined);
    if (file?.state !== 'ready' || !file.job) return log('result=off');
    const own = file.prefixes.own;
    if (!own) return log('result=read-only');
    const facts = factsSchema.safeParse(
      JSON.parse(
        await readFile(join(state, 'facts.json'), 'utf8').catch(() => 'null'),
      ),
    );
    if (!facts.success) return log('result=no-facts');
    const restored = JSON.parse(
      await readFile(join(state, 'restored.json'), 'utf8').catch(
        () => '{"deps":{}}',
      ),
    ) as Restored;
    await saveJob({
      store: openStore(tokensFrom(tokenPath, file)),
      prefixes: file.prefixes,
      own,
      job: file.job,
      facts: facts.data,
      restored,
      imageOs: env.ImageOS ?? 'linux',
      arch: process.arch,
      work,
      log,
    });
  } catch (error) {
    log(`result=failed error=${JSON.stringify(String(error)).slice(0, 300)}`);
  }
}
