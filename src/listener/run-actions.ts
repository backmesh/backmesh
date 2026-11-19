// The listener's run actions through the Worker (owner, 2026-11-19): the
// install's own GitHub token can only read Actions. /v1/rerun reruns a
// run's failed jobs when they all ran on this install's runners, named with
// its tag; /v1/cancel force-cancels a fork's run the gate stops. A refusal
// throws with its status, as GitHub's would, so the caller drops it, and the
// Worker's `code` for which refusal it is.
import type { WorkflowRun } from '../github/checks.js';

interface WorkerRuns {
  url: string;
  key: string;
  install: string;
  fetch: typeof globalThis.fetch;
}

async function post(
  { url, key, fetch }: WorkerRuns,
  path: string,
  body: object,
): Promise<void> {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.ok) return;
  const { error, code } = (await res.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
  };
  throw Object.assign(
    new Error(error ?? `backmesh.com answered ${res.status}`),
    { status: res.status, code },
  );
}

export const workerRerun =
  (worker: WorkerRuns) =>
  ({ owner, repo, runId }: WorkflowRun) =>
    post(worker, '/v1/rerun', {
      owner,
      repo,
      run_id: runId,
      install: worker.install,
    });

export const workerCancel =
  (worker: WorkerRuns) =>
  ({ owner, repo, runId }: WorkflowRun, reason: 'label' | 'limit') =>
    post(worker, '/v1/cancel', {
      owner,
      repo,
      run_id: runId,
      install: worker.install,
      reason,
    });
