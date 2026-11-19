import { generateKeyPairSync, randomBytes } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  generateKey,
  openCue,
  sealCue,
  type Sealed,
} from '../../../src/cue/seal.js';
import { cueMember } from '../../../worker/src/cue.js';
import type { Env } from '../../../worker/src/index.js';
import worker from '../../../worker/src/index.js';
import { admit, keyId, type State } from '../../../worker/src/relay.js';
import {
  FakeRelays,
  FakeSocket,
  keyOf,
  limiter,
  ORIGIN,
  testEnv,
  Upstream,
} from './fakes.js';

const ORG = 11;
let env: Env;
let upstream: Upstream;
let relays: FakeRelays;
let cache: Map<string, Response>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.UTC(2026, 10, 7, 12));
  env = testEnv();
  relays = env.RELAY as FakeRelays;
  upstream = new Upstream();
  upstream.installations.set(ORG, { id: 7, login: 'acme', permissions: {} });
  for (const login of ['alice', 'bob', 'carol']) {
    upstream.memberships.set(login, [
      { id: ORG, login: 'acme', role: 'member' },
    ]);
  }
  cache = new Map();
  vi.stubGlobal('fetch', upstream.fetch);
  vi.stubGlobal('caches', {
    default: {
      match: async (k: string) => cache.get(k)?.clone(),
      put: async (k: string, r: Response) => void cache.set(k, r),
    },
  });
  vi.stubGlobal(
    'WebSocketPair',
    class {
      0 = new FakeSocket();
      1 = new FakeSocket();
    },
  );
  vi.stubGlobal('WebSocketRequestResponsePair', class {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);

const request = (path: string, init: RequestInit = {}) =>
  worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      ...init,
      headers: { 'CF-Connecting-IP': '203.0.113.7', ...init.headers },
    }),
    env,
  );
const as = (login: string, headers: Record<string, string> = {}) => ({
  Authorization: `Bearer token-${login}`,
  ...headers,
});

const keys = async (login = 'alice') =>
  (
    await request('/v1/cue/keys?org=acme', { headers: as(login) })
  ).json() as Promise<{
    org_id: number;
    keys: { kid: string; pub: string }[];
  }>;

const b64u = () => randomBytes(32).toString('base64url');
let sequence = 0;
const hash = () => (++sequence).toString(16).padStart(64, '0');
const tag = () => (++sequence).toString(16).padStart(32, '0');
const post = (
  kids: string[],
  { login = 'alice', t = tag(), h = hash(), headers = {} } = {},
) =>
  request('/v1/cue', {
    method: 'POST',
    headers: as(login, headers),
    body: JSON.stringify({
      org: 'acme',
      tag: t,
      hash: h,
      sealed: kids.map((kid) => ({ kid, enc: b64u(), ct: b64u() })),
    }),
  });

async function newKey() {
  const pub = generateKeyPairSync('x25519').publicKey.export({
    format: 'jwk',
  }).x!;
  return { kid: await keyId(Buffer.from(pub, 'base64url')), pub };
}

// A listener: connects with the org's install key, then publishes its key.
async function listen(key: { kid: string; pub: string }) {
  const install = await keyOf(env, ORG);
  const res = await request('/v1/cue/connect', {
    headers: { Authorization: `Bearer ${install}`, Upgrade: 'websocket' },
  });
  expect(res.status).toBe(200);
  const { relay, state } = relays.object(String(ORG));
  const ws = state.accepted.at(-1)!.ws;
  ws.pinged = new Date();
  await relay.webSocketMessage(ws, JSON.stringify({ type: 'key', ...key }));
  return ws;
}
const relay = () => relays.object(String(ORG)).relay;
const cues = (ws: FakeSocket) => ws.frames().filter((f) => f.type === 'cue');

