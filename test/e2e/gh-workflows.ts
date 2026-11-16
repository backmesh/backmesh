// Pure helpers for driving lost-runner-check.yml and ci-install.yml from the
// stop member (stop-member.ts): finding the run a dispatch created, since
// GitHub's dispatch API returns nothing, and reading ci-install's
// stop-runner and diagnose output back out of a job's log text. The real
// `gh`/`anycloud` calls live in run-stop-member.ts, which isn't unit tested;
// this module is, with fixed log text and fake listings.
import type { RunnerJobDiagnosis } from './stop-member.ts';

export interface WorkflowRun {
  id: number;
  createdAt: string; // ISO 8601
  /** The run's name as GitHub shows it (its `run-name`, when the workflow
   * sets one); used to tell apart runs created at nearly the same time. */
  displayTitle?: string;
}

export type ListRuns = (workflow: string) => Promise<WorkflowRun[]>;
export type DispatchWorkflow = (
  workflow: string,
  inputs: Record<string, string>,
) => Promise<void>;

export interface DispatchAndFindOptions {
  timeoutMs?: number;
  /**
   * Picks the dispatch's own run out of several new ones: needed whenever
   * more than one dispatch of the same workflow can be in flight at once
   * (e2e.yml's `stop` jobs, one per label, each dispatch
   * lost-runner-check.yml around the same time). Without it, the newest new
   * run is assumed to be this dispatch's, which only holds when nothing
   * else dispatches the same workflow concurrently.
   */
  match?: (run: WorkflowRun) => boolean;
}

/**
 * Dispatches `workflow` and resolves with the run id it created, polling
 * until one appears. `workflow_dispatch`'s API gives no run id back, so this
 * is the only way to recover it (ci-install.yml's own `stop-runner` mode
 * instead searches by the runner's name, which doesn't exist until a runner
 * has registered).
 */
