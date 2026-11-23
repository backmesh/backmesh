import { ORPCError } from '@orpc/client';

import type { AnycloudApi } from '../anycloud/client.js';
import { GIB_PER_VCPU } from '../runners/classes.js';
import type { Route } from './routes.js';

// anycloud's terminal states (`TERMINAL_STATES`, `src/shared/workload.ts` at
// v0.1.71). Any other state, even one added later, is a Job that's actual.
export const TERMINAL = new Set([
  'completed',
  'errored',
  'failed',
  'invalid',
  'terminated',
]);

// Each runner VM's disk. anycloud's VM Job default is 30 GB
// on AWS (`job-host.ts:82`), which a job building Docker images fills: the
// local-smolvm suites hit "no space left on device" on it. 100 GB
// is GCP's default and about what a GitHub-hosted runner has.
export const RUNNER_DISK_GB = 100;

// anycloud's `high` disk tier gives AWS gp3 8,000 IOPS and 1,000 MiB/s; a
// runner's own image pull and start cost about 0.6 s more at 4,000 IOPS /
// 500 MiB/s (anycloud's image-pull spike's measured config), which saves
// about $0.009 per 10-minute job (owner, 2026-11-13). AWS gp3 bills IOPS and
// MiB/s separately, so both need to drop for the full saving: throughput
// alone, still at 8,000 IOPS, saves only about half. Disk size stays the
// tier's, and GCP and Azure have no gp3 equivalent to tune (anycloud's
// `assertGp3Performance` refuses the fields off AWS).
export const AWS_RUNNER_DISK_IOPS = 4_000;
export const AWS_RUNNER_DISK_THROUGHPUT_MIBPS = 500;

export interface RunnerJob {
  id: string;
  state: string;
  // anycloud's `startedAt`: the insert sets it to now
  // (`src/api/services/repositories/workload-creation.ts:107,143`), and only a
  // retry or resubmit resets it, which backmesh Jobs never have.
  submittedAt: number;
  // anycloud's status reason, such as a launch's capacity error.
  latestMessage: string | null;
  // Whether its VM is spot.
  spot: boolean;
  // Where it launched; null until a multi-region Job is placed. Optional,
  // for the scaler's quota.
  region?: string | null;
}

// Another listener's runner Job on the control plane, for the quota it
// shares.
export interface ElsewhereJob {
  id: string;
  spot: boolean;
  region: string | null;
}

// How a Job ended, and on which VM: a reclaim's note names them.
export interface JobEnd {
  // `null` while the Job hasn't ended.
  reason: Workload['endReason'];
  // What the Job's last event says, such as "Exited with code 1": anycloud
  // writes none for an exit 0, its `completed` state.
  detail: string | null;
  cloud: string | null;
  region: string | null;
  vmType: string | null;
  spot: boolean;
  // The quota and capacity refusals before it ran, or before it ended.
  refusals: Refusal[];
}

// A launch the cloud refused for quota or capacity before the runner ran:
// anycloud's `retrying` event for a failed Provisioning step names its
// target and diagnosis (`src/api/services/workload-workflows/vm-host-startup.ts:254-276`,
// `task.ts:284-298`; the names in `src/shared/cloud.ts:23-33`).
export interface Refusal {
  region: string;
  diagnosis: string;
}

// A runner Job's timeline in anycloud, from one
// status read: its submit, when its VM's Docker was ready and the image
// pulled, when the runner's container started (`running`), where it
// launched and the launches refused before.
export interface RunnerTimeline {
  // anycloud's `startedAt`, the submit.
  submittedAt: number;
  // The last `downloading` and `starting` events before `running`: the
  // pull's start, once the VM answered SSH with Docker up, and its end
  // (anycloud 0.1.76 `vm-host-startup.ts`, one step each).
  dockerReadyAt: number | null;
  pulledAt: number | null;
  // Whether the VM's user data had pulled the image before anycloud's
  // pull step (its `imagePull` reason `prepulled`); null without it.
  prepulled: boolean | null;
  runningAt: number | null;
  region: string | null;
  refusals: Refusal[];
  // The regions whose refusal left anycloud no untried target, so the Job
  // waited a provisioning backoff (`refusals`).
  backedOff: string[];
  // When anycloud re-queued the Job after its last refusal; null with none.
  refusedUntil: number | null;
}

