import { describe, expect, it } from 'vitest';

import {
  changed,
  changeLines,
  rollListener,
  runnerChanges,
  routesJson,
  targetsOf,
  type RunningListener,
} from '../../../src/cli/converge.js';
import { fakeExec } from './fakes.js';
import { parseRoutes, type Route } from '../../../src/listener/routes.js';
import { planClasses } from '../../../src/runners/classes.js';
import { CATALOG, catalogs } from '../runners/fixtures.js';

const AWS = {
  cloud: 'aws',
  region: 'us-east-2',
  credentials: 'bm-aws',
} as const;
const GCP = {
  cloud: 'gcp',
  region: 'us-central1',
  credentials: 'bm-gcp',
} as const;
const both = planClasses([AWS, GCP], catalogs(), 'aws').classes;
const awsOnly = planClasses(
  [AWS],
  catalogs({ aws: CATALOG.aws }),
  'aws',
).classes;
const running = parseRoutes(JSON.stringify(both));

describe('converge', () => {
  it("diffs the listener's routes against the plan's classes", () => {
    const changes = runnerChanges(running, awsOnly);
    expect(changes).toMatchObject({ added: [], removed: ['gcp'], regions: [] });
    expect(changes.labelsRemoved).toContain('backmesh-gcp-ubuntu-2404-4vcpu');
    expect(changes.labelsAdded).toEqual([]);
    expect(changeLines('acme', changes, awsOnly)).toEqual([
      "acme's runners leave gcp.",
      expect.stringMatching(
        /^These labels stop taking jobs: backmesh-gcp-ubuntu-2404-2vcpu, .*\. Jobs GitHub already assigned to them get runners first; their scale sets are deleted once none is left, and a job sent to them later never runs, so move their workflows to another label\.$/,
      ),
    ]);
    expect(changeLines('acme', runnerChanges(running, both), both)).toEqual([
      "No changes: acme's listener already runs this plan.",
    ]);
  });

  it('renames the scale set of a label renamed under the same class code', () => {
    // As v0.6.1 named them.
    const old = running.map((r) => ({
      ...r,
      label: r.label.replace('ubuntu-2404-', '').replace('vcpu', ''),
    }));
    // Each class renames its old scale set, and none retires: two routes
    // can't share a code.
    const live = new Set(old.map((r) => r.label));
    const written = parseRoutes(routesJson(both, old, live));
    expect(written.filter((r) => r.retiring)).toEqual([]);
    expect(
      written.find((r) => r.label === 'backmesh-ubuntu-2404-4vcpu')
        ?.renamedFrom,
    ).toBe('backmesh-4');
    // A rerun before the listener has renamed them keeps the old names, and
    // drops them once it lists the new ones.
    const again = parseRoutes(routesJson(both, written, live));
    expect(again.map((r) => r.renamedFrom)).toEqual(
      written.map((r) => r.renamedFrom),
    );
    const renamed = new Set(both.map((c) => c.label));
    expect(
      parseRoutes(routesJson(both, written, renamed)).some(
        (r) => r.renamedFrom,
      ),
    ).toBe(false);
  });

  it("doesn't flag a label changed when a release only reorders its VM types", () => {
    // Same types, reversed order: a reorder, with nothing added
    // or removed.
    const reordered = running.map((r) =>
      r.label === 'backmesh-gcp-ubuntu-2404-4vcpu'
        ? { ...r, vmTypes: [...r.vmTypes].reverse() }
        : r,
    );
    const changes = runnerChanges(reordered, both);
    expect(changes.labelsChanged).toEqual([]);
    expect(changed(changes)).toBe(false);
  });

  it('keeps a dropped class retiring until its scale set is gone', () => {
    const live = new Set(both.map((c) => c.label));
    const written = parseRoutes(routesJson(awsOnly, running, live));
    const retiring = written.filter((r) => r.retiring);
    expect(retiring.map((r) => r.cloud)).toEqual(retiring.map(() => 'gcp'));
    expect(retiring.length).toBe(both.length - awsOnly.length);
    // A retiring spot class keeps no on-demand twin to route to.
    expect(retiring.some((r) => r.onDemand)).toBe(false);

    // Already retiring: not a change again, and its cloud isn't a target.
    expect(runnerChanges(written, awsOnly).labelsRemoved).toEqual([]);
    expect(targetsOf(written).map((t) => t.cloud)).toEqual(['aws']);

    // A listener that lists none, or only some, of its scale sets yet
    // can't say they're gone.
    for (const partial of [
      new Set<string>(),
      new Set(['backmesh-ubuntu-2404-4vcpu']),
    ]) {
      expect(
        parseRoutes(routesJson(awsOnly, written, partial)).filter(
          (r: Route) => r.retiring,
        ),
      ).toHaveLength(retiring.length);
    }

    // Once the listener lists none of them, the next write drops them.
    const gone = new Set(awsOnly.map((c) => c.label));
    expect(
      parseRoutes(routesJson(awsOnly, written, gone)).some(
        (r: Route) => r.retiring,
      ),
    ).toBe(false);
  });
});

