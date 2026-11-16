import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { JobMessage } from '../../../src/github/types.js';
import { MAX_QUEUE, Telemetry } from '../../../src/listener/telemetry.js';
import type { ScalerDeps } from '../../../src/listener/scaler.js';
import { eventSchema } from '../../../worker/src/telemetry.js';
import { assigned, ROUTE, setup } from './fakes.js';

const KEY = `bmk_${'a'.repeat(32)}${'b'.repeat(32)}`;
const ORG = 9919;

// The Worker: records event batches. `down` refuses connections,
// `hang` answers only the request's abort, `slow` answers 500 after 20 ms,
// and `status` answers events with that code.
function worker() {
  const batches: { id: string; org: number; started_at: string }[][] = [];
  const state = { down: false, hang: false, slow: false, status: 200 };
  const auth: (string | null)[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    if (state.hang) {
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener('abort', () =>
          reject(init.signal?.reason),
        ),
      );
    }
    if (state.down) throw new TypeError('fetch failed');
    auth.push(new Headers(init?.headers).get('Authorization'));
    if (state.slow) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response('', { status: 500 });
    }
    expect(new URL(String(input)).pathname).toBe('/v1/events');
    if (state.status !== 200) return new Response('', { status: state.status });
    batches.push(JSON.parse(String(init?.body)).events);
    return Response.json({ accepted: 1 });
  };
  return { batches, state, fetch, auth };
}

function telemetryWith(
  w = worker(),
  clock = { now: 0 },
  orgId = async () => ORG,
  runnerVm?: ConstructorParameters<typeof Telemetry>[0]['runnerVm'],
) {
  const logs: ({ msg: string } & Record<string, unknown>)[] = [];
  const telemetry = new Telemetry({
    url: 'https://api.backmesh.test',
    key: KEY,
    version: '0.1.7',
    orgId,
    fetch: w.fetch,
    runnerVm,
    timeoutMs: 50,
    log: (entry) => void logs.push(entry),
    now: () => clock.now,
  });
  return { telemetry, logs, clock, w };
}

const started = (jobId: string, runnerName: string): JobMessage => ({
  messageType: 'JobStarted',
  runnerRequestId: 0,
  repositoryName: 'app',
  ownerName: 'acme',
  jobId,
  jobDisplayName: 'test',
  jobWorkflowRef: '',
  workflowRunId: 7,
  eventName: 'push',
  requestLabels: ['backmesh-4'],
  queueTime: null,
  scaleSetAssignTime: null,
  runnerAssignTime: null,
  finishTime: null,
  runnerId: 0,
  runnerName,
  result: '',
});

// Three jobs through the count loop, with the telemetry hook given.
async function runJobs(jobStarted?: ScalerDeps['jobStarted']) {
  const { anycloud, github, scaler, sets } = setup(
    undefined,
    undefined,
    undefined,
    jobStarted,
  );
  sets[0]!.statistics = assigned(3);
  await scaler.reconcile();
  for (const [i, spec] of anycloud.submitted.entries()) {
    scaler.observe(sets[0]!, started(`job-${i}`, spec.id));
  }
  await scaler.reconcile();
  return { submitted: anycloud.submitted.length, calls: github.calls.length };
}

const start = (
  telemetry: Telemetry,
  id: string,
  queueTime: number | null = null,
) =>
  telemetry.jobStarted(
    ROUTE,
    {
      ...started(id, 'runner'),
      queueTime,
      runnerAssignTime: queueTime && queueTime + 3_000,
    },
    true,
  );

