import type { Octokit } from '@octokit/rest';

import type { WorkflowRun } from './checks.js';

// The REST calls the retry makes, behind an interface tests
// replace. Reading needs Actions: read; the rerun goes through the Worker
// (`src/listener/rerun.ts`), which holds the App's Actions write.
export interface RunState {
  status: string | null;
  conclusion: string | null;
  attempt: number;
}

export interface AttemptJob {
  name: string;
  conclusion: string | null;
  runnerName: string | null;
  labels: string[];
}

export interface WorkflowRuns {
  get(run: WorkflowRun): Promise<RunState>;
  jobs(run: WorkflowRun, attempt: number): Promise<AttemptJob[]>;
  rerunFailedJobs(run: WorkflowRun): Promise<void>;
}

export function workflowRuns(
  octokit: Octokit,
): Omit<WorkflowRuns, 'rerunFailedJobs'> {
  return {
    async get({ owner, repo, runId }) {
      const { data } = await octokit.rest.actions.getWorkflowRun({
        owner,
        repo,
        run_id: runId,
      });
      return {
        status: data.status ?? null,
        conclusion: data.conclusion ?? null,
        attempt: data.run_attempt ?? 1,
      };
    },
    async jobs({ owner, repo, runId }, attempt) {
      const jobs = await octokit.paginate(
        octokit.rest.actions.listJobsForWorkflowRunAttempt,
        { owner, repo, run_id: runId, attempt_number: attempt, per_page: 100 },
      );
      return jobs.map((job) => ({
        name: job.name,
        conclusion: job.conclusion ?? null,
        runnerName: job.runner_name ?? null,
        labels: job.labels,
      }));
    },
  };
}

// The planner's backfill (W2): a workflow's latest completed runs and their
// first attempts' jobs, with Actions: read. Each request waits for `take`,
// the planner's hourly budget; a run whose jobs it cut short is left out.
export interface WorkflowRef {
  owner: string;
  repo: string;
  // The file name, such as `ci.yml`.
  workflow: string;
  event: string;
}

export interface PastJob {
  name: string;
  labels: string[];
  conclusion: string | null;
  queuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

// `uses`, when given, is asked about the newest run's jobs: false ends the
// read there, with nothing, as for a workflow whose jobs run elsewhere.
export type RecentRuns = (
  ref: WorkflowRef,
  count: number,
  take: () => boolean,
  uses?: (jobs: PastJob[]) => boolean,
) => Promise<{ id: number; branch?: string; jobs: PastJob[] }[]>;

const ms = (at: string | null | undefined) => (at ? Date.parse(at) : null);

export function recentRuns(octokit: Octokit): RecentRuns {
  return async ({ owner, repo, workflow, event }, count, take, uses) => {
    if (!take()) return [];
    const { data } = await octokit.rest.actions.listWorkflowRuns({
      owner,
      repo,
      workflow_id: workflow,
      event,
      status: 'completed',
      exclude_pull_requests: true,
      per_page: count,
    });
    const runs = [];
    for (const run of data.workflow_runs) {
      const jobs: PastJob[] = [];
      for (let page = 1; ; page++) {
        if (!take()) return runs;
        const { data } =
          await octokit.rest.actions.listJobsForWorkflowRunAttempt({
            owner,
            repo,
            run_id: run.id,
            attempt_number: 1,
            per_page: 100,
            page,
          });
        jobs.push(
          ...data.jobs.map((job) => ({
            name: job.name,
            labels: job.labels,
            conclusion: job.conclusion ?? null,
            queuedAt: Date.parse(job.created_at),
            startedAt: ms(job.started_at),
            finishedAt: ms(job.completed_at),
          })),
        );
        if (!data.jobs.length || jobs.length >= data.total_count) break;
      }
      // A fork's head branch isn't this repo's.
      const own =
        run.head_repository?.full_name?.toLowerCase() ===
        `${owner}/${repo}`.toLowerCase();
      if (uses && !runs.length && !uses(jobs)) return [];
      runs.push({
        id: run.id,
        ...(own && run.head_branch && { branch: run.head_branch }),
        jobs,
      });
    }
    return runs;
  };
}

// A repository's active workflow files, such as `ci.yml`, for a cue's repo
// the planner has learned nothing of, with Actions: read. The
// owner and repo come back as GitHub spells them, which the job messages'
// workflow refs use.
export type RecentWorkflows = (
  owner: string,
  repo: string,
) => Promise<{ owner: string; repo: string; files: string[] }>;

export function workflowFiles(octokit: Octokit): RecentWorkflows {
  return async (owner, repo) => {
    const { data } = await octokit.rest.actions.listRepoWorkflows({
      owner,
      repo,
      per_page: 100,
    });
    const files = data.workflows.flatMap((w) => {
      const file = /^\.github\/workflows\/([^/]+)$/.exec(w.path)?.[1];
      return file && w.state === 'active' ? [file] : [];
    });
    // `…/repos/<owner>/<repo>/actions/workflows/<id>`.
    const named = /\/repos\/([^/]+)\/([^/]+)\/actions\//.exec(
      data.workflows[0]?.url ?? '',
    );
    return {
      owner: named?.[1] ?? owner,
      repo: named?.[2] ?? repo,
      files,
    };
  };
}

