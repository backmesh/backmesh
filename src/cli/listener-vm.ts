// Each org's listener on its own small `anycloud vm`: the VM's container is
// a Docker CLI with the host's Docker socket (`docs/reference/cli/vm.md` at
// v0.1.78), which runs the listener image as its own container with
// `--restart=always`, so Docker restarts a crash and a host reboot. Its
// settings are the org's Secret: the VM gets it as its container's
// environment at create, and every later change is written to the VM's
// env file through `anycloud exec`'s API route: never in argv on the
// operator's machine or in the API's records, and on the VM only in the
// shell that exec runs, inside the VM's own trust boundary (`vm.md`). anycloud
// never replaces a lost VM: `status` reports one and `upgrade` creates
// another.
import { randomBytes } from 'node:crypto';

import type { RunAnycloud } from '../anycloud/binary.js';
import type { AnycloudApi, AnycloudExec } from '../anycloud/client.js';
import type { Cloud } from '../runners/classes.js';
import { OVERRIDE_ENV } from '../app/override.js';
import {
  API_TOKEN_ENV,
  API_URL_ENV,
  LISTENER_IMAGE_ENV,
  RUNNER_GROUP_ENV,
} from '../listener/env.js';
import { RUNNERS_ENV } from '../listener/routes.js';
import { TERMINAL } from '../listener/runner-jobs.js';
import { CACHE_CAP_ENV } from '../listener/sweep.js';
import { listenerName, orgOfListener } from './installation.js';
import { INSTALL_KEY_ENV, ROTATING_FROM_ENV } from './worker.js';

// By digest, from `mirror.gcr.io` as the listener's own base image is: the
// Docker CLI, `/bin/sh`, `sleep`, `base64` and `sed` on linux/amd64.
export const LISTENER_VM_IMAGE =
  'mirror.gcr.io/library/docker:29-cli@sha256:34507eb5069d8be82c95dd3b6987d4250fd5fee49b82e2509b7d7a7030740d6d';
// About $15–32 a month each with its disk and address: the listener needs
// about half a vCPU and 512 MiB, as it had on `bm-control`. `t3.small` and
// `e2-small` burst above their baseline, billing a busy listener's surplus.
// Each is linux/amd64, as anycloud's VMs require.
export const LISTENER_VM_TYPE: Record<Cloud, string> = {
  aws: 't3.small',
  gcp: 'e2-small',
  azure: 'Standard_B2s',
};
export const LISTENER_VM_MONTHLY_USD: Record<Cloud, number> = {
  aws: 17,
  gcp: 15,
  azure: 32,
};

// Every value the org's Secret may hold (`secretValues`).
const SECRET_NAMES = [
  'ORG',
  'ORG_ID',
  'BACKMESH_INSTALL',
  'BACKMESH_RUNNER_IMAGE',
  LISTENER_IMAGE_ENV,
  RUNNER_GROUP_ENV,
  API_URL_ENV,
  API_TOKEN_ENV,
  INSTALL_KEY_ENV,
  RUNNERS_ENV,
  ROTATING_FROM_ENV,
  CACHE_CAP_ENV,
  OVERRIDE_ENV,
];

const CONTAINER = 'backmesh-listener';
// `/workspace` is the VM's host directory, `0777`; this one is root's alone.
const DIR = '/workspace/backmesh';
const ENV_FILE = `${DIR}/listener.env`;

// `bml-`, the org's install tag and 6 random base-36 characters: anycloud
// caps a workload ID at 28, too short for a login. Each VM takes a new one,
// as anycloud keeps a terminated VM's.
export const listenerVmId = (tag: string) =>
  `bml-${tag}-${(randomBytes(4).readUInt32BE(0) % 36 ** 6).toString(36).padStart(6, '0')}`;
const VM_ID = /^bml-[a-z0-9]{5}-[a-z0-9]{6}$/;

export interface ListenerVm {
  id: string;
  // The Secret it was created with, `backmesh-<org>`, which names its org.
  name: string;
  org: string;
  cloud: string | null;
  region: string | null;
  // The VM ended, such as when anycloud found its host gone (`vm.md`, Repair
  // limits) or someone terminated it, and the org's Secret is still there.
  lost: boolean;
  // Other running VMs for the same org, such as one a `vm --wait` that failed
  // on this side left: two listeners contend for one runner group.
  others: string[];
}

/**
 * Each org's listener VM: its running one, else, while its Secret remains,
 * its last one, ended. At most 1,000 VMs, the API's one page.
 */
