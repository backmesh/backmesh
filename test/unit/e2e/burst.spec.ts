import { describe, expect, it } from 'vitest';

import {
  burstStats,
  burstSummary,
  burstWorkflow,
  type BurstJob,
} from '../../../test/e2e/burst.ts';

const job = (
  name: string,
  queued: number,
  assigned: number,
  marker: number,
  conclusion = 'success',
): BurstJob => ({
  name,
  runner_name: 'r',
  conclusion,
  created_at: new Date(queued * 1000).toISOString(),
  started_at: new Date(assigned * 1000).toISOString(),
  marker: new Date(marker * 1000).toISOString(),
});

describe('burstWorkflow', () => {
  it('runs the jobs round-robin over the labels on a burst/** push, none cancelling the rest', () => {
    const w = JSON.parse(burstWorkflow(['a', 'b'], 3)) as {
      on: unknown;
      jobs: Record<string, { strategy?: unknown; needs?: string }>;
    };
    expect(w.on).toEqual({ push: { branches: ['burst/**'] } });
    expect(w.jobs.burst!.strategy).toEqual({
      'fail-fast': false,
      matrix: {
        include: [
          { i: 0, label: 'a' },
          { i: 1, label: 'b' },
          { i: 2, label: 'a' },
        ],
      },
    });
    expect(w.jobs.report!.needs).toBe('burst');
  });
});

describe('burstStats', () => {
  it('has per label and in all the failed jobs and nearest-rank p50 and p90', () => {
    const jobs = [
      ...Array.from({ length: 10 }, (_, i) =>
        job(`burst ${i} a`, 0, i + 1, i + 11),
      ),
      job('burst 10 b', 0, 50, 60, 'failure'),
    ];
    const stats = burstStats(jobs);
    expect(stats.labels.a).toEqual({
      jobs: 10,
      failed: 0,
      queuedToAssigned: { p50: 5, p90: 9, max: 10 },
      queuedToFirstStep: { p50: 15, p90: 19, max: 20 },
    });
    expect(stats.all.failed).toBe(1);
    expect(stats.all.queuedToFirstStep.max).toBe(60);
    expect(burstSummary(stats)).toContain(
      '| All | 11 | 1 | 6 / 10 | 16 / 20 / 60 |',
    );
  });
});
