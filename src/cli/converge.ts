// What a re-run of `install` or an `upgrade` changes in an org's listener:
// the diff of its runner classes against the plan's, shown in
// the plan, and `rollListener`, the one shared way both commands save the
// org's Secret and roll its listener once they've each separately decided
// to (install.ts and upgrade.ts; one drifted from the other once
// already, so check both when changing either's roll condition).
import { createHash } from 'node:crypto';

import type { RunAnycloud } from '../anycloud/binary.js';
import type { AnycloudControl } from '../app/anycloud.js';
import type { Route } from '../listener/routes.js';
import { RUNNERS_ENV } from '../listener/routes.js';
import {
  where,
  type Cloud,
  type CloudTarget,
  type RunnerClass,
} from '../runners/classes.js';
import { API_URL_ENV, INSTALL_KEY_ENV, ROTATING_FROM_ENV } from './worker.js';
import { LISTENER_CPUS } from './installation.js';
import { CACHE_CAP_ENV } from '../listener/sweep.js';

/** The org's listener as it runs: its Deployment's image and its Secret. */
export interface RunningListener {
  name: string;
  org: string;
  orgId: number;
  image: string;
  runnerImage?: string;
  // `BACKMESH_RUNNERS`, absent before VM Jobs.
  runners?: string;
  // Each repository's cache per region, in GB; absent for the default.
  cacheCapGb?: number;
}

/**
 * What the plan agreed to change from: a re-run's plan ID hashes it, so a
 * listener changed since the plan, by another install or an upgrade, is
 * another plan.
 */
export const fingerprint = (
  running:
    Pick<RunningListener, 'image' | 'runnerImage' | 'runners'> | undefined,
) =>
  running
    ? createHash('sha256')
        .update(
          JSON.stringify([running.image, running.runnerImage, running.runners]),
        )
        .digest('hex')
        .slice(0, 12)
    : null;

export interface RunnerChanges {
  // Clouds whose runners start or stop.
  added: string[];
  removed: string[];
  // Labels whose scale sets start or stop taking jobs.
  labelsAdded: string[];
  labelsRemoved: string[];
  // Labels kept whose VM types or regions change.
  labelsChanged: string[];
  // Per cloud kept, its runner regions added and removed.
  regions: { cloud: string; added: string[]; removed: string[] }[];
}

/** The difference between the listener's routes and the plan's classes. */
export function runnerChanges(
  routes: readonly Route[],
  after: readonly RunnerClass[],
): RunnerChanges {
  // A class already retiring was removed by an earlier run.
  const before = routes.filter((r) => !r.retiring);
  const cloudsOf = (classes: readonly { cloud: string }[]) => [
    ...new Set(classes.map((c) => c.cloud)),
  ];
  const regionsOf = (
    classes: readonly { cloud: string; regions: string[] }[],
    cloud: string,
  ) => [
    ...new Set(
      classes.filter((c) => c.cloud === cloud).flatMap((c) => c.regions),
    ),
  ];
  const [was, now] = [cloudsOf(before), cloudsOf(after)];
  const [labelsWere, labelsNow] = [before, after].map((c) =>
    c.map((r) => r.label),
  ) as [string[], string[]];
  return {
    added: now.filter((c) => !was.includes(c)),
    removed: was.filter((c) => !now.includes(c)),
    labelsAdded: labelsNow.filter((l) => !labelsWere.includes(l)),
    labelsRemoved: labelsWere.filter((l) => !labelsNow.includes(l)),
    labelsChanged: after
      .filter((c) => {
        const was = before.find((r) => r.label === c.label);
        const shape = (r: { vmTypes: string[]; regions: string[] }) =>
          // VM types and regions in any order are the same set: a reorder
          // alone needs no consent. install.ts and
          // upgrade.ts each still decide whether to roll by comparing the
          // routes themselves, not this shape, so a reorder still reaches
          // the listener's Secret.
          JSON.stringify([[...r.vmTypes].sort(), [...r.regions].sort()]);
        return was && shape(was) !== shape(c);
      })
      .map((c) => c.label),
    regions: now
      .filter((c) => was.includes(c))
      .map((cloud) => {
        const [old, next] = [regionsOf(before, cloud), regionsOf(after, cloud)];
        return {
          cloud,
          added: next.filter((r) => !old.includes(r)),
          removed: old.filter((r) => !next.includes(r)),
        };
      })
      .filter((r) => r.added.length || r.removed.length),
  };
}

export const changed = (c: RunnerChanges) =>
  !!(
    c.added.length ||
    c.removed.length ||
    c.labelsAdded.length ||
    c.labelsRemoved.length ||
    c.labelsChanged.length ||
    c.regions.length
  );

