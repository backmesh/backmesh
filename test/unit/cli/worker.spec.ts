// Every sign-in is GitHub's device flow with the backmesh App, run from the
// CLI against github.com: a slow or failing GitHub, or a person who comes
// back after the code expired, must not end it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GITHUB_APP_CLIENT_ID,
  signIn as signInAlone,
  signInForCleanup,
  signInForKey,
} from '../../../src/cli/worker.js';
import { DEVICE, fakeWorker, INSTALL_KEY, SIGNED_IN } from './fakes.js';

const START = Date.UTC(2026, 10, 19, 5, 30);
const HOUR = 3_600_000;
let timeouts: number[];

// Fake timers, and AbortSignal.timeout on them (Node's own isn't faked), so
// a request that takes too long is cut at its timeout in fake time.
beforeEach(() => {
  vi.useFakeTimers({ now: START });
  timeouts = [];
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    timeouts.push(ms);
    const controller = new AbortController();
    setTimeout(
      () =>
        controller.abort(
          new DOMException('The operation timed out.', 'TimeoutError'),
        ),
      ms,
    );
    return controller.signal;
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// Runs fake time forward until `promise` settles, or `limit` passes.
async function settle<T>(promise: Promise<T>, limit = 8 * HOUR) {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true),
  );
  const until = Date.now() + limit;
  while (!done && Date.now() < until) await vi.advanceTimersByTimeAsync(1000);
  return promise;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const pending = json({ error: 'authorization_pending' });
const slowDown = json({ error: 'slow_down', interval: 10 });
const expired = json({ error: 'expired_token' });
const token = json({ access_token: SIGNED_IN, token_type: 'bearer' });
// An answer that takes `ms`, or never comes, unless its request is aborted.
const after =
  (ms: number, answer = token) =>
  (signal?: AbortSignal) =>
    new Promise<Response>((resolve, reject) => {
      const timer =
        ms < Infinity && setTimeout(() => resolve(answer.clone()), ms);
      signal?.addEventListener('abort', () => {
        if (timer) clearTimeout(timer);
        reject(signal.reason);
      });
    });
const silent = after(Infinity);
const keyAnswer = json({
  org_id: 7,
  org: 'acme',
  install: 'i1',
  key: INSTALL_KEY,
});

function signIn(worker: ReturnType<typeof fakeWorker>, install?: string) {
  const lines: string[] = [];
  const key = signInForKey(
    'acme',
    { env: {}, fetch: worker.fetch, print: (line) => lines.push(line) },
    install,
  );
  return { key: settle(key), lines };
}

describe('signInForKey', () => {
  it('signs in on github.com with the App, shows the code and its expiry, and sends the Worker only the token', async () => {
    const worker = fakeWorker({ polls: [pending, slowDown, pending, token] });
    const { key, lines } = signIn(worker, 'ab'.repeat(16));

    expect(await key).toEqual({ key: INSTALL_KEY, token: SIGNED_IN });
    // The App's public client ID, and no scopes: an App's user token
    // holds what both the App and the person can do.
    expect(worker.signIns().map((s) => s.form)).toEqual([
      { client_id: GITHUB_APP_CLIENT_ID },
    ]);
    expect(worker.tokenPolls().map((p) => p.form)).toEqual(
      Array(4).fill({
        client_id: GITHUB_APP_CLIENT_ID,
        device_code: DEVICE.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    );
    // At the interval, 5 s longer after slow_down.
    expect(worker.tokenPolls().map((p) => p.at - START)).toEqual([
      5_000, 10_000, 20_000, 30_000,
    ]);
    // One plain line, readable in a CI job's log, with when the code expires.
    expect(lines).toEqual([
      'Sign in with GitHub once, as an admin of acme, so backmesh can connect to it: open https://github.com/login/device and enter ABCD-1234 (it expires at 05:45 UTC).',
    ]);
    // The device code never leaves the CLI; the Worker gets the token.
    expect(worker.calls).not.toContain('POST /v1/installs/device');
    expect(worker.bodies).toEqual([
      { org: 'acme', github_token: SIGNED_IN, install: 'ab'.repeat(16) },
    ]);
    expect(new Set(timeouts)).toEqual(new Set([30_000]));
  });

  it('completes on a poll GitHub answers after 9 s', async () => {
    const worker = fakeWorker({ polls: [after(9_000)] });

    expect((await signIn(worker).key).key).toBe(INSTALL_KEY);
    expect(worker.tokenPolls()).toHaveLength(1);
  });

  it.each([
    ['a timed-out', silent],
    ['a 5xx', json({ message: 'Bad gateway' }, 502)],
    ['an unreachable', new TypeError('fetch failed')],
  ])('keeps waiting after %s poll', async (_, failure) => {
    const worker = fakeWorker({ polls: [pending, failure, failure, token] });

    expect((await signIn(worker).key).key).toBe(INSTALL_KEY);
    expect(worker.tokenPolls()).toHaveLength(4);
  });

  it('retries the code request when GitHub fails it', async () => {
    const worker = fakeWorker({
      codes: [silent, json({}, 503), json(DEVICE)],
    });
    const { key, lines } = signIn(worker);

    expect((await key).key).toBe(INSTALL_KEY);
    expect(worker.signIns()).toHaveLength(3);
    expect(lines).toHaveLength(1);
  });

  it.each([
    ['runs out', [pending]],
    ['is refused as expired', [pending, expired]],
  ])(
    'prints a new code with its expiry when the code %s, and completes on it',
    async (_, first) => {
      const next = { ...DEVICE, device_code: 'dev-2', user_code: 'WXYZ-5678' };
      const worker = fakeWorker({
        codes: [json(DEVICE), json(next)],
        polls: [
          ...first,
          async () => (worker.signIns().length > 1 ? token : pending).clone(),
        ],
      });
      const { key, lines } = signIn(worker);

      expect((await key).key).toBe(INSTALL_KEY);
      expect(lines).toHaveLength(2);
      expect(lines[1]).toMatch(
        /enter WXYZ-5678 \(it expires at \d\d:\d\d UTC\)\.$/,
      );
      expect(worker.tokenPolls().at(-1)!.form.device_code).toBe('dev-2');
    },
  );

  it('stops when GitHub refuses the device code', async () => {
    const worker = fakeWorker({
      codes: [
        json(
          {
            error: 'device_flow_disabled',
            error_description:
              'Device Flow must be explicitly enabled for this App',
          },
          400,
        ),
      ],
    });

    await expect(signIn(worker).key).rejects.toThrow(
      'GitHub refused the sign-in: Device Flow must be explicitly enabled for this App',
    );
    expect(worker.signIns()).toHaveLength(1);
  });

  it('ends the sign-in when the person denies it', async () => {
    const worker = fakeWorker({ polls: [json({ error: 'access_denied' })] });

    await expect(signIn(worker).key).rejects.toThrow('denied');
    expect(worker.bodies).toEqual([]);
  });

  it('gives up after six hours without a sign-in', async () => {
    const worker = fakeWorker({ polls: [pending] });

    await expect(signIn(worker).key).rejects.toThrow(
      'Nobody finished the GitHub sign-in in 6 hours',
    );
    expect(Date.now() - START).toBeLessThanOrEqual(6 * HOUR + 60_000);
    // A fresh code every 15 minutes.
    expect(worker.signIns().length).toBeGreaterThanOrEqual(24);
  });

  it("refuses with the Worker's error when the signer can't manage the org's runners", async () => {
    const error =
      'Creating a backmesh install for acme needs the right to manage its runners.';
    const worker = fakeWorker({ installs: [json({ error }, 403)] });

    await expect(signIn(worker).key).rejects.toThrow(error);
  });

  it('prints the App install link and sends the same sign-in again once the App is on the org', async () => {
    const link =
      'https://github.com/apps/backmesh/installations/new/permissions?target_id=7';
    const notInstalled = json(
      { error: 'app_not_installed', install_url: link },
      409,
    );
    const worker = fakeWorker({
      installs: [notInstalled, notInstalled, keyAnswer],
    });
    const { key, lines } = signIn(worker);

    expect((await key).key).toBe(INSTALL_KEY);
    expect(lines.filter((l) => l.includes(link))).toHaveLength(1);
    expect(worker.signIns()).toHaveLength(1);
    expect(worker.bodies).toHaveLength(3);
  });

  it.each([
    ['unreachable', new TypeError('fetch failed')],
    ['slow', silent],
    ['failing', json({ error: 'GitHub refused' }, 502)],
  ])('retries the Worker when it is %s', async (_, failure) => {
    const worker = fakeWorker({ installs: [failure, failure, keyAnswer] });

    expect((await signIn(worker).key).key).toBe(INSTALL_KEY);
    expect(worker.signIns()).toHaveLength(1);
  });

  it('asks for a retry when the Worker stays unreachable', async () => {
    const worker = fakeWorker({ installs: [json({ error: 'down' }, 503)] });

    await expect(signIn(worker).key).rejects.toThrow(
      'Retry when backmesh.com is reachable',
    );
  });

  it('waits longer and keeps asking when rate-limited', async () => {
    const limited = json({ error: 'slow down' }, 429);
    const worker = fakeWorker({ installs: [limited, keyAnswer] });

    expect((await signIn(worker).key).key).toBe(INSTALL_KEY);
  });
});

describe('signIn (plain, for a re-sign-in)', () => {
  it("is GitHub's device flow alone, with no call to the Worker", async () => {
    const worker = fakeWorker({ polls: [pending, silent, token] });
    const token_ = await settle(
      signInAlone({ env: {}, fetch: worker.fetch, print: () => {} }),
    );

    expect(token_).toBe(SIGNED_IN);
    expect(worker.calls.every((c) => c.startsWith('POST github.com/'))).toBe(
      true,
    );
  });
});

describe('signInForCleanup', () => {
  it('sends the token, not a device code, and survives an expired code', async () => {
    const worker = fakeWorker({ polls: [expired, token] });
    const cleanup = await settle(
      signInForCleanup('acme', undefined, {
        env: {},
        fetch: worker.fetch,
        print: () => {},
      }),
    );

    expect(cleanup.cleanup_id).toBe('c'.repeat(64));
    expect(worker.signIns()).toHaveLength(2);
    expect(worker.bodies).toEqual([{ org: 'acme', github_token: SIGNED_IN }]);
  });
});
