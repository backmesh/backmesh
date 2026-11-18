import { describe, expect, it } from 'vitest';

import {
  signIn as signInAlone,
  signInForKey,
} from '../../../src/cli/worker.js';
import { fakeWorker, INSTALL_KEY, SIGNED_IN } from './fakes.js';

function signIn(
  installs: (Response | Error)[],
  install?: string,
  signIns?: (Response | Error)[],
  env: NodeJS.ProcessEnv = {},
) {
  const worker = fakeWorker({ installs, signIns });
  const waits: number[] = [];
  const lines: string[] = [];
  const key = signInForKey(
    'acme',
    {
      env,
      fetch: worker.fetch,
      print: (line) => lines.push(line),
      wait: async (ms) => void waits.push(ms),
    },
    install,
  );
  return { key, waits, lines, worker };
}

const pending = (slowDown = false) =>
  Response.json(
    { pending: true, ...(slowDown && { slow_down: true }) },
    { status: 202 },
  );
const issued = Response.json({
  org_id: 7,
  org: 'acme',
  install: 'i1',
  key: INSTALL_KEY,
  github_token: SIGNED_IN,
});

describe('signInForKey', () => {
  it('shows the code, polls at the interval, slows down when told, and returns the key', async () => {
    const { key, waits, lines, worker } = signIn(
      [pending(), pending(true), pending(), issued],
      'ab'.repeat(16),
    );

    // The same sign-in's token is the control plane's, so it asks
    // for the control plane's scopes.
    expect(await key).toEqual({ key: INSTALL_KEY, token: SIGNED_IN });
    expect(worker.devices).toEqual([{ control_plane: true }]);
    expect(waits).toEqual([5_000, 5_000, 10_000, 10_000]);
    // One plain line, readable in a CI job's log.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /https:\/\/github\.com\/login\/device and enter ABCD-1234\.$/,
    );
    expect(lines[0]).not.toContain('\r');
    expect(lines[0]).not.toContain('\u001b');
    // The device code is a credential: sent, never shown.
    expect(lines[0]).not.toContain('dev-3584e1');
    expect(worker.bodies).toHaveLength(4);
    expect(worker.bodies[0]).toEqual({
      org: 'acme',
      device_code: 'dev-3584e1',
      install: 'ab'.repeat(16),
    });
  });

  it("refuses with the Worker's error when the user isn't an org admin", async () => {
    const error = 'You need the admin role in acme.';
    const { key } = signIn([Response.json({ error }, { status: 403 })]);

    await expect(key).rejects.toThrow(error);
  });

  it('refuses an expired or denied code', async () => {
    const { key } = signIn([
      pending(),
      Response.json({ error: 'expired' }, { status: 400 }),
    ]);

    await expect(key).rejects.toThrow('expired');
  });

  it.each([
    ['unreachable', new TypeError('fetch failed'), "didn't answer"],
    [
      'failing with a reason',
      Response.json({ error: 'GitHub refused' }, { status: 502 }),
      '502: GitHub refused',
    ],
  ])('asks for a retry when the Worker is %s', async (_, failure, reason) => {
    const { key } = signIn([pending(), failure]);

    await expect(key).rejects.toThrow(reason);
    await expect(key).rejects.toThrow('Retry when backmesh.com is reachable');
  });

  it('waits longer and keeps polling when rate-limited', async () => {
    const limited = Response.json({ error: 'slow down' }, { status: 429 });
    const { key, waits } = signIn([limited, issued]);

    expect((await key).key).toBe(INSTALL_KEY);
    expect(waits).toEqual([5_000, 10_000]);
  });
});

describe('signInForKey with BACKMESH_SIGN_IN_TOKEN', () => {
  const env = { BACKMESH_SIGN_IN_TOKEN: SIGNED_IN };

  it('sends the token in place of a device code, and prints no code', async () => {
    const limited = Response.json({ error: 'slow down' }, { status: 429 });
    const { key, lines, worker, waits } = signIn(
      [limited, issued],
      undefined,
      undefined,
      env,
    );

    expect(await key).toEqual({ key: INSTALL_KEY, token: SIGNED_IN });
    expect(worker.devices).toEqual([]);
    expect(worker.bodies).toEqual([
      { org: 'acme', github_token: SIGNED_IN },
      { org: 'acme', github_token: SIGNED_IN },
    ]);
    expect(waits).toEqual([10_000]);
    expect(lines).toEqual([]);
  });

  it("refuses with the Worker's reason, and never falls back to a device code", async () => {
    const error = "GitHub doesn't know GITHUB_TOKEN as a backmesh sign-in";
    const { key, worker } = signIn(
      [Response.json({ error }, { status: 401 })],
      undefined,
      undefined,
      env,
    );

    await expect(key).rejects.toThrow(error);
    expect(worker.devices).toEqual([]);
  });
});

describe('signIn (plain, for a re-sign-in)', () => {
  it("signs in through GitHub's device flow", async () => {
    const worker = fakeWorker();
    const token = await signInAlone({
      env: {},
      fetch: worker.fetch as typeof globalThis.fetch,
      print: () => {},
      wait: async () => {},
    });

    expect(token).toBe(SIGNED_IN);
    expect(worker.devices).toEqual([{ control_plane: true }]);
  });
});
