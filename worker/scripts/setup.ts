// Sets up the Worker, idempotently, for .github/workflows/worker-setup.yml:
// the D1 database and its migrations, the Worker and its secrets. A dry run
// only reads and prints the plan.
//
//   node worker/scripts/setup.ts [--apply]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

import { appJwt } from '../src/app.ts';

const HOST = 'https://api.backmesh.com';
const DATABASE = 'backmesh-billing';
const WORKER = 'backmesh-billing';
const CONFIG = 'worker/wrangler.jsonc';
const SETUP_CONFIG = 'worker/wrangler.setup.jsonc';
// Owner-set in the publish environment; the Worker gets them as secrets.
export const REQUIRED = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'];
// The backmesh App: its ID and its private key as PKCS#8, which
// WebCrypto imports. GitHub issues PKCS#1; convert it with
// `openssl pkcs8 -topk8 -nocrypt -in app.pem`. Both or neither: until the App
// exists, the Worker deploys without them and the broker routes answer 503.
const APP = ['BILLING_GITHUB_APP_ID', 'BILLING_GITHUB_APP_PRIVATE_KEY'];
// During a rotation, the next key, which the Worker signs with once set.
const NEXT_KEY = 'BILLING_GITHUB_APP_PRIVATE_KEY_NEXT';
// Retired secrets, deleted where a Worker still has them: the billing
// Worker's, the OAuth client secret only connect links' web flow used
// (owner, 2026-11-12: device flow only), and the OAuth app's client ID,
// which sign-ins used until they moved to the App (owner, 2026-11-19).
const RETIRED = [
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PORTAL_CONFIGURATION',
  'STRIPE_LIVE',
  'BILLING_OPEN',
  'BILLING_ALLOWLIST',
];

export interface Deps {
  env: Record<string, string | undefined>;
  apply: boolean;
  fetch: typeof fetch;
  // Runs wrangler with the arguments, and stdin; returns stdout.
  wrangler: (args: string[], input?: string) => string;
  log: (line: string) => void;
}

// The Worker's cron triggers, read back from Cloudflare, must be exactly
// wrangler.jsonc's: the free plan allows 5 per account, and a deploy that
// fails on that limit can leave them partly changed. Read-only, so a dry
// run reports them too; after a deploy, a difference stops the setup.
export async function checkTriggers(
  env: Deps['env'],
  fetch: Deps['fetch'],
  log: Deps['log'],
  apply: boolean,
) {
  const wanted = (
    JSON.parse(
      /"crons":\s*(\[[^\]]*\])/.exec(readFileSync(CONFIG, 'utf8'))![1]!,
    ) as string[]
  ).sort();
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${WORKER}/schedules`,
    { headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` } },
  );
  if (!res.ok) {
    const why = `Cloudflare answered ${res.status} for the Worker's cron triggers`;
    if (apply) throw new Error(why);
    return log(`${why}.`);
  }
  const { result } = (await res.json()) as {
    result?: { schedules?: { cron: string }[] };
  };
  const crons = (result?.schedules ?? []).map((s) => s.cron).sort();
  log(`The Worker's cron triggers: ${crons.join(', ') || 'none'}.`);
  if (crons.join('\n') === wanted.join('\n')) return;
  const differ = `They should be exactly ${wanted.join(', ')}, as ${CONFIG} sets them.`;
  if (apply) throw new Error(differ);
  log(`${differ} The apply sets them.`);
}

