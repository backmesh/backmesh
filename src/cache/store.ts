// The action's token file and object store: plain HTTPS to S3, GCS or Azure
// Blob with the scoped token, so the action carries no cloud SDK; and finding
// an entry in GitHub's order. Object keys are the cache's own, all URL-safe.
import { createHash, createHmac } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { retryingFetch } from '../github/retry.js';
import {
  esc,
  SECRET_KEY,
  secretName,
  unesc,
  type CacheFile,
  type Manifest,
  type ReadyFile,
  type RefLabel,
} from './format.js';

export interface Store {
  list(prefix: string): Promise<string[]>;
  get(key: string): Promise<Response>;
  put(key: string, body: Blob): Promise<void>;
}
export type Tokens = () => Promise<ReadyFile>;
export type Opened =
  | { state: 'off'; reason: string }
  | { state: 'ready'; file: ReadyFile; tokens: Tokens };

export const TOKEN_COPY = '.backmesh-cache';
const NO_TOKEN_MARK = '.backmesh-cache-off';

// The runner's live Secret file, or runner-job's copy in RUNNER_TEMP for a
// `container:` job, wherever the job's mount puts it.
export function tokenPaths(env: NodeJS.ProcessEnv): string[] {
  const { RUNNER_NAME: name, RUNNER_TEMP: temp } = env;
  return [
    ...(name
      ? [`/run/anycloud-secrets/${secretName(name)}/${SECRET_KEY}`]
      : []),
    ...(temp ? [join(temp, TOKEN_COPY)] : []),
    `/__w/_temp/${TOKEN_COPY}`,
  ];
}

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );
// Retried once, in case a read lands mid-swap.
export async function read(path: string): Promise<CacheFile> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as CacheFile;
  } catch {
    await sleep(200);
    return JSON.parse(await readFile(path, 'utf8')) as CacheFile;
  }
}

// Waits up to `waitMs` for a `pending` file; past it, later steps fall back
// at once.
export async function openCache(
  env: NodeJS.ProcessEnv = process.env,
  waitMs = 20_000,
): Promise<Opened> {
  const mark = env.RUNNER_TEMP && join(env.RUNNER_TEMP, NO_TOKEN_MARK);
  if (mark && (await exists(mark)))
    return { state: 'off', reason: 'no token yet' };
  let path: string | undefined;
  for (const p of tokenPaths(env)) if (!path && (await exists(p))) path = p;
  if (!path) return { state: 'off', reason: 'no token file' };
  const deadline = Date.now() + waitMs;
  let file = await read(path);
  while (file.state === 'pending' && Date.now() < deadline) {
    await sleep(1_000);
    file = await read(path);
  }
  if (file.state === 'pending') {
    if (mark) await writeFile(mark, '').catch(() => undefined);
    return { state: 'off', reason: 'no token yet' };
  }
  if (file.state === 'off') return file;
  // Read at each request: a small file on tmpfs, always the latest token.
  const tokens = async () => {
    const now = await read(path);
    return now.state === 'ready' ? now : file;
  };
  return { state: 'ready', file, tokens };
}

const enc = (v: string) =>
  encodeURIComponent(v).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
const hmac = (key: string | Buffer, data: string) =>
  createHmac('sha256', key).update(data).digest();

