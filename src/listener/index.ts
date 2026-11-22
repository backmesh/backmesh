// The listener's entry point: the scale-set count loop, run as a container
// on the org's own listener VM (`cli/listener-vm.ts`).
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';

import { anycloudApi } from '../anycloud/client.js';
import { ActionsClient } from '../github/actions-client.js';
import type { Note, WorkflowRun } from '../github/checks.js';
import {
  cacheRun,
  gateGitHub,
  recentRuns,
  runBranch,
  runJobs,
  workflowFiles,
  workflowRuns,
} from '../github/runs.js';
import {
  installationOctokit,
  InstallationTokens,
} from '../github/installation-token.js';
import { retryingFetch, type Log } from '../github/retry.js';
import { isOurRunnerGroup } from '../github/runner-group.js';
import { workerCancel, workerRerun } from './run-actions.js';
import { apiUrl, Telemetry } from './telemetry.js';
import { ListenerControl, serve } from './control.js';
import { CacheTokens } from './cache.js';
import { cacheBuckets } from './sweep.js';
import { CueListener } from './cue.js';
import { Gate } from './gate.js';
import { drain } from './drain.js';
import { waitForToken } from './installation.js';
import { listenerRunnerGroup, runListener } from './listener.js';
import { Planner } from './prewarm.js';
import { Retrier } from './retry.js';
import { codeOf, parseRoutes, RUNNERS_ENV } from './routes.js';
import { anycloudRunnerJobs, runnerVm } from './runner-jobs.js';
import { Quotas } from './quota.js';
import { readQuotaStatus } from '../runners/quota.js';
import { Scaler } from './scaler.js';
import { Starts } from './starts.js';
import {
  API_TOKEN_ENV,
  API_URL_ENV,
  RUNNER_GROUP_ENV,
  STANDBY_ENV,
} from './env.js';

const log: Log = (entry) =>
  process.stdout.write(
    `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`,
  );

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

// The org's Secret, which install and upgrade write to the VM.
const org = env('ORG');
const install = env('BACKMESH_INSTALL');
if (!/^[a-z0-9]{5}$/.test(install)) {
  throw new Error('BACKMESH_INSTALL must be 5 lowercase letters or digits.');
}
const runnerGroup = env(RUNNER_GROUP_ENV);
if (!isOurRunnerGroup(install)(runnerGroup)) {
  throw new Error(`${RUNNER_GROUP_ENV} isn't this install's runner group.`);
}
// The install key the Worker knows this install by, and
// mints this org's installation tokens for.
const installKey = env('BACKMESH_INSTALL_KEY');
const { version }: { version: string } = JSON.parse(
  await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
);
// The runner classes, in the Secret so `upgrade` can change them.
const routes = parseRoutes(env(RUNNERS_ENV));
// `install --public-repos`: the group
// allows public repositories while a public class isn't retiring, and the
// gate runs while any public class is listed, so a draining one's jobs stay
// confined.
const allowPublic = routes.some((route) => route.public && !route.retiring);
const publicRoutes = routes.filter((route) => route.public);

const fetch = retryingFetch(globalThis.fetch, { log });
// One retry, which may wait out a 429's Retry-After: the tokens' own
// once-a-minute refresh and the installation wait retry the broker.
const tokens = new InstallationTokens(
  { url: apiUrl(), installKey, org },
  retryingFetch(globalThis.fetch, { log, max: 1, attemptTimeoutMs: 10_000 }),
);
// Since when the control plane has refused the service token, such as after
// a restore from a backup older than its last rotation; null once it takes
// it again.
let refused: { since: string; error: string } | null = null;
const control = new ListenerControl({
  broker: () => tokens.unreachable,
  notInstalled: () => tokens.notInstalled,
  anycloud: () => refused,
});

