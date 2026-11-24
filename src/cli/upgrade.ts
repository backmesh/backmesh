// `backmesh upgrade`: the hosted API to this release's
// anycloud and every org's listener to its images, one at a time, each on
// its own VM: it creates a lost one again, and gives one the control plane
// refuses a new service token.
// There's no `--to`: it moves to the running CLI's own release.
import type { RunAnycloud } from '../anycloud/binary.js';
import {
  type AnycloudApi,
  type AnycloudExec,
  type anycloudApi,
  type anycloudExec,
} from '../anycloud/client.js';
import { ANYCLOUD_PREVIOUS_VERSION } from '../anycloud/contract.generated.js';
import { type FeatureTable, newer } from '../anycloud/features.js';
import { anycloudControl } from '../app/anycloud.js';
import { OVERRIDE } from '../app/override.js';
import type { Compatibility } from '../release/compatibility.js';
import {
  API_URL_ENV,
  GITHUB_APP_ID,
  GITHUB_APPS_FLAG,
  keyAccepted,
  waitForApp,
  workerDeps,
} from './worker.js';
import { z } from 'zod';

import { NeedsPlan, PlanChanged, UsageError } from './errors.js';
import { hashPlan, type UpgradePlan } from './plan.js';
import {
  checkClouds,
  checkHosted,
  checkPinned,
  hostedApi,
  LOGINS,
  regionEnv,
} from './prerequisites.js';
import {
  changed,
  changeLines,
  fingerprint,
  homeOf,
  reorderedOnlyLine,
  answering,
  rollListener,
  routesJson,
  runnerChanges,
  targetsOf,
} from './converge.js';
import { tokenRefused } from '../listener/status.js';
import {
  createListenerVm,
  LISTENER_VM_TYPES,
  listenerVmId,
  startListener,
} from './listener-vm.js';
import type { Cloud, CloudTarget } from '../runners/classes.js';
import type { RunCommand } from '../runners/regions.js';
import { keyFrom, type SignInCheck } from './github-sign-in.js';
import {
  clusterIdOf,
  installConnection,
  installTag,
  orgOfListener,
  readInstallation,
  readOrgId,
  readPublicRepos,
  publicReposWarning,
  type Listener,
} from './installation.js';
import { readApiVersion, readListener, type StatusReport } from './status.js';
import {
  applyRole,
  classesOf,
  keyLine,
  listedAccount,
  noGpuLine,
  noKvmLine,
  planRegions,
  ROLE_SETUP,
  PUBLIC_REPOS_LINE,
  runnerClouds,
  signInRequired,
  SIGNED_IN,
  takesRegions,
} from './install.js';
import { parseRoutes } from '../listener/routes.js';
import { ensureCacheBuckets, withAllowedRegions } from './cache-buckets.js';
import {
  readQuotas,
  readQuotaStatus,
  startsNoRunners,
} from '../runners/quota.js';
import { anycloudRunners } from '../runners/anycloud.js';

export interface UpgradeDeps {
  env: NodeJS.ProcessEnv;
  run: RunAnycloud;
  // Each cloud's own CLI, for the role clouds' sign-in check.
  command: RunCommand;
  // For `api upgrade`, `api status --watch` and `vm --wait`.
  runLong: RunAnycloud;
  release: () => Promise<Compatibility>;
  status: () => Promise<StatusReport>;
  print: (line: string) => void;
  api?: typeof anycloudApi;
  exec?: typeof anycloudExec;
  fetch?: typeof globalThis.fetch;
  features?: FeatureTable;
  // The sign-in's polling wait, and a listener's start.
  wait?: (ms: number) => Promise<void>;
  // The login of a sign-in's user (`signInCheck`).
  signInCheck?: SignInCheck;
  // Undefined without a TTY: upgrade never asks there.
  confirm?: (question: string) => Promise<boolean>;
  // The oldest anycloud a move starts from (OLDEST).
  oldest?: string;
  // The pinned anycloud's previous release (ANYCLOUD_PREVIOUS_VERSION).
  previous?: string;
  // The role setup the pinned anycloud's release window changed.
  roleSetup?: typeof ROLE_SETUP;
}

