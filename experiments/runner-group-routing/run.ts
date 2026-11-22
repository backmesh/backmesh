// Whether two runner groups, each restricted to one repository, route by
// repository when both hold a scale set of the same name: a job in route-a
// with `runs-on: <name>` goes to group A's scale set only, route-b's to group
// B's. Also whether GitHub takes the second scale set of that name at all,
// and, once group B also allows route-a, which set route-a's jobs reach.
// Dispatched through spike.yml, which passes no arguments, so ORG and the
// repositories are committed.
//
// The credential is an org owner's user token for the backmesh App
// (GitHub's device flow with its public client ID): the App's Self-hosted
// runners write runs the groups, scale sets and sessions, and its Actions
// write dispatches and cancels the runs. The run phase prints a code; an
// owner of ORG enters it. The token stays valid afterwards: the owner
// revokes it at https://github.com/settings/apps/authorizations.
//
// No runner ever starts: each session acquires the jobs it's offered, so
// GitHub sends JobAssigned to the set that won, and the runs are then
// cancelled. Cleanup cancels the runs and deletes the sessions, scale sets
// and groups the run recorded in STATE, outside the evidence, carrying on
// past a failed step, and checks the groups and scale sets are gone.
//
// Evidence: report.json in SPIKE_OUTPUT_DIR: each step's answer, the
// org's plan, and every job message each session received. Never a token.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORG = 'backmesh-dryrun';
// Each has .github/workflows/route.yml: workflow_dispatch with a `label`
// input its one job runs on.
const REPOS = { a: 'route-a', b: 'route-b' } as const;
const CLIENT_ID = 'Iv23li6e0q0gl3GOQ9ny';
const SIGN_IN_MS = 20 * 60_000;
// Runs per repository in each phase.
const ROUNDS = { 'one-repo-each': 2, 'route-a-in-both': 5 };
const WATCH_MS = 3 * 60_000;
const API_VERSION = '6.0-preview';
const SCALE_SETS = '_apis/runtime/runnerscalesets';

const OUT = process.env.SPIKE_OUTPUT_DIR ?? 'spike-evidence';
const STATE = join(
  process.env.RUNNER_TEMP ?? tmpdir(),
  'runner-group-routing.json',
);
// Fresh names per run: GitHub routes no jobs to a group whose name was
// deleted and created again (src/github/runner-group.ts).
const RUN = process.env.GITHUB_RUN_ID ?? String(Date.now());
const SET_NAME = `bm-route-${RUN}`;
const GROUPS = { a: `route-spike-a-${RUN}`, b: `route-spike-b-${RUN}` };

type Side = 'a' | 'b';
interface State {
  token: string;
  groups: Partial<Record<Side, number>>;
  scaleSets: Partial<Record<Side, number>>;
  sessions: Partial<Record<Side, string>>;
  runs: { repo: string; id: number; phase: string }[];
}
const keep = (state: State) =>
  writeFileSync(STATE, JSON.stringify(state), { mode: 0o600 });

mkdirSync(OUT, { recursive: true, mode: 0o700 });
const report: Record<string, unknown> = { org: ORG, setName: SET_NAME };
const events: unknown[] = [];
const log = (line: string, detail?: unknown) => {
  console.log(
    `${new Date().toISOString()} ${line}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`,
  );
  events.push({ at: new Date().toISOString(), line, detail });
};
const save = () =>
  writeFileSync(
    join(OUT, 'report.json'),
    `${JSON.stringify({ ...report, events }, null, 2)}\n`,
  );
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(
  url: string,
  token: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const res = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'backmesh-spike',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, json: json as Record<string, unknown> };
}

// GitHub's REST API; anything but a 2xx throws with GitHub's answer.
async function gh(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const { status, json } = await call(
    `https://api.github.com${path}`,
    token,
    method,
    body,
    { 'X-GitHub-Api-Version': '2022-11-28' },
  );
  if (status >= 300) {
    throw new Error(
      `${method} ${path} answered ${status}: ${JSON.stringify(json)}`,
    );
  }
  return json ?? {};
}

