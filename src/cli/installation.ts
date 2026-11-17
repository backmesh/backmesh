// What `install` and `status` both read: the installation's identity from the
// hosted API's URL, each org's listener, and invariant 3 on `bm-control`.
import { createHash } from 'node:crypto';

import { ORPCError } from '@orpc/client';
import { z } from 'zod';

import type { AnycloudApi } from '../anycloud/client.js';
import { ANYCLOUD_VERSION } from '../anycloud/contract.generated.js';
import { CLOUDS, type Cloud } from '../runners/classes.js';

export const CONTROL_POOL = 'bm-control';

// The hosted API's URL is `https://<cluster-id>.anycloud.sh`
// (`docs/reference/cli/cluster.md:90` at v0.1.71).
export function clusterIdOf(apiUrl: string): string {
  const id = /^https:\/\/([a-z0-9-]+)\.anycloud\.sh\/?$/.exec(apiUrl)?.[1];
  if (!id) {
    throw new Error(
      'This machine has no backmesh installation: run `backmesh install`, or run this on the machine that installed it.',
    );
  }
  return id;
}

// The 5-character tag in every runner Job's ID and the org's `bm-<tag>`
// session, from the cluster and the org's numeric ID, so two orgs'
// listeners never scale each other's runners, and install, `status` and
// `uninstall` agree on it without storing it.
export function installTag(clusterId: string, orgId: number): string {
  const digest = createHash('sha256').update(`${clusterId}/${orgId}`).digest();
  return (digest.readUInt32BE(0) % 36 ** 5).toString(36).padStart(5, '0');
}

// Each cloud's anycloud connection on a control plane: `bm-<cloud>-` and 6
// base-36 characters of the cluster ID's hash, so the identity anycloud's
// `--generate` makes for it, `anycloud-<connection>`, is this control
// plane's own in a cloud account others share. At most 15 characters, it
// fits GCP's 30-character service account IDs.
export function connectionName(cloud: Cloud, clusterId: string): string {
  const digest = createHash('sha256').update(clusterId).digest();
  return `bm-${cloud}-${(digest.readUInt32BE(0) % 36 ** 6).toString(36).padStart(6, '0')}`;
}

// The connection install made on this control plane, by its name in
// `credentials list --json`: an installation before 0.4.1 named it
// `bm-<cloud>`, and keeps it.
export const installConnection = <T extends { name: string }>(
  cloud: Cloud,
  clusterId: string,
  listed: readonly T[],
) =>
  listed.find(
    ({ name }) =>
      name === `bm-${cloud}` || name === connectionName(cloud, clusterId),
  );

