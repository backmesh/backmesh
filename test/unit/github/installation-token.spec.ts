import { describe, expect, it } from 'vitest';

import {
  AppNotInstalled,
  InstallationTokens,
  KeyRefused,
  installationOctokit,
} from '../../../src/github/installation-token.js';
import { fakeGitHub, json } from './fake-github.js';

const BROKER = 'https://api.backmesh.com';
const MINT = `POST ${BROKER}/v1/token`;
const KEY = `bmk_${'0'.repeat(64)}`;
const INSTALL_URL =
  'https://github.com/apps/backmesh/installations/new/permissions?target_id=9';

// The broker's answers in order; a minted token lasts an hour from `now`.
function setup(
  now: { value: Date },
  answers: (number | 'token' | 'other-org')[] = ['token'],
) {
  let minted = 0;
  const broker = fakeGitHub({
    [MINT]: () => {
      const answer = answers.length > 1 ? answers.shift()! : answers[0]!;
      if (answer === 409) {
        return json(409, {
          error: 'app_not_installed',
          install_url: INSTALL_URL,
        })();
      }
      // 409.5: a 409 that isn't `app_not_installed`.
      if (typeof answer === 'number') {
        return json(Math.floor(answer), { error: 'x' })();
      }
      minted++;
      return json(200, {
        token: `ghs_${minted}`,
        expires_at: new Date(now.value.getTime() + 60 * 60_000).toISOString(),
        permissions: { actions: 'read', checks: 'write' },
        installation_permissions: { actions: 'write', checks: 'write' },
        org: { id: 9, login: answer === 'other-org' ? 'evil' : 'Acme' },
      })();
    },
  });
  const tokens = new InstallationTokens(
    { url: BROKER, installKey: KEY, org: 'acme' },
    broker.fetch,
    () => now.value,
  );
  return { tokens, broker };
}

// Lets a background refresh finish.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const at = (time: string) => ({ value: new Date(`2026-11-04T${time}Z`) });

