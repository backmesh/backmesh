import { describe, expect, it } from 'vitest';

import type { Note, WorkflowRun } from '../../../src/github/checks.js';
import type { GateGitHub, GateJob } from '../../../src/github/runs.js';
import { Planner } from '../../../src/listener/prewarm.js';
import {
  Gate,
  LIMIT_MS,
  SWEEP_MS,
  type GateDeps,
} from '../../../src/listener/gate.js';
import type { Route } from '../../../src/listener/routes.js';
import { message, ROUTE } from './fakes.js';

const KVM: Route = {
  ...ROUTE,
  label: 'backmesh-ubuntu-2404-kvm-4vcpu',
  code: 'k4',
  kvm: true,
};
const PUBLIC: Route = {
  ...ROUTE,
  label: 'backmesh-ubuntu-2404-public-4vcpu',
  code: 'c4',
  public: true,
};
const pr = (type: Parameters<typeof message>[0], fields = {}) =>
  message(type, { eventName: 'pull_request', ...fields });

// A fake GitHub whose `acme/app` is public and whose run 7 is a fork's,
// unless a test says otherwise.
function setup(github: Partial<GateGitHub> = {}, deps: Partial<GateDeps> = {}) {
  const calls: string[] = [];
  const reasons: string[] = [];
  const notes: Note[] = [];
  const terminated: string[] = [];
  const logs: string[] = [];
  let changed = 0;
  const replayed: string[] = [];
  const clock = { now: 0 };
  const read = (name: string, value: () => unknown) => async () => {
    calls.push(name);
    return value();
  };
  const fake: GateGitHub = {
    run: read('run', () => ({
      private: false,
      fork: true,
    })) as GateGitHub['run'],
    // Through the Worker's /v1/cancel, with why (owner, 2026-11-19).
    forceCancel: async ({ runId }: WorkflowRun, reason) => {
      calls.push(`cancel ${runId}`);
      reasons.push(reason);
    },
    repos: async () => [],
    activeRuns: async () => [],
    jobs: async () => [],
    ...github,
  };
  const gate = new Gate({
    github: fake,
    note: async (_run, note) => void notes.push(note),
    terminate: async (runner) => void terminated.push(runner),
    privateRunner: (name) => name.startsWith('bmabc12-k4-'),
    publicRunner: (name) => name.startsWith('bmabc12-c4-'),
    privateLabels: new Set([ROUTE.label, KVM.label]),
    publicLabels: [PUBLIC.label],
    changed: () => changed++,
    replay: (label, job) =>
      void replayed.push(`${label} ${job.messageType} ${job.jobId}`),
    log: (entry) => void logs.push(entry.msg),
    now: () => clock.now,
    ...deps,
  });
  // Lets the gate's reads answer.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    gate,
    calls,
    reasons,
    notes,
    terminated,
    logs,
    clock,
    settle,
    changed: () => changed,
    replayed,
  };
}

