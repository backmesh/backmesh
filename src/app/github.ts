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

// The login of a sign-in's user: GET /user, which fails with GitHub's 401
// for a token it refuses.
export async function signInLogin(
  token: string,
  options: ConstructorParameters<typeof Octokit>[0] = {},
): Promise<string> {
  const { data } = await call(() =>
    new Octokit({
      log: quietLog,
      ...options,
      auth: token,
    }).rest.users.getAuthenticated(),
  );
  return data.login;
}
