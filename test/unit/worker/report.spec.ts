import { describe, expect, it } from 'vitest';

import { QUERIES } from '../../../worker/scripts/report.ts';
import { testDb } from './fakes.js';

const NOW = Date.UTC(2026, 11, 1);
const DAY = 86_400_000;

// Runs each report query, as the workflow does, over seeded events.
async function report(
  events: [org: number, install: string, details: object, ageDays?: number][],
) {
  const db = testDb();
  let n = 0;
  for (const [org, install, details, age = 1] of events) {
    await db
      .prepare(
        'INSERT OR IGNORE INTO installs (id, org, key_hash, created_at, disowned, revoked) VALUES (?, ?, ?, 0, ?, 0)',
      )
      .bind(install, org, `hash-${install}`, install === 'gone' ? 1 : 0)
      .run();
    await db
      .prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)')
      .bind(
        org,
        `job-${++n}`,
        install,
        '0.1.7',
        NOW - age * DAY,
        JSON.stringify(details),
      )
      .run();
  }
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const { title, sql } of QUERIES) {
    out[title] = (
      await db
        .prepare(sql)
        .bind(NOW - 30 * DAY)
        .all<Record<string, unknown>>()
    ).results;
  }
  return out;
}

const job = (over: object = {}) => ({
  cloud: 'aws',
  region: 'us-east-2',
  vm_type: 'm7a.4xlarge',
  capacity: 'spot',
  queued_ms: 1_000,
  boot_ms: null,
  features: [],
  ...over,
});

describe('telemetry report', () => {
  it('aggregates the last 30 days without naming an org or install', async () => {
    const out = await report([
      [1, 'a', job({ queued_ms: 1_000 })],
      [1, 'a', job({ queued_ms: 2_000, features: ['retry-on-demand'] })],
      [
        2,
        'b',
        job({
          cloud: 'gcp',
          region: 'us-central1',
          vm_type: 'n2d-standard-16',
          capacity: 'on-demand',
          queued_ms: 9_000,
        }),
      ],
      [3, 'c', job({ queued_ms: 100_000 }), 31],
      // A disowned install's events don't count.
      [4, 'gone', job()],
    ]);

    expect(out['Active orgs and installs']).toEqual([
      { orgs: 2, installs: 2, jobs: 3 },
    ]);
    expect(out['Jobs by cloud, region and VM type']).toEqual([
      {
        cloud: 'aws',
        region: 'us-east-2',
        vm_type: 'm7a.4xlarge',
        jobs: 2,
      },
      {
        cloud: 'gcp',
        region: 'us-central1',
        vm_type: 'n2d-standard-16',
        jobs: 1,
      },
    ]);
    expect(out['Spot and on-demand']).toEqual([
      { capacity: 'spot', jobs: 2, percent: 66.7 },
      { capacity: 'on-demand', jobs: 1, percent: 33.3 },
    ]);
    expect(out['Retry on demand in use']).toEqual([{ installs: 1, jobs: 1 }]);
    expect(out['Runner boot (ms)']).toEqual([]);
    const text = JSON.stringify(out);
    for (const id of ['"org"', '"install"']) expect(text).not.toContain(id);
  });

  it('computes p50 and p95 per cloud', async () => {
    const out = await report(
      Array.from(
        { length: 100 },
        (_, i) =>
          [1, 'a', job({ queued_ms: (i + 1) * 10 })] as [
            number,
            string,
            object,
          ],
      ),
    );

    expect(out['Queue time (ms), GitHub queued to runner assigned']).toEqual([
      { cloud: 'aws', jobs: 100, p50: 500, p95: 950 },
    ]);
  });
});
