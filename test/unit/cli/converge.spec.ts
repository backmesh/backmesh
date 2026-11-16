import { describe, expect, it } from 'vitest';

import {
  changed,
  changeLines,
  runnerChanges,
  routesJson,
  targetsOf,
} from '../../../src/cli/converge.js';
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
    expect(changes.labelsRemoved).toContain('backmesh-gcp-4');
    expect(changes.labelsAdded).toEqual([]);
    expect(changeLines('acme', changes, awsOnly)).toEqual([
      "acme's runners leave gcp.",
      expect.stringMatching(
        /^These labels stop taking jobs: backmesh-gcp-2, .*\. Jobs GitHub already assigned to them get runners first; their scale sets are deleted once none is left, and a job sent to them later never runs, so move their workflows to another label\.$/,
      ),
    ]);
    expect(changeLines('acme', runnerChanges(running, both), both)).toEqual([
      "No changes: acme's listener already runs this plan.",
    ]);
  });

  it("doesn't flag a label changed when a release only reorders its VM types", () => {
    // Same types, reversed order: a reorder, with nothing added
    // or removed.
    const reordered = running.map((r) =>
      r.label === 'backmesh-gcp-4'
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
    for (const partial of [new Set<string>(), new Set(['backmesh-4'])]) {
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
