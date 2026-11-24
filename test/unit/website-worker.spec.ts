import { describe, expect, it, vi } from 'vitest';

// @ts-expect-error -- the site's Worker is plain JavaScript, without types.
import worker from '../../website/worker.js';

const get = (path: string) => {
  const env = {
    GO_CLICKS: { writeDataPoint: vi.fn() },
    ASSETS: { fetch: vi.fn(async () => new Response('page')) },
  };
  return {
    env,
    response: worker.fetch(new Request(`https://backmesh.com${path}`), env),
  };
};

describe("the site's channel links", () => {
  it.each(['/go/hn', '/go/reddit-devops/'])(
    'sends %s to the repository and counts its channel',
    async (path) => {
      const { env, response } = get(path);
      const r = await response;
      expect(r.status).toBe(302);
      expect(r.headers.get('location')).toBe(
        'https://github.com/backmesh/backmesh',
      );
      const channel = path.split('/')[2];
      expect(env.GO_CLICKS.writeDataPoint).toHaveBeenCalledWith({
        blobs: [channel],
        indexes: [channel],
      });
    },
  );

  it.each(['/go/', '/go/HN', '/go/hn/x', '/go/lobsters', '/go/hn-'])(
    'serves %s from the assets, uncounted',
    async (path) => {
      const { env, response } = get(path);
      expect(await (await response).text()).toBe('page');
      expect(env.GO_CLICKS.writeDataPoint).not.toHaveBeenCalled();
    },
  );
});