/**
 * Whether `changes` needs no consent (a VM type or region reorder alone,
 * `changed()` false) but still rolls, because the routes actually
 * written (`next`) differ from what's running (`running`) — so
 * install.ts and upgrade.ts can tell it apart from a true no-op re-run
 * and print "VM type order updated" instead of "No changes".
 */
export const reorderedOnly = (
  changes: RunnerChanges,
  next: string,
  running: string | undefined,
) => !changed(changes) && next !== running;

/**
 * "VM type order updated; no consent needed." when `reorderedOnly` is
 * true, `org`-prefixed for upgrade.ts's several orgs; undefined
 * otherwise. install.ts and upgrade.ts each print this at two points
 * (the optimistic `--plan` print and the narrowed roll decision), so
 * this is the one place both the check and the line live.
 */
export const reorderedOnlyLine = (
  org: string | undefined,
  changes: RunnerChanges,
  next: string,
  running: string | undefined,
): string | undefined =>
  reorderedOnly(changes, next, running)
    ? `${org ? `${org}'s ` : ''}VM type order updated; no consent needed.`
    : undefined;

/** The plan's lines for `changes`, such as "acme's runners add gcp". */
export function changeLines(
  org: string,
  c: RunnerChanges,
  after: readonly RunnerClass[],
): string[] {
  if (!changed(c))
    return [`No changes: ${org}'s listener already runs this plan.`];
  const lines = [];
  for (const cloud of c.added) {
    const regions = [
      ...new Set(
        after.filter((r) => r.cloud === cloud).flatMap((r) => r.regions),
      ),
    ];
    lines.push(`${org}'s runners add ${where(cloud as never, regions)}.`);
  }
  for (const cloud of c.removed) {
    lines.push(`${org}'s runners leave ${cloud}.`);
  }
  for (const { cloud, added, removed } of c.regions) {
    const parts = [
      ...(added.length ? [`add ${added.join(', ')}`] : []),
      ...(removed.length ? [`leave ${removed.join(', ')}`] : []),
    ];
    lines.push(`${org}'s ${cloud} runners ${parts.join(' and ')}.`);
  }
  if (c.labelsAdded.length) {
    lines.push(`New labels: ${c.labelsAdded.join(', ')}.`);
  }
  if (c.labelsChanged.length) {
    lines.push(`New VM types or regions for: ${c.labelsChanged.join(', ')}.`);
  }
  if (c.labelsRemoved.length) {
    lines.push(
      `These labels stop taking jobs: ${c.labelsRemoved.join(', ')}. Jobs GitHub already assigned to them get runners first; their scale sets are deleted once none is left, and a job sent to them later never runs, so move their workflows to another label.`,
    );
  }
  return lines;
}

export interface Roll {
  image: string;
  runnerImage: string;
  runners: string;
  installKey: string;
  // Like the install key, never rolled back.
  cacheCapGb?: number;
  // Set while `rotate-key` has minted this key to replace another but not
  // yet revoked it; omitted (by every other caller, and by `rotate-key`
  // once revoked) to clear it. Always `next`'s value, kept through a
  // failed roll's restore too, same as `installKey`: unlike the image and
  // the runner fields, neither is ever rolled back, so a rerun can still
  // find it.
  rotatingFrom?: string;
  // The Worker the install key is from, when not production's (the CLI's
  // BACKMESH_API_URL, as an rc's e2e sets for staging).
  apiUrl?: string;
}

/** The Secret's full value set, so every writer (a roll, its restore, and
 * `rotate-key`'s own marker-clearing save, which rolls nothing) builds it
 * the same way. */
export function secretValues({
  org,
  orgId,
  installKey,
  runnerImage,
  runners,
  rotatingFrom,
  cacheCapGb,
  apiUrl,
}: {
  org: string;
  orgId: number;
  installKey: string;
  apiUrl?: string;
  // A listener from before this Secret uses its built-in image.
  runnerImage?: string;
  runners?: string;
  rotatingFrom?: string;
  cacheCapGb?: number;
}): Record<string, string> {
  return {
    ORG: org,
    ORG_ID: String(orgId),
    ...(runnerImage && { BACKMESH_RUNNER_IMAGE: runnerImage }),
    [INSTALL_KEY_ENV]: installKey,
    ...(runners && { [RUNNERS_ENV]: runners }),
    ...(rotatingFrom && { [ROTATING_FROM_ENV]: rotatingFrom }),
    ...(cacheCapGb && { [CACHE_CAP_ENV]: String(cacheCapGb) }),
    ...(apiUrl && { [API_URL_ENV]: apiUrl }),
  };
}

