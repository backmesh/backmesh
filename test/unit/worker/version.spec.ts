// `GET /v1/version`: the commit the Worker on api.backmesh.com was built
// from, which e2e.yml checks against the release under test.
import { describe, expect, it } from 'vitest';

import worker from '../../../worker/src/index.js';
import { ORIGIN, testEnv } from './fakes.js';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';

describe('GET /v1/version', () => {
  it('answers the commit the Worker was built from', async () => {
    const res = await worker.fetch(new Request(`${ORIGIN}/v1/version`), {
      ...testEnv(),
      COMMIT,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ commit: COMMIT });
  });
});
