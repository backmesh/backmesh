import type { Octokit } from '@octokit/rest';

import type { ActionsClient } from '../github/actions-client.js';
import { sleepFor, type Log, type Sleep } from '../github/retry.js';
import { ensureRunnerGroup } from '../github/runner-group.js';
import type { Gate } from './gate.js';
import type { Route } from './routes.js';
import type { Scaler, ScaleSet } from './scaler.js';

const RECONCILE_EVERY_MS = 50_000;
const SESSION_RETRY_MS = 10_000;
const MAX_SETUP_RETRY_MS = 5 * 60_000;

// Each start creates the install's group (`runnerGroupName`), or sets its
// public repositories back to `allowPublic`, with the installation's
// token, and returns the Actions service's ID that scale sets take.
export async function listenerRunnerGroup(
  octokit: Octokit,
  org: string,
  name: string,
  actions: Pick<ActionsClient, 'getRunnerGroupByName'>,
  allowPublic: boolean,
): Promise<number> {
  await ensureRunnerGroup(octokit, org, name, allowPublic);
  const group = await actions.getRunnerGroupByName(name);
  if (!group) {
    throw new Error(
      `The Actions service doesn't list the runner group ${name} yet.`,
    );
  }
  return group.id;
}

export interface ListenerDeps {
  actions: Pick<
    ActionsClient,
    | 'ensureScaleSet'
    | 'createSession'
    | 'deleteSession'
    | 'getMessage'
    | 'acquireJobs'
    | 'deleteMessage'
    | 'getScaleSet'
    | 'deleteScaleSet'
  >;
  // `listenerRunnerGroup`, bound to the installation.
  runnerGroup: () => Promise<number>;
  scaler: Scaler;
  // With `--public-repos`, hears every message before the scaler.
  gate?: Pick<Gate, 'observe'>;
  routes: Route[];
  // The session owner GitHub shows: the Pod's hostname.
  owner: string;
  log: Log;
  sleep?: Sleep;
  // Given the reconcile once the sessions are up, so a cue can start
  // runners between messages.
  reconciler?: (reconcile: () => void) => void;
}

// One long-poll session per scale set, and a reconcile after any message or
// every 50 s, one at a time. Ends when `signal` aborts,
// deleting its sessions so a new listener can open them at once.
export async function runListener(
  deps: ListenerDeps,
  signal: AbortSignal,
): Promise<void> {
  const { scaler, log } = deps;
  const sets = await addScaleSets(deps, signal);
  if (!sets) return;

  let running: Promise<void> | undefined;
  let again = false;
  // The planner's slots start and end between messages, so the next one
  // reconciles too: the 50 s reconcile is too coarse for T3.
  let due: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(due);
    const ms = scaler.nextDue();
    if (ms !== undefined && !signal.aborted)
      due = setTimeout(reconcile, ms + 1);
  };
  const reconcile = () => {
    if (running) {
      again = true;
      return;
    }
    running = (async () => {
      do {
        again = false;
        // A tick that submitted its limit goes again at once.
        const more = await scaler.reconcile().catch((error: unknown) => {
          log({ msg: 'reconcile failed', error: String(error) });
          return false;
        });
        again ||= more;
      } while (again && !signal.aborted);
    })().finally(() => {
      running = undefined;
      arm();
    });
  };
  const timer = setInterval(reconcile, RECONCILE_EVERY_MS);
  deps.reconciler?.(reconcile);
  try {
    await Promise.all(sets.map((set) => poll(deps, set, reconcile, signal)));
  } finally {
    clearInterval(timer);
    await running;
    clearTimeout(due);
  }
}

