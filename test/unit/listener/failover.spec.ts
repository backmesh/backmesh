import { describe, expect, it } from 'vitest';

import { BOOT_DEADLINE_MS } from '../../../src/listener/failover.js';
import { Quotas } from '../../../src/listener/quota.js';
import type { Route } from '../../../src/listener/routes.js';
import { RUNNER_CAP } from '../../../src/listener/scaler.js';
import {
  formatSlow,
  listenerStatusSchema,
} from '../../../src/listener/status.js';
import type { QuotaLimits } from '../../../src/runners/quota.js';
import { assigned, message, ROUTE, setup } from './fakes.js';
import type { Planner } from '../../../src/listener/prewarm.js';

// AM's burst: spot launches in us-east-2 refused, so its runner Jobs sat
// `retrying` in anycloud's provisioning backoff, 2.5, 5, then 10 minutes.
const TWO: Route = { ...ROUTE, regions: ['us-east-2', 'us-west-2'] };
const OD: Route = {
  ...ROUTE,
  label: 'backmesh-ubuntu-2404-od-4vcpu',
  code: 'b4',
  spot: false,
};
const SPOT = { ...ROUTE, onDemand: { label: OD.label } };
// `install --on-demand-fallback`'s spot route.
const FALLBACK: Route = { ...SPOT, fallback: true };
const refused = (region: string) => ({
  region,
  diagnosis: 'capacity-exhausted',
});

// A scale set with `n` assigned jobs and their runners minted, then left
// retrying with launches refused in `refusedIn`, `ageMs` after their submit.
// `backedOff`: the regions whose refusal left no untried target, so the Job
// waits anycloud's backoff; by default, every refused one.
async function slowRunners(
  routes: Route[],
  n: number,
  ageMs: number,
  refusedIn: string[] = [],
  backedOff = refusedIn,
) {
  const env = setup(routes);
  env.sets[0]!.statistics = assigned(n);
  await env.scaler.reconcile();
  const slow = env.anycloud.submitted.map((spec) => spec.id);
  for (const id of slow) {
    env.anycloud.setState(id, 'retrying', {
      spot: routes[0]!.spot,
    });
  }
  // The fake's timelines say where each was refused.
  for (const id of slow) {
    const timeline = await env.anycloud.jobs.timeline(id);
    timeline!.runningAt = null;
    timeline!.refusals = refusedIn.map(refused);
    timeline!.backedOff = [...new Set(backedOff)];
  }
  env.clock.now = ageMs;
  return { ...env, slow };
}

