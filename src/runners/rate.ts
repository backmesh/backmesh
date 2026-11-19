// What a runner's VM costs while its job runs. There's
// no VM while idle, so this is per use, not a monthly floor.
import { findVmType, type VmTypeDetails } from './anycloud.js';
import { where, type RunnerClass } from './classes.js';
import { regionOf } from './regions.js';

/**
 * A VM Job launches one of its types with capacity in one of its regions, so
 * its $/hour ranges over the list's prices there; null when none is priced.
 * The install region's catalog prices every region.
 */
export function classRate(
  {
    cloud,
    regions,
    vmTypes,
    spot,
  }: Pick<RunnerClass, 'cloud' | 'regions' | 'vmTypes' | 'spot'>,
  details: readonly VmTypeDetails[],
): { low: number; high: number } | null {
  const prices = vmTypes.flatMap((vmType) =>
    (findVmType(details, vmType)?.regions ?? []).flatMap((offer) => {
      if (!regions.includes(regionOf(cloud, offer.region))) return [];
      const usd = spot ? offer.spotPricePerHour : offer.onDemandPricePerHour;
      return typeof usd === 'number' ? [usd] : [];
    }),
  );
  const cents = (usd: number) => Math.round(usd * 100) / 100;
  return prices.length
    ? { low: cents(Math.min(...prices)), high: cents(Math.max(...prices)) }
    : null;
}

const range = (rate: ReturnType<typeof classRate>) =>
  rate
    ? `$${[...new Set([rate.low, rate.high])].map((v) => v.toFixed(2)).join('–')}`
    : 'an unpriced amount';

/**
 * The lines install prints per cloud: priced at its default class, and at
 * its GPU class when it has one.
 */
export function formatRate(
  classes: readonly RunnerClass[],
  details: readonly VmTypeDetails[],
): string[] {
  const [spot, onDemand] = [true, false].map((s) =>
    classes.find((c) => c.vcpus === 4 && !c.kvm && !c.gpu && c.spot === s),
  );
  const { cloud, regions } = (spot ?? onDemand)!;
  const [gpuSpot, gpuOnDemand] = [true, false].map((s) =>
    classes.find((c) => c.gpu && c.spot === s),
  );
  return [
    `${where(cloud, regions)}: no VM while idle; while its job runs, a ${spot?.label ?? 'backmesh-4'} VM costs about ${range(spot ? classRate(spot, details) : null)} an hour on spot and ${range(onDemand ? classRate(onDemand, details) : null)} on demand, plus its disk, and the other sizes scale with their vCPUs`,
    ...(gpuSpot && gpuOnDemand
      ? [
          `${where(cloud, gpuSpot.regions)}: a ${gpuSpot.label} VM (${gpuSpot.vmTypes.join(', ')}) costs about ${range(classRate(gpuSpot, details))} an hour on spot and ${range(classRate(gpuOnDemand, details))} on demand, plus its disk`,
        ]
      : []),
  ];
}
