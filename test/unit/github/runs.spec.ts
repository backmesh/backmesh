import { describe, expect, it } from 'vitest';

import {
  gateGitHub,
  recentRuns,
  runBranch,
  runJobs,
  workflowFiles,
  workflowRuns,
} from '../../../src/github/runs.js';
import { retryingFetch } from '../../../src/github/retry.js';
import { fakeGitHub, json, octokitFor } from './fake-github.js';

const RUNS = 'https://api.github.com/repos/acme/app/actions/runs/7';
const RUN = { owner: 'acme', repo: 'app', runId: 7 };

describe('workflowRuns', () => {
  it("reads a run's state and an attempt's jobs", async () => {
    const { fetch, calls } = fakeGitHub({
      [`GET ${RUNS}`]: json(200, {
        id: 7,
        status: 'completed',
        conclusion: 'failure',
        run_attempt: 2,
      }),
      [`GET ${RUNS}/attempts/2/jobs`]: json(200, {
        total_count: 1,
        jobs: [
          {
            name: 'test (18)',
            conclusion: 'failure',
            runner_name: 'bmabc12-a4-00000001',
            labels: ['backmesh-ubuntu-2404-4vcpu', 'backmesh-noretry'],
          },
        ],
      }),
      [`POST ${RUNS}/rerun-failed-jobs`]: json(201, {}),
    });
    const runs = workflowRuns(octokitFor(fetch));

    expect(await runs.get(RUN)).toEqual({
      status: 'completed',
      conclusion: 'failure',
      attempt: 2,
    });
    expect(await runs.jobs(RUN, 2)).toEqual([
      {
        name: 'test (18)',
        conclusion: 'failure',
        runnerName: 'bmabc12-a4-00000001',
        labels: ['backmesh-ubuntu-2404-4vcpu', 'backmesh-noretry'],
      },
    ]);
    // Reads only: the rerun is the Worker's (`/v1/rerun`).
    expect(calls.every((c) => (c.method ?? 'GET') === 'GET')).toBe(true);
  });
});

describe('recentRuns', () => {
  const REPO = 'https://api.github.com/repos/acme/app/actions';
  const page = (jobs: number[]) =>
    json(200, {
      total_count: 3,
      jobs: jobs.map((i) => ({
        name: `test (${i})`,
        labels: ['backmesh-ubuntu-2404-4vcpu'],
        conclusion: i === 2 ? null : 'success',
        created_at: '2026-11-07T10:00:00Z',
        started_at: i === 2 ? null : '2026-11-07T10:01:00Z',
        completed_at: i === 2 ? null : '2026-11-07T10:02:00Z',
      })),
    });

  it("reads a workflow's completed runs and their first attempts' jobs, page by page, within the budget", async () => {
    const { fetch, calls } = fakeGitHub({
      [`GET ${REPO}/workflows/ci.yml/runs`]: json(200, {
        total_count: 2,
        // Run 8's head is this repo's own branch.
        workflow_runs: [
          {
            id: 8,
            head_branch: 'main',
            head_repository: { full_name: 'Acme/App' },
          },
          {
            id: 9,
            head_branch: 'feature',
            head_repository: { full_name: 'mallory/app' },
          },
        ],
      }),
      [`GET ${REPO}/runs/8/attempts/1/jobs`]: [page([0, 1]), page([2])],
      [`GET ${REPO}/runs/9/attempts/1/jobs`]: page([0]),
    });
    const ref = {
      owner: 'acme',
      repo: 'app',
      workflow: 'ci.yml',
      event: 'push',
    };
    let budget = 3;
    const runs = await recentRuns(octokitFor(fetch))(
      ref,
      20,
      () => budget-- > 0,
    );

    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({
      event: 'push',
      status: 'completed',
      exclude_pull_requests: 'true',
      per_page: '20',
    });
    expect(calls[2]!.url.searchParams.get('page')).toBe('2');
    // The budget ran out before run 9's jobs: it's left out.
    expect(calls).toHaveLength(3);
    expect(runs).toEqual([
      {
        id: 8,
        branch: 'main',
        jobs: [0, 1, 2].map((i) => ({
          name: `test (${i})`,
          labels: ['backmesh-ubuntu-2404-4vcpu'],
          conclusion: i === 2 ? null : 'success',
          queuedAt: Date.parse('2026-11-07T10:00:00Z'),
          startedAt: i === 2 ? null : Date.parse('2026-11-07T10:01:00Z'),
          finishedAt: i === 2 ? null : Date.parse('2026-11-07T10:02:00Z'),
        })),
      },
    ]);
  });
});

