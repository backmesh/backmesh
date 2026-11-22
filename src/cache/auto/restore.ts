// The automatic caches' restorer: started
// by runner-job as the runner user with the runner, it waits for the token
// file's `ready`, reads the job's record and restores every directory the
// record names at once, each into a staging directory renamed onto its
// target. The job-started hook waits for the tools, which setup-* steps look
// for at once; the dependency caches go on in the background, up to `limit`
// after the job starts.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { entryVersion, type ReadyFile, type RefLabel } from '../format.js';
import { makeParents, restorePiece } from '../pieces.js';
import {
  findEntry,
  openStore,
  read,
  readManifest,
  type Store,
  type Tokens,
} from '../store.js';
import {
  createdAt,
  lineOf,
  PM_DIRS,
  RECORD_FILE,
  RECORD_VERSION,
  recordKey,
  recordSchema,
  toolDir,
  toolKey,
  tokensFrom,
  type Pm,
  type Restored,
} from './job.js';

const LIMIT = 120_000;
const secs = (since: number) => `${((Date.now() - since) / 1000).toFixed(1)} s`;

// The token file once it isn't `pending`, or the restorer gives up or
// stops; undefined when it's missing.
async function ready(path: string, over: () => boolean) {
  for (;;) {
    const file = await read(path).catch(() => undefined);
    if (file?.state !== 'pending' || over()) return file;
    await sleep(200);
  }
}

interface Target {
  what: string;
  key: string;
  dir: string;
  pm?: Pm;
}

interface Restoring {
  // A store whose requests `signal` ends.
  storeOf: (signal: AbortSignal) => Store;
  prefixes: Partial<Record<RefLabel, string>>;
  restored: Restored;
  // Writes restored.json, whole, for a saver that may run before the end.
  persist: () => Promise<void>;
  // The hook stopped waiting: the job's steps may be running.
  gaveUp: () => boolean;
  // Past `limit` after the job started.
  expired: () => boolean;
  // `+<s> s` since the job started.
  at: () => string;
  stop: AbortSignal;
}

