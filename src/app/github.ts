import { Octokit } from '@octokit/rest';

// Only a status and a message: Octokit's errors carry the request.
export class GitHubError extends Error {
  constructor(
    readonly status: number | undefined,
    message: string,
  ) {
    super(`GitHub: ${message}`);
  }
}

// @octokit/rest logs every request with its default logger
// (@octokit/plugin-request-log): `${method} ${path} - ${status} with id
// ${id} in ${ms}ms`, `info` on success and `error` on failure, straight to
// the console. A failure already becomes a `GitHubError` with its own
// message below, so that line is never backmesh's to print; `warn` stays
// (real warnings, such as a deprecated endpoint, still show).
const noop = () => undefined;
const quietLog = {
  debug: noop,
  info: noop,
  // Not `console.warn.bind(console)`: that would capture today's
  // `console.warn` for good, so a test that replaces it (`vi.spyOn`) would
  // never see a warning this logs.
  warn: (message: string) => console.warn(message),
  error: noop,
};

async function call<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    const status =
      error instanceof Error && 'status' in error ? Number(error.status) : NaN;
    throw new GitHubError(
      Number.isInteger(status) ? status : undefined,
      error instanceof Error ? error.message : 'request failed',
    );
  }
}

// A sign-in's user (GET /user, which fails with GitHub's 401 for a token it
// refuses) and the IDs of the Apps whose installations it reaches (GET
// /user/installations): a GitHub App's user token reaches only its own
// App's.
export async function signInCheck(
  token: string,
  options: ConstructorParameters<typeof Octokit>[0] = {},
): Promise<{ login: string; appIds: number[] }> {
  const octokit = new Octokit({ log: quietLog, ...options, auth: token });
  const { data } = await call(() => octokit.rest.users.getAuthenticated());
  const installs = await call(() =>
    octokit.rest.apps.listInstallationsForAuthenticatedUser({ per_page: 100 }),
  );
  return {
    login: data.login,
    appIds: installs.data.installations.map((i) => i.app_id),
  };
}