export interface RunnerVm {
  vmType: string | null;
  region: string | null;
  bootMs: number | null;
  refusals: number;
}

export type RunnerSpec = Pick<
  Route,
  'cloud' | 'regions' | 'credentials' | 'vmTypes' | 'kvm' | 'vcpus' | 'gpu'
> & {
  id: string;
  spot: boolean;
  jitConfig: string;
  // The runner's cache Secret.
  secrets?: string[];
};

// One listing of the control plane's unended runner Jobs: this listener's
// own, and how many every other org's listener has.
export interface RunnerListing {
  mine: RunnerJob[];
  others: number;
  // Every other listener's runner Jobs, for the quota they share.
  elsewhere?: ElsewhereJob[];
}

// The anycloud calls the listener makes; tests pass a fake.
export interface RunnerJobs {
  list(): Promise<RunnerListing>;
  submit(spec: RunnerSpec): Promise<void>;
  // `undefined` when there's no such Job: its submit never landed.
  end(id: string): Promise<JobEnd | undefined>;
  // `undefined` when there's no such Job.
  timeline(id: string): Promise<RunnerTimeline | undefined>;
  terminate(id: string): Promise<void>;
}

// Half the class's memory, as the tmpfs default GitHub's runners have.
export const shmSize = (vcpus: number) => `${(vcpus * GIB_PER_VCPU) / 2}g`;

type VmJob = Extract<
  Parameters<AnycloudApi['submitWorkload']>[0]['body'],
  { image: string }
>;
type Status = Awaited<ReturnType<AnycloudApi['getWorkloadStatus']>>;
type Workload = Status['workload'];

// Where the VM launched: an unpinned Job's `region` stays null, and its VM
// row has it (`src/api/services/repositories/workload-queries.ts:237,257`).
const launchedRegion = (status: Status) =>
  status.vms?.at(-1)?.region ?? status.workload.region ?? null;

// anycloud's quota refusals (its gateways' `classifyError`), in the order
// `backmesh status` names the one to raise: GCP's CPUS_ALL_REGIONS, then the
// regional spot vCPUs.
export const QUOTA_REFUSALS: readonly string[] = [
  'quota-exhausted-account',
  'account-regional-spot-quota-exhausted',
  'quota-exhausted-region',
];
const REFUSED = new Set([...QUOTA_REFUSALS, 'capacity-exhausted']);

// The launches refused before the runner first ran, and when anycloud
// re-queued the Job after the last one, or that refusal's time while it
// hasn't. `backedOff` has the regions of the refusals that sent it
// into a provisioning backoff: anycloud retries a refusal at once while its
// claim saw a target (a VM type, zone or region) still untried, and waits
// only once none is left (anycloud 0.1.74 `retry-candidates.ts`,
// `failoverToUntried`).
function refusals(status: Status) {
  const { events } = status;
  const running = events.findIndex((e) => e.state === 'running');
  let untried = 0;
  const backedOff = new Set<string>();
  const refused = events
    .slice(0, running < 0 ? undefined : running)
    .map(({ state, metadata }) => {
      const {
        targetRegion: region,
        diagnosis,
        launchFailover,
        untriedTargets,
      } = metadata ?? {};
      if (state === 'provisioning' && typeof untriedTargets === 'number') {
        untried = untriedTargets;
      }
      if (
        state !== 'retrying' ||
        typeof region !== 'string' ||
        typeof diagnosis !== 'string' ||
        !REFUSED.has(diagnosis)
      ) {
        return null;
      }
      if (!(launchFailover === true && untried > 0)) backedOff.add(region);
      return { region, diagnosis };
    });
  const last = refused.findLastIndex(Boolean);
  const requeued = events.find((e, i) => i > last && e.state === 'queued');
  return {
    list: refused.filter((r) => r !== null),
    backedOff: [...backedOff],
    until: last < 0 ? null : (requeued ?? events[last]!).createdAt,
  };
}