// A workflow run's head branch, for the planner's cues, or
// undefined when the head is another repository's, as a fork's PR is. The
// run, not its PR, since the App's Actions permission covers runs and it
// has no Pull requests permission.
export function runBranch(octokit: Octokit) {
  return async (owner: string, repo: string, runId: number) => {
    const { data } = await octokit.rest.actions.getWorkflowRun({
      owner,
      repo,
      run_id: runId,
    });
    const head = data.head_repository?.full_name?.toLowerCase();
    return head === `${owner}/${repo}`.toLowerCase()
      ? (data.head_branch ?? undefined)
      : undefined;
  };
}

// The run, as the own ref's checks read it, and its repository's
// default branch.
export interface RunFacts {
  repoId: number;
  // The workflow file's path, such as `.github/workflows/ci.yml`.
  path: string;
  headBranch: string | null;
  // `owner/name`.
  headRepository: string | null;
  pullRequests: { number: number; baseRef: string }[];
  defaultBranch: string;
}
export function cacheRun(octokit: Octokit) {
  return async (
    owner: string,
    repo: string,
    runId: number,
  ): Promise<RunFacts> => {
    const { data } = await octokit.rest.actions.getWorkflowRun({
      owner,
      repo,
      run_id: runId,
    });
    return {
      repoId: data.repository.id,
      path: data.path,
      headBranch: data.head_branch ?? null,
      headRepository: data.head_repository?.full_name ?? null,
      pullRequests: (data.pull_requests ?? []).map((pr) => ({
        number: pr.number,
        baseRef: pr.base.ref,
      })),
      defaultBranch:
        data.repository.default_branch ??
        (await octokit.rest.repos.get({ owner, repo })).data.default_branch,
    };
  };
}

// The public-repository gate's reads, with Actions: read. A run is a fork's
// when its head repository isn't its repository, or is gone.
export interface GateRun {
  private: boolean;
  fork: boolean;
}
export interface GateJob {
  name: string;
  labels: string[];
  runnerName: string | null;
  // Epoch ms; null before it starts.
  startedAt: number | null;
  done: boolean;
}
export interface GateGitHub {
  run(run: WorkflowRun): Promise<GateRun>;
  // The installation's repositories.
  repos(): Promise<{ owner: string; repo: string; private: boolean }[]>;
  // The repository's queued and in-progress pull-request runs.
  activeRuns(
    owner: string,
    repo: string,
    events: readonly string[],
  ): Promise<{ runId: number; fork: boolean }[]>;
  jobs(run: WorkflowRun): Promise<GateJob[]>;
}

const isFork = (
  repo: { full_name: string },
  head: { full_name?: string } | null | undefined,
) => head?.full_name?.toLowerCase() !== repo.full_name.toLowerCase();

export function gateGitHub(octokit: Octokit): GateGitHub {
  return {
    async run({ owner, repo, runId }) {
      const { data } = await octokit.rest.actions.getWorkflowRun({
        owner,
        repo,
        run_id: runId,
      });
      return {
        private: data.repository.private,
        fork: isFork(data.repository, data.head_repository),
      };
    },
    async repos() {
      const repos = await octokit.paginate(
        octokit.rest.apps.listReposAccessibleToInstallation,
        { per_page: 100 },
      );
      return repos.map((r) => ({
        owner: r.owner.login,
        repo: r.name,
        private: r.private,
      }));
    },
    async activeRuns(owner, repo, events) {
      const runs = [];
      for (const status of ['queued', 'in_progress'] as const) {
        runs.push(
          ...(await octokit.paginate(
            octokit.rest.actions.listWorkflowRunsForRepo,
            { owner, repo, status, per_page: 100 },
          )),
        );
      }
      return runs
        .filter((r) => events.includes(r.event))
        .map((r) => ({
          runId: r.id,
          fork: isFork(r.repository, r.head_repository),
        }));
    },
    async jobs({ owner, repo, runId }) {
      const jobs = await octokit.paginate(
        octokit.rest.actions.listJobsForWorkflowRun,
        { owner, repo, run_id: runId, per_page: 100 },
      );
      return jobs.map((job) => ({
        name: job.name,
        labels: job.labels,
        runnerName: job.runner_name ?? null,
        startedAt: job.started_at ? Date.parse(job.started_at) : null,
        done: job.status === 'completed',
      }));
    },
  };
}
