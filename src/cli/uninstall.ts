// `backmesh uninstall`: one path, whether the control plane
// answers or is gone. The restore command and the role setup's removal come
// later.
import type { RunAnycloud } from '../anycloud/binary.js';
import {
  anycloudApi,
  anycloudExec,
  activeApiUrl,
  apiToken,
  tokenRefresh,
  type AnycloudApi,
  type AnycloudExec,
} from '../anycloud/client.js';
import { ANYCLOUD_VERSION } from '../anycloud/contract.generated.js';
import { missingFeatures, type FeatureTable } from '../anycloud/features.js';
import { anycloudControl } from '../app/anycloud.js';
import { readOverride } from '../app/override.js';
import { sleepFor, type Sleep } from '../github/retry.js';
import {
  workerDeps,
  finishCleanup,
  refreshCleanupToken,
  signInForCleanup,
  LiveInstalls,
  type Cleanup,
} from './worker.js';
import { removeFromGitHub } from './cleanup.js';
import { drainStatusSchema } from '../listener/drain.js';
import { TERMINAL } from '../listener/runner-jobs.js';
import { CLOUDS, type Cloud } from '../runners/classes.js';
import type { RunCommand } from '../runners/regions.js';
import {
  CLUSTER,
  deleteIdentity,
  generatedIdentity,
  parseControlPlane,
  SIGNED_IN,
  type InstallUi,
} from './install.js';
import { removeIdentity } from './identity.js';
import { UsageError } from './errors.js';
import { signInAgain } from './github-sign-in.js';
import {
  clusterIdOf,
  connectionName,
  installConnection,
  installTag,
  readOrgId,
  sessionOf,
  listenerName,
  orgOfListener,
  readInstallation,
  type Listener,
} from './installation.js';
import { execListener, readApiVersion, readListener } from './status.js';
import { deleteCacheBuckets } from './cache-buckets.js';

export interface UninstallOptions {
  // One org: of several on the control plane, only its listener goes and
  // the control plane stays. Needed when the control plane is gone.
  org?: string;
  yes: boolean;
  deleteCheckpointBucket: boolean;
  confirm?: string;
  // `--control-plane <cloud>:<region>` of the management VM, for deleting
  // the cloud side through the user's cloud CLI when the control plane
  // doesn't answer.
  controlPlane?: string;
  // Leaves the GitHub App on each org, for an org whose next install comes
  // with nobody to click Install, such as our e2e's test org.
  keepApp?: boolean;
}

export interface UninstallDeps {
  env: NodeJS.ProcessEnv;
  run: RunAnycloud;
  // For `api delete`, which waits until the installation is gone.
  runLong: RunAnycloud;
  // The user's cloud CLIs, which delete our CI's generated identities.
  command: RunCommand;
  // `ask` reads a typed line; both are undefined without a TTY.
  ui: InstallUi;
  api?: typeof anycloudApi;
  exec?: typeof anycloudExec;
  fetch?: typeof globalThis.fetch;
  features?: FeatureTable;
  sleep?: Sleep;
  pollMs?: number;
  // The device flow's polling wait.
  wait?: (ms: number) => Promise<void>;
}

const POLL_MS = 10_000;
// Half an hour of polls, for the drain and for the runners' VMs to go.
const POLLS = 180;
// `anycloud exec` can fail while the API or the listener is briefly away.
const FAILED_READS = 3;

async function poll<T>(
  deps: UninstallDeps,
  read: () => Promise<T>,
  done: (value: T) => boolean,
  what: string,
): Promise<T> {
  const { sleep = sleepFor, pollMs = POLL_MS } = deps;
  for (let attempt = 1; ; attempt++) {
    const value = await read();
    if (done(value)) return value;
    if (attempt === POLLS) {
      throw new Error(`Timed out waiting for ${what}. Run uninstall again.`);
    }
    await sleep(pollMs);
  }
}

// What install left in each cloud: our CI's generated identity, whose
// connection is only anycloud's record of it (`credentials-domain.ts:294-303`
// at v0.1.72), or a role connection's setup, which trusts only the deleted
// control plane's issuer. The identity's name is its connection's, unknown
// without the control plane's ID.
export interface Leftover {
  kind: 'key' | 'role';
  connection?: string;
  // Not read from the control plane's connections (`everyCloud`).
  guessed?: boolean;
}
export const leftoverIdentity = (cloud: Cloud, connection?: string) =>
  connection
    ? `${cloud}'s identity ${generatedIdentity(connection)} is left in your cloud, if install generated it. Delete it, signed in to the ${SIGNED_IN[cloud]} install used, with:\n${deleteIdentity(cloud, connection)}`
    : `${cloud}'s identity ${generatedIdentity(`bm-${cloud}`)}-<6 characters> is left in your cloud, if install generated it; delete it in ${cloud}'s console.`;
