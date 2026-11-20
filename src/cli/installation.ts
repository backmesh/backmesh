// What `install` and `status` both read: the installation's identity from the
// hosted API's URL, each org's listener on its VM, and, until `upgrade`
// moves it to one, a listener still on `bm-control` with invariant 3 there.
import { createHash } from 'node:crypto';

import { ORPCError } from '@orpc/client';
import { z } from 'zod';

import type { AnycloudApi } from '../anycloud/client.js';
import { ANYCLOUD_VERSION } from '../anycloud/contract.generated.js';
import { CLOUDS, PUBLIC_VCPUS, type Cloud } from '../runners/classes.js';
import { listListenerVms, type ListenerVm } from './listener-vm.js';

// Where listeners ran before each had its own VM; `upgrade` moves them.
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

// GitHub's public REST read of `path`. It sends GITHUB_TOKEN, else
// GH_TOKEN, when set: a GitHub-hosted runner's shared IP soon spends the
// 60 anonymous reads an hour. GitHub answers a stale token with 401, and one
// an org's SAML SSO refuses with 403, even on a public read, so either
// gets one anonymous retry.
async function readGitHub(
  path: string,
  fetch: typeof globalThis.fetch,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
) {
  const token = env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim();
  const read = async (authorization?: string) => {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        ...(authorization && { authorization }),
      },
      signal,
    });
    return { response, body: await response.text() };
  };
  const first = await read(token && `Bearer ${token}`);
  const rejected = !!(
    token &&
    (first.response.status === 401 ||
      (first.response.status === 403 &&
        !rateLimited(first.response, first.body)))
  );
  return { ...(rejected ? await read() : first), token, rejected };
}

// The org's numeric ID from GitHub's public `GET /orgs/{org}`, which a
// renamed login doesn't change (external).
export async function readOrgId(
  org: string,
  fetch: typeof globalThis.fetch = globalThis.fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const { response, body, token, rejected } = await readGitHub(
    `/orgs/${encodeURIComponent(org)}`,
    fetch,
    env,
  );
  if (response.status === 404) {
    throw new Error(`GitHub has no org named ${org}.`);
  }
  if (rateLimited(response, body)) {
    const advice = !token
      ? 'Set GITHUB_TOKEN to raise it, or retry'
      : rejected
        ? 'Replace the GITHUB_TOKEN or GH_TOKEN that GitHub rejected, or retry'
        : 'Retry';
    throw new Error(
      `GitHub's API rate limit stopped the read of ${org}'s ID (HTTP ${response.status}). ${advice} once it resets.`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `GitHub didn't return ${org}'s ID (HTTP ${response.status}). Retry in a minute.`,
    );
  }
  return z.object({ id: z.number().int() }).parse(JSON.parse(body)).id;
}

// The org's public repositories that aren't archived, of its first 100,
// from GitHub's public `GET /orgs/{org}/repos`: a runner group refuses them
// without `--public-repos` (runner-group.ts), and their jobs wait at GitHub
// with no word to the listener. `more` when GitHub has another page.
// Undefined when GitHub doesn't answer within 10 s, since it only adds a
// warning.
export async function readPublicRepos(
  org: string,
  fetch: typeof globalThis.fetch = globalThis.fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ names: string[]; more: boolean } | undefined> {
  try {
    const { response, body } = await readGitHub(
      `/orgs/${encodeURIComponent(org)}/repos?type=public&per_page=100`,
      fetch,
      env,
      AbortSignal.timeout(10_000),
    );
    if (!response.ok) return undefined;
    const repos = z
      .array(z.object({ full_name: z.string(), archived: z.boolean() }))
      .parse(JSON.parse(body));
    return {
      names: repos.filter((r) => !r.archived).map((r) => r.full_name),
      more: repos.length === 100,
    };
  } catch {
    return undefined;
  }
}

// What the plans and `status` say when the org has public repositories and
// the install no public labels; `fix` is the command that adds them.
export function publicReposWarning(
  org: string,
  { names, more }: { names: readonly string[]; more: boolean },
  fix: string,
) {
  const n = names.length;
  return `${org}: ${n}${more ? '+' : ''} public repositor${n === 1 && !more ? 'y' : 'ies'} (such as ${names[0]}) can't use these runners, and their jobs wait at GitHub. \`${fix}\` adds ${PUBLIC_VCPUS.map((v) => `backmesh-public-${v}`).join(' and ')} for them to use.`;
}

// GitHub's primary rate limit empties `x-ratelimit-remaining`; a secondary
// one sends `retry-after` or names itself in the body.
const rateLimited = ({ status, headers }: Response, body: string) =>
  (status === 403 || status === 429) &&
  (headers.get('x-ratelimit-remaining') === '0' ||
    headers.has('retry-after') ||
    /secondary rate limit/i.test(body));

// Each org's Secret and its anycloud service share one name, as a listener
// from before its VM's Deployment and ServiceAccount (C29) do: `backmesh-` and
// the lower-cased login, since GitHub logins are case-insensitive.
export const listenerName = (org: string) => `backmesh-${org.toLowerCase()}`;
// A GitHub login: up to 39 letters, digits and single inner hyphens.
const LISTENER = /^backmesh-([a-z0-9](?:-?[a-z0-9]){0,38})$/;
export const orgOfListener = (name: string) => LISTENER.exec(name)?.[1];

export const sessionOf = (tag: string) => `bm-${tag}`;

export type NodePool = Awaited<
  ReturnType<AnycloudApi['listNodePools']>
>['nodePools'][number];
export type Deployment = Awaited<
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

/**
 * An org's listener: on its VM, or still a Deployment on `bm-control` that
 * `upgrade` moves to one. Both while a move is under way.
 */
export interface Listener {
  // `backmesh-<org>`.
  name: string;
  vm?: ListenerVm;
  deployment?: Deployment;
}

export interface Installation extends ControlPool {
  // Every org's listener, by name.
  orgs: Listener[];
}

// `bm-control` first, whose read maps a control plane on another anycloud
// to its message.
export async function readInstallation(
  api: AnycloudApi,
): Promise<Installation> {
  const control = await readControlPool(api);
  const vms = await listListenerVms(api);
  const names = [
    ...new Set([...vms, ...control.listeners].map(({ name }) => name)),
  ].sort();
  return {
    ...control,
    problems: [
      ...control.problems,
      ...vms
        .filter((vm) => vm.others.length)
        .map(
          (vm) =>
            `${vm.org} has more than one listener VM: ${[vm.id, ...vm.others].join(', ')}; two listeners contend for its runner group, so terminate all but one`,
        ),
    ],
    orgs: names.map((name) => ({
      name,
      vm: vms.find((vm) => vm.name === name),
      deployment: control.listeners.find((d) => d.name === name),
    })),
  };
}
