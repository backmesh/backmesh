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
import {
  API_URL_ENV as WORKER_URL_ENV,
  INSTALL_KEY_ENV,
  ROTATING_FROM_ENV,
} from './worker.js';

// By digest, from `mirror.gcr.io` as the listener's own base image is: the
// Docker CLI, `/bin/sh`, `sleep`, `base64` and `sed` on linux/amd64.
export const LISTENER_VM_IMAGE =
  'mirror.gcr.io/library/docker:29-cli@sha256:34507eb5069d8be82c95dd3b6987d4250fd5fee49b82e2509b7d7a7030740d6d';
// About $15–32 a month each with its disk and address: the listener needs
// about half a vCPU and 512 MiB, as it had on `bm-control`. `t3.small`,
// `e2-small` and Azure's B-series burst above their baseline, billing a busy
// listener's surplus. Each is linux/amd64, as anycloud's VMs require. On
// Azure a new listener takes the first size its region offers the
// subscription (`vm-sizes.ts`): some offers refuse `Standard_B2s` in every
// region and offer the Bsv2 series. Each is 2 vCPUs: the B2als_v2 and B2ls_v2
// have B2s's 4 GiB, the others 8, the cheapest first after B2s, and the
// control plane's own sizes last, so a region that takes the control plane
// takes a listener too.
export const LISTENER_VM_TYPES: Record<Cloud, readonly string[]> = {
  aws: ['t3.small'],
  gcp: ['e2-small'],
  azure: [
    'Standard_B2s',
    'Standard_B2als_v2',
    'Standard_B2ls_v2',
    'Standard_B2as_v2',
    'Standard_B2s_v2',
    'Standard_D2as_v5',
    'Standard_D2s_v5',
    'Standard_D2s_v4',
  ],
};
// Each size's $/month with its disk and address: Azure's at westus2's
// pay-as-you-go Linux price (Retail Prices API, 2026-11-21), and $2.
export const LISTENER_VM_MONTHLY_USD: Record<string, number> = {
  't3.small': 17,
  'e2-small': 15,
  Standard_B2s: 32,
  Standard_B2als_v2: 29,
  Standard_B2ls_v2: 32,
  Standard_B2as_v2: 57,
  Standard_B2s_v2: 63,
  Standard_D2as_v5: 65,
  Standard_D2s_v5: 72,
  Standard_D2s_v4: 72,
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
  WORKER_URL_ENV,
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
  // Its size, which a VM created in its place keeps.
  vmType: string | null;
  // The VM ended, such as when anycloud found its host gone (`vm.md`, Repair
  // limits) or someone terminated it, and the org's Secret is still there.
  lost: boolean;
  // Other running VMs for the same org, such as one a `vm --wait` that failed
  // on this side left: two listeners contend for one runner group.
  others: string[];
}

/**
 * Each org's listener VM: its running one, else, while its Secret remains,
 * its last one, ended. Running VMs are listed on their own, a short list, so
 * an account's many ended VMs can't push one off the API's 1,000-row page;
 * an ended one is looked for in the newest 1,000 only for an org with none
 * running.
 */
export async function listListenerVms(api: AnycloudApi): Promise<ListenerVm[]> {
  const list = async (stateClass?: 'terminatable') =>
    (
      await api.listWorkloads({
        query: {
          workloadType: 'vm',
          ...(stateClass && { stateClass }),
          limit: '1000',
        },
      })
    ).filter((vm) => VM_ID.test(vm.id));
  const live = (vm: { state: string }) => !TERMINAL.has(vm.state);
  const running = (await list('terminatable')).filter(live);
  const ended = (await list()).filter(
    (vm) =>
      !live(vm) &&
      !running.some((r) => r.secretNames?.join() === vm.secretNames?.join()),
  );
  // An ended VM counts while its org's Secret remains: uninstall deletes the
  // Secret last.
  const saved = ended.length
    ? new Set((await api.listSecrets({ query: {} })).map((s) => s.name))
    : new Set<string>();
  const vms = [...running, ...ended];
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
        vmType: [vm!.vmType ?? []].flat()[0] ?? null,
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
// is parsed by the shell. The file takes one line per value.
export const rollCommand = (values: Record<string, string>) => {
  const multiline = Object.keys(values).find((key) =>
    /[\r\n]/.test(values[key]!),
  );
  if (multiline) throw new Error(`The listener's ${multiline} spans lines.`);
  return [
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
};

// `node -e <script>` in the listener's container, which binds loopback only.
export const inListener = (script: string) =>
  `docker exec ${CONTAINER} node -e ${quote(script)}`;

export interface ListenerPlacement {
  cloud: Cloud;
  region: string;
  credentials: string;
  vmType: string;
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
    ...['--vm-type', where.vmType],
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