export const leftoverRole = (cloud: Cloud, maybe = false) =>
  `${cloud}'s role connection setup is left in the ${SIGNED_IN[cloud]} it ran in${maybe ? ', if install connected it' : ''}. It trusts only this control plane, which is gone; delete it in ${cloud}'s console.`;

// What `api delete --json` couldn't delete, with the tag, ID or name to
// search for (`DeleteEntry`, anycloud `src/cli/services/seed-delete.ts`). A
// kept bucket is reported on its own, and a harmless entry is left on
// purpose at no cost.
interface DeleteReport {
  remaining?: {
    kind: string;
    type?: string;
    id?: string;
    name?: string;
    selector?: string;
    reason?: string;
  }[];
}
function printRemaining(out: string, print: (line: string) => void) {
  const remaining = (JSON.parse(out) as DeleteReport).remaining ?? [];
  // The DNS record is anycloud's, on no cloud console.
  const dns = remaining.find(({ kind }) => kind === 'dnsRecord');
  if (dns) {
    print(
      `backmesh kept the DNS record ${dns.name}, which another GitHub account may hold or which goes once the installation is gone; run uninstall again to remove it.`,
    );
  }
  const left = remaining.filter(
    ({ kind, reason }) =>
      !['checkpointBucket', 'dnsRecord'].includes(kind) &&
      reason !== 'harmless',
  );
  if (!left.length) return;
  const what = left.map(
    (entry) =>
      `${entry.type ?? (entry.kind === 'managementVm' ? 'control plane VM' : entry.kind)} ${entry.selector ?? entry.id ?? entry.name}`,
  );
  print(`Still in your cloud, to delete in its console: ${what.join(', ')}.`);
}

// The hosted API's connections that install made (`installConnection`).
const listConnections = async (run: RunAnycloud, clusterId: string) => {
  const listed = JSON.parse(await run(['credentials', 'list', '--json'])) as {
    name: string;
    kind?: 'key' | 'role';
  }[];
  return new Map(
    CLOUDS.flatMap((cloud) => {
      const found = installConnection(cloud, clusterId, listed);
      return found
        ? [[cloud, { kind: found.kind ?? 'key', connection: found.name }]]
        : [];
    }),
  );
};

// Without the connections, every cloud's: our CI's generated identity, named
// for the control plane when its ID is known, or a customer's role setup.
// One from before 0.4.1, `anycloud-bm-<cloud>`, is printed too: in an
// account several installations share, it may be another's.
const everyCloud = (env: NodeJS.ProcessEnv, clusterId?: string) =>
  new Map<Cloud, Leftover>(
    CLOUDS.map((cloud) => [
      cloud,
      readOverride(env)
        ? {
            kind: 'key',
            connection: clusterId && connectionName(cloud, clusterId),
            guessed: true,
          }
        : { kind: 'role' },
    ]),
  );

// The bucket goes only with the user's yes at a TTY or the flag, and
// then only with the cluster's name or ID, typed or as `--confirm`.
async function bucketDecision(
  options: UninstallOptions,
  deps: UninstallDeps,
  clusterId: string,
): Promise<boolean> {
  const { ui } = deps;
  const remove =
    options.deleteCheckpointBucket ||
    ((await ui.confirm?.(
      "Delete the checkpoint bucket too? It holds the control plane's backups, and deleting it ends any restore.",
    )) ??
      false);
  if (!remove) return false;
  const value =
    options.confirm ??
    (await ui.ask?.(
      `Type the installation's name (${CLUSTER}) or ID (${clusterId}) to delete it and its checkpoint bucket:`,
    ));
  if (value === undefined) {
    throw new UsageError(
      `Deleting the checkpoint bucket needs --confirm <name-or-id>: --confirm ${clusterId}.`,
    );
  }
  if (value.trim() !== CLUSTER && value.trim() !== clusterId) {
    throw new UsageError(
      `${value} is neither ${CLUSTER} nor ${clusterId}; nothing was deleted.`,
    );
  }
  return true;
}

