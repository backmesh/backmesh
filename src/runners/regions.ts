// The regions backmesh's runners may launch in (owner, 2026-11-13). Each
// geo's candidates per cloud are fixed in code,
// not discovered through the user's cloud CLI: every region of the geo whose
// pinned catalog offers every type of every `backmesh-ubuntu-2404-Nvcpu`,
// `backmesh-ubuntu-2404-kvm-Nvcpu` and `backmesh-ubuntu-2404-highmem-Nvcpu`
// class, so no class's types ever need a per-region
// filter (`classes.ts`). `test/unit/runners/regions.spec.ts` checks this
// list against a pinned snapshot of the real catalog, so a catalog or
// type change that breaks it fails CI. Install and upgrade narrow it
// further to the regions the account actually allows (`cache-buckets.ts`).
import type { Cloud } from './classes.js';

/**
 * Runs a local command and resolves with its stdout: the quota and sign-in
 * checks', which still read the user's cloud CLI (`quota.ts`,
 * `prerequisites.ts`); region discovery no longer does. `env` adds
 * variables to the inherited environment.
 */
export type RunCommand = (
  command: string[],
  env?: NodeJS.ProcessEnv,
  // Milliseconds, a minute unless given.
  timeout?: number,
) => Promise<string>;

/**
 * The runner region groups: `install --runner-geo`, US unless given. A
 * geo's regions are fixed in code like the US list (owner, 2026-11-13), not
 * a region list on the command line; EU's was approved for a design
 * partner's europe-west4 pilot (owner, 2026-11-25).
 */
export const GEOS = ['us', 'eu'] as const;
export type Geo = (typeof GEOS)[number];

/**
 * Each geo's runner region candidates per cloud, anchor first
 * (`SUGGESTED_REGION`). US: AWS excludes `us-west-1` (no `m7a` or `m8a`);
 * GCP excludes `us-central2` (almost no general-purpose types); every US
 * Azure region qualifies. EU is the regions in EU member states only, so a
 * job's data stays in the EU: AWS excludes `eu-north-1`, `eu-south-1`,
 * `eu-south-2` and `eu-west-3` (each lacks a class's family); GCP excludes
 * `europe-north2` (no `n2` or `n2d`); every EU Azure region qualifies.
 * London, Zurich and Norway's regions aren't in the EU.
 */
export const RUNNER_REGIONS: Record<Geo, Record<Cloud, string[]>> = {
  us: {
    aws: ['us-east-1', 'us-east-2', 'us-west-2'],
    gcp: [
      'us-east4',
      'us-central1',
      'us-east1',
      'us-east5',
      'us-south1',
      'us-west1',
      'us-west2',
      'us-west3',
      'us-west4',
    ],
    azure: [
      'eastus',
      'centralus',
      'eastus2',
      'northcentralus',
      'southcentralus',
      'westcentralus',
      'westus',
      'westus2',
      'westus3',
    ],
  },
  eu: {
    aws: ['eu-central-1', 'eu-west-1'],
    gcp: [
      'europe-west4',
      'europe-west1',
      'europe-west3',
      'europe-west9',
      'europe-west8',
      'europe-west12',
      'europe-west10',
      'europe-southwest1',
      'europe-north1',
      'europe-central2',
    ],
    azure: [
      'westeurope',
      'northeurope',
      'germanywestcentral',
      'francecentral',
      'swedencentral',
      'italynorth',
      'polandcentral',
      'spaincentral',
      'austriaeast',
      'belgiumcentral',
      'denmarkeast',
    ],
  },
};

// Each geo's anchor: US's is near GitHub's US East, EU's near Amsterdam
// (GCP's europe-west4 and Azure's westeurope are there, AWS's eu-central-1
// in Frankfurt). The control plane's without `--control-plane`, and another
// runner cloud's anchor. The control plane's own region choice is
// unrelated to `RUNNER_REGIONS` and stays free (owner, 2026-11-13): it
// isn't a runner region.
export const SUGGESTED_REGION: Record<Geo, Record<Cloud, string>> = {
  us: { aws: 'us-east-1', gcp: 'us-east4', azure: 'eastus' },
  eu: { aws: 'eu-central-1', gcp: 'europe-west4', azure: 'westeurope' },
};

/**
 * The geo an installation's runners are in, from its routes' regions: an
 * upgrade or a re-run without `--runner-geo` keeps it. US when none of
 * them is a geo's candidate, as a single-region route's may not be.
 */
export const geoOf = (
  routes: readonly { cloud: Cloud; regions: readonly string[] }[],
): Geo =>
  GEOS.find((geo) =>
    routes.some((r) =>
      r.regions.some((region) => RUNNER_REGIONS[geo][r.cloud].includes(region)),
    ),
  ) ?? 'us';

/** A cloud's `--runner-region`: tried first, the geo's others its failover. */
export type Preferred = Partial<Record<Cloud, string>>;

/** The preferred regions an installation's routes keep (`preferred`). */
export const preferredOf = (
  routes: readonly {
    cloud: Cloud;
    regions: readonly string[];
    preferred?: true;
    retiring?: boolean;
  }[],
): Preferred =>
  Object.fromEntries(
    routes
      .filter((r) => r.preferred && !r.retiring)
      .map((r) => [r.cloud, r.regions[0]!]),
  );

/** A catalog offering's region: GCP's are zones, such as us-central1-a. */
export const regionOf = (cloud: Cloud, offering: string) =>
  cloud === 'gcp' ? offering.replace(/-[a-z]$/, '') : offering;