describe('admit', () => {
  const fresh = (): State => ({
    pending: {},
    keys: {},
    coalesce: {},
    users: {},
    org: [],
  });

  it("coalesces a repeat of its tag's latest cue for 120 s, free of the limits", () => {
    const s = fresh();
    const [t, h] = [tag(), hash()];
    expect(admit(s, 7, t, h, 0)).toEqual({ ok: true });
    expect(admit(s, 7, t, h, 119_000)).toEqual({
      ok: false,
      reason: 'coalesced',
    });
    expect(s.org).toHaveLength(1);
    expect(admit(s, 7, t, h, 120_000)).toEqual({ ok: true });
    // A reschedule, then the first time again: each is the tag's latest.
    const later = hash();
    expect(admit(s, 7, t, later, 121_000).ok).toBe(true);
    expect(admit(s, 7, t, h, 122_000).ok).toBe(true);
    expect(admit(s, 7, t, h, 123_000).ok).toBe(false);
  });

  it('admits 10 pushes per user and 60 per org in a sliding 10 minutes', () => {
    const s = fresh();
    for (let i = 0; i < 10; i++) {
      expect(admit(s, 7, tag(), hash(), i).ok).toBe(true);
    }
    expect(admit(s, 7, tag(), hash(), 60_000)).toEqual({
      ok: false,
      reason: 'user',
      retry_s: 540,
    });
    for (let u = 8; u < 13; u++) {
      for (let i = 0; i < 10; i++) {
        expect(admit(s, u, tag(), hash(), 1000).ok).toBe(true);
      }
    }
    expect(admit(s, 99, tag(), hash(), 2000)).toMatchObject({ reason: 'org' });
    // User 7's first cue leaves the window 10 minutes after it.
    expect(admit(s, 99, tag(), hash(), 600_001).ok).toBe(true);
  });

  it('prunes state stored before tags', () => {
    const s = {
      ...fresh(),
      coalesce: { [hash()]: 5 },
      users: { 7: [1, 2] },
      org: [1, 2],
    } as unknown as State;
    expect(admit(s, 7, tag(), hash(), 10).ok).toBe(true);
    expect(s.org).toHaveLength(1);
    expect(Object.keys(s.coalesce)).toHaveLength(1);
  });

  it("counts a push's cues once, up to 5 of them", () => {
    const s = fresh();
    for (let i = 0; i < 9; i++) admit(s, 7, tag(), hash(), 0);
    const t = tag();
    for (let i = 0; i < 5; i++) {
      expect(admit(s, 7, t, hash(), 1000 + i).ok).toBe(true);
    }
    // The tag's 6th counts again: an 11th push.
    expect(admit(s, 7, t, hash(), 2000)).toMatchObject({ reason: 'user' });
  });
});

