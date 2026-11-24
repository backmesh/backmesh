// The landing page's cost figures, computed here so they can be checked.
// Compute only: backmesh's core features are free. The cost docs page,
// src/content/docs/cost.md, repeats these figures; update it with them.

/** GitHub-hosted Linux 4-core x64 (`linux_4_core`), $/minute, list price
 * before included minutes. docs.github.com/en/billing/reference/actions-runner-pricing,
 * read 2026-11-05. */
export const GITHUB_4_CORE_PER_MIN = 0.012;

/** The catalog's spot prices on 2026-11-13 (refreshed with the
 * 2026-11-13 VM type reorder), the lowest zone in each region, for
 * `backmesh-ubuntu-2404-4vcpu`'s VM types (src/runners/classes.ts, same figures). Each job gets
 * its own 4-vCPU, 16 GiB VM, which bills from its boot until the job ends.
 * Disks are left out: each runner's 100 GB gp3 disk, at 4,000 IOPS and
 * 500 MiB/s (src/listener/runner-jobs.ts), adds about $0.038 an hour on AWS,
 * and its 100 GB pd-ssd disk about $0.023 an hour on GCP ($0.17 a GB-month in
 * us-central1, cloud.google.com/compute/disks-image-pricing, read 2026-11-23).
 * `bootS` is the VM boot each job pays, as measured (coordinator,
 * 2026-11-07): about 30 s on AWS, 60–70 s on GCP and Azure. `controlPlane` is
 * the fixed monthly cost while runners have no VM: the management VM and one
 * org's listener VM with their disks and public addresses, as install prints
 * it (src/cli/install.ts MANAGEMENT_MONTHLY_USD and src/cli/listener-vm.ts
 * LISTENER_VM_MONTHLY_USD). */
export const CATALOG_DATE = '2026-11-13';
/** AWS's `backmesh-ubuntu-2404-4vcpu` spot prices by VM family, $/hour, as above; `m8a`'s
 * from the catalog on 2026-11-23. */
export const AWS_SPOT_XLARGE: Record<string, number> = {
  m8a: 0.065,
  m8i: 0.0583,
  m7a: 0.07,
  m7i: 0.0497,
  m6a: 0.0547,
};
/** AWS's `backmesh-ubuntu-2404-od-4vcpu` on-demand prices by VM family, $/hour, us-east-2's
 * from the catalog, as docs/aws.md lists them. */
export const AWS_ON_DEMAND_XLARGE: Record<string, number> = {
  m8a: 0.2434,
  m8i: 0.2117,
  m7a: 0.2318,
  m7i: 0.2016,
  m6a: 0.1728,
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

/** GitHub-hosted Linux GPU runner (`linux_4_core_gpu`: 4 vCPUs, one Tesla
 * T4 with 16 GB of VRAM, 28 GB of RAM), $/minute.
 * docs.github.com/en/billing/reference/actions-runner-pricing, read
 * 2026-11-24. */
export const GITHUB_T4_PER_MIN = 0.052;

/** The GPU labels' types (src/runners/classes.ts GPU_TYPES), $/hour, from
 * the catalog on 2026-11-18: spot in the lowest zone and on demand, in the
 * same regions as above. AWS tries `g4dn.2xlarge` when no `g4dn.xlarge` is
 * free. The GPU page, docs/gpu.md, and docs/cost.md repeat these figures;
 * scripts/check-gpu.mjs checks them in the build. */
export const GPU_CATALOG_DATE = '2026-11-18';
export const GPU_PRICES = [
  { cloud: 'AWS', type: 'g4dn.xlarge', spot: 0.2732, onDemand: 0.526 },
  { cloud: 'AWS', type: 'g4dn.2xlarge', spot: 0.3696, onDemand: 0.752 },
  {
    cloud: 'Azure',
    type: 'Standard_NC4as_T4_v3',
    spot: 0.1766,
    onDemand: 0.526,
  },
];

/** A cold `backmesh-gpu-t4` VM's median launch to job start on AWS, s: 10
 * samples on 2026-11-21, none refused spot capacity (benchmarks/gpu-t4). */
export const AWS_GPU_BOOT_S = 122;

/** The runner's disk on AWS, $ an hour, as above. */
export const AWS_DISK_PER_HOUR = 0.0384;

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