// Step 2 in an org's listener: a POST to its `/drain` stops it taking
// jobs and drains its runner Jobs, a GET reads it until it ends. A failure
// stops before the listener goes, so a rerun drains again.
async function drainListener(
  deps: UninstallDeps,
  exec: AnycloudExec,
  listener: Listener,
) {
  const parse = ({ code, body }: { code: number; body: unknown }) => {
    if (code === 404) {
      throw new Error(
        'The listener has no drain. Run `backmesh upgrade`, then uninstall again.',
      );
    }
    // Only a listener that never got the POST has no drain: a restarted one.
    if (body === null) {
      throw new Error(
        'The listener restarted during the drain, so it takes jobs again. Nothing in your clouds was deleted; run uninstall again.',
      );
    }
    return drainStatusSchema.parse(body);
  };
  parse(await execListener(exec, listener, '/drain', { method: 'POST' }));
  let failed = 0;
  const status = (await poll(
    deps,
    () =>
      execListener(exec, listener, '/drain').then(
        (reply) => ((failed = 0), parse(reply)),
        (cause: unknown) => {
          if (++failed < FAILED_READS) return undefined;
          throw new Error(
            `The listener's drain didn't answer ${FAILED_READS} times in a row. Nothing in your clouds was deleted; check \`backmesh status\` and run uninstall again.`,
            { cause },
          );
        },
      ),
    (value) => value !== undefined && value.state !== 'running',
    "the listener's drain",
  ))!;
  if (status.state !== 'done') {
    throw new Error(
      `The listener couldn't drain its runners: ${status.error}. It has stopped taking jobs and stays stopped until uninstall runs again. Nothing in your clouds was deleted; run uninstall again.`,
    );
  }
}

export interface UninstallResult {
  // Each org removed from GitHub, and whether its App installation went.
  orgs: { org: string; appRemoved: boolean }[];
  // Orgs whose GitHub side was skipped, as the Worker refused a keyless
  // cleanup while another install of the org was live.
  githubSkipped?: string[];
  // The control plane, when it answered.
  apiUrl?: string;
  clusterId?: string;
  // Deleted, kept for the control plane's other orgs, or skipped as gone.
  cloud: 'deleted' | 'kept' | 'skipped';
  checkpointBucket?: 'kept' | 'deleted';
}

// An org to remove: its listener, when it still runs, and its install key.
interface Org {
  org: string;
  listener?: Listener;
  installKey?: string;
  jobs: number;
}

// What uninstall works on when the control plane answers.
interface ControlPlane {
  url: string;
  clusterId: string;
  api: AnycloudApi;
  exec: AnycloudExec;
  orgs: Org[];
  // Orgs an earlier run left unfinished at GitHub (`readControlPlane`).
  unfinished: string[];
  // `--org` with no listener: `unfinished` is only a note, not a failure.
  unfinishedNoteOnly: boolean;
  // Whether the control plane goes: no `--org`, or the last org's.
  whole: boolean;
  // The connections install made, unless they couldn't be read.
  connections?: Map<Cloud, Leftover & { connection: string }>;
  // What install left in each cloud, to print.
  leftovers: Map<Cloud, Leftover>;
  deleteBucket: boolean;
}

interface Gone {
  gone: string;
  // From its URL, when one names the control plane.
  clusterId?: string;
}

// Each listener's org, install key and running jobs, which fail. A lost
// VM's listener can't say: its org's runner Jobs, which uninstall stops,
// are counted through its session, idle runners included, and as none when
// GitHub doesn't give the org's ID.
async function readOrgs(
  listeners: readonly Listener[],
  exec: AnycloudExec,
  runnerJobs: (org: string) => Promise<number>,
) {
  const orgs: Org[] = [];
  for (const listener of listeners) {
    if (listener.vm.lost) {
      const org = orgOfListener(listener.name)!;
      orgs.push({ org, listener, jobs: await runnerJobs(org) });
      continue;
    }
    const read = await readListener(exec, listener).catch((cause: unknown) => {
      throw new Error(
        `${orgOfListener(listener.name)}'s listener didn't answer, and uninstall drains its runners through it. Nothing was deleted; check \`backmesh status\` and run uninstall again.`,
        { cause },
      );
    });
    const jobs = read.status.scaleSets.reduce(
      (sum, set) => sum + set.running,
      0,
    );
    orgs.push({ org: read.org, listener, installKey: read.installKey, jobs });
  }
  return orgs;
}

