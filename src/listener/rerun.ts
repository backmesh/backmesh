// The spot-reclaim retry's rerun, through the Worker's /v1/rerun (owner,
// 2026-11-19): the install's own GitHub token can only read Actions. The
// Worker reruns the run's failed jobs when they all ran on this install's
// runners, named with its tag. A refusal throws with its status, as
// GitHub's would, so the retry drops it.
import type { WorkflowRun } from '../github/checks.js';

export function workerRerun({
  url,
  key,
  install,
  fetch,
}: {
  url: string;
  key: string;
  install: string;
  fetch: typeof globalThis.fetch;
}) {
  return async ({ owner, repo, runId }: WorkflowRun): Promise<void> => {
    const res = await fetch(`${url}/v1/rerun`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ owner, repo, run_id: runId, install }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) return;
    const { error } = (await res.json().catch(() => ({}))) as {
      error?: string;
    };
    throw Object.assign(
      new Error(error ?? `backmesh.com answered ${res.status}`),
      {
        status: res.status,
      },
    );
  };
}