// The labels whose every runner region's quota is under one runner, from
// the classes upgrade plans and the control plane's quota status, read with
// each cloud's credential there; a retiring label and an unread quota count
// as none.
async function noRunnerLines(
  planned: readonly { org: string; runners: string }[],
  api: AnycloudApi,
) {
  const lines: string[] = [];
  for (const { org, runners } of planned) {
    const routes = parseRoutes(runners).filter((r) => !r.retiring);
    for (const cloud of new Set(routes.map((r) => r.cloud))) {
      const mine = routes.filter((r) => r.cloud === cloud);
      const regions = [...new Set(mine.flatMap((r) => r.regions))];
      const credentials = mine[0]!.credentials;
      const limits = await readQuotas(regions, (region) =>
        readQuotaStatus(api, cloud, credentials, region),
      ).catch(() => undefined);
      if (!limits) continue;
      for (const line of startsNoRunners(cloud, limits, mine)) {
        lines.push(`${org}: ${line}`);
      }
    }
  }
  return lines;
}

// `api status --watch --json` prints one document per read and stops once
// the upgrade isn't `starting` (anycloud `src/cli/commands/api.ts`).
const apiStatusLine = (out: string) =>
  JSON.parse(out.trim().split('\n').at(-1) ?? '{}') as {
    healthy?: boolean;
    release?: {
      upgrade?: { state: string; lastError?: string | null } | null;
    } | null;
  };

// that order. `api upgrade` moves the hosted API to the pinned CLI's
// version after its own pre-upgrade backup; runner VMs, which aren't in the
// cluster, keep running. A failed upgrade leaves the old listener on the old
// API, where it resumes. It's the one call an older API takes from this
// release's client (anycloud's release window), so it comes before any read.
async function upgradeApi(
  from: string,
  to: string,
  deps: UpgradeDeps,
): Promise<boolean> {
  if (from === to) return false;
  deps.print('Upgrading the control plane.');
  await deps.runLong(['api', 'upgrade', GITHUB_APPS_FLAG, GITHUB_APP_ID]);
  const status = apiStatusLine(
    await deps.runLong(['api', 'status', '--watch', '--json']),
  );
  const upgrade = status.release?.upgrade;
  if (!status.healthy || upgrade?.state !== 'running') {
    throw new Error(
      `The control plane upgrade failed: ${upgrade?.lastError ?? upgrade?.state ?? 'not answering'}; run \`backmesh upgrade\` again.`,
    );
  }
  return true;
}

export interface UpgradeOptions {
  // `--runners`: the clouds the runners keep, each with the regions it has
  // unless it's named with regions, which it moves to exactly; a bare cloud
  // keeps them too, as upgrade reads no regions through a cloud CLI. A cloud
  // left out drains, as install's does; clouds are added with install.
  // Without it, every cloud stays.
  runners?: string[];
  // `--plan`: print the plan and its ID, and change nothing.
  plan?: boolean;
  // `--plan-id`: the plan `--yes` agrees to.
  planId?: string;
  yes?: boolean;
  // `--public-repos` or `--no-public-repos`, as install's: adds or drops
  // `backmesh-public-<n>`. Without it, each org keeps what it has.
  publicRepos?: boolean;
}

// The oldest anycloud a move starts from: backmesh v0.5.7's, so a v0.5.7
// install still upgrades in one hop (`api upgrade` skips releases). The
// pinned release's own previous (ANYCLOUD_PREVIOUS_VERSION) is v0.6.0's.
export const OLDEST = '0.1.80';

// From a move past the API's window until each org's listener rolls, the
// old listener's launches and cache tokens are refused.
const PAUSED =
  "Until a `backmesh upgrade` run finishes, an org whose listener hasn't rolled starts no runners: its jobs wait queued at GitHub, and its running jobs keep going without backmesh's cache.";