// A runner Job is submitted with `maxRetries: 0`, so when its VM is
// reclaimed or goes away it's `recovering` only until anycloud's next
// reconcile, which fails it with the end reason `reclaimed` or `lost` before
// any rerun (anycloud 0.1.76 `workload-workflows/vm-job-max-retries.ts`,
// `retry-recovery.ts:500`). It then leaves the listing, so the scaler's next
// count replaces it like any other ended runner.
export const RECOVERING = 'recovering';

// A runner Job's status with every event; undefined when there's no such Job.
async function read(api: AnycloudApi, id: string, signal?: AbortSignal) {
  try {
    return await api.getWorkloadStatus(
      { params: { id }, query: { eventsLimit: 'all' } },
      { signal },
    );
  } catch (error) {
    if (error instanceof ORPCError && error.status === 404) return;
    throw error;
  }
}

// A started runner's VM, for its telemetry event: by `JobStarted` its VM
// Job is placed and running, so it names its VM type and region, its boot is
// the submit to `running`, and its refused launches are all in.
export async function runnerVm(
  api: AnycloudApi,
  id: string,
  signal: AbortSignal,
): Promise<RunnerVm | undefined> {
  const status = await read(api, id, signal);
  if (!status) return;
  const { vmType, startedAt } = status.workload;
  const running = status.events.find((event) => event.state === 'running');
  return {
    vmType: typeof vmType === 'string' ? vmType : null,
    region: launchedRegion(status),
    bootMs: running ? Math.max(0, running.createdAt - startedAt) : null,
    refusals: refusals(status).list.length,
  };
}

