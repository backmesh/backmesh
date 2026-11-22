// The installation's REST rate limit, as every response to the listener's
// octokit reports it (`watchRate`): the gate's, the mint's run read, the
// planner's, the retry's and the job start reads alike. Only reads that can
// wait ask it (`heldUntil`); nothing else waits on it. The Worker's reruns
// and cancels use the App's own token for that one call, not this one.
import type { Octokit } from '@octokit/rest';

// Kept for the reads that can't wait: 1,500 of 5,000, 2,500 of 12,500.
const RESERVE = (limit: number) => Math.max(1_500, limit * 0.2);
// A 403 or 429 for the rate limit without a retry-after or a reset.
const PAUSE_MS = 60_000;

export class RateBudget {
  remaining: number | undefined;
  limit: number | undefined;
  private reset = -Infinity;
  private until = -Infinity;

  constructor(private readonly now: () => number = Date.now) {}

  observe(status: number, headers: Record<string, unknown> = {}): void {
    const num = (name: string) => Number(headers[name]);
    const resource = headers['x-ratelimit-resource'];
    // The REST limit's; search and GraphQL have their own.
    if (
      (resource === undefined || resource === 'core') &&
      num('x-ratelimit-limit') > 0 &&
      num('x-ratelimit-remaining') >= 0
    ) {
      this.remaining = num('x-ratelimit-remaining');
      this.limit = num('x-ratelimit-limit');
      this.reset = num('x-ratelimit-reset') * 1000;
    }
    const after = num('retry-after');
    // A 403 is the limit's only with its headers; a 429 always.
    if (
      status === 429 ||
      (status === 403 && (after > 0 || this.remaining === 0))
    )
      this.until = Math.max(
        this.until,
        after > 0
          ? this.now() + after * 1000
          : this.reset > this.now()
            ? this.reset
            : this.now() + PAUSE_MS,
      );
  }

  // Until when a read that can wait should, or undefined: while GitHub
  // asked for a pause, or the hour's reserve is reached before its reset.
  heldUntil(): number | undefined {
    const now = this.now();
    if (now < this.until) return this.until;
    if (
      this.remaining !== undefined &&
      this.remaining < RESERVE(this.limit!) &&
      now < this.reset
    )
      return this.reset;
    return undefined;
  }
}

// Feeds `budget` every response and refusal `octokit` gets.
export function watchRate(octokit: Octokit, budget: RateBudget): void {
  octokit.hook.after('request', (response) =>
    budget.observe(response.status, response.headers),
  );
  octokit.hook.error('request', (error) => {
    const { status, response } = error as {
      status?: number;
      response?: { headers?: Record<string, unknown> };
    };
    if (status) budget.observe(status, response?.headers);
    throw error;
  });
}
