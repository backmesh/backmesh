// The listener's side of `backmesh cue`: one outbound
// WebSocket to the org's relay at api.backmesh.com, signed in with the
// install key (worker/src/relay.ts has the protocol). It makes an X25519 key
// at start, held only in memory, opens each cue, and hands the planner only
// cues that are fresh, unseen, from the user the relay signed in, for a repo
// of this org that GitHub says the user can push to, within an hourly
// budget. Scaling never waits on it: a relay that's down only loses cues.
import type { Log } from '../github/retry.js';
import {
  CUE_FORMATS,
  CueFormatError,
  generateKey,
  openCue,
  validBranch,
  validRepo,
  type Cue,
  type KeyPair,
  type PublicKey,
  type Sealed,
} from '../cue/seal.js';

// The relay closes a socket that hasn't pinged for 60 s; this end drops a
// socket with no pong for 30 s at its next ping, and dials again.
export const PING_MS = 20_000;
const PONG_TIMEOUT_MS = 10_000;
const HANDSHAKE_MS = 10_000;
const BACKOFF_MS = [250, 30_000];
// A cue sealed longer ago than this is refused, and nonces are kept twice as
// long so a replay inside the window is caught.
const FRESH_MS = 120_000;
// Pushes acted on per hour, whatever the relay admits. A push's cues, a
// repo and branch's within 10 minutes of its first (the relay's limit
// window, which also spans the longest lead), count as one: a lead, its
// reschedules and a cancel.
export const BUDGET_PER_HOUR = 60;
const PUSH_MS = 600_000;
const PERMISSION_TTL_MS = 300_000;
const WRITE = new Set(['admin', 'maintain', 'write']);

interface Frame extends Sealed {
  type: 'cue';
  id: string;
  user: { id: number; login: string };
}

export interface CueListenerDeps {
  url: string; // the Worker, https://api.backmesh.com
  installKey: string;
  org: string;
  orgId: () => Promise<number>;
  // The user's permission on the repo, from the installation token, such as
  // `write`; GitHub's 404 is `none`.
  permission: (repo: string, user: string) => Promise<string>;
  // A cue that passed every check, with its lead left in ms.
  onCue: (cue: Cue, leadMs: number) => void;
  log: Log;
  now?: () => number;
  // Node 22's global WebSocket, which takes headers (undici).
  WebSocket?: typeof WebSocket;
}

export class CueListener {
  private key?: { pair: KeyPair; key: PublicKey };
  private orgId?: number;
  private ws?: WebSocket;
  private attempt = 0;
  private stopped = false;
  private lastPong = 0;
  private pinger?: ReturnType<typeof setInterval>;
  private handshake?: ReturnType<typeof setTimeout>;
  private retry?: ReturnType<typeof setTimeout>;
  private readonly seen = new Map<string, number>();
  private readonly permissions = new Map<string, { p: string; at: number }>();
  private acted: { at: number; push: string }[] = [];