export async function upgrade(deps: UpgradeDeps, options: UpgradeOptions = {}) {
  const state = { paused: false };
  try {
    return await upgradeOnce(deps, options, state);
  } catch (error) {
    if (state.paused && error instanceof Error) {
      error.message = `${error.message}\n${PAUSED}`;
    }
    throw error;
  }
}

async function upgradeOnce(
  deps: UpgradeDeps,
  {
    runners = [],
    plan: planOnly = false,
    planId: agreed,
    yes = false,
    publicRepos,
  }: UpgradeOptions,
  state: { paused: boolean },
) {
  const moved = new Set(runnerClouds(runners));
  const { run, print } = deps;
  const release = await deps.release();
  checkPinned(release.anycloud, deps.features);
  const { url, api, exec, as } = await hostedApi(deps, print);
  clusterIdOf(url);
  const from = await readApiVersion(url, deps.fetch ?? globalThis.fetch);
  checkHosted(from, release.anycloud, 'upgrade');
  // An older control plane refuses this release's client on every read but
  // `api upgrade`, the version and the token exchange (anycloud's client
  // window: the API's own release and the one before it, `api-version.ts`),
  // so it moves first, before the listeners can be read or planned. It
  // changes no runners, and the old listener keeps running on it, though
  // past the window it starts none until it rolls (PAUSED).
  // Only checks that need no read come before it, and that a backmesh
  // listener is there, read with the API's own client version; a refusal
  // after it leaves the new API with the old listener, which a later upgrade
  // resumes. The new API's window takes only the release before it, so a
  // listener from further back, as 0.1.80's, has its launches and cache
  // tokens refused until upgrade rolls it.
  const behind = from !== release.anycloud;
  const oldest = deps.oldest ?? OLDEST;
  if (behind && newer(oldest, from)) {
    throw new UsageError(
      'This control plane is too old for this backmesh to upgrade; run `backmesh uninstall` with the backmesh release that installed it, then `backmesh install`.',
    );
  }
  if (behind && planOnly) {
    throw new UsageError(
      'This control plane is behind this backmesh, so `--plan` works only after it updates; run `backmesh upgrade`.',
    );
  }
  if (behind && agreed) {
    throw new PlanChanged(
      `Plan ${agreed} can't apply while this control plane is behind this backmesh; run \`backmesh upgrade\` without --plan-id.`,
    );
  }
  const multiRegion = takesRegions(release.anycloud, deps.features);
  // The listeners, by the same rule as below, read with the older API's
  // own client version, so a control plane with none isn't moved.
  if (behind && !(await readInstallation(as(from))).orgs.length) {
    throw new UsageError(
      `There's no listener on ${url}; run \`backmesh install\`.`,
    );
  }
  // The connections whose setup this release changes, read and their
  // clouds' CLIs checked before the API moves: a re-apply that can't run
  // after it would leave the runners' launches denied.
  const setups = await changedConnections(
    as(from),
    clusterIdOf(url),
    oldest,
    release.anycloud,
    deps.roleSetup ?? ROLE_SETUP,
  );
  await checkRoleClouds(setups, deps);
  const pauses = newer(deps.previous ?? ANYCLOUD_PREVIOUS_VERSION, from);
  if (pauses) {
    print(
      "The control plane's update pauses runner starts until each org's listener rolls, below; queued jobs wait at GitHub.",
    );
  }
  const apiUpgraded = await upgradeApi(from, release.anycloud, deps);
  state.paused = pauses;
  const installation = await readInstallation(api);
  if (!installation.orgs.length) {
    throw new UsageError(
      `There's no listener on ${url}; run \`backmesh install\`.`,
    );
  }
  const control = anycloudControl(api, run);
  const worker = workerDeps(deps, print);
  // Every org's listener and its clouds, read and checked before any
  // sign-in, so a refusal changes nothing but an older API's move and a
  // listener started again. A listener that must start again first, as an
  // older API must move first, leaves `--plan` and `--plan-id` nothing to
  // read until a run without them has done that.
  const read = [];
  const revived: string[] = [];
  // Every org's runner clouds, by connection, for their role setup.
  const connections = new Map<string, CloudTarget>();
  for (const found of installation.orgs) {
    const { why, read: first } = await stalled(found, exec);
    if (why && planOnly) {
      throw new UsageError(
        `${orgOfListener(found.name)}'s listener ${why}, so \`--plan\` works only after upgrade starts it again; run \`backmesh upgrade\`, which does that before it plans anything.`,
      );
    }
    if (why && agreed) {
      throw new PlanChanged(
        `Plan ${agreed} can't apply while ${orgOfListener(found.name)}'s listener ${why}; run \`backmesh upgrade\` without --plan-id.`,
      );
    }
    const listener = why ? await revive(found, url, exec, deps) : found;
    if (why) revived.push(orgOfListener(found.name)!);
    const running =
      first ?? (await readListener(exec, listener).catch(() => undefined));
    if (!running) {
      throw new Error(
        `${orgOfListener(listener.name)}'s listener didn't answer, so upgrade can't read its install key. Run \`backmesh status\`, then upgrade again.`,
      );
    }
    const { org } = running;
    // A listener from before VM Jobs has no classes, and `install` doesn't
    // replace an org's listener.
    const routes = running.runners ? parseRoutes(running.runners) : [];
    const all = targetsOf(routes);
    const targets = moved.size ? all.filter((t) => moved.has(t.cloud)) : all;
    if (!all.length) {
      throw new UsageError(
        `${org}'s listener has no labels, so it's from before VM Jobs. Run \`backmesh uninstall\`, then \`backmesh install\`.`,
      );
    }
    const added = [...moved].find(
      (cloud) => !all.some((t) => t.cloud === cloud),
    );
    if (added) {
      throw new UsageError(
        `${org}'s runners don't use ${added}: \`backmesh install\` adds a cloud.`,
      );
    }
    const home = homeOf(routes);
    read.push({ listener, running, org, targets, home });
    for (const target of all) {
      if (!connections.has(target.credentials)) {
        connections.set(target.credentials, target);
      }
    }
  }
  // Only the runners' connections: their VM Jobs need the new rights.
  const roles = setups.flatMap(({ credentials, account }) => {
    const target = connections.get(credentials);
    return target && account ? [{ ...target, account }] : [];
  });
  for (const role of roles) {
    const { cloud, credentials, account } = role;
    const { AWS_REGION, AWS_DEFAULT_REGION } = {
      ...deps.env,
      ...regionEnv(role, deps.env),
    };
    const stack =
      cloud === 'aws'
        ? ` (its stack in ${AWS_REGION ?? AWS_DEFAULT_REGION})`
        : '';
    print(
      `${cloud}'s role connection ${credentials} in ${SIGNED_IN[cloud]} ${account}${stack}: upgrade re-applies its setup through your ${LOGINS[cloud][0][0]} CLI, for this release's runner permissions.`,
    );
  }
  for (const key of setups) {
    if (!key.account && connections.has(key.credentials)) {
      print(keyLine(key.cloud, key.credentials));
    }
  }
  if (!planOnly) await reapplyRoles(roles, deps);
  // Each org's classes, planned again with the pinned catalog's types,
  // before any listener changes.
  const catalogs = anycloudRunners(run);
  const planned = [];
  for (const entry of read) {
    const { org, targets, running, home } = entry;
    // `install --public-repos` is kept as its public classes.
    const wasPublic =
      !!running.runners &&
      parseRoutes(running.runners).some((r) => r.public && !r.retiring);
    const isPublic = publicRepos ?? wasPublic;
    const plan = await classesOf(
      targets,
      catalogs,
      planRegions(multiRegion, { print }),
      home,
      isPublic,
    );
    // The public labels are the control plane's cloud's, as install's.
    if (isPublic && !plan.classes.some((c) => c.public)) {
      plan.problems.push(
        "--public-repos needs runners on the control plane's cloud: backmesh-public-2 and -4 run there.",
      );
    }
    if (plan.problems.length) {
      throw new Error(
        `This release's classes can't run for ${org}:\n- ${plan.problems.join('\n- ')}`,
      );
    }
    for (const [targets, line] of [
      [plan.noKvm, noKvmLine],
      [plan.noGpu, noGpuLine],
    ] as const) {
      for (const target of targets) {
        print(
          line(target, [...(plan.catalog.get(target.cloud)?.keys() ?? [])]),
        );
      }
    }
    const before = running.runners ? parseRoutes(running.runners) : [];
    // Classes the release dropped retire: their scale sets drain first.
    const live = new Set(running.status.scaleSets.map((set) => set.label));
    if (isPublic && !wasPublic) print(PUBLIC_REPOS_LINE);
    else if (!isPublic) {
      const repos = await readPublicRepos(org, deps.fetch, deps.env);
      if (repos?.names.length) {
        print(
          publicReposWarning(org, repos, 'backmesh upgrade --public-repos'),
        );
      }
    }
    planned.push({
      ...entry,
      classes: plan.classes,
      changes: runnerChanges(before, plan.classes),
      runners: routesJson(plan.classes, before, live),
    });
  }
  const upgradePlan: UpgradePlan = {
    anycloud: { from, to: release.anycloud },
    images: { runner: release.runnerImage, listener: release.listenerImage },
    roles: roles.map(({ cloud, credentials, account }) => ({
      cloud,
      credentials,
      account,
    })),
    orgs: planned.map(({ org, running, changes, classes }) => ({
      org,
      current: fingerprint(running),
      changes,
      classes: classes.map(({ label, cloud, vmTypes, regions }) => ({
        label,
        cloud,
        vmTypes,
        regions,
      })),
    })),
  };
  const id = hashPlan(upgradePlan);
  // A change in the runners needs consent; a release's images alone don't
  // (owner, 2026-11-08).
  const consent = planned.filter((p) => changed(p.changes));
  const asks = consent.length > 0;
  const what = 'changes your runners';
  // What already changed when the user says no.
  const cancelled = (then: string) => {
    const done = [
      ...(apiUpgraded ? ['the control plane updated'] : []),
      ...(roles.length ? ['the role setup re-applied'] : []),
      ...revived.map((org) => `${org}'s listener started again`),
    ];
    return done.length
      ? `Upgrade cancelled after ${done.join(' and ')}, with no ${revived.length ? 'other ' : ''}listener changed; ${then}`
      : `Upgrade cancelled before anything changed. ${then.charAt(0).toUpperCase()}${then.slice(1)}`;
  };
  for (const { org, changes, classes } of consent) {
    changeLines(org, changes, classes).forEach((line) => print(line));
  }
  // `--plan` ends below, its only chance to say so: for any org that
  // looks like a reorder alone (none in `consent` above, since `changed()`
  // is false for those), print the same line the narrowed check in the
  // roll loop prints for certain later, rather than nothing. Still
  // optimistic, since the account-allowed narrowing below, which needs a
  // signed-in connection this plan doesn't have yet, could turn one into
  // a true no-op; a real run says nothing here and prints once, there.
  if (planOnly) {
    for (const { org, changes, runners, running } of planned) {
      const line = reorderedOnlyLine(org, changes, runners, running.runners);
      if (line) print(line);
    }
  }
  // The labels that would start no runners, in the plan too (owner,
  // 2026-11-09).
  const noRunners = await noRunnerLines(planned, api);
  noRunners.forEach((line) => print(line));
  if (planOnly) return { planId: id, ...upgradePlan };
  if (agreed && agreed !== id) {
    throw new PlanChanged(
      `The plan changed since ${agreed}; it's ${id} now. Show it with \`backmesh upgrade --plan\` and agree to it again.`,
    );
  }
  // `--yes --plan-id` agrees; `--plan-id` alone still asks, as install does.
  if (asks && !(yes && agreed)) {
    if (yes) {
      throw new UsageError(
        `This upgrade ${what}: pass --plan-id with --yes. Show the plan and its ID with \`backmesh upgrade --plan\`.`,
      );
    }
    if (!deps.confirm) {
      throw new NeedsPlan(
        `This upgrade ${what}, which needs your agreement: show the plan with \`backmesh upgrade --plan\`, then pass --yes --plan-id <id>.`,
      );
    }
    if (!(await deps.confirm('Proceed?'))) {
      throw new UsageError(
        cancelled('run `backmesh upgrade` again to finish.'),
      );
    }
  }
  // At a terminal, its own question, no unless yes; `--yes` never asks,
  // as install's doesn't, and without a terminal upgrade goes on, as it
  // does when the runners don't change.
  if (
    noRunners.length &&
    deps.confirm &&
    !yes &&
    !(await deps.confirm(
      `${noRunners.length === 1 ? 'A label' : `${noRunners.length} labels`} would start no runners until a quota is raised. Upgrade anyway?`,
    ))
  ) {
    throw new UsageError(
      cancelled(
        'raise the quotas named above, then run `backmesh upgrade` again.',
      ),
    );
  }
  // Each listener's environment names its org, runner image and install
  // key. Without a key to save, the new listener wouldn't start, so
  // upgrade gets every org's first, before any listener changes.
  const orgs = [];
  for (const { listener, running, org, targets, classes, changes } of planned) {
    let installKey = running.installKey;
    if (!installKey) {
      print(
        `${org}'s installation was made before backmesh's one-time GitHub sign-in, so upgrade asks for it now.`,
      );
      installKey = (
        await keyFrom(org, worker, deps.env, {
          checkOf: deps.signInCheck,
        })
      ).key;
    }
    // A refused key was revoked or replaced: signing in again replaces it.
    if (!(await keyAccepted(installKey, worker))) {
      print(
        `backmesh no longer accepts ${org}'s sign-in, so upgrade asks for it again.`,
      );
      // A key is `bmk_`, the 32-hex install ID, then 32 random hex.
      installKey = (
        await keyFrom(org, worker, deps.env, {
          install: installKey.slice(4, 36),
          checkOf: deps.signInCheck,
        })
      ).key;
      if (!(await keyAccepted(installKey, worker))) {
        throw new Error(
          `backmesh refused ${org}'s new sign-in; upgrade again.`,
        );
      }
    }
    // A listener whose org lost the App couldn't start.
    await waitForApp(org, installKey, worker);
    const orgId = running.orgId || (await readOrgId(org, deps.fetch, deps.env));
    orgs.push({
      listener,
      running,
      org,
      orgId,
      installKey,
      targets,
      classes,
      changes,
    });
  }
  // One roll per org, one at a time. A new install key needs the roll
  // too: the listener reads it at start.
  const rolled = [];
  for (const {
    listener,
    running,
    org,
    orgId,
    installKey,
    targets,
    classes,
    changes,
  } of orgs) {
    const { name } = listener;
    const tag = installTag(clusterIdOf(url), orgId);
    // `RUNNER_REGIONS`, narrowed to the ones this account can actually
    // use, exactly as install.ts does (owner, 2026-11-13): a region a
    // cloud policy or a narrower permission denies drops out, named,
    // with no other change. `--plan` couldn't check this earlier.
    const finalClasses = await withAllowedRegions(
      api,
      tag,
      targets,
      classes,
      new Set(running.status.scaleSets.map((set) => set.label)),
      print,
    );
    const finalRunners = routesJson(
      finalClasses,
      running.runners ? parseRoutes(running.runners) : [],
      new Set(running.status.scaleSets.map((set) => set.label)),
    );
    // The listener mints for every route region, so their cache buckets
    // come first; already created or
    // confirmed above, so this only double-checks.
    await ensureCacheBuckets(api, tag, parseRoutes(finalRunners), print);
    const next = {
      image: release.listenerImage,
      runnerImage: release.runnerImage,
      runners: finalRunners,
      installKey,
      // Carried through so an upgrade never silently drops an
      // unfinished `rotate-key` rotation; upgrade itself never
      // sets or clears it.
      rotatingFrom: running.rotatingFrom,
      cacheCapGb: running.cacheCapGb,
      workerUrl: deps.env[API_URL_ENV],
    };
    const override = running.override ? OVERRIDE : undefined;
    // The control plane refuses its token, such as after a restore from an
    // older backup: a new one, which the roll writes.
    const apiToken =
      tokenRefused(running.status.anycloud) || !running.apiToken
        ? await control.rotateServiceToken(name)
        : undefined;
    // install.ts's re-run has its own roll condition (no image change to
    // weigh, since it refuses a listener on another release first); keep
    // both in step (converge.ts).
    const roll =
      !!apiToken ||
      installKey !== running.installKey ||
      running.image !== release.listenerImage ||
      running.runnerImage !== release.runnerImage ||
      running.runners !== finalRunners;
    rolled.push({ org, image: release.listenerImage, rolled: roll });
    if (!roll) continue;
    const reorderLine = reorderedOnlyLine(
      org,
      changes,
      finalRunners,
      running.runners,
    );
    if (reorderLine) print(reorderLine);
    print(`Rolling ${org}'s listener to ${release.listenerImage}.`);
    // The orgs after a failed roll aren't rolled.
    await rollListener(
      {
        name,
        org,
        orgId,
        vm: listener.vm.id,
        identity: {
          install: tag,
          runnerGroup: z.string().parse(running.runnerGroup),
          apiUrl: url,
          apiToken: running.apiToken ?? '',
          override,
        },
        image: running.image,
        runnerImage: running.runnerImage,
        runners: running.runners,
        cacheCapGb: running.cacheCapGb,
      },
      { ...next, apiToken },
      { control, exec, again: 'upgrade', wait: deps.wait },
    );
  }
  state.paused = false;
  return {
    controlPlane: { from, to: release.anycloud, upgraded: apiUpgraded },
    listeners: rolled,
    runnerImage: release.runnerImage,
    status: await deps.status(),
  };
}

