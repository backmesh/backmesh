import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  sealCue,
  type CueFields,
  type CueFormat,
  type PublicKey,
} from '../../../src/cue/seal.js';
import {
  BUDGET_PER_HOUR,
  CueListener,
  PING_MS,
} from '../../../src/listener/cue.js';

// The relay's end of the listener's socket.
class FakeSocket {
  static all: FakeSocket[] = [];
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  closed?: number;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number }) => void;
  onerror?: () => void;
  constructor(
    readonly url: URL,
    readonly init: { headers: Record<string, string> },
  ) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code = 1000) {
    this.closed = code;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  frames() {
    return this.sent.flatMap((f) =>
      f === 'ping' ? [] : [JSON.parse(f) as Record<string, unknown>],
    );
  }
}

const ORG_ID = 11;
let cues: { repo: string; kind: string; lead: number }[];
let logs: Record<string, unknown>[];
let permission: ReturnType<
  typeof vi.fn<(repo: string, user: string) => Promise<string>>
>;
let listener: CueListener;

beforeEach(async () => {
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'Date',
    ],
  });
  vi.setSystemTime(Date.UTC(2026, 10, 7, 12));
  FakeSocket.all = [];
  cues = [];
  logs = [];
  permission = vi.fn(async (_repo: string, _user: string) => 'write');
  listener = new CueListener({
    url: 'https://api.backmesh.test',
    installKey: 'bmk_key',
    org: 'acme',
    orgId: async () => ORG_ID,
    permission,
    onCue: (cue, lead) =>
      void cues.push({ repo: cue.repo, kind: cue.kind, lead }),
    log: (entry) => void logs.push(entry),
    WebSocket: FakeSocket as unknown as typeof WebSocket,
  });
  await listener.start();
});
afterEach(() => {
  listener.stop();
  vi.useRealTimers();
});

const socket = () => FakeSocket.all.at(-1)!;
const published = (ws = socket()) =>
  ws.frames().find((f) => f.type === 'key') as unknown as PublicKey;
const fields: CueFields = {
  repo: 'acme/app',
  branch: 'main',
  user: 'alice',
  kind: 'push',
  pr: '?',
  lead_s: 90,
};

