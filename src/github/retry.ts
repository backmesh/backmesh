import { setTimeout as delay } from 'node:timers/promises';

// Retry with backoff on transient errors, after ARC's client: transport
// errors, 429 and 5xx other than 501 are retried up to 4 times, backing off
// exponentially from 1 s with up to half again as jitter, capped at 30 s, and
// waiting a 429's or 503's Retry-After (actions/scaleset `http_client.go`
// DefaultShouldRetry and DefaultBackoff at 258f2c7b). backmesh caps that
// wait at 60 s, so a bad header can't park a listener.

export type Fetch = typeof fetch;
export type Log = (entry: { msg: string } & Record<string, unknown>) => void;
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface RetryOptions {
  max?: number;
  // Bounds each attempt, so a hung connection is retried; a long poll needs
  // more than its ~50 s. ARC's client timeout is 5 minutes.
  attemptTimeoutMs?: number;
  // Must reject when the signal aborts.
  sleep?: Sleep;
  random?: () => number;
  log?: Log;
}

const WAIT_MIN_MS = 1_000;
const WAIT_MAX_MS = 30_000;
const RETRY_AFTER_MAX_MS = 60_000;

export const sleepFor: Sleep = (ms, signal) => delay(ms, undefined, { signal });

export function retryingFetch(inner: Fetch, options: RetryOptions = {}): Fetch {
  const {
    max = 4,
    attemptTimeoutMs = 5 * 60_000,
    sleep = sleepFor,
    random = Math.random,
    log,
  } = options;

  return async (input, init) => {
    const callerSignal = init?.signal ?? undefined;
    for (let attempt = 0; ; attempt++) {
      const signals = [AbortSignal.timeout(attemptTimeoutMs)];
      if (callerSignal) signals.push(callerSignal);
      let response: Response | undefined;
      let error: unknown;
      try {
        response = await inner(input, {
          ...init,
          signal: AbortSignal.any(signals),
        });
      } catch (caught) {
        // A caller's abort is final; a transport error or attempt timeout isn't.
        if (callerSignal?.aborted) throw caught;
        error = caught;
      }
      if (response && !isTransient(response.status)) return response;
      if (attempt >= max) {
        if (response) return response;
        throw error;
      }
      const wait = backoff(attempt, response, random);
      log?.({
        msg: 'retrying request',
        url: redact(input),
        status: response?.status,
        error: error instanceof Error ? error.message : undefined,
        attempt: attempt + 1,
        waitMs: wait,
      });
      await response?.body?.cancel();
      await sleep(wait, callerSignal);
    }
  };
}

function isTransient(status: number): boolean {
  return status === 429 || (status >= 500 && status !== 501);
}

function backoff(
  attempt: number,
  response: Response | undefined,
  random: () => number,
): number {
  if (response?.status === 429 || response?.status === 503) {
    const retryAfter = response.headers.get('retry-after')?.trim();
    if (retryAfter && /^\d+$/.test(retryAfter)) {
      return Math.min(Number(retryAfter) * 1_000, RETRY_AFTER_MAX_MS);
    }
  }
  const base = WAIT_MIN_MS * 2 ** attempt;
  if (base >= WAIT_MAX_MS) return WAIT_MAX_MS;
  return Math.min(base + Math.floor(random() * (base / 2 + 1)), WAIT_MAX_MS);
}

// Message queue and JIT URLs carry no secret in the path, but drop the query
// anyway so a log line never holds one.
export function redact(input: Parameters<Fetch>[0]): string {
  const url = new URL(input instanceof Request ? input.url : String(input));
  return `${url.origin}${url.pathname}`;
}