const shutdown = new AbortController();
process.once('SIGTERM', () => shutdown.abort());
// Ends the sessions on shutdown or for `uninstall`'s drain.
shutdown.signal.addEventListener('abort', () => control.sessions.abort());
const stopped = () =>
  new Promise((resolve) =>
    shutdown.signal.addEventListener('abort', resolve, { once: true }),
  );

// The listener's service token, which `backmesh upgrade` replaces.
const api = anycloudApi(
  env(API_URL_ENV),
  env(API_TOKEN_ENV),
  async (request, init) => {
    const response = await globalThis.fetch(request, init);
    if (response.status === 401) {
      refused ??= {
        since: new Date().toISOString(),
        error: `HTTP 401: ${await response.clone().text()}`.slice(0, 300),
      };
    } else if (response.ok) refused = null;
    return response;
  },
);

// In standby, one read before `/status` answers, so it reports a token the
// control plane refuses, or any other failure to reach it.
const standby = !!process.env[STANDBY_ENV];
if (standby) {
  await api
    .listWorkloads({ query: { workloadType: 'vm', limit: '1' } })
    .catch((error: unknown) => {
      refused ??= { since: new Date().toISOString(), error: String(error) };
    });
}
// Loopback only: `backmesh status`, `upgrade` and `uninstall` reach it through
// `anycloud exec` and `docker exec`. Up first, so they work while the App
// isn't installed or the runner group can't be made.
const server = serve(control);