  constructor(private readonly deps: CueListenerDeps) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  async start() {
    this.key = await generateKey();
    if (this.stopped) return;
    this.connect();
    this.pinger = setInterval(() => this.heartbeat(), PING_MS);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.pinger);
    clearTimeout(this.handshake);
    clearTimeout(this.retry);
    this.ws?.close(1000, 'stopped');
  }

  private connect() {
    if (this.stopped) return;
    const url = new URL('/v1/cue/connect', this.deps.url);
    url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
    const Socket = this.deps.WebSocket ?? WebSocket;
    // undici's WebSocket takes headers in place of protocols.
    const init = {
      headers: { Authorization: `Bearer ${this.deps.installKey}` },
    };
    const ws = new Socket(url, init as unknown as string[]);
    this.ws = ws;
    // A handshake that hangs (a proxy mid-restart) is dropped.
    clearTimeout(this.handshake);
    const handshake = setTimeout(() => {
      if (ws === this.ws && ws.readyState === ws.CONNECTING) this.drop(4002);
    }, HANDSHAKE_MS);
    this.handshake = handshake;
    ws.onopen = () => {
      clearTimeout(handshake);
      this.attempt = 0;
      this.lastPong = this.now();
      ws.send(
        JSON.stringify({ type: 'key', ...this.key!.key, formats: CUE_FORMATS }),
      );
      this.deps.log({ msg: 'cue relay connected' });
    };
    ws.onmessage = (event) => {
      if (ws !== this.ws) return;
      const data = String(event.data);
      if (data === 'pong') {
        this.lastPong = this.now();
        return;
      }
      // Nothing a cue does may take the listener down.
      this.handle(data).catch((error: unknown) =>
        this.deps.log({ msg: 'cue check failed', error: String(error) }),
      );
    };
    ws.onclose = (event) => {
      clearTimeout(handshake);
      if (ws !== this.ws) return;
      this.deps.log({ msg: 'cue relay closed', code: event.code });
      this.ws = undefined;
      this.reconnect();
    };
    ws.onerror = () => {};
  }

  // Drops the socket and dials again.
  private drop(code: number) {
    const old = this.ws;
    this.ws = undefined;
    old?.close(code);
    this.deps.log({ msg: 'cue relay dropped', code });
    this.reconnect();
  }

  // Exponential backoff with jitter, from 250 ms to 30 s.
  private reconnect() {
    if (this.stopped) return;
    const base = Math.min(BACKOFF_MS[1]!, BACKOFF_MS[0]! * 2 ** this.attempt++);
    clearTimeout(this.retry);
    this.retry = setTimeout(
      () => this.connect(),
      base * (0.5 + Math.random() / 2),
    );
  }

  private heartbeat() {
    if (this.ws?.readyState !== this.ws?.OPEN || !this.ws) return;
    if (this.now() - this.lastPong > PING_MS + PONG_TIMEOUT_MS) {
      this.drop(4000);
      return;
    }
    this.ws.send('ping');
  }

  private refuse(frame: Frame, reason: string) {
    this.deps.log({ msg: 'cue refused', id: frame.id, reason });
  }

  private async handle(data: string) {
    let frame: Frame;
    try {
      frame = JSON.parse(data) as Frame;
    } catch {
      return;
    }
    if (frame?.type !== 'cue' || typeof frame.id !== 'string') return;
    // Acked whatever the verdict, so the relay stops resending it.
    this.ws?.send(JSON.stringify({ type: 'ack', id: frame.id }));
    if (frame.kid !== this.key!.key.kid) return this.refuse(frame, 'key');
    // Looked up at the first cue, and again until it answers.
    this.orgId ??= await this.deps.orgId();
    let cue: Cue;
    try {
      cue = await openCue(this.key!.pair, this.orgId, frame);
    } catch (error) {
      // An older or newer CLI's format, which the CLI learns from the
      // formats this key advertises; else a cue that doesn't open at all.
      if (error instanceof CueFormatError) {
        return this.refuse(frame, error.message);
      }
      return this.refuse(frame, 'does not open');
    }
    const now = this.now();
    for (const [nonce, ts] of this.seen) {
      if (ts < now - 2 * FRESH_MS) this.seen.delete(nonce);
    }
    if (Math.abs(now - cue.ts) > FRESH_MS) return this.refuse(frame, 'stale');
    if (this.seen.has(cue.nonce)) return this.refuse(frame, 'replay');
    this.seen.set(cue.nonce, cue.ts);
    if (cue.user.toLowerCase() !== frame.user?.login?.toLowerCase()) {
      return this.refuse(frame, 'user');
    }
    const owner = cue.repo.split('/')[0]!;
    if (
      !validRepo(cue.repo) ||
      !validBranch(cue.branch) ||
      owner.toLowerCase() !== this.deps.org.toLowerCase()
    ) {
      return this.refuse(frame, 'repo');
    }
    if (!WRITE.has(await this.permission(cue.repo, cue.user))) {
      return this.refuse(frame, 'permission');
    }
    this.acted = this.acted.filter((a) => a.at > now - 3_600_000);
    const push = `${cue.repo.toLowerCase()} ${cue.branch}`;
    if (!this.acted.some((a) => a.push === push && a.at > now - PUSH_MS)) {
      if (this.acted.length >= BUDGET_PER_HOUR) {
        return this.refuse(frame, 'budget');
      }
      this.acted.push({ at: now, push });
    }
    const lead = Math.max(0, cue.ts + cue.lead_s * 1000 - now);
    this.deps.log({
      msg: 'cue',
      id: frame.id,
      repo: cue.repo,
      branch: cue.branch,
      ...(cue.kind === 'drop' ? { cancel: true } : { lead_ms: lead }),
    });
    this.deps.onCue(cue, lead);
  }

  // Cached five minutes per repo and user, as GitHub answered it.
  private async permission(repo: string, user: string) {
    const key = `${repo.toLowerCase()} ${user.toLowerCase()}`;
    const cached = this.permissions.get(key);
    if (cached && cached.at > this.now() - PERMISSION_TTL_MS) return cached.p;
    const p = await this.deps.permission(repo, user);
    this.permissions.set(key, { p, at: this.now() });
    return p;
  }
}