// Before any change: the control plane, when one is configured here and
// answers, with the orgs to remove and the bucket's confirmation; else why
// its cloud side is skipped.
async function readControlPlane(
  options: UninstallOptions,
  deps: UninstallDeps,
): Promise<ControlPlane | Gone> {
  const { run } = deps;
  const url = await activeApiUrl(run);
  let clusterId;
  try {
    clusterId = clusterIdOf(url);
  } catch {
    return { gone: 'This machine has no backmesh control plane configured' };
  }
  try {
    await readApiVersion(url, deps.fetch ?? globalThis.fetch);
  } catch {
    return { gone: `The control plane at ${url} doesn't answer`, clusterId };
  }
  if (options.controlPlane) {
    throw new UsageError(
      `The control plane at ${url} answers, so uninstall deletes it through its API; --control-plane is only for one that doesn't.`,
    );
  }
  const token = await apiToken(deps.env, run);
  const refresh = tokenRefresh(
    deps.env,
    run,
    url,
    signInAgain(workerDeps(deps, deps.ui.print)),
  );
  const api = (deps.api ?? anycloudApi)(url, token, undefined, refresh);
  const exec = (deps.exec ?? anycloudExec)(url, token, undefined, refresh);
  const { orgs: listeners } = await readInstallation(api);
  // `--org` for one of several orgs removes that org only; for the last
  // org, or without it, uninstall removes everything.
  const { org } = options;
  let whole = true;
  let mine = listeners;
  if (org) {
    const name = listenerName(org);
    // A rerun past the listener's delete finds only its Secret.
    const known =
      listeners.some((listener) => listener.name === name) ||
      (await api.listSecrets()).some((secret) => secret.name === name);
    // With no listener at all (gone, crashed, or never per org), `--org`
    // names the org: the whole path runs, its sign-in first, which refuses
    // anyone who isn't that org's admin before any change.
    if (!known && listeners.length) {
      const orgs = listeners.map((listener) => orgOfListener(listener.name));
      throw new UsageError(
        `There's no backmesh for ${org} on ${url}. Its orgs are ${orgs.join(', ')}.`,
      );
    }
    mine = listeners.filter((listener) => listener.name === name);
    whole = !listeners.some((listener) => listener.name !== name);
  }
  const orgs = await readOrgs(mine, exec, async (login) => {
    const orgId = await readOrgId(login, deps.fetch, deps.env).catch(
      () => undefined,
    );
    if (orgId === undefined) return 0;
    const session = sessionOf(installTag(clusterId, orgId));
    return (
      await api.listWorkloads({
        query: { session, sessionExact: 'true', stateClass: 'terminatable' },
      })
    ).filter((job) => !TERMINAL.has(job.state)).length;
  });
  // `--org`'s listener an earlier run deleted: its org, without a key.
  if (org && !orgs.length) orgs.push({ org, jobs: 0 });
  // When the control plane goes, a Secret without its listener, but
  // `--org`'s, may name an org whose removal an earlier run didn't finish.
  // It isn't signed in for, since a Secret's name alone may not be an
  // org's; `unfinished` names them, and the run fails on them. Only `--org`
  // with no listener, as for an install that never ran one per org, makes
  // them a note: such a Secret's name says too little.
  const unfinished = !whole
    ? []
    : (await api.listSecrets())
        .filter(
          ({ name }) =>
            orgOfListener(name) &&
            name !== (org && listenerName(org)) &&
            !listeners.some((listener) => listener.name === name),
        )
        .map(({ name }) => orgOfListener(name)!);
  // The hosted API's connections name the clouds and hold the cache
  // buckets; they go with it at step 4. Without them every cloud's identity
  // cleanup runs: one that doesn't exist is only reported.
  const connections = await listConnections(run, clusterId).catch(
    () => undefined,
  );
  const leftovers = !whole
    ? new Map<Cloud, Leftover>()
    : (connections ?? everyCloud(deps.env, clusterId));
  const deleteBucket =
    whole && (await bucketDecision(options, deps, clusterId));
  return {
    url,
    clusterId,
    api,
    exec,
    orgs,
    unfinished,
    unfinishedNoteOnly: !!org && !listeners.length,
    whole,
    connections,
    leftovers,
    deleteBucket,
  };
}

// A token for the GitHub cleanup with at least 30 minutes left, re-minted
// with the cleanup's ID after a long drain rather than a second sign-in,
// with the installs live then.
async function cleanupTokenNow(cleanup: Cleanup, deps: UninstallDeps) {
  const left = Date.parse(cleanup.expires_at ?? '') - Date.now();
  if (!cleanup.token || !cleanup.cleanup_id || left > 30 * 60_000)
    return cleanup;
  return refreshCleanupToken(
    cleanup.cleanup_id,
    workerDeps(deps, deps.ui.print),
  );
}

// One org, in order (owner, 2026-11-06): an admin's sign-in for the
// cleanup token, which comes first so a refused one changes nothing; the
// listener's drain, then its VM, service and Secret, so
// nothing registers the scale sets again; backmesh's GitHub side; then the
// App's installation.
async function removeOrg(
  { org, listener, installKey }: Org,
  plane: ControlPlane | undefined,
  clusterId: string | undefined,
  deps: UninstallDeps,
  keepApp = false,
): Promise<
  UninstallResult['orgs'][number] | { skipped: string; left?: string }