const listening = control.listen(async (signal) => {
  if (standby) return void (await stopped());
  await waitForToken(tokens, log, signal);
  const octokit = installationOctokit(tokens, fetch);
  const actions = new ActionsClient({
    org,
    octokit,
    fetch,
    signal: shutdown.signal,
    log,
  });
  const orgId = async (signal?: AbortSignal) =>
    (await octokit.request('GET /orgs/{org}', { org, request: { signal } }))
      .data.id;
  const telemetry = new Telemetry({
    url: apiUrl(),
    key: installKey,
    version,
    orgId,
    fetch: globalThis.fetch,
    runnerVm: (runner, signal) => runnerVm(api, runner, signal),
    log,
  });
  void telemetry.run(shutdown.signal);
  const worker = {
    url: apiUrl(),
    key: installKey,
    install,
    fetch: globalThis.fetch,
  };
  // Retry reads with this org's token and reruns through the Worker, which
  // holds the App's Actions write (owner, 2026-11-19).
  const retrier = new Retrier({
    runs: {
      ...workflowRuns(octokit),
      rerunFailedJobs: workerRerun(worker),
    },
    ours: (runner) => codeOf(install, runner) !== undefined,
    log,
  });
  const planner = new Planner({
    // A draining label needs no runners started ahead, and a public one
    // gets none.
    labels: routes
      .filter((r) => !r.retiring && !r.public)
      .map((route) => route.label),
    history: recentRuns(octokit),
    runBranch: runBranch(octokit),
    workflows: workflowFiles(octokit),
    replanned: () => reconcile?.(),
    log,
  });
  // Install and upgrade make a cache bucket in every route region before
  // the listener starts.
  const cache = new CacheTokens({
    api,
    install,
    buckets: cacheBuckets(install, routes),
    run: cacheRun(octokit),
    region: async (runner) =>
      (await runnerVm(api, runner, AbortSignal.timeout(30_000)))?.region ??
      null,
    log,
  });
  // A job's start from the REST jobs list, for its cache token, ahead of
  // GitHub's late JobStarted.
  const starts = new Starts({
    jobs: runJobs(octokit),
    waiting: (route, runner) =>
      codeOf(install, runner) === route.code && cache.waiting(runner),
    started: (route, job, startedAt) => cache.started(route, job, startedAt),
    log,
  });
  const jobs = anycloudRunnerJobs(api, install, env('BACKMESH_RUNNER_IMAGE'));
  // A note on a run (a reclaim, a fork run held, the runtime limit), in the
  // listener's log: the App posts no check runs.
  const note = async (run: WorkflowRun, n: Note) =>
    log({ msg: 'note', run: `${run.owner}/${run.repo}/${run.runId}`, ...n });
  const privateCodes = new Set(
    routes.filter((route) => !route.public).map((route) => route.code),
  );
  const publicCodes = new Set(publicRoutes.map((route) => route.code));
  const gate = publicRoutes.length
    ? new Gate({
        github: { ...gateGitHub(octokit), forceCancel: workerCancel(worker) },
        note,
        terminate: (runner) => jobs.terminate(runner),
        privateRunner: (name) => privateCodes.has(codeOf(install, name) ?? ''),
        publicRunner: (name) => publicCodes.has(codeOf(install, name) ?? ''),
        privateLabels: new Set(
          routes.filter((route) => !route.public).map((route) => route.label),
        ),
        publicLabels: publicRoutes
          .filter((route) => !route.retiring)
          .map((route) => route.label),
        changed: () => reconcile?.(),
        replay: (label, job) => planner.observe(label, job, Date.now()),
        log,
      })
    : undefined;
  const scaler = new Scaler({
    install,
    cache,
    gate,
    jobStarted: (route, job, spot) => telemetry.jobStarted(route, job, spot),
    jobs,
    github: actions,
    note,
    retry: (run, reclaims) => retrier.decide(run, reclaims),
    routing: retrier,
    planner,
    quotas: new Quotas(
      (cloud, credentialName, region) =>
        readQuotaStatus(api, cloud, credentialName, region, true),
      log,
    ),
    log,
  });
  // `backmesh cue`: a cue only adds the planner's slots, and
  // a relay that's down only loses cues.
  let reconcile: (() => void) | undefined;
  const cues = new CueListener({
    url: apiUrl(),
    installKey,
    org,
    orgId: () => orgId(AbortSignal.timeout(10_000)),
    permission: async (repo, user) => {
      const [owner, name] = repo.split('/') as [string, string];
      const answer = await octokit
        .request(
          'GET /repos/{owner}/{repo}/collaborators/{username}/permission',
          {
            owner,
            repo: name,
            username: user,
          },
        )
        .catch((error: { status?: number }) => {
          if (error.status === 404) return undefined;
          throw error;
        });
      return answer?.data.permission ?? 'none';
    },
    // A changed start or end moves the next due reconcile, so any change
    // reconciles.
    onCue: (cue, leadMs) => {
      const { repo, branch } = cue;
      if (cue.kind === 'drop') {
        const dropped = planner.cancel(repo, branch, Date.now());
        log({ msg: 'cue cancelled', slots: dropped });
        if (dropped) reconcile?.();
        return;
      }
      const slots = planner.cue(repo, branch, leadMs, Date.now(), cue.pr);
      log({ msg: 'cue slots', ...slots });
      if (Object.values(slots).some(Boolean)) reconcile?.();
    },
    log,
  });
  void cues
    .start()
    .catch((error: unknown) =>
      log({ msg: 'cue relay off', error: String(error) }),
    );
  shutdown.signal.addEventListener('abort', () => cues.stop(), { once: true });
  control.ready({
    scaler,
    telemetry: () => telemetry.status(),
    actionsPermission: () => tokens.actionsPermission(),
    drain: (progress) => drain({ scaler, log }, progress),
  });
  void starts.run(signal);
  await runListener(
    {
      actions,
      runnerGroup: () =>
        listenerRunnerGroup(octokit, org, runnerGroup, actions, allowPublic),
      scaler,
      gate,
      starts,
      routes,
      owner: hostname(),
      log,
      reconciler: (fn) => (reconcile = fn),
    },
    signal,
  );
  await scaler.flushJobs();
});

try {
  await listening;
  // Exiting would restart the container, and a new listener would recreate the
  // scale sets, so a drained one waits for uninstall to delete it.
  if (control.drainStarted && !shutdown.signal.aborted) await stopped();
} finally {
  server.close();
}