export function anycloudRunnerJobs(
  api: AnycloudApi,
  install: string,
  image: string,
): RunnerJobs {
  // Session attribution scopes the listing and the cost.
  const session = `bm-${install}`;
  return {
    async list() {
      // Every `bm-*` session, a prefix match: the 500-runner cap is the
      // control plane's. 1,000 rows holds the cap and its overshoot of 50
      // per other listener for up to 11 listeners, so one page is complete.
      const items = (
        await api.listWorkloads({
          query: { session: 'bm-', stateClass: 'terminatable', limit: '1000' },
        })
      ).filter(
        (item) => item.session?.startsWith('bm-') && !TERMINAL.has(item.state),
      );
      const mine = items.filter((item) => item.session === session);
      return {
        mine: mine.map(
          ({ id, state, startedAt, latestMessage, spot, region }) => ({
            id,
            state,
            submittedAt: startedAt,
            latestMessage,
            spot,
            region,
          }),
        ),
        others: items.length - mine.length,
        elsewhere: items
          .filter((item) => item.session !== session)
          .map(({ id, spot, region }) => ({ id, spot, region })),
      };
    },
    async submit(spec) {
      const {
        id,
        cloud,
        credentials,
        regions,
        vmTypes,
        spot,
        kvm,
        vcpus,
        gpu,
        jitConfig,
        secrets,
      } = spec;
      // A region list (anycloud 0.1.74) places only where a KVM class's
      // types nest, since its types and regions are the union of its
      // regions'; install writes one only for an anycloud with it.
      const placement =
        regions.length > 1
          ? { cloudConfig: { regions: [...regions] } }
          : { cloudConfig: { region: regions[0]! } };
      // One VM per runner, the first of its types with capacity, in the
      // cheapest of its regions anycloud can place it in, failing over among
      // them. With `maxRetries: 0`, a reclaimed or lost VM ends the Job
      // instead of rerunning its JIT config, and a clean exit on an AWS or
      // GCP spot VM ends it at once rather than after anycloud's 150 s
      // reclaim grace (0.1.74). On demand gets the same cap:
      // a lost host ends the Job rather than restarting a spent runner.
      const body: VmJob = {
        image,
        credentialName: credentials,
        ...placement,
        cloudConfig: {
          ...placement.cloudConfig,
          vmType: [...vmTypes],
          spot,
          diskSizeGb: RUNNER_DISK_GB,
          ...(cloud === 'aws' && {
            diskIops: AWS_RUNNER_DISK_IOPS,
            diskThroughputMibps: AWS_RUNNER_DISK_THROUGHPUT_MIBPS,
          }),
        },
        workloadType: 'job',
        maxRetries: 0,
        // A runner Job never resumes (maxRetries 0), so a spot one needs no
        // checkpoint bucket; anycloud would mount it at /mnt/checkpoint,
        // which the /mnt bind below overlaps and admission refuses.
        noCheckpoint: true,
        id,
        // The runner's name is its Job's ID: runner-job reads the cache
        // Secret's file by it. Its start-up timings count from here.
        env: {
          RUNNER_JITCONFIG: jitConfig,
          BACKMESH_RUNNER_NAME: id,
          BACKMESH_SUBMITTED_AT: String(Date.now()),
        },
        ...(secrets && { secrets }),
        // The job uses its VM's Docker through the host's socket, and a KVM
        // class's VM nests, with `/dev/kvm` passed in. On the
        // VM's network, a port a job's container publishes is the runner's
        // `localhost`, as on GitHub's runners. anycloud shares /workspace,
        // where the runner's work, RUNNER_TEMP, tool cache and HOME live, at
        // the same path; /tmp, /var/tmp and /mnt are bound too, so a
        // `docker run -v` of a path there finds the same files on the VM
        // (runner-job.sh `share_paths`). The job already controls its one-job
        // VM's Docker, so these give it nothing more. A GPU class's VM gets
        // anycloud's NVIDIA base image, with the driver and the container
        // toolkit, so its GPU passes into the runner's container, where
        // `nvidia-smi` and CUDA work, and the job's own `docker run --gpus
        // all` works on the VM's Docker.
        hostDocker: true,
        ...(kvm && { requireNestedVirtualization: true }),
        dockerOptions: {
          network: 'host',
          shmSize: shmSize(vcpus),
          binds: ['/tmp:/tmp', '/var/tmp:/var/tmp', '/mnt:/mnt'],
          ...(gpu && { gpus: 'all' }),
        },
        session,
        agent: 'backmesh',
      };
      await api.submitWorkload({ body });
    },
    async end(id) {
      const status = await read(api, id);
      if (!status) return;
      const { endReason, state, cloudProvider, vmType, spot } = status.workload;
      const said = status.events.at(-1)?.metadata;
      const text = [said?.message, said?.reason].find(
        (value) => typeof value === 'string',
      );
      return {
        reason: endReason,
        detail: state === 'completed' ? 'Exited with code 0' : (text ?? null),
        cloud: cloudProvider?.toLowerCase() ?? null,
        region: launchedRegion(status),
        // A list is the candidates before placement, not the VM.
        vmType: typeof vmType === 'string' ? vmType : null,
        spot,
        refusals: refusals(status).list,
      };
    },
    async timeline(id) {
      const status = await read(api, id);
      if (!status) return;
      const refused = refusals(status);
      const { events } = status;
      const running = events.findIndex((event) => event.state === 'running');
      const before = running < 0 ? events : events.slice(0, running);
      const step = (state: string) =>
        before.findLast((event) => event.state === state);
      const pull = step('downloading')?.metadata?.imagePull as
        { reason?: unknown } | undefined;
      return {
        submittedAt: status.workload.startedAt,
        dockerReadyAt: step('downloading')?.createdAt ?? null,
        pulledAt: step('starting')?.createdAt ?? null,
        prepulled: pull ? pull.reason === 'prepulled' : null,
        runningAt: events[running]?.createdAt ?? null,
        region: launchedRegion(status),
        refusals: refused.list,
        backedOff: refused.backedOff,
        refusedUntil: refused.until,
      };
    },
    async terminate(id) {
      await api.terminateWorkload({ params: { id }, query: { session } });
    },
  };
}
