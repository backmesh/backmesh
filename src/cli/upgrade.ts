// `backmesh upgrade`: the hosted API to this release's
// anycloud and every org's listener to its images, one at a time, each on
// its own VM: it creates a lost one again, moves one still on `bm-control`
// to a VM, and gives one the control plane refuses a new service token.
// There's no `--to`: it moves to the running CLI's own release.
import type { RunAnycloud } from '../anycloud/binary.js';
import { ANYCLOUD_PREVIOUS_VERSION } from '../anycloud/contract.generated.js';
import {
  type AnycloudApi,
  type AnycloudExec,
  type anycloudApi,
  type anycloudExec,
} from '../anycloud/client.js';
import type { FeatureTable } from '../anycloud/features.js';
import { anycloudControl, type AnycloudControl } from '../app/anycloud.js';
import { OVERRIDE } from '../app/override.js';
import { runnerGroupName } from '../github/runner-group.js';
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
import { checkHosted, checkPinned, hostedApi } from './prerequisites.js';
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
  secretValues,
  targetsOf,
  type ListenerIdentity,
  type Roll,
} from './converge.js';
import { STANDBY_ENV } from '../listener/env.js';
import { listenerStatusSchema, tokenRefused } from '../listener/status.js';
import {
  createListenerVm,
  createVm,
  LISTENER_VM_MONTHLY_USD,
  LISTENER_VM_TYPES,
  listenerVmId,
  rollListenerVm,
  startListener,
} from './listener-vm.js';
import type { Cloud } from '../runners/classes.js';
import { keyFrom, type SignInCheck } from './github-sign-in.js';
import {
  clusterIdOf,
  CONTROL_POOL,
  installConnection,
  installTag,
  listenerName,
  orgOfListener,
  readInstallation,
  readOrgId,
  readPublicRepos,
  publicReposWarning,
  type Listener,
  type NodePool,
} from './installation.js';
import { readApiVersion, readListener, type StatusReport } from './status.js';
import {
  classesOf,
  noGpuLine,
  noKvmLine,
  planRegions,
  PUBLIC_REPOS_LINE,
  runnerClouds,
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
  // The release before the pinned anycloud, the oldest a move starts from.
  previous?: string;
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

export async function upgrade(
  deps: UpgradeDeps,
  {
    runners = [],
    plan: planOnly = false,
    planId: agreed,
    yes = false,
    publicRepos,
  }: UpgradeOptions = {},
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
  // changes no runners, and the old listener keeps running on it.
  // Only checks that need no read come before it, and that a backmesh
  // listener is there, read with the API's own client version; a refusal
  // after it leaves the new API with the old listener, which a later upgrade
  // resumes. That holds for an API one release behind, whose listeners the
  // new one's client window still takes; one further back is refused.
  const behind = from !== release.anycloud;
  // A listener keeps working only on an API whose client window holds its
  // own anycloud: the move's from one release back at most.
  const previous = deps.previous ?? ANYCLOUD_PREVIOUS_VERSION;
  if (behind && from !== previous) {
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
  const apiUpgraded = await upgradeApi(from, release.anycloud, deps);
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
  }
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
    orgs: planned.map(({ org, listener, running, changes, classes }) => ({
      org,
      current: fingerprint(running),
      moves: !!listener.deployment,
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
  // Each org's own VM replaces `bm-control`'s one Node, which costs about
  // the same as one: for one org, the move needs no consent, as an image
  // doesn't; for several, the added VMs do (coordinator, 2026-11-18).
  const cloud = installation.pool?.cloudProvider?.toLowerCase() as
    Cloud | undefined;
  const moving = planned.filter((p) => p.listener.deployment);
  if (moving.length && cloud) {
    const type = LISTENER_VM_TYPES[cloud][0]!;
    const usd = LISTENER_VM_MONTHLY_USD[type]!;
    print(
      moving.length === 1
        ? `${moving[0]!.org}'s listener moves from ${CONTROL_POOL} to its own ${type} VM, about $${usd} a month, and ${CONTROL_POOL}, about the same, is deleted.`
        : `${moving.map((p) => p.org).join(', ')}'s listeners move from ${CONTROL_POOL} to ${type} VMs of their own: about $${usd * moving.length} a month in all, instead of ${CONTROL_POOL}'s one Node at about $${usd}, which is deleted.`,
    );
  }
  // A change in the runners needs consent, as several orgs' moves do; a
  // release's images alone don't (owner, 2026-11-08).
  const consent = planned.filter((p) => changed(p.changes));
  const asks = consent.length > 0 || moving.length > 1;
  const what = consent.length
    ? 'changes your runners'
    : 'gives several listeners VMs of their own';
  // What already changed when the user says no.
  const cancelled = (then: string) => {
    const done = [
      ...(apiUpgraded ? ['the control plane updated'] : []),
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
    if (listener.deployment) {
      print(`Moving ${org}'s listener from ${CONTROL_POOL} to its own VM.`);
      await moveToVm(listener, {
        org,
        orgId,
        identity: {
          install: tag,
          // Its runner group keeps its name, so its scale sets stay.
          runnerGroup: runnerGroupName(tag, listener.deployment!.id),
          apiUrl: url,
          apiToken: await control.issueServiceToken(name),
          override,
        },
        next,
        url,
        pool: installation.pool,
        api,
        exec,
        control,
        deps,
      });
      rolled.push({ org, image: release.listenerImage, rolled: true });
      continue;
    }
    // The control plane refuses its token, such as after a restore from an
    // older backup: a new one, which the roll writes.
    const apiToken =
      tokenRefused(running.status.anycloud) || !running.apiToken
        ? await control.rotateServiceToken(name)
        : undefined;
    // install.ts's re-run has its own roll condition (no image change to
    // weigh, since it refuses a listener on another release first); keep
    // both in step (converge.ts).
    // A listener left in standby by a move that stopped after its
    // Deployment's delete takes jobs only once rolled without it.
    const roll =
      running.standby ||
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
        vm: listener.vm!.id,
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
    // The last step of the move that left it in standby.
    if (running.standby) await forgetServiceAccount(control, org, print);
  }
  // `bm-control` once no listener is left on it.
  const left = (await readInstallation(api)).orgs.some((o) => o.deployment);
  if (installation.pool && !left) {
    print(`Deleting ${CONTROL_POOL}, which no listener uses now.`);
    await run(['node-pool', 'delete', installation.pool.id]);
  }
  return {
    controlPlane: { from, to: release.anycloud, upgraded: apiUpgraded },
    listeners: rolled,
    runnerImage: release.runnerImage,
    status: await deps.status(),
  };
}

// Why an org's listener on its VM must start again before upgrade can read
// it: its VM is gone, or it doesn't answer. A Deployment is read where it is.
// The read, when it answered, is the loop's.
async function stalled(
  found: Listener,
  exec: AnycloudExec,
): Promise<{ why?: string; read?: Awaited<ReturnType<typeof readListener>> }> {
  const { vm } = found;
  if (!vm || found.deployment) return {};
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
  const vm = found.vm!;
  const { name } = found;
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

/**
 * Moves an org's listener from its Deployment on `bm-control` to its own VM,
 * in `bm-control`'s cloud and region. The Secret gets the VM's values and the
 * VM is created; its listener starts in standby, which checks its settings
 * and token and takes no jobs, while the Deployment still runs. Only once
 * it answers is the Deployment deleted and the VM's listener restarted to
 * take the jobs, so the org never has two listeners, and a move that fails
 * before then leaves the Deployment running. The ServiceAccount goes last.
 * A rerun after a failure finds the VM made and the Deployment there or
 * not.
 */
async function moveToVm(
  listener: Listener,
  {
    org,
    orgId,
    identity,
    next,
    url,
    pool,
    api,
    exec,
    control,
    deps,
  }: {
    url: string;
    // `bm-control`, where it runs.
    pool: NodePool | undefined;
    org: string;
    orgId: number;
    identity: ListenerIdentity;
    next: Omit<Roll, 'apiToken'>;
    api: AnycloudApi;
    exec: AnycloudExec;
    control: AnycloudControl;
    deps: UpgradeDeps;
  },
) {
  const { name, deployment } = listener;
  const values = secretValues({ org, orgId, identity, ...next });
  await control.saveSecret(name, values);
  const stop = async () => {
    await deps.run(['deployment', 'delete', deployment!.id]);
    for (let i = 0; ; i++) {
      const { deployments } = await api.listDeployments({ query: {} });
      if (!deployments.some((d) => d.id === deployment!.id && !d.deletedAt))
        return;
      if (i === 60) {
        throw new Error(
          `${org}'s Deployment ${deployment!.name} didn't stop; run \`backmesh upgrade\` again.`,
        );
      }
      await (deps.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(
        5000,
      );
    }
  };
  let vm = listener.vm?.lost ? undefined : listener.vm?.id;
  if (!vm) {
    const cloud = pool?.cloudProvider?.toLowerCase() as Cloud | undefined;
    const credentials = cloud && (await connectionOf(cloud, url, deps));
    if (!pool?.region || !cloud || !credentials) {
      throw new Error(
        `${org}'s listener runs on a node pool upgrade can't read; run \`backmesh status\`, then upgrade again.`,
      );
    }
    vm = listenerVmId(identity.install);
    // `bm-control`'s own size, the first, which its region took.
    await createVm(
      org,
      vm,
      {
        cloud,
        region: pool.region,
        credentials,
        vmType: LISTENER_VM_TYPES[cloud][0]!,
      },
      deps.runLong,
    );
  }
  await rollListenerVm(exec, vm, { ...values, [STANDBY_ENV]: '1' });
  const { body } = await answering(exec, { org, vm }, deps.wait);
  const failed = listenerStatusSchema.parse(body).anycloud;
  if (failed) {
    throw new Error(
      `${org}'s listener on ${vm} can't use the control plane (${failed.error}), so its Deployment keeps running; run \`backmesh upgrade\` again.`,
    );
  }
  await stop();
  await rollListenerVm(exec, vm, values);
  await answering(exec, { org, vm }, deps.wait);
  await forgetServiceAccount(control, org, deps.print);
}

// A moved listener's ServiceAccount access entry, inert once its
// Deployment is gone: no Pod holds its token.
const forgetServiceAccount = (
  control: AnycloudControl,
  org: string,
  print: (line: string) => void,
) =>
  control
    .removeServiceAccount(listenerName(org))
    .catch((error: unknown) =>
      print(
        `${org}'s old ${CONTROL_POOL} access entry wasn't removed (${error instanceof Error ? error.message : String(error)}); with its Deployment gone nothing holds its token.`,
      ),
    );

// The connection install made for `cloud` on this control plane.
async function connectionOf(cloud: Cloud, url: string, deps: UpgradeDeps) {
  const listed = JSON.parse(
    await deps.run(['credentials', 'list', '--json']),
  ) as { name: string }[];
  return installConnection(cloud, clusterIdOf(url), listed)?.name;
}
