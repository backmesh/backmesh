// POST /v1/rerun { owner, repo, run_id, install }, with the install key as
// the bearer: the listener's spot-reclaim retry (owner, 2026-11-19). An
// install's own token can only read Actions, so the Worker reruns a run's
// failed jobs for it, and only when the key's org owns the repository, the
// run has finished at its first or second attempt, and every failed job of
// that attempt ran on this install's runners (`bm<install>-…`, the runner
// tag the key is bound to on its first rerun). The rerun's token has
// Actions write for that one call and is dropped.
import { gitHub, GitHubError, mintToken } from './app.js';
import { notInstalled } from './broker.js';
import type { Env } from './index.js';

const HOUR = 3_600_000;
const RERUNS_PER_HOUR = 20;
// GitHub's "re-run failed jobs" reruns these.
const FAILED = new Set(['failure', 'cancelled', 'timed_out']);
// Attempt 3 is the retry's last (`src/listener/retry.ts`).
const ATTEMPT_CAP = 3;
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

const json = (body: unknown, status = 200) => Response.json(body, { status });

export async function rerun(
  request: Request,
  env: Env,
  install: { id: string; org: number },
) {
  const body = (await request.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const { owner, repo, run_id, install: tag } = body;
  if (
    typeof owner !== 'string' ||
    !NAME.test(owner) ||
    typeof repo !== 'string' ||
    !NAME.test(repo) ||
    typeof run_id !== 'number' ||
    !Number.isSafeInteger(run_id) ||
    run_id < 1 ||
    typeof tag !== 'string' ||
    !/^[a-z0-9]{5}$/.test(tag)
  ) {
    return json(
      {
        error: 'owner, repo, run_id and install (the runner tag) are required',
      },
      400,
    );
  }
  const run = `${owner}/${repo}/${run_id}`;
  const record = (outcome: string) =>
    env.DB.prepare(
      'INSERT INTO reruns (at, install, org, run, outcome, ip, ray) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(
        Date.now(),
        install.id,
        install.org,
        run,
        outcome,
        request.headers.get('CF-Connecting-IP'),
        request.headers.get('CF-Ray'),
      )
      .run();
  const refuse = async (outcome: string, status: number, error: string) => {
    await record(outcome);
    return json({ error }, status);
  };

  const recent = await env.DB.prepare(
    "SELECT count(*) AS n FROM reruns WHERE install = ? AND at > ? AND outcome = 'ok'",
  )
    .bind(install.id, Date.now() - HOUR)
    .first<{ n: number }>();
  if (recent!.n >= RERUNS_PER_HOUR) {
    return refuse('rate_limited', 429, 'Too many reruns; retry later.');
  }
  const bound = await env.DB.prepare('SELECT tag FROM installs WHERE id = ?')
    .bind(install.id)
    .first<{ tag: string | null }>();
  if (bound?.tag && bound.tag !== tag) {
    return refuse('bad_tag', 403, "That isn't this install's runner tag.");
  }

  const reader = await mintToken(env, install.org, {
    actions: 'read',
    metadata: 'read',
  });
  if (!reader) {
    await record('app_not_installed');
    return notInstalled(env, install.org);
  }
  const as = (token: string, path: string, init: RequestInit = {}) =>
    gitHub(path, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'backmesh',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  const read = async <T>(path: string) => {
    const res = await as(reader.answer.token, path);
    if (res.status === 403 || res.status === 404) return null;
    if (!res.ok) throw new GitHubError(`GitHub ${path}: ${res.status}`);
    return (await res.json()) as T;
  };
  const repoPath = `/repos/${owner}/${repo}`;
  const found = await read<{ owner: { id: number } }>(repoPath);
  if (found?.owner.id !== install.org) {
    return refuse(
      'not_org_repo',
      403,
      "That repository isn't one of this install's org's that backmesh's App is on.",
    );
  }
  const state = await read<{ status: string; run_attempt: number }>(
    `${repoPath}/actions/runs/${run_id}`,
  );
  if (!state) return refuse('no_run', 404, 'No such run.');
  if (state.status !== 'completed') {
    return refuse('not_completed', 409, "The run hasn't finished.");
  }
  if (state.run_attempt >= ATTEMPT_CAP) {
    return refuse('attempt_cap', 409, `The run is at attempt ${ATTEMPT_CAP}.`);
  }
  const jobs: { conclusion: string | null; runner_name: string | null }[] = [];
  for (let page = 1; ; page++) {
    const listed = await read<{ total_count: number; jobs: typeof jobs }>(
      `${repoPath}/actions/runs/${run_id}/attempts/${state.run_attempt}/jobs?per_page=100&page=${page}`,
    );
    if (!listed) return refuse('no_run', 404, 'No such run.');
    jobs.push(...listed.jobs);
    if (!listed.jobs.length || jobs.length >= listed.total_count) break;
  }
  const failed = jobs.filter((job) => FAILED.has(job.conclusion ?? ''));
  if (!failed.length) return refuse('no_failed_job', 409, 'No job failed.');
  const ours = new RegExp(`^bm${tag}-[0-9a-z]{2}-[0-9a-z]{8}$`);
  if (!failed.every((job) => ours.test(job.runner_name ?? ''))) {
    return refuse(
      'not_our_runners',
      403,
      "The run's failed jobs didn't all run on this install's runners.",
    );
  }

  await env.DB.prepare(
    'UPDATE installs SET tag = ? WHERE id = ? AND tag IS NULL',
  )
    .bind(tag, install.id)
    .run();
  const writer = await mintToken(env, install.org, {
    actions: 'write',
    metadata: 'read',
  });
  if (!writer) {
    await record('app_not_installed');
    return notInstalled(env, install.org);
  }
  const res = await as(
    writer.answer.token,
    `${repoPath}/actions/runs/${run_id}/rerun-failed-jobs`,
    { method: 'POST' },
  );
  if (!res.ok) {
    await record('github_failed');
    throw new GitHubError(`GitHub refused the rerun: ${res.status}`);
  }
  await record('ok');
  return json({ rerun: true });
}
