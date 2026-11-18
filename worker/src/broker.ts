// The token broker: installation tokens of the
// backmesh App for an install key's own org, and uninstall's cleanup:
// a runners-only token on an org admin's sign-in, then the App's removal.
// Every mint and cleanup call leaves an audit row; the broker keeps no token.
import {
  app,
  forget,
  GitHubError,
  installationOf,
  installUrl,
  mintToken,
  randomHex,
} from './app.js';
import type { Env } from './index.js';
import {
  AppRestricted,
  deviceToken,
  keyInstall,
  orgAdmin,
  rememberLogin,
  sha256,
} from './installs.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface AuditRow {
  action: 'token' | 'uninstall' | 'cleanup';
  outcome: string;
  install?: string;
  org?: number;
  installation?: number;
  permissions?: Record<string, string>;
  expires_at?: string;
}

export const audit = (env: Env, request: Request, row: AuditRow) =>
  env.DB.prepare(
    `INSERT INTO audit (at, action, outcome, install, org, installation,
     permissions, expires_at, ip, ray) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      Date.now(),
      row.action,
      row.outcome,
      row.install ?? null,
      row.org ?? null,
      row.installation ?? null,
      row.permissions ? JSON.stringify(row.permissions) : null,
      row.expires_at ?? null,
      request.headers.get('CF-Connecting-IP'),
      request.headers.get('CF-Ray'),
    )
    .run();

// Daily (the cron): audit rows are kept 90 days.
// Expired cleanups go too.
export const trimAudit = (env: Env, now = Date.now()) =>
  env.DB.batch([
    env.DB.prepare('DELETE FROM audit WHERE at < ?').bind(now - 90 * DAY),
    env.DB.prepare('DELETE FROM cleanups WHERE expires_at < ?').bind(now),
  ]);

const notInstalled = (env: Env, org: number) =>
  Response.json(
    { error: 'app_not_installed', install_url: installUrl(env, org) },
    { status: 409 },
  );

// The org's unrevoked installs but `except` that minted a token in the last
// hour, each with its last mint: a listener that still runs refreshes its
// token every 30 minutes. An aborted install's leftover key doesn't count.
async function liveInstalls(env: Env, org: number, except: string | null) {
  const { results } = await env.DB.prepare(
    `SELECT install, max(at) AS at FROM audit WHERE org = ?1 AND at > ?2
     AND action = 'token' AND outcome = 'ok' AND install != ?3
     AND install IN (SELECT id FROM installs WHERE revoked = 0)
     GROUP BY install`,
  )
    .bind(org, Date.now() - HOUR, except ?? '')
    .all<{ install: string; at: number }>();
  return results.map((r) => ({
    install: r.install,
    last_token_at: new Date(r.at).toISOString(),
  }));
}

const tooMany = () =>
  Response.json({ error: 'Too many requests; retry later.' }, { status: 429 });

// POST /v1/token: a token for the key's org. Never refused over billing:
// an unpaid or over-cap org still gets tokens.
export async function token(
  request: Request,
  env: Env,
  install: { id: string; org: number },
) {
  const minted = await mintToken(env, install.org);
  if (!minted) {
    console.log(`token refused: ${install.id} app_not_installed`);
    return notInstalled(env, install.org);
  }
  const { answer, installation } = minted;
  await audit(env, request, {
    action: 'token',
    outcome: 'ok',
    install: install.id,
    org: install.org,
    installation,
    permissions: answer.permissions,
    expires_at: answer.expires_at,
  });
  return Response.json(answer);
}

// What a cleanup token may do: manage the org's self-hosted runners, scale
// sets and runner groups, and nothing else.
const CLEANUP: Record<string, string> = {
  organization_self_hosted_runners: 'write',
};
// A cleanup outlives its first token: the drain (up to 30 minutes), the
// GitHub cleanup and the cloud side come before the App's removal.
const CLEANUP_TTL = 3 * HOUR;

type Cleanup = { id: string; org: number; install: string | null };
const recorder =
  (env: Env, request: Request) =>
  (outcome: string, org?: number, row: Partial<AuditRow> = {}) =>
    audit(env, request, { action: 'cleanup', outcome, org, ...row });

// A runners-only token for the cleanup's org, unless an install of the org
// is live, at most 5 an hour per org with the refusals that passed the
// admin check, counted from the audit rows. Pending polls and refusals
// before the admin check don't count, so a sign-in that isn't an admin's
// can't lock the admin out; SIGNIN_LIMIT bounds those per IP. The App not
// installed answers no token: there's nothing at GitHub to remove.
async function cleanupToken(
  env: Env,
  request: Request,
  cleanup: Cleanup,
  login: string,
) {
  const record = recorder(env, request);
  const at = (outcome: string, row: Partial<AuditRow> = {}) =>
    record(outcome, cleanup.org, {
      install: cleanup.install ?? undefined,
      ...row,
    });
  const recent = await env.DB.prepare(
    `SELECT count(*) AS n FROM audit WHERE org = ? AND action = 'cleanup'
     AND at > ? AND outcome IN ('ok', 'live_install', 'app_not_installed', 'github_failed')`,
  )
    .bind(cleanup.org, Date.now() - HOUR)
    .first<{ n: number }>();
  if (recent!.n >= 5) {
    await at('rate_limited');
    return tooMany();
  }
  const live = await liveInstalls(env, cleanup.org, cleanup.install);
  if (live.length) {
    await at('live_install');
    const error = `backmesh ${live.length === 1 ? 'install' : 'installs'} ${live.map((l) => `${l.install} (last token ${l.last_token_at})`).join(', ')} of ${login} got a token in the last hour, so a control plane may still run there. If its control plane is gone too, run uninstall again an hour after the latest token listed.`;
    return Response.json({ error, live }, { status: 409 });
  }
  // Ends the uninstalling install's own key first: it gets no new token.
  if (cleanup.install) {
    await env.DB.prepare('UPDATE installs SET revoked = 1 WHERE id = ?')
      .bind(cleanup.install)
      .run();
  }
  const minted = await mintToken(env, cleanup.org, CLEANUP).catch(
    async (error: unknown) => {
      await at('github_failed');
      throw error;
    },
  );
  if (!minted) await at('app_not_installed');
  else {
    await at('ok', {
      installation: minted.installation,
      permissions: minted.answer.permissions,
      expires_at: minted.answer.expires_at,
    });
  }
  return Response.json({
    token: minted?.answer.token ?? null,
    expires_at: minted?.answer.expires_at ?? null,
    org: { id: cleanup.org, login: minted?.answer.org.login ?? login },
  });
}

// POST /v1/installs/cleanup { device_code, org }, with the install key as
// the bearer when the CLI could read it: an admin of `org` signs
// in through the device flow, polled here (202 while pending). The key, if
// sent, must be the org's; its own last mint doesn't count as live, and it's
// revoked before the mint. Answers a runners-only token and a
// `cleanup_id` for the re-mint and the App's removal, bound to the org and
// the admin, so uninstall needs one sign-in. No key names the org when the
// control plane is gone, so the admin check does, and the installation's
// account.id must be that org (installationOf).
export async function cleanup(request: Request, env: Env) {
  const record = recorder(env, request);
  const { device_code, org } = (await request.json().catch(() => ({}))) as {
    device_code?: unknown;
    org?: unknown;
  };
  if (typeof device_code !== 'string' || typeof org !== 'string') {
    await record('bad_request');
    const error = 'device_code and org are required';
    return Response.json({ error }, { status: 400 });
  }
  const signedIn = await deviceToken(env, device_code);
  if (signedIn instanceof Response) {
    if (signedIn.status !== 202) await record('signin_failed');
    return signedIn;
  }
  const admin = await orgAdmin(signedIn, org, 'uninstall').catch(
    async (error: unknown) => {
      await record(
        error instanceof AppRestricted ? 'app_restricted' : 'github_failed',
      );
      throw error;
    },
  );
  if (!admin) {
    await record('not_admin');
    const error = `Uninstalling backmesh from ${org} needs its admin role.`;
    return Response.json({ error }, { status: 403 });
  }
  let install: string | null = null;
  if (request.headers.has('Authorization')) {
    // A revoked key still names its install: a rerun after this revoked it.
    const key = await keyInstall(env, request);
    if (key?.org !== admin.id) {
      await record('bad_key', admin.id);
      const error = `The install key isn't one of ${admin.login}'s.`;
      return Response.json({ error }, { status: 403 });
    }
    install = key.id;
  }
  // The admin's current login finds the installation when none is cached.
  await rememberLogin(env, admin.id, admin.login);
  const id = randomHex() + randomHex();
  const answer = await cleanupToken(
    env,
    request,
    { id, org: admin.id, install },
    admin.login,
  );
  if (!answer.ok) return answer;
  // Only an answered cleanup is kept.
  await env.DB.prepare(
    'INSERT INTO cleanups (id, org, admin, install, expires_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(
      await sha256(id),
      admin.id,
      admin.user,
      install,
      Date.now() + CLEANUP_TTL,
    )
    .run();
  return Response.json({
    ...((await answer.json()) as object),
    cleanup_id: id,
  });
}

// The unexpired, unfinished cleanup a body's `cleanup_id` names, or null,
// and whether the body asks to keep the App.
async function cleanupOf(env: Env, request: Request) {
  const { cleanup_id, keep_app } = (await request.json().catch(() => ({}))) as {
    cleanup_id?: unknown;
    keep_app?: unknown;
  };
  if (typeof cleanup_id !== 'string') return null;
  const row = await env.DB.prepare(
    `SELECT c.org, c.install, o.login FROM cleanups c JOIN orgs o ON o.id = c.org
     WHERE c.id = ? AND c.finished = 0 AND c.expires_at > ?`,
  )
    .bind(await sha256(cleanup_id), Date.now())
    .first<{ org: number; install: string | null; login: string }>();
  return row && { ...row, id: cleanup_id, keepApp: keep_app === true };
}
const unknownCleanup = () =>
  Response.json(
    { error: 'Unknown, expired or finished cleanup; run uninstall again.' },
    { status: 401 },
  );

// POST /v1/installs/cleanup/token { cleanup_id }: a fresh runners-only
// token, for a GitHub cleanup that starts after the first one's half-life.
export async function cleanupRefresh(request: Request, env: Env) {
  const cleanup = await cleanupOf(env, request);
  if (!cleanup) return unknownCleanup();
  return cleanupToken(env, request, cleanup, cleanup.login);
}

// POST /v1/installs/cleanup/finish { cleanup_id, keep_app? }: uninstall's
// last step. Deletes the org's installation of the App and revokes all its
// installs' keys, unless another install of the org is live, which it names;
// the cleanup's own install was revoked at the sign-in. One already gone
// counts as done. `keep_app` (`uninstall --keep-app`) revokes the keys and
// leaves the installation, which only an org owner can make again.
export async function cleanupFinish(request: Request, env: Env) {
  const cleanup = await cleanupOf(env, request);
  if (!cleanup) return unknownCleanup();
  const { org } = cleanup;
  const record = (outcome: string, installation?: number) =>
    audit(env, request, {
      action: 'uninstall',
      outcome,
      install: cleanup.install ?? undefined,
      org,
      installation,
    });
  const live = await liveInstalls(env, org, cleanup.install);
  let installation: number | undefined;
  if (!live.length) {
    installation = cleanup.keepApp
      ? undefined
      : (await installationOf(env, org))?.id;
    if (installation) {
      const res = await app(env, `/app/installations/${installation}`, {
        method: 'DELETE',
      });
      if (!res.ok && res.status !== 404) {
        await record('github_failed', installation);
        throw new GitHubError(`GitHub kept the installation: ${res.status}`);
      }
    }
    if (!cleanup.keepApp) await forget(env, org);
    await env.DB.prepare('UPDATE installs SET revoked = 1 WHERE org = ?')
      .bind(org)
      .run();
  }
  await env.DB.prepare('UPDATE cleanups SET finished = 1 WHERE id = ?')
    .bind(await sha256(cleanup.id))
    .run();
  await record(
    live.length ? 'ok_still_used' : cleanup.keepApp ? 'ok_kept_app' : 'ok',
    installation,
  );
  return Response.json({
    removed: !live.length && !cleanup.keepApp,
    still_used_by: live.map((l) => l.install),
  });
}
