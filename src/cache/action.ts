// The cache action: `actions/cache`'s
// inputs and outputs, restoring file-split pieces from the region's bucket
// and snapshotting saves for the runner to upload after the job. With no
// token, or on a bucket error, it runs upstream @actions/cache unchanged.
import { lstat, mkdir, rm } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as github from '@actions/cache';
import * as core from '@actions/core';
import * as glob from '@actions/glob';

import { AUTO_PREFIX, entryVersion, esc, MAX_ESCAPED_KEY } from './format.js';
import { makeParents, restorePiece } from './pieces.js';
import {
  newUploadId,
  PLANS_DIR,
  snapshot,
  workDir,
  writePlan,
} from './snapshot.js';
import {
  findEntry,
  hasEntry,
  openCache,
  openStore,
  readManifest,
} from './store.js';

// A restore's deadline: 10 minutes, plus the entry's bytes at a cautious
// 50 MB/s once its manifest is read, at most 2 hours; past it, GitHub's cache.
export const restoreDeadlineMs = (bytes = 0) =>
  Math.min(2 * 3_600_000, 10 * 60_000 + (bytes / 50e6) * 1000);
const log = (text: string) => core.info(`backmesh cache: ${text}`);
const secs = (since: number) => `${((Date.now() - since) / 1000).toFixed(1)} s`;
const workspace = () => process.env.GITHUB_WORKSPACE ?? process.cwd();

function inputs() {
  return {
    paths: core.getMultilineInput('path', { required: true }),
    key: core.getInput('key', { required: true }),
    restoreKeys: core.getMultilineInput('restore-keys'),
    lookupOnly: core.getInput('lookup-only') === 'true',
    failOnMiss: core.getInput('fail-on-cache-miss') === 'true',
    crossOs: core.getInput('enableCrossOsArchive') === 'true',
  };
}
type Inputs = ReturnType<typeof inputs>;

// Our cache, or why not: a key too long for an object name uses GitHub's.
async function open(key: string) {
  const opened =
    esc(key).length > MAX_ESCAPED_KEY
      ? { state: 'off' as const, reason: 'key too long' }
      : await openCache();
  if (opened.state === 'off')
    log(`off (${opened.reason}); using GitHub's cache`);
  return opened;
}

// actions/cache's outputs and its miss.
function finish(i: Inputs, matched?: string) {
  if (!matched && i.failOnMiss)
    throw new Error(
      `Failed to restore cache entry. Exiting as fail-on-cache-miss is set. Input key: ${i.key}`,
    );
  if (!matched)
    return core.info(
      `Cache not found for input keys: ${[i.key, ...i.restoreKeys].join(', ')}`,
    );
  core.saveState('matched', matched);
  core.setOutput('cache-hit', String(matched === i.key));
  core.setOutput('cache-matched-key', matched);
}

const fromGitHub = async (i: Inputs) =>
  finish(
    i,
    await github.restoreCache(
      i.paths.slice(),
      i.key,
      i.restoreKeys,
      { lookupOnly: i.lookupOnly },
      i.crossOs,
    ),
  );

// Our restore: its matched key, or undefined on a miss; throws on a bucket
// error, having removed every file the entry lists if a piece failed, so a
// truncated file never stays.
async function fromBucket(
  i: Inputs,
  opened: Extract<Awaited<ReturnType<typeof openCache>>, { state: 'ready' }>,
) {
  const started = Date.now();
  const deadline = new AbortController();
  const arm = (ms: number) =>
    setTimeout(() => deadline.abort(new Error('restore deadline')), ms);
  let timer = arm(restoreDeadlineMs());
  const store = openStore(opened.tokens, globalThis.fetch, deadline.signal);
  try {
    return await restoreFrom(i, opened, store, started, (bytes) => {
      clearTimeout(timer);
      timer = arm(started + restoreDeadlineMs(bytes) - Date.now());
    });
  } finally {
    clearTimeout(timer);
  }
}

