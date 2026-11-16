import { describe, expect, it } from 'vitest';

import { checkRunPoster } from '../../../src/github/checks.js';
import { fakeGitHub, json, octokitFor } from './fake-github.js';

const RUN = 'GET https://api.github.com/repos/acme/app/actions/runs/7';
const NOTE = {
  name: 'test',
  title: 'test lost its spot VM',
  summary: 'Rerun it.',
};

describe('checkRunPoster', () => {
  it("posts a neutral check run named after the job on the run's head SHA", async () => {
    const { fetch, calls } = fakeGitHub({
      [RUN]: json(200, { id: 7, head_sha: 'abc123' }),
      'POST https://api.github.com/repos/acme/app/check-runs': json(201, {
        id: 1,
      }),
    });
    const post = checkRunPoster(octokitFor(fetch), () => undefined);
    await post({ owner: 'acme', repo: 'app', runId: 7 }, NOTE);

    expect(calls.at(-1)!.body).toEqual({
      name: 'backmesh: test',
      head_sha: 'abc123',
      status: 'completed',
      conclusion: 'neutral',
      output: { title: NOTE.title, summary: NOTE.summary },
    });
  });

  it('skips a deleted run', async () => {
    const logged: unknown[] = [];
    const { fetch, calls } = fakeGitHub({
      [RUN]: json(404, { message: 'Not Found' }),
    });
    const post = checkRunPoster(octokitFor(fetch), (entry) =>
      logged.push(entry),
    );
    await post({ owner: 'acme', repo: 'app', runId: 7 }, NOTE);

    expect(calls).toHaveLength(1);
    expect(logged).toHaveLength(1);
  });

  it('throws any other failure', async () => {
    const { fetch } = fakeGitHub({
      [RUN]: json(200, { id: 7, head_sha: 'abc123' }),
      'POST https://api.github.com/repos/acme/app/check-runs': json(403, {
        message: 'Resource not accessible by integration',
      }),
    });
    const post = checkRunPoster(octokitFor(fetch), () => undefined);
    await expect(
      post({ owner: 'acme', repo: 'app', runId: 7 }, NOTE),
    ).rejects.toThrow(/not accessible/);
  });
});