describe('Gate', () => {
  it('trusts non-PR events and public labels without a read', async () => {
    const { gate, calls, settle } = setup();
    gate.observe(KVM, message('JobAssigned', { eventName: 'push' }));
    gate.observe(PUBLIC, pr('JobAssigned'));
    await settle();
    expect(calls).toEqual([]);
    expect(gate.heldOn(KVM.code)).toBe(0);
    expect(gate.heldOn(PUBLIC.code)).toBe(0);
  });

  it("trusts a private repo's PR from the sweep's listing, with no run read, and from the run read before it", async () => {
    const { gate, calls, settle, changed } = setup({
      repos: async () => [{ owner: 'acme', repo: 'app', private: true }],
      run: async () => {
        calls.push('run');
        return { private: true, fork: true };
      },
    });
    // Before any sweep: the run read says private.
    gate.observe(KVM, pr('JobAssigned'));
    expect(gate.heldOn(KVM.code)).toBe(1);
    await settle();
    expect(gate.heldOn(KVM.code)).toBe(0);
    expect(changed()).toBe(1);
    await gate.tick();
    gate.observe(KVM, pr('JobAssigned', { workflowRunId: 8 }));
    await settle();
    expect(calls).toEqual(['run']);
    expect(gate.heldOn(KVM.code)).toBe(0);
  });

  it('trusts a same-repo PR in a public repo after one run read', async () => {
    const { gate, calls, settle, notes } = setup({
      run: async () => {
        calls.push('run');
        return { private: false, fork: false };
      },
    });
    gate.observe(KVM, pr('JobAssigned'));
    gate.observe(KVM, pr('JobAssigned', { jobId: 'job-2' }));
    expect(gate.heldOn(KVM.code)).toBe(2);
    await settle();
    expect(gate.heldOn(KVM.code)).toBe(0);
    expect(calls).toEqual(['run']);
    expect(notes).toEqual([]);
  });

  it("holds a fork run's jobs until they complete, cancels it once with a note, and ends a runner that starts one", async () => {
    const { gate, calls, settle, notes, terminated, logs, clock } = setup();
    gate.observe(KVM, pr('JobAssigned'));
    await settle();
    expect(calls).toEqual(['run', 'cancel 7']);
    expect(notes).toEqual([
      {
        name: 'fork run 7',
        title: 'Fork run cancelled',
        summary:
          '`test` asked for `backmesh-ubuntu-2404-kvm-4vcpu`. In this public repository, pull requests from forks run only on `backmesh-ubuntu-2404-public-4vcpu`, so backmesh cancelled the run. Use one of them, or a GitHub-hosted runner.',
      },
    ]);
    expect(gate.holds(pr('JobAssigned'))).toBe(true);
    // An idle runner of the set took it before the cancel landed.
    clock.now = 10_000;
    gate.observe(KVM, pr('JobStarted', { runnerName: 'bmabc12-k4-00000001' }));
    await settle();
    expect(terminated).toEqual(['bmabc12-k4-00000001']);
    expect(logs).toContain('untrusted job on a private label');
    // Within the minute, no second cancel.
    expect(calls.filter((c) => c.startsWith('cancel'))).toHaveLength(1);
    expect(gate.heldOn(KVM.code)).toBe(1);
    gate.observe(KVM, pr('JobCompleted', { result: 'canceled' }));
    expect(gate.heldOn(KVM.code)).toBe(0);
  });

  it("counts a cancelled run's jobs again 2 minutes after the cancel, with no JobCompleted", async () => {
    const { gate, settle, clock } = setup();
    gate.observe(KVM, pr('JobAssigned'));
    await settle();
    clock.now = 2 * 60_000 - 1;
    await gate.tick();
    expect(gate.heldOn(KVM.code)).toBe(1);
    clock.now = 2 * 60_000;
    await gate.tick();
    expect(gate.heldOn(KVM.code)).toBe(0);
  });

  it('ends a runner that started a fork job before the read answered', async () => {
    const { gate, settle, terminated } = setup();
    gate.observe(KVM, pr('JobAssigned'));
    gate.observe(KVM, pr('JobStarted', { runnerName: 'bmabc12-k4-00000001' }));
    await settle();
    expect(terminated).toEqual(['bmabc12-k4-00000001']);
  });

  it('keeps jobs held while reads fail, and reads again each tick', async () => {
    let fail = true;
    const { gate, settle, logs, changed } = setup({
      run: async () => {
        if (fail) throw new Error('502');
        return { private: false, fork: false };
      },
    });
    gate.observe(KVM, pr('JobAssigned'));
    await settle();
    expect(gate.heldOn(KVM.code)).toBe(1);
    expect(logs).toContain('run read failed; its pull-request jobs wait');
    fail = false;
    await gate.tick();
    expect(gate.heldOn(KVM.code)).toBe(0);
    expect(changed()).toBe(1);
  });

  it('keeps a fork run held and its runners ended when the cancel is refused', async () => {
    const { gate, settle, terminated, logs, notes } = setup({
      forceCancel: async () => {
        throw new Error('403 Resource not accessible by integration');
      },
    });
    gate.observe(KVM, pr('JobAssigned'));
    gate.observe(KVM, pr('JobStarted', { runnerName: 'bmabc12-k4-00000001' }));
    await settle();
    expect(logs).toContain('fork run cancel failed');
    expect(notes).toEqual([]);
    expect(terminated).toEqual(['bmabc12-k4-00000001']);
    expect(gate.heldOn(KVM.code)).toBe(1);
  });

  it("sweeps public repos' fork runs that messages missed, every 5 minutes", async () => {
    const jobs: Record<number, GateJob[]> = {
      // On a private label, started by this install's runner.
      7: [
        {
          name: 'build',
          labels: ['backmesh-ubuntu-2404-kvm-4vcpu'],
          runnerName: 'bmabc12-k4-00000001',
          startedAt: 0,
          done: false,
        },
      ],
      // Only on the public label.
      8: [
        {
          name: 'lint',
          labels: ['backmesh-ubuntu-2404-public-4vcpu'],
          runnerName: 'bmabc12-c4-00000002',
          startedAt: 0,
          done: false,
        },
      ],
    };
    const { gate, calls, terminated, notes, clock } = setup({
      repos: async () => [
        { owner: 'acme', repo: 'app', private: false },
        // Never swept.
        { owner: 'acme', repo: 'secret', private: true },
      ],
      activeRuns: async () => [
        { runId: 7, fork: true },
        { runId: 8, fork: true },
        { runId: 9, fork: false },
      ],
      jobs: async ({ runId }) => {
        calls.push(`jobs ${runId}`);
        return jobs[runId] ?? [];
      },
    });
    await gate.tick();
    expect(calls).toEqual(['jobs 7', 'cancel 7', 'jobs 8']);
    expect(terminated).toEqual(['bmabc12-k4-00000001']);
    expect(notes.map((n) => n.summary)).toEqual([
      expect.stringContaining(
        '`build` asked for `backmesh-ubuntu-2404-kvm-4vcpu`',
      ),
    ]);
    clock.now = SWEEP_MS - 1;
    await gate.tick();
    expect(calls).toHaveLength(3);
    clock.now = SWEEP_MS;
    await gate.tick();
    expect(calls.filter((c) => c === 'jobs 7')).toHaveLength(2);
  });

  it("replays a trusted run's held messages to the planner in order, and never an untrusted run's", async () => {
    const { gate, settle, replayed } = setup({
      run: async ({ runId }) => ({ private: false, fork: runId === 8 }),
    });
    gate.observe(KVM, pr('JobAssigned'));
    gate.observe(KVM, pr('JobAssigned', { jobId: 'job-2' }));
    gate.observe(KVM, pr('JobCompleted', { jobId: 'job-2' }));
    expect(gate.holds(pr('JobAssigned'))).toBe(true);
    gate.observe(KVM, pr('JobAssigned', { workflowRunId: 8 }));
    await settle();
    expect(replayed).toEqual([
      'backmesh-ubuntu-2404-kvm-4vcpu JobAssigned job-1',
      'backmesh-ubuntu-2404-kvm-4vcpu JobAssigned job-2',
      'backmesh-ubuntu-2404-kvm-4vcpu JobCompleted job-2',
    ]);
    // Classified trusted, its later messages go to the planner directly.
    expect(gate.holds(pr('JobStarted'))).toBe(false);
    expect(gate.holds(pr('JobStarted', { workflowRunId: 8 }))).toBe(true);
    // A completion of a run it never heard of isn't held.
    gate.observe(KVM, pr('JobCompleted', { workflowRunId: 9 }));
    expect(gate.holds(pr('JobCompleted', { workflowRunId: 9 }))).toBe(false);
  });

  it('forgets visibility when the listing fails, and reads a run again once its repo turns public', async () => {
    let listing: { owner: string; repo: string; private: boolean }[] | Error = [
      { owner: 'acme', repo: 'app', private: true },
    ];
    const { gate, calls, clock, settle } = setup({
      repos: async () => {
        if (listing instanceof Error) throw listing;
        return listing;
      },
      run: async () => {
        calls.push('run');
        return { private: false, fork: true };
      },
    });
    await gate.tick();
    gate.observe(KVM, pr('JobAssigned'));
    await settle();
    expect(calls).toEqual([]);
    // The move made it public: the trusted run is read again.
    listing = [{ owner: 'acme', repo: 'app', private: false }];
    clock.now = SWEEP_MS;
    await gate.tick();
    gate.observe(KVM, pr('JobAssigned'));
    await settle();
    expect(calls).toEqual(['run', 'cancel 7']);
    // A failed listing trusts no repository from the last one, even one it
    // listed as private.
    listing = [{ owner: 'acme', repo: 'app', private: true }];
    clock.now = 2 * SWEEP_MS;
    await gate.tick();
    listing = new Error('502');
    clock.now = 3 * SWEEP_MS;
    await gate.tick();
    gate.observe(KVM, pr('JobAssigned', { workflowRunId: 8 }));
    await settle();
    expect(calls.filter((c) => c === 'run')).toHaveLength(2);
  });

  // The Worker's own clock may be a little behind; its refusal says it
  // didn't see the limit, which isn't a refusal for good.
  it('tries a cancel the Worker found not yet due again after a minute', async () => {
    let early = true;
    const { gate, calls, clock, settle } = setup({
      forceCancel: async () => {
        calls.push('cancel');
        if (early) {
          throw Object.assign(new Error('not yet'), {
            status: 403,
            code: 'not_gated',
          });
        }
      },
    });
    gate.observe(KVM, pr('JobAssigned'));
    await settle();
    early = false;
    clock.now = 60_000;
    gate.observe(KVM, pr('JobAssigned', { jobId: 'job-2' }));
    await settle();
    expect(calls.filter((c) => c === 'cancel')).toHaveLength(2);
  });

  it('tries a cancel GitHub failed for another reason again after a minute', async () => {
    let fail = true;
    const { gate, calls, clock, settle } = setup({
      forceCancel: async () => {
        calls.push('cancel');
        if (fail) throw Object.assign(new Error('502'), { status: 502 });
      },
    });
    gate.observe(KVM, pr('JobAssigned'));
    await settle();
    fail = false;
    clock.now = 60_000;
    gate.observe(KVM, pr('JobAssigned', { jobId: 'job-2' }));
    await settle();
    expect(calls.filter((c) => c === 'cancel')).toHaveLength(2);
  });

  it('tries a refused cancel once per run', async () => {
    const { gate, calls, clock, settle, logs } = setup({
      forceCancel: async () => {
        calls.push('cancel');
        throw Object.assign(new Error('Resource not accessible'), {
          status: 403,
        });
      },
    });
    gate.observe(KVM, pr('JobAssigned'));
    await settle();
    clock.now = 10 * 60_000;
    gate.observe(KVM, pr('JobAssigned', { jobId: 'job-2' }));
    await settle();
    expect(calls.filter((c) => c === 'cancel')).toHaveLength(1);
    expect(logs.filter((m) => m === 'fork run cancel failed')).toHaveLength(1);
  });

  it("goes on to a repo's other runs when one run's jobs can't be read", async () => {
    const { gate, calls } = setup({
      repos: async () => [{ owner: 'acme', repo: 'app', private: false }],
      activeRuns: async () => [
        { runId: 7, fork: true },
        { runId: 8, fork: true },
      ],
      jobs: async ({ runId }) => {
        if (runId === 7) throw new Error('502');
        return [
          {
            name: 'build',
            labels: ['backmesh-ubuntu-2404-kvm-4vcpu'],
            runnerName: null,
            startedAt: null,
            done: false,
          },
        ];
      },
    });
    await gate.tick();
    expect(calls).toEqual(['cancel 8']);
  });

  it("lets a same-repo PR's run reach the planner after the read: its children start when build does", async () => {
    let clock = -3_600_000;
    const planner = new Planner({
      labels: [KVM.label],
      log: () => undefined,
      now: () => clock,
    });
    clock = 0;
    const ref = 'acme/app/.github/workflows/ci.yml@refs/heads/feature';
    // build waits 71 s and runs 100 s; two tests queue 2 s after it.
    const run = (id: number, t: number) => {
      const job = (
        name: string,
        i: number,
        q: number,
        start: number,
        end: number,
      ) => {
        const fields = {
          workflowRunId: id,
          jobId: `${id}-${i}`,
          jobDisplayName: name,
          jobWorkflowRef: ref,
          queueTime: (t + q) * 1000,
        };
        return [
          { at: t + q, job: pr('JobAssigned', fields) },
          {
            at: t + start,
            job: pr('JobStarted', {
              ...fields,
              runnerAssignTime: (t + start) * 1000,
            }),
          },
          {
            at: t + end,
            job: pr('JobCompleted', {
              ...fields,
              finishTime: (t + end) * 1000,
              result: 'Succeeded',
            }),
          },
        ];
      };
      return [
        ...job('build', 0, 0, 71, 171),
        ...job('test (0)', 1, 173, 251, 371),
        ...job('test (1)', 2, 173, 251, 371),
      ].sort((a, b) => a.at - b.at);
    };
    for (const { at, job } of run(1, 0))
      planner.observe(KVM.label, job, at * 1000);
    const { gate: replaying, settle } = setup(
      { run: async () => ({ private: false, fork: false }) },
      { replay: (label, job) => planner.observe(label, job, clock) },
    );
    // The next run, through the gate as the listener hears it.
    const t = 600;
    const [assigned, started] = run(2, t);
    clock = t * 1000;
    for (const { job } of [assigned!]) {
      replaying.observe(KVM, job);
      if (!replaying.holds(job)) planner.observe(KVM.label, job, clock);
    }
    await settle();
    clock = started!.at * 1000;
    replaying.observe(KVM, started!.job);
    expect(replaying.holds(started!.job)).toBe(false);
    planner.observe(KVM.label, started!.job, clock);
    expect(planner.speculative(KVM.label, clock)).toBe(2);
  });

  it("tells the Worker why it cancels: a label that isn't public, or the runtime limit", async () => {
    const { gate, reasons, settle, clock } = setup();
    gate.observe(KVM, pr('JobAssigned'));
    await settle();
    gate.observe(
      PUBLIC,
      pr('JobStarted', {
        workflowRunId: 8,
        runnerName: 'bmabc12-c4-00000008',
      }),
    );
    await settle();
    clock.now = LIMIT_MS;
    await gate.tick();
    expect(reasons).toEqual(['label', 'limit']);
  });

  describe('the runtime limit', () => {
    it('ends a later job of a run past the limit as soon as it starts', async () => {
      const { gate, terminated, settle, clock } = setup();
      gate.observe(
        PUBLIC,
        pr('JobStarted', { runnerName: 'bmabc12-c4-00000007' }),
      );
      await settle();
      clock.now = LIMIT_MS;
      await gate.tick();
      clock.now = LIMIT_MS + 60_000;
      gate.observe(
        PUBLIC,
        pr('JobStarted', { jobId: 'job-2', runnerName: 'bmabc12-c4-0000000c' }),
      );
      await settle();
      expect(terminated).toContain('bmabc12-c4-0000000c');
    });

    const started = (runId = 7) =>
      pr('JobStarted', {
        workflowRunId: runId,
        runnerName: `bmabc12-c4-0000000${runId}`,
      });

    it("cancels an untrusted run's public job at 60 minutes, then ends its runner 5 minutes on", async () => {
      const { gate, calls, notes, terminated, settle, clock } = setup();
      gate.observe(PUBLIC, started());
      await settle();
      // On a public label alone: nothing to cancel yet, nothing held.
      expect(calls).toEqual(['run']);
      expect(gate.heldOn(PUBLIC.code)).toBe(0);
      clock.now = LIMIT_MS - 1;
      await gate.tick();
      expect(calls).not.toContain('cancel 7');
      clock.now = LIMIT_MS;
      await gate.tick();
      expect(calls).toContain('cancel 7');
      expect(notes.at(-1)).toEqual({
        name: 'runtime limit in run 7',
        title: 'Runtime limit',
        summary:
          '`test` ran on `backmesh-ubuntu-2404-public-4vcpu` for 60 minutes, the limit for pull requests from forks, so backmesh cancelled the run.',
      });
      clock.now = LIMIT_MS + 5 * 60_000;
      await gate.tick();
      expect(terminated).toEqual(['bmabc12-c4-00000007']);
    });

    it('never times a trusted run, or a job that completed', async () => {
      const { gate, calls, clock, settle } = setup({
        run: async ({ runId }) => {
          calls.push('run');
          return { private: false, fork: runId === 8 };
        },
      });
      gate.observe(PUBLIC, started(7));
      gate.observe(PUBLIC, started(8));
      gate.observe(
        PUBLIC,
        pr('JobCompleted', {
          workflowRunId: 8,
          runnerName: 'bmabc12-c4-00000008',
        }),
      );
      await settle();
      clock.now = 2 * LIMIT_MS;
      await gate.tick();
      expect(calls.filter((c) => c.startsWith('cancel'))).toEqual([]);
    });

    it("times a fork job a restart lost from the sweep's started_at", async () => {
      const { gate, calls, clock, terminated } = setup({
        repos: async () => [{ owner: 'acme', repo: 'app', private: false }],
        activeRuns: async () => [{ runId: 7, fork: true }],
        jobs: async () => [
          {
            name: 'sleep',
            labels: ['backmesh-ubuntu-2404-public-4vcpu'],
            runnerName: 'bmabc12-c4-00000007',
            startedAt: -30 * 60_000,
            done: false,
          },
        ],
      });
      // The new listener's first tick, 30 minutes into the job.
      await gate.tick();
      expect(calls).toEqual([]);
      clock.now = 30 * 60_000;
      await gate.tick();
      expect(calls).toEqual(['cancel 7']);
      clock.now = 35 * 60_000;
      await gate.tick();
      expect(terminated).toEqual(['bmabc12-c4-00000007']);
    });

    it("keeps a sweep-seeded clock when the runner's JobStarted comes later", async () => {
      const { gate, calls, clock, settle, logs } = setup({
        repos: async () => [{ owner: 'acme', repo: 'app', private: false }],
        activeRuns: async () => [{ runId: 7, fork: true }],
        jobs: async () => [
          {
            name: 'sleep',
            labels: ['backmesh-ubuntu-2404-public-4vcpu'],
            runnerName: 'bmabc12-c4-00000007',
            startedAt: -30 * 60_000,
            done: false,
          },
        ],
      });
      await gate.tick();
      expect(logs).toContain('runtime limit timed from the sweep');
      // A redelivered JobStarted, assigned 30 minutes ago by GitHub's clock.
      clock.now = 10 * 60_000;
      gate.observe(
        PUBLIC,
        pr('JobStarted', {
          runnerName: 'bmabc12-c4-00000007',
          runnerAssignTime: clock.now,
        }),
      );
      await settle();
      clock.now = 30 * 60_000;
      await gate.tick();
      expect(calls).toContain('cancel 7');
    });

    it('ends every public runner of the run at the grace, with one cancel, logged as the limit', async () => {
      const { gate, calls, clock, settle, terminated, logs } = setup();
      gate.observe(PUBLIC, started());
      clock.now = 20 * 60_000;
      gate.observe(
        PUBLIC,
        pr('JobStarted', { jobId: 'job-2', runnerName: 'bmabc12-c4-0000000b' }),
      );
      await settle();
      clock.now = LIMIT_MS;
      await gate.tick();
      clock.now = LIMIT_MS + 5 * 60_000;
      await gate.tick();
      expect(terminated.sort()).toEqual([
        'bmabc12-c4-00000007',
        'bmabc12-c4-0000000b',
      ]);
      expect(calls.filter((c) => c.startsWith('cancel'))).toEqual(['cancel 7']);
      expect(logs).toContain('runtime limit terminate');
      expect(logs).not.toContain('untrusted job on a private label');
    });
  });
});
