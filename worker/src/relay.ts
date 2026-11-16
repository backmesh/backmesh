// The cue relay (`backmesh cue`): one Durable Object
// per org, named by the org's ID, that holds the org's listener WebSockets
// (hibernating), rate limits and coalesces cues, and buffers each for 60 s
// until a listener acks it. It only ever sees ciphertext: a cue is sealed
// with HPKE to a listener's key, so the relay learns the org, the signed-in
// user, when and how big, never the repo, branch or commit.
//
// Each cue carries its push's tag: random, made by the CLI per repo and
// branch and kept 10 minutes (src/cli/cue.ts), so the relay can tell a
// push's cues apart from another push's within those minutes but learns no
// names, and nothing links one tag to the next. Its hash is equal for
// repeats of a cue: the same push, time and kind, under a salt only the CLI
// holds.
//
// A listener makes one key at start and keeps it for its process's life.
// The listener's socket (GET /v1/cue/connect, cue.ts) speaks JSON text:
//   listener → relay  `ping` every 20 s, answered `pong` without waking the
//                     object; `{ type: 'key', kid, pub }` on every connect;
//                     `{ type: 'ack', id }` once a cue is handled.
//   relay → listener  `{ type: 'cue', id, kid, enc, ct, user: { id, login },
//                     relayed_at }`, resent on reconnect until acked.
// `pub` is a raw X25519 public key and `kid` the first 16 characters of the
// base64url SHA-256 of it, both base64url; `enc` is HPKE's 32-byte
// encapsulated key.

// The subset of the Workers runtime the relay uses.
export interface CfSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}
export interface DurableObjectState {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    setAlarm(at: number): Promise<void>;
  };
  acceptWebSocket(ws: CfSocket, tags?: string[]): void;
  getWebSockets(tag?: string): CfSocket[];
  getWebSocketAutoResponseTimestamp(ws: CfSocket): Date | null;
  setWebSocketAutoResponse(pair: unknown): void;
  blockConcurrencyWhile(fn: () => Promise<void>): Promise<void>;
}
export interface RelayNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}
declare const WebSocketPair: new () => { 0: CfSocket; 1: CfSocket };
declare const WebSocketRequestResponsePair: new (
  request: string,
  response: string,
) => unknown;

// Owner, 2026-11-07: 10 pushes' cues per user and 60 per org in a sliding
// 10 minutes; a repeat within 120 s is free and never delivered twice. A cue
// waits 60 s for a listener. Owner, 2026-11-08: a push's cues (one tag)
// count once; past `per_push` of them, each `per_push` more count again, so
// a tag can't carry unlimited cues.
export const LIMITS = {
  user_max: 10,
  org_max: 60,
  window_ms: 600_000,
  coalesce_ms: 120_000,
  buffer_ms: 60_000,
  per_push: 5,
};
// Three missed 20 s pings: a listener that died without a close.
const STALE_MS = 60_000;

interface Pending {
  kid: string;
  tag: string;
  frame: string;
  expires: number;
}
// An admitted cue, for the windows.
interface Admitted {
  at: number;
  tag: string;
}
export interface State {
  pending: Record<string, Pending>; // by `${cue id}:${kid}`
  // Every key a listener published. One no live socket holds still routes
  // for buffer_ms from when that was first seen (`gone`), however the socket
  // ended: a close, a crash or a redeploy that never ran webSocketClose.
  // `formats`: the cue formats it opens, when it said (a listener from
  // before formats doesn't).
  keys: Record<
    string,
    { pub: string; install: string; gone?: number; formats?: number[] }
  >;
  // A tag's latest cue's hash, a repeat of which is coalesced until `until`.
  coalesce: Record<string, { hash: string; until: number }>;
  users: Record<string, Admitted[]>; // by user ID, oldest first
  org: Admitted[];
}
interface Attachment {
  install: string;
  connected_at: number;
  key?: { kid: string; pub: string; formats?: number[] };
}
export type Verdict =
  | { ok: true }
  | { ok: false; reason: 'coalesced' }
  | { ok: false; reason: 'user' | 'org'; retry_s: number };

