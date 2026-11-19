// Whether the backmesh App's user token (`ghu_`, GitHub's device flow with
// the App's public client ID) can tell an org owner from a plain member with
// the App's existing permissions: GET /orgs/{org}/actions/runner-groups is
// listed under its Self-hosted runners permission, and a user token holds
// only what both the App and the person can do. Dispatched through
// spike.yml, which passes no arguments, so ORG is committed. It uses no
// secret: the client ID is public.
//
// The run phase starts one device sign-in per ROLE at once and prints each
// code; an owner and a plain member of ORG each enter one. A code that
// expires gets a fresh one until SIGN_IN_MS runs out. With each token it
// sends only GET requests: who signed in, their membership of ORG and their
// orgs and memberships (the App has no Members permission, so GitHub may
// refuse these), the installations the token reaches, and the runner
// groups. Nothing is created, so cleanup
// only says so.
//
// Evidence: report.json in SPIKE_OUTPUT_DIR: statuses, GitHub's messages and
// X-Accepted-GitHub-Permissions, the runner groups' count, never a token or
// device code. The tokens stay valid (revoking one needs the App's client
// secret): each person revokes theirs at
// https://github.com/settings/apps/authorizations when done.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ORG = 'backmesh-e2e';
const CLIENT_ID = 'Iv23li6e0q0gl3GOQ9ny';
const ROLES = ['owner', 'member'] as const;
const SIGN_IN_MS = 35 * 60_000;
const OUT = process.env.SPIKE_OUTPUT_DIR ?? 'spike-evidence';

mkdirSync(OUT, { recursive: true, mode: 0o700 });
const log = (line: string) =>
  console.log(`${new Date().toISOString()} ${line}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const form = async (path: string, body: Record<string, string>) =>
  (await (
    await fetch(`https://github.com${path}`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(30_000),
    })
  ).json()) as Record<string, unknown>;

// One sign-in: a fresh code whenever the last one expired.
async function signIn(role: string, deadline: number): Promise<string> {
  while (Date.now() < deadline) {
    const code = await form('/login/device/code', { client_id: CLIENT_ID });
    if (typeof code.device_code !== 'string') {
      throw new Error(`device code refused: ${JSON.stringify(code)}`);
    }
    log(
      `${role} of ${ORG}: open ${String(code.verification_uri)} and enter ${String(code.user_code)} (expires in ${String(code.expires_in)} s)`,
    );
    let interval = Number(code.interval) * 1000;
    const expires = Date.now() + Number(code.expires_in) * 1000;
    while (Date.now() < Math.min(expires, deadline)) {
      await sleep(interval);
      const answer = await form('/login/oauth/access_token', {
        client_id: CLIENT_ID,
        device_code: code.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }).catch((error: unknown) => ({ error: String(error) }));
      if (typeof answer.access_token === 'string') return answer.access_token;
      if (answer.error === 'slow_down') interval += 5000;
      else if (answer.error === 'expired_token') break;
      else if (answer.error !== 'authorization_pending') {
        log(`${role}: token poll answered ${String(answer.error)}`);
      }
    }
    log(`${role}: the code expired; a fresh one follows`);
  }
  throw new Error(`${role} didn't sign in within ${SIGN_IN_MS / 60_000} min`);
}

async function get(token: string, path: string) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'backmesh-spike',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    path,
    status: res.status,
    accepted: res.headers.get('X-Accepted-GitHub-Permissions'),
    sso: res.headers.get('X-GitHub-SSO'),
    message: typeof body.message === 'string' ? body.message : undefined,
    body,
  };
}

async function probe(role: string, token: string) {
  const user = await get(token, '/user');
  const membership = await get(
    token,
    `/user/memberships/orgs/${encodeURIComponent(ORG)}`,
  );
  const installations = await get(token, '/user/installations');
  // What `backmesh install` without --org lists: the user's orgs.
  const orgs = await get(token, '/user/orgs?per_page=100');
  const memberships = await get(
    token,
    '/user/memberships/orgs?state=active&per_page=100',
  );
  const groups = await get(
    token,
    `/orgs/${encodeURIComponent(ORG)}/actions/runner-groups`,
  );
  const result = {
    role,
    prefix: token.slice(0, 4),
    login: user.body.login,
    user: { status: user.status },
    membership: {
      status: membership.status,
      message: membership.message,
      accepted: membership.accepted,
      role: membership.body.role,
      state: membership.body.state,
    },
    installations: {
      status: installations.status,
      // Which App each installation is, so a user token's installations
      // can be told to be the issuing App's.
      installations: (
        (installations.body.installations ?? []) as {
          account?: { login?: string };
          app_id?: number;
          app_slug?: string;
        }[]
      ).map((i) => ({
        account: i.account?.login,
        app_id: i.app_id,
        app_slug: i.app_slug,
      })),
    },
    orgs: {
      status: orgs.status,
      message: orgs.message,
      accepted: orgs.accepted,
      logins: Array.isArray(orgs.body)
        ? (orgs.body as { login?: string }[]).map((o) => o.login)
        : undefined,
    },
    memberships: {
      status: memberships.status,
      message: memberships.message,
      accepted: memberships.accepted,
      roles: Array.isArray(memberships.body)
        ? (
            memberships.body as {
              role?: string;
              organization?: { login?: string };
            }[]
          ).map((m) => `${m.organization?.login}:${m.role}`)
        : undefined,
    },
    runnerGroups: {
      status: groups.status,
      message: groups.message,
      accepted: groups.accepted,
      sso: groups.sso,
      count: groups.body.total_count,
    },
  };
  log(`${role}: ${JSON.stringify(result)}`);
  return result;
}

if (process.env.SPIKE_PHASE === 'cleanup') {
  log('Nothing to clean up: the run phase only signs in and reads.');
} else {
  const deadline = Date.now() + SIGN_IN_MS;
  const results = await Promise.allSettled(
    ROLES.map(async (role) => probe(role, await signIn(role, deadline))),
  );
  const report = results.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : { role: ROLES[i], error: String(r.reason) },
  );
  writeFileSync(
    join(OUT, 'report.json'),
    `${JSON.stringify({ org: ORG, client_id: CLIENT_ID, report }, null, 2)}\n`,
  );
  if (results.some((r) => r.status === 'rejected')) process.exit(1);
}
