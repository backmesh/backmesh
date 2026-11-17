// The launch video's media host: the backmesh-media R2 bucket behind
// media.backmesh.com (internal/launch-video/README.md), after anycloud's
// experiments/cloudflare-r2-media-check. Dispatched through spike.yml, whose
// publish environment gives it the Cloudflare token. spike.yml takes no
// arguments, so MODE below is committed: each dispatched SHA states what it
// did.
//
// MODE 'check' (read-only, GET requests only): whether the token verifies,
// can list R2 buckets and read the backmesh.com zone, and whether the bucket,
// its custom domain and any media.backmesh.com DNS record already exist.
//
// MODE 'create': creates the bucket and attaches media.backmesh.com with a
// TLS 1.2 minimum, each skipped when it already exists, then waits until the
// domain's ownership and certificate are active and the host answers over
// HTTPS. It uploads nothing. The bucket and domain are meant to stay, so
// cleanup only reports them; remove them by deleting the custom domain, then
// the bucket.
//
// Evidence: report.json in SPIKE_OUTPUT_DIR, without token material.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MODE: 'check' | 'create' = 'check';
const API = 'https://api.cloudflare.com/client/v4';
const ZONE = 'backmesh.com';
const HOST = 'media.backmesh.com';
const BUCKET = 'backmesh-media';
const ACTIVE_TIMEOUT_MS = 15 * 60_000;
const SERVE_TIMEOUT_MS = 10 * 60_000;
const OUT = process.env.SPIKE_OUTPUT_DIR ?? 'spike-evidence';
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? '';

