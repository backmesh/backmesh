import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createORPCClient, ORPCError } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import type { JsonifiedClient } from '@orpc/openapi-client';
import { OpenAPILink } from '@orpc/openapi-client/fetch';

import { anycloudDir } from './binary.js';
import { ANYCLOUD_VERSION, anycloudContract } from './contract.generated.js';

export type AnycloudApi = JsonifiedClient<
  ContractRouterClient<typeof anycloudContract>
>;

// The pinned binary's active API, as `api status --json` reports it
// (`docs/reference/cli/api-utilities.md:38-40` at v0.1.71), so the URL is the
// one the CLI resolves. `ANYCLOUD_API_TOKEN` counts only alongside `API_URL`,
// as in the CLI (`api-utilities.md:147-149`); a hosted API's comes from
// `anycloud api token`. None puts it in argv.
export async function apiTarget(
  env: NodeJS.ProcessEnv,
  run: (args: string[]) => Promise<string>,
  signIn: () => Promise<void>,
): Promise<{
  url: string;
  token: string;
  refresh?: (refusal: unknown) => Promise<string>;
}> {
  const url = await activeApiUrl(run);
  return {
    url,
    token: await apiToken(env, run),
    refresh: tokenRefresh(env, run, url, signIn),
  };
}

export async function activeApiUrl(
  run: (args: string[]) => Promise<string>,
): Promise<string> {
  const { url } = await run(['api', 'status', '--json'])
    .then((out) => JSON.parse(out) as { url: string })
    .catch((cause: unknown) => {
      throw new Error(
        "Couldn't read which control plane this machine uses; retry.",
        { cause },
      );
    });
  return url;
}

export async function apiToken(
  env: NodeJS.ProcessEnv,
  run: (args: string[]) => Promise<string>,
): Promise<string> {
  if (env.API_URL && env.ANYCLOUD_API_TOKEN) return env.ANYCLOUD_API_TOKEN;
  return (await run(['api', 'token'])).trim();
}

// `api token` returns the hosted API's saved token even after a rotation or a
// removal elsewhere, which that API then refuses with a 401
// (`hostedApiBearer`, `api-authentication.ts:186-190` at v0.1.72).
// `anycloud login <url>` exchanges the GitHub sign-in again and saves the
// account's current token, as the CLI's `signInRecovery` does, so the
// binary's later calls send it too. Without a GitHub sign-in it relays its
// own device code (`{"actionRequired": ...}` on stdout, exit 1); backmesh
// signs in with its own instead and exchanges again. Like the CLI,
// nothing refreshes ANYCLOUD_API_TOKEN, whose account
// may be another.
export function tokenRefresh(
  env: NodeJS.ProcessEnv,
  run: (args: string[]) => Promise<string>,
  url: string,
  signIn: () => Promise<void>,
): ((refusal: unknown) => Promise<string>) | undefined {
  if (env.API_URL && env.ANYCLOUD_API_TOKEN) return;
  return async () => {
    await run(['login', url]).catch(async (error: unknown) => {
      const stdout = (error as { stdout?: string } | undefined)?.stdout;
      if (!stdout?.includes('"actionRequired"')) throw error;
      await signIn();
      // A second relay would carry anycloud's own code and wording, so only
      // backmesh's is shown; any other failure keeps its reason.
      await run(['login', url]).catch((retry: unknown) => {
        const out = (retry as { stdout?: string } | undefined)?.stdout;
        if (!out?.includes('"actionRequired"')) throw retry;
        throw new Error(
          `${url} refused the new GitHub sign-in too; sign in as a GitHub account that can use this installation.`,
        );
      });
    });
    return apiToken(env, run);
  };
}

// A file anycloud keeps in its state directory, where an empty or missing
// one reads as none (`readSavedToken` at v0.1.72).
export const anycloudPath = (env: NodeJS.ProcessEnv, name: string) =>
  join(anycloudDir(env), name);
export const readSaved = async (path: string) =>
  (await readFile(path, 'utf8').catch(() => '')).trim();

