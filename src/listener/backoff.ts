// The startup-failure backoff of one scale set, after
// ARC's `maxFailures`: after 5 consecutive runners end without starting a
// job, mint nothing but one probe per 1, 2, 4, 8, 16, then 30 minutes, until
// a `JobStarted`. In memory only: a restart re-arms it after 5 new failures.
const THRESHOLD = 5;
const FIRST_DELAY_MS = 60_000;
const MAX_DELAY_MS = 30 * 60_000;

export class StartupBackoff {
  failures = 0;
  // The last failure's end reason and what its Job said, such as
  // "exited: Exited with code 1".
  lastEnd: string | undefined;
  delayMs: number | undefined;
  nextProbeAt: number | undefined;
  private probe: string | undefined;

  // How many of `short` runners the scale set may mint now.
  allowance(short: number, now: number): number {
    if (this.delayMs === undefined) return short;
    const due = this.probe === undefined && now >= (this.nextProbeAt ?? 0);
    return due ? Math.min(short, 1) : 0;
  }

  minted(name: string): void {
    if (this.delayMs !== undefined) this.probe = name;
  }

  // A runner this process minted ended without starting a job. `failure` is
  // how it ended, or undefined when it doesn't count: a reclaim, the
  // listener's own scale-down, or a submit that never landed.
  ended(name: string, failure: string | undefined, now: number): void {
    const probe = name === this.probe;
    if (probe) this.probe = undefined;
    if (failure === undefined) {
      if (probe) this.nextProbeAt = now;
      return;
    }
    this.failures++;
    this.lastEnd = failure;
    if (probe && this.delayMs !== undefined) {
      this.delayMs = Math.min(this.delayMs * 2, MAX_DELAY_MS);
    } else if (this.failures >= THRESHOLD && this.delayMs === undefined) {
      this.delayMs = FIRST_DELAY_MS;
    } else {
      return;
    }
    this.nextProbeAt = now + this.delayMs;
  }

  reset(): void {
    this.failures = 0;
    this.delayMs = this.nextProbeAt = this.probe = undefined;
  }
}
