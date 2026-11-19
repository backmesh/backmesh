// The listener's two run actions, which need Actions write its own token
// doesn't have (owner, 2026-11-19), with the install key as the bearer:
//   POST /v1/rerun  { owner, repo, run_id, install }          spot-reclaim retry
//   POST /v1/cancel { owner, repo, run_id, install, reason }  fork protection
// The Worker reads the run with a read-only token, checks it's one the key's
// install may act on, and acts with a token that has Actions write for that
// one call and is dropped. `install` is the install's runner tag, bound to
// the key on its first action: `bm<install>-…` runners are its own. Every
// call is a run_actions row, which also counts toward the hourly limit.
import { gitHub, GitHubError, installationOf, mintToken } from './app.js';
import { notInstalled } from './broker.js';
import type { Env } from './index.js';

const HOUR = 3_600_000;
const PER_HOUR = 20;
// The retry's rule (`src/listener/retry.ts`): a run whose failed or timed
// out jobs all ran on this install's runners, at most 3 attempts. A
// cancelled job, such as a matrix sibling fail-fast cancelled, can be
// anywhere.
const FAILED = new Set(['failure', 'timed_out']);
const ATTEMPT_CAP = 3;
// The gate's rules (`src/listener/gate.ts`): a fork's pull-request run, and
// the runtime limit, less 2 minutes for the listener's clock.
const PR_EVENTS = [
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
];
const LIMIT_MS = 58 * 60_000;
const NOT_ACCESSIBLE = 'Resource not accessible by integration';
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

const json = (body: unknown, status = 200) => Response.json(body, { status });

interface Job {
  conclusion: string | null;
  status?: string;
  runner_name: string | null;
  labels?: string[];
  started_at?: string | null;
}
interface Run {
  status: string;
  event?: string;
  run_attempt: number;
  repository?: { full_name: string };
  head_repository?: { full_name: string } | null;
}

interface Target {
  owner: string;
  repo: string;
  runId: number;
  tag: string;
  path: string;
  ours: RegExp;
  run: Run;
  repository: { owner: { id: number }; private: boolean };
  jobs: (attempt?: number) => Promise<Job[] | null>;
  refuse: (outcome: string, status: number, error: string) => Promise<Response>;
}

