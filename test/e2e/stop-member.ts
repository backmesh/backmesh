// Orchestrates the stop member: a job on
// the label waits in an INT-ignoring container (lost-runner-check.yml's
// `step: docker`), ci-install's `stop-runner` mode ends its runner Job the
// same way a manual trial did (backmesh runs 42753183250 and 42753320207),
// and GitHub must mark the job failed within 15 s of that request;
// ci-install's `diagnose` mode must then show the runner Job cleaned up.
// Real GitHub and anycloud calls are injected (`StopMemberDeps`) so the
// polling and assertion logic here is tested without dispatching anything;
// `run-stop-member.ts` wires the real adapter.

export interface JobStatus {
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: string | null;
  runnerName: string | null;
  /** ISO 8601, once `status` is `completed`. */
  completedAt: string | null;
}

export interface RunnerJobDiagnosis {
  /** ISO 8601, once anycloud has cleaned the runner Job's VM up. */
  cleanedAt: string | null;
  cleanupError: string | null;
}

export interface StopMemberDeps {
  /** Dispatches lost-runner-check.yml for `label` with `step: docker` and
   * resolves with its run id once GitHub has queued it. */
  dispatchLostRunnerCheck(label: string): Promise<number>;
  /** The run's one job, however far along. */
  getJob(runId: number): Promise<JobStatus>;
  /** Cancels `runId` if it's still running: best-effort cleanup for when
   * something else here throws before the runner Job (and its VM) would
   * otherwise end on its own. */
  cancelRun(runId: number): Promise<void>;
  /** ci-install's `stop-runner` mode: terminates `runnerId`'s VM Job and
   * resolves with the moment it asked anycloud to (the step's own "at"
   * timestamp), not when ci-install's dispatch happened to start. */
  terminateRunner(runnerId: string): Promise<string>;
  /** ci-install's `diagnose` mode for one runner Job id, already retried
   * (`diagnoseWithRetry`) as far as it's going to be: `cleanedAt` is null
   * only once that's given up. */
  diagnoseRunner(runnerId: string): Promise<RunnerJobDiagnosis>;
  /** Milliseconds to sleep between polls; injected so tests run instantly. */
  sleep(ms: number): Promise<void>;
}

export interface StopMemberResult {
  runnerId: string;
  terminatedAt: string;
  failedAt: string;
  secondsToFail: number;
}

const POLL_INTERVAL_MS = 2000;
const RUNNER_WAIT_TIMEOUT_MS = 5 * 60_000;
const FAIL_WITHIN_SECONDS = 15;

async function poll<T>(
  sleep: StopMemberDeps['sleep'],
  timeoutMs: number,
  attempt: () => Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await attempt();
    if (result !== undefined) return result;
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs} ms waiting`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

export async function runStopMember(
  deps: StopMemberDeps,
  label: string,
): Promise<StopMemberResult> {
  const runId = await deps.dispatchLostRunnerCheck(label);
  try {
    return await assertStopped(deps, label, runId);
  } catch (error) {
    // Best effort, unconditional: whatever failed above, don't leave the
    // check's own runner Job (and its VM) running for the rest of
    // lost-runner-check.yml's 30-minute timeout. This never gates on reading
    // the job first: a status read can itself throw (no job listed yet, a
    // label mismatch, an API error), which must never skip the cancel it
    // was meant to guard. Cancelling an already-completed run just errors,
    // swallowed the same as any other cancel failure.
    try {
      await deps.cancelRun(runId);
    } catch {
      // Swallow: the original error is what matters.
    }
    throw error;
  }
}

async function assertStopped(
  deps: StopMemberDeps,
  label: string,
  runId: number,
): Promise<StopMemberResult> {
  const runnerId = await poll(deps.sleep, RUNNER_WAIT_TIMEOUT_MS, async () => {
    const job = await deps.getJob(runId);
    if (job.status === 'completed') {
      throw new Error(
        `${label}'s lost-runner-check job ended (${job.conclusion ?? 'unknown'}) before it ever had a runner`,
      );
    }
    // GitHub reports `runner_name: ""` (not null) before a runner has
    // registered yet, same as it does once the job is queued; treat that
    // empty (or whitespace-only) string exactly like null, or the poll
    // returns before there's a real runner to terminate (run 42775988257:
    // `terminateRunner("")` dispatched ci-install.yml's stop-runner with an
    // empty runner id, which it then refused).
    return job.runnerName && job.runnerName.trim() ? job.runnerName : undefined;
  });

  const terminatedAt = await deps.terminateRunner(runnerId);

  const failedJob = await poll(
    deps.sleep,
    (FAIL_WITHIN_SECONDS + 60) * 1000,
    async () => {
      const job = await deps.getJob(runId);
      return job.status === 'completed' ? job : undefined;
    },
  );
  if (failedJob.conclusion !== 'failure') {
    throw new Error(
      `${label}'s lost-runner-check job ended ${failedJob.conclusion ?? 'unknown'}, not failure, after terminating ${runnerId}`,
    );
  }
  if (!failedJob.completedAt) {
    throw new Error(`${label}: the completed job has no completedAt`);
  }
  const secondsToFail =
    (Date.parse(failedJob.completedAt) - Date.parse(terminatedAt)) / 1000;
  if (!(secondsToFail >= 0) || secondsToFail > FAIL_WITHIN_SECONDS) {
    throw new Error(
      `${label}: GitHub marked the job failed ${secondsToFail.toFixed(1)} s after terminating ${runnerId}, not within ${FAIL_WITHIN_SECONDS} s`,
    );
  }

  // Already retried (gh-workflows.ts's `diagnoseWithRetry`):
  // called once here, not polled, so a cleanup check never re-dispatches
  // ci-install.yml on its own.
  const diagnosis = await deps.diagnoseRunner(runnerId);
  if (!diagnosis.cleanedAt) {
    throw new Error(
      `${label}: ${runnerId} wasn't cleaned up after ci-install's diagnose ran out of retries`,
    );
  }
  if (diagnosis.cleanupError) {
    throw new Error(
      `${label}: ${runnerId} cleaned up with an error: ${diagnosis.cleanupError}`,
    );
  }

  return {
    runnerId,
    terminatedAt,
    failedAt: failedJob.completedAt,
    secondsToFail,
  };
}