// One directory: its status line's text. `commit`, just before the rename,
// says whether the restore still counts; `signal` ends its requests. A
// dependency's entry goes into restored.json before its rename, so a
// restorer killed in between leaves the saver its landing.
async function restoreOne(
  c: Restoring,
  t: Target,
  commit: () => boolean,
  signal: AbortSignal,
): Promise<string> {
  const started = Date.now();
  const store = c.storeOf(signal);
  if (existsSync(t.dir))
    return `gave way ${t.what}: a step made ${t.dir} first, at ${c.at()}`;
  const match = await findEntry(
    store,
    c.prefixes,
    entryVersion([t.dir]),
    t.key,
    t.pm ? [lineOf(t.key)] : [],
  );
  // A tool's key is exact; findEntry would take a longer one.
  if (!match || (!t.pm && match.key !== t.key)) return `missed ${t.what}`;
  const manifest = await readManifest(store, match.prefix);
  const staging = `${t.dir}.bm-${randomBytes(4).toString('hex')}`;
  try {
    await mkdir(staging, { recursive: true });
    await makeParents(
      staging,
      // tar refuses the same names without -P.
      manifest.pieces
        .flatMap((p) => p.members)
        .filter((m) => !m.startsWith('/') && !m.split('/').includes('..')),
    );
    const results = await Promise.allSettled(
      manifest.pieces.map((p) =>
        restorePiece(store, match.prefix, p, staging, false, signal),
      ),
    );
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;
    // `bounded` has said why.
    if (!commit()) return '';
    if (t.pm) {
      c.restored.deps[t.pm] = {
        ref: match.ref,
        key: match.key,
        at: createdAt(match.prefix),
        landed: Date.now(),
      };
      await c.persist();
    }
    try {
      // Fails on a directory a step made and wrote into since the check
      // above, which keeps its files. One still empty is replaced, and the
      // step's later writes land in the restored cache: npm, Yarn and pnpm
      // write into theirs by path. A job that caches the directory itself,
      // such as with actions/cache, is skipped (aside.ts).
      await rename(staging, t.dir);
    } catch (error) {
      if (t.pm) {
        delete c.restored.deps[t.pm];
        await c.persist();
      }
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
      return `gave way ${t.what}: a step made ${t.dir} first, at ${c.at()}`;
    }
    // setup-* takes a tool without it as missing.
    if (!t.pm) await writeFile(`${t.dir}.complete`, '');
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  const older = match.key === t.key ? '' : ', an older lockfile';
  const size = `${(manifest.bytes / 1e6).toFixed(0)} MB`;
  const at = t.pm ? `, at ${c.at()}` : '';
  return `restored ${t.what} (${match.ref}${older})  ${size} in ${secs(started)}${at}`;
}

// restoreOne until `over()`: then one not yet renamed is let go, its requests
// ended, and once it's cleaned up, `why()` said for it; one being renamed is
// let finish. Stopped, it says so.
async function bounded(
  c: Restoring,
  t: Target,
  over: () => boolean,
  why: () => string,
): Promise<string> {
  const end = new AbortController();
  let committed = false;
  let settled = false;
  void (async () => {
    while (!settled && !over()) await sleep(200);
    if (!settled && !committed) end.abort();
  })();
  const line = await restoreOne(
    c,
    t,
    () => !end.signal.aborted && (committed = true),
    AbortSignal.any([c.stop, end.signal]),
  )
    .catch((error: unknown) => {
      if (c.stop.aborted) return `stopped ${t.what}: the job ended`;
      if (end.signal.aborted) return '';
      return `failed ${t.what}: ${String(error).slice(0, 200)}`;
    })
    .finally(() => (settled = true));
  return line || why();
}

async function restoreAll(
  file: ReadyFile,
  c: Restoring,
  env: NodeJS.ProcessEnv,
  say: (text: string) => Promise<void>,
  toolsDone: () => Promise<void>,
) {
  const key = recordKey(file.job!);
  const store = c.storeOf(c.stop);
  const found = await findEntry(store, c.prefixes, RECORD_VERSION, key, []);
  if (!found || found.key !== key)
    return say('found no record of this job yet: its save writes one');
  const body = await (await store.get(`${found.prefix}${RECORD_FILE}`)).json();
  const parsed = recordSchema.safeParse(body);
  if (!parsed.success)
    return say('ignored its job record, which it could not read');
  const record = parsed.data;
  c.restored.record = {
    data: record,
    ref: found.ref,
    at: createdAt(found.prefix),
  };
  if (record.container)
    return say('skipped: a container: job runs in its own image');
  if (record.off)
    return say(
      'skipped: the job opts out, or its workflow file is not in its repository',
    );
  const deps: Promise<void>[] = [];
  for (const d of record.deps) {
    if (record.aside.includes(d.pm)) continue;
    if (d.reset) {
      await say(
        `skipped ${d.pm}: its cache outgrew its lockfile, so it starts again`,
      );
      continue;
    }
    const t: Target = {
      what: d.pm,
      key: d.key,
      dir: join(env.HOME!, PM_DIRS[d.pm]),
      pm: d.pm,
    };
    const why = () => `gave up ${t.what}: still restoring at ${c.at()}`;
    deps.push(bounded(c, t, c.expired, why).then(say));
  }
  for (const pm of record.aside)
    await say(`skipped ${pm}: the job caches ${PM_DIRS[pm]} itself`);
  await Promise.all(
    record.tools.map(async (tool) => {
      const t: Target = {
        what: `${tool.tool} ${tool.version}`,
        key: toolKey(env.ImageOS ?? 'linux', tool),
        dir: toolDir(env.RUNNER_TOOL_CACHE!, tool),
      };
      // setup-* may be installing it.
      const why = () => `skipped ${t.what}: the job started without it`;
      await say(c.gaveUp() ? why() : await bounded(c, t, c.gaveUp, why));
    }),
  );
  await toolsDone();
  await Promise.all(deps);
}

// Writes `lines` for the hooks to print, `ready` with when the token came
// (epoch ms) for the job-started hook's timing line, `tools-done` once the
// tools are, which is all that hook waits for, `restored.json` for the
// saver, then `done`, into `state`. Never throws.
export async function restore(
  tokenPath: string,
  state: string,
  env: NodeJS.ProcessEnv = process.env,
  storeOf = (tokens: Tokens, signal: AbortSignal): Store =>
    openStore(tokens, globalThis.fetch, signal),
  limit = LIMIT,
  stop = new AbortController().signal,
): Promise<void> {
  const began = Date.now();
  const say = async (text: string) => {
    const line = `backmesh cache: auto ${text}`;
    console.log(line);
    await appendFile(join(state, 'lines'), `${line}\n`).catch(() => undefined);
  };
  const toolsDone = () => writeFile(join(state, 'tools-done'), '');
  const restored: Restored = { deps: {} };
  let saving = Promise.resolve();
  const persist = () =>
    (saving = saving
      .catch(() => undefined)
      .then(async () => {
        const path = join(state, 'restored.json');
        await writeFile(`${path}.new`, JSON.stringify(restored));
        await rename(`${path}.new`, path);
      }));
  // The hook notes the job's start (epoch ms). A runner can start well before
  // its job, so the limit counts from it, and waits on until then.
  let started: number | undefined;
  const startedAt = () => {
    try {
      started ||= Number(readFileSync(join(state, 'started'), 'utf8'));
    } catch {
      // Not yet.
    }
    return started || undefined;
  };
  const expired = () => Date.now() >= (startedAt() ?? Infinity) + limit;
  const at = () => `+${secs(startedAt() ?? began)}`;
  const gaveUp = () => existsSync(join(state, 'gave-up'));
  try {
    const file = await ready(tokenPath, () => expired() || stop.aborted);
    if (file && file.state !== 'pending')
      await writeFile(join(state, 'ready'), String(Date.now()));
    if (file?.state === 'pending') {
      // A runner stopped before it got a job has nothing to say.
      if (startedAt())
        await say(
          stop.aborted
            ? 'stopped: the job ended before its cache token came'
            : `gave up: no cache token by ${at()}`,
        );
    } else if (file?.state === 'off')
      await say(`skipped: the cache is off for this runner (${file.reason})`);
    else if (file?.job) {
      const tokens = tokensFrom(tokenPath, file);
      const c = {
        storeOf: (signal: AbortSignal) => storeOf(tokens, signal),
        prefixes: file.prefixes,
        restored,
        persist,
        gaveUp,
        expired,
        at,
        stop,
      };
      await restoreAll(file, c, env, say, toolsDone);
    }
  } catch (error) {
    await say(`failed: ${String(error).slice(0, 200)}`);
  } finally {
    await persist();
    await toolsDone();
    await writeFile(join(state, 'done'), '');
  }
}
