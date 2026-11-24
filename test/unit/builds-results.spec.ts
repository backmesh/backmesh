import { describe, expect, it } from 'vitest';

import {
  figures,
  mannWhitney,
  type Job,
} from '../../benchmarks/builds/results.ts';

const us = (iso: string) => Date.parse(iso) * 1000;
const job = (marks: Record<string, number>): Job => ({
  id: 1,
  url: '',
  conclusion: 'success',
  runner: null,
  createdAt: '2026-11-22T10:00:00Z',
  startedAt: '2026-11-22T10:00:30Z',
  completedAt: '2026-11-22T10:01:40Z',
  steps: [
    { name: 'Marks', startedAt: '2026-11-22T10:00:40Z', completedAt: null },
  ],
  marks,
  cache: [],
  nproc: 4,
  region: null,
  vm: null,
});

describe('build benchmark figures', () => {
  it('splits the wait into pieces from the queueing', () => {
    const f = figures(
      job({
        submitted: us('2026-11-22T10:00:02Z'),
        vm_booted: us('2026-11-22T10:00:10Z'),
        container_started: us('2026-11-22T10:00:25Z'),
        runner_listening: us('2026-11-22T10:00:28Z'),
        job_received: us('2026-11-22T10:00:32Z'),
        restore_waited: us('2026-11-22T10:00:35Z'),
      }),
    );
    expect(f).toEqual({
      wait: 40,
      build: 60,
      total: 100,
      segments: {
        listener: 2,
        vm: 8,
        container: 15,
        runner: 3,
        assigned: 2,
        setUpJob: 2,
        cacheHold: 3,
        toFirstStep: 5,
      },
    });
  });

  it('counts pieces before the queueing as 0, and GitHub has only its own', () => {
    const early = figures(
      job({
        submitted: us('2026-11-22T09:58:00Z'),
        vm_booted: us('2026-11-22T09:58:10Z'),
        runner_listening: us('2026-11-22T09:58:40Z'),
      }),
    )!;
    expect(early.segments).toMatchObject({
      listener: 0,
      vm: 0,
      runner: 0,
      assigned: 30,
    });
    expect(figures(job({}))!.segments).toEqual({
      assigned: 30,
      toFirstStep: 10,
    });
  });

  it('has no figures for a failed job', () => {
    expect(figures({ ...job({}), conclusion: 'failure' })).toBeNull();
  });
});

describe('mannWhitney', () => {
  it('matches the tie-corrected normal approximation', () => {
    // U = 5; ties of 3 and 2 make the variance 25/12 × (11 − 30/90).
    expect(mannWhitney([1, 2, 2, 3, 5], [2, 4, 4, 6, 7])).toBeCloseTo(
      0.1376,
      3,
    );
    expect(mannWhitney([1, 2, 3], [4, 5, 6])).toBeCloseTo(0.0809, 3);
    expect(mannWhitney([4, 5, 6], [1, 2, 3])).toBeCloseTo(0.0809, 3);
    expect(mannWhitney([1, 2], [1, 2])).toBeCloseTo(1, 5);
  });
});
