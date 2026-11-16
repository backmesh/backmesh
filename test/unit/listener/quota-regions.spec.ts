import { describe, expect, it } from 'vitest';

import { BOOT_DEADLINE_MS } from '../../../src/listener/failover.js';
import { Quotas } from '../../../src/listener/quota.js';
import type { Route } from '../../../src/listener/routes.js';
import { formatSlow } from '../../../src/listener/status.js';
import {
  skippedRegions,
  type QuotaLimits,
} from '../../../src/runners/quota.js';
import { assigned, ROUTE, setup } from './fakes.js';

// The CI account's us-west-1 sits at AWS's default 5 vCPUs for spot and on
// demand (spike 42582624801): one 8-vCPU runner can't fit.
const EIGHT: Route = {
  ...ROUTE,
  label: 'backmesh-8',
  code: 'a8',
  vcpus: 8,
  regions: ['us-east-2', 'us-west-1'],
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
const REFRESH_MS = 10 * 60_000;

function withLimits(limits: Record<string, QuotaLimits>, routes = [EIGHT]) {
  const q = new Quotas(
    async (_cloud, _credentials, region) => limits[region] ?? {},
    () => undefined,
  );
  return setup(routes, undefined, undefined, undefined, undefined, q);
}

describe('regions skipped for quota', () => {
  it("skips a region whose quota can't fit one runner, and keeps it listed", async () => {
    const env = withLimits({
      'us-east-2': { spot: 512, onDemand: 256 },
      'us-west-1': { spot: 5, onDemand: 5 },
    });
    await flush();
    env.sets[0]!.statistics = assigned(2);
    await env.scaler.reconcile();
    expect(env.anycloud.submitted.map((s) => s.regions)).toEqual([
      ['us-east-2'],
      ['us-east-2'],
    ]);
    expect(env.sets[0]!.route.regions).toEqual(['us-east-2', 'us-west-1']);
    const set = env.scaler.status().scaleSets[0]!;
    expect(formatSlow(set)).toEqual([
      '    us-west-1: spot quota 5 vCPU, under one 8-vCPU runner, skipped; raise L-34B43A08 to use it',
    ]);
  });

  it('uses the region again once a later read shows the quota raised', async () => {
    const limits: Record<string, QuotaLimits> = {
      'us-east-2': { spot: 512 },
      'us-west-1': { spot: 5 },
    };
    const env = withLimits(limits);
    await flush();
    env.sets[0]!.statistics = assigned(1);
    await env.scaler.reconcile();
    expect(env.anycloud.submitted.at(-1)!.regions).toEqual(['us-east-2']);
    limits['us-west-1'] = { spot: 64 };
    env.clock.now += REFRESH_MS;
    env.sets[0]!.statistics = assigned(2);
    // This reconcile starts the read; the next uses it.
    await env.scaler.reconcile();
    await flush();
    env.sets[0]!.statistics = assigned(3);
    await env.scaler.reconcile();
    expect(env.anycloud.submitted.at(-1)!.regions).toEqual([
      'us-east-2',
      'us-west-1',
    ]);
    expect(env.scaler.status().scaleSets[0]!.skipped).toBeUndefined();
  });

  it('starts none when every region is skipped, and says so', async () => {
    const env = withLimits({
      'us-east-2': { spot: 4 },
      'us-west-1': { spot: 5 },
    });
    await flush();
    env.sets[0]!.statistics = assigned(2);
    await env.scaler.reconcile();
    expect(env.anycloud.submitted).toEqual([]);
    expect(env.scaler.status().scaleSets[0]!.skipped).toEqual({
      cloud: 'aws',
      spot: true,
      vcpus: 8,
      all: true,
      regions: [
        { region: 'us-east-2', limit: 4 },
        { region: 'us-west-1', limit: 5 },
      ],
    });
  });

  it('starts nothing for a spot label with every spot region skipped or avoided, never on demand (owner, 2026-11-09)', async () => {
    const SPOT8: Route = { ...EIGHT, onDemand: { label: 'backmesh-od-8' } };
    const OD8: Route = {
      ...EIGHT,
      label: 'backmesh-od-8',
      code: 'b8',
      spot: false,
    };
    const env = withLimits(
      {
        'us-east-2': { spot: 512, onDemand: 256 },
        'us-west-1': { spot: 5, onDemand: 64 },
      },
      [SPOT8, OD8],
    );
    await flush();
    // us-east-2 avoided for spot, us-west-1 skipped for spot.
    for (let i = 0; i < 3; i++) {
      env.scaler.failover.missed({ ...SPOT8, spot: true }, ['us-east-2'], 0);
    }
    env.sets[0]!.statistics = assigned(1);
    env.sets[1]!.statistics = assigned(0);
    await env.scaler.reconcile();
    expect(env.anycloud.submitted).toEqual([]);
    const set = env.scaler.status().scaleSets[0]!;
    expect(set.skipped).toMatchObject({ spot: true, all: false });
    expect(formatSlow(set)).toEqual([
      '    us-west-1: spot quota 5 vCPU, under one 8-vCPU runner, skipped; raise L-34B43A08 to use it',
    ]);
    expect(env.scaler.status().avoided).toEqual([
      expect.objectContaining({ where: 'aws us-east-2 spot' }),
    ]);
    // Status names the avoided region and when it opens again.
    expect(set.avoiding).toEqual({
      regions: ['us-east-2'],
      until: new Date(30 * 60_000).toISOString(),
    });
    // The on-demand label, with every region it fits avoided, keeps
    // starting in them.
    for (let i = 0; i < 3; i++) {
      env.scaler.failover.missed(
        { ...OD8, spot: false },
        ['us-east-2', 'us-west-1'],
        0,
      );
    }
    env.sets[1]!.statistics = assigned(1);
    await env.scaler.reconcile();
    expect(
      env.anycloud.submitted.map((spec) => [
        spec.id.slice(8, 10),
        spec.regions,
      ]),
    ).toEqual([['b8', ['us-east-2', 'us-west-1']]]);
    expect(env.scaler.status().scaleSets[1]!.avoiding).toBeUndefined();
  });

  it("doesn't avoid a route's only region its quota fits", async () => {
    const env = withLimits({
      'us-east-2': { spot: 512 },
      'us-west-1': { spot: 5 },
    });
    await flush();
    env.sets[0]!.statistics = assigned(3);
    await env.scaler.reconcile();
    for (const { id } of env.anycloud.submitted) {
      env.anycloud.setState(id, 'retrying', { spot: true });
      const timeline = await env.anycloud.jobs.timeline(id);
      timeline!.runningAt = null;
      timeline!.refusals = [
        { region: 'us-east-2', diagnosis: 'capacity-exhausted' },
      ];
    }
    env.clock.now = BOOT_DEADLINE_MS;
    await env.scaler.reconcile();
    expect(env.scaler.status().avoided).toBeUndefined();
    expect(env.scaler.status().scaleSets[0]!.slow).toMatchObject({ stuck: 3 });
    // New runners still start there, slowly or not.
    env.sets[0]!.statistics = assigned(4);
    await env.scaler.reconcile();
    expect(env.anycloud.submitted.at(-1)!.regions).toEqual(['us-east-2']);
  });

  it("keeps a spot label's on-demand runners starting in the on-demand window when every on-demand region is avoided", async () => {
    const SPOT8: Route = { ...EIGHT, onDemand: { label: 'backmesh-od-8' } };
    const OD8: Route = {
      ...EIGHT,
      label: 'backmesh-od-8',
      code: 'b8',
      spot: false,
    };
    const q = new Quotas(
      async () => ({ spot: 512, onDemand: 512 }),
      () => undefined,
    );
    const routing = {
      observe: () => undefined,
      onDemand: () => true,
      reclaimed: () => undefined,
      poll: async () => [],
      retried: () => false,
      status: () => ({ waiting: 0, paused: [] }),
    };
    const env = setup(
      [SPOT8, OD8],
      undefined,
      routing,
      undefined,
      undefined,
      q,
    );
    await flush();
    for (let i = 0; i < 3; i++) {
      env.scaler.failover.missed(
        { ...SPOT8, spot: false },
        ['us-east-2', 'us-west-1'],
        0,
      );
    }
    env.sets[0]!.statistics = assigned(1);
    env.sets[1]!.statistics = assigned(0);
    await env.scaler.reconcile();
    expect(env.anycloud.submitted).toEqual([
      expect.objectContaining({
        spot: false,
        regions: ['us-east-2', 'us-west-1'],
      }),
    ]);
    expect(env.scaler.status().scaleSets[0]!.avoiding).toBeUndefined();
  });

  it('stays on spot in the on-demand window when no region fits on demand', async () => {
    const SPOT8: Route = { ...EIGHT, onDemand: { label: 'backmesh-od-8' } };
    const OD8: Route = {
      ...EIGHT,
      label: 'backmesh-od-8',
      code: 'b8',
      spot: false,
    };
    const q = new Quotas(
      async () => ({ spot: 512, onDemand: 5 }),
      () => undefined,
    );
    const routing = {
      observe: () => undefined,
      onDemand: () => true,
      reclaimed: () => undefined,
      poll: async () => [],
      retried: () => false,
      status: () => ({ waiting: 0, paused: [] }),
    };
    const env = setup(
      [SPOT8, OD8],
      undefined,
      routing,
      undefined,
      undefined,
      q,
    );
    await flush();
    env.sets[0]!.statistics = assigned(1);
    env.sets[1]!.statistics = assigned(0);
    await env.scaler.reconcile();
    expect(env.anycloud.submitted).toEqual([
      expect.objectContaining({ spot: true }),
    ]);
    // Status names the on-demand quota it couldn't use.
    expect(env.scaler.status().scaleSets[0]!.skipped).toMatchObject({
      spot: false,
      all: false,
      regions: [
        { region: 'us-east-2', limit: 5 },
        { region: 'us-west-1', limit: 5 },
      ],
    });
  });

  it('records a slow spot runner as stuck when on demand fits no region', async () => {
    const SPOT1: Route = {
      ...EIGHT,
      regions: ['us-east-2'],
      onDemand: { label: 'backmesh-od-8' },
    };
    const OD1: Route = {
      ...SPOT1,
      label: 'backmesh-od-8',
      code: 'b8',
      spot: false,
    };
    const env = withLimits({ 'us-east-2': { spot: 512, onDemand: 5 } }, [
      SPOT1,
      OD1,
    ]);
    await flush();
    env.sets[0]!.statistics = assigned(1);
    env.sets[1]!.statistics = assigned(0);
    await env.scaler.reconcile();
    const [id] = env.anycloud.submitted.map((spec) => spec.id);
    env.anycloud.setState(id!, 'retrying');
    (await env.anycloud.jobs.timeline(id!))!.refusals = [
      { region: 'us-east-2', diagnosis: 'capacity-exhausted' },
    ];
    env.clock.now = 180_000;
    await env.scaler.reconcile();
    expect(env.anycloud.submitted).toHaveLength(1);
    expect(env.scaler.status().scaleSets[0]!.slow).toMatchObject({ stuck: 1 });
  });

  it('records skipped regions before the first statistics, and while scaling down', async () => {
    const env = withLimits({
      'us-east-2': { spot: 4 },
      'us-west-1': { spot: 5 },
    });
    await flush();
    await env.scaler.reconcile();
    expect(env.scaler.status().scaleSets[0]!.skipped).toMatchObject({
      all: true,
    });
  });

  it("records the kind it mints with, not a replacement's", async () => {
    const SPOT8: Route = { ...EIGHT, onDemand: { label: 'backmesh-od-8' } };
    const OD8: Route = {
      ...EIGHT,
      label: 'backmesh-od-8',
      code: 'b8',
      spot: false,
    };
    const env = withLimits(
      {
        'us-east-2': { spot: 512, onDemand: 4 },
        'us-west-1': { spot: 512, onDemand: 4 },
      },
      [SPOT8, OD8],
    );
    await flush();
    env.sets[0]!.statistics = assigned(2);
    env.sets[1]!.statistics = assigned(0);
    await env.scaler.reconcile();
    expect(env.anycloud.submitted.map((spec) => spec.spot)).toEqual([
      true,
      true,
    ]);
    expect(env.scaler.status().scaleSets[0]!.skipped).toBeUndefined();
  });

  it('waits for the first quota reads before the first cycle', async () => {
    let answer: (limits: QuotaLimits) => void = () => undefined;
    const q = new Quotas(
      (_cloud, _credentials, region) =>
        region === 'us-west-1'
          ? new Promise((resolve) => (answer = resolve))
          : Promise.resolve({ spot: 512 }),
      () => undefined,
    );
    const env = setup([EIGHT], undefined, undefined, undefined, undefined, q);
    env.sets[0]!.statistics = assigned(1);
    const cycle = env.scaler.reconcile();
    answer({ spot: 5 });
    await cycle;
    expect(env.anycloud.submitted.at(-1)!.regions).toEqual(['us-east-2']);
  });

  it('gives the on-demand code for an on-demand route, and never skips GCP', async () => {
    const OD: Route = {
      ...EIGHT,
      label: 'backmesh-od-8',
      code: 'b8',
      spot: false,
    };
    const od = withLimits(
      { 'us-east-2': { onDemand: 256 }, 'us-west-1': { onDemand: 5 } },
      [OD],
    );
    await flush();
    od.sets[0]!.statistics = assigned(1);
    await od.scaler.reconcile();
    expect(formatSlow(od.scaler.status().scaleSets[0]!)).toEqual([
      '    us-west-1: on-demand quota 5 vCPU, under one 8-vCPU runner, skipped; raise L-1216C47A to use it',
    ]);

    const GCP: Route = {
      ...EIGHT,
      label: 'backmesh-gcp-8',
      code: 'g8',
      cloud: 'gcp',
      regions: ['us-central1', 'us-east4'],
    };
    // Limits under one runner, as if read: never applied to GCP.
    const gcp = withLimits(
      {
        'us-central1': { spot: 1, onDemand: 1 },
        'us-east4': { spot: 1, onDemand: 1 },
      },
      [GCP],
    );
    await flush();
    gcp.sets[0]!.statistics = assigned(1);
    await gcp.scaler.reconcile();
    expect(gcp.anycloud.submitted.at(-1)!.regions).toEqual([
      'us-central1',
      'us-east4',
    ]);
  });
});

describe("install's plan", () => {
  const classes = [2, 4, 8, 16].flatMap((vcpus) =>
    [true, false].map((spot) => ({
      label: `backmesh-${spot ? '' : 'od-'}${vcpus}`,
      vcpus,
      spot,
      regions: ['us-east-2', 'us-west-1'],
    })),
  );

  it('names each region a class is skipped in, with the quota to raise', () => {
    const limits = new Map<string, QuotaLimits>([
      ['us-east-2', { spot: 512, onDemand: 256 }],
      ['us-west-1', { spot: 5, onDemand: 1 }],
    ]);
    expect(skippedRegions('aws', limits, classes)).toEqual([
      'us-west-1: spot quota 5 vCPU, skipped for backmesh-8, backmesh-16; raise L-34B43A08 to use it',
      'us-west-1: on-demand quota 1 vCPU, skipped; raise L-1216C47A to use it',
    ]);
    expect(
      skippedRegions(
        'azure',
        new Map([['westus2', { spot: 3, onDemand: 100 }]]),
        classes.map((c) => ({ ...c, regions: ['westus2'] })),
      ),
    ).toEqual([
      'westus2: spot quota 3 vCPU, skipped for backmesh-4, backmesh-8, backmesh-16; raise "Total Regional Low-priority vCPUs" to use it',
    ]);
    expect(skippedRegions('gcp', limits, classes)).toEqual([]);
  });
});