> {
  const { ui } = deps;
  const worker = workerDeps(deps, ui.print);
  // Without a key, as when install failed before its listener started, the
  // Worker refuses the sign-in while another install of the org is live.
  // When this machine's control plane goes, only the org's GitHub side is
  // skipped: the control plane is deleted all the same.
  let cleanup: Cleanup | undefined;
  let refused: LiveInstalls | undefined;
  try {
    cleanup = await signInForCleanup(org, installKey, worker);
  } catch (error) {
    if (!(plane?.whole && error instanceof LiveInstalls)) throw error;
    refused = error;
  }
  const login = cleanup?.org.login ?? org;
  // A refused cleanup names no org ID: GitHub's, which a rate limit can
  // stop, costs only the cache buckets, never the control plane's deletion.
  const orgId =
    cleanup?.org.id ??
    (await readOrgId(org, deps.fetch, deps.env).catch((error: unknown) => {
      ui.print(
        `${error instanceof Error ? error.message : String(error)} So ${org}'s cache buckets (named bm-cache-<id>-<region>) weren't deleted with this install; delete them in each cloud's console.`,
      );
      return undefined;
    }));
  // This org's runner groups on this control plane (`isOurRunnerGroup`).
  const tag =
    clusterId && orgId !== undefined ? installTag(clusterId, orgId) : undefined;
  const groups = tag ? `backmesh-${tag}-*` : 'backmesh-*-*';
  if (plane) {
    // An org's other listener VMs go before the drain, so none takes a job
    // or registers the scale sets again meanwhile.
    if (listener?.vm.others.length)
      await terminateVms(plane.api, deps, listener.vm.others);
    // A lost VM's listener can't drain: its org's runners are stopped
    // instead.
    const lost = !!listener?.vm.lost;
    if (listener && !lost) await drainListener(deps, plane.exec, listener);
    if (lost && tag) await stopRunners(plane, deps, sessionOf(tag));
    await removeListener(org, listener, plane.api, deps);
    // With the runners drained, no mint names a cache bucket, and the
    // runners' cache Secrets the listener didn't get to are orphans.
    if (tag) {
      await deleteCacheBuckets(plane.api, tag, plane.connections, ui.print);
      for (const { name } of await plane.api.listSecrets({})) {
        if (name.startsWith(`_bm-cache-bm${tag}-`))
          await deps.run(['secrets', 'delete', name]).catch(() => undefined);
      }
    }
  }
  // Refused: with no listener ever run, nothing of this install is at
  // GitHub; a listener's runner groups are left for the org's owner to
  // delete, as `uninstall --org` would remove the App a live install uses.
  if (refused) {
    const live = `${refused.live.length === 1 ? 'install' : 'installs'} ${refused.live.map((l) => `${l.install} (last token ${l.last_token_at})`).join(', ')} of ${login} ${refused.live.length === 1 ? 'is' : 'are'} live`;
    if (listener) {
      return {
        skipped: login,
        left: `backmesh.com refused ${login}'s GitHub cleanup without this install's key while ${live}. This machine's control plane and its cloud side are deleted; delete this install's runner groups ${groups} and their runners in ${login}'s Actions settings.`,
      };
    }
    ui.print(
      `No listener of this install ever ran, so nothing of it is at ${login}'s GitHub. backmesh.com refused a GitHub cleanup without its key while ${live}, whose runners and App stay.`,
    );
    return { skipped: login };
  }
  const { token, live = [] } = await cleanupTokenNow(cleanup!, deps);
  // Another install of the org is live: only this one's part goes.
  const installOnly = live.length > 0;
  if (token) {
    const remaining = await removeFromGitHub(login, token, {
      tag,
      installOnly,
      print: ui.print,
      fetch: deps.fetch,
      sleep: deps.sleep,
      pollMs: deps.pollMs,
    });
    if (remaining.length) {
      throw new Error(
        `GitHub still lists ${remaining.join(', ')} in ${login}. The cloud side wasn't deleted; run \`backmesh uninstall --org ${login}\` again.`,
      );
    }
    ui.print(
      `Removed backmesh's scale sets, runners and runner groups ${groups} from ${login}.`,
    );
  } else {
    ui.print(
      `The backmesh GitHub App isn't installed on ${login}, so backmesh can't reach its runners there. Check the org's Actions settings for runner groups ${groups}.`,
    );
  }
  if (installOnly) {
    ui.print(
      `The backmesh GitHub App and the org's other backmesh runners stay on ${login} for ${live.length === 1 ? 'install' : 'installs'} ${live.map((l) => `${l.install} (last token ${l.last_token_at})`).join(', ')}, which got a token in the last hour. If ${live.length === 1 ? 'its control plane is' : 'their control planes are'} gone too, run \`backmesh uninstall --org ${login}\` an hour after the latest token to remove them.`,
    );
  }
  // No cleanup to finish when the App isn't on the org, nor while another
  // install uses it.
  const app =
    !installOnly &&
    cleanup!.cleanup_id &&
    (await finishCleanup(cleanup!.cleanup_id, worker, keepApp).catch(
      (cause: unknown) => {
        throw new Error(
          `backmesh couldn't remove its GitHub App from ${login}: ${cause instanceof Error ? cause.message : String(cause)}. Run \`backmesh uninstall --org ${login}\` again.`,
          { cause },
        );
      },
    ));
  if (app) {
    ui.print(
      app.removed
        ? `Removed the backmesh GitHub App from ${login}.`
        : app.still_used_by.length
          ? `The backmesh GitHub App stays on ${login}, which its installs ${app.still_used_by.join(', ')} still use.`
          : `The backmesh GitHub App stays on ${login}, as --keep-app asked.`,
    );
  }
  // Last: the Secret marks an org whose removal a rerun must finish.
  // Secrets are write-only and outlive a deleted VM.
  if (plane) {
    const name = listenerName(org);
    if ((await plane.api.listSecrets()).some((s) => s.name === name)) {
      await deps.run(['secrets', 'delete', name]);
    }
  }
  return { org: login, appRemoved: app ? app.removed : !installOnly };
}

