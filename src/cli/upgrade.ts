// `backmesh upgrade`: the hosted API to this release's
// anycloud and every org's listener to its images, one at a time.
// There's no `--to`: it moves to the running CLI's own release.
import type { RunAnycloud } from '../anycloud/binary.js';
import { ANYCLOUD_PREVIOUS_VERSION } from '../anycloud/contract.generated.js';
import { type AnycloudApi, type anycloudApi } from '../anycloud/client.js';
import type { FeatureTable } from '../anycloud/features.js';
import { anycloudControl } from '../app/anycloud.js';
import type { Compatibility } from '../release/compatibility.js';
import { keyAccepted, waitForApp, workerDeps } from './worker.js';
import { NeedsPlan, PlanChanged, UsageError } from './errors.js';
import { hashPlan, type UpgradePlan } from './plan.js';
import { checkHosted, checkPinned, hostedApi } from './prerequisites.js';
import {
  changed,
  changeLines,
  fingerprint,
  homeOf,
  reorderedOnlyLine,
  rollListener,
  routesJson,
  runnerChanges,
  targetsOf,
} from './converge.js';
import { keyFrom, type SignInScopes } from './github-sign-in.js';
import {
  clusterIdOf,
  installTag,
  orgOfListener,
  readControlPool,
  readOrgId,
} from './installation.js';
import { readApiVersion, readListener, type StatusReport } from './status.js';
import {
  classesOf,
  noKvmLine,
  planRegions,
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
  // For `api upgrade`, `api status --watch` and `deployment upgrade --wait`.
  runLong: RunAnycloud;
  release: () => Promise<Compatibility>;
  status: () => Promise<StatusReport>;
  print: (line: string) => void;
  api?: typeof anycloudApi;
  fetch?: typeof globalThis.fetch;
  features?: FeatureTable;
  // The sign-in's polling wait.
  wait?: (ms: number) => Promise<void>;
  // The scopes GitHub granted a sign-in (`signInScopes`).
  signInScopes?: SignInScopes;
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
  await deps.runLong(['api', 'upgrade']);
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
}

export async function upgrade(
  deps: UpgradeDeps,
  {
    runners = [],
    plan: planOnly = false,
    planId: agreed,
    yes = false,
  }: UpgradeOptions = {},
) {
  const moved = new Set(runnerClouds(runners));
  const { run, print } = deps;
  const release = await deps.release();
  checkPinned(release.anycloud, deps.features);
  const { url, api, as } = await hostedApi(deps, print);
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
  if (behind && !(await readControlPool(as(from))).listeners.length) {
    throw new UsageError(
      `There's no listener on ${url}; run \`backmesh install\`.`,
    );
  }
  const apiUpgraded = await upgradeApi(from, release.anycloud, deps);
  const { listeners } = await readControlPool(api);
  if (!listeners.length) {
    throw new UsageError(
      `There's no listener on ${url}; run \`backmesh install\`.`,
    );
  }
  const worker = workerDeps(deps, print);
  // Every org's listener and its clouds, read and checked before any
  // sign-in, so a refusal changes nothing but an older API's move.
  const read = [];
  for (const listener of listeners) {
    const running = await readListener(run, listener.name).catch(
      () => undefined,
    );
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
    const plan = await classesOf(
      targets,
      catalogs,
      planRegions(multiRegion, { print }),
      home,
      !!running.runners &&
        parseRoutes(running.runners).some((r) => r.public && !r.retiring),
    );
    if (plan.problems.length) {
      throw new Error(
        `This release's classes can't run for ${org}:\n- ${plan.problems.join('\n- ')}`,
      );
    }
    plan.noKvm.forEach((target) =>
      print(
        noKvmLine(target, [...(plan.catalog.get(target.cloud)?.keys() ?? [])]),
      ),
    );
    const before = running.runners ? parseRoutes(running.runners) : [];
    // Classes the release dropped retire: their scale sets drain first.
    const live = new Set(running.status.scaleSets.map((set) => set.label));
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
      current: fingerprint({ ...running, image: listener.image }),
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
  // Only a change in the runners needs consent; a release's images alone
  // don't (owner, 2026-11-08).
  const consent = planned.filter((p) => changed(p.changes));
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
  if (consent.length && !(yes && agreed)) {
    if (yes) {
      throw new UsageError(
        'This upgrade changes your runners: pass --plan-id with --yes. Show the plan and its ID with `backmesh upgrade --plan`.',
      );
    }
    if (!deps.confirm) {
      throw new NeedsPlan(
        'This upgrade changes your runners, which needs your agreement: show the plan with `backmesh upgrade --plan`, then pass --yes --plan-id <id>.',
      );
    }
    if (!(await deps.confirm('Proceed?'))) {
      throw new UsageError(
        apiUpgraded
          ? 'Upgrade cancelled after the control plane updated, with no listener changed; run `backmesh upgrade` again to finish.'
          : 'Upgrade cancelled before anything changed.',
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
      apiUpgraded
        ? 'Upgrade cancelled after the control plane updated, with no listener changed; raise the quotas named above, then run `backmesh upgrade` again.'
        : 'Upgrade cancelled; nothing changed. Raise the quotas named above, then run upgrade again.',
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
          scopesOf: deps.signInScopes,
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
          scopesOf: deps.signInScopes,
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
    const orgId = running.orgId || (await readOrgId(org, deps.fetch));
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
  const control = anycloudControl(api, run);
  // One roll per org, one at a time, loads its Secrets; `Recreate` stops
  // the old Pod before the new one starts. `--secret` replaces the
  // list, so the org's Secret is saved first. A new install key needs the
  // roll too: the listener reads it at start.
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
    // install.ts's re-run has its own roll condition (no image change to
    // weigh, since it refuses a listener on another release first); keep
    // both in step (converge.ts).
    const roll =
      installKey !== running.installKey ||
      listener.image !== release.listenerImage ||
      running.runnerImage !== release.runnerImage ||
      running.runners !== finalRunners;
    rolled.push({ org, image: release.listenerImage, rolled: roll });
    // The listener mints for every route region, so their cache buckets
    // come first; already created or
    // confirmed above, so this only double-checks.
    await ensureCacheBuckets(api, tag, parseRoutes(finalRunners), print);
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
        image: listener.image,
        runnerImage: running.runnerImage,
        runners: running.runners,
        cacheCapGb: running.cacheCapGb,
      },
      {
        image: release.listenerImage,
        runnerImage: release.runnerImage,
        runners: finalRunners,
        installKey,
        // Carried through so an upgrade never silently drops an
        // unfinished `rotate-key` rotation; upgrade itself never
        // sets or clears it.
        rotatingFrom: running.rotatingFrom,
        cacheCapGb: running.cacheCapGb,
      },
      { control, runLong: deps.runLong, again: 'upgrade' },
    );
  }
  return {
    controlPlane: { from, to: release.anycloud, upgraded: apiUpgraded },
    listeners: rolled,
    runnerImage: release.runnerImage,
    status: await deps.status(),
  };
}