export async function setup({ env, apply, fetch, wrangler, log }: Deps) {
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length) {
    throw new Error(
      `Add these to the publish environment first: ${missing.join(', ')}`,
    );
  }
  const app = APP.filter((name) => env[name]);
  if (app.length === 1 || (!app.length && env[NEXT_KEY])) {
    throw new Error(
      `Set both ${APP.join(' and ')}${env[NEXT_KEY] ? ` before ${NEXT_KEY}` : ''}, or neither.`,
    );
  }
  if (!app.length) {
    log(
      'The backmesh App is not configured: the Worker deploys without it, and /v1/token and the /v1/installs/cleanup routes answer 503.',
    );
  }
  // Each App key must be PKCS#8 and sign a JWT GitHub accepts. Read-only,
  // so a dry run checks too.
  for (const name of ['BILLING_GITHUB_APP_PRIVATE_KEY', NEXT_KEY]) {
    const pem = env[name];
    if (!pem) continue;
    if (!pem.includes('-----BEGIN PRIVATE KEY-----')) {
      throw new Error(
        `${name} must be PKCS#8 (BEGIN PRIVATE KEY): convert GitHub's key with openssl pkcs8 -topk8 -nocrypt -in app.pem`,
      );
    }
    const jwt = await appJwt({
      GITHUB_APP_ID: env.BILLING_GITHUB_APP_ID!,
      GITHUB_APP_PRIVATE_KEY: pem,
    });
    const res = await fetch('https://api.github.com/app', {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${jwt}`,
        'User-Agent': 'backmesh-setup',
      },
    });
    if (!res.ok) {
      throw new Error(
        `GitHub refused ${name} for App ${env.BILLING_GITHUB_APP_ID} on GET /app: ${res.status}`,
      );
    }
    const { slug } = (await res.json()) as { slug: string };
    log(`${name} signs for the GitHub App ${slug}.`);
  }
  const plan = (line: string) => log(`${apply ? '' : 'would '}${line}`);

  // Cloudflare: the database, its migrations and the Worker.
  const databases = JSON.parse(wrangler(['d1', 'list', '--json'])) as {
    uuid: string;
    name: string;
  }[];
  let database = databases.find((d) => d.name === DATABASE)?.uuid;
  if (!database) {
    plan(`create the D1 database ${DATABASE}`);
    if (apply) {
      wrangler(['d1', 'create', DATABASE]);
      database = (
        JSON.parse(wrangler(['d1', 'list', '--json'])) as typeof databases
      ).find((d) => d.name === DATABASE)?.uuid;
    }
  }
  if (database && apply) {
    writeFileSync(
      SETUP_CONFIG,
      readFileSync(CONFIG, 'utf8').replace(
        /"database_id": "[^"]*"/,
        `"database_id": "${database}"`,
      ),
    );
  }
  const config = ['--config', SETUP_CONFIG];
  const listSecrets = () =>
    (
      JSON.parse(
        wrangler(['secret', 'list', '--format', 'json', '--name', WORKER]),
      ) as { name: string }[]
    ).map((s) => s.name);
  plan(`apply ${DATABASE}'s migrations and deploy the Worker on ${HOST}`);
  if (apply) {
    wrangler(['d1', 'migrations', 'apply', DATABASE, '--remote', ...config]);
    wrangler(['deploy', ...config]);
  }
  // After a deploy the Worker exists, so a failure here is real; a dry run
  // may find no Worker yet.
  let secrets: string[] = [];
  if (apply) secrets = listSecrets();
  else {
    try {
      secrets = listSecrets();
    } catch {
      log('No Worker yet.');
    }
  }
  await checkTriggers(env, fetch, log, apply);

  // The Worker's secrets, through stdin so no value reaches the log.
  const pending: Record<string, string> = {};
  if (app.length) {
    pending.GITHUB_APP_ID = env.BILLING_GITHUB_APP_ID!;
    pending.GITHUB_APP_PRIVATE_KEY = env.BILLING_GITHUB_APP_PRIVATE_KEY!;
  }
  if (env[NEXT_KEY]) pending.GITHUB_APP_PRIVATE_KEY_NEXT = env[NEXT_KEY];
  if (Object.keys(pending).length) {
    plan(`set the Worker secrets ${Object.keys(pending).sort().join(', ')}`);
    if (apply) wrangler(['secret', 'bulk', ...config], JSON.stringify(pending));
  }
  // Once a rotation is promoted, the Worker stops signing with the old next
  // key, which it would otherwise prefer, and no retired secret stays.
  const stale = [
    ...(env[NEXT_KEY] ? [] : ['GITHUB_APP_PRIVATE_KEY_NEXT']),
    ...RETIRED,
  ].filter((name) => secrets.includes(name));
  for (const name of stale) {
    plan(`delete the Worker secret ${name}`);
    if (apply) wrangler(['secret', 'delete', name, ...config]);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await setup({
    env: process.env,
    apply: process.argv.includes('--apply'),
    fetch,
    wrangler: (args, input) =>
      execFileSync('website/node_modules/.bin/wrangler', args, {
        input,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'inherit'],
      }),
    log: console.log,
  });
}