describe('InstallationTokens', () => {
  it('mints from the broker with the install key', async () => {
    const { tokens, broker } = setup(at('12:00:00'));
    expect(await tokens.get()).toBe('ghs_1');
    expect(broker.calls[0]?.headers.get('authorization')).toBe(`Bearer ${KEY}`);
  });

  it("records the token's permissions, as an installation keeps its old ones", async () => {
    const { tokens } = setup(at('12:00:00'));
    expect(tokens.permissions).toBeUndefined();
    await tokens.get();
    expect(tokens.permissions?.actions).toBe('read');
    // What the installation grants the App: backmesh.com's run actions need
    // Actions write there.
    expect(tokens.installationPermissions?.actions).toBe('write');
    // What the listener's status reports.
    expect(tokens.actionsPermission()).toBe('write');
  });

  it('refreshes in the background from 30 minutes before expiry', async () => {
    const now = at('12:00:00');
    const { tokens, broker } = setup(now);
    await tokens.get();
    now.value = new Date('2026-11-04T12:29:00Z');
    expect(await tokens.get()).toBe('ghs_1');
    expect(broker.calls).toHaveLength(1);
    now.value = new Date('2026-11-04T12:31:00Z');
    expect(await tokens.get()).toBe('ghs_1');
    await settle();
    expect(await tokens.get()).toBe('ghs_2');
    expect(broker.calls).toHaveLength(2);
  });

  it('serves the current token at once through a broker outage, retrying once a minute, and reports it until the broker answers', async () => {
    const now = at('12:00:00');
    const { tokens, broker } = setup(now, ['token', 503, 503, 503, 'token']);
    await tokens.get();
    now.value = new Date('2026-11-04T12:40:00Z');
    expect(await tokens.get()).toBe('ghs_1');
    await settle();
    expect(tokens.unreachable).toEqual({
      since: '2026-11-04T12:40:00.000Z',
      error: 'The token broker answered 503: x',
    });
    // Within the minute, no caller calls the broker again.
    now.value = new Date('2026-11-04T12:40:59Z');
    expect(await tokens.get()).toBe('ghs_1');
    await settle();
    expect(broker.calls).toHaveLength(2);
    // A minute on, a caller's refresh tries again in the background.
    now.value = new Date('2026-11-04T12:41:00Z');
    expect(await tokens.get()).toBe('ghs_1');
    await settle();
    expect(broker.calls).toHaveLength(3);
    // Past the token's last minute, the outage reaches the caller.
    now.value = new Date('2026-11-04T12:59:30Z');
    await expect(tokens.get()).rejects.toThrow(/answered 503/);
    expect(tokens.unreachable?.since).toBe('2026-11-04T12:40:00.000Z');
    expect(await tokens.get()).toBe('ghs_2');
    expect(tokens.unreachable).toBeNull();
  });

  it('tells a refused install key apart from an outage, keeping when the failures began', async () => {
    const now = at('12:00:00');
    const { tokens } = setup(now, [503, 401]);
    await expect(tokens.get()).rejects.toThrow(/answered 503/);
    now.value = new Date('2026-11-04T12:05:00Z');
    await expect(tokens.get()).rejects.toThrow(KeyRefused);
    expect(tokens.unreachable).toEqual({
      since: '2026-11-04T12:00:00.000Z',
      error: expect.stringMatching(/backmesh upgrade/),
    });
  });

  it("names the install link while the App isn't installed, which shows the broker answers", async () => {
    const { tokens } = setup(at('12:00:00'), [503, 409]);
    await expect(tokens.get()).rejects.toThrow(/answered 503/);
    const error = await tokens.get().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppNotInstalled);
    expect((error as AppNotInstalled).installUrl).toBe(INSTALL_URL);
    expect(tokens.unreachable).toBeNull();
  });

  it('reports an installation removed after a token until a mint succeeds again', async () => {
    const now = at('12:00:00');
    const { tokens } = setup(now, ['token', 409, 409, 'token']);
    await tokens.get();
    expect(tokens.notInstalled).toBeNull();
    // The background refresh finds the installation gone.
    now.value = new Date('2026-11-04T12:40:00Z');
    expect(await tokens.get()).toBe('ghs_1');
    await settle();
    expect(tokens.notInstalled).toEqual({
      since: '2026-11-04T12:40:00.000Z',
      installUrl: INSTALL_URL,
    });
    // Past expiry it reaches the caller, keeping when it began.
    now.value = new Date('2026-11-04T12:59:30Z');
    await expect(tokens.get()).rejects.toThrow(AppNotInstalled);
    expect(tokens.notInstalled?.since).toBe('2026-11-04T12:40:00.000Z');
    // Reinstalled: the next mint clears it.
    expect(await tokens.get()).toBe('ghs_2');
    expect(tokens.notInstalled).toBeNull();
  });

  it('fails on another 409', async () => {
    const { tokens } = setup(at('12:00:00'), [409.5]);
    const error = await tokens.get().catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(AppNotInstalled);
    expect(String(error)).toMatch(/answered 409: x/);
  });

  it("refuses a token for an org that isn't the listener's", async () => {
    const { tokens } = setup(at('12:00:00'), ['other-org']);
    await expect(tokens.get()).rejects.toThrow(/for evil, not acme/);
  });

  it('shares one mint between concurrent callers', async () => {
    const { tokens } = setup(at('12:00:00'));
    const all = await Promise.all([tokens.get(), tokens.get(), tokens.get()]);
    expect(all).toEqual(['ghs_1', 'ghs_1', 'ghs_1']);
  });

  it('authenticates REST calls with the installation token', async () => {
    const { tokens, broker } = setup(at('12:00:00'));
    const rest = fakeGitHub({
      'GET https://api.github.com/orgs/acme': json(200, { login: 'acme' }),
    });
    const octokit = installationOctokit(tokens, async (input, init) =>
      String(input).startsWith(BROKER)
        ? broker.fetch(input, init)
        : rest.fetch(input, init),
    );
    await octokit.orgs.get({ org: 'acme' });
    expect(rest.calls[0]?.headers.get('authorization')).toBe('token ghs_1');
  });
});
