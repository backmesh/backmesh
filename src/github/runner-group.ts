import { createHash } from 'node:crypto';

import type { Octokit } from '@octokit/rest';

// The org runner group an installation's scale sets join,
// with "Allow public repositories" off, so public repos can't use the
// runners, unless `install --public-repos` turned it on.

// `backmesh-<tag>-<6>`: the org's install tag and six base-36 characters
// from the ID of the listener VM install creates (a listener from before
// its VM: its Deployment's). GitHub routes no jobs to a group whose name was
// deleted and created again, so each install takes a new name, and the
// org's Secret keeps it (`RUNNER_GROUP_ENV`) through restarts, upgrades and
// a VM created again.
export function runnerGroupName(tag: string, listenerId: string): string {
  const digest = createHash('sha256').update(listenerId).digest();
  const id = (digest.readUInt32BE(0) % 36 ** 6).toString(36).padStart(6, '0');
  return `backmesh-${tag}-${id}`;
}

// The one group every install shared before per-install names. backmesh
// never deletes it; uninstall's `cleanUp` deletes its scale sets.
export const LEGACY_RUNNER_GROUP = 'backmesh';

// The groups uninstall deletes: its org's installs on this control plane,
// by tag. Without the control plane's ID, any install's: the Worker mints
// the cleanup token only while no other install of the org is live.
export const isOurRunnerGroup =
  (tag: string | undefined) =>
  (name: string): boolean =>
    new RegExp(`^backmesh-${tag ?? '[a-z0-9]{5}'}-[a-z0-9]{6}$`).test(name);

export interface OrgRunnerGroup {
  id: number;
  name: string;
}

// Creates the group, or takes the existing one and sets its public
// repositories back to `allowPublic` if someone changed them. Scale sets take the group's Actions
// service ID, from ActionsClient.getRunnerGroupByName, as ARC's controller
// does (`autoscalingrunnerset_controller.go` at 0.13.0).
export async function ensureRunnerGroup(
  octokit: Octokit,
  org: string,
  name: string,
  allowPublic: boolean,
): Promise<OrgRunnerGroup> {
  // octokit/rest has no method for the org runner-group routes, so these
  // calls name the route.
  const groups = await octokit.paginate(
    'GET /orgs/{org}/actions/runner-groups',
    { org, per_page: 100 },
  );
  const existing = groups.find((group) => group.name === name);
  if (!existing) {
    const { data } = await octokit.request(
      'POST /orgs/{org}/actions/runner-groups',
      {
        org,
        name,
        visibility: 'all',
        allows_public_repositories: allowPublic,
      },
    );
    return { id: data.id, name: data.name };
  }
  if (existing.allows_public_repositories !== allowPublic) {
    await octokit.request(
      'PATCH /orgs/{org}/actions/runner-groups/{runner_group_id}',
      {
        org,
        runner_group_id: existing.id,
        name,
        allows_public_repositories: allowPublic,
      },
    );
  }
  return { id: existing.id, name: existing.name };
}

// Something already gone counts as deleted, so uninstall can rerun.
async function deleting(request: () => Promise<unknown>): Promise<void> {
  try {
    await request();
  } catch (error) {
    if (!(
      error instanceof Error &&
      'status' in error &&
      error.status === 404
    )) {
      throw error;
    }
  }
}

export function deleteRunnerGroup(
  octokit: Octokit,
  org: string,
  id: number,
): Promise<void> {
  return deleting(() =>
    octokit.request(
      'DELETE /orgs/{org}/actions/runner-groups/{runner_group_id}',
      { org, runner_group_id: id },
    ),
  );
}

export async function listRunnerGroups(
  octokit: Octokit,
  org: string,
): Promise<OrgRunnerGroup[]> {
  const groups = await octokit.paginate(
    'GET /orgs/{org}/actions/runner-groups',
    { org, per_page: 100 },
  );
  return groups.map(({ id, name }) => ({ id, name }));
}

// The org's self-hosted runners, which uninstall checks for leftovers.
export async function listOrgRunners(
  octokit: Octokit,
  org: string,
): Promise<{ id: number; name: string }[]> {
  const runners = await octokit.paginate('GET /orgs/{org}/actions/runners', {
    org,
    per_page: 100,
  });
  return runners.map(({ id, name }) => ({ id, name }));
}

export function deleteOrgRunner(
  octokit: Octokit,
  org: string,
  id: number,
): Promise<void> {
  return deleting(() =>
    octokit.request('DELETE /orgs/{org}/actions/runners/{runner_id}', {
      org,
      runner_id: id,
    }),
  );
}
