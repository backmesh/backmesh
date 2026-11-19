// The listener's spot-reclaim rerun goes through the Worker's /v1/rerun with
// its install key and runner tag: its own GitHub token can only read.
import { describe, expect, it } from 'vitest';

import { workerCancel, workerRerun } from '../../../src/listener/rerun.js';

const KEY = `bmk_${'ab'.repeat(32)}`;
const RUN = { owner: 'acme', repo: 'app', runId: 42 };

function fake(answer: Response) {
  const sent: { url: string; auth: string | null; body: unknown }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    sent.push({
      url,
      auth: new Headers(init.headers).get('Authorization'),
      body: JSON.parse(String(init.body)),
    });
    return answer.clone();
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

describe('workerRerun', () => {
  it("asks the Worker to rerun the run's failed jobs, naming the install's runner tag", async () => {
    const { fetch, sent } = fake(Response.json({ rerun: true }));
    const rerun = workerRerun({
      url: 'https://api.backmesh.test',
      key: KEY,
      install: 'a1b2c',
      fetch,
    });

    await rerun(RUN);

    expect(sent).toEqual([
      {
        url: 'https://api.backmesh.test/v1/rerun',
        auth: `Bearer ${KEY}`,
        body: { owner: 'acme', repo: 'app', run_id: 42, install: 'a1b2c' },
      },
    ]);
  });

  it("throws the Worker's refusal with its status, as retry reads GitHub's", async () => {
    const { fetch } = fake(
      Response.json({ error: 'not ours' }, { status: 403 }),
    );
    const rerun = workerRerun({
      url: 'https://x',
      key: KEY,
      install: 'a1b2c',
      fetch,
    });

    await expect(rerun(RUN)).rejects.toMatchObject({
      message: 'not ours',
      status: 403,
    });
  });

  it('asks the Worker to cancel a fork run, saying why', async () => {
    const { fetch, sent } = fake(Response.json({ cancelled: true }));
    const cancel = workerCancel({
      url: 'https://api.backmesh.test',
      key: KEY,
      install: 'a1b2c',
      fetch,
    });

    await cancel(RUN, 'limit');

    expect(sent).toEqual([
      {
        url: 'https://api.backmesh.test/v1/cancel',
        auth: `Bearer ${KEY}`,
        body: {
          owner: 'acme',
          repo: 'app',
          run_id: 42,
          install: 'a1b2c',
          reason: 'limit',
        },
      },
    ]);
  });
});