describe('cueMember', () => {
  const member = (token: string, org: string) =>
    cueMember(ORIGIN, token, org, async () => true);
  const stub = (status: number, body: unknown) => {
    const fetch = vi.fn(async (url: string) =>
      url.endsWith('/user')
        ? Response.json({ id: 5, login: 'alice' })
        : Response.json(body, { status }),
    );
    vi.stubGlobal('fetch', fetch);
    return fetch;
  };
  const installations = (...logins: string[]) => ({
    total_count: logins.length,
    installations: logins.map((login, i) => ({
      id: i + 1,
      account: { id: login === 'acme' ? ORG : 100 + i, login },
    })),
  });

  it('asks GitHub once per token and org for five minutes', async () => {
    const fetch = stub(200, installations('globex', 'acme'));
    const alice = { id: 5, login: 'alice', org_id: ORG };
    expect(await member('t', 'acme')).toEqual(alice);
    expect(await member('t', 'ACME')).toEqual(alice);
    // The user, and the App's installations the user's token reaches.
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledWith(
      'https://api.github.com/user/installations?per_page=100',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer t' }),
      }),
    );
    const [response] = [...cache.values()];
    expect(response!.headers.get('Cache-Control')).toBe('max-age=300');
    await member('other', 'acme');
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('refuses a user whose token reaches no installation on the org', async () => {
    stub(200, installations('globex'));
    expect(await member('t', 'acme')).toBeNull();
  });

  it('reports an expired token, and caches neither that nor a failure', async () => {
    stub(401, { message: 'Bad credentials' });
    expect(await member('t', 'acme')).toBe('expired');
    const fetch = stub(403, { message: 'rate limited' });
    await expect(member('t', 'acme')).rejects.toThrow('403');
    await expect(member('t', 'acme')).rejects.toThrow('403');
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(cache.size).toBe(0);
  });

  it('asks GitHub only when the limit admits it', async () => {
    const fetch = stub(200, installations('acme'));
    expect(await cueMember(ORIGIN, 't', 'acme', async () => false)).toBe(
      'limited',
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('sign-ins', () => {
  it("names the org's SAML SSO when GitHub asks for it", async () => {
    upstream.answers.set('/user/installations', () =>
      Response.json(
        { message: 'Resource protected by organization SAML enforcement.' },
        { status: 403, headers: { 'X-GitHub-SSO': 'required; url=x' } },
      ),
    );

    const res = await request('/v1/cue/keys?org=acme', {
      headers: as('alice'),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error:
        "Authorize the backmesh sign-in for acme's SAML SSO on GitHub, then sign in again.",
    });
  });

  // The listener acts on a cue only for a user GitHub says can push to its
  // repository, so the Worker's check is who reaches the org's App
  // installation through a repository, member or not.
  it('admits an outside collaborator with a repository, and refuses a member with none', async () => {
    const path = '/v1/cue/keys?org=acme';
    upstream.reaches.set('olivia', [ORG]);
    upstream.reaches.set('bob', []);

    expect((await request(path, { headers: as('olivia') })).status).toBe(200);
    const refused = await request(path, { headers: as('bob') });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error:
        "None of acme's repositories that backmesh's GitHub App is on is open to you.",
    });
  });

  it('refuses a missing or expired sign-in and a non-member', async () => {
    const path = '/v1/cue/keys?org=acme';
    expect((await request(path)).status).toBe(401);
    expect((await request(path, { headers: as('mallory') })).status).toBe(403);
    expect((await post(['a'.repeat(16)], { login: 'mallory' })).status).toBe(
      403,
    );
    upstream.revoked.add('alice');
    const expired = await request(path, { headers: as('alice') });
    expect(expired.status).toBe(401);
    upstream.revoked.delete('alice');
    upstream.failing.set('/user/installations', 502);
    expect((await request(path, { headers: as('bob') })).status).toBe(502);
  });

  it('counts GitHub checks and refused install keys against the client IP', async () => {
    env.SIGNIN_LIMIT = limiter(3);
    const path = '/v1/cue/keys?org=acme';
    expect((await request(path, { headers: as('mallory') })).status).toBe(403);
    const connect = { Authorization: `Bearer bmk_${'0'.repeat(64)}` };
    expect(
      (await request('/v1/cue/connect', { headers: connect })).status,
    ).toBe(401);
    expect((await request(path, { headers: as('alice') })).status).toBe(200);
    // Cached answers ask GitHub nothing, so they aren't counted.
    expect((await request(path, { headers: as('alice') })).status).toBe(200);
    expect((await request(path, { headers: as('mallory') })).status).toBe(403);
    const calls = upstream.calls.length;
    expect((await request(path, { headers: as('bob') })).status).toBe(429);
    expect(upstream.calls).toHaveLength(calls);
  });

  it('connects only a listener with a live install key, by WebSocket', async () => {
    const key = await keyOf(env, ORG);
    const plain = { Authorization: `Bearer ${key}` };
    expect((await request('/v1/cue/connect', { headers: plain })).status).toBe(
      426,
    );
    await listen(await newKey());
    expect(relays.connects).toEqual([
      expect.objectContaining({
        upgrade: 'websocket',
        'x-install': key.slice(4, 36),
      }),
    ]);
    await env.DB.prepare('UPDATE installs SET revoked = 1').run();
    const res = await request('/v1/cue/connect', {
      headers: { ...plain, Upgrade: 'websocket' },
    });
    expect(res.status).toBe(401);
  });

  it('limits listener connects per install', async () => {
    env.INSTALL_LIMIT = limiter(1);
    await listen(await newKey());
    const res = await request('/v1/cue/connect', {
      headers: {
        Authorization: `Bearer ${await keyOf(env, ORG)}`,
        Upgrade: 'websocket',
      },
    });
    expect(res.status).toBe(429);
  });
});

describe('the relay', () => {
  it('delivers a cue to the listener holding its key, with the signed-in user', async () => {
    const key = await newKey();
    const ws = await listen(key);
    expect(await keys()).toEqual({ org_id: ORG, keys: [key] });
    // A client can't name another user: the Worker sets x-user itself.
    const forged = JSON.stringify({ id: 1, login: 'root' });
    const res = await post([key.kid], { headers: { 'x-user': forged } });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ sent: 1, keys: [key] });
    expect(cues(ws)).toEqual([
      expect.objectContaining({
        kid: key.kid,
        user: { id: upstream.userIds.get('alice'), login: 'alice' },
        relayed_at: Date.now(),
      }),
    ]);
  });

  it('relays a real cue with a 30 s lead, which the listener opens', async () => {
    const { pair, key } = await generateKey();
    const ws = await listen(key);
    const sealed = await sealCue(
      ORG,
      key,
      {
        repo: 'acme/app',
        branch: 'main',
        user: 'alice',
        kind: 'push',
        pr: '?',
        lead_s: 30,
      },
      Date.now(),
    );
    const res = await request('/v1/cue', {
      method: 'POST',
      headers: as('alice'),
      body: JSON.stringify({
        org: 'acme',
        tag: tag(),
        hash: hash(),
        sealed: [sealed],
      }),
    });
    expect(res.status).toBe(202);
    const [frame] = cues(ws) as unknown as Sealed[];
    expect(await openCue(pair, ORG, frame!)).toMatchObject({ lead_s: 30 });
  });

  it("returns the formats a listener's key advertises, and none from an older listener", async () => {
    const key = await newKey();
    const install = await keyOf(env, ORG);
    const res = await request('/v1/cue/connect', {
      headers: { Authorization: `Bearer ${install}`, Upgrade: 'websocket' },
    });
    expect(res.status).toBe(200);
    const { relay: r, state } = relays.object(String(ORG));
    const ws = state.accepted.at(-1)!.ws;
    ws.pinged = new Date();
    await r.webSocketMessage(
      ws,
      JSON.stringify({ type: 'key', ...key, formats: [1, 2] }),
    );
    expect((await keys()).keys).toEqual([{ ...key, formats: [1, 2] }]);
    const stale = await post(['A'.repeat(16)]);
    expect(await stale.json()).toMatchObject({
      keys: [{ ...key, formats: [1, 2] }],
    });
    // A bad list is dropped, and the key still routes.
    await r.webSocketMessage(
      ws,
      JSON.stringify({ type: 'key', ...key, formats: ['x'] }),
    );
    expect((await keys()).keys).toEqual([key]);
    // An older listener's frame, with no formats, works as before.
    await r.webSocketMessage(ws, JSON.stringify({ type: 'key', ...key }));
    expect((await keys()).keys).toEqual([key]);
    expect((await post([key.kid])).status).toBe(202);
    // A key whose listener went away keeps its formats.
    await r.webSocketMessage(
      ws,
      JSON.stringify({ type: 'key', ...key, formats: [1, 2] }),
    );
    await r.webSocketClose(ws, 1006);
    expect((await keys()).keys).toEqual([{ ...key, formats: [1, 2] }]);
  });

  it('refuses a malformed cue and asks to reseal for an unknown key', async () => {
    const key = await newKey();
    await listen(key);
    const bad = await request('/v1/cue', {
      method: 'POST',
      headers: as('alice'),
      body: JSON.stringify({ org: 'acme', tag: tag(), hash: 'x', sealed: [] }),
    });
    expect(bad.status).toBe(400);
    const stale = await post(['A'.repeat(16)]);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ keys: [key] });
    const big = await request('/v1/cue', {
      method: 'POST',
      headers: as('alice'),
      body: 'x'.repeat(16_385),
    });
    expect(big.status).toBe(413);
  });

  it('coalesces a repeated hash, and rate limits the user', async () => {
    const key = await newKey();
    const ws = await listen(key);
    const [t, h] = [tag(), hash()];
    expect((await post([key.kid], { t, h })).status).toBe(202);
    const again = await post([key.kid], { t, h, login: 'bob' });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ coalesced: true });
    for (let i = 0; i < 9; i++) await post([key.kid]);
    const over = await post([key.kid]);
    expect(over.status).toBe(429);
    expect(await over.json()).toMatchObject({ reason: 'user', retry_s: 600 });
    expect(cues(ws)).toHaveLength(10);
    expect((await post([key.kid], { login: 'bob' })).status).toBe(202);
  });

  it('buffers a cue 60 s for a listener that went away, and resends until acked', async () => {
    const key = await newKey();
    const ws = await listen(key);
    await relay().webSocketClose(ws, 1006);
    // The key still routes while it's within the buffer.
    expect((await keys()).keys).toEqual([key]);
    expect(await (await post([key.kid])).json()).toMatchObject({ sent: 0 });
    advance(10_000);
    const back = await listen(key);
    const [cue] = cues(back);
    expect(cue).toBeDefined();
    // Resent on the next reconnect until acked.
    await relay().webSocketMessage(
      back,
      JSON.stringify({ type: 'ack', id: cue!.id }),
    );
    expect(cues(await listen(key))).toEqual([]);
  });

  it("replaces a push's cue still waiting with its newer one", async () => {
    const key = await newKey();
    const ws = await listen(key);
    await relay().webSocketClose(ws, 1006);
    const t = tag();
    const id = async (res: Promise<Response>) =>
      ((await (await res).json()) as { id: string }).id;
    await post([key.kid], { t });
    const newer = await id(post([key.kid], { t }));
    const other = await id(post([key.kid]));
    expect(cues(await listen(key)).map((c) => c.id)).toEqual([newer, other]);
  });

  it('forgets a listener away more than 60 s, and its cues', async () => {
    const key = await newKey();
    const ws = await listen(key);
    await relay().webSocketClose(ws, 1006);
    await post([key.kid]);
    advance(60_001);
    await relay().alarm();
    expect((await keys()).keys).toEqual([]);
    expect(cues(await listen(key))).toEqual([]);
  });

  it('closes a socket whose pings stopped, and drops a restarted listener’s old key', async () => {
    const old = await newKey();
    const ws = await listen(old);
    advance(60_001);
    expect((await keys()).keys).toEqual([old]);
    expect(ws.closed).toBe(4003);
    await post([old.kid]);
    // A restart makes a new key: the old one's buffered cue can't open.
    const fresh = await newKey();
    const back = await listen(fresh);
    expect(cues(back)).toEqual([]);
    expect((await keys()).keys).toEqual([fresh]);
    expect((await post([old.kid])).status).toBe(409);
  });

  it('keeps one socket per install', async () => {
    const key = await newKey();
    const first = await listen(key);
    const ws = await listen(key);
    expect(first.closed).toBe(4001);
    expect((await keys()).keys).toEqual([key]);
    expect(await (await post([key.kid])).json()).toMatchObject({ sent: 1 });
    expect(cues(first)).toEqual([]);
    expect(cues(ws)).toHaveLength(1);
  });

  it('ignores a key whose ID doesn’t match it', async () => {
    const key = await newKey();
    await listen({ ...key, kid: 'B'.repeat(16) });
    expect((await keys()).keys).toEqual([]);
  });

  it('keeps its state across an eviction, and lets it expire', async () => {
    const key = await newKey();
    await listen(key);
    await post([key.kid]);
    relays.restart(String(ORG));
    const { state } = relays.object(String(ORG));
    expect((await keys()).keys).toEqual([key]);
    expect(state.alarm).toBe(Date.now() + 60_050);
    advance(600_001);
    state.accepted.at(-1)!.ws.pinged = new Date();
    await relay().alarm();
    expect(state.stored.get('state')).toMatchObject({
      pending: {},
      coalesce: {},
      users: {},
      org: [],
    });
  });
});