describe('recentRuns, asked whether a workflow uses the labels', () => {
  it("stops at the newest run when its jobs don't", async () => {
    const REPO = 'https://api.github.com/repos/acme/app/actions';
    const { fetch, calls } = fakeGitHub({
      [`GET ${REPO}/workflows/ci.yml/runs`]: json(200, {
        total_count: 2,
        workflow_runs: [{ id: 8 }, { id: 9 }],
      }),
      [`GET ${REPO}/runs/8/attempts/1/jobs`]: json(200, {
        total_count: 1,
        jobs: [
          {
            name: 'deploy',
            labels: ['ubuntu-latest'],
            conclusion: 'success',
            created_at: '2026-11-07T10:00:00Z',
            started_at: null,
            completed_at: null,
          },
        ],
      }),
    });
    const ref = {
      owner: 'acme',
      repo: 'app',
      workflow: 'ci.yml',
      event: 'push',
    };
    const runs = await recentRuns(octokitFor(fetch))(
      ref,
      20,
      () => true,
      (jobs) =>
        jobs.some((job) => job.labels.includes('backmesh-ubuntu-2404-4vcpu')),
    );
    expect(runs).toEqual([]);
    expect(calls).toHaveLength(2);
  });
});

describe('runBranch', () => {
  it("reads a run's head branch, and none for a fork's PR", async () => {
    const run = (full: string | null) =>
      json(200, {
        id: 7,
        head_branch: 'feature',
        head_repository: full === null ? null : { full_name: full },
      });
    const { fetch, calls } = fakeGitHub({
      [`GET ${RUNS}`]: [run('Acme/App'), run('mallory/app'), run(null)],
    });
    const branch = runBranch(octokitFor(fetch));
    expect(await branch('acme', 'app', 7)).toBe('feature');
    expect(calls[0]!.url.pathname).toBe('/repos/acme/app/actions/runs/7');
    expect(await branch('acme', 'app', 7)).toBeUndefined();
    expect(await branch('acme', 'app', 7)).toBeUndefined();
  });
});

describe('workflowFiles', () => {
  it("lists a repo's active workflow files, with its name as GitHub spells it", async () => {
    const workflow = (id: number, path: string, state = 'active') => ({
      id,
      path,
      state,
      url: `https://api.github.com/repos/Acme/App/actions/workflows/${id}`,
    });
    const { fetch, calls } = fakeGitHub({
      ['GET https://api.github.com/repos/acme/app/actions/workflows']: json(
        200,
        {
          total_count: 4,
          workflows: [
            workflow(1, '.github/workflows/ci.yml'),
            workflow(2, '.github/workflows/old.yml', 'disabled_manually'),
            // GitHub's own, such as Dependabot's, have no file.
            workflow(3, 'dynamic/dependabot/dependabot-updates'),
            workflow(4, '.github/workflows/release.yaml'),
          ],
        },
      ),
    });
    expect(await workflowFiles(octokitFor(fetch))('acme', 'app')).toEqual({
      owner: 'Acme',
      repo: 'App',
      files: ['ci.yml', 'release.yaml'],
    });
    expect(calls).toHaveLength(1);
  });
});