// AWS Signature Version 4 for S3, with an unsigned payload over HTTPS.
export function signS3(
  method: string,
  url: URL,
  headers: Record<string, string>,
  creds: { accessKeyId: string; secretAccessKey: string; sessionToken: string },
  region: string,
  now: Date,
  // AWS's own examples sign the payload's hash; requests here never do.
  payload = 'UNSIGNED-PAYLOAD',
): Record<string, string> {
  const date = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const all: Record<string, string> = {
    ...headers,
    host: url.host,
    'x-amz-content-sha256': payload,
    'x-amz-date': date,
    ...(creds.sessionToken && { 'x-amz-security-token': creds.sessionToken }),
  };
  const names = Object.keys(all).sort();
  const query = [...url.searchParams]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${enc(k)}=${enc(v)}`)
    .join('&');
  const canonical = [
    method,
    url.pathname,
    query,
    names.map((n) => `${n}:${all[n]!.trim()}\n`).join(''),
    names.join(';'),
    payload,
  ].join('\n');
  const scope = `${date.slice(0, 8)}/${region}/s3/aws4_request`;
  let key: Buffer = hmac(`AWS4${creds.secretAccessKey}`, date.slice(0, 8));
  for (const part of [region, 's3', 'aws4_request']) key = hmac(key, part);
  const toSign = `AWS4-HMAC-SHA256\n${date}\n${scope}\n${createHash('sha256').update(canonical).digest('hex')}`;
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return {
    ...all,
    authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  };
}

const tag = (xml: string, name: string) =>
  [...xml.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, 'g'))].map(
    (m) => m[1]!,
  );

// `signal` ends every request, such as at a restore's deadline.
export function openStore(
  tokens: Tokens,
  fetch = globalThis.fetch,
  signal?: AbortSignal,
): Store {
  // An attempt bounds its whole body: a listing or manifest is small, so a
  // stalled one is retried soon; a piece's body may take minutes.
  const quick = retryingFetch(fetch, { max: 3, attemptTimeoutMs: 30_000 });
  const slow = retryingFetch(fetch, { max: 3, attemptTimeoutMs: 30 * 60_000 });
  // One request: signed for S3, a bearer token for GCS, the covering SAS for
  // Azure. GCS's XML API takes S3's listing, so they share it.
  async function send(
    method: string,
    key: string,
    init: RequestInit = {},
    query: Record<string, string | undefined> = {},
  ) {
    const file = await tokens();
    const token = file.tokens.find((t) =>
      t.prefixes.some((p) => key.startsWith(p)),
    );
    if (!token) throw new Error(`no token covers ${key}`);
    const c = token.credentials;
    const path = Object.keys(query).length ? '' : `/${key}`;
    const base = {
      aws: `https://${file.bucket}.s3.${file.region}.amazonaws.com`,
      gcp: `https://storage.googleapis.com/${file.bucket}`,
      azure: `${file.accountUrl?.replace(/\/$/, '')}/${file.bucket}`,
    }[file.cloud];
    const url = new URL(
      `${base}${path}${'sasToken' in c ? `?${c.sasToken}` : ''}`,
    );
    for (const [k, v] of Object.entries(query))
      if (v) url.searchParams.set(k, v);
    let headers = { ...(init.headers as Record<string, string>) };
    if ('sessionToken' in c)
      headers = signS3(method, url, headers, c, file.region!, new Date());
    if ('accessToken' in c) headers.authorization = `Bearer ${c.accessToken}`;
    if ('sasToken' in c) headers['x-ms-version'] = '2021-08-06';
    // A listing (`hasEntry` included) or a manifest, read or written.
    const small = !path || key.endsWith('/manifest.json');
    const res = await (small ? quick : slow)(url, {
      ...init,
      method,
      headers,
      signal,
    });
    if (!res.ok)
      throw new Error(
        `${method} ${key}: ${res.status} ${(await res.text()).slice(0, 200)}`,
      );
    return { res, azure: file.cloud === 'azure' };
  }
  return {
    async list(prefix) {
      const keys: string[] = [];
      for (
        let next: string | undefined, first = true;
        first || next;
        first = false
      ) {
        const azure = (await tokens()).cloud === 'azure';
        const query = azure
          ? { restype: 'container', comp: 'list', prefix, marker: next }
          : { 'list-type': '2', prefix, 'continuation-token': next };
        const xml = await (await send('GET', prefix, {}, query)).res.text();
        keys.push(...tag(xml, azure ? 'Name' : 'Key'));
        next = tag(xml, azure ? 'NextMarker' : 'NextContinuationToken')[0];
      }
      return keys;
    },
    async get(key) {
      return (await send('GET', key)).res;
    },
    async put(key, body) {
      // Azure's blob type; S3 and GCS ignore it.
      const headers = {
        'content-length': String(body.size),
        'x-ms-blob-type': 'BlockBlob',
      };
      const init = { body, headers };
      await (await send('PUT', key, init)).res.body?.cancel();
    },
  };
}

// An entry's complete instances (with a manifest) of this version under
// `ref`, newest first: an upload ID starts with its time in base 36.
async function entries(
  store: Store,
  ref: string,
  wanted: string,
  version: string,
) {
  return (await store.list(`${ref}e/${esc(wanted)}`))
    .map((k) => k.slice(ref.length).split('/'))
    .filter(
      (p) => p.length === 5 && p[2] === version && p[4] === 'manifest.json',
    )
    .map((p) => ({
      key: unesc(p[1]!),
      id: p[3]!,
      prefix: `${ref}e/${p[1]}/${version}/${p[3]}/`,
    }))
    .filter((e) => e.key.startsWith(wanted))
    .sort((a, b) => (a.id < b.id ? 1 : -1));
}

// GitHub's order, in own, then base, then default: the exact key, then a
// prefix match on it, then each restore key; the newest among matches.
export async function findEntry(
  store: Store,
  prefixes: Partial<Record<RefLabel, string>>,
  version: string,
  key: string,
  restoreKeys: readonly string[],
): Promise<{ ref: RefLabel; key: string; prefix: string } | undefined> {
  const seen = new Set<string>();
  for (const ref of ['own', 'base', 'default'] as const) {
    const at = prefixes[ref];
    if (!at || seen.has(at)) continue;
    seen.add(at);
    for (const [i, wanted] of [key, ...restoreKeys].entries()) {
      const found = await entries(store, at, wanted, version);
      const pick = (i === 0 && found.find((e) => e.key === key)) || found[0];
      if (pick) return { ref, key: pick.key, prefix: pick.prefix };
    }
  }
  return undefined;
}

export const hasEntry = async (
  store: Store,
  own: string,
  version: string,
  key: string,
) => (await entries(store, own, key, version)).some((e) => e.key === key);

export const readManifest = async (store: Store, prefix: string) =>
  (await (await store.get(`${prefix}manifest.json`)).json()) as Manifest;