export async function dispatchAndFind(
  dispatch: DispatchWorkflow,
  listRuns: ListRuns,
  sleep: (ms: number) => Promise<void>,
  workflow: string,
  inputs: Record<string, string>,
  { timeoutMs = 60_000, match }: DispatchAndFindOptions = {},
): Promise<number> {
  const before = new Set((await listRuns(workflow)).map((r) => r.id));
  await dispatch(workflow, inputs);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const created = (await listRuns(workflow)).filter(
      (r) => !before.has(r.id) && (!match || match(r)),
    );
    if (created.length > 0) {
      return created.reduce((a, b) => (a.createdAt > b.createdAt ? a : b)).id;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${workflow}: no new ${match ? 'matching ' : ''}run appeared within ${timeoutMs} ms of dispatching it`,
      );
    }
    await sleep(2000);
  }
}

/**
 * The `gh api` arguments for listing ci-install.yml's own runs (used by
 * `ciInstallBusy`, in run-stop-member.ts): an explicit `-X GET`, since `gh
 * api` switches to POST the moment any `-f`/`-F` field is given, which this
 * read-only listing must never do; `per_page` goes in the URL's query
 * string instead, for the same reason.
 */
export function ciInstallRunsArgs(repo: string): string[] {
  return [
    'api',
    '-X',
    'GET',
    `repos/${repo}/actions/workflows/ci-install.yml/runs?per_page=20`,
  ];
}

/** True if any of `runs` hasn't finished yet (`queued`, `in_progress`, or
 * `waiting` on an environment's protection rules) — the check before
 * dispatching into ci-install.yml's singleton `ci-install` concurrency
 * group, so an e2e check never piles onto, races or cancels another run
 * there (the owner's own pending install/upgrade included). */
export function anyRunActive(runs: { status: string }[]): boolean {
  return runs.some((r) => r.status !== 'completed');
}

/**
 * ci-install.yml's `diagnose` mode, dispatched carefully: it waits before
 * asking, since anycloud's cleanup isn't instant, and retries at most once
 * if the runner Job isn't cleaned up yet, rather than polling by
 * re-dispatching every few seconds, which would spam ci-install.yml (and
 * its shared `ci-install` concurrency group) for the whole cleanup wait.
 */
export async function diagnoseWithRetry(
  attempt: () => Promise<RunnerJobDiagnosis>,
  sleep: (ms: number) => Promise<void>,
  waitMs = 45_000,
): Promise<RunnerJobDiagnosis> {
  let diagnosis: RunnerJobDiagnosis = { cleanedAt: null, cleanupError: null };
  for (let attempts = 0; attempts < 2; attempts++) {
    await sleep(waitMs);
    diagnosis = await attempt();
    if (diagnosis.cleanedAt) return diagnosis;
  }
  return diagnosis;
}

// GitHub's job-log download (`gh api .../actions/jobs/{id}/logs`) prefixes
// every line with its own timestamp ("2026-11-10T04:04:10.9382778Z ..."),
// unlike the live run view, and renders `::group::`/`::endgroup::` as
// `##[group]`/`##[endgroup]` (observed on run 42753394421). Both parsers
// below strip that prefix first, so they work on the log as GitHub actually
// serves it, not just as the Actions UI shows it.
const LOG_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z /gm;

/**
 * The `gh api` arguments for downloading one job's raw log text (`jobLog`,
 * in run-stop-member.ts). Actions job logs always carry terminal escape
 * sequences (color codes, `##[group]`); recent `gh` refuses to print a
 * response that contains them unless asked to, which turned a ci-install
 * refusal into an opaque `Command failed: gh api ...` crash instead of
 * letting the log's own `##[error]` line surface (run 42775988257).
 */
export function jobLogsArgs(repo: string, jobId: number): string[] {
  return [
    'api',
    `repos/${repo}/actions/jobs/${jobId}/logs`,
    '--allow-escape-sequences',
  ];
}

// A raw job log renders `::error::...` as `##[error]...`; the generic
// "Process completed with exit code N." line that always follows a failed
// step is never the useful one, so it's skipped in favor of whatever
// `fail()` (or GitHub itself) printed first.
const ERROR_LINE = /^##\[error\](.*)$/gm;
const GENERIC_ERROR_LINE = /^Process completed with exit code \d+\.$/;

function findErrorLine(log: string): string | null {
  for (const match of log.matchAll(ERROR_LINE)) {
    const message = match[1]!.trim();
    if (message && !GENERIC_ERROR_LINE.test(message)) return message;
  }
  return null;
}

/**
 * ci-install.yml's `stop-runner` step prints `Terminating <id> at <ISO>`
 * before it asks anycloud to terminate; extracts that timestamp from the
 * job's log text (`gh api .../actions/jobs/{id}/logs`). When the run instead
 * failed before ever printing that line (ci-install.yml refusing the
 * request, say), the thrown error carries the run's own `##[error]` line
 * instead of just reporting the expected line as missing.
 */
export function parseTerminatedAt(log: string, runnerId: string): string {
  const stripped = log.replace(LOG_TIMESTAMP, '');
  const match = new RegExp(`Terminating ${runnerId} at (\\S+)`).exec(stripped);
  if (!match) {
    const errorLine = findErrorLine(stripped);
    throw new Error(
      errorLine
        ? `ci-install.yml failed before terminating ${runnerId}: ${errorLine}`
        : `no "Terminating ${runnerId} at ..." line in the log for ${runnerId}`,
    );
  }
  return match[1]!;
}

// The matching `}` for the `{` at `openIndex`, string-aware so a brace inside
// a quoted value (an error message, say) isn't counted.
function matchingBrace(text: string, openIndex: number): number {
  let depth = 0;
  let inString = false;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`no closing brace for the one at offset ${openIndex}`);
}

/**
 * ci-install.yml's `diagnose` step prints one pretty-printed JSON object per
 * named id (its `ids` input), with `cleanedAt` and `cleanupError` among
 * other fields; extracts and parses the object for `runnerId` from the
 * job's log text. When the run instead failed before ever printing that
 * object (ci-install.yml refusing the request, say), the thrown error
 * carries the run's own `##[error]` line instead of just reporting the
 * expected JSON as missing.
 */
export function parseDiagnosis(
  rawLog: string,
  runnerId: string,
): RunnerJobDiagnosis {
  const log = rawLog.replace(LOG_TIMESTAMP, '');
  const marker = `"id": "${runnerId}"`;
  const markerIndex = log.indexOf(marker);
  if (markerIndex < 0) {
    const errorLine = findErrorLine(log);
    throw new Error(
      errorLine
        ? `ci-install.yml failed before diagnosing ${runnerId}: ${errorLine}`
        : `no diagnose JSON for ${runnerId} in the log`,
    );
  }
  const openIndex = log.lastIndexOf('{', markerIndex);
  if (openIndex < 0) {
    throw new Error(`no opening brace before ${runnerId}'s diagnose JSON`);
  }
  const closeIndex = matchingBrace(log, openIndex);
  const parsed: unknown = JSON.parse(log.slice(openIndex, closeIndex + 1));
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${runnerId}'s diagnose JSON isn't an object`);
  }
  const { id, cleanedAt, cleanupError } = parsed as Record<string, unknown>;
  if (id !== runnerId) {
    throw new Error(
      `the diagnose JSON found names id ${String(id)}, not ${runnerId}`,
    );
  }
  return {
    cleanedAt: typeof cleanedAt === 'string' ? cleanedAt : null,
    cleanupError: typeof cleanupError === 'string' ? cleanupError : null,
  };
}