// Step 1 for one org: its listener's VM and service, then a wait until the
// VM is gone. A rerun past the delete finds the service gone or not. The
// Secret stays until the org is finished.
async function removeListener(
  org: string,
  listener: Listener | undefined,
  api: AnycloudApi,
  deps: UninstallDeps,
) {
  const name = listener?.name ?? listenerName(org);
  const control = anycloudControl(api, deps.run);
  const vm = listener?.vm;
  if (vm && !vm.lost) await terminateVms(api, deps, [vm.id]);
  // Idempotent, so a rerun past the VM's end still revokes its token, and
  // an org that never had a service is fine. An anycloud without service
  // tokens never issued one.
  if (
    !missingFeatures(ANYCLOUD_VERSION, ['service-tokens'], deps.features).length
  )
    await control.removeService(name);
}

// Terminates listener VMs and waits until each has ended.
async function terminateVms(
  api: AnycloudApi,
  deps: UninstallDeps,
  ids: readonly string[],
) {
  for (const id of ids) await deps.run(['terminate', id]);
  await poll(
    deps,
    // Running VMs on their own, so a missing one has really ended.
    () =>
      api.listWorkloads({
        query: {
          workloadType: 'vm',
          stateClass: 'terminatable',
          limit: '1000',
        },
      }),
    (vms) => !vms.some((w) => ids.includes(w.id) && !TERMINAL.has(w.state)),
    ids.length > 1 ? 'the listener VMs to go' : 'the listener VM to go',
  );
}

