import { describe, expect, it } from 'vitest';

import { Planner } from '../../../src/listener/prewarm.js';
import { codeOf } from '../../../src/listener/routes.js';
import {
  COMPLETED_GRACE_MS,
  REQUEUE_HOLD_MS,
  type Scaler,
} from '../../../src/listener/scaler.js';
import {
  formatPlanner,
  formatReasons,
  listenerStatusSchema,
} from '../../../src/listener/status.js';
import { assigned, INSTALL, message, ROUTE, setup } from './fakes.js';

// The listener's loop: a tick that submitted its limit goes again at once.
async function settle(scaler: Scaler) {
  while (await scaler.reconcile());
}

describe('Scaler', () => {
  it('submits generic runners up to TotalAssignedJobs', async () => {
    const { anycloud, scaler, sets } = setup();
    sets[0]!.statistics = assigned(3);
    await scaler.reconcile();
    await scaler.reconcile();

    expect(anycloud.submitted).toHaveLength(3);
    for (const spec of anycloud.submitted) {
      expect(codeOf(INSTALL, spec.id)).toBe('a4');
      expect(spec).toEqual({
        id: spec.id,
        cloud: 'aws',
        regions: ['us-east-2'],
        credentials: 'bm-aws',
        vmTypes: ['m6a.xlarge', 'm7a.xlarge'],
        kvm: false,
        vcpus: 4,
        spot: true,
        jitConfig: `jit-${spec.id}`,
      });
    }
  });

  it('runs the jobs a retiring scale set already has, and offers it no capacity', async () => {
    const retiring = {
      ...ROUTE,
      label: 'backmesh-ubuntu-2404-8vcpu',
      code: 'a8',
      vcpus: 8,
      retiring: true,
    };
    const { anycloud, scaler, sets } = setup([retiring, ROUTE]);
    // Jobs already assigned to the retiring label get their runners, so
    // they run before its scale set goes.
    sets[0]!.statistics = assigned(3);
    sets[1]!.statistics = assigned(2);
    await settle(scaler);
    expect(anycloud.submitted.map((s) => codeOf(INSTALL, s.id)).sort()).toEqual(
      ['a4', 'a4', 'a8', 'a8', 'a8'],
    );
    expect(scaler.capacity(sets[0]!)).toBe(0);
    expect(scaler.capacity(sets[1]!)).toBeGreaterThan(0);
    expect(
      listenerStatusSchema.shape.scaleSets.parse(scaler.status().scaleSets)[0],
    ).toMatchObject({ label: 'backmesh-ubuntu-2404-8vcpu', retiring: true });
  });

  it('keeps the installation within 500 runners across scale sets', async () => {
    const other = { ...ROUTE, label: 'backmesh-ubuntu-2404-8vcpu', code: 'a8' };
    const { anycloud, scaler, sets } = setup([ROUTE, other]);
    sets[0]!.statistics = assigned(400);
    sets[1]!.statistics = assigned(400);
    await settle(scaler);

    expect(anycloud.live.size).toBe(500);
    expect(await scaler.reconcile()).toBe(false);
    expect(anycloud.live.size).toBe(500);
    expect(scaler.capacity(sets[1]!)).toBe(100);
  });

  it("counts other orgs' runner Jobs against the control plane's 500", async () => {
    const { anycloud, scaler, sets } = setup();
    anycloud.control.others = 480;
    sets[0]!.statistics = assigned(100);
    await settle(scaler);

    expect(anycloud.live.size).toBe(20);
    expect(sets[0]!.capped).toBe(true);
    expect(scaler.capacity(sets[0]!)).toBe(20);
    // Their runners end: this org gets the room on the next tick.
    anycloud.control.others = 0;
    await settle(scaler);
    expect(anycloud.live.size).toBe(100);
    expect(sets[0]!.capped).toBe(false);
  });

  it("never scales this org's runners down when other orgs fill the cap", async () => {
    const { anycloud, scaler, sets } = setup();
    sets[0]!.statistics = assigned(100);
    await settle(scaler);
    anycloud.control.others = 450;
    await settle(scaler);

    expect(anycloud.terminated).toEqual([]);
    expect(anycloud.live.size).toBe(100);
    expect(scaler.capacity(sets[0]!)).toBe(50);
  });

  it('submits at most 50 a tick and asks for another tick when it did', async () => {
    const other = { ...ROUTE, label: 'backmesh-ubuntu-2404-8vcpu', code: 'a8' };
    const { anycloud, scaler, sets } = setup([ROUTE, other]);
    sets[0]!.statistics = assigned(40);
    sets[1]!.statistics = assigned(30);

    expect(await scaler.reconcile()).toBe(true);
    expect(anycloud.submitted).toHaveLength(50);
    // The tick's limit isn't the cap.
    expect(sets.map((set) => set.capped)).toEqual([false, false]);
    expect(await scaler.reconcile()).toBe(false);
    expect(anycloud.submitted).toHaveLength(70);
  });

  it("doesn't ask for another tick when a submit failed", async () => {
    const { anycloud, scaler, sets } = setup();
    sets[0]!.statistics = assigned(60);
    anycloud.failNextSubmits(1);

    expect(await scaler.reconcile()).toBe(false);
  });

  it('removes the registration of a failed submit and stops the cycle', async () => {
    const { anycloud, github, scaler, sets } = setup();
    sets[0]!.statistics = assigned(20);
    anycloud.failNextSubmits(1);
    await scaler.reconcile();

    // The other workers finish what they started; nothing new starts.
    expect(anycloud.submitted.length).toBeLessThan(4);
    const minted = github.calls.filter((call) => call.startsWith('mint'));
    expect(github.runners.size).toBe(minted.length - 1);
  });

  it('keeps the registration when a gateway error may hide a landed Job', async () => {
    const { anycloud, github, scaler, sets } = setup();
    sets[0]!.statistics = assigned(1);
    anycloud.failNextSubmits(1, 502);
    await scaler.reconcile();

    const [id] = anycloud.submitted.map((spec) => spec.id);
    expect(github.runners.has(id!)).toBe(true);
    await scaler.reconcile();
    expect(anycloud.submitted).toHaveLength(1);
  });

  it("removes a registration whose Job doesn't exist", async () => {
    const { anycloud, github, scaler, sets } = setup();
    sets[0]!.statistics = assigned(1);
    await scaler.reconcile();
    const [id] = anycloud.submitted.map((spec) => spec.id);
    // A submit that timed out and never landed.
    anycloud.live.delete(id!);
    sets[0]!.statistics = assigned(0);
    await scaler.reconcile();

    expect(github.runners.has(id!)).toBe(false);
    expect(sets[0]!.backoff.failures).toBe(0);
  });

  it('retries a failed end read next cycle', async () => {
    const { anycloud, scaler, sets } = setup();
    sets[0]!.statistics = assigned(1);
    await scaler.reconcile();
    const [id] = anycloud.submitted.map((spec) => spec.id);
    anycloud.end(id!, 'exited');
    sets[0]!.statistics = assigned(0);
    anycloud.failNextEndReads(1);
    await scaler.reconcile();
    expect(sets[0]!.backoff.failures).toBe(0);

    await scaler.reconcile();
    expect(sets[0]!.backoff.failures).toBe(1);
  });

  it("doesn't count a completed runner, and terminates its Job after the grace once GitHub lets it go", async () => {
    const { anycloud, clock, github, scaler, sets } = setup();
    sets[0]!.statistics = assigned(3);
    await scaler.reconcile();
    const [a, b, c] = anycloud.submitted.map((spec) => spec.id);
    for (const id of [a!, b!]) {
      anycloud.live.set(id, {
        id,
        state: 'running',
        submittedAt: 0,
        latestMessage: null,
        spot: true,
      });
      scaler.observe(sets[0]!, message('JobStarted', { runnerName: id }));
    }
    // a's job completes and its Job is still exiting. Two jobs remain: b's
    // and the one c will take.
    scaler.observe(sets[0]!, message('JobCompleted', { runnerName: a! }));
    sets[0]!.statistics = assigned(2);
    await scaler.reconcile();
    expect(anycloud.submitted).toHaveLength(3);

    clock.now = COMPLETED_GRACE_MS - 1;
    await scaler.reconcile();
    expect(anycloud.terminated).toEqual([]);
    // Past the grace, GitHub still refuses to remove a's runner.
    github.busy.add(a!);
    clock.now = COMPLETED_GRACE_MS;
    await scaler.reconcile();
    expect(anycloud.terminated).toEqual([]);
    github.busy.delete(a!);
    await scaler.reconcile();
    expect(anycloud.terminated).toEqual([a]);
    expect([...anycloud.live.keys()]).toEqual([b, c]);
    expect(anycloud.submitted).toHaveLength(3);
    expect(sets[0]!.backoff.failures).toBe(0);
  });

  it("doesn't count a completed runner's exit as a startup failure", async () => {
    const { anycloud, scaler, sets } = setup();
    sets[0]!.statistics = assigned(1);
    await scaler.reconcile();
    const [id] = anycloud.submitted.map((spec) => spec.id);
    scaler.observe(sets[0]!, message('JobStarted', { runnerName: id! }));
    scaler.observe(sets[0]!, message('JobCompleted', { runnerName: id! }));
    anycloud.end(id!, 'exited');
    sets[0]!.statistics = assigned(0);
    await scaler.reconcile();

    expect(sets[0]!.backoff.failures).toBe(0);
  });

  it('keeps a busy mark that arrives during a failed end read', async () => {
    const { anycloud, scaler, sets } = setup();
    sets[0]!.statistics = assigned(1);
    await scaler.reconcile();
    const [id] = anycloud.submitted.map((spec) => spec.id);
    anycloud.end(id!, 'exited');
    sets[0]!.statistics = assigned(0);
    anycloud.failNextEndReads(1);
    // A late JobStarted: the runner took a job and exited.
    anycloud.onEndRead(() =>
      scaler.observe(sets[0]!, message('JobStarted', { runnerName: id! })),
    );
    await scaler.reconcile();
    anycloud.onEndRead(() => {});
    await scaler.reconcile();

    expect(sets[0]!.backoff.failures).toBe(0);
  });

  it('leaves out completed runners from the other scale sets in capacity', async () => {
    const other = { ...ROUTE, label: 'backmesh-ubuntu-2404-8vcpu', code: 'a8' };
    const { anycloud, scaler, sets } = setup([ROUTE, other]);
    sets[1]!.statistics = assigned(3);
    await scaler.reconcile();
    await scaler.reconcile();
    expect(scaler.capacity(sets[0]!)).toBe(497);
    const [done] = anycloud.submitted.map((spec) => spec.id);
    scaler.observe(sets[1]!, message('JobCompleted', { runnerName: done! }));

    expect(scaler.capacity(sets[0]!)).toBe(498);
    expect(scaler.capacity(sets[1]!)).toBe(500);
  });

  it('still scales up when a scale-down lookup fails', async () => {
    const other = { ...ROUTE, label: 'backmesh-ubuntu-2404-8vcpu', code: 'a8' };
    const { anycloud, github, scaler, sets } = setup([ROUTE, other]);
    sets[0]!.statistics = assigned(2);
    await scaler.reconcile();
    sets[0]!.statistics = assigned(0);
    sets[1]!.statistics = assigned(1);
    github.failNextLookups(1);
    await scaler.reconcile();

    expect(anycloud.terminated).toEqual([]);
    expect(anycloud.submitted.map((spec) => codeOf(INSTALL, spec.id))).toEqual([
      'a4',
      'a4',
      'a8',
    ]);
    await scaler.reconcile();
    expect(anycloud.terminated).toHaveLength(2);
  });

  it("scales down the idle runners of a route that's gone", async () => {
    const other = { ...ROUTE, label: 'backmesh-ubuntu-2404-8vcpu', code: 'a8' };
    const { anycloud, github, scaler, sets, make } = setup([ROUTE, other]);
    sets[0]!.statistics = assigned(1);
    sets[1]!.statistics = assigned(2);
    await scaler.reconcile();
    const [, busy, idle] = anycloud.submitted.map((spec) => spec.id);
    github.busy.add(busy!);

    // A restart without the a8 route.
    const restarted = make();
    restarted.add(ROUTE, 1).statistics = assigned(1);
    await restarted.reconcile();

    expect(anycloud.terminated).toEqual([idle]);
    expect(github.runners.has(idle!)).toBe(false);
    expect(anycloud.live.has(busy!)).toBe(true);
  });

  it('scales down idle runners, queued first, registration before Job', async () => {
    const { anycloud, github, scaler, sets } = setup();
    sets[0]!.statistics = assigned(3);
    await scaler.reconcile();
    const [a, b, c] = anycloud.submitted.map((spec) => spec.id);
    anycloud.setState(a!, 'running');
    anycloud.setState(b!, 'running');
    scaler.observe(sets[0]!, message('JobStarted', { runnerName: b! }));
    sets[0]!.statistics = assigned(1);
    await scaler.reconcile();

    expect(anycloud.terminated).toEqual([c, a]);
    expect(github.calls.slice(-2)).toEqual([`remove ${c}`, `remove ${a}`]);
    expect([...anycloud.live.keys()]).toEqual([b]);
  });

  it('keeps a still-launching runner while GitHub offers a dropped job again', async () => {
    const { anycloud, clock, scaler, sets } = setup();
    sets[0]!.statistics = assigned(1);
    await scaler.reconcile();
    const [id] = anycloud.submitted.map((spec) => spec.id);
    // No runner took the job within GitHub's 5 minutes: it ends with none,
    // and the assigned count dips before GitHub offers it again.
    clock.now = 300_000;
    scaler.observe(sets[0]!, message('JobCompleted', { result: 'canceled' }));
    sets[0]!.statistics = assigned(0);
    await scaler.reconcile();
    expect(anycloud.terminated).toEqual([]);
    sets[0]!.statistics = assigned(1);
    await scaler.reconcile();
    expect(anycloud.submitted.map((spec) => spec.id)).toEqual([id]);
    // A job that really went is scaled down once the hold ends.
    sets[0]!.statistics = assigned(0);
    clock.now += REQUEUE_HOLD_MS;
    await scaler.reconcile();
    expect(anycloud.terminated).toEqual([id]);
  });

  it('keeps a runner GitHub refuses to remove', async () => {
    const { anycloud, github, scaler, sets } = setup();
    sets[0]!.statistics = assigned(1);
    await scaler.reconcile();
    const [id] = anycloud.submitted.map((spec) => spec.id);
    github.busy.add(id!);
    sets[0]!.statistics = assigned(0);
    await scaler.reconcile();

    expect(anycloud.terminated).toEqual([]);
    expect(github.runners.has(id!)).toBe(true);
  });

  it('recovers after a restart from names alone', async () => {
    const { anycloud, github, scaler, sets, make } = setup();
    sets[0]!.statistics = assigned(3);
    await scaler.reconcile();
    const [busy] = anycloud.submitted.map((spec) => spec.id);
    scaler.observe(sets[0]!, message('JobStarted', { runnerName: busy! }));
    github.busy.add(busy!);

    // A new process: no busy marks and nothing it minted.
    const restarted = make();
    const set = restarted.add(ROUTE, 1);
    set.statistics = assigned(3);
    await restarted.reconcile();
    expect(anycloud.submitted).toHaveLength(3);

    set.statistics = assigned(0);
    await restarted.reconcile();
    expect([...anycloud.live.keys()]).toEqual([busy]);

    // Runners the old process minted aren't this one's startup failures.
    anycloud.end(busy!, 'exited');
    set.statistics = assigned(1);
    await restarted.reconcile();
    expect(set.backoff.failures).toBe(0);
    expect(anycloud.submitted).toHaveLength(4);
  });

  // Owner, 2026-11-13: a cycle submits its runners before its ends,
  // reclaims and removals, and still does every one of them.
  it('submits runners before the housekeeping, and skips none of it', async () => {
    const OD = {
      ...ROUTE,
      label: 'backmesh-ubuntu-2404-od-4vcpu',
      code: 'b4',
      spot: false,
    };
    let calls: string[] = [];
    // The retry's routing: the breaker hears the cycle's reclaims, and its
    // waiting runs are polled.
    const routing = {
      observe: () => undefined,
      onDemand: () => false,
      reclaimed: (capacities: Set<string>) =>
        void calls.push(`reclaimed ${[...capacities].join(',')}`),
      poll: async () => (calls.push('poll'), []),
      retried: () => false,
      status: () => undefined,
    };
    const SPOT = { ...ROUTE, onDemand: { label: OD.label } };
    const env = setup([SPOT, OD], undefined, routing);
    const [a, b] = env.sets;
    calls = env.github.calls;
    const { jobs } = env.anycloud;
    const { submit, end, terminate, timeline } = { ...jobs };
    jobs.submit = async (spec) => (
      calls.push(`submit ${spec.id}`),
      submit(spec)
    );
    jobs.end = async (id) => (calls.push(`end ${id}`), end(id));
    jobs.terminate = async (id) => (
      calls.push(`terminate ${id}`),
      terminate(id)
    );
    jobs.timeline = async (id) => (calls.push(`timeline ${id}`), timeline(id));
    a!.statistics = assigned(4);
    b!.statistics = assigned(2);
    await env.scaler.reconcile();
    const [r1, r2, r3, r4] = env.anycloud.submitted
      .filter((spec) => spec.spot)
      .map((spec) => spec.id);
    // r4 is up, so it's no slow runner.
    env.anycloud.setState(r4!, 'running');
    const [b1, b2] = env.anycloud.submitted
      .filter((spec) => !spec.spot)
      .map((spec) => spec.id);
    // r3's job succeeded; its Job is still listed past the grace.
    for (const [runner, result] of [[r3!, 'Succeeded']] as const) {
      const fields = { runnerName: runner, result, jobId: runner };
      env.scaler.observe(a!, message('JobStarted', fields));
      env.scaler.observe(a!, message('JobCompleted', fields));
    }
    // b's jobs went: b1's terminate fails, leaving an orphan, and b2 stays
    // an extra for the cycle under test.
    a!.statistics = assigned(3);
    b!.statistics = assigned(0);
    jobs.terminate = async (id) => {
      jobs.terminate = async (id) => (
        calls.push(`terminate ${id}`),
        terminate(id)
      );
      throw new Error(`503 ${id}`);
    };
    await env.scaler.reconcile();
    env.clock.now = COMPLETED_GRACE_MS;
    // r1's job failed and its spot VM was reclaimed; r2 exited before
    // taking a job.
    const failed = { runnerName: r1!, result: 'Failed', jobId: r1! };
    env.scaler.observe(a!, message('JobStarted', failed));
    env.scaler.observe(a!, message('JobCompleted', failed));
    env.anycloud.end(r1!, 'reclaimed');
    env.anycloud.end(r2!, 'exited', 'Exited with code 1');
    a!.statistics = assigned(2);
    calls.length = 0;
    // The submit takes a second, which the housekeeping's times include.
    jobs.submit = async (spec) => {
      calls.push(`submit ${spec.id}`);
      env.clock.now += 1_000;
      return submit(spec);
    };

    await env.scaler.reconcile();

    const r5 = env.anycloud.submitted.at(-1)!.id;
    expect(calls).toEqual([
      `mint ${r5}`,
      `submit ${r5}`,
      // Ends: r2 is a startup failure, r1 a reclaim.
      `end ${r2}`,
      `remove ${r2}`,
      `end ${r1}`,
      // The breaker hears r1's spot reclaim.
      'reclaimed aws spot',
      // Retired: r3, past its grace.
      `remove ${r3}`,
      `terminate ${r3}`,
      // The orphan, then b's extra.
      `terminate ${b1}`,
      `remove ${b2}`,
      `terminate ${b2}`,
      'note reclaims in run 7',
      'poll',
      `timeline ${r1}`,
    ]);
    expect(a!.backoff.failures).toBe(1);
    expect(env.logs).toContainEqual(
      expect.objectContaining({
        msg: 'runner failed to start',
        runner: r2,
        at: COMPLETED_GRACE_MS + 1_000,
      }),
    );
    expect(env.anycloud.live.has(b1!)).toBe(false);
  });

  it('backs off after 5 unstarted ends, probes, and resets on JobStarted', async () => {
    const { anycloud, clock, notes, logs, scaler, sets } = setup();
    const [set] = sets;
    set!.statistics = assigned(5);
    scaler.observe(set!, message('JobAssigned'));
    await scaler.reconcile();
    for (const { id } of anycloud.submitted) {
      anycloud.end(id, 'exited', 'Exited with code 1');
    }
    await scaler.reconcile();

    expect(set!.backoff.failures).toBe(5);
    expect(set!.backoff.lastEnd).toBe('exited: Exited with code 1');
    // Ends are read after the cycle's submits, so the backoff holds the
    // next cycle's.
    expect(anycloud.submitted).toHaveLength(10);
    for (const { id } of anycloud.submitted.slice(5)) {
      anycloud.end(id, 'exited', 'Exited with code 1');
    }
    await scaler.reconcile();
    expect(anycloud.submitted).toHaveLength(10);
    expect(anycloud.live.size).toBe(0);
    // In `status` and the log, never as a check run on the waiting runs.
    const backingOff = () =>
      logs.filter(
        (entry) => entry.msg === 'runners fail to start; backing off',
      );
    expect(backingOff()).toEqual([
      expect.objectContaining({
        label: 'backmesh-ubuntu-2404-4vcpu',
        failures: 5,
        nextProbeAt: '1970-01-01T00:01:00.000Z',
      }),
    ]);

    clock.now = 60_000;
    await scaler.reconcile();
    expect(anycloud.live.size).toBe(1);
    const probe = anycloud.submitted.at(-1)!.id;
    anycloud.end(probe, 'exited');
    await scaler.reconcile();
    expect(set!.backoff.nextProbeAt).toBe(60_000 + 120_000);
    expect(backingOff()).toHaveLength(2);

    clock.now = 180_000;
    await scaler.reconcile();
    const next = anycloud.submitted.at(-1)!.id;
    scaler.observe(set!, message('JobStarted', { runnerName: next }));
    await scaler.reconcile();
    expect(anycloud.live.size).toBe(5);
    expect(set!.backoff.failures).toBe(0);
    expect(notes).toEqual([]);
  });

  it("doesn't count reclaims or its own scale-down as startup failures", async () => {
    const { anycloud, scaler, sets } = setup();
    sets[0]!.statistics = assigned(6);
    await scaler.reconcile();
    for (const { id } of anycloud.submitted.slice(0, 4)) {
      anycloud.end(id, 'reclaimed');
    }
    sets[0]!.statistics = assigned(0);
    await scaler.reconcile();

    expect(anycloud.terminated).toHaveLength(2);
    await scaler.reconcile();
    expect(sets[0]!.backoff.failures).toBe(0);
  });

  it('reports the queue counts by state, without completed runners', async () => {
    const { anycloud, clock, scaler, sets } = setup();
    sets[0]!.statistics = assigned(6);
    await scaler.reconcile();
    const [a, b, c, , e, f] = anycloud.submitted.map((spec) => spec.id);
    anycloud.setState(a!, 'running');
    anycloud.setState(b!, 'provisioning');
    anycloud.setState(c!, 'queued', {
      submittedAt: 15_000,
      latestMessage: 'InsufficientInstanceCapacity',
    });
    anycloud.setState(e!, 'finalizing');
    anycloud.setState(f!, 'running');
    scaler.observe(sets[0]!, message('JobCompleted', { runnerName: f! }));
    sets[0]!.statistics = assigned(5);
    clock.now = 45_000;
    await scaler.reconcile();

    const status = scaler.status();
    const served = { installed: true, broker: null, ...status };
    expect(listenerStatusSchema.parse(served)).toEqual(served);
    expect(status).toEqual({
      runners: 5,
      cap: 500,
      scaleSets: [
        {
          label: 'backmesh-ubuntu-2404-4vcpu',
          cloud: 'aws',
          queued: 2,
          starting: 1,
          running: 1,
          oldestQueuedMs: 45_000,
          reasons: [
            { reason: 'InsufficientInstanceCapacity', count: 1 },
            { reason: 'no reason given', count: 1 },
          ],
          capped: false,
          statistics: assigned(5),
          // The completed job's message has no timestamps, and its runner
          // Job no timeline. The listener started 45 s ago.
          jobs: {
            day: {
              jobs: 1,
              startMs: null,
              runMs: null,
              dominant: null,
              reclaims: 0,
              startupFailures: 0,
              reruns: 0,
              retries: { onDemand: 0, spot: 0 },
              fellBack: 0,
              regions: {
                'us-east-2': {
                  jobs: 1,
                  vmMs: { p50: 30_000, p95: 30_000 },
                },
              },
              refusedIn: {},
              refusedFor: {},
              quotaRefused: { runners: 0, regions: [], waitMs: null },
              since: '1970-01-01T00:00:00.000Z',
              startedFor: {
                cue: { jobs: 0, startMs: null },
                predicted: { jobs: 0, startMs: null },
                reactive: { jobs: 1, startMs: null },
              },
            },
            week: expect.objectContaining({ jobs: 1 }),
          },
          backoff: null,
        },
      ],
    });
  });

  it('reports a backoff in the status', async () => {
    const { anycloud, scaler, sets } = setup();
    sets[0]!.statistics = assigned(5);
    await scaler.reconcile();
    for (const { id } of anycloud.submitted) anycloud.end(id, 'exited');
    await scaler.reconcile();

    const [set] = listenerStatusSchema.parse({
      installed: true,
      broker: null,
      ...scaler.status(),
    }).scaleSets;
    expect(set!.backoff?.nextProbeAt).toBe('1970-01-01T00:01:00.000Z');
    // No detail: the end reason alone.
    expect(set!.backoff?.lastEnd).toBe('exited');
    expect(set!.jobs?.day).toMatchObject({ jobs: 0, startupFailures: 5 });
  });

  describe('job rows', () => {
    const T = Date.UTC(2026, 10, 5, 12);
    // One runner submitted at T, its VM Job running 30 s later, and a
    // job queued 1 s before T that it took at T + 45 s and ran for 4 min.
    async function ranJob() {
      const env = setup();
      env.clock.now = T;
      env.sets[0]!.statistics = assigned(1);
      await env.scaler.reconcile();
      const id = env.anycloud.submitted[0]!.id;
      const times = {
        runnerName: id,
        queueTime: T - 1_000,
        scaleSetAssignTime: T - 500,
        runnerAssignTime: T + 45_000,
      };
      env.clock.now = T + 45_000;
      env.scaler.observe(env.sets[0]!, message('JobStarted', times));
      env.clock.now = T + 285_000;
      const done = message('JobCompleted', {
        ...times,
        finishTime: T + 285_000,
        result: 'succeeded',
      });
      env.scaler.observe(env.sets[0]!, done);
      return { ...env, id, done };
    }
    const rowsOf = (logs: ({ msg: string } & Record<string, unknown>)[]) =>
      logs.filter((entry) => entry.msg.startsWith('job '));

    it("records each job with its runner Job's timeline, once", async () => {
      const { anycloud, done, id, logs, scaler, sets } = await ranJob();
      expect(rowsOf(logs).map((entry) => entry.msg)).toEqual(['job started']);

      // Redelivered before and after its row is written.
      scaler.observe(sets[0]!, done);
      await scaler.reconcile();
      scaler.observe(sets[0]!, done);
      await scaler.reconcile();
      const completed = rowsOf(logs).filter(
        (entry) => entry.msg === 'job completed',
      );
      expect(completed).toEqual([
        {
          msg: 'job completed',
          at: T + 285_000,
          label: 'backmesh-ubuntu-2404-4vcpu',
          jobId: 'job-1',
          runId: 7,
          org: 'acme',
          repo: 'app',
          workflowRef: null,
          job: 'test',
          event: 'push',
          runner: id,
          queuedAt: T - 1_000,
          assignedAt: T - 500,
          runnerAssignedAt: T + 45_000,
          finishedAt: T + 285_000,
          result: 'succeeded',
          runnerJob: {
            submittedAt: T,
            dockerReadyAt: T + 20_000,
            pulledAt: T + 25_000,
            prepulled: true,
            runningAt: T + 30_000,
            region: 'us-east-2',
            refusals: [],
            backedOff: [],
            refusedUntil: null,
          },
          start: 'reactive',
        },
      ]);
      expect(anycloud.live.has(id)).toBe(true);
      expect(scaler.status().scaleSets[0]!.jobs?.day).toMatchObject({
        jobs: 1,
        startMs: { p50: 46_000, p95: 46_000 },
        runMs: { p50: 240_000, p95: 240_000 },
        // 30 of the 46 s waited for the VM.
        dominant: { segment: 'vm', share: 30_000 / 46_000 },
      });
    });

    it('retries a failed timeline read, then records the row without it', async () => {
      const first = await ranJob();
      first.anycloud.failNextTimelineReads(1);
      await first.scaler.reconcile();
      expect(rowsOf(first.logs)).toHaveLength(1);
      await first.scaler.reconcile();
      expect(rowsOf(first.logs).at(-1)).toMatchObject({
        msg: 'job completed',
        runnerJob: { runningAt: T + 30_000 },
      });

      const second = await ranJob();
      // No job left, so no runner minted to miss the boot deadline.
      second.sets[0]!.statistics = assigned(0);
      second.anycloud.failNextTimelineReads(2);
      await second.scaler.reconcile();
      second.clock.now += COMPLETED_GRACE_MS;
      await second.scaler.reconcile();
      expect(second.logs.map((entry) => entry.msg)).toContain(
        'runner Job read failed; its row has no timeline',
      );
      expect(rowsOf(second.logs).at(-1)).toMatchObject({
        msg: 'job completed',
        runnerJob: null,
      });
    });

    it('records a job canceled before any runner took it, with no read', async () => {
      const { anycloud, logs, scaler, sets } = setup();
      anycloud.failNextTimelineReads(1);
      scaler.observe(
        sets[0]!,
        message('JobCompleted', { queueTime: 1, result: 'canceled' }),
      );
      await scaler.reconcile();
      expect(rowsOf(logs)).toMatchObject([
        { msg: 'job completed', runner: null, runnerJob: null, start: null },
      ]);
    });

    it('logs a redelivered JobStarted again, for readers to dedupe by job ID', async () => {
      const { logs, scaler, sets } = await ranJob();
      scaler.observe(sets[0]!, message('JobStarted', { runnerName: 'r' }));
      expect(
        rowsOf(logs)
          .filter((entry) => entry.msg === 'job started')
          .map((entry) => entry.jobId),
      ).toEqual(['job-1', 'job-1']);
    });

    it('writes the rows still waiting for a read at shutdown, without it', async () => {
      const { logs, scaler } = await ranJob();
      await scaler.flushJobs();
      await scaler.flushJobs();
      expect(rowsOf(logs).filter((e) => e.msg === 'job completed')).toEqual([
        expect.objectContaining({ jobId: 'job-1', runnerJob: null }),
      ]);
    });
  });

  describe('reclaims', () => {
    // Runners whose jobs failed, their Jobs still listed: one per job name,
    // all in run 7.
    async function failedRunner(
      result = 'Failed',
      retry?: Parameters<typeof setup>[1],
      jobs = ['test'],
    ) {
      const env = setup(undefined, retry);
      env.sets[0]!.statistics = assigned(jobs.length);
      await env.scaler.reconcile();
      const ids = env.anycloud.submitted.map((spec) => spec.id);
      jobs.forEach((jobDisplayName, i) => {
        const fields = { runnerName: ids[i]!, jobDisplayName, result };
        env.scaler.observe(env.sets[0]!, message('JobStarted', fields));
        env.scaler.observe(env.sets[0]!, message('JobCompleted', fields));
      });
      env.sets[0]!.statistics = assigned(0);
      return { ...env, id: ids[0]!, ids };
    }

    it('replaces a runner whose VM went once anycloud ends its Job, busy or idle', async () => {
      const { anycloud, github, logs, scaler, sets } = setup();
      sets[0]!.statistics = assigned(2);
      await scaler.reconcile();
      const [busy, idle] = anycloud.submitted.map((spec) => spec.id);
      github.busy.add(busy!);
      scaler.observe(sets[0]!, message('JobStarted', { runnerName: busy! }));
      for (const id of [busy!, idle!]) anycloud.setState(id, 'recovering');
      await scaler.reconcile();
      // Recovering, they're left to anycloud and still count.
      expect(anycloud.terminated).toEqual([]);
      expect(anycloud.submitted).toHaveLength(2);
      // At maxRetries 0 anycloud fails both, which leaves the listing: the
      // count mints a runner for each of the 2 assigned jobs, and neither
      // end is a startup failure.
      anycloud.end(busy!, 'reclaimed');
      anycloud.end(idle!, 'lost');
      await scaler.reconcile();
      expect(anycloud.submitted).toHaveLength(4);
      expect(anycloud.terminated).toEqual([]);
      expect(github.calls).toContain(`remove ${idle}`);
      expect(logs.some((e) => e.msg === 'runner failed to start')).toBe(false);
      expect(sets[0]!.backoff.failures).toBe(0);
    });

    it("ends nothing itself when a runner's job succeeds and its Job exits", async () => {
      const { anycloud, logs, notes, scaler, sets } = setup();
      sets[0]!.statistics = assigned(1);
      await scaler.reconcile();
      const id = anycloud.submitted[0]!.id;
      const fields = { runnerName: id, result: 'Succeeded' };
      scaler.observe(sets[0]!, message('JobStarted', fields));
      scaler.observe(sets[0]!, message('JobCompleted', fields));
      sets[0]!.statistics = assigned(0);
      // anycloud ends the Job itself on its clean exit (maxRetries 0).
      anycloud.end(id, 'exited', 'Exited with code 0');
      await scaler.reconcile();
      expect(anycloud.terminated).toEqual([]);
      expect(notes).toEqual([]);
      expect(logs.some((e) => e.msg === 'runner failed to start')).toBe(false);
      expect(sets[0]!.backoff.failures).toBe(0);
    });

    it('posts one note per run, naming every reclaimed job, when nothing retries it', async () => {
      const { anycloud, ids, notes, scaler } = await failedRunner(
        'Failed',
        undefined,
        ['test', 'lint', 'build'],
      );
      await scaler.reconcile();
      expect(notes).toHaveLength(0);

      anycloud.end(ids[0]!, 'reclaimed');
      anycloud.end(ids[1]!, 'reclaimed');
      await scaler.reconcile();
      expect(notes).toEqual([
        {
          run: { owner: 'acme', repo: 'app', runId: 7 },
          note: {
            name: 'reclaims in run 7',
            title: 'Rerun needed: 2 jobs lost a spot VM',
            summary:
              "`test` (aws m6a.xlarge us-east-2, spot), `lint` (aws m6a.xlarge us-east-2, spot) lost their spot VM to a reclaim. backmesh doesn't rerun them automatically. Rerun the failed jobs from the Actions tab once the run finishes.",
          },
        },
      ]);
      expect(scaler.status().scaleSets[0]!.jobs?.day).toMatchObject({
        reclaims: 2,
      });

      // A later reclaim in the run reposts under the same name, with all
      // three, which replaces the first on the SHA.
      anycloud.end(ids[2]!, 'reclaimed');
      await scaler.reconcile();
      expect(notes).toHaveLength(2);
      expect(notes[1]!.note).toMatchObject({
        name: 'reclaims in run 7',
        title: 'Rerun needed: 3 jobs lost a spot VM',
        summary: expect.stringMatching(/^`test` .*, `lint` .*, `build` \(/),
      });
    });

    it('says why a reclaim backmesh retries failed, and records it with the job', async () => {
      const asked: unknown[] = [];
      const { anycloud, id, logs, notes, scaler } = await failedRunner(
        'Failed',
        async (run, reclaims) => {
          asked.push({ run, reclaims });
          return 'retry';
        },
      );
      anycloud.end(id, 'reclaimed');
      await scaler.reconcile();

      // As RunsOn's spot interruption annotation: the failed job's reason.
      expect(notes).toEqual([
        {
          run: { owner: 'acme', repo: 'app', runId: 7 },
          note: {
            name: 'reclaims in run 7',
            title: 'Spot reclaim',
            summary:
              "`test` (aws m6a.xlarge us-east-2, spot) lost its spot VM to a reclaim. If the run's only failures are reclaims, backmesh reruns its failed jobs once it finishes, on an on-demand runner where it can, at most twice, unless a job sets `backmesh-noretry`.",
          },
        },
      ]);
      const reclaim = {
        job: 'test',
        runner: id,
        label: 'backmesh-ubuntu-2404-4vcpu',
        spot: true,
        vm: 'aws m6a.xlarge us-east-2',
      };
      expect(asked).toEqual([
        { run: { owner: 'acme', repo: 'app', runId: 7 }, reclaims: [reclaim] },
      ]);
      // One row per reclaim, with the run's decision.
      expect(logs.filter((entry) => entry.msg === 'job reclaimed')).toEqual([
        {
          msg: 'job reclaimed',
          at: 0,
          ...reclaim,
          repo: 'acme/app',
          runId: 7,
          retry: 'retry',
        },
      ]);
    });

    it('names a job reclaimed again in a rerun once', async () => {
      // Two runners took `test`: the first attempt's and its rerun's.
      const { anycloud, ids, notes, scaler } = await failedRunner(
        'Failed',
        async () => 'retry',
        ['test', 'test'],
      );
      anycloud.end(ids[0]!, 'reclaimed');
      await scaler.reconcile();
      anycloud.end(ids[1]!, 'reclaimed');
      await scaler.reconcile();
      expect(notes.map(({ note }) => note.summary)).toEqual([
        expect.stringMatching(/^`test` \([^)]*\) lost its spot VM/),
        expect.stringMatching(/^`test` \([^)]*\) lost its spot VM/),
      ]);
    });

    it('posts the note when the retry decision fails', async () => {
      const { anycloud, id, logs, notes, scaler } = await failedRunner(
        'Failed',
        async () => {
          throw new Error('GitHub 502');
        },
      );
      anycloud.end(id, 'reclaimed');
      await scaler.reconcile();
      expect(notes.map(({ note }) => note.summary)).toEqual([
        expect.stringContaining("backmesh doesn't rerun it automatically."),
      ]);
      expect(logs).toContainEqual(
        expect.objectContaining({ msg: 'job reclaimed', retry: 'unavailable' }),
      );
    });

    it('posts once, with the reason, when the user must rerun', async () => {
      for (const [retry, reason] of [
        ['noretry', '`backmesh-noretry` opted it out of the automatic rerun.'],
        ['attempt-cap', "This run is at attempt 3, backmesh's limit."],
      ] as const) {
        const { anycloud, id, notes, scaler } = await failedRunner(
          'Failed',
          async () => retry,
        );
        anycloud.end(id, 'reclaimed');
        await scaler.reconcile();
        expect(notes.map(({ note }) => note.summary)).toEqual([
          expect.stringContaining(
            ` lost its spot VM to a reclaim. ${reason} Rerun`,
          ),
        ]);
      }
    });

    it('re-reads a Job that has no end yet, or whose read failed', async () => {
      const { anycloud, id, notes, scaler } = await failedRunner();
      anycloud.end(id, null);
      await scaler.reconcile();
      anycloud.failNextEndReads(1);
      await scaler.reconcile();
      expect(notes).toHaveLength(0);

      anycloud.end(id, 'lost');
      await scaler.reconcile();
      expect(notes).toHaveLength(1);
    });

    it('posts after submitting the replacement', async () => {
      const { anycloud, github, id, scaler, sets } = await failedRunner();
      anycloud.end(id, 'reclaimed');
      sets[0]!.statistics = assigned(1);
      await scaler.reconcile();

      const next = anycloud.submitted.at(-1)!.id;
      expect(github.calls.slice(-2)).toEqual([
        `mint ${next}`,
        'note reclaims in run 7',
      ]);
    });

    it('reads the end of any result but succeeded or skipped', async () => {
      for (const result of ['Canceled', 'Abandoned']) {
        const { anycloud, id, notes, scaler } = await failedRunner(result);
        anycloud.end(id, 'reclaimed');
        await scaler.reconcile();
        expect(notes).toHaveLength(1);
      }
    });

    it('posts nothing for any other end, or a job that succeeded or was skipped', async () => {
      for (const [result, reason] of [
        ['Failed', 'exited'],
        ['Succeeded', 'reclaimed'],
        ['Skipped', 'reclaimed'],
      ] as const) {
        const { anycloud, id, notes, scaler } = await failedRunner(result);
        anycloud.end(id, reason);
        await scaler.reconcile();
        expect(notes).toHaveLength(0);
      }
    });

    it("stops reading after 10 minutes, so its own terminate isn't a reclaim", async () => {
      const { anycloud, clock, id, notes, scaler } = await failedRunner();
      clock.now = COMPLETED_GRACE_MS;
      await scaler.reconcile();
      expect(anycloud.terminated).toEqual([id]);

      anycloud.end(id, 'reclaimed');
      await scaler.reconcile();
      expect(notes).toHaveLength(0);
    });
  });

  it('reports the cap holding a scale set back, and formats the reasons', async () => {
    const other = { ...ROUTE, label: 'backmesh-ubuntu-2404-8vcpu', code: 'a8' };
    const { scaler, sets } = setup([ROUTE, other]);
    sets[0]!.statistics = assigned(450);
    sets[1]!.statistics = assigned(100);
    await settle(scaler);
    // Status counts the next cycle's listing.
    await scaler.reconcile();

    const status = listenerStatusSchema.parse({
      installed: true,
      broker: null,
      ...scaler.status(),
    });
    expect(status.scaleSets.map((set) => set.capped)).toEqual([false, true]);
    expect(formatReasons(status.scaleSets[1]!, status.cap)).toEqual([
      '    50 queued: no reason given',
      "    held back by the control plane's 500-runner cap",
    ]);
  });

  describe('with the planner', () => {
    // A planner whose speculative count per label, and cues' of it, the
    // test sets.
    const planned = (
      counts: Record<string, number>,
      cues: Record<string, number> = {},
    ) => {
      const planner = new Planner({ labels: [], log: () => undefined });
      planner.speculative = (label, _, cue) =>
        (cue ? cues : counts)[label] ?? 0;
      return planner;
    };

    it("records whether a job's runner was started for a cue, a prediction or the job", async () => {
      const counts = { 'backmesh-ubuntu-2404-4vcpu': 1 };
      const cues = { 'backmesh-ubuntu-2404-4vcpu': 1 };
      const planner = planned(counts, cues);
      const env = setup([ROUTE], undefined, undefined, undefined, planner);
      const ids = () => env.anycloud.submitted.map((spec) => spec.id);
      env.sets[0]!.statistics = assigned(0);
      await env.scaler.reconcile();
      // A prediction joins the cue, whose idle runner still fills its slot.
      counts['backmesh-ubuntu-2404-4vcpu'] = 2;
      await env.scaler.reconcile();
      counts['backmesh-ubuntu-2404-4vcpu'] = cues[
        'backmesh-ubuntu-2404-4vcpu'
      ] = 0;
      env.sets[0]!.statistics = assigned(3);
      await env.scaler.reconcile();
      expect(ids()).toHaveLength(3);
      // Each runner takes a job; a fourth job's runner isn't this process's.
      for (const [i, runnerName] of [...ids(), 'other'].entries()) {
        const jobId = `job-${i}`;
        env.scaler.observe(
          env.sets[0]!,
          message('JobStarted', { jobId, runnerName }),
        );
        env.scaler.observe(
          env.sets[0]!,
          message('JobCompleted', { jobId, runnerName, result: 'succeeded' }),
        );
      }
      // The cue runner's Job ends before its row is written.
      env.anycloud.end(ids()[0]!, null);
      await env.scaler.reconcile();
      const rows = env.logs.filter((entry) => entry.msg === 'job completed');
      expect(rows.map((row) => [row.runner, row.start])).toEqual([
        [ids()[0], 'cue'],
        [ids()[1], 'predicted'],
        [ids()[2], 'reactive'],
        ['other', null],
      ]);
    });

    it('adds speculative runners to TotalAssignedJobs, and scales down idle ones when they expire', async () => {
      const counts = { 'backmesh-ubuntu-2404-4vcpu': 3 };
      const env = setup(
        [ROUTE],
        undefined,
        undefined,
        undefined,
        planned(counts),
      );
      env.sets[0]!.statistics = assigned(1);
      await env.scaler.reconcile();
      expect(env.anycloud.submitted).toHaveLength(4);
      expect(env.scaler.status().scaleSets[0]).toMatchObject({
        speculative: 3,
        capped: false,
      });

      // The slots expire: today's scale-down removes three idle runners.
      counts['backmesh-ubuntu-2404-4vcpu'] = 0;
      await env.scaler.reconcile();
      expect(env.anycloud.terminated).toHaveLength(3);
      expect(env.anycloud.live.size).toBe(1);
    });

    it('gives speculative runners only the room real jobs leave', async () => {
      const other = {
        ...ROUTE,
        label: 'backmesh-ubuntu-2404-8vcpu',
        code: 'a8',
      };
      const env = setup(
        [ROUTE, other],
        undefined,
        undefined,
        undefined,
        planned({ 'backmesh-ubuntu-2404-4vcpu': 5 }),
      );
      env.anycloud.control.others = 495;
      // backmesh-ubuntu-2404-4vcpu comes first, but backmesh-ubuntu-2404-8vcpu's 3 real jobs go before its
      // speculation: 2 of the 5 left.
      env.sets[0]!.statistics = assigned(0);
      env.sets[1]!.statistics = assigned(3);
      await env.scaler.reconcile();
      const codes = env.anycloud.submitted.map((spec) =>
        codeOf(INSTALL, spec.id),
      );
      expect(codes.filter((code) => code === 'a4')).toHaveLength(2);
      expect(codes.filter((code) => code === 'a8')).toHaveLength(3);
      // At the cap, speculation keeps the runners it has.
      await env.scaler.reconcile();
      expect(env.anycloud.terminated).toEqual([]);
      expect(env.sets.map((set) => set.capped)).toEqual([false, false]);
    });

    it("gives back speculative runners' room to other scale sets' real jobs", async () => {
      const other = {
        ...ROUTE,
        label: 'backmesh-ubuntu-2404-8vcpu',
        code: 'a8',
      };
      const env = setup(
        [ROUTE, other],
        undefined,
        undefined,
        undefined,
        planned({ 'backmesh-ubuntu-2404-4vcpu': 5 }),
      );
      env.anycloud.control.others = 495;
      env.sets[0]!.statistics = assigned(0);
      env.sets[1]!.statistics = assigned(0);
      await env.scaler.reconcile();
      expect(env.anycloud.live.size).toBe(5);
      // 3 real jobs on backmesh-ubuntu-2404-8vcpu at the cap: 3 idle speculative runners
      // go, and the next tick starts the real jobs' runners.
      env.sets[1]!.statistics = assigned(3);
      await env.scaler.reconcile();
      expect(env.anycloud.terminated).toHaveLength(3);
      await env.scaler.reconcile();
      const codes = [...env.anycloud.live.keys()].map((id) =>
        codeOf(INSTALL, id),
      );
      expect(codes.filter((code) => code === 'a8')).toHaveLength(3);
      expect(codes.filter((code) => code === 'a4')).toHaveLength(2);
    });

    it("leaves real jobs the tick's submissions first", async () => {
      const other = {
        ...ROUTE,
        label: 'backmesh-ubuntu-2404-8vcpu',
        code: 'a8',
      };
      const env = setup(
        [ROUTE, other],
        undefined,
        undefined,
        undefined,
        planned({ 'backmesh-ubuntu-2404-4vcpu': 60 }),
      );
      env.sets[0]!.statistics = assigned(0);
      env.sets[1]!.statistics = assigned(3);
      expect(await env.scaler.reconcile()).toBe(true);
      const codes = env.anycloud.submitted.map((spec) =>
        codeOf(INSTALL, spec.id),
      );
      expect(codes.filter((code) => code === 'a8')).toHaveLength(3);
      expect(codes.filter((code) => code === 'a4')).toHaveLength(47);
    });

    it("teaches the planner each label's boot from its runners' timelines", async () => {
      const planner = new Planner({
        labels: [ROUTE.label],
        log: () => undefined,
      });
      const env = setup([ROUTE], undefined, undefined, undefined, planner);
      // Both runners are submitted at 0 and running at 30 s (the fake's).
      env.sets[0]!.statistics = assigned(2);
      await env.scaler.reconcile();
      const [a, b] = env.anycloud.submitted.map((spec) => spec.id);
      const done = async (
        runnerName: string,
        queueTime: number,
        at: number,
      ) => {
        env.scaler.observe(
          env.sets[0]!,
          message('JobCompleted', {
            jobId: runnerName,
            runnerName,
            queueTime,
            runnerAssignTime: at,
            result: 'succeeded',
          }),
        );
        await env.scaler.reconcile();
      };
      // b's job queued after b was running, so b may have idled: only its
      // 30 s start counts, plus 8 s to register before any is measured.
      await done(b!, 40_000, 200_000);
      expect(planner.boot(ROUTE.label)).toBe(38_000);
      // a's job waited for it: it registered and took it 15 s after running.
      await done(a!, -1_000, 45_000);
      expect(planner.boot(ROUTE.label)).toBe(45_000);
    });

    it('feeds the planner every message and reports it in the status', async () => {
      const planner = new Planner({
        labels: [ROUTE.label],
        log: () => undefined,
      });
      const env = setup([ROUTE], undefined, undefined, undefined, planner);
      env.scaler.observe(
        env.sets[0]!,
        message('JobAvailable', {
          jobWorkflowRef: 'acme/app/.github/workflows/ci.yml@refs/heads/main',
        }),
      );
      const status = listenerStatusSchema.parse({
        installed: true,
        broker: null,
        ...env.scaler.status(),
      });
      // Heard of, with no run learned yet.
      expect(status.planner).toEqual({ keys: 0, guarded: 0, off: false });
      expect(formatPlanner(status.planner)).toEqual([]);
      expect(formatPlanner({ keys: 1, guarded: 0, off: false })).toEqual([
        'Planner: 1 workflow learned',
      ]);
      expect(formatPlanner({ keys: 3, guarded: 1, off: false })).toEqual([
        'Planner: 3 workflows learned, 1 reactive (predictions under 60 % right)',
      ]);
      expect(formatPlanner({ keys: 3, guarded: 0, off: true })).toEqual([
        'Planner: off after an error; scaling reactively',
      ]);
      expect(
        formatReasons({ ...status.scaleSets[0]!, speculative: 2 }, 500),
      ).toEqual(['    2 started ahead of predicted jobs']);
    });
  });

  describe('public repositories', () => {
    const PUBLIC4 = {
      ...ROUTE,
      label: 'backmesh-ubuntu-2404-public-4vcpu',
      code: 'c4',
      public: true,
    };
    const PUBLIC2 = {
      ...PUBLIC4,
      label: 'backmesh-ubuntu-2404-public-2vcpu',
      code: 'c2',
      vcpus: 2,
    };
    const gate = (held: Record<string, number>) => ({
      heldOn: (code: string) => held[code] ?? 0,
      holds: () => false,
      tick: async () => undefined,
    });

    it('starts no runner for the jobs the gate holds, and starts them once it lets them go', async () => {
      const held = { a4: 2 };
      const env = setup(
        [ROUTE],
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        gate(held),
      );
      env.sets[0]!.statistics = assigned(3);
      await env.scaler.reconcile();
      expect(env.anycloud.submitted).toHaveLength(1);
      held.a4 = 0;
      await env.scaler.reconcile();
      expect(env.anycloud.submitted).toHaveLength(3);
    });

    it('never shows the planner a job the gate holds', () => {
      const seen: string[] = [];
      const planner = new Planner({ labels: [], log: () => undefined });
      planner.observe = (_label, job) => void seen.push(job.jobId);
      const env = setup(
        [ROUTE],
        undefined,
        undefined,
        undefined,
        planner,
        undefined,
        undefined,
        {
          heldOn: () => 0,
          holds: (job) => job.jobId === 'fork',
          tick: async () => undefined,
        },
      );
      env.scaler.observe(
        env.sets[0]!,
        message('JobAssigned', { jobId: 'fork' }),
      );
      env.scaler.observe(
        env.sets[0]!,
        message('JobAssigned', { jobId: 'own' }),
      );
      expect(seen).toEqual(['own']);
    });

    it('holds the public sets to 32 vCPUs together, in capacity and in the runners it starts', async () => {
      const env = setup([PUBLIC4, PUBLIC2]);
      env.sets[0]!.statistics = assigned(10);
      env.sets[1]!.statistics = assigned(10);
      await settle(env.scaler);
      const vcpus = env.anycloud.submitted.reduce(
        (sum, spec) => sum + spec.vcpus,
        0,
      );
      expect(vcpus).toBe(32);
      expect(env.anycloud.submitted.filter((s) => s.vcpus === 4)).toHaveLength(
        8,
      );
      // The next listing has them.
      await env.scaler.reconcile();
      expect(env.anycloud.submitted).toHaveLength(8);
      // A set's capacity counts its own runners: the 4s hold the cap, so
      // the 2s get none.
      expect(env.scaler.capacity(env.sets[0]!)).toBe(8);
      expect(env.scaler.capacity(env.sets[1]!)).toBe(0);
      // A private set keeps the control plane's room.
      const mixed = setup([ROUTE, PUBLIC2]);
      expect(mixed.scaler.capacity(mixed.sets[0]!)).toBe(500);
      expect(mixed.scaler.capacity(mixed.sets[1]!)).toBe(16);
    });

    it('starts no speculative runners on a public set', async () => {
      const planner = new Planner({ labels: [], log: () => undefined });
      planner.speculative = () => 3;
      const env = setup([PUBLIC4], undefined, undefined, undefined, planner);
      env.sets[0]!.statistics = assigned(1);
      await env.scaler.reconcile();
      expect(env.anycloud.submitted).toHaveLength(1);
    });

    it('never asks the retry to rerun a reclaim on a public label', async () => {
      const asked: unknown[] = [];
      const env = setup([PUBLIC4], async (run) => {
        asked.push(run);
        return 'retry';
      });
      env.sets[0]!.statistics = assigned(1);
      await env.scaler.reconcile();
      const id = env.anycloud.submitted[0]!.id;
      const fields = { runnerName: id, result: 'Failed' };
      env.scaler.observe(env.sets[0]!, message('JobStarted', fields));
      env.scaler.observe(env.sets[0]!, message('JobCompleted', fields));
      env.sets[0]!.statistics = assigned(0);
      env.anycloud.end(id, 'reclaimed');
      await env.scaler.reconcile();
      expect(asked).toEqual([]);
      expect(env.notes.map((n) => n.note.title)).toEqual([
        'Rerun needed: a job lost a spot VM',
      ]);
    });
  });
});