const form = async (path: string, body: Record<string, string>) =>
  (await (
    await fetch(`https://github.com${path}`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(30_000),
    })
  ).json()) as Record<string, unknown>;

async function signIn(): Promise<string> {
  const deadline = Date.now() + SIGN_IN_MS;
  while (Date.now() < deadline) {
    const code = await form('/login/device/code', { client_id: CLIENT_ID });
    if (typeof code.device_code !== 'string') {
      throw new Error(`device code refused: ${JSON.stringify(code)}`);
    }
    console.log(
      `::notice title=Owner sign-in::An owner of ${ORG}: open ${String(code.verification_uri)} and enter ${String(code.user_code)} (expires in ${String(code.expires_in)} s)`,
    );
    let interval = Number(code.interval) * 1000;
    const expires = Date.now() + Number(code.expires_in) * 1000;
    while (Date.now() < Math.min(expires, deadline)) {
      await sleep(interval);
      const answer = await form('/login/oauth/access_token', {
        client_id: CLIENT_ID,
        device_code: code.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }).catch((error: unknown): Record<string, unknown> => ({
        error: String(error),
      }));
      if (typeof answer.access_token === 'string') return answer.access_token;
      if (answer.error === 'slow_down') interval += 5000;
      else if (answer.error === 'expired_token') break;
    }
  }
  throw new Error(`no owner signed in within ${SIGN_IN_MS / 60_000} min`);
}

// The Actions service, as src/github/actions-client.ts reaches it: an org
// registration token exchanged for its URL and an admin token.
async function actionsService(token: string) {
  const { token: registration } = (await gh(
    token,
    'POST',
    `/orgs/${ORG}/actions/runners/registration-token`,
  )) as { token: string };
  const res = await fetch(
    'https://api.github.com/actions/runner-registration',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `RemoteAuth ${registration}`,
        'User-Agent': 'backmesh-spike',
      },
      body: JSON.stringify({
        url: `https://github.com/${ORG}`,
        runner_event: 'register',
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!res.ok) throw new Error(`runner-registration answered ${res.status}`);
  const admin = (await res.json()) as { url: string; token: string };
  return (method: string, path: string, body?: unknown, auth = admin.token) => {
    const url = new URL(`${admin.url.replace(/\/+$/, '')}/${path}`);
    url.searchParams.set('api-version', API_VERSION);
    return call(url.toString(), auth, method, body);
  };
}

type Service = Awaited<ReturnType<typeof actionsService>>;
interface Session {
  sessionId: string;
  messageQueueUrl: string;
  messageQueueAccessToken: string;
}
interface Seen {
  side: Side;
  job: Job;
  // For a JobAvailable: whether this session's acquire got the job.
  acquired?: boolean;
  acquire?: { status: number; json: unknown };
}
interface Job {
  messageType: string;
  runnerRequestId: number;
  repositoryName: string;
  workflowRunId: number;
  requestLabels?: string[];
}

// Long-polls one session until `stop`, acks each message and acquires each
// job it's offered; every job message lands in `seen`.
async function watch(
  side: Side,
  service: Service,
  scaleSetId: number,
  session: Session,
  stop: { done: boolean },
  seen: Seen[],
) {
  let last = 0;
  while (!stop.done) {
    const url = new URL(session.messageQueueUrl);
    if (last) url.searchParams.set('lastMessageId', String(last));
    const res = await call(
      url.toString(),
      session.messageQueueAccessToken,
      'GET',
      undefined,
      {
        Accept: `application/json; api-version=${API_VERSION}`,
        'X-ScaleSetMaxCapacity': '10',
      },
    ).catch((error: unknown) => ({
      status: 0,
      json: { error: String(error) },
    }));
    if (res.status === 202) continue;
    if (res.status !== 200) {
      log(`${side}: poll answered ${res.status}`, res.json);
      await sleep(5000);
      continue;
    }
    const envelope = res.json as {
      messageId: number;
      messageType: string;
      body?: string;
    };
    last = envelope.messageId;
    const jobs: Job[] =
      envelope.messageType === 'RunnerScaleSetJobMessages' && envelope.body
        ? (JSON.parse(envelope.body) as Job[])
        : [];
    for (const job of jobs) {
      const entry: Seen = { side, job };
      if (job.messageType === 'JobAvailable') {
        const acquire = await service(
          'POST',
          `${SCALE_SETS}/${scaleSetId}/acquirejobs`,
          [job.runnerRequestId],
          session.messageQueueAccessToken,
        );
        entry.acquire = acquire;
        const granted = (acquire.json as { value?: unknown } | undefined)
          ?.value;
        entry.acquired =
          acquire.status === 200 &&
          Array.isArray(granted) &&
          granted.includes(job.runnerRequestId);
      }
      seen.push(entry);
      log(`${side} got ${job.messageType} from ${job.repositoryName}`, entry);
    }
    const ack = new URL(session.messageQueueUrl);
    ack.pathname = `${ack.pathname}/${envelope.messageId}`;
    await call(ack.toString(), session.messageQueueAccessToken, 'DELETE');
  }
}

async function dispatch(
  token: string,
  state: State,
  repo: string,
  phase: string,
) {
  const before = Date.now();
  await gh(
    token,
    'POST',
    `/repos/${ORG}/${repo}/actions/workflows/route.yml/dispatches`,
    { ref: 'main', inputs: { label: SET_NAME } },
  );
  // The dispatch answers 204 without the run; find it.
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const { workflow_runs } = (await gh(
      token,
      'GET',
      `/repos/${ORG}/${repo}/actions/workflows/route.yml/runs?event=workflow_dispatch&per_page=10`,
    )) as {
      workflow_runs: { id: number; created_at: string; html_url: string }[];
    };
    const run = workflow_runs.find(
      (r) =>
        Date.parse(r.created_at) >= before - 5000 &&
        !state.runs.some((known) => known.id === r.id),
    );
    if (run) {
      state.runs.push({ repo, id: run.id, phase });
      keep(state);
      log(`dispatched ${repo}`, { run: run.html_url });
      return;
    }
  }
  throw new Error(`no run appeared for the dispatch in ${repo}`);
}

