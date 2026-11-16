// Telemetry: one event per job started, sent in batches to the
// Worker. A JobStarted only queues an event, and every call is timed
// out and caught, so a Worker that's down changes nothing but what `status`
// shows.
import { createHash } from 'node:crypto';

import { z } from 'zod';

import { sleepFor, type Fetch, type Log, type Sleep } from '../github/retry.js';
import type { JobMessage } from '../github/types.js';
import type { Route } from './routes.js';
import type { RunnerVm } from './runner-jobs.js';

export const apiUrl = (env = process.env) =>
  env.BACKMESH_API_URL ?? 'https://api.backmesh.com';
const BATCH = 100; // events per request: the Worker's limit
// Unsent events are dropped oldest first past this, and on a restart.
export const MAX_QUEUE = 50_000;
const SEND_MS = 60_000;
const MAX_BACKOFF_MS = 32 * 60_000;

// The runner's facts at JobStarted, from its route and whether its VM is
// spot, then its VM Job's VM type, region, boot and refused launches; never
// the job's names. A route with more than one region doesn't say which.
function runnerFacts(route: Route, job: JobMessage, spot: boolean | null) {
  // GitHub's own clock: queued to assigned, null without both times.
  const assigned = job.runnerAssignTime ?? job.scaleSetAssignTime;
  return {
    cloud: route.cloud,
    region: route.regions.length > 1 ? null : route.regions[0]!,
    vm_type: null as string | null,
    capacity: spot === null ? null : spot ? 'spot' : 'on-demand',
    label: route.label,
    queued_ms:
      job.queueTime === null || assigned === null
        ? null
        : Math.max(0, assigned - job.queueTime),
    boot_ms: null as number | null,
    launch_refusals: null as number | null,
    features: [] as 'retry-on-demand'[], // the Worker's known names
  };
}

export const telemetryStatusSchema = z.object({
  // The last send's error until one succeeds, and its HTTP status: a 4xx is
  // the Worker refusing, not an outage.
  lastError: z.string().nullable(),
  lastStatus: z.number().int().nullable(),
  pending: z.number().int(),
});
export type TelemetryStatus = z.infer<typeof telemetryStatusSchema>;

export interface TelemetryDeps {
  url: string;
  // BACKMESH_INSTALL_KEY, minted by install's or upgrade's device sign-in;
  // the Worker knows the org and install from it.
  key: string;
  version: string;
  // The org's numeric ID, which the Worker keys orgs by.
  orgId: (signal: AbortSignal) => Promise<number>;
  fetch: Fetch;
  // The started runner's VM Job (`runnerVm`); without it, the event's VM
  // type and boot stay null.
  runnerVm?: (
    runner: string,
    signal: AbortSignal,
  ) => Promise<RunnerVm | undefined>;
  log: Log;
  now?: () => number;
  timeoutMs?: number;
}

// The Worker's HTTP status; not GitHub's, from the org lookup.
const statusOf = (error: unknown) =>
  (error as { workerStatus?: number }).workerStatus ?? null;

export class Telemetry {
  private queue: {
    job: string;
    at: number;
    facts: ReturnType<typeof runnerFacts>;
    // Settles once the runner's VM Job read has filled in, or failed.
    vm?: Promise<void>;
  }[] = [];
  private lastError: string | null = null;
  private lastStatus: number | null = null;
  private sending: Promise<void> | undefined;
  private failures = 0;
  private nextSend = 0;
  private org: number | undefined;

  constructor(private readonly deps: TelemetryDeps) {}

  private now = () => (this.deps.now ?? Date.now)();

  // Synchronous, for the scaler's JobStarted.
  jobStarted(route: Route, job: JobMessage, spot: boolean | null): void {
    const at = this.now();
    const facts = runnerFacts(route, job, spot);
    const vm = this.deps.runnerVm?.(job.runnerName, this.timeout()).then(
      (read) => {
        facts.vm_type = read?.vmType ?? null;
        facts.region = read?.region ?? facts.region;
        facts.boot_ms = read?.bootMs ?? null;
        facts.launch_refusals = read?.refusals ?? null;
      },
      () => undefined,
    );
    this.queue.push({ job: job.jobId, at, facts, vm });
    if (this.queue.length > MAX_QUEUE) {
      const dropped = this.queue.splice(0, this.queue.length - MAX_QUEUE);
      this.deps.log({
        msg: 'telemetry events dropped',
        dropped: dropped.length,
      });
    }
    if (this.queue.length >= BATCH && this.now() >= this.nextSend) {
      void this.send();
    }
  }

  private async post(path: string, body: object): Promise<void> {
    const res = await this.deps.fetch(`${this.deps.url}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.deps.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: this.timeout(),
    });
    if (!res.ok) {
      const message = `${path} answered ${res.status}`;
      throw Object.assign(new Error(message), { workerStatus: res.status });
    }
  }

  private timeout = () => AbortSignal.timeout(this.deps.timeoutMs ?? 10_000);

  private async orgId() {
    return (this.org ??= await this.deps.orgId(this.timeout()));
  }

  private failed(error: unknown) {
    this.lastError = error instanceof Error ? error.message : String(error);
    this.lastStatus = statusOf(error);
  }

  // Sends and logs requests of up to 100. A refused (4xx) batch is dropped,
  // so it can't block the queue; other failures back off 2 to 32 minutes.
  send(): Promise<void> {
    this.sending ??= this.flush().finally(() => (this.sending = undefined));
    return this.sending;
  }

  private async flush() {
    try {
      const org = await this.orgId();
      while (this.queue.length) {
        const batch = this.queue.slice(0, BATCH);
        await Promise.all(batch.map((entry) => entry.vm));
        const events = batch.map(({ job, at, facts }) => ({
          id: createHash('sha256').update(`${org}:${job}`).digest('hex'),
          version: this.deps.version,
          started_at: new Date(at).toISOString(),
          ...facts,
        }));
        const refused = await this.post('/v1/events', { events }).then(
          () => null,
          (error: unknown) => {
            const status = statusOf(error) ?? 500;
            if (status >= 500 || status === 429) throw error;
            this.failed(error);
            return String(error);
          },
        );
        if (!refused) this.lastError = this.lastStatus = null;
        const msg = `telemetry events ${refused ? 'refused' : 'sent'}`;
        this.deps.log({ msg, events, ...(refused && { error: refused }) });
        const sent = new Set(batch);
        this.queue = this.queue.filter((e) => !sent.has(e));
        // A backlog drains at the Worker's rate, not the back-off's.
        this.failures = 0;
      }
    } catch (error) {
      this.failed(error);
      const wait = Math.min(SEND_MS * 2 ** ++this.failures, MAX_BACKOFF_MS);
      this.nextSend = this.now() + wait;
      const pending = this.queue.length;
      const msg = 'telemetry events not sent; retrying';
      this.deps.log({ msg, pending, retryInMs: wait, error: String(error) });
    }
  }

  // Sends every minute, or after a back-off.
  async run(signal: AbortSignal, sleep: Sleep = sleepFor): Promise<void> {
    while (!signal.aborted) {
      if (this.queue.length && this.now() >= this.nextSend) await this.send();
      await sleep(SEND_MS, signal).catch(() => {});
    }
  }

  status(): TelemetryStatus {
    return {
      lastError: this.lastError,
      lastStatus: this.lastStatus,
      pending: this.queue.length,
    };
  }
}