async function restoreFrom(
  i: Inputs,
  opened: Extract<Awaited<ReturnType<typeof openCache>>, { state: 'ready' }>,
  store: ReturnType<typeof openStore>,
  started: number,
  sized: (bytes: number) => void,
) {
  const { prefixes } = opened.file;
  const match = await findEntry(
    store,
    prefixes,
    entryVersion(i.paths),
    i.key,
    i.restoreKeys,
  );
  if (!match) {
    log(`miss ${i.key} (${Object.keys(prefixes).join(', ')})`);
    return undefined;
  }
  const manifest = await readManifest(store, match.prefix);
  sized(manifest.bytes);
  if (!i.lookupOnly) {
    const members = manifest.pieces.flatMap((p) => p.members);
    await makeParents(workspace(), members);
    const results = await Promise.allSettled(
      manifest.pieces.map((p) =>
        restorePiece(store, match.prefix, p, workspace()),
      ),
    );
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) {
      for (const m of members) {
        const path = resolve(workspace(), m);
        if (!(await lstat(path).catch(() => undefined))?.isDirectory())
          await rm(path, { force: true });
      }
      throw failed.reason;
    }
  }
  const size = `${(manifest.bytes / 1e9).toFixed(2)} GB in ${manifest.pieces.length} pieces`;
  log(
    `${i.lookupOnly ? 'found' : 'hit'} (${match.ref}) ${match.key}  ${size}  ${secs(started)}`,
  );
  return match.key;
}

export async function restore(): Promise<void> {
  try {
    const i = inputs();
    core.saveState('key', i.key);
    core.setOutput('cache-primary-key', i.key);
    const opened = await open(i.key);
    if (opened.state === 'off') return await fromGitHub(i);
    let matched: string | undefined;
    try {
      matched = await fromBucket(i, opened);
    } catch (error) {
      core.warning(
        `backmesh cache: restore failed (${String(error)}); using GitHub's cache`,
      );
      return await fromGitHub(i);
    }
    finish(i, matched);
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

async function toGitHub(i: Inputs) {
  await github
    .saveCache(i.paths.slice(), i.key, {}, i.crossOs)
    .catch((e: unknown) => core.warning(String(e)));
}

export async function save(key?: string): Promise<void> {
  try {
    const i = inputs();
    if (key) i.key = key;
    // The automatic caches' keys.
    if (i.key.startsWith(AUTO_PREFIX))
      return core.warning(
        `backmesh cache: keys starting with ${AUTO_PREFIX} are reserved; not saved`,
      );
    const opened = await open(i.key);
    if (opened.state === 'off') return await toGitHub(i);
    const own = opened.file.prefixes.own;
    if (!own) return log(`not saved (read-only ref) ${i.key}`);
    const version = entryVersion(i.paths);
    const held = await hasEntry(
      openStore(opened.tokens),
      own,
      version,
      i.key,
    ).catch((e: unknown) => e);
    if (held instanceof Error) {
      core.warning(`backmesh cache: ${String(held)}; using GitHub's cache`);
      return await toGitHub(i);
    }
    if (held) return log(`exists ${i.key}, not saved`);
    const paths = await (
      await glob.create(i.paths.join('\n'), { implicitDescendants: false })
    ).glob();
    if (!paths.length)
      return core.warning(
        'Path Validation Error: Path(s) specified in the action for caching do(es) not exist, hence no cache is being saved.',
      );
    const started = Date.now();
    const work = workDir(workspace());
    const uploadId = newUploadId();
    const dir = join(work, PLANS_DIR, uploadId);
    await mkdir(dir, { recursive: true });
    const { roots, copied, at } = await snapshot(paths, dir);
    const uploader = relative(
      work,
      fileURLToPath(new URL('./upload.mjs', import.meta.url)),
    );
    await writePlan(dir, {
      v: 1,
      key: i.key,
      version,
      own,
      uploadId,
      workspace: workspace(),
      roots,
      at,
      uploader,
    });
    const note = copied ? ` (${copied} copied)` : '';
    log(
      `snapshot ${i.key}  ${roots.length} paths in ${secs(started)}${note}; uploading after the job`,
    );
  } catch (error) {
    core.warning(`backmesh cache: save failed: ${String(error)}`);
  }
}

// The combined action's post step: no save after an exact hit.
export async function post(): Promise<void> {
  const key = core.getState('key');
  if (!key) return;
  if (core.getState('matched') === key)
    return core.info(
      `Cache hit occurred on the primary key ${key}, not saving cache.`,
    );
  await save(key);
}
