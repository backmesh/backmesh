import { describe, expect, it } from 'vitest';

import { drain, type DrainDeps } from '../../../src/listener/drain.js';
import { assigned, setup } from './fakes.js';

const deps = (scaler: DrainDeps['scaler']): DrainDeps => ({
  scaler,
  log: () => undefined,
  sleep: async () => undefined,
});

describe('drain', () => {
  it('drains the runner Jobs to zero', async () => {
    const { anycloud, github, scaler, sets } = setup();
    sets[0]!.statistics = assigned(2);
    await scaler.reconcile();
    const [busy, idle] = anycloud.submitted.map((spec) => spec.id);
    github.busy.add(busy!);
    const counts: number[] = [];

    const status = await drain(deps(scaler), (n) => counts.push(n));

    // Idle first, by scale-down; the busy runner's Job is terminated after.
    expect(github.calls).toContain(`remove ${idle}`);
    expect(anycloud.terminated).toEqual([idle, busy]);
    expect(counts).toEqual([2, 0]);
    expect(status).toEqual({ state: 'done', runnerJobs: 0, error: null });
  });

  it('fails with the error when the count fails', async () => {
    const status = await drain(
      deps({
        drain: async () => {
          throw new Error('API down');
        },
      }),
      () => undefined,
    );
    expect(status).toEqual({
      state: 'failed',
      runnerJobs: 0,
      error: 'Error: API down',
    });
  });
});
