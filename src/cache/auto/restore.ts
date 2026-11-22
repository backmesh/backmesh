// The automatic caches' restorer: started
// by runner-job as the runner user with the runner, it waits for the token
// file's `ready`, reads the job's record and restores every directory the
// record names at once, each into a staging directory renamed onto its
// target. The job-started hook waits for the tools, which setup-* steps look
// for at once; the dependency caches go on in the background, up to `limit`
// after the restorer starts.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
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

// The token file once it isn't `pending` or the deadline passed; undefined
// when it's missing.
async function ready(path: string, deadline: number) {
  for (;;) {
    const file = await read(path).catch(() => undefined);
    if (file?.state !== 'pending' || Date.now() >= deadline) return file;
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
  store: Store;
  prefixes: Partial<Record<RefLabel, string>>;
  restored: Restored;
  // Writes restored.json, whole, for a saver that may run before the end.
  persist: () => Promise<void>;
  // The hook stopped waiting: the job's steps may be running.
  gaveUp: () => boolean;
  // `+<s> s` since the job started.
  at: () => Promise<string>;
}

// One directory: its status line's text. `commit`, just before the rename,
// says whether the restore still counts. A dependency's entry goes into
// restored.json before its rename, so a restorer killed in between leaves
// the saver its landing.
async function restoreOne(
  c: Restoring,
  t: Target,
  commit: () => boolean,
): Promise<string> {
  const started = Date.now();
  if (existsSync(t.dir))
    return `gave way ${t.what}: a step made ${t.dir} first, at ${await c.at()}`;
  const match = await findEntry(
    c.store,
    c.prefixes,
    entryVersion([t.dir]),
    t.key,
    t.pm ? [lineOf(t.key)] : [],
  );
  // A tool's key is exact; findEntry would take a longer one.
  if (!match || (!t.pm && match.key !== t.key)) return `missed ${t.what}`;
  const manifest = await readManifest(c.store, match.prefix);
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
        restorePiece(c.store, match.prefix, p, staging, false),
      ),
    );
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;
    // A dependency's line is the deadline's, already said.
    if (!commit()) return `skipped ${t.what}: the job started without it`;
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
      // above, which keeps its files; replaces one still empty.
      await rename(staging, t.dir);
    } catch (error) {
      if (t.pm) {
        delete c.restored.deps[t.pm];
        await c.persist();
      }
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
      return `gave way ${t.what}: a step made ${t.dir} first, at ${await c.at()}`;
    }
    // setup-* takes a tool without it as missing.
    if (!t.pm) await writeFile(`${t.dir}.complete`, '');
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  const older = match.key === t.key ? '' : ', an older lockfile';
  const size = `${(manifest.bytes / 1e6).toFixed(0)} MB`;
  const at = t.pm ? `, at ${await c.at()}` : '';
  return `restored ${t.what} (${match.ref}${older})  ${size} in ${secs(started)}${at}`;
}

async function restoreAll(
  file: ReadyFile,
  c: Restoring,
  env: NodeJS.ProcessEnv,
  deadline: number,
  say: (text: string) => Promise<void>,
  toolsDone: () => Promise<void>,
) {
  const key = recordKey(file.job!);
  const found = await findEntry(c.store, c.prefixes, RECORD_VERSION, key, []);
  if (!found || found.key !== key)
    return say('found no record of this job yet: its save writes one');
  const body = await (
    await c.store.get(`${found.prefix}${RECORD_FILE}`)
  ).json();
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
  const failed = (t: Target) => (error: unknown) =>
    `failed ${t.what}: ${String(error).slice(0, 200)}`;
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
    // Past the deadline, one not yet renamed is given up, and its download
    // discarded when it ends; one being renamed is let finish.
    let expired = false;
    let committed = false;
    const one = restoreOne(c, t, () => !expired && (committed = true)).catch(
      failed(t),
    );
    const late = sleep(Math.max(0, deadline - Date.now()), undefined, {
      ref: false,
    }).then(async () => {
      if (committed) return one;
      expired = true;
      return `gave up ${t.what}: still restoring at ${await c.at()}`;
    });
    deps.push(Promise.race([one, late]).then(say));
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
      const commit = () => !c.gaveUp();
      await say(
        commit()
          ? await restoreOne(c, t, commit).catch(failed(t))
          : `skipped ${t.what}: the job started without it`,
      );
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
  storeOf: (tokens: Tokens) => Store = openStore,
  limit = LIMIT,
): Promise<void> {
  const began = Date.now();
  const deadline = began + limit;
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
  // The hook notes the job's start; before it, the restorer's.
  const at = async () => {
    const started = await readFile(join(state, 'started'), 'utf8').catch(
      () => '',
    );
    return `+${secs(Number(started) || began)}`;
  };
  const gaveUp = () => existsSync(join(state, 'gave-up'));
  try {
    const file = await ready(tokenPath, deadline);
    if (file && file.state !== 'pending')
      await writeFile(join(state, 'ready'), String(Date.now()));
    if (file?.state === 'pending')
      await say(`gave up: no cache token by ${await at()}`);
    else if (file?.state === 'off')
      await say(`skipped: the cache is off for this runner (${file.reason})`);
    else if (file?.job) {
      const store = storeOf(tokensFrom(tokenPath, file));
      const c = {
        store,
        prefixes: file.prefixes,
        restored,
        persist,
        gaveUp,
        at,
      };
      await restoreAll(file, c, env, deadline, say, toolsDone);
    }
  } catch (error) {
    await say(`failed: ${String(error).slice(0, 200)}`);
  } finally {
    await persist();
    await toolsDone();
    await writeFile(join(state, 'done'), '');
  }
}