// One path (owner, 2026-11-06): each org removed from GitHub
// (`removeOrg`), then the cloud side when the control plane answers and
// goes, or a note when it's gone.
export async function uninstall(
  options: UninstallOptions,
  deps: UninstallDeps,
): Promise<UninstallResult> {
  const { ui } = deps;
  if (!options.yes && !ui.confirm) {
    throw new UsageError(
      'uninstall deletes the installation; pass --yes to run it without a terminal.',
    );
  }
  const missing = missingFeatures(
    ANYCLOUD_VERSION,
    ['release-1', 'c26', 'c28'],
    deps.features,
  );
  if (missing.length) {
    throw new Error(
      `This backmesh's control plane (${ANYCLOUD_VERSION}) lacks ${missing.join(', ')}, which uninstall needs.`,
    );
  }
  // Only when the control plane is gone: where its management VM runs.
  const seed = options.controlPlane
    ? parseControlPlane(options.controlPlane)
    : undefined;
  const read = await readControlPlane(options, deps);
  const plane = 'gone' in read ? undefined : read;
  const gone = 'gone' in read ? read : undefined;
  if (gone && seed && !gone.clusterId) {
    throw new UsageError(
      `${gone.gone}, so --control-plane has no cluster ID to delete. Nothing was deleted; run uninstall where the control plane is targeted.`,
    );
  }
  if (gone && !options.org) {
    throw new UsageError(
      `${gone.gone}, so uninstall can't read which orgs it served. Nothing was deleted; pass --org <org> to remove backmesh from that org's GitHub.`,
    );
  }
  const orgs = plane?.orgs ?? [{ org: options.org!, jobs: 0 }];
  const names = orgs.map(({ org }) => org).join(', ') || 'no org';
  const running = orgs.reduce((sum, { jobs }) => sum + jobs, 0);
  // An org's other listener VMs, which status warns about, go too.
  const extra = orgs.flatMap(({ listener }) => listener?.vm?.others ?? []);
  const fail = `${running} running job${running === 1 ? '' : 's'} will fail.${extra.length ? ` The extra listener VM${extra.length === 1 ? '' : 's'} ${extra.join(', ')} ${extra.length === 1 ? 'goes' : 'go'} too.` : ''}`;
  // With the control plane gone, its cloud side goes through the user's
  // cloud CLI, given its cloud and region and the ID its URL names.
  const seedDelete = gone?.clusterId && seed ? gone.clusterId : undefined;
  const deleteBucket =
    !!seedDelete && (await bucketDecision(options, deps, seedDelete));
  const seedArgs = seedDelete
    ? [
        'api',
        'delete',
        seedDelete,
        '--cloud',
        seed!.cloud,
        '--region',
        seed!.region,
      ]
    : [];
  // Before any change: with no deletion flag, the seed's delete checks its
  // guards (the account, a gone or stopped management VM) and only lists
  // what it would delete (`api-utilities.md`, "Delete with the hosted API gone").
  // An installation that is failed or mid-delete, such as an AWS stack whose
  // VM is gone or an earlier run's DELETE_FAILED, is refused only without
  // `--delete-vms`, which the delete below passes; anycloud tells it apart
  // by its message alone (`seed-delete.ts`, guard 1).
  // A wording change in anycloud would refuse these again, never delete
  // more: anycloud should give them their own code.
  let unsettled: string | undefined;
  if (seedDelete) {
    await deps.runLong([...seedArgs, '--json']).catch((cause: unknown) => {
      const found =
        /installation is (?:failed|in-progress) \(([^)]*)\).*--delete-vms/s.exec(
          String(cause),
        );
      if (found) {
        unsettled = found[0].split(';')[0];
        return;
      }
      throw new Error(
        `backmesh won't delete ${seedDelete} through your cloud CLI, so nothing was deleted: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    });
  }
  const what = gone
    ? seedDelete
      ? `${gone.gone}, so uninstall removes backmesh from ${names}'s GitHub, then deletes its control plane and runner VMs${deleteBucket ? ', and its checkpoint bucket,' : ''} in ${seed!.cloud} ${seed!.region} through your cloud CLI.${unsettled ? ` backmesh says the ${unsettled}.` : ''} Continue?`
      : `${gone.gone}, so uninstall removes backmesh from ${names}'s GitHub only and deletes nothing in your clouds. Continue?`
    : plane!.whole
      ? `Uninstall backmesh from ${names} and delete its control plane? ${fail}`
      : `Uninstall backmesh from ${names}? The control plane stays. ${fail}`;
  if (!options.yes && !(await ui.confirm?.(what))) {
    throw new UsageError('Uninstall cancelled; nothing was deleted.');
  }
  ui.print(
    gone
      ? `Uninstalling backmesh from ${names}'s GitHub. ${gone.gone}, so ${seedDelete ? 'its cloud side is deleted through your cloud CLI' : 'nothing in your clouds is deleted'}.`
      : plane!.whole
        ? `Uninstalling backmesh from ${names} and ${plane!.url}. ${fail}`
        : `Uninstalling backmesh from ${names}; the control plane stays. ${fail}`,
  );

  const removed: UninstallResult['orgs'] = [];
  const githubSkipped: string[] = [];
  // What a refused cleanup left at GitHub, which fails the run once the
  // cloud side is deleted.
  const githubLeft: string[] = [];
  const clusterId = plane?.clusterId ?? gone?.clusterId;
  for (const org of orgs) {
    const done = await removeOrg(org, plane, clusterId, deps, options.keepApp);
    if (!('skipped' in done)) removed.push(done);
    else {
      githubSkipped.push(done.skipped);
      if (done.left) githubLeft.push(done.left);
    }
  }

  // An older Worker ignores --keep-app and removes the App anyway; said once
  // the rest is deleted, so the run still fails.
  const keptApp = () => {
    const gone = removed.filter(({ appRemoved }) => appRemoved);
    if (options.keepApp && gone.length) {
      throw new Error(
        `backmesh.com removed its GitHub App from ${gone.map(({ org }) => org).join(', ')} although --keep-app asked to keep it. Everything else was uninstalled; an org owner installs the App again.`,
      );
    }
  };
  if (plane && !plane.whole) {
    keptApp();
    return {
      orgs: removed,
      apiUrl: plane.url,
      clusterId: plane.clusterId,
      cloud: 'kept',
    };
  }
  if (plane) {
    await deleteCloudSide(plane, deps);
    if (!removed.length && !githubSkipped.length) {
      ui.print(
        "No listener named an org, so nothing was removed from GitHub. Run `backmesh uninstall --org <org>` to remove backmesh's runners and App from an org.",
      );
    }
  } else if (seedDelete) {
    printRemaining(
      await deps.runLong([
        ...seedArgs,
        '--delete-vms',
        ...(deleteBucket ? ['--delete-buckets'] : []),
        ...['--confirm', seedDelete, '--json'],
      ]),
      ui.print,
    );
  } else {
    ui.print(
      `${gone!.gone}, so nothing in your clouds was deleted. The control plane's VMs, the runners' VMs, the checkpoint bucket, the cache buckets (named bm-cache-<id>-<region>) and the connections install made may still be there and cost money.${gone!.clusterId ? ` Run uninstall again with --control-plane <cloud>:<region> of its control plane to delete them through your cloud CLI.` : " Delete them in each cloud's console."}`,
    );
  }
  // Without the control plane's connections, what install may have left:
  // our CI's generated identities, or a customer's role setups. A generated
  // identity goes once its connection went with the control plane; one that
  // may still answer keeps it.
  const maybe = !plane;
  const leftovers = plane?.leftovers ?? everyCloud(deps.env, clusterId);
  for (const [cloud, { kind, connection, guessed }] of leftovers) {
    ui.print(
      kind === 'role'
        ? leftoverRole(cloud, maybe)
        : connection && (plane || seedDelete)
          ? await removeIdentity(cloud, connection, deps.command)
          : leftoverIdentity(cloud, connection),
    );
    if (guessed) ui.print(leftoverIdentity(cloud, `bm-${cloud}`));
  }
  if ((plane && !plane.deleteBucket) || (seedDelete && !deleteBucket)) {
    ui.print(
      `The checkpoint bucket is kept, with the control plane's backups. Delete it in your cloud's console once you no longer need them.`,
    );
  }
  // Exits non-zero, so CI fails, while an org may be left at GitHub.
  if (plane?.unfinished.length) {
    const left = plane.unfinished;
    if (plane.unfinishedNoteOnly) {
      ui.print(
        `Secrets left: ${left.map(listenerName).join(', ')} (deleted with the control plane).`,
      );
    } else {
      throw new Error(
        `An earlier uninstall may have stopped before it finished ${left.join(', ')} at GitHub. If ${left.length === 1 ? 'that is an org' : 'those are orgs'}, run ${left.map((o) => `\`backmesh uninstall --org ${o}\``).join(', then ')} to finish.`,
      );
    }
  }
  if (githubLeft.length) throw new Error(githubLeft.join(' '));
  keptApp();
  return {
    orgs: removed,
    ...(githubSkipped.length && { githubSkipped }),
    ...(plane
      ? {
          apiUrl: plane.url,
          clusterId: plane.clusterId,
          cloud: 'deleted' as const,
          checkpointBucket: plane.deleteBucket
            ? ('deleted' as const)
            : ('kept' as const),
        }
      : seedDelete
        ? {
            clusterId: seedDelete,
            cloud: 'deleted' as const,
            checkpointBucket: deleteBucket
              ? ('deleted' as const)
              : ('kept' as const),
          }
        : { cloud: 'skipped' as const }),
  };
}
// Runner VM Jobs the drain left (every org's, or one org's `session`), and
// terminated ones whose VM or checkpoint bucket is still going: only the
// hosted API releases them, so it stays until they're gone. `terminatable`
// lists both.
async function stopRunners(
  plane: ControlPlane,
  deps: UninstallDeps,
  session?: string,
) {
  const runners = async () =>
    (
      await plane.api.listWorkloads({
        query: {
          session: session ?? 'bm-',
          ...(session && { sessionExact: 'true' as const }),
          stateClass: 'terminatable',
          limit: '1000',
        },
      })
    ).filter(
      (job) =>
        job.session?.startsWith('bm-') &&
        (!TERMINAL.has(job.state) || (job.vmCount > 0 && !job.cleanedAt)),
    );
  for (const job of await runners()) {
    if (!TERMINAL.has(job.state)) {
      await plane.api.terminateWorkload({
        params: { id: job.id },
        query: { session: job.session! },
      });
    }
  }
  await poll(deps, runners, (jobs) => !jobs.length, "the runners' VMs to go");
}

// Steps 3-4: the runners once the listener is gone, then the installation
// through its own API, which deletes itself last; the connections go with
// it. With C28, the bucket goes only when confirmed.
async function deleteCloudSide(plane: ControlPlane, deps: UninstallDeps) {
  await stopRunners(plane, deps);
  printRemaining(
    await deps.runLong([
      ...['api', 'delete', plane.clusterId],
      ...(plane.deleteBucket
        ? ['--delete-buckets', '--confirm', plane.clusterId]
        : []),
      '--json',
    ]),
    deps.ui.print,
  );
}
