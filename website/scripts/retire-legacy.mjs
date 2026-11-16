// Retires the old backmesh product's Cloudflare resources, by exact name:
// the Pages projects below and the backmesh-edge Worker. It lists what it
// would delete; with --apply and CONFIRM set to the phrase below, it deletes
// it and checks that every name stops serving. backmesh-site, the old
// backmesh.com site, goes only once backmesh.com and www.backmesh.com serve
// this site's Worker. A run after everything is gone changes nothing.
// .github/workflows/retire-legacy.yml runs it.
const PROJECTS = ['backmesh-dashboard', 'builder', 'llmcomp', 'backmesh-site'];
const OLD_SITE = 'backmesh-site';
const WORKER = 'backmesh-edge';
const NEW_SITE = 'backmesh-website'; // wrangler.jsonc's name
const CONFIRM =
  'delete backmesh-dashboard builder llmcomp backmesh-edge backmesh-site';
// The addresses Cloudflare documents for a record that only routes to a Worker.
const PLACEHOLDERS = new Set(['192.0.2.1', '100::']);
// The new site's names: never deleted from DNS or probed to stop serving.
const LIVE = new Set(['backmesh.com', 'www.backmesh.com']);
const inZone = (host) =>
  host === 'backmesh.com' || host.endsWith('.backmesh.com');

const apply = process.argv.includes('--apply');
const {
  CLOUDFLARE_API_TOKEN: token,
  CLOUDFLARE_ACCOUNT_ID,
  CONFIRM: confirm,
} = process.env;
if (!CLOUDFLARE_ACCOUNT_ID) throw new Error('CLOUDFLARE_ACCOUNT_ID is unset.');
if (apply && confirm !== CONFIRM) {
  throw new Error(`Deleting needs confirm to be exactly "${CONFIRM}".`);
}
const A = `/accounts/${CLOUDFLARE_ACCOUNT_ID}`;

// One API call; a 404 is null, so a resource already gone isn't an error.
async function cf(method, path) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  const body = await res.json();
  if (!body.success) {
    throw new Error(`${method} ${path}: ${JSON.stringify(body.errors)}`);
  }
  return body;
}
// Every page of a list. Cloudflare's list endpoints differ: DNS records take
// page and per_page (up to 5,000,000), Pages deployments take page with their
// own page size, and Pages domains, Workers domains and routes reject both
// (code 8000024). So only DNS sets per_page, and a later page is asked for
// only when result_info says there is one.
async function all(path, perPage) {
  const items = [];
  for (let page = 1; ; page++) {
    const params = new URLSearchParams();
    if (perPage) params.set('per_page', perPage);
    if (perPage || page > 1) params.set('page', page);
    const sep = path.includes('?') ? '&' : '?';
    const body = await cf('GET', params.size ? `${path}${sep}${params}` : path);
    items.push(...(body?.result ?? []));
    const pages = body?.result_info?.total_pages ?? 1;
    if (!body?.result?.length || page >= pages) return items;
  }
}

// The account's backmesh.com zone, by name.
const zone = (
  await cf(
    'GET',
    `/zones?name=backmesh.com&account.id=${CLOUDFLARE_ACCOUNT_ID}`,
  )
)?.result?.[0];
if (!zone) throw new Error('The account has no backmesh.com zone.');
const Z = `/zones/${zone.id}`;
const records = await all(`${Z}/dns_records`, 100);
const problems = [];

// The plan: every resource, by exact name, and the hosts that must stop serving.
const projects = [];
for (const name of PROJECTS) {
  const project = (await cf('GET', `${A}/pages/projects/${name}`))?.result;
  if (!project) {
    console.log(`Pages project ${name}: already gone.`);
    continue;
  }
  const domains = (await all(`${A}/pages/projects/${name}/domains`)).map(
    (d) => d.name,
  );
  // The project's own name and its branch aliases, such as main.<sub>.
  const sub = project.subdomain;
  const dns = records.filter(
    (r) =>
      r.type === 'CNAME' &&
      (r.content === sub || r.content.endsWith(`.${sub}`)) &&
      !LIVE.has(r.name),
  );
  const deployments = await all(`${A}/pages/projects/${name}/deployments`);
  const outside = domains.filter((d) => !inZone(d));
  projects.push({ name, subdomain: sub, domains, dns });
  console.log(
    `Pages project ${name} (${sub}): ${deployments.length} deployments; ` +
      `custom domains: ${domains.join(', ') || 'none'}; ` +
      (outside.length
        ? `outside backmesh.com, so their DNS is kept: ${outside.join(', ')}; `
        : '') +
      `DNS: ${dns.map((r) => `${r.name} CNAME ${r.content}`).join(', ') || 'none'}`,
  );
}

const scripts = (await cf('GET', `${A}/workers/scripts`))?.result ?? [];
const zoneRoutes = (await cf('GET', `${Z}/workers/routes`))?.result ?? [];
const host = (route) => route.pattern.split('/')[0];
// Hosts that another Worker also routes keep their DNS.
const shared = new Set(zoneRoutes.filter((r) => r.script !== WORKER).map(host));
const worker = scripts.some((s) => s.id === WORKER)
  ? {
      routes: zoneRoutes.filter((r) => r.script === WORKER),
      domains: (await all(`${A}/workers/domains`)).filter(
        (d) => d.service === WORKER,
      ),
      schedules:
        (await cf('GET', `${A}/workers/scripts/${WORKER}/schedules`))?.result
          ?.schedules ?? [],
      bindings:
        (await cf('GET', `${A}/workers/scripts/${WORKER}/settings`))?.result
          ?.bindings ?? [],
    }
  : null;