// Until the listener logs its verdict: opening runs on WebCrypto.
async function settled(before: number) {
  while (
    logs.filter((l) => /^cue( refused)?$/.test(String(l.msg))).length <= before
  ) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
const verdicts = () =>
  logs.filter((l) => /^cue( refused)?$/.test(String(l.msg))).length;

let ids = 0;
async function deliver(
  over: Partial<CueFields> = {},
  {
    login = 'alice',
    ts = Date.now(),
    frame = {},
    format = undefined as CueFormat | undefined,
  } = {},
) {
  const ws = socket();
  const before = verdicts();
  const sealed = await sealCue(
    ORG_ID,
    published(ws),
    { ...fields, ...over },
    ts,
    format,
  );
  const id = `cue-${++ids}`;
  ws.onmessage!({
    data: JSON.stringify({
      type: 'cue',
      id,
      ...sealed,
      user: { id: 5, login },
      relayed_at: Date.now(),
      ...frame,
    }),
  });
  await settled(before);
  return id;
}
const refusals = () =>
  logs.filter((l) => l.msg === 'cue refused').map((l) => l.reason);

describe('CueListener', () => {
  it("opens the previous release's format, and names an older one in its refusal", async () => {
    socket().open();
    // It advertises the formats it opens with its key.
    expect(published()).toMatchObject({ formats: [1, 2] });
    // rc.5 and rc.6 CLIs seal format 1 with `pr`.
    await deliver({}, { format: 1 });
    expect(cues).toEqual([{ repo: 'acme/app', kind: 'push', lead: 90_000 }]);
    // rc.4's: format 1 with no `pr` and a null lead.
    await deliver(
      { pr: undefined, lead_s: null } as unknown as Partial<CueFields>,
      { format: 1 },
    );
    expect(refusals()).toEqual(['format 1 without pr']);
    expect(cues).toHaveLength(1);
  });

  it('connects with the install key and publishes its key', () => {
    const ws = socket();
    expect(ws.url.href).toBe('wss://api.backmesh.test/v1/cue/connect');
    expect(ws.init.headers).toEqual({ Authorization: 'Bearer bmk_key' });
    ws.open();
    expect(published()).toMatchObject({
      kid: expect.any(String),
      pub: expect.any(String),
    });
  });

  it('hands the planner a checked cue with its lead left, and acks it', async () => {
    socket().open();
    vi.advanceTimersByTime(5_000);
    const id = await deliver({}, { ts: Date.now() - 5_000 });
    expect(cues).toEqual([{ repo: 'acme/app', kind: 'push', lead: 85_000 }]);
    // Logged with its repo and branch, which its slots' lines name too.
    expect(logs.at(-1)).toEqual({
      msg: 'cue',
      id,
      repo: 'acme/app',
      branch: 'main',
      lead_ms: 85_000,
    });
    expect(socket().frames()).toContainEqual({ type: 'ack', id });
    expect(permission).toHaveBeenCalledWith('acme/app', 'alice');
    // A cue delayed past its push time has none left.
    await deliver({}, { ts: Date.now() - 100_000 });
    expect(cues[1]).toEqual({ repo: 'acme/app', kind: 'push', lead: 0 });
    // The shortest lead, 30 s (owner, 2026-11-09).
    await deliver({ lead_s: 30 }, { ts: Date.now() });
    expect(cues.at(-1)).toEqual({
      repo: 'acme/app',
      kind: 'push',
      lead: 30_000,
    });
    // A cancel passes the same checks.
    await deliver({ kind: 'drop', lead_s: 600 });
    expect(cues[3]).toMatchObject({ repo: 'acme/app', kind: 'drop' });
    // The permission is cached.
    expect(permission).toHaveBeenCalledTimes(1);
  });

  it('refuses a replay, a stale cue, another user, another org and no write access', async () => {
    socket().open();
    const ws = socket();
    const sealed = await sealCue(ORG_ID, published(), fields);
    const frame = JSON.stringify({
      type: 'cue',
      id: 'a',
      ...sealed,
      user: { id: 5, login: 'alice' },
    });
    ws.onmessage!({ data: frame });
    await settled(0);
    ws.onmessage!({ data: frame.replace('"a"', '"b"') });
    await settled(1);
    await deliver({}, { ts: Date.now() - 121_000 });
    await deliver({}, { login: 'mallory' });
    await deliver({ repo: 'other/app' });
    permission.mockResolvedValueOnce('read');
    await deliver({ repo: 'acme/web' });
    await deliver({}, { frame: { kid: 'A'.repeat(16) } });
    expect(refusals()).toEqual([
      'replay',
      'stale',
      'user',
      'repo',
      'permission',
      'key',
    ]);
    expect(cues).toHaveLength(1);
  });

  it("acts on at most its hourly budget of pushes, counting a push's cues once", async () => {
    socket().open();
    for (let i = 0; i < BUDGET_PER_HOUR + 1; i++) {
      await deliver({ branch: `b${i}` });
    }
    expect(cues).toHaveLength(BUDGET_PER_HOUR);
    expect(refusals()).toEqual(['budget']);
    // The same branch again within 10 minutes: reschedules and a cancel are
    // the same push.
    await deliver({ branch: 'b0', lead_s: 300 });
    await deliver({ branch: 'B0' });
    await deliver({ branch: 'b0', lead_s: 120 });
    await deliver({ branch: 'b0', kind: 'drop', lead_s: 600 });
    expect(cues).toHaveLength(BUDGET_PER_HOUR + 3);
    expect(refusals()).toEqual(['budget', 'budget']);
    // An hour on, the socket answering its pings.
    for (let t = 0; t <= 3_600_000; t += PING_MS) {
      vi.advanceTimersByTime(PING_MS);
      socket().onmessage!({ data: 'pong' });
    }
    await deliver();
    expect(cues).toHaveLength(BUDGET_PER_HOUR + 4);
  });

  it('pings every 20 s, and dials again when a pong is 10 s late', () => {
    const ws = socket();
    ws.open();
    vi.advanceTimersByTime(PING_MS);
    expect(ws.sent.filter((f) => f === 'ping')).toHaveLength(1);
    ws.onmessage!({ data: 'pong' });
    vi.advanceTimersByTime(PING_MS);
    expect(ws.closed).toBeUndefined();
    vi.advanceTimersByTime(PING_MS);
    expect(ws.closed).toBe(4000);
    vi.advanceTimersByTime(250);
    expect(FakeSocket.all).toHaveLength(2);
    // The same key, again.
    socket().open();
    expect(published(socket())).toEqual(published(ws));
  });

  it('reconnects with backoff after a close, and drops a hung handshake', () => {
    const first = socket();
    first.open();
    first.onclose!({ code: 1006 });
    vi.advanceTimersByTime(250);
    expect(FakeSocket.all).toHaveLength(2);
    // Never opens: dropped after 10 s, then dialled after up to 0.5 s.
    vi.advanceTimersByTime(10_000);
    expect(FakeSocket.all[1]!.closed).toBe(4002);
    vi.advanceTimersByTime(500);
    expect(FakeSocket.all).toHaveLength(3);
    listener.stop();
    socket().onclose!({ code: 1006 });
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(3);
  });
});
