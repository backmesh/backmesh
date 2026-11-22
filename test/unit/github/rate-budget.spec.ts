import { describe, expect, it } from 'vitest';

import { RateBudget, watchRate } from '../../../src/github/rate-budget.js';
import { fakeGitHub, json, octokitFor } from './fake-github.js';

const limit = (remaining: number, max = 5_000, reset = 600) => ({
  'x-ratelimit-remaining': String(remaining),
  'x-ratelimit-limit': String(max),
  'x-ratelimit-reset': String(reset),
});

describe('RateBudget', () => {
  it('holds reads below max(1,500, 20 %) of the limit until its reset', () => {
    let now = 0;
    const budget = new RateBudget(() => now);
    expect(budget.heldUntil()).toBeUndefined();
    budget.observe(200, limit(1_500));
    expect(budget.heldUntil()).toBeUndefined();
    budget.observe(200, limit(1_499));
    expect(budget.heldUntil()).toBe(600_000);
    // 20 % of a larger limit.
    budget.observe(200, limit(2_499, 12_500));
    expect(budget.heldUntil()).toBe(600_000);
    budget.observe(200, limit(2_500, 12_500));
    expect(budget.heldUntil()).toBeUndefined();
    budget.observe(200, limit(10));
    now = 600_000;
    expect(budget.heldUntil()).toBeUndefined();
    // Another resource's limit isn't the REST one.
    budget.observe(200, { ...limit(0), 'x-ratelimit-resource': 'search' });
    expect(budget.remaining).toBe(10);
  });

  it("pauses on a 429 or the limit's 403 as GitHub asks, but not on another 403", () => {
    let now = 0;
    const budget = new RateBudget(() => now);
    budget.observe(403, {});
    expect(budget.heldUntil()).toBeUndefined();
    budget.observe(429, { 'retry-after': '30' });
    expect(budget.heldUntil()).toBe(30_000);
    now = 30_000;
    budget.observe(403, limit(0, 5_000, 90));
    expect(budget.heldUntil()).toBe(90_000);
    now = 90_000;
    // No retry-after or reset ahead: a minute.
    budget.observe(429, {});
    expect(budget.heldUntil()).toBe(150_000);
  });

  it("hears every response and refusal of the octokit it watches, a 304's too", async () => {
    const URL = 'https://api.github.com/repos/acme/app';
    const { fetch } = fakeGitHub({
      [`GET ${URL}`]: [
        json(200, {}, limit(4_000)),
        () => new Response(null, { status: 304, headers: limit(3_999) }),
        json(429, { message: 'slow down' }, { 'retry-after': '5' }),
      ],
    });
    const octokit = octokitFor(fetch);
    const budget = new RateBudget(() => 0);
    watchRate(octokit, budget);
    const get = () => octokit.rest.repos.get({ owner: 'acme', repo: 'app' });
    await get();
    expect(budget.remaining).toBe(4_000);
    await expect(get()).rejects.toMatchObject({ status: 304 });
    expect(budget.remaining).toBe(3_999);
    await expect(get()).rejects.toMatchObject({ status: 429 });
    expect(budget.heldUntil()).toBe(5_000);
  });
});
