import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cue, type CueDeps } from '../../../src/cli/cue.js';
import { MAX_LEAD_S, MIN_LEAD_S } from '../../../src/cue/seal.js';
import { git as gitIn, runCli } from '../../../src/cli/run.js';
import {
  generateKey,
  openCue,
  type Cue,
  type Sealed,
} from '../../../src/cue/seal.js';

const BASE = 'https://api.backmesh.test';
// The relay's cue credential for alice, traded for her App sign-in.
const CREDENTIAL = `bmc_${'a1'.repeat(32)}`;
const STALE = `bmc_${'b2'.repeat(32)}`;

// The relay and GitHub as `backmesh cue` sees them: the org's listener keys,
// opened here to check what was sealed.
class Relay {
  listeners: Awaited<ReturnType<typeof generateKey>>[] = [];
  received: { cue: Cue; tag: string; hash: string }[] = [];
  calls: string[] = [];
  // Each request's Authorization header.
  auths: (string | null)[] = [];
  // The next POST's answer, when set.
  answer?: { status: number; body: object };
  hang = false;
  fetch = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    this.calls.push(`${init.method ?? 'GET'} ${url.host}${url.pathname}`);
    if (this.hang) {
      return new Promise<Response>((_, reject) =>
        init.signal!.addEventListener('abort', () =>
          reject(init.signal!.reason),
        ),
      );
    }
    const auth = new Headers(init.headers).get('Authorization');
    this.auths.push(auth);
    // A fresh App sign-in, traded once for the cue credential; the cue
    // routes take only that, and GitHub is never asked.
    if (url.pathname === '/v1/cue/sign-in') {
      // A sign-in that reaches none of the App's installations.
      if (auth === 'Bearer ghu_nobody') {
        return Response.json({ error: 'No org.' }, { status: 403 });
      }
      if (auth !== 'Bearer ghu_alice') {
        return Response.json(
          { error: 'GitHub sign-in expired' },
          { status: 401 },
        );
      }
      return Response.json({
        credential: CREDENTIAL,
        login: 'alice',
        expires_at: '2100-01-01T00:00:00.000Z',
      });
    }
    if (url.host === 'api.github.com') {
      return Response.json({ message: 'unexpected' }, { status: 500 });
    }
    // A credential traded before the org's App was installed.
    if (auth === `Bearer ${STALE}`) {
      return Response.json({ error: 'Not your org.' }, { status: 403 });
    }
    // An App sign-in still works on the cue routes, as the Worker's does.
    if (auth !== `Bearer ${CREDENTIAL}` && auth !== 'Bearer ghu_alice') {
      return Response.json(
        { error: 'Cue sign-in expired; run `backmesh cue --sign-in`.' },
        { status: 401 },
      );
    }
    const keys = this.listeners.map((l) => l.key);
    if (url.pathname === '/v1/cue/keys') {
      return Response.json({ org_id: 11, login: 'alice', keys });
    }
    if (this.answer) {
      const { status, body } = this.answer;
      this.answer = undefined;
      return Response.json(body, { status });
    }
    const { tag, hash, sealed } = JSON.parse(String(init.body)) as {
      tag: string;
      hash: string;
      sealed: Sealed[];
    };
    const known = sealed.filter((s) => keys.some((k) => k.kid === s.kid));
    if (!known.length) return Response.json({ keys }, { status: 409 });
    for (const s of known) {
      const l = this.listeners.find((x) => x.key.kid === s.kid)!;
      this.received.push({ cue: await openCue(l.pair, 11, s), tag, hash });
    }
    return Response.json({ id: 'c1', sent: 1, keys }, { status: 202 });
  });
}

// Until the CLI's first request, so its 3 s budget has started.
async function requested() {
  while (!relay.calls.length) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

let dir: string;
let relay: Relay;
let deps: CueDeps;
let signIns: number;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'bm-cue-'));
  writeFileSync(join(dir, '.token'), 'ghu_alice\n');
  relay = new Relay();
  relay.listeners.push(await generateKey());
  signIns = 0;
  deps = {
    env: { BACKMESH_ANYCLOUD_DIR: dir, BACKMESH_API_URL: BASE },
    fetch: relay.fetch as unknown as typeof fetch,
    git: async (args) =>
      ({
        'remote get-url origin': 'git@github.com:acme/app.git',
        'rev-parse --abbrev-ref HEAD': 'feature/x',
      })[args.join(' ')] ?? '',
    signIn: async () => {
      signIns++;
      writeFileSync(join(dir, '.token'), 'ghu_alice\n');
    },
  };
});