const KID = /^[A-Za-z0-9_-]{16}$/;
const TAG = /^[0-9a-f]{32}$/;
const B64U = /^[A-Za-z0-9_-]+$/;
const json = (body: unknown, status = 200) => Response.json(body, { status });
const emptyState = (): State => ({
  pending: {},
  keys: {},
  coalesce: {},
  users: {},
  org: [],
});

// The key ID the CLI and listener derive the same way.
export async function keyId(pub: Uint8Array) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', pub));
  return btoa(String.fromCharCode(...digest))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .slice(0, 16);
}

const fromB64u = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
    c.charCodeAt(0),
  );

// Drops coalescing hashes and window entries that have run out.
function prune(state: State, now: number) {
  for (const [tag, c] of Object.entries(state.coalesce)) {
    if (!(c.until > now)) delete state.coalesce[tag];
  }
  const since = now - LIMITS.window_ms;
  for (const [u, cues] of Object.entries(state.users)) {
    const kept = cues.filter((c) => c.at > since);
    if (kept.length) state.users[u] = kept;
    else delete state.users[u];
  }
  state.org = state.org.filter((c) => c.at > since);
}

// What cues count as against a limit: each tag once per `per_push` cues.
function pushes(cues: Admitted[]) {
  const per = Map.groupBy(cues, (c) => c.tag);
  return [...per.values()].reduce(
    (n, mine) => n + Math.ceil(mine.length / LIMITS.per_push),
    0,
  );
}

// Coalescing first (a repeat of its tag's latest cue is free), then the
// per-user and per-org windows. Records the cue in `state` when admitted.
export function admit(
  state: State,
  userId: number,
  tag: string,
  hash: string,
  now: number,
): Verdict {
  prune(state, now);
  if (state.coalesce[tag]?.hash === hash) {
    return { ok: false, reason: 'coalesced' };
  }
  const cue = { at: now, tag };
  const mine = state.users[String(userId)] ?? [];
  const retry = (cues: Admitted[]) =>
    Math.ceil((cues[0]!.at + LIMITS.window_ms - now) / 1000);
  if (pushes([...mine, cue]) > LIMITS.user_max) {
    return { ok: false, reason: 'user', retry_s: retry(mine) };
  }
  if (pushes([...state.org, cue]) > LIMITS.org_max) {
    return { ok: false, reason: 'org', retry_s: retry(state.org) };
  }
  state.coalesce[tag] = { hash, until: now + LIMITS.coalesce_ms };
  state.users[String(userId)] = [...mine, cue];
  state.org.push(cue);
  return { ok: true };
}

// A cue as the CLI posts it, or null when malformed.
function parseCue(body: unknown) {
  const { tag, hash, sealed } = (body ?? {}) as {
    tag?: unknown;
    hash?: unknown;
    sealed?: unknown;
  };
  if (typeof tag !== 'string' || !TAG.test(tag)) return null;
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return null;
  if (!Array.isArray(sealed) || sealed.length === 0 || sealed.length > 4) {
    return null;
  }
  const valid = sealed.every(
    (s: { kid?: unknown; enc?: unknown; ct?: unknown }) =>
      typeof s?.kid === 'string' &&
      KID.test(s.kid) &&
      typeof s.enc === 'string' &&
      B64U.test(s.enc) &&
      s.enc.length === 43 &&
      typeof s.ct === 'string' &&
      B64U.test(s.ct) &&
      s.ct.length <= 2048,
  );
  return valid
    ? {
        tag,
        hash,
        sealed: sealed as { kid: string; enc: string; ct: string }[],
      }
    : null;
}

// A socket getWebSockets() still lists can be closing.
function send(ws: CfSocket, data: string) {
  try {
    ws.send(data);
    return true;
  } catch {
    return false;
  }
}

export class Relay {
  // Loaded once per wake and changed only synchronously, so handlers that
  // interleave at an await never work on a stale copy.
  private state = emptyState();