describe('gateGitHub', () => {
  const REPO_RUNS = 'https://api.github.com/repos/acme/app/actions/runs';
  const run = (
    id: number,
    event: string,
    head: { full_name: string } | null,
    isPrivate = false,
  ) => ({
    id,
    event,
    repository: { full_name: 'acme/app', private: isPrivate },
    head_repository: head,
  });

  it("calls a run a fork's when its head is another repository or gone, whatever the case", async () => {
    const { fetch } = fakeGitHub({
      [`GET ${RUNS}`]: [
        json(200, run(7, 'pull_request', { full_name: 'ACME/App' })),
        json(200, run(7, 'pull_request', { full_name: 'someone/app' })),
        json(200, run(7, 'pull_request', null)),
        json(200, run(7, 'pull_request', { full_name: 'someone/app' }, true)),
      ],
    });
    const github = gateGitHub(octokitFor(fetch));
    expect(await github.run(RUN)).toEqual({ private: false, fork: false });
    expect(await github.run(RUN)).toEqual({ private: false, fork: true });
    expect(await github.run(RUN)).toEqual({ private: false, fork: true });
    expect(await github.run(RUN)).toEqual({ private: true, fork: true });
  });

  it("lists a repo's queued and in-progress runs of the given events", async () => {
    const page = (...runs: ReturnType<typeof run>[]) =>
      json(200, { total_count: runs.length, workflow_runs: runs });
    const { fetch, calls } = fakeGitHub({
      [`GET ${REPO_RUNS}`]: [
        page(run(7, 'pull_request', { full_name: 'someone/app' })),
        page(
          run(8, 'push', { full_name: 'acme/app' }),
          run(9, 'pull_request_review', { full_name: 'acme/app' }),
        ),
      ],
    });
    const github = gateGitHub(octokitFor(fetch));
    expect(
      await github.activeRuns('acme', 'app', [
        'pull_request',
        'pull_request_review',
      ]),
    ).toEqual([
      { runId: 7, fork: true },
      { runId: 9, fork: false },
    ]);
    expect(calls.map((c) => c.url.searchParams.get('status'))).toEqual([
      'queued',
      'in_progress',
    ]);
  });
});

describe('runJobs', () => {
  const job = (name: string, runner = '') => ({
    name,
    labels: ['backmesh-4'],
    runner_name: runner,
    status: runner ? 'in_progress' : 'queued',
    started_at: runner ? '2026-11-22T15:49:15Z' : null,
    run_attempt: 2,
    head_sha: 'abc',
  });
  const limit = {
    'x-ratelimit-remaining': '4000',
    'x-ratelimit-limit': '5000',
    'x-ratelimit-reset': '1800000000',
  };
  const rate = { remaining: 4000, limit: 5000, reset: 1_800_000_000_000 };

  it("reads a run's jobs on its last ETag, with the rate limit, and a run past one page with none", async () => {
    const { fetch, calls } = fakeGitHub({
      [`GET ${RUNS}/jobs`]: [
        json(
          200,
          { total_count: 1, jobs: [job('a')] },
          { etag: '"e1"', ...limit },
        ),
        () => new Response(null, { status: 304, headers: limit }),
        json(
          200,
          { total_count: 101, jobs: [job('a', 'bmabc12-a4-00000001')] },
          { etag: '"e2"' },
        ),
      ],
    });
    const read = runJobs(octokitFor(fetch), fetch);

    expect(await read(RUN)).toEqual({
      etag: '"e1"',
      jobs: [
        {
          name: 'a',
          labels: ['backmesh-4'],
          runnerName: '',
          startedAt: null,
          done: false,
          attempt: '2:abc',
        },
      ],
      rate,
    });
    expect(calls[0]!.headers.get('if-none-match')).toBeNull();
    expect(await read(RUN, '"e1"')).toEqual({
      etag: '"e1"',
      jobs: undefined,
      rate,
    });
    expect(calls[1]!.headers.get('if-none-match')).toBe('"e1"');
    // The first page's ETag can't say the second didn't change.
    const paged = await read(RUN, '"e1"');
    expect(paged.etag).toBeUndefined();
    expect(paged.jobs!.map((j) => [j.name, j.startedAt])).toEqual([
      ['a', Date.parse('2026-11-22T15:49:15Z')],
    ]);
    expect(calls).toHaveLength(3);
  });

  it("gives a 429 to the caller at once, past the octokit's retrying fetch", async () => {
    const { fetch, calls } = fakeGitHub({
      [`GET ${RUNS}/jobs`]: json(429, {}, { 'retry-after': '30' }),
    });
    const octokit = octokitFor(retryingFetch(fetch, { sleep: async () => {} }));
    await expect(runJobs(octokit, fetch)(RUN)).rejects.toMatchObject({
      status: 429,
      response: { headers: { 'retry-after': '30' } },
    });
    expect(calls).toHaveLength(1);
  });
});
