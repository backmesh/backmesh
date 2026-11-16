// The automatic caches' restorer: started
// by runner-job as the runner user with the runner, it waits for the token
// file's `ready`, reads the job's record and restores every directory the
// record names at once, each into a staging directory renamed onto its
// target only if no step made the target first.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
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

const secs = (since: number) => `${((Date.now() - since) / 1000).toFixed(1)} s`;

// The token file once `ready`; undefined when it's missing or `off`, or
// still `pending` once the job-started hook gave up on it.
async function ready(path: string, state: string) {
  for (;;) {
    const file = await read(path).catch(() => undefined);
    if (!file || file.state === 'off') return undefined;
    if (file.state === 'ready') return file;
    if (existsSync(join(state, 'gave-up'))) return undefined;
    await sleep(200);
  }
}

interface Target {
  what: string;
  key: string;
  dir: string;
  pm?: Pm;
}

// One directory: its status line's text.
async function restoreOne(
  store: Store,
  prefixes: Partial<Record<RefLabel, string>>,
  t: Target,
  restored: Restored,
): Promise<string> {
  const started = Date.now();
  const match = await findEntry(
    store,
    prefixes,
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
        restorePiece(store, match.prefix, p, staging, false),
      ),
    );
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;
    if (existsSync(t.dir)) return `late ${t.what}: a step made ${t.dir} first`;
    await rename(staging, t.dir);
    // setup-* takes a tool without it as missing.
    if (!t.pm) await writeFile(`${t.dir}.complete`, '');
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  if (t.pm)
    restored.deps[t.pm] = {
      ref: match.ref,
      key: match.key,
      at: createdAt(match.prefix),
    };
  const older = match.key === t.key ? '' : ', an older lockfile';
  const size = `${(manifest.bytes / 1e6).toFixed(0)} MB`;
  return `restored ${t.what} (${match.ref}${older})  ${size} in ${secs(started)}`;
}

async function restoreAll(
  file: ReadyFile,
  store: Store,
  env: NodeJS.ProcessEnv,
  restored: Restored,
  say: (text: string) => Promise<void>,
) {
  const { prefixes } = file;
  const key = recordKey(file.job!);
  const found = await findEntry(store, prefixes, RECORD_VERSION, key, []);
  if (!found || found.key !== key) return;
  const body = await (await store.get(`${found.prefix}${RECORD_FILE}`)).json();
  const parsed = recordSchema.safeParse(body);
  if (!parsed.success)
    return say('ignored its job record, which it could not read');
  const record = parsed.data;
  restored.record = {
    data: record,
    ref: found.ref,
    at: createdAt(found.prefix),
  };
  if (record.off || record.container) return;
  const targets: Target[] = record.tools.map((t) => ({
    what: `${t.tool} ${t.version}`,
    key: toolKey(env.ImageOS ?? 'linux', t),
    dir: toolDir(env.RUNNER_TOOL_CACHE!, t),
  }));
  for (const d of record.deps) {
    if (record.aside.includes(d.pm)) continue;
    if (d.reset) {
      await say(
        `skipped ${d.pm}: its cache outgrew its lockfile, so it starts again`,
      );
      continue;
    }
    const dir = join(env.HOME!, PM_DIRS[d.pm]);
    targets.push({
      what: d.pm,
      key: d.key,
      dir,
      pm: d.pm,
    });
  }
  for (const pm of record.aside)
    await say(`skipped ${pm}: the job caches ${PM_DIRS[pm]} itself`);
  await Promise.all(
    targets.map(async (t) =>
      say(
        await restoreOne(store, prefixes, t, restored).catch(
          (error: unknown) =>
            `failed ${t.what}: ${String(error).slice(0, 200)}`,
        ),
      ),
    ),
  );
}

// Writes `lines` for the job-started hook to print, `restored.json` for the
// saver, then `done`, into `state`. Never throws.
export async function restore(
  tokenPath: string,
  state: string,
  env: NodeJS.ProcessEnv = process.env,
  storeOf: (tokens: Tokens) => Store = openStore,
): Promise<void> {
  const say = async (text: string) => {
    const line = `backmesh cache: auto ${text}`;
    console.log(line);
    await appendFile(join(state, 'lines'), `${line}\n`).catch(() => undefined);
  };
  const restored: Restored = { deps: {} };
  try {
    const file = await ready(tokenPath, state);
    if (file?.job)
      await restoreAll(
        file,
        storeOf(tokensFrom(tokenPath, file)),
        env,
        restored,
        say,
      );
  } catch (error) {
    await say(`failed: ${String(error).slice(0, 200)}`);
  } finally {
    await writeFile(join(state, 'restored.json'), JSON.stringify(restored));
    await writeFile(join(state, 'done'), '');
  }
}