const KVM: Route = {
  ...ROUTE,
  label: 'backmesh-ubuntu-2404-kvm-4vcpu',
  code: 'k4',
  kvm: true,
  regions: ['us-west-2'],
};
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('boot deadline', () => {
  it('replaces a runner still retrying at the deadline in another region, then ends it', async () => {
    const env = await slowRunners([TWO], 1, BOOT_DEADLINE_MS, ['us-east-2']);
    await env.scaler.reconcile();
    const [replacement] = env.anycloud.submitted.slice(1);
    expect(replacement).toMatchObject({ spot: true, regions: ['us-west-2'] });
    expect(env.anycloud.terminated).toEqual(env.slow);
    expect(env.github.runners.has(env.slow[0]!)).toBe(false);
    // Its end isn't a startup failure.
    await env.scaler.reconcile();
    expect(env.sets[0]!.backoff.failures).toBe(0);
    const set = env.scaler.status().scaleSets[0]!;
    expect(set.slow).toEqual({
      replaced: 1,
      stuck: 0,
      from: ['us-east-2'],
      to: ['us-west-2'],
    });
    expect(formatSlow(set)).toEqual([
      '    1 runner starting slowly in us-east-2; replaced in us-west-2',
    ]);
  });

  it("leaves a Job waiting its turn in anycloud's own queue, which another region wouldn't help", async () => {
    const env = await slowRunners([TWO], 1, BOOT_DEADLINE_MS);
    env.anycloud.setState(env.slow[0]!, 'queued');
    await env.scaler.reconcile();
    expect(env.anycloud.submitted).toHaveLength(1);
    expect(env.scaler.status().avoided).toBeUndefined();
  });

  // Owner, 2026-11-13: a refused runner fails over past the slowest normal
  // start (67 s to running), not at 3 minutes; one never refused is never
  // replaced, at 3 minutes or later.
  it('replaces a refused runner from 75 s after its submit, and an unrefused one never', async () => {
    const refusedEnv = await slowRunners([TWO], 1, 74_999, ['us-east-2']);
    await refusedEnv.scaler.reconcile();
    expect(refusedEnv.anycloud.submitted).toHaveLength(1);
    refusedEnv.clock.now = 75_000;
    await refusedEnv.scaler.reconcile();
    expect(refusedEnv.anycloud.submitted).toHaveLength(2);

    const env = await slowRunners([TWO], 1, 75_000);
    env.anycloud.setState(env.slow[0]!, 'queued');
    for (const at of [75_000, 180_000, 10 * 60_000]) {
      env.clock.now = at;
      await env.scaler.reconcile();
    }
    expect(env.anycloud.submitted).toHaveLength(1);
    // Refused later, it goes once its cached read is a minute old.
    (await env.anycloud.jobs.timeline(env.slow[0]!))!.refusals = [
      refused('us-east-2'),
    ];
    env.clock.now += 59_999;
    await env.scaler.reconcile();
    expect(env.anycloud.submitted).toHaveLength(1);
    env.clock.now += 1;
    await env.scaler.reconcile();
    expect(env.anycloud.submitted).toHaveLength(2);
  });

  it('replaces a refused Job waiting between its retries, but not while anycloud tries a launch', async () => {
    for (const [state, replaced] of [
      ['retrying', true],
      ['queued', true],
      ['provisioning', false],
    ] as const) {
      const env = await slowRunners([TWO], 1, BOOT_DEADLINE_MS, ['us-east-2']);
      env.anycloud.setState(env.slow[0]!, state);
      await env.scaler.reconcile();
      expect(env.anycloud.submitted).toHaveLength(replaced ? 2 : 1);
    }
  });

  it("doesn't show a region avoided where avoiding changes nothing", async () => {
    const env = await slowRunners([OD], 3, BOOT_DEADLINE_MS, ['us-east-2']);
    await env.scaler.reconcile();
    expect(env.scaler.status().avoided).toBeUndefined();
  });

  it("goes on with other slow runners when one's timeline read fails", async () => {
    const env = await slowRunners([TWO], 2, BOOT_DEADLINE_MS, ['us-east-2']);
    env.anycloud.failNextTimelineReads(1);
    await env.scaler.reconcile();
    expect(env.anycloud.submitted).toHaveLength(3);
  });

  it('waits until the deadline, and replaces each slow runner once', async () => {
    const env = await slowRunners([TWO], 2, BOOT_DEADLINE_MS - 1, [
      'us-east-2',
    ]);
    await env.scaler.reconcile();
    expect(env.anycloud.submitted).toHaveLength(2);
    env.clock.now += 1;
    await env.scaler.reconcile();
    await env.scaler.reconcile();
    expect(env.anycloud.submitted).toHaveLength(4);
    expect(env.anycloud.terminated).toEqual(env.slow);
  });

  it("never replaces a spot runner on demand: a one-region route's slow runners have nowhere to go (owner, 2026-11-09)", async () => {
    for (const routes of [[SPOT, OD], [OD]]) {
      const env = await slowRunners(routes, 1, BOOT_DEADLINE_MS, ['us-east-2']);
      await env.scaler.reconcile();
      expect(env.anycloud.submitted).toHaveLength(1);
      expect(env.anycloud.terminated).toEqual([]);
      expect(formatSlow(env.scaler.status().scaleSets[0]!)).toEqual([
        '    1 runner still retrying a launch 75 s after submit, with no other region to replace it in',
      ]);
    }
  });

  it('with fallback, replaces a one-region spot runner on demand, and its job says it fell back (owner, 2026-11-25)', async () => {
    const env = await slowRunners([FALLBACK, OD], 1, BOOT_DEADLINE_MS, [
      'us-east-2',
    ]);
    await env.scaler.reconcile();
    const replacement = env.anycloud.submitted.at(-1)!;
    expect(replacement).toMatchObject({ spot: false, regions: ['us-east-2'] });
    expect(env.anycloud.terminated).toEqual(env.slow);
    expect(env.logs).toContainEqual(
      expect.objectContaining({
        msg: 'spot refused in every region; replaced on demand',
        runner: env.slow[0],
        replacement: replacement.id,
        label: FALLBACK.label,
      }),
    );
    const fields = { runnerName: replacement.id, result: 'Succeeded' };
    env.scaler.observe(env.sets[0]!, message('JobStarted', fields));
    env.scaler.observe(env.sets[0]!, message('JobCompleted', fields));
    await env.scaler.reconcile();
    expect(env.logs).toContainEqual(
      expect.objectContaining({
        msg: 'job completed',
        runner: replacement.id,
        fallback: true,
      }),
    );
    const set = env.scaler.status().scaleSets[0]!;
    expect(set).toMatchObject({
      fallback: true,
      slow: { replaced: 1, onDemand: 1, stuck: 0 },
      jobs: { day: { fellBack: 1 } },
    });
    expect(formatSlow(set)).toEqual([
      '    1 runner starting slowly in us-east-2; replaced in us-east-2, 1 on demand',
    ]);
    const served = {
      installed: true,
      broker: null,
      ...env.scaler.status(),
    };
    expect(listenerStatusSchema.parse(served)).toEqual(served);
  });

  it('with fallback, replaces on demand a spot replacement refused too, after failing over to the other regions', async () => {
    const env = await slowRunners(
      [{ ...FALLBACK, regions: TWO.regions }, OD],
      1,
      BOOT_DEADLINE_MS,
      ['us-east-2'],
    );
    await env.scaler.reconcile();
    const spot = env.anycloud.submitted.at(-1)!;
    expect(spot).toMatchObject({ spot: true, regions: ['us-west-2'] });
    env.anycloud.setState(spot.id, 'retrying', { spot: true });
    const timeline = (await env.anycloud.jobs.timeline(spot.id))!;
    timeline.runningAt = null;
    timeline.refusals = [refused('us-west-2')];
    env.clock.now += BOOT_DEADLINE_MS;
    await env.scaler.reconcile();
    expect(env.anycloud.submitted.at(-1)).toMatchObject({
      spot: false,
      regions: ['us-east-2', 'us-west-2'],
    });
    expect(env.anycloud.submitted).toHaveLength(3);
  });

  it('with fallback, starts on demand while every spot region is avoided', async () => {
    const env = await slowRunners(
      [{ ...FALLBACK, regions: TWO.regions }, OD],
      3,
      BOOT_DEADLINE_MS,
      ['us-east-2'],
    );
    await env.scaler.reconcile();
    // Their replacements in us-west-2 miss the deadline too.
    for (const spec of env.anycloud.submitted.slice(3)) {
      env.anycloud.setState(spec.id, 'retrying', { spot: true });
      const timeline = (await env.anycloud.jobs.timeline(spec.id))!;
      timeline.runningAt = null;
      timeline.refusals = [refused('us-west-2')];
      timeline.backedOff = ['us-west-2'];
    }
    env.clock.now += BOOT_DEADLINE_MS;
    await env.scaler.reconcile();
    expect(env.scaler.status().avoided?.map((a) => a.where)).toEqual([
      'aws us-east-2 spot',
      'aws us-west-2 spot',
    ]);
    env.sets[0]!.statistics = assigned(4);
    await env.scaler.reconcile();
    expect(env.anycloud.submitted.at(-1)).toMatchObject({ spot: false });
    expect(env.scaler.status().scaleSets[0]!.avoiding).toBeUndefined();
  });

  it('replaces an on-demand runner in its other on-demand regions', async () => {
    const OD2: Route = { ...OD, regions: ['us-east-2', 'us-west-2'] };
    const env = await slowRunners([OD2], 1, BOOT_DEADLINE_MS, ['us-east-2']);
    await env.scaler.reconcile();
    expect(env.anycloud.submitted.at(-1)).toMatchObject({
      spot: false,
      regions: ['us-west-2'],
    });
  });

  it("doesn't fail over the planner's speculative runners, or a job GitHub cancelled", async () => {
    // Two runners for one assigned job: the second is speculative.
    const env = await slowRunners([TWO], 2, BOOT_DEADLINE_MS, ['us-east-2']);
    env.sets[0]!.statistics = assigned(1);
    await env.scaler.reconcile();
    // One replaced, and scale-down removed the other as an extra.
    expect(env.anycloud.submitted).toHaveLength(3);
    expect(env.anycloud.live.size).toBe(1);
    // Cancelled: no job left, so nothing is replaced, and both go.
    const gone = await slowRunners([TWO], 1, 30_000, ['us-east-2']);
    gone.sets[0]!.statistics = assigned(0);
    gone.clock.now = BOOT_DEADLINE_MS;
    await gone.scaler.reconcile();
    expect(gone.anycloud.submitted).toHaveLength(1);
    expect(gone.anycloud.terminated).toEqual(gone.slow);
    expect(gone.scaler.status().scaleSets[0]!.slow).toBeUndefined();
  });

  it('keeps a slow runner that took a job meanwhile, and scale-down removes the extra', async () => {
    const env = await slowRunners([TWO], 1, BOOT_DEADLINE_MS, ['us-east-2']);
    env.github.busy.add(env.slow[0]!);
    await env.scaler.reconcile();
    expect(env.anycloud.submitted).toHaveLength(2);
    expect(env.anycloud.terminated).toEqual([]);
    // The job runs on the slow runner: the replacement is the extra.
    env.anycloud.setState(env.slow[0]!, 'running');
    await env.scaler.reconcile();
    expect(env.anycloud.terminated).toEqual([env.anycloud.submitted[1]!.id]);
  });

  it('retries a failed removal of the replaced Job, never the replacement', async () => {
    const env = await slowRunners([TWO], 1, BOOT_DEADLINE_MS, ['us-east-2']);
    // Both the removal and scale-down's try at the slow one fail.
    env.github.failNextLookups(2);
    await env.scaler.reconcile();
    expect(env.anycloud.submitted).toHaveLength(2);
    expect(env.anycloud.terminated).toEqual([]);
    // Next cycle: no second replacement, and the slow one goes, not the
    // replacement.
    await env.scaler.reconcile();
    expect(env.anycloud.submitted).toHaveLength(2);
    expect(env.anycloud.terminated).toEqual(env.slow);
    await env.scaler.reconcile();
    expect(env.anycloud.terminated).toEqual(env.slow);
    expect(env.anycloud.live.size).toBe(1);
  });

  it('lets scale-down take a slow runner whose own removal failed', async () => {
    const env = await slowRunners([TWO], 1, BOOT_DEADLINE_MS, ['us-east-2']);
    env.github.failNextLookups(1);
    await env.scaler.reconcile();
    expect(env.anycloud.terminated).toEqual(env.slow);
    expect(env.anycloud.live.size).toBe(1);
  });

  it("doesn't count a reclaimed runner's recovery as slow", async () => {
    const env = await slowRunners([TWO], 1, BOOT_DEADLINE_MS);
    env.anycloud.setState(env.slow[0]!, 'recovering');
    await env.scaler.reconcile();
    expect(env.anycloud.submitted).toHaveLength(1);
  });

  it('avoids a region for spot runners for 30 minutes after 3 missed the deadline in it, each backing off there', async () => {
    // Refused with a VM type or zone still untried, which anycloud moves to
    // at once, they're replaced, but the region isn't avoided.
    const untried = await slowRunners(
      [TWO],
      3,
      BOOT_DEADLINE_MS,
      ['us-east-2'],
      [],
    );
    await untried.scaler.reconcile();
    expect(untried.anycloud.submitted).toHaveLength(6);
    expect(untried.scaler.status().avoided).toBeUndefined();
    // Refused in two regions, it counts only where it backed off.
    const THREE = { ...TWO, regions: ['us-east-2', 'us-west-2', 'us-east-1'] };
    const both = await slowRunners(
      [THREE],
      3,
      BOOT_DEADLINE_MS,
      ['us-east-2', 'us-east-1'],
      ['us-east-2'],
    );
    await both.scaler.reconcile();
    expect(both.scaler.status().avoided?.map((a) => a.where)).toEqual([
      'aws us-east-2 spot',
    ]);

    const env = await slowRunners([TWO], 3, BOOT_DEADLINE_MS, ['us-east-2']);
    await env.scaler.reconcile();
    const status = env.scaler.status();
    expect(status.avoided).toEqual([
      {
        where: 'aws us-east-2 spot',
        until: new Date(BOOT_DEADLINE_MS + 30 * 60_000).toISOString(),
      },
    ]);
    const served = { installed: true, broker: null, ...status };
    expect(listenerStatusSchema.parse(served)).toEqual(served);
    // A new job's runner goes to us-west-2 only, until the 30 minutes pass.
    env.sets[0]!.statistics = assigned(4);
    await env.scaler.reconcile();
    expect(env.anycloud.submitted.at(-1)!.regions).toEqual(['us-west-2']);
    env.clock.now += 30 * 60_000;
    env.sets[0]!.statistics = assigned(5);
    await env.scaler.reconcile();
    expect(env.anycloud.submitted.at(-1)!.regions).toEqual([
      'us-east-2',
      'us-west-2',
    ]);
  });

  it('replaces at the 500-runner cap, where each replacement nets out', async () => {
    const full = await slowRunners([TWO], 1, BOOT_DEADLINE_MS, ['us-east-2']);
    full.anycloud.control.others = RUNNER_CAP - 1;
    await full.scaler.reconcile();
    expect(full.anycloud.submitted).toHaveLength(2);
    expect(full.anycloud.live.size).toBe(1);
  });

  it("keeps a one-region spot route on spot after misses, and doesn't avoid its only region", async () => {
    const env = await slowRunners([SPOT, OD], 3, BOOT_DEADLINE_MS, [
      'us-east-2',
    ]);
    await env.scaler.reconcile();
    expect(env.scaler.status().avoided).toBeUndefined();
    env.sets[0]!.statistics = assigned(4);
    await env.scaler.reconcile();
    expect(env.anycloud.submitted.at(-1)!.spot).toBe(true);
  });

  it('replaces a burst 10 a cycle, and asks to reconcile again until done', async () => {
    const env = await slowRunners([TWO], 25, BOOT_DEADLINE_MS, ['us-east-2']);
    const runs: boolean[] = [];
    for (let i = 0; i < 3; i++) runs.push(await env.scaler.reconcile());
    expect(runs).toEqual([true, true, false]);
    expect(env.anycloud.submitted).toHaveLength(50);
  });

  it('keeps retrying the terminate of a runner whose registration scale-down removed, and its end is no failure', async () => {
    const env = setup([TWO]);
    env.sets[0]!.statistics = assigned(2);
    await env.scaler.reconcile();
    env.sets[0]!.statistics = assigned(1);
    const terminate = env.anycloud.jobs.terminate;
    let fails = 2;
    env.anycloud.jobs.terminate = async (id) => {
      if (fails-- > 0) throw new Error('503');
      return terminate(id);
    };
    await env.scaler.reconcile();
    // The set is at its target now; the orphan is still retried.
    await env.scaler.reconcile();
    expect(env.anycloud.live.size).toBe(2);
    await env.scaler.reconcile();
    expect(env.anycloud.live.size).toBe(1);
    await env.scaler.reconcile();
    expect(env.sets[0]!.backoff.failures).toBe(0);
  });

  it('retries a scale-down terminate that failed', async () => {
    const env = setup([TWO]);
    env.sets[0]!.statistics = assigned(2);
    await env.scaler.reconcile();
    env.sets[0]!.statistics = assigned(1);
    const terminate = env.anycloud.jobs.terminate;
    env.anycloud.jobs.terminate = async () => {
      env.anycloud.jobs.terminate = terminate;
      throw new Error('503');
    };
    await env.scaler.reconcile();
    expect(env.anycloud.live.size).toBe(2);
    await env.scaler.reconcile();
    expect(env.anycloud.live.size).toBe(1);
  });

  it('leaves a refused Job that anycloud already placed elsewhere and is booting', async () => {
    const env = await slowRunners([TWO], 1, BOOT_DEADLINE_MS, ['us-east-2']);
    env.anycloud.setState(env.slow[0]!, 'initializing');
    await env.scaler.reconcile();
    expect(env.anycloud.submitted).toHaveLength(1);
  });

  it('leaves a scale set in its startup-failure backoff to the backoff', async () => {
    const env = await slowRunners([TWO], 1, BOOT_DEADLINE_MS, ['us-east-2']);
    env.sets[0]!.backoff.delayMs = 60_000;
    await env.scaler.reconcile();
    expect(env.anycloud.submitted).toHaveLength(1);
  });

  it('stops replacing at the first failed submit, and tries again next cycle', async () => {
    const env = await slowRunners([TWO], 2, BOOT_DEADLINE_MS, ['us-east-2']);
    env.anycloud.failNextSubmits(1);
    await env.scaler.reconcile();
    expect(env.anycloud.terminated).toEqual([]);
    await env.scaler.reconcile();
    expect(env.anycloud.terminated).toEqual(env.slow);
  });
});