// The org's numeric ID from GitHub's public `GET /orgs/{org}`, which a
// renamed login doesn't change (external).
export async function readOrgId(
  org: string,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<number> {
  const response = await fetch(
    `https://api.github.com/orgs/${encodeURIComponent(org)}`,
    { headers: { accept: 'application/vnd.github+json' } },
  );
  if (response.status === 404) {
    throw new Error(`GitHub has no org named ${org}.`);
  }
  if (!response.ok) {
    throw new Error(
      `GitHub didn't return ${org}'s ID (HTTP ${response.status}). Retry in a minute.`,
    );
  }
  return z.object({ id: z.number().int() }).parse(await response.json()).id;
}

// Each org's listener Deployment, its ServiceAccount (C29) and its Secret
// share one name: `backmesh-` and the lower-cased login, since GitHub logins
// are case-insensitive.
export const listenerName = (org: string) => `backmesh-${org.toLowerCase()}`;
// A GitHub login: up to 39 letters, digits and single inner hyphens.
const LISTENER = /^backmesh-([a-z0-9](?:-?[a-z0-9]){0,38})$/;
export const orgOfListener = (name: string) => LISTENER.exec(name)?.[1];

export const sessionOf = (tag: string) => `bm-${tag}`;

export type NodePool = Awaited<
  ReturnType<AnycloudApi['listNodePools']>
>['nodePools'][number];
type Deployment = Awaited<
  ReturnType<AnycloudApi['listDeployments']>
>['deployments'][number];

// A listener is an unmanaged `backmesh-<org>` Deployment; anycloud runs
// `job --node-pool` on a managed one (RFC 0044).
const isListener = (deployment: Deployment, pool: NodePool) =>
  !!orgOfListener(deployment.name) &&
  !deployment.managed &&
  deployment.nodePoolId === pool.id;

export interface ControlPool {
  pool?: NodePool;
  // Every org's listener, by name.
  listeners: Deployment[];
  // Invariant 3: why `bm-control` isn't the listeners alone on an
  // unprivileged pool, or why a listener is elsewhere. Empty when it is,
  // or nothing exists yet.
  problems: string[];
}

// Deployments aren't workloads, so this reads both, and neither list filters
// on `bm-control` by name: it compares each `nodePoolId` itself. A pool's
// privileged setting is fixed at create (`node-pools-domain.ts:330`). A control
// plane on another anycloud refuses this release's reads (anycloud's client
// window, `api-version.ts`), and anycloud's own message names anycloud. Its
// message carries both versions.
export const BEHIND_CONTROL_PLANE =
  'This control plane is behind this backmesh; run `backmesh upgrade`.';
export const AHEAD_CONTROL_PLANE =
  'This control plane is ahead of this backmesh; install the latest backmesh release.';

// anycloud's "Client version X must exactly match API version Y."
function controlPlaneAhead(message: string): boolean {
  const served = /API version (\d+(?:\.\d+)*)/.exec(message)?.[1];
  if (!served) return false;
  const a = served.split('.').map(Number);
  const b = ANYCLOUD_VERSION.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

export async function readControlPool(api: AnycloudApi): Promise<ControlPool> {
  const pools = await api
    .listNodePools({ query: {} })
    .catch((error: unknown) => {
      if (
        error instanceof ORPCError &&
        error.code === 'CLIENT_VERSION_MISMATCH'
      ) {
        throw new Error(
          controlPlaneAhead(error.message)
            ? AHEAD_CONTROL_PLANE
            : BEHIND_CONTROL_PLANE,
          { cause: error },
        );
      }
      throw error;
    });
  const pool = pools.nodePools.find(
    (entry) => entry.name === CONTROL_POOL && entry.state !== 'terminated',
  );
  const deployments = (
    await api.listDeployments({ query: {} })
  ).deployments.filter((deployment) => deployment.deletedAt === null);
  const elsewhere = deployments.filter(
    (d) => orgOfListener(d.name) && d.nodePoolId !== pool?.id,
  );
  const problems = elsewhere.map(
    (d) =>
      `A Deployment named ${d.name} runs outside ${CONTROL_POOL}, on node pool ${d.nodePoolId}`,
  );
  if (!pool) return { listeners: [], problems };
  // At most 500 runner Jobs: one 1,000-row page.
  const workloads = await api.listWorkloads({
    query: { stateClass: 'terminatable', limit: '1000' },
  });
  const listeners = deployments
    .filter((d) => isListener(d, pool))
    .sort((a, b) => a.name.localeCompare(b.name));
  const others = [
    ...deployments
      .filter((d) => d.nodePoolId === pool.id && !listeners.includes(d))
      .map((d) => `Deployment ${d.name}${d.managed ? ' (managed)' : ''}`),
    ...workloads
      .filter((w) => w.nodePoolId === pool.id)
      .map((w) => `workload ${w.id}`),
  ];
  if (pool.allowPrivilegedJobs) {
    problems.push(`${CONTROL_POOL} admits privileged Jobs`);
  }
  if (others.length) {
    problems.push(
      `${CONTROL_POOL} runs more than the listeners: ${others.join(', ')}`,
    );
  }
  return { pool, listeners, problems };
}

interface ClusterRecord {
  id: string;
  name?: string;
  cloudProvider?: string | null;
  region?: string | null;
}

/**
 * Where the control plane this machine targets runs: its own cluster record
 * (`cluster list --json`, anycloud 0.1.74), else `bm-control`'s cloud and
 * region, which install creates beside the management VM. Undefined when
 * neither says, such as an install that stopped before `bm-control`. `name`
 * is the cluster record's own, read for nothing but `install`'s re-run
 * reuse check (`backmesh`, not some other anycloud cluster this machine
 * happens to target), and absent when the record wasn't found by ID.
 */
export async function controlPlaneOf(
  run: (args: string[]) => Promise<string>,
  url: string,
  pool: NodePool | undefined,
): Promise<{ cloud: Cloud; region: string; name?: string } | undefined> {
  const id = clusterIdOf(url);
  // An older API, or one that won't list, leaves `bm-control` to say.
  const clusters = await run(['cluster', 'list', '--json'])
    .then((out) => JSON.parse(out) as unknown)
    .catch(() => []);
  const own = (Array.isArray(clusters) ? clusters : []).find(
    (cluster): cluster is ClusterRecord =>
      (cluster as ClusterRecord | null)?.id === id,
  );
  for (const where of [own, pool]) {
    const cloud = where?.cloudProvider?.toLowerCase() as Cloud;
    if (where?.region && CLOUDS.includes(cloud)) {
      return { cloud, region: where.region, name: own?.name };
    }
  }
  return undefined;
}
