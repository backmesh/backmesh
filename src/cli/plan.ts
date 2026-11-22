// What `backmesh install` would create and bill, and the ID that `--yes
// --plan-id` agrees to. `--plan` prints it
// with no GitHub sign-in and nothing created, so an agent can show it and
// ask once; `--yes --plan-id` recomputes it and refuses a changed one.
import { createHash } from 'node:crypto';

import type { RunnerClass } from '../runners/classes.js';
import type { RunnerChanges } from './converge.js';

export interface InstallPlan {
  org: string;
  // `--cache-cap`, or the running listener's: each repository's cache per
  // region in GB, absent for the default 10.
  cacheCapGb?: number;
  orgId: number;
  anycloud: string;
  images: { runner: string; listener: string };
  // The clouds install connects: the control plane's first, unless this run
  // reuses it with a listener on it and it's no runner cloud, when it's
  // left out. `account`
  // is the AWS account, GCP project or Azure subscription that bills it.
  clouds: { cloud: string; region: string; account: string }[];
  controlPlane: {
    cloud: string;
    region: string;
    // A new one's VM; absent for an existing one, whose size the plan
    // doesn't read.
    managementVm?: string;
    monthlyUsd?: number;
    // Read from this machine's control plane when it has one; a new one
    // otherwise, and install checks again once `api create` resumes it.
    exists: boolean;
    sharedWith: string[];
  };
  // The org's own listener VM, which a re-run keeps: null then.
  listener: {
    cloud: string;
    region: string;
    vmType: string;
    monthlyUsd: number;
  } | null;
  // Azure's: the regions install tries, in order, for the always-on VMs it
  // creates, with the size each takes there, the first of its sizes the
  // region offers (`vm-sizes.ts`); absent elsewhere.
  alwaysOnRegions?: {
    region: string;
    managementVm?: string;
    listenerVm?: string;
  }[];
  // Each runner cloud's regions, fixed (`RUNNER_REGIONS`, `regions.ts`) and
  // account-allowed; hashed with the classes' regions, so another account
  // or placement is another plan.
  runners: { cloud: string; regions: string[] }[];
  classes: Pick<
    RunnerClass,
    | 'label'
    | 'cloud'
    | 'region'
    | 'vcpus'
    | 'spot'
    | 'kvm'
    | 'vmTypes'
    | 'regions'
    | 'gpu'
  >[];
  // Shown, not hashed, as `quotas`.
  rates: string[];
  noKvm: string[];
  noGpu: string[];
  // The same-owner check, as the human agrees to it; null for an org
  // alone on its control plane.
  sameOwner: string | null;
  // A re-run's: the listener it read (`fingerprint`), and what changes in
  // its runners; null on a new listener.
  current: string | null;
  changes: RunnerChanges | null;
  // Shown, not hashed: usage moves the numbers between the plan and the yes.
  quotas: string[];
}

export const sameOwnerLine = (org: string, others: readonly string[]) =>
  `${org} joins the control plane of ${others.join(', ')}. Each org's listener holds a control plane token that can reach the others' install keys, and their runners use the same cloud connections, so every one of them must have the same owner.`;

// The plan as built, in install's fixed key order. The quotas and rates
// are shown, not agreed to: usage moves the quotas, and the catalog behind
// the rates updates through the day, while the classes' VM types already
// fix what a job runs on.
export const planId = ({ quotas: _, rates: __, ...plan }: InstallPlan) =>
  hashPlan(plan);

export const hashPlan = (plan: object) =>
  `p-${createHash('sha256')
    .update(JSON.stringify(plan))
    .digest('hex')
    .slice(0, 12)}`;

/**
 * What `upgrade` changes: the control plane's anycloud and the
 * listeners' images, which need no consent, and each org's runner classes,
 * which do when they change (owner, 2026-11-08). `--plan` prints it before
 * any sign-in, and `--yes --plan-id` agrees to it.
 */
export interface UpgradePlan {
  anycloud: { from: string; to: string };
  images: { runner: string; listener: string };
  orgs: {
    org: string;
    // The listener it read (`fingerprint`), and what changes in its runners.
    current: string | null;
    changes: RunnerChanges;
    classes: Pick<RunnerClass, 'label' | 'cloud' | 'vmTypes' | 'regions'>[];
  }[];
}
