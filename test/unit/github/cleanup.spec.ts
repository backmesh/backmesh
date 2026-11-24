import { describe, expect, it } from 'vitest';

import {
  cleanUpGitHub,
  type CleanupDeps,
  type OrgCleanup,
} from '../../../src/github/cleanup.js';
import { isOurRunnerGroup } from '../../../src/github/runner-group.js';

const GROUP = 'backmesh-0a1b2-k3j9x0';

// GitHub's side of uninstall's cleanup: the scale sets by name, the runner
// groups and the org's runners. Besides this install's group there are the
// default group, the shared `backmesh` group from before per-install names, and
// another control plane's install of the org. `legacy` puts a pre-K listener's
// scale set in the shared group.
function fakeOrg(runners: string[], { legacy = false } = {}) {
  const calls: string[] = [];
  const left = new Map(runners.map((name, i) => [i + 100, name]));
  const groups = new Map([
    [1, 'Default'],
    [3, GROUP],
    [5, 'backmesh'],
    [6, 'backmesh-zzzzz-000000'],
  ]);
  // By the group's Actions service ID and the label.
  const scaleSets = new Map([['30/backmesh-ubuntu-2404-4vcpu', 1]]);
  if (legacy) scaleSets.set('32/backmesh-ubuntu-2404-4vcpu', 2);
  let sticky = 0;
  let stickySets = 0;
  // What GitHub names the scale set it returns for a label.
  let setName = (label: string) => label;
  const rest: OrgCleanup = {
    listRunnerGroups: async () =>
      [...groups].map(([id, name]) => ({ id, name })),
    deleteRunnerGroup: async (id) => {
      calls.push(`delete group ${id}`);
      groups.delete(id);
    },
    listRunners: async () => [...left].map(([id, name]) => ({ id, name })),
    deleteRunner: async (id) => {
      calls.push(`delete runner ${left.get(id)}`);
      if (sticky > 0) sticky--;
      else left.delete(id);
    },
  };
  const actions: CleanupDeps['actions'] = {
    // The Actions service's ID is the REST one plus 27.
    getRunnerGroupByName: async (name) => {
      const id = [...groups].find(([, g]) => g === name)?.[0];
      return id === undefined ? undefined : { id: id + 27, name };
    },
    getScaleSet: async (runnerGroupId, name) => {
      const id = scaleSets.get(`${runnerGroupId}/${name}`);
      return id === undefined
        ? undefined
        : { id, name: setName(name), runnerGroupId };
    },
    deleteScaleSet: async (id) => {
      calls.push(`delete scale set ${id}`);
      if (stickySets > 0) stickySets--;
      else {
        for (const [key, set] of scaleSets) {
          if (set === id) scaleSets.delete(key);
        }
      }
    },
  };
  return {
    rest,
    actions,
    calls,
    // The next deletes leave the runner listed, as GitHub can until it sees
    // a terminated runner's job end.
    keepRunners: (count: number) => (sticky = count),
    keepScaleSets: (count: number) => (stickySets = count),
    nameScaleSets: (name: typeof setName) => (setName = name),
  };
}

const deps = (org: ReturnType<typeof fakeOrg>): CleanupDeps => ({
  labels: ['backmesh-ubuntu-2404-4vcpu'],
  actions: org.actions,
  rest: org.rest,
  log: () => undefined,
  sleep: async () => undefined,
});
const ours = {
  runner: (name: string) => name.startsWith('bm0a1b2-'),
  group: isOurRunnerGroup('0a1b2'),
};

describe('GitHub cleanup', () => {
  it('deletes the scale sets by name, our runners, then the empty group', async () => {
    const org = fakeOrg(['bm0a1b2-a4-00000000', 'other-runner']);
    expect(await cleanUpGitHub(deps(org), ours)).toEqual([]);
    expect(org.calls).toEqual([
      'delete scale set 1',
      'delete runner bm0a1b2-a4-00000000',
      'delete group 3',
    ]);
  });

  it('reports what GitHub still lists, keeping the group', async () => {
    const org = fakeOrg(['bm0a1b2-a4-00000000']);
    org.keepRunners(60);
    expect(await cleanUpGitHub(deps(org), ours)).toEqual([
      'runner bm0a1b2-a4-00000000',
      `runner group ${GROUP}`,
    ]);
    expect(org.calls).not.toContain('delete group 3');
  });

  it('retries until GitHub lets the runner go', async () => {
    const org = fakeOrg(['bm0a1b2-a4-00000000']);
    org.keepRunners(4);
    expect(await cleanUpGitHub(deps(org), ours)).toEqual([]);
    expect(org.calls.filter((c) => c.startsWith('delete runner'))).toHaveLength(
      5,
    );
    expect(org.calls.at(-1)).toBe('delete group 3');
  });

  it('keeps the runner group while a scale set remains', async () => {
    const org = fakeOrg([]);
    org.keepScaleSets(60);
    expect(await cleanUpGitHub(deps(org), ours)).toEqual([
      `scale set backmesh-ubuntu-2404-4vcpu in ${GROUP}`,
      `runner group ${GROUP}`,
    ]);
    expect(org.calls.filter((c) => !c.startsWith('delete scale set'))).toEqual(
      [],
    );
  });

  it("leaves a scale set whose name isn't the label", async () => {
    const org = fakeOrg([]);
    org.nameScaleSets((label) => `${label}-other`);
    expect(await cleanUpGitHub(deps(org), ours)).toEqual([]);
    expect(org.calls).toEqual(['delete group 3']);
  });

  it('deletes a pre-K scale set in the shared group, keeping the group', async () => {
    const org = fakeOrg([], { legacy: true });
    expect(await cleanUpGitHub(deps(org), ours)).toEqual([]);
    expect(org.calls).toEqual([
      'delete scale set 1',
      'delete scale set 2',
      'delete group 3',
    ]);
  });

  it("without the control plane's ID, deletes every install's group but the old shared one", async () => {
    const org = fakeOrg([]);
    const anyInstall = { ...ours, group: isOurRunnerGroup(undefined) };
    expect(await cleanUpGitHub(deps(org), anyInstall)).toEqual([]);
    expect(org.calls).toEqual([
      'delete scale set 1',
      'delete group 3',
      'delete group 6',
    ]);
  });
});