// Each run on its own: one failed call doesn't leave the rest running.
async function cancelRuns(token: string, state: State) {
  for (const { repo, id } of state.runs) {
    const path = `/repos/${ORG}/${repo}/actions/runs/${id}`;
    try {
      const run = await gh(token, 'GET', path);
      if (run.status !== 'completed') {
        await gh(token, 'POST', `${path}/force-cancel`);
      }
    } catch (error) {
      log(`cancel ${repo} ${id} failed`, String(error));
    }
  }
}

// Each step carries on past another's failure, to the check of what's left.
async function cleanUp(state: State) {
  const { token } = state;
  let failed = false;
  const step = async <T>(what: string, fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (error) {
      failed = true;
      log(`${what} failed`, String(error));
      return undefined;
    }
  };
  await step('cancelling the runs', () => cancelRuns(token, state));
  const service = await step('the Actions service', () =>
    actionsService(token),
  );
  for (const side of ['a', 'b'] as const) {
    const set = state.scaleSets[side];
    const session = state.sessions[side];
    if (!service || set === undefined) continue;
    if (session) {
      await step(`deleting session ${side}`, () =>
        service('DELETE', `${SCALE_SETS}/${set}/sessions/${session}`),
      );
    }
    const res = await step(`deleting scale set ${side}`, () =>
      service('DELETE', `${SCALE_SETS}/${set}`),
    );
    log(`deleted scale set ${side}`, { id: set, status: res?.status });
  }
  for (const side of ['a', 'b'] as const) {
    const id = state.groups[side];
    if (id === undefined) continue;
    await step(`deleting group ${side}`, () =>
      gh(token, 'DELETE', `/orgs/${ORG}/actions/runner-groups/${id}`),
    );
  }
  // What's left, by ID.
  const groups = await step('listing the groups', () =>
    gh(token, 'GET', `/orgs/${ORG}/actions/runner-groups?per_page=100`),
  );
  const leftGroups = (
    (groups?.runner_groups ?? []) as { id: number; name: string }[]
  ).filter((g) => Object.values(state.groups).includes(g.id));
  const leftSets: number[] = [];
  for (const id of Object.values(state.scaleSets)) {
    const res = await step(`checking scale set ${id}`, () =>
      service ? service('GET', `${SCALE_SETS}/${id}`) : Promise.reject(),
    );
    if (!res || (res.status === 200 && res.json?.id === id)) leftSets.push(id);
  }
  report.leftover = { groups: leftGroups, scaleSets: leftSets };
  log('left after cleanup', report.leftover);
  if (failed || leftGroups.length || leftSets.length) {
    throw new Error('cleanup failed a step or left groups or scale sets');
  }
}

