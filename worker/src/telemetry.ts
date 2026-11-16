// Per-launch telemetry: the event intake, for product and capacity
// planning and support. Nothing here counts toward or blocks anything.
import { z } from 'zod';

import type { D1Database, Env } from './index.js';

const DAY = 86_400_000;
// A started_at outside [now - 35 days, now] is clamped to now, so a late
// batch still counts and a future date can't keep an event past retention.
const CLAMP = 35 * DAY;
const RETENTION = 90 * DAY;

// One job started. The org and install come from the install key, never
// from the event. Fields the listener doesn't know are null. Nothing names a
// repository, workflow, job, branch or commit, or comes from the job's run.
const name = z.string().max(64).nullable();
export const eventSchema = z.strictObject({
  id: z.string().regex(/^[0-9a-f]{64}$/),
  version: z.string().max(64),
  started_at: z.iso.datetime({ offset: true }),
  cloud: z.enum(['aws', 'gcp', 'azure']).nullable(),
  region: name,
  vm_type: name,
  capacity: z.enum(['spot', 'on-demand']).nullable(),
  label: name,
  queued_ms: z.number().int().nonnegative().nullable(),
  boot_ms: z.number().int().nonnegative().nullable(),
  // Launches the cloud refused, for quota or capacity, before the runner's VM
  // ran in another region or on another type. Listeners before region failover
  // don't send it.
  launch_refusals: z.number().int().nonnegative().nullable().optional(),
  // Known feature names only, so nothing else can ride along.
  features: z.array(z.enum(['retry-on-demand'])).max(10),
});
const batchSchema = z.object({ events: z.array(eventSchema).min(1).max(100) });

// POST /v1/events: a batch of job-started events from one install.
export async function intake(
  request: Request,
  env: Env,
  install: { id: string; org: number },
  now = Date.now(),
): Promise<Response> {
  const parsed = batchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: z.prettifyError(parsed.error) },
      { status: 400 },
    );
  }
  const rows = parsed.data.events.map(
    ({ id, version, started_at, ...details }) => {
      const at = Date.parse(started_at);
      const startedAt = at > now || at < now - CLAMP ? now : at;
      return [id, version, startedAt, JSON.stringify(details)];
    },
  );
  await env.DB.prepare(
    `INSERT OR IGNORE INTO events
     SELECT ?, json_extract(value, '$[0]'), ?, json_extract(value, '$[1]'),
       json_extract(value, '$[2]'), json_extract(value, '$[3]')
     FROM json_each(?)`,
  )
    .bind(install.org, install.id, JSON.stringify(rows))
    .run();
  return Response.json({ accepted: rows.length });
}

// Daily (the cron): folds raw events older than 90 days into per-day
// counts by org and install, which are kept.
export async function retain(db: D1Database, now = Date.now()) {
  const cutoff = now - RETENTION;
  await db.batch([
    db
      .prepare(
        `INSERT INTO daily_counts
         SELECT date(started_at / 1000, 'unixepoch'), org, install, count(*)
         FROM events WHERE started_at < ? GROUP BY 1, 2, 3
         ON CONFLICT DO UPDATE SET jobs = jobs + excluded.jobs`,
      )
      .bind(cutoff),
    db.prepare('DELETE FROM events WHERE started_at < ?').bind(cutoff),
  ]);
}
