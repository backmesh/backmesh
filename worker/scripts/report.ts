// The telemetry report for .github/workflows/telemetry-report.yml: fixed,
// read-only queries over the last 30 days of job-started events, written as
// aggregates only (no org or install is named). The telemetry page's "How we
// use it" lists exactly these.
//
//   node worker/scripts/report.ts >>"$GITHUB_STEP_SUMMARY"
import { execFileSync } from 'node:child_process';

const DAY = 86_400_000;
const field = (name: string) => `json_extract(details, '$.${name}')`;

// Percentiles of a field per cloud, with window functions (D1 is SQLite).
const percentiles = (name: string) => `
  , v AS (SELECT ${field('cloud')} AS cloud, ${field(name)} AS ms FROM live
    WHERE started_at > ?1 AND ${field(name)} IS NOT NULL),
  r AS (SELECT cloud, ms, row_number() OVER (PARTITION BY cloud ORDER BY ms) AS i,
    count(*) OVER (PARTITION BY cloud) AS n FROM v)
  SELECT cloud, n AS jobs, min(CASE WHEN i >= 0.5 * n THEN ms END) AS p50,
    min(CASE WHEN i >= 0.95 * n THEN ms END) AS p95
  FROM r GROUP BY cloud, n ORDER BY cloud`;

// Events from installs nobody disowned.
const LIVE = `WITH live AS (SELECT events.* FROM events JOIN installs
  ON installs.id = events.install AND installs.disowned = 0)`;

// Each query's `?1` is the window's start, in milliseconds.
const queries: { title: string; sql: string }[] = [
  {
    title: 'Active orgs and installs',
    sql: `SELECT count(DISTINCT org) AS orgs, count(DISTINCT install) AS installs,
      count(*) AS jobs FROM live WHERE started_at > ?1`,
  },
  {
    title: 'Jobs by cloud, region and VM type',
    sql: `SELECT ${field('cloud')} AS cloud, ${field('region')} AS region,
      ${field('vm_type')} AS vm_type, count(*) AS jobs
      FROM live WHERE started_at > ?1 GROUP BY 1, 2, 3 ORDER BY jobs DESC LIMIT 50`,
  },
  {
    title: 'Spot and on-demand',
    sql: `SELECT ${field('capacity')} AS capacity, count(*) AS jobs,
      round(100.0 * count(*) / (SELECT count(*) FROM live WHERE started_at > ?1), 1) AS percent
      FROM live WHERE started_at > ?1 GROUP BY 1 ORDER BY jobs DESC`,
  },
  {
    title: 'Retry on demand in use',
    sql: `SELECT count(DISTINCT install) AS installs, count(*) AS jobs FROM live
      WHERE started_at > ?1 AND EXISTS (SELECT 1 FROM json_each(details, '$.features')
        WHERE value = 'retry-on-demand')`,
  },
  {
    title: 'Queue time (ms), GitHub queued to runner assigned',
    sql: percentiles('queued_ms'),
  },
  { title: 'Runner boot (ms)', sql: percentiles('boot_ms') },
];

export const QUERIES = queries.map(({ title, sql }) => ({
  title,
  sql: `${LIVE} ${sql.trim()}`,
}));

export function table(title: string, rows: Record<string, unknown>[]) {
  const columns = Object.keys(rows[0] ?? {});
  if (!columns.length) return `### ${title}\n\nNo events.\n`;
  const line = (cells: unknown[]) =>
    `| ${cells.map((c) => c ?? '—').join(' | ')} |`;
  return [
    `### ${title}`,
    '',
    line(columns),
    line(columns.map(() => '-')),
    ...rows.map((row) => line(columns.map((c) => row[c]))),
    '',
  ].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const since = Date.now() - 30 * DAY;
  console.log(
    `## backmesh telemetry, last 30 days (to ${new Date().toISOString()})\n`,
  );
  for (const { title, sql } of QUERIES) {
    // d1 execute takes no parameters; `since` is an integer.
    const out = execFileSync(
      'website/node_modules/.bin/wrangler',
      // No --config: wrangler finds the database by name in the account.
      [
        'd1',
        'execute',
        'backmesh-billing',
        '--remote',
        '--json',
        '--command',
        sql.replaceAll('?1', String(since)),
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
    );
    console.log(
      table(
        title,
        (JSON.parse(out) as { results: Record<string, unknown>[] }[])[0]!
          .results,
      ),
    );
  }
}
