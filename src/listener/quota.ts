// The runner regions' vCPU quotas for the scaler: runners
// past a region's quota wait in anycloud's launch retries, 2.5 then 5 then 10
// minutes apart, while their jobs could wait at GitHub and start once room
// frees. Read through the control plane's quota status, the same AWS and
// Azure limits install reads (`runners/quota.ts`); GCP's aren't read.
import type { Log } from '../github/retry.js';
import type { Cloud } from '../runners/classes.js';
import type { QuotaLimits } from '../runners/quota.js';

// Each region's limits are read again this long after the last read; the
// control plane caches its provider reads for 5 minutes too.
const REFRESH_MS = 10 * 60_000;

export type ReadQuota = (
  cloud: Cloud,
  credentials: string,
  region: string,
) => Promise<QuotaLimits>;

// The last limits read per cloud and region, refreshed in the background so
// a reconcile never waits on a read. Until a region's first read answers,
// its limits are unknown and nothing is held back; a failed read keeps the
// last ones.
export class Quotas {
  private readonly known = new Map<string, QuotaLimits>();
  private readonly tried = new Map<string, number>();
  private readonly pending = new Set<Promise<unknown>>();

  constructor(
    private readonly read: ReadQuota,
    private readonly log: Log,
  ) {}

  // The regions' summed vCPU limit for spot or on-demand VMs, or undefined
  // while any of them is unknown, or on GCP.
  limit(
    cloud: Cloud,
    credentials: string,
    regions: readonly string[],
    spot: boolean,
    now: number,
  ): number | undefined {
    if (cloud === 'gcp') return undefined;
    const each = regions.map((region) =>
      this.regionLimit(cloud, credentials, region, spot, now),
    );
    return each.every((v) => v !== undefined)
      ? each.reduce((sum: number, v) => sum + v!, 0)
      : undefined;
  }

  // One region's limit, or undefined while unknown, or on GCP. Every call
  // re-reads a region whose last read is REFRESH_MS old, so a raised quota
  // takes effect within that.
  regionLimit(
    cloud: Cloud,
    credentials: string,
    region: string,
    spot: boolean,
    now: number,
  ): number | undefined {
    if (cloud === 'gcp') return undefined;
    const k = `${cloud} ${region}`;
    if (now - (this.tried.get(k) ?? -Infinity) >= REFRESH_MS) {
      this.refresh(k, cloud, credentials, region, now);
    }
    const limits = this.known.get(k);
    const vcpus = spot ? limits?.spot : limits?.onDemand;
    return vcpus !== undefined && Number.isFinite(vcpus) ? vcpus : undefined;
  }

  private refresh(
    k: string,
    cloud: Cloud,
    credentials: string,
    region: string,
    now: number,
  ) {
    // A failed read keeps the last limits, and is tried again REFRESH_MS on.
    this.tried.set(k, now);
    const read = this.read(cloud, credentials, region)
      // A limit the read didn't return keeps its last value.
      .then((limits) =>
        this.known.set(k, {
          ...this.known.get(k),
          ...Object.fromEntries(
            Object.entries(limits).filter(([, v]) => v !== undefined),
          ),
        }),
      )
      .catch((error: unknown) =>
        this.log({
          msg: 'quota read failed; keeping its last limits, if any',
          region: k,
          error: String(error),
        }),
      )
      .finally(() => this.pending.delete(read));
    this.pending.add(read);
  }

  // Resolves once the reads under way answer, or after `ms`.
  async settled(ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...this.pending]),
      new Promise((resolve) => (timer = setTimeout(resolve, ms))),
    ]);
    clearTimeout(timer);
  }
}