// A refused bearer: a stale token's 401, or GITHUB_SIGN_IN_REQUIRED for the
// stale GitHub sign-in behind it. The CLI's `signInRecovery` refreshes only
// the second (`auth.ts:50-80` at v0.1.72).
const isRefused = (error: unknown) =>
  error instanceof ORPCError &&
  (error.status === 401 || error.code === 'GITHUB_SIGN_IN_REQUIRED');

// `token` is read per request when it's a function: the listener's projected
// ServiceAccount token, which the kubelet rotates (C29). With `refresh`, the
// first refused request refreshes the token, once for the client, so
// concurrent refusals share one `login`, and each refused request is retried
// once.
export function anycloudApi(
  url: string,
  token: string | (() => Promise<string>),
  fetch?: typeof globalThis.fetch,
  refresh?: (refusal: unknown) => Promise<string>,
  // Another release's client header, for a read an older API accepts only
  // from its own release (anycloud's client window).
  clientVersion = ANYCLOUD_VERSION,
): AnycloudApi {
  let bearer = token;
  let refreshed: Promise<string> | undefined;
  return createORPCClient(
    new OpenAPILink(anycloudContract, {
      url: `${url}/v1`,
      headers: async () => ({
        authorization: `Bearer ${typeof bearer === 'string' ? bearer : await bearer()}`,
        'anycloud-client-version': clientVersion,
      }),
      interceptors: refresh && [
        async ({ next }) => {
          try {
            return await next();
          } catch (error) {
            if (!isRefused(error)) throw error;
            bearer = await (refreshed ??= refresh(error));
            return next();
          }
        },
      ],
      fetch: fetch && ((request, init) => fetch(request, init)),
    }),
  );
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `command` under `/bin/sh` in a workload's container. */
export type AnycloudExec = (id: string, command: string) => Promise<ExecResult>;

// `anycloud exec` as its own API route (`POST /v1/workloads/{id}/exec`,
// newline-delimited JSON events, as `executeWorkloadCommand` reads them
// at v0.1.78), so a command that writes a listener's settings is never in
// argv on this machine or in the API's records: the API records the call
// but not its command. A refused bearer is refreshed once for the client,
// as `anycloudApi` does.
export function anycloudExec(
  url: string,
  token: string,
  fetch: typeof globalThis.fetch = globalThis.fetch,
  refresh?: (refusal: unknown) => Promise<string>,
): AnycloudExec {
  let bearer = token;
  let refreshed: Promise<string> | undefined;
  const post = (id: string, command: string) =>
    fetch(`${url}/v1/workloads/${encodeURIComponent(id)}/exec`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/x-ndjson',
        authorization: `Bearer ${bearer}`,
        'anycloud-client-version': ANYCLOUD_VERSION,
      },
      body: JSON.stringify({ command }),
    });
  return async (id, command) => {
    let response = await post(id, command);
    if (response.status === 401 && refresh) {
      bearer = await (refreshed ??= refresh(response));
      response = await post(id, command);
    }
    const text = await response.text();
    if (!response.ok) {
      const reason = (() => {
        try {
          return (JSON.parse(text) as { message?: string }).message;
        } catch {
          return undefined;
        }
      })();
      throw new Error(
        `anycloud exec ${id} failed: ${reason ?? `HTTP ${response.status}`}`,
      );
    }
    // Each stream's chunks are decoded together, so a character split
    // across two events stays whole.
    const out: Record<'stdout' | 'stderr', Buffer[]> = {
      stdout: [],
      stderr: [],
    };
    let code: number | undefined;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let event: { type: string; data?: string; code?: number; error?: string };
      try {
        event = JSON.parse(line) as typeof event;
      } catch (cause) {
        throw new Error(`anycloud exec ${id} answered with something else.`, {
          cause,
        });
      }
      if (event.type === 'stdout' || event.type === 'stderr')
        out[event.type].push(Buffer.from(event.data ?? '', 'base64'));
      else if (event.type === 'exit') code = event.code;
      else if (event.type === 'error')
        throw new Error(`anycloud exec ${id} failed: ${event.error}`);
    }
    if (code === undefined) {
      throw new Error(`anycloud exec ${id} ended without an exit code.`);
    }
    return {
      code,
      stdout: Buffer.concat(out.stdout).toString(),
      stderr: Buffer.concat(out.stderr).toString(),
    };
  };
}