mkdirSync(OUT, { recursive: true, mode: 0o700 });
const log = (line: string) =>
  console.log(`${new Date().toISOString()} ${line}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Answer<T> {
  status: number;
  ok: boolean;
  errors: string[];
  result?: T;
}

async function call<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<Answer<T>> {
  if (MODE === 'check' && method !== 'GET') {
    throw new Error(`read-only run refused ${method} ${path}`);
  }
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    result?: T;
    errors?: { code: number; message: string }[];
  };
  return {
    status: res.status,
    ok: res.ok && json.success === true,
    errors: (json.errors ?? []).map((e) => `${e.code}: ${e.message}`),
    result: json.result,
  };
}

interface Domain {
  domain: string;
  enabled: boolean;
  minTLS?: string;
  status?: { ownership?: string; ssl?: string };
}

const report: { mode: string; at: string; steps: object[] } = {
  mode: MODE,
  at: new Date().toISOString(),
  steps: [],
};
function step(name: string, a: Answer<unknown>, seen?: unknown) {
  const line = {
    step: name,
    status: a.status,
    ok: a.ok,
    errors: a.errors,
    seen,
  };
  report.steps.push(line);
  log(
    `${a.ok ? 'PASS' : 'FAIL'} ${name} (${a.status})${a.errors.length ? ` ${a.errors.join('; ')}` : ''}${seen === undefined ? '' : ` ${JSON.stringify(seen)}`}`,
  );
}
const save = () =>
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2), {
    mode: 0o600,
  });

async function look() {
  const account = await call<{ status: string }>(
    'GET',
    `/accounts/${ACCOUNT}/tokens/verify`,
  );
  step('token verifies (account token)', account, account.result?.status);
  const user = await call<{ status: string }>('GET', '/user/tokens/verify');
  step('token verifies (user token)', user, user.result?.status);

  const buckets = await call<{ buckets?: { name: string }[] }>(
    'GET',
    `/accounts/${ACCOUNT}/r2/buckets?name_contains=${BUCKET}&per_page=1000`,
  );
  const exists = (buckets.result?.buckets ?? []).some((b) => b.name === BUCKET);
  step('lists R2 buckets', buckets, { bucketExists: exists });

  let domains: Domain[] = [];
  let domainsRead = true;
  if (exists) {
    const d = await call<{ domains?: Domain[] }>(
      'GET',
      `/accounts/${ACCOUNT}/r2/buckets/${BUCKET}/domains/custom`,
    );
    domains = d.result?.domains ?? [];
    domainsRead = d.ok;
    step(`reads ${BUCKET} custom domains`, d, domains);
  }

  const zones = await call<{ id: string; account?: { id: string } }[]>(
    'GET',
    `/zones?name=${ZONE}`,
  );
  const zone = zones.result?.[0];
  const zoneId = zone?.account?.id === ACCOUNT ? zone.id : undefined;
  step(`reads the ${ZONE} zone in this account`, zones, {
    found: Boolean(zone),
    inAccount: Boolean(zoneId),
  });
  let records = 0;
  if (zoneId) {
    const found = await call<{ type: string; name: string }[]>(
      'GET',
      `/zones/${zoneId}/dns_records?name=${HOST}`,
    );
    step(
      `reads DNS records for ${HOST}`,
      found,
      (found.result ?? []).map((r) => r.type),
    );
    records = found.ok ? (found.result ?? []).length : -1;
  }
  return {
    exists,
    zoneId,
    records,
    attached: domains.some((d) => d.domain === HOST),
    canRead:
      (account.ok || user.ok) &&
      buckets.ok &&
      zones.ok &&
      domainsRead &&
      records >= 0,
  };
}

async function create(zoneId: string, exists: boolean, attached: boolean) {
  const deadline = Date.now() + ACTIVE_TIMEOUT_MS;
  if (exists) {
    log('the bucket exists; not creating it');
  } else {
    const made = await call('POST', `/accounts/${ACCOUNT}/r2/buckets`, {
      name: BUCKET,
    });
    step(`creates ${BUCKET}`, made);
    if (!made.ok) throw new Error('bucket creation failed');
  }
  if (attached) {
    log(`${HOST} is attached; not attaching it`);
  } else {
    const added = await call(
      'POST',
      `/accounts/${ACCOUNT}/r2/buckets/${BUCKET}/domains/custom`,
      { domain: HOST, zoneId, enabled: true, minTLS: '1.2' },
    );
    step(`attaches ${HOST}`, added);
    if (!added.ok) throw new Error('custom domain attach failed');
  }

  let domain: Answer<Domain> | undefined;
  while (Date.now() < deadline) {
    domain = await call<Domain>(
      'GET',
      `/accounts/${ACCOUNT}/r2/buckets/${BUCKET}/domains/custom/${HOST}`,
    );
    const s = domain.result?.status;
    if (s?.ownership === 'active' && s?.ssl === 'active') break;
    await sleep(15_000);
  }
  step(`${HOST} status`, domain!, domain!.result);
  const s = domain!.result?.status;
  if (s?.ownership !== 'active' || s?.ssl !== 'active') {
    throw new Error(`${HOST} is not active yet`);
  }

  // The bucket is empty, so R2 answers 404 for a missing key; any answer over
  // HTTPS proves DNS, the certificate and the binding.
  let served = 'no answer';
  const serveDeadline = Date.now() + SERVE_TIMEOUT_MS;
  while (Date.now() < serveDeadline) {
    const res = await fetch(`https://${HOST}/launch/`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null);
    if (res) {
      served = `${res.status} ${res.headers.get('server') ?? ''}`.trim();
      if (res.status === 404) break;
    }
    await sleep(15_000);
  }
  report.steps.push({ step: `HEAD https://${HOST}/launch/`, seen: served });
  log(`HEAD https://${HOST}/launch/: ${served}`);
  if (!served.startsWith('404')) throw new Error(`${HOST} does not serve yet`);
}

async function run() {
  if (!ACCOUNT || !TOKEN) {
    throw new Error(
      'CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are needed',
    );
  }
  try {
    const seen = await look();
    if (!seen.canRead) throw new Error('the token cannot read what it needs');
    if (MODE === 'create') {
      if (!seen.zoneId) throw new Error(`zone ${ZONE} not in this account`);
      // Attaching may replace a record already at the host; never do that.
      if (!seen.attached && seen.records > 0) {
        throw new Error(`${HOST} already has DNS records; not attaching`);
      }
      await create(seen.zoneId, seen.exists, seen.attached);
      log('pass: the bucket and domain are ready; nothing was uploaded');
    } else {
      log('pass: read-only check done; nothing was created');
    }
  } finally {
    save();
  }
}

async function cleanup() {
  // Nothing to remove: a check creates nothing, and the bucket and domain
  // are the production media host, meant to stay.
  log(
    MODE === 'create'
      ? `${BUCKET} and ${HOST} stay; delete the domain, then the bucket, to remove them`
      : 'read-only run; nothing to remove',
  );
}

await (process.env.SPIKE_PHASE === 'cleanup' ? cleanup() : run());
