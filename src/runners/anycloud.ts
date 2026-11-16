// The anycloud read install and upgrade plan the classes from, behind an
// interface tests replace. The catalog is local to the pinned binary, so
// `vm-types` runs it with `--json`.
import { runAnycloud, type RunAnycloud } from '../anycloud/binary.js';
import type { Cloud } from './classes.js';

/** A record of `vm-types <cloud> <region> --details --json` (anycloud `src/shared/catalog/vm-details.ts:9-25`). */
export interface VmTypeDetails {
  vmType: string;
  vCPUs: number | null;
  memoryGiB: number | null;
  accelerators: unknown[] | null;
  capabilities?: { nestedVirtualization: boolean | null };
  regions: {
    region: string;
    onDemandPricePerHour?: number | null;
    spotPricePerHour: number | null;
  }[];
}

/** Catalog lookups ignore case, as anycloud's do (`vm-details.ts:35`). */
export const findVmType = (details: readonly VmTypeDetails[], vmType: string) =>
  details.find((entry) => entry.vmType.toLowerCase() === vmType.toLowerCase());

export interface RunnersAnycloud {
  vmTypeDetails(cloud: Cloud, region: string): Promise<VmTypeDetails[]>;
}

export function anycloudRunners(
  exec: RunAnycloud = runAnycloud,
): RunnersAnycloud {
  return {
    vmTypeDetails: async (cloud, region) => {
      const args = ['vm-types', cloud, region, '--details', '--json'];
      const stdout = await exec(args);
      let result: unknown;
      try {
        result = JSON.parse(stdout);
      } catch {
        result = undefined;
      }
      if (!Array.isArray(result)) {
        throw new Error(`${args.join(' ')} printed no JSON list`);
      }
      return result as VmTypeDetails[];
    },
  };
}
