// Why a sign-in poll to api.backmesh.com "didn't answer" on 2026-11-19 at
// 02:09:43 UTC (an Angstrom-AI install on Azure; the CLI gives up after 10
// seconds or on a network error). Reads the Worker's history for 02:05–02:15
// UTC: Workers Logs events through the observability query API, and
// per-minute invocation metrics through the GraphQL Analytics API.
// Dispatched through spike.yml, whose publish environment gives it the
// Cloudflare token.
//
// Read-only: both APIs take POST, but only to query. Nothing is created,
// so cleanup has nothing to do.
//
// Evidence: report.json in SPIKE_OUTPUT_DIR. Each event keeps only its time,
// path without query string, status, outcome, durations, exceptions and
// console lines; never headers, bodies, IPs or token material.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPT = 'backmesh-billing';
const FROM = Date.parse('2026-11-19T19:00:00Z');
const TO = Date.parse('2026-11-19T20:15:00Z');
const API = 'https://api.cloudflare.com/client/v4';
const OUT = process.env.SPIKE_OUTPUT_DIR ?? 'spike-evidence';
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? '';

if (process.env.SPIKE_PHASE === 'cleanup') process.exit(0);
mkdirSync(OUT, { recursive: true, mode: 0o700 });

async function post(path: string, body: unknown) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  return {
    status: res.status,
    json: (await res.json().catch(() => ({}))) as any,
  };
}

const SECRET = /gho_\w+|bmk_[0-9a-f]+|ghs_\w+|Bearer \S+/g;
const KEEP =
  /timestamp|url|path|status|outcome|duration|wall|cpu|exception|error|message|level|trigger|scriptname|service|subrequest/i;

// The kept fields of one event, flattened, with query strings and anything
// token-shaped removed.
function scrub(event: unknown, prefix = '', out: Record<string, unknown> = {}) {
  if (event && typeof event === 'object') {
    for (const [k, v] of Object.entries(event)) {
      if (/header|body|ip$|clientip|cookie|cf$/i.test(k)) continue;
      scrub(v, prefix ? `${prefix}.${k}` : k, out);
    }
  } else if (KEEP.test(prefix)) {
    out[prefix] =
      typeof event === 'string'
        ? event.replace(/\?.*$/, '').replace(SECRET, '[redacted]')
        : event;
  }
  return out;
}

const report: Record<string, unknown> = { script: SCRIPT, from: FROM, to: TO };

const events = await post(
  `/accounts/${ACCOUNT}/workers/observability/telemetry/query`,
  {
    queryId: 'sign-in-2026-11-19',
    timeframe: { from: FROM, to: TO },
    view: 'events',
    limit: 2000,
  },
);
const rows: unknown =
  events.json?.result?.events?.events ?? events.json?.result?.events;
report.events = {
  status: events.status,
  errors: events.json?.errors,
  count: Array.isArray(rows) ? rows.length : 0,
  // Every Worker in the account; each row's scriptName or service says whose.
  rows: Array.isArray(rows) ? rows.map((r) => scrub(r)) : [],
};

const metrics = await post('/graphql', {
  query: `query ($account: String!, $from: Time!, $to: Time!, $script: String!) {
    viewer { accounts(filter: { accountTag: $account }) {
      workersInvocationsAdaptive(limit: 100,
        filter: { scriptName: $script, datetime_geq: $from, datetime_leq: $to },
        orderBy: [datetimeMinute_ASC]) {
        dimensions { datetimeMinute status }
        sum { requests errors subrequests }
        quantiles { cpuTimeP99 wallTimeP99 }
      } } } }`,
  variables: {
    account: ACCOUNT,
    from: new Date(FROM).toISOString(),
    to: new Date(TO).toISOString(),
    script: SCRIPT,
  },
});
report.metrics = {
  status: metrics.status,
  errors: metrics.json?.errors,
  rows: metrics.json?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive,
};

writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
