// Uninstall's GitHub cleanup and leftovers check: backmesh's scale
// sets, leftover runners and runner group in an org, which `uninstall`
// deletes with its runners-only cleanup token.
import type { ActionsClient } from './actions-client.js';
import { sleepFor, type Log, type Sleep } from './retry.js';
import { LEGACY_RUNNER_GROUP } from './runner-group.js';

// The org-level REST calls, with the cleanup token.
export interface OrgCleanup {
  listRunnerGroups(): Promise<{ id: number; name: string }[]>;
  deleteRunnerGroup(id: number): Promise<void>;
  listRunners(): Promise<{ id: number; name: string }[]>;
  deleteRunner(id: number): Promise<void>;
}

export interface CleanupDeps {
  // The scale sets' names: the runner classes' labels.
  labels: string[];
  actions: Pick<
    ActionsClient,
    'getRunnerGroupByName' | 'getScaleSet' | 'deleteScaleSet'
  >;
  rest: OrgCleanup;
  log: Log;
  sleep?: Sleep;
  pollMs?: number;
}

const POLL_MS = 10_000;
// About 10 minutes: GitHub may keep a terminated runner's registration until
// it sees the job end.
const POLLS = 60;

// Which runners and runner groups are backmesh's, by name.
export interface Ours {
  runner(name: string): boolean;
  group(name: string): boolean;
}

// Retried until step 7's check finds nothing; answers what's still left.
export async function cleanUpGitHub(
  deps: CleanupDeps,
  isOurs: Ours,
): Promise<string[]> {
  const { log, sleep = sleepFor, pollMs = POLL_MS } = deps;
  for (let attempt = 1; ; attempt++) {
    const remaining = await cleanUp(deps, isOurs).catch((error: unknown) => {
      log({ msg: 'GitHub cleanup failed', error: String(error) });
      return [`GitHub cleanup: ${String(error)}`];
    });
    if (!remaining.length || attempt === POLLS) return remaining;
    await sleep(pollMs);
  }
}

// Step 2b: the scale sets, leftover registrations and the runner groups;
// then step 7's check of each. Every attempt reads GitHub afresh, so an
// earlier attempt's deletes count. The scale sets are looked up in
// backmesh's runner groups, as ARC's are, and one goes only if its name is
// the label, so no other group's scale set is touched.
async function cleanUp({ labels, actions, rest }: CleanupDeps, isOurs: Ours) {
  const remaining: string[] = [];
  const groups = async () =>
    (await rest.listRunnerGroups()).filter((g) => isOurs.group(g.name));
  // Also the shared group from before per-install names, whose scale sets
  // a listener from then registered; the group itself stays.
  const names = [...(await groups()).map((g) => g.name), LEGACY_RUNNER_GROUP];
  for (const name of names) {
    const found = await actions.getRunnerGroupByName(name);
    const service = found?.name === name ? found : undefined;
    const scaleSet = async (label: string) => {
      const set = service && (await actions.getScaleSet(service.id, label));
      return set?.name === label ? set : undefined;
    };
    for (const label of labels) {
      const set = await scaleSet(label);
      if (set) await actions.deleteScaleSet(set.id);
      if (set && (await scaleSet(label))) {
        remaining.push(`scale set ${label} in ${name}`);
      }
    }
  }
  const ours = async () =>
    (await rest.listRunners()).filter((r) => isOurs.runner(r.name));
  for (const runner of await ours()) await rest.deleteRunner(runner.id);
  remaining.push(...(await ours()).map((runner) => `runner ${runner.name}`));
  // Only empty groups go: GitHub moves a deleted group's runners to the
  // default group (external).
  if (!remaining.length) {
    for (const group of await groups()) await rest.deleteRunnerGroup(group.id);
  }
  remaining.push(...(await groups()).map((g) => `runner group ${g.name}`));
  return remaining;
}