// The runner group and a scale set per route, retried from 10 s to 5
// minutes, as the installation wait is, so a failure doesn't restart the Pod
// and its loopback server stays up. Undefined once `signal` aborts.
async function addScaleSets(
  deps: ListenerDeps,
  signal: AbortSignal,
): Promise<ScaleSet[] | undefined> {
  const { actions, scaler, log, sleep = sleepFor } = deps;
  for (
    let waitMs = SESSION_RETRY_MS;
    !signal.aborted;
    waitMs = Math.min(waitMs * 2, MAX_SETUP_RETRY_MS)
  ) {
    try {
      const groupId = await deps.runnerGroup();
      const sets: ScaleSet[] = [];
      for (const route of deps.routes) {
        // A retiring class's scale set is never created again: once it's
        // deleted, a restart skips it.
        const scaleSet = route.retiring
          ? await actions.getScaleSet(groupId, route.label)
          : await actions.ensureScaleSet(
              route.label,
              groupId,
              route.replaceScaleSetId,
            );
        if (!scaleSet) {
          log({ msg: 'retired scale set gone', label: route.label });
          continue;
        }
        log({
          msg: 'scale set ready',
          scaleSetId: scaleSet.id,
          name: scaleSet.name,
          runnerGroupId: scaleSet.runnerGroupId,
        });
        sets.push(scaler.add(route, scaleSet.id));
      }
      return sets;
    } catch (error) {
      log({
        msg: 'runner group or scale sets failed; retrying',
        retryInMs: waitMs,
        error: String(error),
      });
      await sleep(waitMs, signal).catch(() => undefined);
    }
  }
  return undefined;
}

// A retiring scale set goes once GitHub counts no job assigned to it,
// running or busy: its session's capacity is 0, so GitHub assigns it no new
// job, and the runners of the jobs it already has start and finish as
// usual. So once the assigned count is 0 it stays 0, and no runner can pick
// a job up after the delete. Polling it ends, and the session is deleted on
// the way out.
async function retire(
  { actions, scaler, log }: ListenerDeps,
  set: ScaleSet,
): Promise<boolean> {
  const { statistics } = set;
  if (!set.route.retiring || !statistics) return false;
  if (
    statistics.totalAcquiredJobs ||
    statistics.totalAssignedJobs ||
    statistics.totalRunningJobs ||
    statistics.totalBusyRunners
  ) {
    return false;
  }
  await actions.deleteScaleSet(set.scaleSetId);
  scaler.remove(set);
  log({
    msg: 'scale set retired',
    label: set.route.label,
    scaleSetId: set.scaleSetId,
  });
  return true;
}

async function poll(
  deps: ListenerDeps,
  set: ScaleSet,
  reconcile: () => void,
  signal: AbortSignal,
): Promise<void> {
  const { actions, scaler, log, sleep = sleepFor } = deps;
  while (!signal.aborted) {
    try {
      const session = await actions.createSession(
        set.scaleSetId,
        deps.owner,
        signal,
      );
      // An idle healthy listener otherwise logs nothing, so this line tells a
      // quiet listener from a stalled one.
      log({
        msg: 'session opened',
        label: set.route.label,
        scaleSetId: set.scaleSetId,
      });
      try {
        // A new session carries the statistics, so a restart starts counting
        // at once.
        set.statistics = session.statistics ?? set.statistics;
        if (await retire(deps, set)) return;
        reconcile();
        for (let last = 0; !signal.aborted;) {
          const message = await actions.getMessage(
            session,
            last,
            scaler.capacity(set),
            signal,
          );
          if (!message) continue;
          // Acquire every offered job, choosing none; a retiring
          // scale set takes none.
          const offered = message.jobs.filter(
            (job) => job.messageType === 'JobAvailable' && !set.route.retiring,
          );
          await actions.acquireJobs(
            session,
            offered.map((job) => job.runnerRequestId),
          );
          for (const job of message.jobs) {
            deps.gate?.observe(set.route, job);
            scaler.observe(set, job);
          }
          // After the planner has heard the jobs, so a reconcile between
          // never counts an assigned job and its slot both.
          set.statistics = message.statistics ?? set.statistics;
          // The message's runners don't wait for its delete.
          reconcile();
          await actions.deleteMessage(session, message.messageId);
          last = message.messageId;
          if (await retire(deps, set)) return;
        }
      } finally {
        await actions.deleteSession(session).catch(() => undefined);
      }
    } catch (error) {
      if (signal.aborted) return;
      log({
        msg: 'session failed; reopening',
        label: set.route.label,
        error: String(error),
      });
      await sleep(SESSION_RETRY_MS, signal).catch(() => undefined);
    }
  }
}
