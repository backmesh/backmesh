import { describe, expect, it } from 'vitest';

import { AppNotInstalled } from '../../../src/github/installation-token.js';
import { waitForToken } from '../../../src/listener/installation.js';

const INSTALL_URL =
  'https://github.com/apps/backmesh/installations/new/permissions?target_id=9';

describe('waitForToken', () => {
  it('waits with backoff capped at 5 minutes, logging the install link, until the broker mints', async () => {
    const answers = [
      new AppNotInstalled(INSTALL_URL),
      new Error('502'),
      ...Array(5).fill(new AppNotInstalled(INSTALL_URL)),
    ];
    const waits: number[] = [];
    const logs: Record<string, unknown>[] = [];
    let calls = 0;
    const tokens = {
      get: async () => {
        calls++;
        const answer = answers.shift();
        if (answer) throw answer;
        return 'ghs_1';
      },
    };

    await waitForToken(
      tokens,
      (entry) => void logs.push(entry),
      new AbortController().signal,
      async (ms) => void waits.push(ms),
    );

    expect(calls).toBe(8);
    expect(waits).toEqual([
      10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000,
    ]);
    expect(logs[0]).toMatchObject({ installUrl: INSTALL_URL });
    expect(logs[1]).toMatchObject({ error: 'Error: 502' });
  });
});