// Why an org's listener on its VM must start again before upgrade can read
// it: its VM is gone, or it doesn't answer. The read, when it answered, is
// the loop's.
async function stalled(
  found: Listener,
  exec: AnycloudExec,
): Promise<{ why?: string; read?: Awaited<ReturnType<typeof readListener>> }> {
  const { vm } = found;
  if (vm.lost) return { why: `VM ${vm.id} is gone` };
  return readListener(exec, found).then(
    (read) => ({ read }),
    () => ({ why: `on ${vm.id} isn't answering` }),
  );
}

/**
 * An org's listener that can answer: a lost VM is created again from the
 * org's Secret, in its cloud and region, and a VM whose listener stopped is
 * started again from its last settings.
 */
async function revive(
  found: Listener,
  url: string,
  exec: AnycloudExec,
  deps: UpgradeDeps,
): Promise<Listener> {
  const { name, vm } = found;
  const org = orgOfListener(name)!;
  if (!vm.lost) {
    deps.print(`Starting ${org}'s listener on ${vm.id} again.`);
    await startListener(exec, org, vm.id);
    await answering(exec, { org, vm: vm.id }, deps.wait);
    return found;
  }
  const cloud = vm.cloud as Cloud | null;
  const credentials = cloud && (await connectionOf(cloud, url, deps));
  if (!cloud || !vm.region || !credentials) {
    throw new Error(
      `${org}'s listener VM ${vm.id} is gone, and upgrade can't tell where to create another; run \`backmesh uninstall --org ${org}\`, then \`backmesh install\`.`,
    );
  }
  // Its tag is the old VM's, `bml-<tag>-…`.
  const id = listenerVmId(vm.id.slice(4, 9));
  deps.print(
    `${org}'s listener VM ${vm.id} is gone; creating ${id} on ${cloud} ${vm.region}.`,
  );
  // The Secret holds every value the listener reads; the size is the lost
  // VM's, which install read its region offers.
  await createListenerVm(
    org,
    id,
    {
      cloud,
      region: vm.region,
      credentials,
      vmType: vm.vmType ?? LISTENER_VM_TYPES[cloud][0]!,
    },
    { exec, runLong: deps.runLong },
  );
  await answering(exec, { org, vm: id }, deps.wait);
  return { name, vm: { ...vm, id, lost: false } };
}

