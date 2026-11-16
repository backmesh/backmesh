import type { RunAnycloud } from '../anycloud/binary.js';
import type { AnycloudApi } from '../anycloud/client.js';

// The anycloud calls the app makes. Callers pass the pinned binary and the
// API client; tests pass fakes. Secrets go through the API (`PUT
// /secrets/{name}`, `GET /secrets`), so a value is never in argv or an exec
// error. The rest go through the CLI (`deployments.md:175-182` on anycloud
// main; `--service-account` per RFC 0049 § C29), whose arguments hold nothing
// secret.
export function anycloudControl(api: AnycloudApi, run: RunAnycloud) {
  const cli = async (...args: string[]) => void (await run(args));
  return {
    saveSecret: async (name: string, values: Record<string, string>) =>
      void (await api.saveSecret({ params: { name }, body: { values } })),
    // C29 (RFC 0049 release 1): a Deployment's ServiceAccount as an API member.
    addServiceAccount: (deployment: string) =>
      cli('api', 'access', 'add', '--service-account', deployment),
    removeServiceAccount: (deployment: string) =>
      cli('api', 'access', 'remove', '--service-account', deployment),
  };
}

export type AnycloudControl = ReturnType<typeof anycloudControl>;
