import { existsSync, rmSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { setup } from '../../../worker/scripts/setup.ts';
import { appKey, Upstream } from './fakes.js';

const ENV: Record<string, string> = {
  CLOUDFLARE_API_TOKEN: 'cf',
  CLOUDFLARE_ACCOUNT_ID: 'acct',
  BILLING_GITHUB_CLIENT_ID: 'Iv1.client',
  BILLING_GITHUB_APP_ID: '1',
  BILLING_GITHUB_APP_PRIVATE_KEY: appKey(),
  GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567',
};

// Cloudflare and wrangler, in memory, recording every write.
// `deployed`: the triggers a deploy leaves, as wrangler.jsonc sets them
// unless a test says otherwise.
function world(deployed = ['17 3 * * *']) {
  const writes: string[] = [];
  const deploys: string[][] = [];
  const secrets: Record<string, string> = {};
  const cf = {
    databases: [] as { uuid: string; name: string }[],
    secrets,
    // The Worker's cron triggers, as Cloudflare lists them.
    crons: [] as string[],
    deployed: false,
  };
  const fetch = async (
    input: string | URL | Request,
    init: RequestInit = {},
  ) => {
    const url = new URL(String(input));
    if (url.host === 'api.cloudflare.com') {
      const auth = new Headers(init.headers).get('Authorization');
      if (
        auth !== 'Bearer cf' ||
        url.pathname !==
          '/client/v4/accounts/acct/workers/scripts/backmesh-billing/schedules'
      ) {
        return new Response('', { status: 404 });
      }
      return Response.json({
        success: true,
        result: { schedules: cf.crons.map((cron) => ({ cron })) },
      });
    }
    if (url.host === 'api.github.com') {
      // The fakes' GitHub checks the JWT against the App's public key.
      return new Upstream().fetch(input, init);
    }
    return new Response(`unexpected ${url.host}`, { status: 500 });
  };
  const wrangler = (args: string[], input?: string) => {
    const command =
      args[0] === 'deploy' ? 'deploy' : args.slice(0, 2).join(' ');
    if (command === 'd1 list') return JSON.stringify(cf.databases);
    if (command === 'secret list') {
      if (!cf.deployed) throw new Error('no Worker');
      return JSON.stringify(Object.keys(cf.secrets).map((name) => ({ name })));
    }
    writes.push(`wrangler ${command}`);
    // As wrangler deploy does: the config's triggers replace the Worker's.
    if (command === 'deploy') {
      deploys.push(args);
      cf.crons = deployed;
      cf.deployed = true;
    }
    if (command === 'd1 create')
      cf.databases.push({ uuid: 'db-uuid', name: args[2]! });
    if (command === 'secret delete') delete cf.secrets[args[2]!];
    if (command === 'secret bulk')
      Object.assign(cf.secrets, JSON.parse(input!));
    return '';
  };
  const log: string[] = [];
  const run = (apply: boolean, env: Record<string, string> = ENV) =>
    setup({
      env,
      apply,
      fetch: fetch as typeof globalThis.fetch,
      wrangler,
      log: (l) => log.push(l),
    });
  return { cf, writes, deploys, log, run };
}

afterEach(() => rmSync('worker/wrangler.setup.jsonc', { force: true }));

describe('Worker setup', () => {
  it("checks the Worker's cron triggers are exactly the config's", async () => {
    const w = world();
    // Left by a deploy that failed on the free plan's cron limit.
    w.cf.crons = ['17 3 * * *', '* * * * *'];
    await w.run(false);
    expect(w.log).toContain(
      "The Worker's cron triggers: * * * * *, 17 3 * * *.",
    );
    expect(w.log.join('\n')).toContain(
      'They should be exactly 17 3 * * *, as worker/wrangler.jsonc sets them. The apply sets them.',
    );
    await w.run(true);
    expect(w.log).toContain("The Worker's cron triggers: 17 3 * * *.");

    // A deploy that leaves them wrong stops the apply.
    await expect(world(['* * * * *']).run(true)).rejects.toThrow(
      'They should be exactly 17 3 * * *',
    );
  });

  it('deploys the Worker with the commit it was built from', async () => {
    const w = world();
    await w.run(true);
    expect(w.deploys).toEqual([
      [
        'deploy',
        '--config',
        'worker/wrangler.setup.jsonc',
        '--var',
        `COMMIT:${ENV.GITHUB_SHA}`,
      ],
    ]);

    const { GITHUB_SHA: _, ...noCommit } = ENV;
    await expect(world().run(true, noCommit)).rejects.toThrow('GITHUB_SHA');
  });

  it('names missing secrets', async () => {
    const w = world();
    const { BILLING_GITHUB_CLIENT_ID: _, ...partial } = ENV;
    await expect(w.run(true, partial)).rejects.toThrow(
      'BILLING_GITHUB_CLIENT_ID',
    );
    expect(w.writes).toEqual([]);
  });

  it('deploys without the App until it exists, and refuses half of it', async () => {
    const w = world();
    const {
      BILLING_GITHUB_APP_ID: _id,
      BILLING_GITHUB_APP_PRIVATE_KEY: _key,
      ...noApp
    } = ENV;

    await expect(
      w.run(true, { ...noApp, BILLING_GITHUB_APP_ID: '1' }),
    ).rejects.toThrow('or neither');
    expect(w.writes).toEqual([]);

    await w.run(true, noApp);
    expect(w.writes).toContain('wrangler deploy');
    expect(w.cf.secrets).not.toHaveProperty('GITHUB_APP_ID');
    expect(w.cf.secrets).not.toHaveProperty('GITHUB_APP_PRIVATE_KEY');
    expect(w.cf.secrets).toHaveProperty('GITHUB_CLIENT_ID');
    expect(w.log.join('\n')).toContain('answer 503');
  });

  it('checks the App key is PKCS#8 and that GitHub accepts it, even in a dry run', async () => {
    const w = world();
    const { generateKeyPairSync } = await import('node:crypto');
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pkcs1 = other.privateKey
      .export({ type: 'pkcs1', format: 'pem' })
      .toString();

    await expect(
      w.run(false, { ...ENV, BILLING_GITHUB_APP_PRIVATE_KEY: pkcs1 }),
    ).rejects.toThrow('PKCS#8');
    await expect(
      w.run(false, {
        ...ENV,
        BILLING_GITHUB_APP_PRIVATE_KEY_NEXT: appKey(other.privateKey),
      }),
    ).rejects.toThrow('GitHub refused BILLING_GITHUB_APP_PRIVATE_KEY_NEXT');
    await w.run(false);
    expect(w.log).toContain(
      'BILLING_GITHUB_APP_PRIVATE_KEY signs for the GitHub App backmesh.',
    );
    expect(w.writes).toEqual([]);
  });

  it('only reads in a dry run, and prints the plan', async () => {
    const w = world();

    await w.run(false);

    expect(w.writes).toEqual([]);
    expect(existsSync('worker/wrangler.setup.jsonc')).toBe(false);
    expect(w.log.join('\n')).toContain(
      'would create the D1 database backmesh-billing',
    );
  });

  it('creates the database, deploys the Worker and sets its secrets, again on later runs', async () => {
    const w = world();

    await w.run(true);

    expect(w.writes).toEqual([
      'wrangler d1 create',
      'wrangler d1 migrations',
      'wrangler deploy',
      'wrangler secret bulk',
    ]);
    expect(w.cf.secrets).toEqual({
      GITHUB_CLIENT_ID: 'Iv1.client',
      GITHUB_APP_ID: '1',
      GITHUB_APP_PRIVATE_KEY: ENV.BILLING_GITHUB_APP_PRIVATE_KEY,
    });

    w.writes.length = 0;
    await w.run(true);
    expect(w.writes).toEqual([
      'wrangler d1 migrations',
      'wrangler deploy',
      'wrangler secret bulk',
    ]);
  });

  it('deletes retired secrets', async () => {
    const w = world();
    await w.run(true);
    Object.assign(w.cf.secrets, {
      STRIPE_SECRET_KEY: 'rk_live_owner',
      STRIPE_WEBHOOK_SECRET: 'whsec',
      STRIPE_PORTAL_CONFIGURATION: 'bpc_1',
      STRIPE_LIVE: '1',
      BILLING_OPEN: 'true',
      BILLING_ALLOWLIST: 'acme',
      GITHUB_CLIENT_SECRET: 'client-secret',
    });

    await w.run(true);

    expect(Object.keys(w.cf.secrets).sort()).toEqual([
      'GITHUB_APP_ID',
      'GITHUB_APP_PRIVATE_KEY',
      'GITHUB_CLIENT_ID',
    ]);
  });

  it("stores the next App key during a rotation, and deletes it once it's promoted", async () => {
    const w = world();
    const next = ENV.BILLING_GITHUB_APP_PRIVATE_KEY!;

    await w.run(true, { ...ENV, BILLING_GITHUB_APP_PRIVATE_KEY_NEXT: next });
    expect(w.cf.secrets.GITHUB_APP_PRIVATE_KEY_NEXT).toBe(next);

    await w.run(true);
    expect(w.cf.secrets).not.toHaveProperty('GITHUB_APP_PRIVATE_KEY_NEXT');
    expect(w.writes).toContain('wrangler secret delete');
  });
});
