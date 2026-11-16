import { Octokit } from '@octokit/rest';
import { z } from 'zod';

import type { Fetch } from './retry.js';

// The token broker: the Worker mints an installation
// token of backmesh's App for the install key's own org.
export interface BrokerCredentials {
  // The Worker, `https://api.backmesh.com`.
  url: string;
  installKey: string;
  // The listener's `ORG`: a token for any other org is refused.
  org: string;
}

// The broker's 409: the App isn't installed on the org yet.
export class AppNotInstalled extends Error {
  constructor(readonly installUrl: string) {
    super(`The backmesh App isn't installed; install it at ${installUrl}`);
  }
}

// The broker's 401: the install key is unknown or revoked, as step 6 of an
// uninstall leaves it.
export class KeyRefused extends Error {}

const tokenSchema = z.object({
  token: z.string(),
  expires_at: z.iso.datetime(),
  permissions: z.record(z.string(), z.string()),
  org: z.object({ id: z.number(), login: z.string() }),
});
const notInstalledSchema = z.object({
  error: z.literal('app_not_installed'),
  install_url: z.string(),
});

// A token lasts an hour. Refreshing with 30 minutes left, in the background
// while the current token serves, rides out a shorter broker outage.
const REFRESH_MARGIN_MS = 30 * 60_000;
// A token this close to expiry isn't handed out.
const EXPIRY_MARGIN_MS = 60_000;
// After a failed background refresh, the next waits this long.
const RETRY_MS = 60_000;

export class InstallationTokens {
  private token: { value: string; expiresAt: number } | undefined;
  // What the last token was granted, such as `{ actions: 'read' }`: the
  // installation keeps its old permissions until an org owner approves new
  // ones. Undefined before the first mint.
  permissions: Record<string, string | undefined> | undefined;
  // Since when the broker has failed or refused, and the latest reason;
  // null once it mints or answers 409.
  unreachable: { since: string; error: string } | null = null;
  // Since when the broker has answered that the App isn't installed on the
  // org, with its install link; null once it mints. After a token, this is
  // an installation an owner removed.
  notInstalled: { since: string; installUrl: string } | null = null;
  private pending: Promise<string> | undefined;
  private failedAt = -Infinity;

  constructor(
    private readonly credentials: BrokerCredentials,
    private readonly fetch: Fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // Concurrent callers share one mint. Only a caller without a usable
  // token waits for it.
  async get(): Promise<string> {
    const now = this.now().getTime();
    const left = (this.token?.expiresAt ?? 0) - now;
    if (this.token && left > REFRESH_MARGIN_MS) return this.token.value;
    if (this.token && left > EXPIRY_MARGIN_MS) {
      if (now - this.failedAt >= RETRY_MS) void this.refresh().catch(() => {});
      return this.token.value;
    }
    return this.refresh();
  }

  private refresh(): Promise<string> {
    this.pending ??= this.mint()
      .catch((error: unknown) => {
        this.failedAt = this.now().getTime();
        throw error;
      })
      .finally(() => (this.pending = undefined));
    return this.pending;
  }

  private async mint(): Promise<string> {
    const { url, installKey, org } = this.credentials;
    const fail = (
      error: string,
      Type: new (message: string) => Error = Error,
    ) => {
      const since = this.unreachable?.since ?? this.now().toISOString();
      this.unreachable = { since, error };
      return new Type(error);
    };
    const response = await this.fetch(`${url}/v1/token`, {
      method: 'POST',
      headers: { authorization: `Bearer ${installKey}` },
    }).catch((error: unknown) => {
      throw fail(`The token broker didn't answer: ${String(error)}`);
    });
    const body: unknown = await response.json().catch(() => undefined);
    const notInstalled =
      response.status === 409 && notInstalledSchema.safeParse(body).data;
    if (notInstalled) {
      this.unreachable = null;
      this.notInstalled = {
        since: this.notInstalled?.since ?? this.now().toISOString(),
        installUrl: notInstalled.install_url,
      };
      throw new AppNotInstalled(notInstalled.install_url);
    }
    if (response.status === 401) {
      throw fail(
        'backmesh.com refused the install key (401); run `backmesh upgrade` to sign in again',
        KeyRefused,
      );
    }
    const why = z.object({ error: z.string() }).safeParse(body).data?.error;
    if (!response.ok) {
      throw fail(
        `The token broker answered ${response.status}${why ? `: ${why}` : ''}`,
      );
    }
    const parsed = tokenSchema.safeParse(body);
    if (!parsed.success)
      throw fail('The token broker gave an unexpected answer');
    const data = parsed.data;
    if (data.org.login.toLowerCase() !== org.toLowerCase()) {
      throw fail(
        `The token broker gave a token for ${data.org.login}, not ${org}`,
      );
    }
    this.token = { value: data.token, expiresAt: Date.parse(data.expires_at) };
    this.permissions = data.permissions;
    this.unreachable = null;
    this.notInstalled = null;
    return data.token;
  }
}

// An Octokit for GitHub's REST API that authenticates with the current
// installation token on every request.
export function installationOctokit(
  tokens: InstallationTokens,
  fetch: Fetch,
): Octokit {
  const octokit = new Octokit({ request: { fetch } });
  octokit.hook.before('request', async (options) => {
    options.headers.authorization = `token ${await tokens.get()}`;
  });
  return octokit;
}