/**
 * Saves the org's Secret with `next` and rolls its listener: `--secret`
 * replaces the list, so the Secret is saved first, and `Recreate` stops the
 * old Pod before the new one starts. A failed roll goes back to the old
 * image and runner fields, keeping `next`'s install key (and `rotatingFrom`,
 * if set), which minting revoked the old one for.
 */
export async function rollListener(
  running: RunningListener,
  next: Roll,
  deps: {
    control: Pick<AnycloudControl, 'saveSecret'>;
    runLong: RunAnycloud;
    // The command to run again, for the failure's message; omitted when the
    // caller's own message already says what to do next.
    again?: string;
  },
) {
  const { name, org, orgId } = running;
  const save = (runnerImage: string | undefined, runners?: string) =>
    deps.control.saveSecret(
      name,
      secretValues({
        org,
        orgId,
        installKey: next.installKey,
        runnerImage,
        runners,
        rotatingFrom: next.rotatingFrom,
        cacheCapGb: next.cacheCapGb,
        apiUrl: next.apiUrl,
      }),
    );
  await save(next.runnerImage, next.runners);
  const rollTo = (image: string) =>
    deps.runLong([
      ...['deployment', 'upgrade', name],
      ...['--image', image, '--secret', name],
      ...['--cpus', LISTENER_CPUS, '--wait'],
    ]);
  // Rotate-key's two calls always roll to the image they're already on,
  // with the same runner image and classes too: there's genuinely nothing
  // to restore, since `running` and `next` name the same target and the
  // restore-save would write the same install key and marker again.
  // Retrying the identical roll would only repeat whatever just failed, so
  // it's skipped, rather than claimed fixed. `upgrade` can still change
  // just the runner image or classes with the listener's own image
  // unchanged, which this must not mistake for a no-op: that still has a
  // real prior state (`running.runnerImage`/`running.runners`) to restore.
  const unchanged =
    next.image === running.image &&
    next.runnerImage === running.runnerImage &&
    next.runners === running.runners &&
    next.cacheCapGb === running.cacheCapGb;
  await rollTo(next.image).catch(async (cause: unknown) => {
    if (unchanged) {
      throw new Error(
        `${org}'s listener's roll to ${next.image} failed.${deps.again ? ` Run ${deps.again} again.` : ''}`,
        { cause },
      );
    }
    const back = await save(running.runnerImage, running.runners)
      .then(() => rollTo(running.image))
      .then(
        () => `it's back on ${running.image}`,
        () => `going back to ${running.image} failed too`,
      );
    throw new Error(
      `${org}'s listener's roll to ${next.image} failed, and ${back}.${deps.again ? ` Run ${deps.again} again.` : ''}`,
      { cause },
    );
  });
}

/**
 * One target per cloud, from the listener's classes, anchored on each
 * cloud's first route's region. The actual runner regions are always
 * `RUNNER_REGIONS` (`regions.ts`), account-allowed, not kept from here.
 */
export function targetsOf(all: readonly Route[]): CloudTarget[] {
  // A retiring class's cloud may be gone.
  const routes = all.filter((r) => !r.retiring);
  const targets = new Map<Cloud, CloudTarget>();
  for (const { cloud, region, credentials } of routes) {
    if (!targets.has(cloud)) targets.set(cloud, { cloud, region, credentials });
  }
  return [...targets.values()];
}

/**
 * The cloud whose labels are plain stays the home cloud (`classLabel`):
 * none when the control plane's cloud has no runners.
 */
export const homeOf = (routes: readonly Route[]) =>
  routes.find((r) => !r.label.startsWith(`backmesh-${r.cloud}-`))?.cloud;

/**
 * The listener's classes as the plan writes them: the new ones, then each
 * one it drops, retiring (`routes.ts`), until the listener has deleted its
 * scale set: `live` is the labels its status still lists.
 */
export function routesJson(
  classes: readonly RunnerClass[],
  before: readonly Route[],
  live: ReadonlySet<string>,
): string {
  const labels = new Set(classes.map((c) => c.label));
  // A listener still setting its scale sets up, which lists only some of
  // the active ones, can't say a retiring one is gone.
  const ready = before.every((r) => r.retiring || live.has(r.label));
  const gone = (label: string) => ready && !live.has(label);
  const retiring = before
    .filter((r) => !labels.has(r.label) && !(r.retiring && gone(r.label)))
    .map(({ onDemand: _, ...route }) => ({ ...route, retiring: true }));
  return JSON.stringify([...classes, ...retiring]);
}
