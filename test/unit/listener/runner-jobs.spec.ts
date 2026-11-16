import { afterEach, describe, expect, it, vi } from 'vitest';

import { anycloudApi } from '../../../src/anycloud/client.js';
import {
  anycloudRunnerJobs,
  runnerVm,
  shmSize,
  type RunnerSpec,
} from '../../../src/listener/runner-jobs.js';

function fakeApi(respond: (request: Request) => Response) {
  const requests: { request: Request; body: unknown }[] = [];
  let token = 0;
  const api = anycloudApi(
    'https://api.example',
    async () => `sa-token-${++token}`,
    async (input, init) => {
      const request = new Request(input, init);
      const text = await request.clone().text();
      requests.push({ request, body: text ? JSON.parse(text) : undefined });
      return respond(request);
    },
  );
  return {
    api,
    jobs: anycloudRunnerJobs(api, 'abc12', 'runner@sha256:1'),
    requests,
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('anycloudRunnerJobs', () => {
  afterEach(() => vi.useRealTimers());

  it('submits one VM Job on the host Docker, on the first of its types with capacity', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 10, 5, 12));
    const { jobs, requests } = fakeApi(() => json(202, { id: 'x' }));
    const spec: RunnerSpec = {
      id: 'bmabc12-a4-00000000',
      cloud: 'aws',
      regions: ['us-east-2'],
      credentials: 'bm-aws',
      vmTypes: ['m6a.xlarge', 'm7a.xlarge'],
      spot: true,
      kvm: false,
      vcpus: 4,
      jitConfig: 'jit',
    };
    await jobs.submit(spec);
    await jobs.submit({ ...spec, id: 'b', spot: false, jitConfig: 'j' });
    await jobs.submit({
      ...spec,
      id: 'c',
      regions: ['us-east-2', 'us-west-2'],
    });
    await jobs.submit({ ...spec, id: 'd', regions: ['us-west-2'], kvm: true });
    await jobs.submit({
      ...spec,
      id: 'e',
      regions: ['us-east-2', 'us-west-2'],
      kvm: true,
    });

    const [first, second, third, fourth, fifth] = requests;
    expect(first!.request.url).toBe('https://api.example/v1/workloads');
    // `maxRetries: 0` and `noCheckpoint` on spot and on demand alike
    // (anycloud 0.1.74 admits both on a VM Job).
    expect(first!.body).toEqual({
      image: 'runner@sha256:1',
      credentialName: 'bm-aws',
      cloudConfig: {
        region: 'us-east-2',
        vmType: ['m6a.xlarge', 'm7a.xlarge'],
        spot: true,
        diskSizeGb: 100,
        diskIops: 4_000,
        diskThroughputMibps: 500,
      },
      workloadType: 'job',
      maxRetries: 0,
      noCheckpoint: true,
      id: 'bmabc12-a4-00000000',
      env: {
        RUNNER_JITCONFIG: 'jit',
        BACKMESH_SUBMITTED_AT: '1793880000000',
      },
      hostDocker: true,
      // /tmp, /var/tmp and /mnt at the same paths on the VM, so a job's
      // `docker run -v` of a path there finds the file.
      dockerOptions: {
        network: 'host',
        shmSize: '8g',
        binds: ['/tmp:/tmp', '/var/tmp:/var/tmp', '/mnt:/mnt'],
      },
      session: 'bm-abc12',
      agent: 'backmesh',
    });
    // /dev/shm is half the class's memory, as on GitHub's runners.
    expect(shmSize(2)).toBe('4g');
    expect(shmSize(16)).toBe('32g');
    expect(second!.body).toMatchObject({
      cloudConfig: { spot: false },
      maxRetries: 0,
      env: { RUNNER_JITCONFIG: 'j' },
    });
    // More than one region is an unpinned Job that anycloud places within
    // them (`cloudConfig.regions`, anycloud 0.1.74).
    expect((third!.body as { cloudConfig: object }).cloudConfig).toEqual({
      regions: ['us-east-2', 'us-west-2'],
      vmType: ['m6a.xlarge', 'm7a.xlarge'],
      spot: true,
      diskSizeGb: 100,
      diskIops: 4_000,
      diskThroughputMibps: 500,
    });
    // A class's one region needn't be the install region. A KVM class asks
    // for nesting in one region or several; others don't.
    expect(first!.body).not.toHaveProperty('requireNestedVirtualization');
    expect(fourth!.body).toMatchObject({
      cloudConfig: { region: 'us-west-2' },
      hostDocker: true,
      requireNestedVirtualization: true,
    });
    // A KVM class's list launches only where its types nest.
    expect(fifth!.body).toMatchObject({
      cloudConfig: { regions: ['us-east-2', 'us-west-2'] },
      requireNestedVirtualization: true,
    });
    // The projected token is re-read for every request.
    expect(first!.request.headers.get('authorization')).toBe(
      'Bearer sa-token-1',
    );
    expect(second!.request.headers.get('authorization')).toBe(
      'Bearer sa-token-2',
    );
  });

  it('leaves GCP and Azure at their default tier, with neither gp3 field', async () => {
    const { jobs, requests } = fakeApi(() => json(202, { id: 'x' }));
    const spec: RunnerSpec = {
      id: 'bmabc12-a4-00000000',
      cloud: 'gcp',
      regions: ['us-east-2'],
      credentials: 'bm-gcp',
      vmTypes: ['n2d-standard-4'],
      spot: true,
      kvm: false,
      vcpus: 4,
      jitConfig: 'jit',
    };
    await jobs.submit(spec);
    await jobs.submit({
      ...spec,
      id: 'b',
      cloud: 'azure',
      credentials: 'bm-azure',
      vmTypes: ['Standard_D4as_v5'],
    });

    for (const { body } of requests) {
      expect(body).not.toHaveProperty('cloudConfig.diskIops');
      expect(body).not.toHaveProperty('cloudConfig.diskThroughputMibps');
    }
  });

  it("lists the session's unended Jobs and counts every other bm- session's", async () => {
    const row = (id: string, state: string, session = 'bm-abc12') => ({
      id,
      state,
      startedAt: 5,
      latestMessage: null,
      spot: false,
      session,
    });
    const { jobs, requests } = fakeApi(() =>
      json(200, [
        row('a', 'queued'),
        row('b', 'running'),
        row('c', 'completed'),
        row('d', 'some-later-state'),
        // Another org's listener on the same control plane.
        row('e', 'running', 'bm-zzz99'),
        row('f', 'failed', 'bm-zzz99'),
        // The prefix match also takes a `bm-` session label; not a runner.
        row('g', 'running', 'other'),
      ]),
    );

    // A state this version doesn't know counts as actual.
    const { mine, others } = await jobs.list();
    expect(mine.map((job) => job.id)).toEqual(['a', 'b', 'd']);
    expect(others).toBe(1);
    expect(mine[0]).toEqual({
      id: 'a',
      state: 'queued',
      submittedAt: 5,
      latestMessage: null,
      spot: false,
    });
    const query = new URL(requests[0]!.request.url).searchParams;
    expect(Object.fromEntries(query)).toEqual({
      session: 'bm-',
      limit: '1000',
      stateClass: 'terminatable',
    });
  });

  it("reads a Job's end and what its last event says, and none for a Job that doesn't exist", async () => {
    const event = (
      state: string,
      metadata: Record<string, unknown> | null,
    ) => ({
      id: 1,
      workloadId: 'x',
      createdAt: 1,
      state,
      metadata,
    });
    const workload = (state: string, endReason: string | null) => ({
      state,
      endReason,
      cloudProvider: 'AWS',
      region: 'us-east-2',
      vmType: 'm6a.xlarge',
      spot: true,
    });
    const statuses: Record<string, unknown> = {
      // anycloud's batch outcome for a nonzero exit, after earlier events.
      errored: {
        workload: workload('errored', 'exited'),
        events: [
          event('running', { executionId: 'e' }),
          event('errored', { executionId: 'e', message: 'Exited with code 1' }),
        ],
      },
      // An exit 0 completes with no message.
      completed: {
        workload: workload('completed', 'exited'),
        events: [event('completed', { executionId: 'e' })],
      },
      retried: {
        workload: workload('failed', 'retries-exhausted'),
        events: [
          event('retrying', {
            diagnosis: 'quota-exhausted-region',
            targetRegion: 'us-east-2',
          }),
          event('failed', { reason: 'retry attempts exhausted' }),
        ],
      },
      reclaimed: {
        workload: workload('failed', 'reclaimed'),
        events: [event('failed', null)],
      },
      // At `maxRetries: 0`, anycloud fails a Job whose VM went as reclaimed
      // or lost (`vm-job-max-retries.ts`).
      capped: {
        workload: workload('failed', 'reclaimed'),
        events: [
          event('running', null),
          event('recovering', {
            reason: 'preemption: attempting in-place VM restart',
          }),
          event('failed', { reason: 'max retries (0) reached' }),
        ],
      },
      cappedEarly: {
        workload: workload('failed', 'reclaimed'),
        events: [
          event('provisioning', null),
          event('recovering', { reason: 'preemption during provisioning' }),
          event('failed', { reason: 'max retries (0) reached' }),
        ],
      },
      cappedLost: {
        workload: workload('failed', 'lost'),
        events: [
          event('running', null),
          event('recovering', { reason: 'SSH unreachable for 5 min' }),
          event('failed', { reason: 'max retries (0) reached' }),
        ],
      },
      recovering: {
        workload: workload('recovering', null),
        events: [event('recovering', { reason: 'preemption during running' })],
      },
      // Not ended, and a VM type list is candidates, not the VM.
      placing: {
        workload: { ...workload('queued', null), vmType: ['a', 'b'] },
        events: [],
      },
      // An unpinned Job's region is its VM's.
      unpinned: {
        workload: { ...workload('completed', 'exited'), region: null },
        vms: [{ ip: '10.0.0.1', endedAt: 2, region: 'us-west-2' }],
        events: [event('completed', null)],
      },
    };
    const { jobs } = fakeApi((request) => {
      const status = statuses[new URL(request.url).pathname.split('/').at(-1)!];
      return status
        ? json(200, status)
        : json(404, { code: 'NOT_FOUND', message: 'no such workload' });
    });

    const vm = {
      cloud: 'aws',
      region: 'us-east-2',
      vmType: 'm6a.xlarge',
      spot: true,
      refusals: [],
    };
    expect(await jobs.end('errored')).toEqual({
      ...vm,
      reason: 'exited',
      detail: 'Exited with code 1',
    });
    expect(await jobs.end('completed')).toEqual({
      ...vm,
      reason: 'exited',
      detail: 'Exited with code 0',
    });
    expect(await jobs.end('retried')).toEqual({
      ...vm,
      reason: 'retries-exhausted',
      detail: 'retry attempts exhausted',
      refusals: [{ region: 'us-east-2', diagnosis: 'quota-exhausted-region' }],
    });
    expect(await jobs.end('reclaimed')).toEqual({
      ...vm,
      reason: 'reclaimed',
      detail: null,
    });
    expect(await jobs.end('capped')).toMatchObject({
      reason: 'reclaimed',
      detail: 'max retries (0) reached',
    });
    expect(await jobs.end('cappedEarly')).toMatchObject({
      reason: 'reclaimed',
    });
    expect(await jobs.end('cappedLost')).toMatchObject({ reason: 'lost' });
    expect(await jobs.end('recovering')).toMatchObject({ reason: null });
    expect(await jobs.end('placing')).toEqual({
      reason: null,
      detail: null,
      cloud: 'aws',
      region: 'us-east-2',
      vmType: null,
      spot: true,
      refusals: [],
    });
    expect(await jobs.end('unpinned')).toMatchObject({ region: 'us-west-2' });
    expect(await jobs.end('gone')).toBeUndefined();
  });

  it("reads a runner Job's submit and its start on its VM", async () => {
    const event = (id: number, state: string, createdAt: number) => ({
      id,
      workloadId: 'x',
      createdAt,
      state,
      metadata: null as Record<string, unknown> | null,
    });
    // A failed Provisioning step's `retrying` event names its target
    // (`vm-host-startup.ts:254-276`); one after `running` isn't a launch.
    const refused = (
      id: number,
      targetRegion: string,
      diagnosis: string,
      launchFailover?: true,
    ) => ({
      ...event(id, 'retrying', 1793880003000 + id),
      metadata: {
        diagnosis,
        targetRegion,
        targetVmType: 'm6a.xlarge',
        ...(launchFailover && { launchFailover }),
      },
    });
    // The claim's untried targets: anycloud retries a failover at once
    // while one is left, and backs off once none is.
    const claim = (id: number, untriedTargets: number) => ({
      ...event(id, 'provisioning', 1793880003000 + id),
      metadata: { untriedTargets },
    });
    const statuses: Record<string, unknown> = {
      started: {
        workload: { startedAt: 1793880002500, region: null },
        vms: [{ ip: '10.0.0.1', endedAt: null, region: 'us-west-2' }],
        events: [
          claim(11, 2),
          refused(12, 'us-east-2', 'capacity-exhausted', true),
          { ...event(13, 'retrying', 1793880004000), metadata: { error: 'x' } },
          claim(131, 0),
          refused(14, 'us-east-1', 'quota-exhausted-region', true),
          {
            ...event(140, 'retrying', 1793880004500),
            metadata: { error: 'y' },
          },
          // anycloud re-queues the Job once the last counted refusal's
          // backoff ends, before claiming it again.
          event(141, 'queued', 1793880005000),
          refused(15, 'us-east-1', 'temporary-provider-failure'),
          // A replayed step's events: the last before `running` count.
          event(150, 'downloading', 1793880040000),
          {
            ...event(151, 'downloading', 1793880041000),
            metadata: {
              imagePull: { method: 'docker', reason: 'prepulled' },
            },
          },
          event(16, 'starting', 1793880060000),
          event(17, 'running', 1793880090400),
          event(170, 'starting', 1793880095000),
          refused(18, 'us-west-2', 'capacity-exhausted'),
        ],
      },
      queued: { workload: { startedAt: 1793880002500 }, events: [] },
      // Pulled over SSH: the user data didn't pull it first.
      pulled: {
        workload: { startedAt: 1793880002500 },
        events: [
          {
            ...event(31, 'downloading', 1793880040000),
            metadata: { imagePull: { method: 'docker', elapsedMs: 9000 } },
          },
        ],
      },
      // Refused, and not re-queued yet.
      retrying: {
        workload: { startedAt: 1793880002500, region: null },
        events: [refused(21, 'us-east4', 'quota-exhausted-account')],
      },
    };
    const { jobs, requests } = fakeApi((request) => {
      const status = statuses[new URL(request.url).pathname.split('/').at(-1)!];
      return status
        ? json(200, status)
        : json(404, { code: 'NOT_FOUND', message: 'no such workload' });
    });

    expect(await jobs.timeline('started')).toEqual({
      submittedAt: 1793880002500,
      dockerReadyAt: 1793880041000,
      pulledAt: 1793880060000,
      prepulled: true,
      runningAt: 1793880090400,
      region: 'us-west-2',
      refusals: [
        { region: 'us-east-2', diagnosis: 'capacity-exhausted' },
        { region: 'us-east-1', diagnosis: 'quota-exhausted-region' },
      ],
      // us-east-2's moved on to an untried target at once.
      backedOff: ['us-east-1'],
      // anycloud's re-queue after the last counted refusal's backoff: the
      // first `queued` event after it, not an uncounted retry around it.
      refusedUntil: 1793880005000,
    });
    // Every event: the first `running`, and a recovery, can be early ones.
    expect(new URL(requests[0]!.request.url).search).toBe('?eventsLimit=all');
    expect(await jobs.timeline('queued')).toEqual({
      submittedAt: 1793880002500,
      dockerReadyAt: null,
      pulledAt: null,
      prepulled: null,
      runningAt: null,
      region: null,
      refusals: [],
      backedOff: [],
      refusedUntil: null,
    });
    expect(await jobs.timeline('pulled')).toMatchObject({
      dockerReadyAt: 1793880040000,
      pulledAt: null,
      prepulled: false,
    });
    // A refusal that isn't a failover always backs off.
    expect(await jobs.timeline('retrying')).toMatchObject({
      backedOff: ['us-east4'],
      refusedUntil: 1793880003021,
    });
    expect(await jobs.timeline('gone')).toBeUndefined();
  });

  it("reads a started runner's VM type and its boot, submit to running", async () => {
    const statuses: Record<string, unknown> = {
      started: {
        workload: {
          startedAt: 1793880002500,
          vmType: 'm6a.xlarge',
          region: 'us-east-2',
        },
        // In time order: its first `running`, then a later one after a
        // restart in place.
        events: [
          { id: 1, state: 'starting', createdAt: 1793880040000 },
          { id: 2, state: 'running', createdAt: 1793880044500 },
          { id: 3, state: 'recovering', createdAt: 1793880100000 },
          { id: 4, state: 'running', createdAt: 1793880160000 },
        ],
      },
      // Before placement, the type is the candidate list.
      queued: {
        workload: { startedAt: 1793880002500, vmType: ['m6a.xlarge'] },
        events: [],
      },
    };
    const { api } = fakeApi((request) => {
      const status = statuses[new URL(request.url).pathname.split('/').at(-1)!];
      return status
        ? json(200, status)
        : json(404, { code: 'NOT_FOUND', message: 'no such workload' });
    });
    const signal = new AbortController().signal;

    expect(await runnerVm(api, 'started', signal)).toEqual({
      vmType: 'm6a.xlarge',
      region: 'us-east-2',
      bootMs: 42_000,
      refusals: 0,
    });
    expect(await runnerVm(api, 'queued', signal)).toEqual({
      vmType: null,
      region: null,
      bootMs: null,
      refusals: 0,
    });
    expect(await runnerVm(api, 'gone', signal)).toBeUndefined();
  });
});
