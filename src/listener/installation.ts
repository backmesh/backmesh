import {
  AppNotInstalled,
  type InstallationTokens,
} from '../github/installation-token.js';
import { sleepFor, type Log, type Sleep } from '../github/retry.js';

const FIRST_WAIT_MS = 10_000;
const MAX_WAIT_MS = 5 * 60_000;

// Until the broker mints a token, which needs the App installed on the org,
// the listener waits, backing off from 10 s to 5 minutes and
// logging the install link, instead of exiting into a crash loop. Rejects
// when `signal` aborts.
export async function waitForToken(
  tokens: Pick<InstallationTokens, 'get'>,
  log: Log,
  signal: AbortSignal,
  sleep: Sleep = sleepFor,
): Promise<void> {
  for (
    let waitMs = FIRST_WAIT_MS;
    ;
    waitMs = Math.min(waitMs * 2, MAX_WAIT_MS)
  ) {
    try {
      await tokens.get();
      return;
    } catch (error) {
      log(
        error instanceof AppNotInstalled
          ? {
              msg: "The backmesh App isn't installed on the org; waiting",
              installUrl: error.installUrl,
              retryInMs: waitMs,
            }
          : {
              msg: 'token broker failed; retrying',
              retryInMs: waitMs,
              error: String(error),
            },
      );
    }
    await sleep(waitMs, signal);
  }
}
