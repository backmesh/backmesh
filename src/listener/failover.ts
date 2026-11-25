// The boot deadline: a runner Job with no VM
// BOOT_DEADLINE_MS after its submit gets a replacement in another of its
// runner regions, of its own kind (owner, 2026-11-09: never on demand for a
// spot label), and a region that keeps missing the deadline is avoided for a
// while, like the spot breaker. In memory only.
//
// Only a Job whose launch the cloud refused counts: one waiting its turn in
// the control plane's own provisioning queue, or already booting in another
// region, isn't helped by a replacement, so it's never replaced, however
// long it waits.
// 75 s (owner, 2026-11-13; 180 s before): a runner's VM is running 46–67 s
// after its submit (F, 165 boots on 11-07), so 75 s is past every normal
// start. A refused Job then waits anycloud's provisioning retry, a random
// 15 s to 2.5 minutes at first, then up to 5 and 10 (`retry-backoff.ts`),
// and a launch and a boot after it: about 2 minutes more on average, which
// a replacement in another region beats. AM's burst waited 13–28 minutes.
export const BOOT_DEADLINE_MS = 75_000;
// Three Jobs past the deadline in a region, for one kind of VM (spot or on
// demand, KVM or not), within 15 minutes avoid it for that kind for 30. Only
// a region whose refusal sent the Job into anycloud's backoff counts
// (`Scaler.replace`): at 75 s, one anycloud moved on from at once to an
// untried VM type or zone often launches before the old 180 s.
const SLOW_EVENTS = 3;
const SLOW_WINDOW_MS = 15 * 60_000;
const AVOID_MS = 30 * 60_000;
// Status shows the last 15 minutes' replacements.
const SHOWN_MS = 15 * 60_000;

// A replacement: the slow Job's regions (where its launches were refused,
// or its one region), and the region its replacement went to, or null when
// there was nowhere to put one; `onDemand` when a spot Job's replacement
// fell back on demand (`fallback`).
export interface Replacement {
  label: string;
  from: string[];
  to: string | null;
  at: number;
  onDemand?: true;
}

// Which runners a region's misses count for: such as "aws us-east-2 spot".
export interface Kind {
  cloud: string;
  spot: boolean;
  kvm: boolean;
  gpu?: string;
}
const key = ({ cloud, spot, kvm, gpu }: Kind, region: string) =>
  `${cloud} ${region} ${kvm ? 'KVM ' : ''}${gpu ? 'GPU ' : ''}${spot ? 'spot' : 'on demand'}`;

export class Failover {
  private readonly slow = new Map<string, number[]>();
  private readonly avoided = new Map<string, number>();
  private replaced: Replacement[] = [];

  avoiding(kind: Kind, region: string, now: number): boolean {
    return this.until(kind, region) > now;
  }

  // When the region's avoidance for the kind ends; 0 if never avoided.
  until(kind: Kind, region: string): number {
    return this.avoided.get(key(kind, region)) ?? 0;
  }

  // A Job of the kind missed the deadline in these regions.
  missed(kind: Kind, regions: readonly string[], now: number): void {
    for (const region of regions) {
      const k = key(kind, region);
      const recent = [...(this.slow.get(k) ?? []), now].filter(
        (at) => now - at < SLOW_WINDOW_MS,
      );
      this.slow.set(k, recent);
      if (recent.length >= SLOW_EVENTS) {
        this.avoided.set(k, now + AVOID_MS);
        this.slow.delete(k);
      }
    }
  }

  replacedOne(replacement: Replacement): void {
    this.replaced = this.replaced.filter(
      (r) => replacement.at - r.at < SHOWN_MS,
    );
    this.replaced.push(replacement);
  }

  // A scale set's replacements in the last SHOWN_MS, and the slow runners
  // with nowhere to go, for `status`.
  status(label: string, now: number) {
    const mine = this.replaced.filter(
      (r) => r.label === label && now - r.at < SHOWN_MS,
    );
    if (!mine.length) return undefined;
    const done = mine.filter((r) => r.to !== null);
    const onDemand = done.filter((r) => r.onDemand).length;
    return {
      replaced: done.length,
      ...(onDemand && { onDemand }),
      stuck: mine.length - done.length,
      from: [...new Set(done.flatMap((r) => r.from))].sort(),
      to: [...new Set(done.map((r) => r.to!))].sort(),
    };
  }

  // The regions avoided now, such as "aws us-east-2", with until when.
  avoidedNow(now: number) {
    return [...this.avoided]
      .filter(([, until]) => until > now)
      .map(([where, until]) => ({ where, until }));
  }
}
