import type { RunAnycloud } from '../anycloud/binary.js';
import type { AnycloudApi } from '../anycloud/client.js';

// The anycloud calls the app makes. Callers pass the pinned binary and the
// API client; tests pass fakes. Secrets go through the API (`PUT
// /secrets/{name}`, `GET /secrets`), so a value is never in argv or an exec
// error. The rest go through the CLI, whose arguments hold nothing secret.
// A service token comes back on stdout, never through argv.
export function anycloudControl(api: AnycloudApi, run: RunAnycloud) {
  const cli = async (...args: string[]) => void (await run(args));
  const token = async (args: string[]) =>
    (JSON.parse(await run([...args, '--json'])) as { token: string }).token;
  return {
    saveSecret: async (name: string, values: Record<string, string>) =>
      void (await api.saveSecret({ params: { name }, body: { values } })),
    // An owner-issued service token (anycloud phase 2a): the API keeps only
    // its SHA-256, so it's shown once. A service already registered, such as
    // by an install that stopped before its Secret, gets a new one; any
    // other refusal is the add's.
    issueServiceToken: (service: string) =>
      token(['api', 'access', 'add', '--service', service]).catch(
        (error: unknown) => {
          if (!String(error).includes('API_ACCESS_SERVICE_EXISTS')) throw error;
          return token(['api', 'token', 'rotate', '--service', service]);
        },
      ),
    rotateServiceToken: (service: string) =>
      token(['api', 'token', 'rotate', '--service', service]),
    removeService: (service: string) =>
      cli('api', 'access', 'remove', '--service', service),
    // C29 (RFC 0049 release 1): a Deployment's ServiceAccount, which a
    // listener from before its VM has.
    removeServiceAccount: (deployment: string) =>
      cli('api', 'access', 'remove', '--service-account', deployment),
  };
}

export type AnycloudControl = ReturnType<typeof anycloudControl>;