if (!worker) console.log(`Worker ${WORKER}: already gone.`);
else {
  const hosts = worker.routes.map(host);
  worker.dns = records.filter(
    (r) =>
      hosts.includes(r.name) &&
      !LIVE.has(r.name) &&
      !shared.has(r.name) &&
      ['A', 'AAAA'].includes(r.type) &&
      PLACEHOLDERS.has(r.content),
  );
  worker.hosts = hosts.filter((h) => !h.includes('*') && !shared.has(h));
  const kept = records.filter(
    (r) => hosts.includes(r.name) && !worker.dns.includes(r),
  );
  console.log(
    `Worker ${WORKER}: routes: ${worker.routes.map((r) => r.pattern).join(', ') || 'none'}; ` +
      `custom domains: ${worker.domains.map((d) => d.hostname).join(', ') || 'none'}; ` +
      `cron triggers: ${worker.schedules.map((s) => s.cron).join(', ') || 'none'}; ` +
      `bindings: ${worker.bindings.map((b) => `${b.type} ${b.name}`).join(', ') || 'none'}; ` +
      `placeholder DNS: ${worker.dns.map((r) => `${r.name} ${r.type} ${r.content}`).join(', ') || 'none'}` +
      (kept.length
        ? `; DNS kept (not a placeholder, or another Worker routes it): ${kept.map((r) => `${r.name} ${r.type} ${r.content}`).join(', ')}`
        : ''),
  );
}

// The old site goes only once the new one serves both names.
async function newSiteServes() {
  const domains = await all(`${A}/workers/domains`);
  const ours = ['backmesh.com', 'www.backmesh.com'].every((host) =>
    domains.some((d) => d.hostname === host && d.service === NEW_SITE),
  );
  const home = await fetch('https://backmesh.com/').then(
    (r) => r.text(),
    () => '',
  );
  const www = await fetch('https://www.backmesh.com/', {
    redirect: 'manual',
  }).catch(() => null);
  return (
    ours &&
    home.includes('<title>backmesh: GitHub Actions runners') &&
    www?.status === 301 &&
    www.headers.get('location') === 'https://backmesh.com/'
  );
}
const site = projects.find((p) => p.name === OLD_SITE);
if (site && !(await newSiteServes())) {
  problems.push(
    `${OLD_SITE} kept: backmesh.com and www.backmesh.com don't serve ${NEW_SITE} yet.`,
  );
  projects.splice(projects.indexOf(site), 1);
}

if (!projects.length && !worker) console.log('Nothing to delete.');
if (!apply) {
  for (const problem of problems) console.log(problem);
  console.log('Dry run: nothing was deleted.');
  process.exit(0);
}

for (const p of projects) {
  for (const domain of p.domains) {
    await cf('DELETE', `${A}/pages/projects/${p.name}/domains/${domain}`);
  }
  for (const r of p.dns) await cf('DELETE', `${Z}/dns_records/${r.id}`);
  // A project with many deployments can't be deleted, so they go first; the
  // live one may refuse until the project goes with it.
  for (const d of await all(`${A}/pages/projects/${p.name}/deployments`)) {
    await cf(
      'DELETE',
      `${A}/pages/projects/${p.name}/deployments/${d.id}?force=true`,
    ).catch((error) =>
      console.log(`Kept deployment ${d.id} for now: ${error.message}`),
    );
  }
  await cf('DELETE', `${A}/pages/projects/${p.name}`);
  console.log(`Deleted the Pages project ${p.name}.`);
}
if (worker) {
  for (const r of worker.routes)
    await cf('DELETE', `${Z}/workers/routes/${r.id}`);
  for (const d of worker.domains)
    await cf('DELETE', `${A}/workers/domains/${d.id}`);
  for (const r of worker.dns) await cf('DELETE', `${Z}/dns_records/${r.id}`);
  await cf('DELETE', `${A}/workers/scripts/${WORKER}`);
  console.log(`Deleted the Worker ${WORKER}.`);
}

// Every name stops serving: no 2xx or 3xx answer, within about five minutes
// while DNS caches expire.
const hosts = [
  ...projects.flatMap((p) => [p.subdomain, ...p.domains]),
  ...(worker
    ? [...worker.hosts, ...worker.domains.map((d) => d.hostname)]
    : []),
];
for (const host of new Set(hosts.filter((h) => !LIVE.has(h)))) {
  let serving = true;
  for (let i = 0; i < 10 && serving; i++) {
    if (i) await new Promise((r) => setTimeout(r, 30_000));
    const res = await fetch(`https://${host}/`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    serving = !!res && res.status < 400;
  }
  if (serving) problems.push(`${host} still serves.`);
  else console.log(`${host} no longer serves.`);
}
for (const p of projects) {
  if (await cf('GET', `${A}/pages/projects/${p.name}`))
    problems.push(`${p.name} still exists.`);
}
if (
  worker &&
  ((await cf('GET', `${A}/workers/scripts`))?.result ?? []).some(
    (s) => s.id === WORKER,
  )
) {
  problems.push(`${WORKER} still exists.`);
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