async function run() {
  const token = await signIn();
  const state: State = {
    token,
    groups: {},
    scaleSets: {},
    sessions: {},
    runs: [],
  };
  keep(state);
  const who = await gh(token, 'GET', '/user');
  const org = await gh(token, 'GET', `/orgs/${ORG}`);
  report.signedIn = who.login;
  report.plan = (org.plan as { name?: string } | undefined)?.name;
  log('signed in', { login: who.login, plan: report.plan });

  const repoIds: Record<Side, number> = { a: 0, b: 0 };
  for (const side of ['a', 'b'] as const) {
    repoIds[side] = (await gh(token, 'GET', `/repos/${ORG}/${REPOS[side]}`))
      .id as number;
  }

  // Each group: selected visibility, its one repository.
  for (const side of ['a', 'b'] as const) {
    const group = await gh(
      token,
      'POST',
      `/orgs/${ORG}/actions/runner-groups`,
      {
        name: GROUPS[side],
        visibility: 'selected',
        selected_repository_ids: [repoIds[side]],
      },
    );
    state.groups[side] = group.id as number;
    keep(state);
    const repos = await gh(
      token,
      'GET',
      `/orgs/${ORG}/actions/runner-groups/${group.id as number}/repositories`,
    );
    log(`group ${side}`, {
      id: group.id,
      visibility: group.visibility,
      repositories: (repos.repositories as { name: string }[]).map(
        (r) => r.name,
      ),
    });
  }

  // The same scale-set name in each group.
  const service = await actionsService(token);
  const scaleSetIds: Record<Side, number> = { a: 0, b: 0 };
  const opened: { side: Side; session: Session }[] = [];
  for (const side of ['a', 'b'] as const) {
    const groups = await service(
      'GET',
      `_apis/runtime/runnergroups/?groupName=${encodeURIComponent(GROUPS[side])}`,
    );
    // Without it the set would land in the Default group.
    const groupId = (groups.json?.value as { id: number }[] | undefined)?.[0]
      ?.id;
    if (groupId === undefined) {
      throw new Error(`the Actions service has no group ${GROUPS[side]}`);
    }
    const created = await service('POST', SCALE_SETS, {
      name: SET_NAME,
      runnerGroupId: groupId,
      labels: [{ name: SET_NAME, type: 'System' }],
      RunnerSetting: { ephemeral: true, disableUpdate: true },
    });
    log(`create scale set ${side}`, {
      status: created.status,
      body: created.json,
    });
    if (created.status !== 200) {
      report.duplicateName = {
        side,
        status: created.status,
        body: created.json,
      };
      throw new Error(`the scale set in group ${side} wasn't created`);
    }
    scaleSetIds[side] = created.json.id as number;
    state.scaleSets[side] = scaleSetIds[side];
    keep(state);
    if (created.json.runnerGroupId !== groupId) {
      throw new Error(
        `scale set ${side} is in group ${String(created.json.runnerGroupId)}, not ${groupId}`,
      );
    }
    const session = await service(
      'POST',
      `${SCALE_SETS}/${scaleSetIds[side]}/sessions`,
      {
        ownerName: `route-spike-${side}`,
      },
    );
    if (session.status !== 200)
      throw new Error(`session ${side}: ${session.status}`);
    const made = session.json as unknown as Session;
    opened.push({ side, session: made });
    state.sessions[side] = made.sessionId;
    keep(state);
  }
  report.duplicateName = { created: true, scaleSetIds };

  const seen: Seen[] = [];
  const stop = { done: false };
  const watchers = opened.map(({ side, session }) =>
    watch(side, service, scaleSetIds[side], session, stop, seen),
  );
  try {
    // Phase 1: each group allows only its own repository.
    for (let i = 0; i < ROUNDS['one-repo-each']; i++) {
      await dispatch(token, state, REPOS.a, 'one-repo-each');
      await dispatch(token, state, REPOS.b, 'one-repo-each');
    }
    await sleep(WATCH_MS);
    await cancelRuns(token, state);
    await sleep(30_000);

    // Phase 2: group B also allows route-a.
    await gh(
      token,
      'PUT',
      `/orgs/${ORG}/actions/runner-groups/${state.groups.b}/repositories/${repoIds.a}`,
    );
    log('group b now also allows route-a');
    for (let i = 0; i < ROUNDS['route-a-in-both']; i++) {
      await dispatch(token, state, REPOS.a, 'route-a-in-both');
      await dispatch(token, state, REPOS.b, 'route-a-in-both');
    }
    await sleep(WATCH_MS);
    await cancelRuns(token, state);
    await sleep(30_000);
  } finally {
    stop.done = true;
    // A long poll ends within about 50 s.
    await Promise.allSettled(watchers);
    for (const { side, session } of opened) {
      await service(
        'DELETE',
        `${SCALE_SETS}/${scaleSetIds[side]}/sessions/${session.sessionId}`,
      );
    }
    report.messages = seen;
    // Per run: the sessions offered its job, the ones whose acquire got
    // it, and the ones sent JobAssigned. A session won the job when both.
    const sides = (id: number, test: (entry: Seen) => boolean) => [
      ...new Set(
        seen
          .filter((e) => e.job.workflowRunId === id && test(e))
          .map((e) => e.side),
      ),
    ];
    const runs = state.runs.map(({ repo, id, phase }) => {
      const acquiredBy = sides(id, (e) => e.acquired === true);
      const assignedTo = sides(id, (e) => e.job.messageType === 'JobAssigned');
      return {
        run: `https://github.com/${ORG}/${repo}/actions/runs/${id}`,
        repo,
        phase,
        offeredTo: sides(id, (e) => e.job.messageType === 'JobAvailable'),
        acquiredBy,
        assignedTo,
        wonBy: acquiredBy.filter((side) => assignedTo.includes(side)),
      };
    });
    report.runs = runs;
    // Per phase and repository: how many jobs each outcome had.
    const summary: Record<string, Record<string, number>> = {};
    for (const { phase, repo, offeredTo, wonBy } of runs) {
      const key = `${phase} ${repo}`;
      const outcome = `offered ${offeredTo.join('+') || 'none'}, won ${wonBy.join('+') || 'none'}`;
      summary[key] ??= {};
      summary[key][outcome] = (summary[key][outcome] ?? 0) + 1;
    }
    report.summary = summary;
    log('summary', summary);
    save();
  }
}

try {
  if (process.env.SPIKE_PHASE === 'cleanup') {
    let state: State | undefined;
    try {
      state = JSON.parse(readFileSync(STATE, 'utf8')) as State;
    } catch {
      log('no state: the run phase created nothing');
    }
    if (state) {
      await cleanUp(state);
      rmSync(STATE);
    }
  } else {
    await run();
  }
} catch (error) {
  log('failed', String(error));
  process.exitCode = 1;
} finally {
  if (process.env.SPIKE_PHASE === 'cleanup') {
    writeFileSync(
      join(OUT, 'cleanup.json'),
      `${JSON.stringify({ leftover: report.leftover, events }, null, 2)}\n`,
    );
  } else {
    save();
  }
}