describe('rollListener', () => {
  const RUNNING: RunningListener = {
    name: 'backmesh-acme',
    org: 'acme',
    orgId: 7,
    vm: 'bml-l8u5e-abc123',
    identity: {
      install: 'l8u5e',
      runnerGroup: 'backmesh-l8u5e-k3j9x0',
      apiUrl: 'https://c1.anycloud.sh',
      apiToken: 'acapi_old',
    },
    image: 'listener@1',
    runnerImage: 'runner@1',
    runners: '[]',
  };
  const NEXT = {
    image: 'listener@2',
    runnerImage: 'runner@2',
    runners: '[1]',
    installKey: 'bmk_new',
    apiToken: 'acapi_new',
  };
  // The env file each roll writes, decoded from its command.
  const written = (command: string) =>
    Buffer.from(/printf %s '([^']+)'/.exec(command)![1]!, 'base64').toString();
  const STATUS = JSON.stringify({ code: 200, body: {}, env: {} });

  function setUp(fails: (command: string) => boolean = () => false) {
    const saved: Record<string, string>[] = [];
    const control = {
      saveSecret: async (_: string, values: Record<string, string>) =>
        void saved.push(values),
    };
    const { exec, calls } = fakeExec((_, command) =>
      fails(command)
        ? { code: 1, stdout: '', stderr: 'Error: pull access denied' }
        : STATUS,
    );
    const roll = () =>
      rollListener(RUNNING, NEXT, {
        control,
        exec,
        again: 'upgrade',
        wait: async () => undefined,
      });
    return { saved, calls, roll };
  }

  it('saves the Secret, writes it to the VM, restarts the listener and waits for it', async () => {
    const { saved, calls, roll } = setUp();
    await roll();
    expect(saved).toEqual([
      {
        ORG: 'acme',
        ORG_ID: '7',
        BACKMESH_INSTALL: 'l8u5e',
        BACKMESH_LISTENER_IMAGE: 'listener@2',
        BACKMESH_RUNNER_GROUP: 'backmesh-l8u5e-k3j9x0',
        ANYCLOUD_API_URL: 'https://c1.anycloud.sh',
        ANYCLOUD_API_TOKEN: 'acapi_new',
        BACKMESH_RUNNER_IMAGE: 'runner@2',
        BACKMESH_INSTALL_KEY: 'bmk_new',
        BACKMESH_RUNNERS: '[1]',
      },
    ]);
    expect(calls.map(([id]) => id)).toEqual([RUNNING.vm, RUNNING.vm]);
    expect(written(calls[0]![1])).toBe(
      Object.entries(saved[0]!)
        .map(([k, v]) => `${k}=${v}\n`)
        .join(''),
    );
    expect(calls[1]![1]).toContain('8080/status');
  });

  it('goes back to the old image and runners on a failed roll, keeping the new key and token', async () => {
    const { saved, calls, roll } = setUp((command) =>
      command.includes('printf') ? written(command).includes('@2') : false,
    );
    await expect(roll()).rejects.toThrow(
      "acme's listener's roll to listener@2 failed, and it's back on listener@1. Run upgrade again.",
    );
    expect(saved[1]).toMatchObject({
      BACKMESH_LISTENER_IMAGE: 'listener@1',
      BACKMESH_RUNNER_IMAGE: 'runner@1',
      BACKMESH_RUNNERS: '[]',
      BACKMESH_INSTALL_KEY: 'bmk_new',
      ANYCLOUD_API_TOKEN: 'acapi_new',
    });
    expect(calls).toHaveLength(3);
  });

  it('fails when the restarted listener never answers', async () => {
    const saved: unknown[] = [];
    const { exec, calls } = fakeExec((_, command) =>
      command.includes('8080/status') ? new Error('No such container') : '',
    );
    await expect(
      rollListener(
        RUNNING,
        {
          ...NEXT,
          image: RUNNING.image,
          runnerImage: RUNNING.runnerImage!,
          runners: RUNNING.runners!,
        },
        {
          control: { saveSecret: async () => void saved.push(1) },
          exec,
          wait: async () => undefined,
        },
      ),
    ).rejects.toThrow("acme's listener's roll to listener@1 failed.");
    // One roll and 24 reads: nothing to go back to.
    expect(calls).toHaveLength(25);
  });
});