describe('quota cap', () => {
  const quotas = (limits: Record<string, QuotaLimits>) => {
    const reads: string[] = [];
    const logs: Record<string, unknown>[] = [];
    const q = new Quotas(
      async (cloud, credentials, region) => {
        reads.push(`${cloud} ${credentials} ${region}`);
        const found = limits[region];
        if (!found) throw new Error('no such region');
        return found;
      },
      (entry) => void logs.push(entry),
    );
    return { q, reads, logs };
  };
  const withQuotas = (routes: Route[], q: Quotas, planner?: Planner) =>
    setup(routes, undefined, undefined, undefined, planner, q);

  it("mints no runner past the route's spot vCPU quota, summed over its regions", async () => {
    const { q, reads } = quotas({
      'us-east-2': { spot: 8, onDemand: 64 },
      'us-west-2': { spot: 4, onDemand: 64 },
    });
    const env = withQuotas([TWO], q);
    const set = env.sets[0]!;
    // The reads start with the scale set, so the first burst is capped.
    expect(reads).toEqual(['aws bm-aws us-east-2', 'aws bm-aws us-west-2']);
    await flush();
    set.statistics = assigned(5);
    // 12 spot vCPUs: three 4-vCPU runners.
    await env.scaler.reconcile();
    expect(env.anycloud.submitted).toHaveLength(3);
    set.statistics = assigned(7);
    await env.scaler.reconcile();
    expect(env.anycloud.submitted).toHaveLength(3);
    const status = env.scaler.status().scaleSets[0]!;
    expect(status.quota).toEqual({
      cloud: 'aws',
      regions: ['us-east-2', 'us-west-2'],
      spot: true,
      kind: 'spot',
      limit: 12,
    });
    expect(formatSlow(status)).toEqual([
      '    capped by aws us-east-2, us-west-2 spot vCPU quota (12); raise EC2 "All Standard (A, C, D, H, I, M, R, T, Z) Spot Instance Requests" (L-34B43A08) in us-east-2, us-west-2',
    ]);
    // Two runners end: 4 vCPUs live, room for two more.
    for (const id of [...env.anycloud.live.keys()].slice(0, 2)) {
      env.anycloud.end(id, 'exited');
    }
    await env.scaler.reconcile();
    expect(env.anycloud.submitted).toHaveLength(5);
  });

  it("counts only the route's own regions, and every listener's runners of the cloud", async () => {
    const { q } = quotas({
      'us-east-2': { spot: 8 },
      'us-west-2': { spot: 400 },
    });
    // backmesh-ubuntu-2404-4vcpu only in us-east-2; a KVM class in us-west-2 has room.
    const env = withQuotas([ROUTE, KVM], q);
    env.sets[0]!.statistics = assigned(1);
    env.sets[1]!.statistics = assigned(0);
    await env.scaler.reconcile();
    await flush();
    // Another org's listener has a 4-vCPU spot runner on the control plane.
    env.anycloud.control.elsewhere = [
      { id: 'bmzzzzz-a4-00000001', spot: true, region: 'us-east-2' },
    ];
    env.sets[0]!.statistics = assigned(5);
    await env.scaler.reconcile();
    // 8 vCPUs in us-east-2, 4 ours and 4 theirs: no more.
    expect(env.anycloud.submitted).toHaveLength(1);
    expect(env.scaler.status().scaleSets[0]!.quota).toMatchObject({
      regions: ['us-east-2'],
      limit: 8,
    });
  });

  it('caps the on-demand quota for spot routes in the on-demand window', async () => {
    const { q } = quotas({ 'us-east-2': { spot: 400, onDemand: 4 } });
    const routing = {
      observe: () => undefined,
      onDemand: () => true,
      reclaimed: () => undefined,
      poll: async () => [],
      retried: () => false,
      status: () => ({ waiting: 0, paused: [] }),
    };
    const env = setup([SPOT], undefined, routing, undefined, undefined, q);
    env.sets[0]!.statistics = assigned(1);
    await env.scaler.reconcile();
    await flush();
    env.sets[0]!.statistics = assigned(3);
    await env.scaler.reconcile();
    expect(env.anycloud.submitted.map((spec) => spec.spot)).toEqual([false]);
    expect(env.scaler.status().scaleSets[0]!.quota).toMatchObject({
      spot: false,
      limit: 4,
    });
  });

  it("caps a GPU label by its family's quota, not the CPU labels', and names it", async () => {
    const { q } = quotas({
      'us-east-2': { spot: 64, onDemand: 64, gpuSpot: 8, gpuOnDemand: 0 },
    });
    const GPU: Route = {
      ...ROUTE,
      label: 'backmesh-ubuntu-2404-gpu-t4',
      code: 'd4',
      vmTypes: ['g4dn.xlarge'],
      gpu: 'T4',
    };
    const env = withQuotas([ROUTE, GPU], q);
    await flush();
    env.sets[0]!.statistics = assigned(3);
    env.sets[1]!.statistics = assigned(3);
    await env.scaler.reconcile();
    // 8 GPU spot vCPUs: two T4 runners, while backmesh-ubuntu-2404-4vcpu takes its three.
    const codes = env.anycloud.submitted.map((s) => s.id.slice(8, 10));
    expect(codes.filter((c) => c === 'a4')).toHaveLength(3);
    expect(codes.filter((c) => c === 'd4')).toHaveLength(2);
    expect(env.anycloud.submitted.find((s) => s.gpu)).toMatchObject({
      gpu: 'T4',
      vmTypes: ['g4dn.xlarge'],
    });
    const status = env.scaler.status().scaleSets[1]!;
    expect(status).toMatchObject({
      gpu: 'T4',
      quota: { spot: true, kind: 'gpuSpot', limit: 8 },
    });
    expect(formatSlow(status)).toEqual([
      '    capped by aws us-east-2 GPU spot vCPU quota (8); raise EC2 "All G and VT Spot Instance Requests" (L-3819A6DF) in us-east-2',
    ]);
  });

  it("gives the quota to real jobs before any set's speculative runners", async () => {
    const { q } = quotas({ 'us-east-2': { spot: 12 } });
    q.limit('aws', 'bm-aws', ['us-east-2'], 'spot', 0);
    const B: Route = {
      ...ROUTE,
      label: 'backmesh-ubuntu-2404-8vcpu',
      code: 'a8',
      vcpus: 8,
    };
    let wanted = 0;
    const planner = {
      observe: () => undefined,
      speculative: (label: string) => (label === ROUTE.label ? wanted : 0),
      nextDue: () => undefined,
      booted: () => undefined,
      status: () => ({ keys: 0, guarded: 0, off: false }),
    } as unknown as Planner;
    const env = withQuotas([ROUTE, B], q, planner);
    env.sets[0]!.statistics = assigned(0);
    env.sets[1]!.statistics = assigned(0);
    await env.scaler.reconcile();
    await flush();
    // backmesh-ubuntu-2404-4vcpu wants 2 speculative runners, backmesh-ubuntu-2404-8vcpu has a real job:
    // 8 of the 12 vCPUs go to it first, then one speculative runner.
    wanted = 2;
    env.sets[1]!.statistics = assigned(1);
    await env.scaler.reconcile();
    const labels = env.anycloud.submitted.map((spec) => spec.id.slice(8, 10));
    expect(labels.sort()).toEqual(['a4', 'a8']);
  });

  it("leaves the tick to other scale sets when one is at its quota, and doesn't reconcile again at once", async () => {
    const { q } = quotas({ 'us-east-2': { spot: 4 } });
    const GCP: Route = {
      ...ROUTE,
      label: 'backmesh-gcp-ubuntu-2404-4vcpu',
      code: 'g4',
      cloud: 'gcp',
      credentials: 'bm-gcp',
      regions: ['us-central1'],
    };
    const env = withQuotas([ROUTE, GCP], q);
    await flush();
    env.sets[0]!.statistics = assigned(80);
    env.sets[1]!.statistics = assigned(3);
    expect(await env.scaler.reconcile()).toBe(false);
    const codes = env.anycloud.submitted.map((spec) => spec.id.slice(8, 10));
    expect(codes.sort()).toEqual(['a4', 'g4', 'g4', 'g4']);
  });

  it('never replaces a slow spot runner on demand, whatever the on-demand quota', async () => {
    const { q } = quotas({ 'us-east-2': { spot: 400, onDemand: 400 } });
    const env = withQuotas([SPOT, OD], q);
    await flush();
    env.sets[0]!.statistics = assigned(1);
    await env.scaler.reconcile();
    const [slow] = env.anycloud.submitted.map((spec) => spec.id);
    env.anycloud.setState(slow!, 'retrying');
    const timeline = await env.anycloud.jobs.timeline(slow!);
    timeline!.refusals = [refused('us-east-2')];
    env.clock.now = BOOT_DEADLINE_MS;
    await env.scaler.reconcile();
    expect(env.anycloud.submitted).toHaveLength(1);
    expect(env.anycloud.terminated).toEqual([]);
  });

  it("shows no cap when only speculative runners were held back, and doesn't count another listener's unplaced runner", async () => {
    const { q } = quotas({ 'us-east-2': { spot: 4 } });
    q.limit('aws', 'bm-aws', ['us-east-2'], 'spot', 0);
    const planner = {
      observe: () => undefined,
      speculative: () => 2,
      nextDue: () => undefined,
      booted: () => undefined,
      status: () => ({ keys: 0, guarded: 0, off: false }),
    } as unknown as Planner;
    const env = withQuotas([ROUTE], q, planner);
    await flush();
    env.anycloud.control.elsewhere = [
      { id: 'bmzzzzz-a4-00000001', spot: true, region: null },
    ];
    env.sets[0]!.statistics = assigned(0);
    await env.scaler.reconcile();
    expect(env.anycloud.submitted).toHaveLength(1);
    expect(env.scaler.status().scaleSets[0]!.quota).toBeUndefined();
  });

  it("doesn't cap GCP, or a region whose read hasn't answered", async () => {
    const { q, logs } = quotas({ 'us-east-2': { spot: 4 } });
    expect(
      q.limit('gcp', 'bm-gcp', ['us-central1'], 'spot', 0),
    ).toBeUndefined();
    q.limit('aws', 'bm-aws', ['us-east-2', 'us-west-1'], 'spot', 0);
    await flush();
    expect(
      q.limit('aws', 'bm-aws', ['us-east-2', 'us-west-1'], 'spot', 1),
    ).toBeUndefined();
    expect(q.limit('aws', 'bm-aws', ['us-east-2'], 'spot', 1)).toBe(4);
    expect(logs).toContainEqual(
      expect.objectContaining({
        msg: 'quota read failed; keeping its last limits, if any',
      }),
    );
  });
});