describe('backmesh cue', () => {
  // App user tokens last 8 hours (owner, 2026-11-19): cue trades one for
  // the relay's own 30-day credential and sends GitHub nothing after.
  describe('the cue credential', () => {
    const saved = () => join(dir, 'backmesh-cue-credential');

    it('trades the saved sign-in for a credential once, then sends only the credential', async () => {
      expect((await cue({ inS: 120, signIn: false }, deps)).outcome).toBe(
        'sent',
      );
      expect(relay.calls).toEqual([
        'POST api.backmesh.test/v1/cue/sign-in',
        'GET api.backmesh.test/v1/cue/keys',
        'POST api.backmesh.test/v1/cue',
      ]);
      expect(readFileSync(saved(), 'utf8')).toBe(`${CREDENTIAL}\n`);
      expect(statSync(saved()).mode & 0o777).toBe(0o600);
      // The saved sign-in can expire now: cue doesn't need it.
      writeFileSync(join(dir, '.token'), 'ghu_expired\n');
      relay.calls = [];
      relay.auths = [];
      expect(
        (await cue({ inS: 120, signIn: false, branch: 'dev' }, deps)).outcome,
      ).toBe('sent');
      expect(relay.auths).toEqual([`Bearer ${CREDENTIAL}`]);
    });

    it('trades again when the credential is refused, from the saved sign-in', async () => {
      writeFileSync(saved(), 'bmc_old\n');

      expect((await cue({ inS: 120, signIn: false }, deps)).outcome).toBe(
        'sent',
      );
      expect(readFileSync(saved(), 'utf8')).toBe(`${CREDENTIAL}\n`);
    });

    it('takes a credential in BACKMESH_CUE_TOKEN as it is, for a sandbox', async () => {
      rmSync(join(dir, '.token'));
      const given = {
        ...deps,
        env: { ...deps.env, BACKMESH_CUE_TOKEN: CREDENTIAL },
      };

      expect((await cue({ inS: 120, signIn: false }, given)).outcome).toBe(
        'sent',
      );
      expect(relay.calls).not.toContain(
        'POST api.backmesh.test/v1/cue/sign-in',
      );
      expect(existsSync(saved())).toBe(false);
    });

    it('trades a fresh sign-in at --sign-in, with no cue needed', async () => {
      writeFileSync(saved(), 'bmc_old\n');

      expect(await cue({ signIn: true }, deps)).toEqual({
        outcome: 'signed in',
        message: 'Signed in. Nothing was sent.',
      });

      expect(signIns).toBe(1);
      expect(relay.calls).toEqual(['POST api.backmesh.test/v1/cue/sign-in']);
      expect(readFileSync(saved(), 'utf8')).toBe(`${CREDENTIAL}\n`);
    });

    it("trades again when the saved credential doesn't reach the org", async () => {
      writeFileSync(saved(), `${STALE}\n`);

      expect((await cue({ inS: 120, signIn: false }, deps)).outcome).toBe(
        'sent',
      );
      expect(readFileSync(saved(), 'utf8')).toBe(`${CREDENTIAL}\n`);
    });

    it('says so when the sign-in reaches none of the orgs the App is on', async () => {
      writeFileSync(join(dir, '.token'), 'ghu_nobody\n');

      expect(await cue({ inS: 120, signIn: false }, deps)).toEqual({
        outcome: 'refused',
        message:
          "Your GitHub sign-in reaches none of the orgs backmesh's GitHub App is on, so there's no org to cue. Nothing was sent.",
      });
    });

    it('names the cue credential when it was refused and the sign-in is gone too', async () => {
      writeFileSync(saved(), 'bmc_old\n');
      writeFileSync(join(dir, '.token'), 'ghu_revoked\n');

      expect(await cue({ inS: 120, signIn: false }, deps)).toEqual({
        outcome: 'not signed in',
        message:
          'The saved cue credential expired or was revoked. Run `backmesh cue --sign-in` to sign in again. Nothing was sent.',
      });
    });

    it('sends an App sign-in in BACKMESH_CUE_TOKEN as it is', async () => {
      const given = {
        ...deps,
        env: { ...deps.env, BACKMESH_CUE_TOKEN: 'ghu_alice' },
      };

      expect((await cue({ inS: 120, signIn: false }, given)).outcome).toBe(
        'sent',
      );
      expect(relay.calls).not.toContain(
        'POST api.backmesh.test/v1/cue/sign-in',
      );
      expect(relay.auths).toContain('Bearer ghu_alice');
    });
  });

  it("seals the repo, branch, user and lead to the listener's key", async () => {
    const result = await cue({ inS: 120, signIn: false }, deps);
    expect(result).toEqual({
      outcome: 'sent',
      message: 'Cued acme/app feature/x.',
    });
    expect(relay.received).toEqual([
      {
        cue: expect.objectContaining({
          org_id: 11,
          repo: 'acme/app',
          branch: 'feature/x',
          user: 'alice',
          kind: 'push',
          lead_s: 120,
        }),
        tag: expect.stringMatching(/^[0-9a-f]{32}$/),
        hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
    // Neither the repo nor the branch goes to the relay in the clear.
    const posted = relay.fetch.mock.calls
      .map(([, init]) => String(init?.body ?? ''))
      .join(' ');
    expect(posted).not.toMatch(/app|feature/);
  });

  it('caches the keys and login, so the next cue is one request', async () => {
    await cue({ inS: 120, signIn: false }, deps);
    relay.calls = [];
    expect((await cue({ inS: 400, signIn: false }, deps)).outcome).toBe('sent');
    expect(relay.calls).toEqual(['POST api.backmesh.test/v1/cue']);
    expect(statSync(join(dir, 'backmesh-cue.json')).mode & 0o777).toBe(0o600);
  });

  it("tags a branch's cues as one push for 10 minutes, each time and kind its own hash", async () => {
    let now = 1_000_000_000_020;
    deps.now = () => now;
    const sent = async (opts: Partial<Parameters<typeof cue>[0]>) => {
      await cue({ ...opts, signIn: false }, deps);
      return relay.received.at(-1)!;
    };
    const first = await sent({ inS: 300 });
    // Another time, a cancel and a cue after it are each their own, with
    // the push's tag whatever the commit.
    const seen = new Set([first.hash]);
    for (const opts of [{ inS: 600 }, { cancel: true }, { inS: 90 }]) {
      now += 10_000;
      const next = await sent(opts);
      expect(next.tag).toBe(first.tag);
      expect(seen.has(next.hash)).toBe(false);
      seen.add(next.hash);
    }
    // Another branch is another push; the next window, a new tag.
    expect((await sent({ branch: 'dev', inS: 300 })).tag).not.toBe(first.tag);
    now += 600_000;
    const later = await sent({ inS: 300 });
    expect(later.tag).not.toBe(first.tag);
    expect(seen.has(later.hash)).toBe(false);
  });

  it("skips a cue up to 45 s later than the branch's live one, until a push", async () => {
    const t0 = 1_000_000_000_000;
    let now = t0;
    deps.now = () => now;
    let pushes: number[] = [];
    const git = deps.git;
    deps.git = async (args, signal) =>
      args[0] === 'reflog'
        ? pushes
            .toReversed()
            .map((at) => `origin/feature/x@{${at}}\tupdate by push`)
            .join('\n')
        : git(args, signal);
    const run = async (inS: number, at: number, branch?: string) => {
      now = t0 + at * 1000;
      return (await cue({ inS, branch, signIn: false }, deps)).outcome;
    };
    // Live at +300 s.
    expect(await run(300, 0)).toBe('sent');
    expect(await cue({ inS: 300, signIn: false }, deps)).toEqual({
      outcome: 'coalesced',
      message:
        'Already cued acme/app feature/x for a push in about 300 s, close to this estimate, so nothing was sent.',
    });
    // Up to 45 s later is skipped.
    expect(await run(285, 60)).toBe('coalesced');
    expect(relay.received).toHaveLength(1);
    // 46 s later: its runners would be gone by then.
    expect(await run(286, 60)).toBe('sent');
    // Earlier is sent: the runners start sooner. Live at +240 s now.
    expect(await run(150, 90)).toBe('sent');
    // Another branch is its own; a cancel ends the live cue.
    expect(await run(300, 90, 'dev')).toBe('sent');
    expect((await cue({ cancel: true, signIn: false }, deps)).outcome).toBe(
      'sent',
    );
    expect(await run(150, 90)).toBe('sent');
    // Live at +240 s; a push at +200 s took its runners, so the next is sent.
    pushes = [Math.floor(t0 / 1000) + 200];
    expect(await run(100, 210)).toBe('sent');
    // That push also started a new tag: the relay mustn't coalesce the
    // next push's cue with the last push's.
    expect(relay.received.at(-1)!.tag).not.toBe(relay.received.at(-2)!.tag);
    // Past the live time, a cue is sent; the branch's tag expiring 10
    // minutes after its first cue doesn't end the skip.
    pushes = [];
    expect(await run(300, 430)).toBe('sent');
    expect(await run(100, 640)).toBe('coalesced');
    // With --repo, git can't tell this repo's pushes, so nothing is skipped.
    now += 1;
    expect(
      (await cue({ repo: 'acme/app', inS: 100, signIn: false }, deps)).outcome,
    ).toBe('sent');
    expect(relay.received).toHaveLength(9);
  });

  it('says once, at the next cue, when a push came within 10 s of the last cue sent', async () => {
    const t0 = 1_000_000_000_500;
    const t0s = Math.floor(t0 / 1000);
    let now = t0;
    deps.now = () => now;
    // When git logged pushes to origin/feature/x, in seconds, and a fetch.
    let pushes: number[] = [];
    const git = deps.git;
    deps.git = async (args, signal) =>
      args[0] === 'reflog'
        ? [
            ...pushes
              .toReversed()
              .map((at) => `origin/feature/x@{${at}}\tupdate by push`),
            `origin/feature/x@{${t0s + 2}}\tfetch: fast-forward`,
          ].join('\n')
        : git(args, signal);
    const run = async (opts: Partial<Parameters<typeof cue>[0]> = {}) =>
      (await cue({ inS: 300, ...opts, signIn: false }, deps)).message;
    const note = (n: string) =>
      `\nYour last cue on feature/x came ${n} before its push, too late to start runners. Run \`backmesh cue --in <seconds>\` as its own command when you start your checks.`;
    await run();
    // A skipped re-cue isn't the last cue sent.
    now = t0 + 246_000;
    expect(await run({ inS: 90 })).toContain('nothing was sent');
    // Two pushes: the first after the cue counts.
    pushes = [t0s + 4, t0s + 20, t0s + 250];
    now = t0 + 600_000;
    relay.answer = { status: 429, body: { error: 'Too many cues.' } };
    expect(await run()).toBe(
      `backmesh.com refused the cue (Too many cues.).${note('4 s')}`,
    );
    // Said once, though that cue was refused.
    now += 1;
    expect(await run({ inS: 90 })).toBe('Cued acme/app feature/x.');
    // 10 s after, within the second, a push 11 s after (as a 30 s cue
    // pushed on time is), or another repo.
    pushes = [Math.floor(now / 1000) + 10];
    now += 600_000;
    expect(await run()).toBe(`Cued acme/app feature/x.${note('10 s')}`);
    pushes = [Math.floor(now / 1000)];
    now += 600_000;
    expect(await run()).toBe(
      `Cued acme/app feature/x.${note('under a second')}`,
    );
    for (const after of [11, 30]) {
      pushes = [Math.floor(now / 1000) + after];
      now += 600_000;
      expect(await run()).toBe('Cued acme/app feature/x.');
    }
    pushes = [Math.floor(now / 1000) + 1];
    now += 600_000;
    expect(await run({ repo: 'acme/web' })).toBe('Cued acme/web feature/x.');
  });

  it('reads from git whether the branch has a PR, and seals it', async () => {
    const head = 'a'.repeat(40);
    let refs: string | Error = '';
    let asked: string[] = [];
    const git = deps.git;
    deps.git = async (args, signal) => {
      if (args[0] !== 'ls-remote') return git(args, signal);
      asked = args;
      if (refs instanceof Error) throw refs;
      return refs;
    };
    let now = 1_000_000_000_000;
    deps.now = () => now;
    const pr = async (opts: Partial<Parameters<typeof cue>[0]> = {}) => {
      now += 600_000;
      await cue({ inS: 300, ...opts, signIn: false }, deps);
      return relay.received.at(-1)!.cue.pr;
    };
    refs = [
      `${'b'.repeat(40)}\trefs/pull/6/head`,
      `${head}\trefs/heads/feature/x`,
      `${head}\trefs/pull/7/head`,
    ].join('\n');
    expect(await pr()).toBe('y');
    expect(asked).toEqual([
      'ls-remote',
      'origin',
      'refs/heads/feature/x',
      'refs/pull/*/head',
    ]);
    // No PR at the branch's head, or no remote branch yet.
    refs = `${head}\trefs/heads/feature/x\n${'b'.repeat(40)}\trefs/pull/6/head`;
    expect(await pr()).toBe('n');
    refs = `${head}\trefs/pull/7/head`;
    expect(await pr()).toBe('n');
    // git failing, another repo than origin, and a cancel can't tell.
    refs = new Error('ls-remote failed');
    expect(await pr()).toBe('?');
    refs = '';
    expect(await pr({ repo: 'acme/web' })).toBe('?');
    expect(await pr({ inS: undefined, cancel: true })).toBe('?');
  });

  it('reads the PR flag with real git from a remote with PR refs, and gives up after 1.5 s', async () => {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' };
    const sh = (cwd: string, ...args: string[]) =>
      gitIn(args, AbortSignal.timeout(10_000), env, cwd);
    const remote = join(dir, 'remote.git');
    const work = join(dir, 'work');
    mkdirSync(work);
    await sh(dir, 'init', '-q', '--bare', remote);
    await sh(work, 'init', '-q', '-b', 'feature/x');
    await sh(work, 'remote', 'add', 'origin', remote);
    await sh(
      work,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'one',
    );
    await sh(work, 'push', '-q', 'origin', 'HEAD:refs/heads/feature/x');
    const head = await sh(work, 'rev-parse', 'HEAD');
    // A PR at another commit, then one at the branch's head (packed).
    await sh(
      work,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'two',
    );
    const other = await sh(work, 'rev-parse', 'HEAD');
    await sh(work, 'push', '-q', 'origin', 'HEAD:refs/heads/other');
    await sh(remote, 'update-ref', 'refs/pull/6/head', other);
    const real: CueDeps['git'] = (args, signal) => {
      if (args[0] === 'ls-remote') return gitIn(args, signal, env, work);
      return deps.git(args, signal);
    };
    const flag = async () => {
      await cue({ inS: 300, signIn: false }, { ...deps, git: real });
      return relay.received.at(-1)!.cue.pr;
    };
    let now = 1_000_000_000_000;
    deps.now = () => (now += 600_000);
    expect(await flag()).toBe('n');
    await sh(remote, 'update-ref', 'refs/pull/7/head', head);
    await sh(remote, 'pack-refs', '--all');
    expect(await flag()).toBe('y');
    // A remote that never answers: '?', and the cue still goes.
    const hung: CueDeps['git'] = (args, signal) =>
      args[0] === 'ls-remote'
        ? new Promise((_, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason)),
          )
        : deps.git(args, signal);
    const started = Date.now();
    expect(
      (await cue({ inS: 300, signIn: false }, { ...deps, git: hung })).outcome,
    ).toBe('sent');
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(relay.received.at(-1)!.cue.pr).toBe('?');
  });

  it("cancels the branch's cue, sealed as a cue", async () => {
    expect(await cue({ cancel: true, signIn: false }, deps)).toEqual({
      outcome: 'sent',
      message: 'Cancelled the cue for acme/app feature/x.',
    });
    expect(relay.received[0]!.cue).toMatchObject({
      repo: 'acme/app',
      branch: 'feature/x',
      kind: 'drop',
      lead_s: 600,
    });
    relay.answer = { status: 200, body: { coalesced: true } };
    expect((await cue({ cancel: true, signIn: false }, deps)).message).toBe(
      'Already cancelled the cue for acme/app feature/x.',
    );
    // With --in, in range or not, a cancel is refused for the --in.
    for (const inS of [120, 50]) {
      expect(
        await cue({ cancel: true, inS, signIn: false }, deps),
      ).toMatchObject({
        outcome: 'refused',
        message: expect.stringContaining('--cancel'),
      });
    }
    expect(relay.received).toHaveLength(1);
  });

  it("reseals once for a restarted listener's new key", async () => {
    await cue({ inS: 120, signIn: false }, deps);
    relay.listeners = [await generateKey()];
    relay.calls = [];
    expect((await cue({ inS: 400, signIn: false }, deps)).outcome).toBe('sent');
    expect(relay.calls).toEqual([
      'POST api.backmesh.test/v1/cue',
      'POST api.backmesh.test/v1/cue',
    ]);
    const cached = JSON.parse(
      readFileSync(join(dir, 'backmesh-cue.json'), 'utf8'),
    );
    expect(cached.keys).toEqual([relay.listeners[0]!.key]);
  });

  it('sends nothing without a listener or a sign-in, and signs in on request', async () => {
    relay.listeners = [];
    expect((await cue({ inS: 120, signIn: false }, deps)).outcome).toBe(
      'no listener',
    );
    writeFileSync(join(dir, '.token'), '');
    rmSync(join(dir, 'backmesh-cue-credential'), { force: true });
    expect(await cue({ inS: 120, signIn: false }, deps)).toMatchObject({
      outcome: 'not signed in',
      message: expect.stringContaining('backmesh cue --sign-in'),
    });
    relay.listeners = [await generateKey()];
    expect((await cue({ inS: 120, signIn: true }, deps)).outcome).toBe('sent');
    expect(signIns).toBe(1);
  });

  it('with --sign-in alone, signs in and sends nothing, but keeps --in and --cancel working alongside it', async () => {
    // Still refused, exactly as without --sign-in: no --in or --cancel is
    // the one case `--sign-in` doesn't rescue.
    expect(await cue({ signIn: false }, deps)).toEqual({
      outcome: 'refused',
      message: expect.stringContaining(`${MIN_LEAD_S} to ${MAX_LEAD_S}`),
    });
    expect(signIns).toBe(0);
    rmSync(join(dir, '.token'), { force: true });
    expect(await cue({ signIn: true }, deps)).toEqual({
      outcome: 'signed in',
      message: 'Signed in. Nothing was sent.',
    });
    expect(signIns).toBe(1);
    expect(readFileSync(join(dir, '.token'), 'utf8')).toBe('ghu_alice\n');
    expect(relay.calls).toEqual([]);
    // `--sign-in --in N` keeps sending the cue, as before.
    expect((await cue({ signIn: true, inS: 120 }, deps)).outcome).toBe('sent');
    expect(signIns).toBe(2);
    // `--sign-in --cancel` keeps cancelling.
    expect(await cue({ signIn: true, cancel: true }, deps)).toEqual({
      outcome: 'sent',
      message: 'Cancelled the cue for acme/app feature/x.',
    });
    expect(signIns).toBe(3);
  });

  it('gives up after 3 s, and reads a 5xx as an outage', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    relay.hang = true;
    const pending = cue({ inS: 120, signIn: false }, deps);
    await requested();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await pending).toMatchObject({
      outcome: 'unavailable',
      message: expect.stringContaining('no answer in 3 s'),
    });
    vi.useRealTimers();
    relay.hang = false;
    await cue({ inS: 120, signIn: false }, deps);
    relay.answer = { status: 503, body: {} };
    expect((await cue({ inS: 400, signIn: false }, deps)).outcome).toBe(
      'unavailable',
    );
  });

  it('says why the relay refused, such as a rate limit or a revoked sign-in', async () => {
    await cue({ inS: 120, signIn: false }, deps);
    relay.answer = { status: 429, body: { error: 'Too many cues.' } };
    expect((await cue({ inS: 400, signIn: false }, deps)).message).toContain(
      'Too many cues.',
    );
    // The relay refuses the saved credential, and GitHub the saved sign-in
    // it would be traded again from.
    writeFileSync(join(dir, 'backmesh-cue-credential'), 'bmc_old\n');
    writeFileSync(join(dir, '.token'), 'ghu_revoked\n');
    const revoked = {
      outcome: 'not signed in',
      message: `The saved GitHub sign-in expired or was revoked. Run \`backmesh cue --sign-in\` to sign in again. Nothing was sent.`,
    };
    expect(await cue({ inS: 120, signIn: false }, deps)).toEqual(revoked);
    // The file stays for --sign-in to replace, and the push isn't blocked.
    expect(readFileSync(join(dir, '.token'), 'utf8')).toBe('ghu_revoked\n');
    const out: string[] = [];
    writeFileSync(join(dir, 'backmesh-cue-credential'), 'bmc_old\n');
    const code = await runCli(['cue', '--in', '120'], {
      stdout: (t) => void out.push(t),
      stderr: (t) => void out.push(t),
      env: deps.env,
      isTTY: false,
      cueDeps: () => deps,
    });
    expect(code).toBe(0);
    expect(out.join('')).toBe(`${revoked.message}\n`);
  });

  it('uses BACKMESH_CUE_TOKEN before the saved sign-in, for a sandbox that has none', async () => {
    const given = (token: string) => ({
      ...deps,
      env: { ...deps.env, BACKMESH_CUE_TOKEN: ` ${token}\n` },
    });
    // A sandbox: no saved sign-in at all, only the token a human gave it.
    rmSync(join(dir, '.token'), { force: true });
    expect(
      (
        await cue(
          { inS: 120, signIn: false, branch: 'sandbox-1' },
          given('ghu_alice'),
        )
      ).outcome,
    ).toBe('sent');
    // It wins over a saved sign-in GitHub has revoked.
    writeFileSync(join(dir, '.token'), 'ghu_revoked\n');
    expect(
      (
        await cue(
          { inS: 120, signIn: false, branch: 'sandbox-2' },
          given('ghu_alice'),
        )
      ).outcome,
    ).toBe('sent');
    // A refused given token names the variable, not a sign-in it can't do.
    const refused = await cue(
      { inS: 120, signIn: false, branch: 'sandbox-3' },
      given('ghu_revoked'),
    );
    expect(refused.outcome).toBe('not signed in');
    expect(refused.message).toContain('BACKMESH_CUE_TOKEN');
    expect(refused.message).not.toContain('--sign-in');
    // A blank variable falls back to the saved sign-in.
    writeFileSync(join(dir, '.token'), 'ghu_alice\n');
    expect(
      (
        await cue(
          { inS: 120, signIn: false, branch: 'sandbox-4' },
          given('   '),
        )
      ).outcome,
    ).toBe('sent');
    // With the variable set, --sign-in would mint a token cue never uses.
    expect(
      (
        await cue(
          { inS: 120, signIn: true, branch: 'sandbox-5' },
          given('ghu_alice'),
        )
      ).outcome,
    ).toBe('refused');
    expect(signIns).toBe(0);
  });

  it('takes the repo and branch from options, and refuses what it can’t tell', async () => {
    const result = await cue(
      { repo: 'acme/web', branch: 'main', inS: 120, signIn: false },
      deps,
    );
    expect(result.outcome).toBe('sent');
    expect(relay.received[0]!.cue).toMatchObject({
      repo: 'acme/web',
      branch: 'main',
    });
    deps.git = async () => '';
    expect(await cue({ inS: 120, signIn: false }, deps)).toEqual({
      outcome: 'refused',
      message:
        "Couldn't tell the GitHub repo from this checkout's origin remote; pass --repo owner/name.",
    });
    // Out of range, or none at all (only a cancel goes without), is
    // refused.
    for (const inS of [601, 90.5, 20.5, -1, Number.NaN]) {
      expect(await cue({ inS, signIn: false }, deps)).toEqual({
        outcome: 'refused',
        message: `--in takes whole seconds, up to ${MAX_LEAD_S}.`,
      });
    }
    expect(await cue({ signIn: false }, deps)).toEqual({
      outcome: 'refused',
      message: expect.stringContaining(`${MIN_LEAD_S} to ${MAX_LEAD_S}`),
    });
    // A detached HEAD names no branch, and HEAD isn't one.
    deps.git = async (args) =>
      args.includes('--abbrev-ref') ? 'HEAD' : 'git@github.com:acme/app.git';
    expect((await cue({ inS: 120, signIn: false }, deps)).message).toBe(
      'HEAD is detached, so there is no branch to cue; pass --branch <branch>.',
    );
    expect(relay.received).toHaveLength(1);
    expect(
      (await cue({ branch: 'HEAD', inS: 120, signIn: false }, deps)).message,
    ).toBe("HEAD isn't a branch name; pass --branch <branch>.");
  });

  it('sends nothing for a push under 30 s away, and exits 0', async () => {
    // Before any git call or token read: signed out, it still says so.
    const git = vi.fn(deps.git);
    deps.git = git;
    rmSync(join(dir, '.token'));
    for (const inS of [0, 29]) {
      expect(await cue({ inS, signIn: false }, deps)).toEqual({
        outcome: 'too soon',
        message:
          'A push in under 30 s is too soon for runners to start early, so nothing was sent.',
      });
    }
    // No relay request, so no rate-limit count, and no cache write.
    expect(relay.calls).toEqual([]);
    expect(git).not.toHaveBeenCalled();
    expect(existsSync(join(dir, 'backmesh-cue.json'))).toBe(false);
    // Only digits are a lead: '' or 1e1 is refused, not read as 0 or 10.
    for (const value of ['', ' ', '1e1', '0x10']) {
      const text: string[] = [];
      await runCli(['cue', '--in', value], {
        stdout: (t) => void text.push(t),
        stderr: (t) => void text.push(t),
        env: deps.env,
        isTTY: false,
        cueDeps: () => deps,
      });
      expect(text.join('')).toContain('--in takes whole seconds');
    }
    writeFileSync(join(dir, '.token'), 'ghu_alice\n');
    const out: string[] = [];
    const code = await runCli(['cue', '--in', '29'], {
      stdout: (t) => void out.push(t),
      stderr: (t) => void out.push(t),
      env: deps.env,
      isTTY: false,
      cueDeps: () => deps,
    });
    expect(code).toBe(0);
    expect(out.join('')).toContain('too soon for runners to start early');
    expect(relay.calls).toEqual([]);
    // 30 and 600 are cues, sealed with their lead.
    for (const inS of [30, 600]) {
      expect((await cue({ inS, signIn: false }, deps)).outcome).toBe('sent');
    }
    expect(relay.received.map(({ cue }) => cue.lead_s)).toEqual([30, 600]);
  });

  it('seals a format the listener reads, or says which side to update', async () => {
    const send = async () => cue({ inS: 120, signIn: false }, deps);
    // A listener from before formats (rc.6 and earlier) opens format 1 only.
    expect((await send()).outcome).toBe('sent');
    expect(relay.received.at(-1)!.cue.v).toBe(1);
    // One that reads 1 and 2 gets the newest, 2. The keys are cached, so a
    // new key (a restarted listener) is read afresh.
    relay.listeners = [await generateKey()];
    relay.listeners[0]!.key.formats = [1, 2];
    rmSync(join(dir, 'backmesh-cue.json'));
    expect((await send()).outcome).toBe('sent');
    expect(relay.received.at(-1)!.cue.v).toBe(2);
    // One that reads only newer formats: nothing is sent, and the CLI says
    // to update itself.
    relay.listeners[0]!.key.formats = [3];
    rmSync(join(dir, 'backmesh-cue.json'));
    const calls = relay.calls.length;
    expect(await send()).toEqual({
      outcome: 'refused',
      message:
        "Your backmesh CLI is too old for acme's listener: update it. Nothing was sent.",
    });
    expect(relay.calls.slice(calls)).not.toContain(
      'POST api.backmesh.test/v1/cue',
    );
    // The refusal isn't cached: once the listener reads 2, the next cue
    // fetches its keys again and is sent.
    relay.listeners[0]!.key.formats = [2, 3];
    expect((await send()).outcome).toBe('sent');
    expect(relay.received.at(-1)!.cue.v).toBe(2);
  });

  it("reports a cue sent even when its cache can't be written", async () => {
    mkdirSync(join(dir, 'backmesh-cue.json'));
    expect((await cue({ inS: 120, signIn: false }, deps)).outcome).toBe('sent');
  });

  it('exits 0 whatever the relay says', async () => {
    relay.hang = true;
    const out: string[] = [];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const code = runCli(['cue', '--in', '90'], {
      stdout: (t) => void out.push(t),
      stderr: (t) => void out.push(t),
      env: deps.env,
      isTTY: false,
      cueDeps: () => deps,
    });
    await requested();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await code).toBe(0);
    vi.useRealTimers();
    expect(out.join('')).toContain("Couldn't reach backmesh.com");
  });

  it('backmesh cue --sign-in, alone, signs in and exits 0 without a cue', async () => {
    rmSync(join(dir, '.token'), { force: true });
    const out: string[] = [];
    const code = await runCli(['cue', '--sign-in'], {
      stdout: (t) => void out.push(t),
      stderr: (t) => void out.push(t),
      env: deps.env,
      isTTY: false,
      cueDeps: () => deps,
    });
    expect(code).toBe(0);
    expect(out.join('')).toBe('Signed in. Nothing was sent.\n');
    expect(signIns).toBe(1);
    expect(relay.calls).toEqual([]);
  });
});
