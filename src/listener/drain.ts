import { z } from 'zod';

import { sleepFor, type Log, type Sleep } from '../github/retry.js';
import type { Scaler } from './scaler.js';

// What `/drain` returns and `backmesh uninstall` polls:
// the listener stops taking jobs and drains its runner Jobs to zero before
// the control plane goes. The CLI cleans up GitHub itself.
export const drainStatusSchema = z.object({
  state: z.enum(['running', 'done', 'failed']),
  // Runner Jobs still listed at the last count.
  runnerJobs: z.number().int(),
  error: z.string().nullable(),
});
export type DrainStatus = z.infer<typeof drainStatusSchema>;

export const DRAINING: DrainStatus = {
  state: 'running',
  runnerJobs: 0,
  error: null,
};

export interface DrainDeps {
  scaler: Pick<Scaler, 'drain'>;
  log: Log;
  sleep?: Sleep;
  pollMs?: number;
}

const POLL_MS = 10_000;
// About 10 minutes. Terminated Jobs leave the listing once their runner
// exits; past this, uninstall's step 3 terminates what's left and waits for it.
const POLLS = 60;

// Runs once the sessions are deleted, so no job is taken.
export async function drain(
  deps: DrainDeps,
  progress: (runnerJobs: number) => void,
): Promise<DrainStatus> {
  const { log, sleep = sleepFor, pollMs = POLL_MS } = deps;
  let runnerJobs = 0;
  try {
    for (let poll = 1; ; poll++) {
      runnerJobs = await deps.scaler.drain();
      progress(runnerJobs);
      if (!runnerJobs || poll === POLLS) break;
      await sleep(pollMs);
    }
    return { state: 'done', runnerJobs, error: null };
  } catch (error) {
    log({ msg: 'drain failed', error: String(error) });
    return { ...DRAINING, state: 'failed', runnerJobs, error: String(error) };
  }
}