// The connection install made for `cloud` on this control plane.
async function connectionOf(cloud: Cloud, url: string, deps: UpgradeDeps) {
  const listed = JSON.parse(
    await deps.run(['credentials', 'list', '--json']),
  ) as { name: string }[];
  return installConnection(cloud, clusterIdOf(url), listed)?.name;
}

type Changed = { cloud: Cloud; credentials: string; account?: string };

// This control plane's connection in each cloud whose role setup changed,
// read through the API at its own release: a role connection has its
// account, a key connection (our CI's override) none. Only while the
// release that changed it is past the oldest a move starts from: every run,
// so a re-run retries a re-apply that failed after the API moved.
async function changedConnections(
  api: AnycloudApi,
  clusterId: string,
  oldest: string,
  to: string,
  { since, rights }: typeof ROLE_SETUP,
): Promise<Changed[]> {
  if (!newer(since, oldest) || newer(since, to)) return [];
  const listed = await api.listCredentials({});
  return (Object.keys(rights) as Cloud[]).flatMap((cloud) => {
    const entry = installConnection(cloud, clusterId, listed);
    if (!entry) return [];
    const account = listedAccount(cloud, entry);
    return [{ cloud, credentials: entry.name, account }];
  });
}

// Each role cloud's CLI signed in, and AWS's to the role's account, as
// install checks before it bills. GCP's re-apply names its project itself.
// It's every role connection on the control plane, before upgrade can read
// which are the runners': a control-plane-only cloud's is checked too,
// though only the runners' are re-applied.
async function checkRoleClouds(changed: Changed[], deps: UpgradeDeps) {
  const roles = changed.filter((c) => c.account);
  if (!roles.length) return;
  // sts answers in any region; the stack's is the runners' (reapplyRoles).
  const identities = await checkClouds(
    roles.map(({ cloud }) => ({ cloud, region: 'us-east-1' })),
    deps,
  );
  const aws = roles.find((r) => r.cloud === 'aws');
  const { Account } = JSON.parse(identities.get('aws') ?? '{}') as {
    Account?: string;
  };
  if (aws && Account !== aws.account) {
    throw new UsageError(
      `aws's CLI is signed in to account ${Account ?? 'unknown'}, not ${aws.account}, where ${aws.credentials}'s role is: sign it in to ${aws.account}, then run \`backmesh upgrade\` again.`,
    );
  }
}

