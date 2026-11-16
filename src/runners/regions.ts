// The regions backmesh's runners may launch in (owner, 2026-11-13). Each
// cloud's candidates are fixed in code,
// not discovered through the user's cloud CLI: every US region whose
// pinned catalog offers every type of every `backmesh-N` and
// `backmesh-kvm-N` class, so no class's types ever need a per-region
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
) => Promise<string>;

/**
 * Each cloud's runner region candidates, anchor first (`SUGGESTED_REGION`):
 * AWS excludes `us-west-1` (no `m7a`); GCP excludes `us-central2` (almost
 * no general-purpose types); every US Azure region qualifies.
 */
export const RUNNER_REGIONS: Record<Cloud, string[]> = {
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
};

// A region near GitHub's US East: the control plane's without
// `--control-plane`, and another runner cloud's anchor. The control
// plane's own region choice is unrelated to `RUNNER_REGIONS` and stays
// free (owner, 2026-11-13): it isn't a runner region.
export const SUGGESTED_REGION: Record<Cloud, string> = {
  aws: 'us-east-1',
  gcp: 'us-east4',
  azure: 'eastus',
};

/** A catalog offering's region: GCP's are zones, such as us-central1-a. */
export const regionOf = (cloud: Cloud, offering: string) =>
  cloud === 'gcp' ? offering.replace(/-[a-z]$/, '') : offering;