describe('Telemetry', () => {
  it('queues one event per job started and sends it in the documented shape, logged', async () => {
    const { telemetry, logs, clock, w } = telemetryWith();
    const { submitted } = await runJobs((route, job, spot) =>
      telemetry.jobStarted(route, job, spot),
    );
    expect(submitted).toBe(3);
    expect(telemetry.status().pending).toBe(3);

    clock.now = Date.UTC(2026, 10, 6);
    start(telemetry, 'job-9', clock.now - 4_000);
    await telemetry.send();

    expect(w.batches).toHaveLength(1);
    expect(w.batches[0]).toHaveLength(4);
    expect(w.batches[0]![3]).toEqual({
      id: createHash('sha256').update(`${ORG}:job-9`).digest('hex'),
      version: '0.1.7',
      started_at: '2026-11-06T00:00:00.000Z',
      cloud: 'aws',
      region: 'us-east-2',
      vm_type: null,
      capacity: 'spot',
      label: 'backmesh-4',
      queued_ms: 3_000,
      boot_ms: null,
      launch_refusals: null,
      features: [],
    });
    expect(w.auth).toEqual([`Bearer ${KEY}`]);
    // The Worker's strict schema takes every event as sent.
    for (const event of w.batches[0]!) eventSchema.parse(event);
    expect(logs).toContainEqual({
      msg: 'telemetry events sent',
      events: w.batches[0],
    });
    expect(telemetry.status().pending).toBe(0);
  });

  it("names a job's cloud, region and capacity from its route and VM", async () => {
    const { telemetry, w } = telemetryWith();
    for (const [cloud, region, spot] of [
      ['aws', 'us-east-2', false],
      ['gcp', 'us-central1', true],
      ['azure', 'westus2', null],
    ] as const) {
      const route = { ...ROUTE, cloud, region, regions: [region] };
      telemetry.jobStarted(route, started(cloud, 'runner'), spot);
    }
    await telemetry.send();
    type Facts = { cloud: string; region: string; capacity: string | null };
    const events = w.batches[0] as unknown as Facts[];
    expect(events.map((e) => [e.cloud, e.region, e.capacity])).toEqual([
      ['aws', 'us-east-2', 'on-demand'],
      ['gcp', 'us-central1', 'spot'],
      ['azure', 'westus2', null],
    ]);
  });

  it("fills in each runner's VM type and boot from its VM Job before sending", async () => {
    const reads: string[] = [];
    let answer: () => void = () => undefined;
    const { telemetry, w } = telemetryWith(
      undefined,
      undefined,
      undefined,
      (runner, signal) => {
        reads.push(runner);
        expect(signal).toBeInstanceOf(AbortSignal);
        if (runner === 'gone') return Promise.resolve(undefined);
        if (runner === 'down') return Promise.reject(new Error('API down'));
        return new Promise((resolve) => {
          answer = () =>
            resolve({
              vmType: 'm6a.xlarge',
              region: 'us-west-2',
              bootMs: 41_000,
              refusals: 2,
            });
        });
      },
    );
    for (const runner of ['slow', 'gone', 'down']) {
      telemetry.jobStarted(ROUTE, started(`job-${runner}`, runner), true);
    }
    const sent = telemetry.send();
    // The batch waits for the slow read.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(w.batches).toEqual([]);
    answer();
    await sent;

    expect(reads).toEqual(['slow', 'gone', 'down']);
    type Facts = Record<
      'vm_type' | 'region' | 'boot_ms' | 'launch_refusals',
      unknown
    >;
    const events = w.batches[0] as unknown as Facts[];
    // The launched region; a missing Job or a failed read leaves the route's
    // one region and nulls.
    expect(
      events.map((e) => [e.vm_type, e.region, e.boot_ms, e.launch_refusals]),
    ).toEqual([
      ['m6a.xlarge', 'us-west-2', 41_000, 2],
      [null, 'us-east-2', null, null],
      [null, 'us-east-2', null, null],
    ]);
    for (const event of w.batches[0]!) eventSchema.parse(event);
  });

  it("leaves a route's region out until its VM's read names one", async () => {
    const { telemetry, w } = telemetryWith(
      undefined,
      undefined,
      undefined,
      async () => undefined,
    );
    const route = { ...ROUTE, regions: ['us-east-2', 'us-west-2'] };
    telemetry.jobStarted(route, started('job-1', 'gone'), true);
    await telemetry.send();
    expect(w.batches[0]![0]).toMatchObject({ region: null });
  });

  it('sends with a null VM once its read times out, holding no batch back', async () => {
    // A read that answers only its signal's abort, as `runnerVm`'s fetch does.
    const { telemetry, w } = telemetryWith(
      undefined,
      undefined,
      undefined,
      (_, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason)),
        ),
    );
    telemetry.jobStarted(ROUTE, started('job-1', 'hung'), true);
    await telemetry.send();
    type Facts = { vm_type: string | null; boot_ms: number | null };
    const events = w.batches[0] as unknown as Facts[];
    expect(events.map((e) => [e.vm_type, e.boot_ms])).toEqual([[null, null]]);
  });

  it('sends at 100 events without waiting for the minute', async () => {
    const { telemetry, w } = telemetryWith();
    for (let i = 0; i < 100; i++) start(telemetry, `job-${i}`);
    await telemetry.send();

    expect(w.batches.map((b) => b.length)).toEqual([100]);
  });

  it('keeps events through an outage, backs off, and sends them once it ends', async () => {
    const { telemetry, clock, w } = telemetryWith();
    w.state.down = true;
    start(telemetry, 'job-1');
    await telemetry.send();
    expect(telemetry.status()).toMatchObject({
      pending: 1,
      lastError: 'fetch failed',
    });

    w.state.down = false;
    for (let i = 0; i < 100; i++) start(telemetry, `more-${i}`);
    // The first retry waits two minutes, so the 100th event doesn't send.
    await Promise.resolve();
    expect(w.batches).toEqual([]);

    clock.now += 120_000;
    await telemetry.send();
    expect(w.batches.flat()).toHaveLength(101);
  });

  it('drops the oldest events past the queue bound, and logs it', async () => {
    const { telemetry, logs, w } = telemetryWith();
    w.state.hang = true;
    for (let i = 0; i <= MAX_QUEUE; i++) start(telemetry, `job-${i}`);

    expect(telemetry.status().pending).toBe(MAX_QUEUE);
    expect(logs).toContainEqual({
      msg: 'telemetry events dropped',
      dropped: 1,
    });
  });

  it('times out a Worker that never answers', async () => {
    const { telemetry, w } = telemetryWith();
    w.state.hang = true;
    start(telemetry, 'job-1');
    await telemetry.send();

    expect(telemetry.status().lastError).toMatch(/timeout/);
  });

  it('drops and logs a batch the Worker refuses, and keeps sending', async () => {
    const { telemetry, logs, w } = telemetryWith();
    w.state.status = 400;
    start(telemetry, 'job-1');
    await telemetry.send();

    expect(telemetry.status()).toMatchObject({ pending: 0, lastStatus: 400 });
    expect(logs).toContainEqual(
      expect.objectContaining({ msg: 'telemetry events refused' }),
    );
  });

  it('keeps a rate-limited (429) batch and backs off', async () => {
    const { telemetry, logs, w } = telemetryWith();
    w.state.status = 429;
    start(telemetry, 'job-1');
    await telemetry.send();
    expect(telemetry.status()).toMatchObject({ pending: 1, lastStatus: 429 });
    expect(logs).toContainEqual(
      expect.objectContaining({ retryInMs: 120_000, pending: 1 }),
    );

    w.state.status = 200;
    await telemetry.send();
    expect(w.batches.flat()).toHaveLength(1);

    // A sent batch resets the back-off.
    w.state.status = 429;
    start(telemetry, 'job-2');
    await telemetry.send();
    expect(logs.at(-1)).toMatchObject({ retryInMs: 120_000 });
  });

  it('retries the org ID lookup after it fails', async () => {
    let calls = 0;
    const orgId = async () => {
      // GitHub's status isn't the Worker's: no sign-in note.
      if (calls++ === 0) {
        throw Object.assign(new Error('GitHub answered 401'), { status: 401 });
      }
      return ORG;
    };
    const { telemetry, clock, w } = telemetryWith(undefined, undefined, orgId);
    start(telemetry, 'job-1');
    await telemetry.send();
    expect(telemetry.status()).toMatchObject({
      pending: 1,
      lastError: 'GitHub answered 401',
      lastStatus: null,
    });

    clock.now += 120_000;
    await telemetry.send();
    expect(w.batches.flat()).toHaveLength(1);
  });

  it('sends each minute, and clears the error once a send succeeds', async () => {
    const { telemetry, clock, w } = telemetryWith();
    w.state.down = true;
    start(telemetry, 'job-1');
    await telemetry.send();
    expect(telemetry.status().lastError).toBe('fetch failed');
    const stop = new AbortController();
    const sleeps: number[] = [];
    await telemetry.run(stop.signal, async (ms) => {
      sleeps.push(ms);
      clock.now += ms;
      w.state.down = false;
      if (sleeps.length === 3) stop.abort();
    });

    expect(sleeps).toEqual([60_000, 60_000, 60_000]);
    expect(telemetry.status()).toEqual({
      lastError: null,
      lastStatus: null,
      pending: 0,
    });
    expect(w.batches.flat()).toHaveLength(1);
  });

  it.each(['refuses connections', 'never answers', 'answers 500 slowly'])(
    'runs jobs exactly as without telemetry when the Worker %s',
    async (failure) => {
      const { telemetry, w } = telemetryWith();
      w.state.down = failure === 'refuses connections';
      w.state.hang = failure === 'never answers';
      w.state.slow = failure === 'answers 500 slowly';
      for (let i = 0; i < 150; i++) start(telemetry, `before-${i}`);

      expect(
        await runJobs((route, job, spot) =>
          telemetry.jobStarted(route, job, spot),
        ),
      ).toEqual(await runJobs());
      expect(telemetry.status().pending).toBe(153);
    },
  );
});