// Checks the request, counts it, reads the repository and run, and hands
// them to `decide`, which answers a refusal or the GitHub write to make.
async function runAction(
  request: Request,
  env: Env,
  install: { id: string; org: number },
  action: 'rerun' | 'cancel',
  extra: (body: Record<string, unknown>) => boolean,
  decide: (
    target: Target,
  ) => Promise<Response | { path: string; done: object }>,
) {
  const body = (await request.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const { owner, repo, run_id: runId, install: tag } = body;
  if (
    typeof owner !== 'string' ||
    !NAME.test(owner) ||
    typeof repo !== 'string' ||
    !NAME.test(repo) ||
    typeof runId !== 'number' ||
    !Number.isSafeInteger(runId) ||
    runId < 1 ||
    typeof tag !== 'string' ||
    !/^[a-z0-9]{5}$/.test(tag) ||
    !extra(body)
  ) {
    return json(
      {
        error: `owner, repo, run_id and install (the runner tag)${action === 'cancel' ? ' and reason (label or limit)' : ''} are required`,
      },
      400,
    );
  }
  const run = `${owner}/${repo}/${runId}`;
  // Recorded first, so calls at once can't pass the limit together.
  const row = await env.DB.prepare(
    `INSERT INTO run_actions (at, action, install, org, run, outcome, ip, ray)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?) RETURNING rowid AS id`,
  )
    .bind(
      Date.now(),
      action,
      install.id,
      install.org,
      run,
      request.headers.get('CF-Connecting-IP'),
      request.headers.get('CF-Ray'),
    )
    .first<{ id: number }>();
  const record = (outcome: string) =>
    env.DB.prepare('UPDATE run_actions SET outcome = ? WHERE rowid = ?')
      .bind(outcome, row!.id)
      .run();
  // `code` tells the listener which refusal it is.
  const refuse = async (
    outcome: string,
    status: number,
    error: string,
    more: object = {},
  ) => {
    await record(outcome);
    return json({ error, code: outcome, ...more }, status);
  };
  // A call GitHub fails isn't left pending.
  try {
    return await act(
      { env, install, action, owner, repo, runId, tag, record, refuse },
      decide,
    );
  } catch (error) {
    await record('github_failed');
    throw error;
  }
}

async function act(
  c: {
    env: Env;
    install: { id: string; org: number };
    action: 'rerun' | 'cancel';
    owner: string;
    repo: string;
    runId: number;
    tag: string;
    record: (outcome: string) => Promise<unknown>;
    refuse: (
      outcome: string,
      status: number,
      error: string,
      more?: object,
    ) => Promise<Response>;
  },
  decide: (
    target: Target,
  ) => Promise<Response | { path: string; done: object }>,
) {
  const { env, install, action, owner, repo, runId, tag, record, refuse } = c;
  // Actions made and under way count; refusals don't.
  const recent = await env.DB.prepare(
    `SELECT count(*) AS n FROM run_actions WHERE install = ? AND action = ?
     AND at > ? AND outcome IN ('ok', 'pending')`,
  )
    .bind(install.id, action, Date.now() - HOUR)
    .first<{ n: number }>();
  if (recent!.n > PER_HOUR) {
    return refuse('rate_limited', 429, `Too many ${action}s; retry later.`);
  }
  const bound = async () =>
    (
      await env.DB.prepare('SELECT tag FROM installs WHERE id = ?')
        .bind(install.id)
        .first<{ tag: string | null }>()
    )?.tag;
  const already = await bound();
  if (already && already !== tag) {
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
  // null: GitHub doesn't show it to the installation. A rate limit or any
  // other failure is GitHub's (502).
  const read = async <T>(path: string) => {
    const res = await as(reader.answer.token, path);
    if (res.ok) return (await res.json()) as T;
    const { message } = (await res.json().catch(() => ({}))) as {
      message?: string;
    };
    if (
      res.status === 404 ||
      (res.status === 403 && message === NOT_ACCESSIBLE)
    )
      return null;
    throw new GitHubError(
      `GitHub ${path.split('?')[0]}: ${res.status} ${message ?? ''}`,
    );
  };
  const repoPath = `/repos/${owner}/${repo}`;
  const repository = await read<Target['repository']>(repoPath);
  if (repository?.owner.id !== install.org) {
    return refuse(
      'not_org_repo',
      403,
      "That repository isn't one of this install's org's that backmesh's App is on.",
    );
  }
  const path = `${repoPath}/actions/runs/${runId}`;
  const state = await read<Run>(path);
  if (!state) return refuse('no_run', 404, 'No such run.');
  const jobs = async (attempt?: number) => {
    const listed: Job[] = [];
    const base = attempt ? `${path}/attempts/${attempt}/jobs` : `${path}/jobs`;
    for (let page = 1; ; page++) {
      const answer = await read<{ total_count: number; jobs: Job[] }>(
        `${base}?per_page=100&page=${page}`,
      );
      if (!answer) return null;
      listed.push(...answer.jobs);
      if (!answer.jobs.length || listed.length >= answer.total_count) break;
    }
    return listed;
  };
  const decided = await decide({
    owner,
    repo,
    runId,
    tag,
    path,
    ours: new RegExp(`^bm${tag}-[0-9a-z]{2}-[0-9a-z]{8}$`),
    run: state,
    repository,
    jobs,
    refuse,
  });
  if (decided instanceof Response) return decided;

  // Bound now, and read back: of two first calls with different tags, one
  // binds and the other is refused.
  await env.DB.prepare(
    'UPDATE installs SET tag = ? WHERE id = ? AND tag IS NULL',
  )
    .bind(tag, install.id)
    .run();
  if ((await bound()) !== tag) {
    return refuse('bad_tag', 403, "That isn't this install's runner tag.");
  }
  // The App's Actions write is an owner's to accept on each installation.
  const installation = await installationOf(env, install.org);
  if (installation?.permissions.actions !== 'write') {
    const accept = `https://github.com/organizations/${installation?.login ?? owner}/settings/installations/${installation?.id ?? ''}`;
    return refuse('actions_write_needed', 409, 'actions_write_needed', {
      accept_url: accept,
    });
  }
  const writer = await mintToken(env, install.org, {
    actions: 'write',
    metadata: 'read',
  });
  if (!writer) {
    await record('app_not_installed');
    return notInstalled(env, install.org);
  }
  const res = await as(writer.answer.token, decided.path, { method: 'POST' });
  if (res.ok) {
    await record('ok');
    return json(decided.done);
  }
  const { message } = (await res.json().catch(() => ({}))) as {
    message?: string;
  };
  const limited =
    res.status === 429 ||
    res.headers.get('x-ratelimit-remaining') === '0' ||
    res.headers.has('retry-after') ||
    /rate limit/i.test(message ?? '');
  // GitHub's own refusal won't change by asking again: its 4xx goes back.
  // A rate limit or a failure is GitHub's (502), tried again later.
  if (res.status < 500 && !limited) {
    return refuse(
      'github_refused',
      res.status,
      `GitHub refused the ${action}: ${message ?? res.status}`,
    );
  }
  throw new GitHubError(`GitHub failed the ${action}: ${res.status}`);
}

// The spot-reclaim retry: a finished run below attempt 3 whose failed or
// timed-out jobs all ran on this install's runners.
export const rerun = (
  request: Request,
  env: Env,
  install: { id: string; org: number },
) =>
  runAction(
    request,
    env,
    install,
    'rerun',
    () => true,
    async (t) => {
      if (t.run.status !== 'completed') {
        return t.refuse('not_completed', 409, "The run hasn't finished.");
      }
      if (t.run.run_attempt >= ATTEMPT_CAP) {
        return t.refuse(
          'attempt_cap',
          409,
          `The run is at attempt ${ATTEMPT_CAP}.`,
        );
      }
      const jobs = await t.jobs(t.run.run_attempt);
      if (!jobs) return t.refuse('no_run', 404, 'No such run.');
      const failed = jobs.filter((job) => FAILED.has(job.conclusion ?? ''));
      if (!failed.length)
        return t.refuse('no_failed_job', 409, 'No job failed.');
      if (!failed.every((job) => t.ours.test(job.runner_name ?? ''))) {
        return t.refuse(
          'not_our_runners',
          403,
          "The run's failed jobs didn't all run on this install's runners.",
        );
      }
      return { path: `${t.path}/rerun-failed-jobs`, done: { rerun: true } };
    },
  );

// The public-repository gate: a fork's pull-request run in one of the org's
// public repositories that's still going, and either asks for a backmesh
// label that isn't public (`label`) or has a job on this install's runner
// past the 60-minute limit (`limit`), less 2 minutes for the listener's
// clock.
export const cancel = (
  request: Request,
  env: Env,
  install: { id: string; org: number },
) => {
  let reason: unknown;
  return runAction(
    request,
    env,
    install,
    'cancel',
    (body) => {
      reason = body.reason;
      return reason === 'label' || reason === 'limit';
    },
    async (t) => {
      const fork =
        t.run.head_repository?.full_name.toLowerCase() !==
        t.run.repository?.full_name.toLowerCase();
      if (
        t.repository.private ||
        !fork ||
        !PR_EVENTS.includes(t.run.event ?? '')
      ) {
        return t.refuse(
          'not_fork_run',
          403,
          "That isn't a fork's run in a public repository.",
        );
      }
      if (t.run.status === 'completed') {
        return t.refuse('completed', 409, 'The run has finished.');
      }
      const jobs = await t.jobs();
      if (!jobs) return t.refuse('no_run', 404, 'No such run.');
      const live = jobs.filter((job) => job.status !== 'completed');
      const holds =
        reason === 'label'
          ? live.some((job) =>
              (job.labels ?? []).some(
                (l) =>
                  l.startsWith('backmesh-') &&
                  !l.startsWith('backmesh-public-'),
              ),
            )
          : live.some(
              (job) =>
                t.ours.test(job.runner_name ?? '') &&
                !!job.started_at &&
                Date.now() - Date.parse(job.started_at) >= LIMIT_MS,
            );
      if (!holds) {
        return t.refuse(
          'not_gated',
          403,
          reason === 'label'
            ? "None of the run's jobs asks for a backmesh label that isn't public."
            : "None of the run's jobs has run 60 minutes on this install's runners.",
        );
      }
      return { path: `${t.path}/force-cancel`, done: { cancelled: true } };
    },
  );
};
