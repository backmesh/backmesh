import { createVerify, generateKeyPairSync } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import type {
  D1Database,
  D1Statement,
  Env,
} from '../../../worker/src/index.js';
import worker from '../../../worker/src/index.js';
import { mintKey } from '../../../worker/src/installs.js';
import {
  type CfSocket,
  type DurableObjectState,
  Relay,
} from '../../../worker/src/relay.js';

const MIGRATIONS = new URL('../../../worker/migrations/', import.meta.url);

// D1 over node:sqlite, with the Worker's migrations applied.
export function testDb(): D1Database {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync(MIGRATIONS).sort()) {
    db.exec(readFileSync(new URL(file, MIGRATIONS), 'utf8'));
  }
  const statement = (sql: string, args: unknown[] = []): D1Statement => {
    const values = args as (string | number | null)[];
    return {
      bind: (...next) => statement(sql, next),
      first: async <T>() => (db.prepare(sql).get(...values) ?? null) as T,
      all: async <T>() => ({ results: db.prepare(sql).all(...values) as T[] }),
      run: async () => db.prepare(sql).run(...values),
    };
  };
  return {
    prepare: (sql) => statement(sql),
    batch: async (statements) => {
      db.exec('BEGIN');
      try {
        const results = [];
        for (const s of statements) results.push(await s.run());
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

export const ORIGIN = 'https://api.backmesh.test';
// The App's key; GitHub checks JWTs against the public half.
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
export const appKey = (key = privateKey) =>
  key.export({ type: 'pkcs8', format: 'pem' }).toString();
export { publicKey as appPublicKey };

// A rate limiter that allows `limit` calls per key.
export const limiter = (limit = Infinity) => {
  const calls = new Map<string, number>();
  return {
    limit: async ({ key }: { key: string }) => {
      calls.set(key, (calls.get(key) ?? 0) + 1);
      return { success: calls.get(key)! <= limit };
    },
  };
};

// One end of a hibernating WebSocket: what the relay sent, how it closed,
// and when its last ping was auto-answered.
export class FakeSocket implements CfSocket {
  sent: string[] = [];
  closed?: number;
  pinged: Date | null = null;
  private attachment: unknown;
  send(data: string) {
    if (this.closed !== undefined) throw new Error('closed');
    this.sent.push(data);
  }
  close(code?: number) {
    this.closed ??= code ?? 1000;
  }
  serializeAttachment(value: unknown) {
    this.attachment = structuredClone(value);
  }
  deserializeAttachment() {
    return structuredClone(this.attachment);
  }
  frames() {
    return this.sent.map((f) => JSON.parse(f) as Record<string, unknown>);
  }
}

// A Durable Object's state: storage that survives `restart()` (an
// eviction), and its accepted sockets by tag.
export class FakeObjectState implements DurableObjectState {
  stored = new Map<string, unknown>();
  alarm?: number;
  accepted: { ws: FakeSocket; tags: string[] }[] = [];
  storage = {
    get: async <T>(key: string) => structuredClone(this.stored.get(key)) as T,
    put: async (key: string, value: unknown) =>
      void this.stored.set(key, structuredClone(value)),
    setAlarm: async (at: number) => void (this.alarm = at),
  };
  acceptWebSocket(ws: CfSocket, tags: string[] = []) {
    this.accepted.push({ ws: ws as FakeSocket, tags });
  }
  getWebSockets(tag?: string) {
    return this.accepted
      .filter((a) => a.ws.closed === undefined)
      .filter((a) => !tag || a.tags.includes(tag))
      .map((a) => a.ws);
  }
  getWebSocketAutoResponseTimestamp(ws: CfSocket) {
    return (ws as FakeSocket).pinged;
  }
  setWebSocketAutoResponse() {}
  async blockConcurrencyWhile(fn: () => Promise<void>) {
    await fn();
  }
}

// The RELAY binding: one Relay per org ID, as the runtime keeps one object
// per name. `connect` stands in for the 101 response Node can't build.
export class FakeRelays {
  objects = new Map<string, { relay: Relay; state: FakeObjectState }>();
  connects: Record<string, string>[] = [];
  object(name: string) {
    if (!this.objects.has(name)) {
      const state = new FakeObjectState();
      this.objects.set(name, { relay: new Relay(state, {}), state });
    }
    return this.objects.get(name)!;
  }
  // An eviction: a new instance on the same storage and sockets.
  restart(name: string) {
    const { state } = this.object(name);
    this.objects.set(name, { relay: new Relay(state, {}), state });
  }
  idFromName = (name: string) => name;
  get = (id: unknown) => ({
    fetch: async (request: Request) => {
      const { relay } = this.object(String(id));
      if (new URL(request.url).pathname !== '/connect') {
        return relay.fetch(request);
      }
      this.connects.push(Object.fromEntries(request.headers));
      relay.connect(request.headers.get('x-install')!, Date.now());
      return new Response('connected');
    },
  });
}

export function testEnv(): Env {
  return {
    DB: testDb(),
    RELAY: new FakeRelays(),
    SIGNIN_LIMIT: limiter(),
    INSTALL_LIMIT: limiter(),
    TOKEN_LIMIT: limiter(),
    GITHUB_APP_ID: '1',
    GITHUB_APP_SLUG: 'backmesh',
    GITHUB_APP_PRIVATE_KEY: appKey(),
  };
}

type Membership = { id: number; login: string; role: 'admin' | 'member' };
type InstallationFixture = {
  id: number;
  login: string;
  permissions: Record<string, string>;
};

// An App JWT's issuer when GitHub would accept it, else null.
function appIssuer(auth: string, key = publicKey) {
  const [header, claims, signature] = auth.replace('Bearer ', '').split('.');
  if (!signature) return null;
  const ok = createVerify('RSA-SHA256')
    .update(`${header}.${claims}`)
    .verify(key, signature, 'base64url');
  const { iss, exp } = JSON.parse(Buffer.from(claims!, 'base64url').toString());
  return ok && exp * 1000 > Date.now() ? String(iss) : null;
}

// GitHub as its documented responses, from fixed state.
export class Upstream {
  memberships = new Map<string, Membership[]>();
  calls: string[] = [];
  // Every form body sent upstream, by path.
  forms: [string, URLSearchParams][] = [];
  // GitHub user IDs by login; a test can give a login to a new account.
  userIds = new Map<string, number>();
  // Device-flow polls answered authorization_pending before the token.
  devicePending = 0;
  // Device codes GitHub refuses as used or expired.
  consumed = new Set<string>();
  // The App's installations by org ID, and the key GitHub checks JWTs with.
  installations = new Map<number, InstallationFixture>();
  appPublicKey = publicKey;
  // Each token mint's requested permissions.
  mints: Record<string, string>[] = [];
  // The repositories installation tokens can read, by `owner/repo`, with
  // their owner's ID, and their workflow runs by `owner/repo/id`.
  repos = new Map<string, { ownerId: number; private?: boolean }>();
  runs = new Map<
    string,
    {
      status: string;
      attempt: number;
      // The head repository's `owner/repo`: a fork's when it isn't the run's.
      head?: string;
      jobs: {
        conclusion: string | null;
        runner_name: string | null;
        labels?: string[];
        status?: string;
        started_at?: string | null;
      }[];
    }
  >();
  // Each `rerun-failed-jobs` call: its run, and the permissions of the
  // token it was made with (the latest mint).
  reruns: { run: string; permissions: Record<string, string> }[] = [];
  // Each `force-cancel` call, the same way.
  cancels: { run: string; permissions: Record<string, string> }[] = [];
  // The scopes GitHub grants a sign-in's token, as its answer lists them.
  oauthScope = 'read:org,read:packages';
  // Paths GitHub never answers: the request waits until it's aborted.
  silent = new Set<string>();
  // The orgs whose installation each user's token reaches, by user, when
  // not the user's memberships.
  reaches = new Map<string, number[]>();
  // Users whose token GitHub refuses (401).
  revoked = new Set<string>();
  // GitHub's status for a path it fails.
  failing = new Map<string, number>();
  // GitHub's own answer for a path, such as a rate limit or an SSO refusal.
  answers = new Map<string, () => Response>();

  fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const auth = new Headers(init.headers).get('Authorization') ?? '';
    const user = auth.replace('Bearer token-', '');
    const form = new URLSearchParams(
      typeof init.body === 'string'
        ? init.body
        : (init.body as URLSearchParams),
    );
    const path = url.pathname;
    this.calls.push(`${init.method ?? 'GET'} ${url.host}${path}`);
    this.forms.push([path, form]);
    if (this.silent.has(path)) {
      return new Promise<Response>((_, reject) =>
        init.signal?.addEventListener('abort', () =>
          reject(init.signal!.reason),
        ),
      );
    }
    const answer = this.answers.get(path);
    if (answer) return answer();
    if (this.failing.has(path)) {
      return new Response('', { status: this.failing.get(path) });
    }
    if (this.revoked.has(user)) {
      return Response.json({ message: 'Bad credentials' }, { status: 401 });
    }
    if (path === '/login/device/code') {
      return Response.json({
        device_code: 'device',
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        interval: 5,
        expires_in: 900,
      });
    }
    if (form.get('grant_type')?.endsWith('device_code')) {
      if (this.devicePending > 0) {
        this.devicePending--;
        return Response.json({ error: 'authorization_pending' });
      }
      if (this.consumed.has(form.get('device_code')!)) {
        return Response.json({ error: 'expired_token' });
      }
    }
    // The App's installations a user token reaches: GitHub lists one when
    // the user can access one of its repositories, which `reaches` sets
    // (an outside collaborator's, or a member's with no repository), else
    // the user's orgs.
    if (path === '/user/installations') {
      const orgs =
        this.reaches.get(user) ??
        (this.memberships.get(user) ?? []).map((o) => o.id);
      const installations = orgs.flatMap((id) => {
        const i = this.installations.get(id);
        return i ? [{ id: i.id, account: { id, login: i.login } }] : [];
      });
      return Response.json({
        total_count: installations.length,
        installations,
      });
    }
    if (path === '/login/oauth/access_token') {
      return Response.json({
        access_token: `token-${form.get('code') ?? form.get('device_code')}`,
        scope: this.oauthScope,
      });
    }
    if (path === '/user') {
      return Response.json({ id: this.userId(user), login: user });
    }
    // The App's user token reaches an org's runner groups only where the
    // App is installed and the person can manage the org's runners.
    const groups = path.match(/^\/orgs\/([^/]+)\/actions\/runner-groups$/);
    if (groups) {
      const org = this.org(groups[1]!);
      const m = this.memberships.get(user)?.find((o) => o.id === org?.id);
      if (!org || !m) {
        return Response.json({ message: 'Not Found' }, { status: 404 });
      }
      if (!this.installations.has(org.id) || m.role !== 'admin') {
        return Response.json(
          { message: 'Resource not accessible by integration' },
          { status: 403 },
        );
      }
      return Response.json({ total_count: 1, runner_groups: [] });
    }
    const org = path.match(/^\/orgs\/([^/]+)$/);
    if (org) {
      const found = this.org(org[1]!);
      return found
        ? Response.json(found)
        : Response.json({ message: 'Not Found' }, { status: 404 });
    }
    if (path.startsWith('/app') || /^\/orgs\/[^/]+\/installation$/.test(path))
      return this.app(path, init);
    if (auth.startsWith('Bearer ghs_')) return this.installation(path, init);
    return new Response(`unexpected ${path}`, { status: 500 });
  };

  // GitHub's public `GET /orgs/{org}`, from the orgs the fixtures name.
  private org(login: string) {
    const known = [
      ...[...this.memberships.values()].flat(),
      ...[...this.installations].map(([id, i]) => ({ id, login: i.login })),
    ].find((o) => o.login.toLowerCase() === login.toLowerCase());
    return known && { id: known.id, login: known.login };
  }

  // A repository and its runs, as an installation token reads them.
  private installation(path: string, init: RequestInit) {
    const [, owner, repo, rest] =
      path.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/) ?? [];
    const found = this.repos.get(`${owner}/${repo}`);
    if (!found) return Response.json({ message: 'Not Found' }, { status: 404 });
    if (!rest) {
      return Response.json({
        full_name: `${owner}/${repo}`,
        private: found.private ?? true,
        owner: { id: found.ownerId, login: owner },
      });
    }
    const [, id, more] = rest.match(/^\/actions\/runs\/(\d+)(\/.*)?$/) ?? [];
    const run = this.runs.get(`${owner}/${repo}/${id}`);
    if (!run) return Response.json({ message: 'Not Found' }, { status: 404 });
    if (!more) {
      return Response.json({
        id: Number(id),
        status: run.status,
        run_attempt: run.attempt,
        repository: { full_name: `${owner}/${repo}` },
        head_repository: { full_name: run.head ?? `${owner}/${repo}` },
      });
    }
    if (more === '/rerun-failed-jobs' && init.method === 'POST') {
      this.reruns.push({
        run: `${owner}/${repo}/${id}`,
        permissions: this.mints.at(-1)!,
      });
      return new Response(null, { status: 201 });
    }
    if (more === '/force-cancel' && init.method === 'POST') {
      this.cancels.push({
        run: `${owner}/${repo}/${id}`,
        permissions: this.mints.at(-1)!,
      });
      return new Response(null, { status: 202 });
    }
    if (more === `/attempts/${run.attempt}/jobs` || more === '/jobs') {
      return Response.json({ total_count: run.jobs.length, jobs: run.jobs });
    }
    return new Response(`unexpected ${path}`, { status: 500 });
  }

  private userId(login: string) {
    if (!this.userIds.has(login))
      this.userIds.set(login, this.userIds.size + 1);
    return this.userIds.get(login)!;
  }

  private app(path: string, init: RequestInit) {
    const auth = new Headers(init.headers).get('Authorization') ?? '';
    if (appIssuer(auth, this.appPublicKey) !== '1') {
      return new Response('', { status: 401 });
    }
    const all = [...this.installations].map(([org, i]) => ({ org, ...i }));
    if (path === '/app') return Response.json({ id: 1, slug: 'backmesh' });
    const installation = (i: (typeof all)[number]) =>
      Response.json({
        id: i.id,
        account: { id: i.org, login: i.login },
        permissions: i.permissions,
      });
    const byLogin = path.match(/^\/orgs\/([^/]+)\/installation$/);
    if (byLogin) {
      const found = all.find((i) => i.login === byLogin[1]);
      return found ? installation(found) : new Response('', { status: 404 });
    }
    const [, id, mint] =
      path.match(/^\/app\/installations\/(\d+)(\/access_tokens)?$/) ?? [];
    const found = all.find((i) => i.id === Number(id));
    if (!found) return new Response('', { status: 404 });
    if (init.method === 'DELETE') {
      this.installations.delete(found.org);
      return new Response(null, { status: 204 });
    }
    if (!mint) return installation(found);
    const { permissions } = JSON.parse(String(init.body)) as {
      permissions: Record<string, string>;
    };
    this.mints.push(permissions);
    const granted = Object.entries(permissions).every(
      ([name, level]) =>
        found.permissions[name] === level ||
        (level === 'read' && found.permissions[name] === 'write'),
    );
    if (!granted) return new Response('', { status: 422 });
    return Response.json(
      {
        token: `ghs_${found.id}`,
        expires_at: '2026-11-06T13:00:00Z',
        permissions,
      },
      { status: 201 },
    );
  }
}

// A browser: keeps cookies across the Worker's redirects.
export class Browser {
  private cookies = new Map<string, string>();
  constructor(private readonly env: Env) {}

  async request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set(
      'Cookie',
      [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
    );
    const res = await worker.fetch(
      new Request(ORIGIN + path, { ...init, headers }),
      this.env,
    );
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [name, value] = pair!.split('=');
      this.cookies.set(name!, value!);
    }
    return res;
  }
}

// Each org's install key, minted on first use, as `backmesh install` would.
const keys = new WeakMap<Env, Map<number, string>>();
export async function keyOf(env: Env, org: number) {
  const byOrg = keys.get(env) ?? new Map<number, string>();
  keys.set(env, byOrg);
  if (!byOrg.has(org)) byOrg.set(org, (await mintKey(env.DB, org)).key);
  return byOrg.get(org)!;
}

export const authed = async (
  env: Env,
  org: number,
  path: string,
  init: RequestInit = {},
) =>
  worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${await keyOf(env, org)}` },
    }),
    env,
  );

export const status = async (env: Env, org: number) =>
  (await authed(env, org, '/v1/status')).json();
