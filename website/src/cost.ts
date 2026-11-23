// The landing page's cost figures, computed here so they can be checked.
// Compute only: backmesh's core features are free. The cost docs page,
// src/content/docs/cost.md, repeats these figures; update it with them.

/** GitHub-hosted Linux 4-core x64 (`linux_4_core`), $/minute, list price
 * before included minutes. docs.github.com/en/billing/reference/actions-runner-pricing,
 * read 2026-11-05. */
export const GITHUB_4_CORE_PER_MIN = 0.012;

/** The catalog's spot prices on 2026-11-13 (refreshed with the
 * 2026-11-13 VM type reorder), the lowest zone in each region, for
 * `backmesh-4`'s VM types (src/runners/classes.ts, same figures). Each job gets
 * its own 4-vCPU, 16 GiB VM, which bills from its boot until the job ends.
 * Disks are left out: each runner's 100 GB gp3 disk, at 4,000 IOPS and
 * 500 MiB/s (src/listener/runner-jobs.ts), adds about $0.038 an hour on AWS.
 * `bootS` is the VM boot each job pays, as measured (coordinator,
 * 2026-11-07): about 30 s on AWS, 60–70 s on GCP and Azure. `controlPlane` is
 * the fixed monthly cost while runners have no VM: the management VM and one
 * org's listener VM with their disks and public addresses, as install prints
 * it (src/cli/install.ts MANAGEMENT_MONTHLY_USD and src/cli/listener-vm.ts
 * LISTENER_VM_MONTHLY_USD). */
export const CATALOG_DATE = '2026-11-13';
/** AWS's `backmesh-4` spot prices by VM family, $/hour, as above. */
export const AWS_SPOT_XLARGE: Record<string, number> = {
  m8i: 0.0583,
  m7a: 0.07,
  m7i: 0.0497,
  m6a: 0.0547,
};
const clouds = [
  {
    cloud: 'AWS',
    region: 'us-east-2',
    // No m6i.
    spot: Object.values(AWS_SPOT_XLARGE),
    bootS: [30, 30],
    controlPlane: 86,
  },
  {
    cloud: 'Azure',
    region: 'westus2',
    // ads_v5, as_v5, s_v5.
    spot: [0.0381, 0.0318, 0.0355],
    bootS: [60, 70],
    controlPlane: 111,
  },
  {
    cloud: 'GCP',
    region: 'us-central1',
    // n2, n2d.
    spot: [0.1165, 0.0899],
    bootS: [60, 70],
    controlPlane: 74,
  },
];

/** $ per 1,000 minutes of a 4-vCPU job on each cloud, and $ per 1,000 jobs'
 * boots, over the cheapest and most expensive types. */
export const per1000 = clouds.map(
  ({ cloud, region, spot, bootS, controlPlane }) => {
    const [low, high] = [Math.min(...spot), Math.max(...spot)];
    const [fast, slow] = bootS as [number, number];
    return {
      cloud,
      region,
      controlPlane,
      low: (low / 60) * 1000,
      high: (high / 60) * 1000,
      bootS,
      bootLow: (low / 3600) * fast * 1000,
      bootHigh: (high / 3600) * slow * 1000,
    };
  },
);

export const github1000 = GITHUB_4_CORE_PER_MIN * 1000;

/** The headline: a month of 4-vCPU jobs on GitHub and on backmesh, as a
 * lower bound: each cloud's fixed control plane plus the jobs' spot VMs over
 * the cheapest and most expensive types, without disks, boots, or runners the
 * planner starts that no job takes. backmesh's range spans all three clouds. */
export const MINUTES = 150_000;
const month = (per1000Usd: number) => (MINUTES / 1000) * per1000Usd;
export const totals = per1000.map((p) => ({
  cloud: p.cloud,
  low: p.controlPlane + month(p.low),
  high: p.controlPlane + month(p.high),
}));
export const headline = {
  github: MINUTES * GITHUB_4_CORE_PER_MIN,
  low: Math.min(...totals.map((t) => t.low)),
  high: Math.max(...totals.map((t) => t.high)),
};