// A release's runners can need new permissions, as anycloud 0.1.81's VM Job
// network does, and the control plane serves the role setup that grants
// them, so upgrade re-applies each one right after the control plane moves,
// before any listener rolls, and on every run. anycloud converges the cloud
// side and saves the same connection again. The AWS stack's region is
// install's: the runners' first region, unless the user set one.
async function reapplyRoles(
  roles: (CloudTarget & { account: string })[],
  deps: UpgradeDeps,
) {
  const again =
    "This release's runners need its role setup; run `backmesh upgrade` again.";
  for (const role of roles) {
    const { cloud, account } = role;
    const where = `${SIGNED_IN[cloud]} ${account}`;
    const made = await applyRole(
      role,
      account,
      regionEnv(role, deps.env),
      deps,
    ).catch((error: unknown) => {
      const login = signInRequired(error);
      throw new Error(
        login
          ? `${cloud}'s CLI needs a sign-in to ${where}: run \`${login}\`. ${again}`
          : `${cloud}'s role setup in ${where} wasn't re-applied: ${error instanceof Error ? error.message : String(error)}. ${again}`,
        { cause: error },
      );
    });
    if (made !== account) {
      throw new Error(
        `${cloud}'s CLI re-applied the role setup in ${SIGNED_IN[cloud]} ${made ?? 'unknown'}, not ${account}, where ${role.credentials}'s role is. Sign it in to ${account}. ${again}`,
      );
    }
  }
}
