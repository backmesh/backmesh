// Moves backmesh.com and www.backmesh.com from the old site's Pages project
// to this site's Worker, before `wrangler deploy` (website.yml). Cloudflare
// won't attach a Worker custom domain over an existing CNAME, so:
//   guard   reads only: fails unless each name is free, already ours, or
//           held only by a CNAME to the old project's pages.dev name.
//   detach  the same checks, then removes each name from the Pages project
//           and deletes that CNAME, so the deploy can attach the name. The
//           old site stops serving the names here (owner: that's fine).
// Only these two names and the project backmesh-site are ever touched.
// Usage: node scripts/cutover.mjs guard|detach
const HOSTS = ['backmesh.com', 'www.backmesh.com'];
const WORKER = 'backmesh-website'; // wrangler.jsonc's name
const PROJECT = 'backmesh-site'; // the old site's Pages project
const command = process.argv[2];
const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account } =
  process.env;
const A = `/accounts/${account}`;

async function cf(method, path, body) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body && { 'content-type': 'application/json' }),
    },
    body: body && JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.success) {
    throw new Error(`${method} ${path}: ${JSON.stringify(json.errors)}`);
  }
  return json.result;
}

const [zone] = await cf('GET', '/zones?name=backmesh.com');
if (!zone) throw new Error('The token sees no backmesh.com zone.');
const Z = `/zones/${zone.id}`;
// Null once retire-legacy.yml has deleted the project.
const project = await cf('GET', `${A}/pages/projects/${PROJECT}`).catch(
  () => null,
);

// Each name's state: attached to our Worker, or its records and Pages entry.
async function read(host) {
  const domains = await cf('GET', `${A}/workers/domains?hostname=${host}`);
  const holder = domains.find((d) => d.hostname === host);
  const records = (await cf('GET', `${Z}/dns_records?name=${host}`)).filter(
    (r) => ['A', 'AAAA', 'CNAME'].includes(r.type),
  );
  const pages =
    project &&
    (await cf('GET', `${A}/pages/projects/${PROJECT}/domains`)).find(
      (d) => d.name === host,
    );
  return { host, holder, records, pages };
}

function check({ host, holder, records }) {
  if (holder?.service === WORKER) return null;
  if (holder)
    return `${host} is a custom domain of the Worker ${holder.service}.`;
  const other = records.filter(
    (r) => !(r.type === 'CNAME' && r.content === project?.subdomain),
  );
  if (other.length) {
    return `${host} has ${other.map((r) => `a ${r.type} record to ${r.content}`).join(', ')}, not only a CNAME to ${project?.subdomain ?? `the deleted project ${PROJECT}`}.`;
  }
  return null;
}

const states = await Promise.all(HOSTS.map(read));

if (command === 'guard' || command === 'detach') {
  const problems = states.map(check).filter(Boolean);
  if (problems.length)
    throw new Error(`Not deploying:\n${problems.join('\n')}`);
  if (command === 'guard') {
    for (const s of states) {
      console.log(
        s.holder
          ? `${s.host}: already this site's.`
          : `${s.host}: ${s.records.length ? `a CNAME to ${project?.subdomain}` : 'free'}, to be attached.`,
      );
    }
    process.exit(0);
  }
  const moving = states.filter((s) => !s.holder);
  for (const s of moving) {
    if (s.pages) {
      await cf('DELETE', `${A}/pages/projects/${PROJECT}/domains/${s.host}`);
      console.log(`Removed ${s.host} from the Pages project ${PROJECT}.`);
    }
    for (const r of s.records) {
      await cf('DELETE', `${Z}/dns_records/${r.id}`);
      console.log(`Deleted ${s.host}'s CNAME to ${r.content}.`);
    }
  }
} else {
  throw new Error('Usage: node scripts/cutover.mjs guard|detach');
}
