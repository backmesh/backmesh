import { describe, expect, it } from 'vitest';

import {
  codeOf,
  parseRoutes,
  runnerName,
} from '../../../src/listener/routes.js';
import { planClasses } from '../../../src/runners/classes.js';
import { CATALOG, catalogs } from '../runners/fixtures.js';

describe('routes', () => {
  // What install writes for aws:us-east-2 (`planClasses`).
  const { classes } = planClasses(
    [{ cloud: 'aws', region: 'us-east-2', credentials: 'bm-aws' }],
    catalogs({ aws: CATALOG.aws }),
    'aws',
  );
  const json = JSON.stringify(classes);

  it('routes each label to its VM class', () => {
    const routes = parseRoutes(json);
    expect(routes).toHaveLength(18);
    expect(routes[1]).toEqual({
      label: 'backmesh-4',
      code: 'a4',
      cloud: 'aws',
      region: 'us-east-2',
      credentials: 'bm-aws',
      vcpus: 4,
      spot: true,
      kvm: false,
      vmTypes: [
        'm8a.xlarge',
        'm8i.xlarge',
        'm7a.xlarge',
        'm7i.xlarge',
        'm6a.xlarge',
      ],
      regions: ['us-east-2'],
      onDemand: { label: 'backmesh-od-4' },
    });
  });

  it("launches a Secret's route from before regions in its one region", () => {
    const old = classes.map(({ regions: _, ...route }) => route);
    expect(parseRoutes(JSON.stringify(old))[1]?.regions).toEqual(['us-east-2']);
    const two = classes.map((c) => ({
      ...c,
      regions: ['us-east-2', 'us-west-2'],
    }));
    expect(parseRoutes(JSON.stringify(two))[1]?.regions).toEqual([
      'us-east-2',
      'us-west-2',
    ]);
  });

  it('gives each spot route the on-demand label of its size and kind', () => {
    const fours = parseRoutes(json).filter((route) => route.vcpus === 4);
    expect(
      fours.map(({ label, code, onDemand }) => [label, code, onDemand?.label]),
    ).toEqual([
      ['backmesh-4', 'a4', 'backmesh-od-4'],
      ['backmesh-od-4', 'b4', undefined],
      ['backmesh-kvm-4', 'k4', 'backmesh-kvm-od-4'],
      ['backmesh-kvm-od-4', 'l4', undefined],
      // A GPU label's twin is the GPU one, not backmesh-od-4.
      ['backmesh-gpu-t4', 'd4', 'backmesh-gpu-od-t4'],
      ['backmesh-gpu-od-t4', 'e4', undefined],
    ]);
    // A spot class whose on-demand twin is gone keeps no on-demand label.
    const spotOnly = JSON.stringify(classes.filter((c) => c.spot));
    expect(parseRoutes(spotOnly).some((r) => r.onDemand)).toBe(false);
  });

  it('gives a public route no on-demand label', () => {
    const { classes: withPublic } = planClasses(
      [{ cloud: 'aws', region: 'us-east-2', credentials: 'bm-aws' }],
      catalogs({ aws: CATALOG.aws }),
      'aws',
      true,
    );
    const route = parseRoutes(JSON.stringify(withPublic)).find(
      (r) => r.label === 'backmesh-public-4',
    );
    expect(route).toMatchObject({ code: 'c4', public: true, spot: true });
    expect(route?.onDemand).toBeUndefined();
  });

  it('refuses two routes with one code', () => {
    const twice = JSON.stringify([classes[0], { ...classes[0], label: 'x' }]);
    expect(() => parseRoutes(twice)).toThrow('a2');
  });

  it('refuses malformed classes', () => {
    expect(() => parseRoutes('{')).toThrow('BACKMESH_RUNNERS');
    const ibm = JSON.stringify([{ ...classes[0], cloud: 'ibm' }]);
    expect(() => parseRoutes(ibm)).toThrow('BACKMESH_RUNNERS');
    const typeless = JSON.stringify([{ ...classes[0], vmTypes: [] }]);
    expect(() => parseRoutes(typeless)).toThrow('BACKMESH_RUNNERS');
  });

  it('names runners with a fixed-length ID that maps back to its scale set', () => {
    const name = runnerName('abc12', 'a4');

    expect(name).toMatch(/^bmabc12-a4-[0-9a-z]{8}$/);
    expect(codeOf('abc12', name)).toBe('a4');
    expect(codeOf('xyz98', name)).toBeUndefined();
    expect(codeOf('abc12', 'bmabc12-a4-short')).toBeUndefined();
  });
});
