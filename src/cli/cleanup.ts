// Uninstall's GitHub cleanup, with its cleanup token: backmesh's
// scale sets, leftover runners and runner group in the org. The token can
// only manage the org's self-hosted runners; it stays in memory and is
// never written.
import { Octokit } from '@octokit/rest';

import { ActionsClient } from '../github/actions-client.js';
import { cleanUpGitHub } from '../github/cleanup.js';
import type { Sleep } from '../github/retry.js';
import {
  deleteOrgRunner,
  deleteRunnerGroup,
  isOurRunnerGroup,
  listOrgRunners,
  listRunnerGroups,
} from '../github/runner-group.js';
import { RUNNER_NAME } from '../listener/routes.js';
import { CLASS_VCPUS, classLabel, CLOUDS } from '../runners/classes.js';

export interface GitHubCleanupDeps {
  // The org's install tag, when the control plane's ID is known.
  tag?: string;
  // Only the tag's runners and groups, and not the shared legacy group's
  // scale sets, while another install of the org is live.
  installOnly?: boolean;
  print: (line: string) => void;
  fetch?: typeof globalThis.fetch;
  sleep?: Sleep;
  pollMs?: number;
}

// Every label a runner class has, spot or on demand, KVM or not, on the
// home cloud or another: which classes ran isn't known once the control
// plane is gone.
const LABELS = [
  ...new Set(
    CLOUDS.flatMap((cloud) =>
      [false, true].flatMap((prefixed) =>
        [false, true].flatMap((od) =>
          [false, true].flatMap((kvm) =>
            CLASS_VCPUS.map((vcpus) =>
              classLabel(cloud, prefixed, od, kvm, vcpus),
            ),
          ),
        ),
      ),
    ),
  ),
];

// Answers what GitHub still lists after about 10 minutes of retries. Every
// backmesh runner in the org goes, of any installation, unless
// `installOnly`: the Worker mints the token for the rest only while no other
// install of the org is live.
export async function removeFromGitHub(
  org: string,
  token: string,
  deps: GitHubCleanupDeps,
): Promise<string[]> {
  const fetch = deps.fetch ?? globalThis.fetch;
  const octokit = new Octokit({ auth: token, request: { fetch } });
  const actions = new ActionsClient({ org, octokit, fetch, sleep: deps.sleep });
  let warned = false;
  return cleanUpGitHub(
    {
      labels: LABELS,
      actions,
      rest: {
        listRunnerGroups: () => listRunnerGroups(octokit, org),
        deleteRunnerGroup: (id) => deleteRunnerGroup(octokit, org, id),
        listRunners: () => listOrgRunners(octokit, org),
        deleteRunner: (id) => deleteOrgRunner(octokit, org, id),
      },
      // The first failure, so a lasting one isn't silent for 10 minutes.
      log: ({ error }) => {
        if (warned) return;
        warned = true;
        deps.print(`GitHub cleanup failed (${String(error)}); retrying.`);
      },
      sleep: deps.sleep,
      pollMs: deps.pollMs,
    },
    {
      runner: (name) =>
        RUNNER_NAME.test(name) &&
        (!deps.installOnly || name.startsWith(`bm${deps.tag}-`)),
      group: isOurRunnerGroup(deps.tag),
      legacy: !deps.installOnly,
    },
  );
}