  constructor(
    private readonly ctx: DurableObjectState,
    _env: unknown,
  ) {
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong'),
    );
    void ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get<State>('state')) ?? emptyState();
    });
  }

  // Persists the state and wakes the object when the next entry runs out,
  // so user IDs and ciphertext leave storage even when nothing else happens.
  private async save(now: number) {
    const state = this.state;
    for (const [k, p] of Object.entries(state.pending)) {
      if (p.expires <= now) delete state.pending[k];
    }
    await this.ctx.storage.put('state', state);
    const next = Math.min(
      ...Object.values(state.pending).map((p) => p.expires),
      ...[state.org[0], ...Object.values(state.users).map((c) => c[0])]
        .filter((c) => c !== undefined)
        .map((c) => c.at + LIMITS.window_ms),
      ...Object.values(state.keys).flatMap((k) =>
        k.gone ? [k.gone + LIMITS.buffer_ms] : [],
      ),
      ...Object.values(state.coalesce).map((c) => c.until),
    );
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next + 50);
  }

  // Live sockets. Pings never wake the
  // object, so a socket whose last ping is stale is closed here.
  private sockets(now: number, except?: CfSocket) {
    return this.ctx.getWebSockets().flatMap((ws) => {
      if (ws === except) return [];
      const a = ws.deserializeAttachment() as Attachment;
      const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws);
      if (now - Math.max(pinged?.getTime() ?? 0, a.connected_at) > STALE_MS) {
        try {
          ws.close(4003, 'stale');
        } catch {
          // Already closing.
        }
        return [];
      }
      return [{ ws, key: a.key }];
    });
  }

  // Marks keys no live socket holds as gone, and forgets them (with their
  // buffered cues) buffer_ms later. Returns the key IDs that route.
  private sweep(now: number, except?: CfSocket) {
    const live = new Set(this.sockets(now, except).map((s) => s.key?.kid));
    for (const [kid, k] of Object.entries(this.state.keys)) {
      if (live.has(kid)) {
        delete k.gone;
        continue;
      }
      k.gone ??= now;
      if (k.gone + LIMITS.buffer_ms <= now) this.forget(kid);
    }
    return new Set(Object.keys(this.state.keys));
  }

  private forget(kid: string) {
    delete this.state.keys[kid];
    for (const [pk, p] of Object.entries(this.state.pending)) {
      if (p.kid === kid) delete this.state.pending[pk];
    }
  }

  // What the CLI seals to: each live listener's key, then keys whose
  // listener went away within buffer_ms (their cues wait for it).
  private published(now: number) {
    const live = this.sockets(now).flatMap(({ key }) => (key ? [key] : []));
    const away = Object.entries(this.state.keys)
      .filter(([, k]) => k.gone)
      .map(([kid, k]) => ({
        kid,
        pub: k.pub,
        ...(k.formats && { formats: k.formats }),
      }));
    return [...live, ...away].slice(0, 4);
  }

  // Accepts an install's listener socket and returns the client end. One
  // socket per install: a reconnect replaces the old one, whose keys then
  // wait buffer_ms for the new socket to present them again.
  connect(install: string, now: number) {
    for (const old of this.ctx.getWebSockets(install)) {
      const { key: _, ...rest } = old.deserializeAttachment() as Attachment;
      old.serializeAttachment(rest);
      try {
        old.close(4001, 'replaced');
      } catch {
        // Already closing.
      }
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [install]);
    const attachment: Attachment = { install, connected_at: now };
    pair[1].serializeAttachment(attachment);
    return pair[0];
  }

  // The Worker (cue.ts) sends only what it vouches for: x-install on
  // /connect, x-user on /cue.
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const now = Date.now();
    if (path === '/connect') {
      const init: ResponseInit & { webSocket: CfSocket } = {
        status: 101,
        webSocket: this.connect(request.headers.get('x-install') ?? '', now),
      };
      return new Response(null, init);
    }
    // Read before the sweep: a socket's message can run during this await.
    const body =
      path === '/cue' ? await request.json().catch(() => null) : undefined;
    const before = JSON.stringify(this.state.keys);
    const routable = this.sweep(now);
    const changed = () => JSON.stringify(this.state.keys) !== before;
    if (path === '/keys') {
      if (changed()) await this.save(now);
      return json({ keys: this.published(now) });
    }
    if (path !== '/cue') return json({ error: 'Not found.' }, 404);
    const user = JSON.parse(request.headers.get('x-user') ?? '{}') as {
      id: number;
      login: string;
    };
    const cue = parseCue(body);
    if (!cue) return json({ error: 'Malformed cue.' }, 400);
    const keys = this.published(now);
    const known = cue.sealed.filter((s) => routable.has(s.kid));
    if (known.length === 0) {
      if (changed()) await this.save(now);
      return json({ error: 'Unknown key; reseal.', keys }, 409);
    }
    const verdict = admit(this.state, user.id, cue.tag, cue.hash, now);
    if (!verdict.ok && verdict.reason !== 'coalesced') {
      return json({ error: 'Too many cues.', ...verdict }, 429);
    }
    if (!verdict.ok) {
      await this.save(now);
      return json({ coalesced: true, keys });
    }
    // A push's newer cue replaces any of its cues still waiting.
    for (const [pk, p] of Object.entries(this.state.pending)) {
      if (p.tag === cue.tag) delete this.state.pending[pk];
    }
    const id = crypto.randomUUID();
    let sent = 0;
    for (const s of known) {
      const frame = JSON.stringify({
        type: 'cue',
        id,
        ...s,
        user: { id: user.id, login: user.login },
        relayed_at: now,
      });
      this.state.pending[`${id}:${s.kid}`] = {
        kid: s.kid,
        tag: cue.tag,
        frame,
        expires: now + LIMITS.buffer_ms,
      };
      for (const { ws, key } of this.sockets(now)) {
        if (key?.kid === s.kid && send(ws, frame)) sent++;
      }
    }
    await this.save(now);
    return json({ id, sent, keys }, 202);
  }

  async webSocketMessage(ws: CfSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string' || message.length > 2048) return;
    let msg: {
      type?: unknown;
      id?: unknown;
      kid?: unknown;
      pub?: unknown;
      formats?: unknown;
    };
    try {
      msg = JSON.parse(message) as typeof msg;
    } catch {
      return;
    }
    const a = ws.deserializeAttachment() as Attachment;
    if (msg.type === 'ack' && typeof msg.id === 'string') {
      // Not saved: a resend after an eviction is harmless (the listener
      // dedupes), and this halves the object's row writes.
      delete this.state.pending[`${msg.id}:${a.key?.kid}`];
      return;
    }
    // 32 bytes, unpadded.
    if (msg.type !== 'key' || typeof msg.pub !== 'string') return;
    if (msg.pub.length !== 43 || !B64U.test(msg.pub)) return;
    const kid = await keyId(fromB64u(msg.pub));
    if (kid !== msg.kid) return;
    const now = Date.now();
    // Optional and additive: a listener from before formats sends none.
    const formats =
      Array.isArray(msg.formats) &&
      msg.formats.length > 0 &&
      msg.formats.length <= 8 &&
      msg.formats.every((f) => Number.isInteger(f) && f > 0 && f < 1000)
        ? (msg.formats as number[])
        : undefined;
    a.key = { kid, pub: msg.pub, ...(formats && { formats }) };
    ws.serializeAttachment(a);
    // A key this install published before died with its process (a
    // restart): its buffered cues can never be opened.
    for (const [old, k] of Object.entries(this.state.keys)) {
      if (k.install === a.install && old !== kid) this.forget(old);
    }
    this.state.keys[kid] = {
      pub: msg.pub,
      install: a.install,
      ...(formats && { formats }),
    };
    this.sweep(now);
    for (const p of Object.values(this.state.pending)) {
      if (p.kid === kid && p.expires > now) send(ws, p.frame);
    }
    await this.save(now);
  }

  async webSocketClose(ws: CfSocket, code: number) {
    try {
      ws.close(code === 1005 ? 1000 : code);
    } catch {
      // Already closed.
    }
    const now = Date.now();
    this.sweep(now, ws);
    await this.save(now);
  }

  async webSocketError(ws: CfSocket) {
    await this.webSocketClose(ws, 1011);
  }

  async alarm() {
    const now = Date.now();
    prune(this.state, now);
    this.sweep(now);
    await this.save(now);
  }
}
