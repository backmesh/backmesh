// The pinned `anycloud` binary: backmesh drives it with `--json`
// where the API has no route, such as the catalog and `api create`. Its
// arguments hold nothing secret. backmesh fetches it
// on first use and runs it with its own state directory, so the user never
// installs, types or configures it.
import { execFile, spawn, type StdioOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { ANYCLOUD_SHA256, ANYCLOUD_VERSION } from './contract.generated.js';

/** Runs `anycloud <args>` and resolves with its stdout. */
// `env` adds variables to the child's environment.
export type RunAnycloud = (
  args: string[],
  env?: NodeJS.ProcessEnv,
) => Promise<string>;

const execFileAsync = promisify(execFile);

// anycloud's state (its local API, sign-in and saved tokens), apart from any
// anycloud the user runs, whose own `ANYCLOUD_DIR` backmesh ignores.
// `BACKMESH_ANYCLOUD_DIR` overrides it: our CI keeps its `~/.anycloud`.
export const anycloudDir = (env: NodeJS.ProcessEnv) =>
  env.BACKMESH_ANYCLOUD_DIR || join(homedir(), '.backmesh', 'anycloud');

const binaryPath = () =>
  join(homedir(), '.backmesh', 'bin', ANYCLOUD_VERSION, 'anycloud');

const RELEASES = 'https://github.com/anycloud-sh/releases/releases/download';

// The release's platform name: the four backmesh is built for.
export function platformOf(platform: NodeJS.Platform, arch: string): string {
  const name = `${platform}-${arch}`;
  if (!ANYCLOUD_SHA256[name]) {
    throw new Error(`backmesh doesn't run on ${name}.`);
  }
  return name;
}

// Downloads the pinned release's binary for this platform into `path`,
// refusing any whose digest isn't the pinned one. It's unpacked beside
// `path` and renamed into place, so a failed run leaves no binary behind.
export async function fetchBinary(
  path: string,
  platform: string,
  fetch: typeof globalThis.fetch = globalThis.fetch,
  expected = ANYCLOUD_SHA256[platform],
) {
  const asset = `anycloud-${platform}.tar.gz`;
  const url = `${RELEASES}/v${ANYCLOUD_VERSION}/${asset}`;
  const res = await fetch(url).catch((cause: unknown) => {
    throw new Error(`Couldn't download backmesh's runtime from ${url}.`, {
      cause,
    });
  });
  if (!res.ok) {
    throw new Error(
      `Couldn't download backmesh's runtime from ${url}: HTTP ${res.status}.`,
    );
  }
  const body = Buffer.from(await res.arrayBuffer());
  const digest = createHash('sha256').update(body).digest('hex');
  if (digest !== expected) {
    throw new Error(
      `backmesh's runtime from ${url} has the SHA-256 ${digest}, not the pinned ${expected}. Nothing was installed.`,
    );
  }
  const dir = join(path, '..');
  await mkdir(dir, { recursive: true });
  const work = await mkdtemp(join(dir, '.fetch-'));
  try {
    await writeFile(join(work, asset), body);
    await execFileAsync('tar', ['-xzf', asset, 'anycloud'], { cwd: work });
    await rename(join(work, 'anycloud'), path);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

let resolved: Promise<string> | undefined;

// The binary's path, fetched the first time any command needs it.
async function binary(): Promise<string> {
  resolved ??= (async () => {
    const path = binaryPath();
    // A missing or empty file is fetched again; a directory there fails the
    // fetch's rename instead of being run.
    const found = await stat(path).catch(() => undefined);
    if (!found?.isFile() || found.size === 0)
      await fetchBinary(path, platformOf(process.platform, process.arch));
    return path;
  })().catch((error: unknown) => {
    resolved = undefined;
    throw error;
  });
  return resolved;
}

const childEnv = () => ({
  ...process.env,
  ANYCLOUD_DIR: anycloudDir(process.env),
});

// A failed call names the step and anycloud's own reason, never the
// `Command failed: <path> <args>` line, and keeps stdout for
// `relayedAction`, and stderr for `api create`'s progress.
export class StepFailed extends Error {
  constructor(
    args: readonly string[],
    readonly stdout: string,
    readonly stderr: string,
    options: { cause: unknown },
  ) {
    // With `--json`, `api create` and `api delete` print their
    // failure as `{"error":{"code","message"}}` on stdout and progress on
    // stderr. A binary that didn't start (ENOENT, EACCES) printed nothing.
    const reason =
      jsonError(stdout) ||
      stderr.trim() ||
      stdout.trim().split('\n').at(-1) ||
      (options.cause instanceof Error ? options.cause.message : '');
    super(
      `${args
        .filter((arg) => !arg.startsWith('-'))
        .slice(0, 2)
        .join(' ')} failed${reason ? `: ${reason}` : '.'}`,
      options,
    );
  }
}

function jsonError(stdout: string): string | undefined {
  try {
    const { error } = JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as {
      error?: { code?: string; message?: string };
    };
    if (error?.message)
      return error.code ? `${error.message} (${error.code})` : error.message;
  } catch {
    // Not a JSON line.
  }
  return undefined;
}

/** 0 waits for as long as the command runs, as `cluster status --watch` does. */
export const anycloudBinary =
  (timeoutMs: number): RunAnycloud =>
  async (args, env) => {
    const file = await binary();
    return execFileAsync(file, args, {
      env: { ...childEnv(), ...env },
      maxBuffer: 64 << 20,
      timeout: timeoutMs,
    }).then(
      ({ stdout }) => stdout,
      (error: { stdout?: string; stderr?: string }) => {
        throw new StepFailed(args, error.stdout ?? '', error.stderr ?? '', {
          cause: error,
        });
      },
    );
  };

/** `vm-types` reads the catalog, which it may download first. */
export const runAnycloud = anycloudBinary(120_000);

/**
 * Runs `anycloud <args>` on this terminal, as `logs` does; resolves with its
 * exit code. `toStderr` sends its output to stderr, so `--json`'s stdout
 * carries only the result.
 */
export async function streamAnycloud(
  args: string[],
  toStderr = false,
): Promise<number> {
  const file = await binary();
  const stdio: StdioOptions = toStderr ? ['inherit', 2, 'inherit'] : 'inherit';
  return new Promise((resolve, reject) => {
    spawn(file, args, { env: childEnv(), stdio })
      .on('error', reject)
      .on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}
