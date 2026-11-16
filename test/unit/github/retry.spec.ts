import { describe, expect, it } from 'vitest';

import { retryingFetch, type Fetch } from '../../../src/github/retry.js';

function scripted(steps: (number | Error)[], retryAfter = '7') {
  let calls = 0;
  const fetch: Fetch = async () => {
    const step = steps[Math.min(calls++, steps.length - 1)];
    if (step instanceof Error) throw step;
    return new Response(null, {
      status: step,
      headers: step === 429 ? { 'retry-after': retryAfter } : {},
    });
  };
  return { fetch, calls: () => calls };
}

function retrying(inner: Fetch) {
  const waits: number[] = [];
  const fetch = retryingFetch(inner, {
    sleep: async (ms) => void waits.push(ms),
    random: () => 0,
  });
  return { fetch, waits };
}

describe('retryingFetch', () => {
  it('retries 5xx with exponential backoff until success', async () => {
    const inner = scripted([500, 502, 200]);
    const { fetch, waits } = retrying(inner.fetch);
    const response = await fetch('https://api.github.com/x');
    expect(response.status).toBe(200);
    expect(waits).toEqual([1_000, 2_000]);
  });

  it.each([
    ['7', 7_000],
    ['3600', 60_000],
  ])("waits a 429's Retry-After of %s s, up to 60 s", async (header, ms) => {
    const { fetch, waits } = retrying(scripted([429, 200], header).fetch);
    await fetch('https://api.github.com/x');
    expect(waits).toEqual([ms]);
  });

  it('retries transport errors', async () => {
    const inner = scripted([new TypeError('fetch failed'), 200]);
    const { fetch } = retrying(inner.fetch);
    expect((await fetch('https://api.github.com/x')).status).toBe(200);
    expect(inner.calls()).toBe(2);
  });

  it.each([404, 409, 501])('returns %i without retrying', async (status) => {
    const inner = scripted([status]);
    const { fetch } = retrying(inner.fetch);
    expect((await fetch('https://api.github.com/x')).status).toBe(status);
    expect(inner.calls()).toBe(1);
  });

  it('gives up after 4 retries, returning the last response', async () => {
    const inner = scripted([503]);
    const { fetch, waits } = retrying(inner.fetch);
    expect((await fetch('https://api.github.com/x')).status).toBe(503);
    expect(inner.calls()).toBe(5);
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000]);
  });

  it('caps the backoff at 30 s and adds jitter below the cap', async () => {
    const waits: number[] = [];
    const fetch = retryingFetch(scripted([500]).fetch, {
      max: 6,
      sleep: async (ms) => void waits.push(ms),
      random: () => 0.9999999,
    });
    await fetch('https://api.github.com/x');
    expect(waits).toEqual([1_500, 3_000, 6_000, 12_000, 24_000, 30_000]);
  });

  it("doesn't retry once the caller aborts", async () => {
    const controller = new AbortController();
    const inner: Fetch = async () => {
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    };
    const { fetch, waits } = retrying(inner);
    await expect(
      fetch('https://api.github.com/x', { signal: controller.signal }),
    ).rejects.toThrow('aborted');
    expect(waits).toEqual([]);
  });

  it('stops a backoff wait when the caller aborts', async () => {
    const controller = new AbortController();
    const inner = scripted([503]);
    const fetch = retryingFetch(inner.fetch, { max: 1 });
    const pending = fetch('https://api.github.com/x', {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toThrow(/abort/i);
    expect(inner.calls()).toBe(1);
  });
});