export async function listListenerVms(api: AnycloudApi): Promise<ListenerVm[]> {
  const vms = (
    await api.listWorkloads({ query: { workloadType: 'vm', limit: '1000' } })
  ).filter((vm) => VM_ID.test(vm.id));
  const live = (vm: (typeof vms)[number]) => !TERMINAL.has(vm.state);
  // An ended VM counts while its org's Secret remains: uninstall deletes the
  // Secret last.
  const saved = vms.every(live)
    ? new Set<string>()
    : new Set((await api.listSecrets({ query: {} })).map((s) => s.name));
  const byOrg = new Map<string, (typeof vms)[number][]>();
  for (const vm of vms) {
    const name = vm.secretNames?.find((s) => orgOfListener(s));
    if (!name || !(live(vm) || saved.has(name))) continue;
    byOrg.set(name, [...(byOrg.get(name) ?? []), vm]);
  }
  return [...byOrg]
    .map(([name, all]) => {
      const running = all.filter(live);
      const [vm] = running.length
        ? running
        : all.toSorted((a, b) => b.startedAt - a.startedAt);
      return {
        id: vm!.id,
        name,
        org: orgOfListener(name)!,
        cloud: vm!.cloudProvider?.toLowerCase() ?? null,
        region: vm!.region,
        lost: !running.length,
        others: running.slice(1).map(({ id }) => id),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

// Pulls the env file's image and starts the listener from it, replacing any
// listener container: Docker's `--restart=always` restarts it after a crash
// or a reboot.
const restart = [
  `IMAGE=$(sed -n 's/^${LISTENER_IMAGE_ENV}=//p' ${ENV_FILE})`,
  'docker pull -q "$IMAGE" >/dev/null',
  // SIGTERM first, so the old listener deletes its GitHub sessions and the
  // new one opens them at once rather than after GitHub expires them.
  `docker stop -t 60 ${CONTAINER} >/dev/null 2>&1 || true`,
  `docker rm -f ${CONTAINER} >/dev/null 2>&1 || true`,
  `docker run -d --name ${CONTAINER} --restart=always --log-opt max-size=50m --log-opt max-file=3 --env-file ${ENV_FILE} "$IMAGE" >/dev/null`,
];

// Starts the listener from its env file, the last roll's. A new VM has none
// yet: its container's environment holds the Secret as it was at create.
export const startCommand = () =>
  [
    'set -e',
    `mkdir -p ${DIR}`,
    `chmod 700 ${DIR}`,
    `[ -s ${ENV_FILE} ] || env | grep -E '^(${SECRET_NAMES.join('|')})=' > ${ENV_FILE}`,
    ...restart,
  ].join('\n');

// `values` replace the env file, written whole through base64 so no value
// is parsed by the shell.
export const rollCommand = (values: Record<string, string>) =>
  [
    'set -e',
    `mkdir -p ${DIR}`,
    `chmod 700 ${DIR}`,
    `printf %s ${quote(
      Buffer.from(
        Object.entries(values)
          .map(([key, value]) => `${key}=${value}\n`)
          .join(''),
      ).toString('base64'),
    )} | base64 -d > ${ENV_FILE}`,
    ...restart,
  ].join('\n');

// `node -e <script>` in the listener's container, which binds loopback only.
export const inListener = (script: string) =>
  `docker exec ${CONTAINER} node -e ${quote(script)}`;

export interface ListenerPlacement {
  cloud: Cloud;
  region: string;
  credentials: string;
}

export interface ListenerVmDeps {
  exec: AnycloudExec;
  // For `vm --wait`, which runs for minutes.
  runLong: RunAnycloud;
}

const checked = async (
  exec: AnycloudExec,
  id: string,
  command: string,
  what: string,
) => {
  const { code, stderr } = await exec(id, command);
  if (code !== 0) {
    throw new Error(
      `${what} on ${id} failed${stderr.trim() ? `: ${stderr.trim().split('\n').at(-1)}` : ` (exit ${code})`}.`,
    );
  }
};

/** Creates `org`'s listener VM with its Secret, saved first. */
export const createVm = (
  org: string,
  id: string,
  where: ListenerPlacement,
  runLong: RunAnycloud,
) =>
  runLong([
    ...['vm', LISTENER_VM_IMAGE, '--id', id],
    ...['--credentials', where.credentials, '--region', where.region],
    ...['--vm-type', LISTENER_VM_TYPE[where.cloud]],
    ...['--secret', listenerName(org), '--wait'],
  ]);

/** Creates `org`'s listener VM with its Secret and starts the listener. */
export async function createListenerVm(
  org: string,
  id: string,
  where: ListenerPlacement,
  deps: ListenerVmDeps,
): Promise<void> {
  await createVm(org, id, where, deps.runLong);
  await startListener(deps.exec, org, id);
}

/** Starts the listener on its VM again, from its last settings. */
export const startListener = (exec: AnycloudExec, org: string, id: string) =>
  checked(exec, id, startCommand(), `${org}'s listener start`);

/** Writes the listener's settings to its VM and restarts it with them. */
export const rollListenerVm = (
  exec: AnycloudExec,
  id: string,
  values: Record<string, string>,
) => checked(exec, id, rollCommand(values), 'The listener roll');
