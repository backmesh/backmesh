import { randomInt } from 'node:crypto';

import { z } from 'zod';

import { CLOUDS, type RunnerClass } from '../runners/classes.js';

// Fixed routing: each label is one scale set whose runners are
// VM Jobs of its class. Install and upgrade write the classes into the
// listener's Secret as `BACKMESH_RUNNERS` (`runners/classes.ts`).
export const RUNNERS_ENV = 'BACKMESH_RUNNERS';

const RunnerClasses = z.array(
  z.object({
    label: z.string(),
    code: z.string().regex(/^[0-9a-z]{2}$/),
    cloud: z.enum(CLOUDS),
    region: z.string(),
    credentials: z.string(),
    vcpus: z.number().int().positive(),
    spot: z.boolean(),
    kvm: z.boolean(),
    vmTypes: z.array(z.string()).min(1),
    // A Secret from before regions has none: its runners launch in
    // its one region until `upgrade` rewrites it.
    regions: z.array(z.string()).min(1).optional(),
    // A class install or upgrade removed: its scale set takes no new jobs and
    // is deleted once GitHub counts no job assigned to it, since GitHub accepts
    // deleting a busy scale set and fails its job minutes later.
    retiring: z.boolean().optional(),
    public: z.boolean().optional(),
  }),
);

export interface Route extends RunnerClass {
  retiring?: boolean;
  // A spot route's on-demand label of the same size and kind: where a retry
  // or a paused spot capacity's runners go, as on-demand VMs.
  onDemand?: { label: string };
}

export function parseRoutes(json: string): Route[] {
  let classes: Route[];
  try {
    classes = RunnerClasses.parse(JSON.parse(json)).map((route) => ({
      ...route,
      regions: route.regions ?? [route.region],
    }));
  } catch (error) {
    throw new Error(`${RUNNERS_ENV} is malformed: ${String(error)}`);
  }
  const routes = classes.map((route): Route => {
    // A public route has no on-demand pair, so it feeds no breaker and has
    // no on-demand retry.
    const od =
      route.spot &&
      !route.retiring &&
      !route.public &&
      classes.find(
        (c) =>
          !c.spot &&
          !c.retiring &&
          c.cloud === route.cloud &&
          c.kvm === route.kvm &&
          c.vcpus === route.vcpus,
      );
    return { ...route, ...(od && { onDemand: { label: od.label } }) };
  });
  // A runner's code is all that names its scale set.
  const codes = routes.map((route) => route.code);
  const repeated = codes.find((code, i) => codes.indexOf(code) !== i);
  if (repeated) throw new Error(`Two routes share the code ${repeated}.`);
  return routes;
}

// The runner Job's ID scheme, which is also the runner's name: `bm`, the
// 5-character installation tag, `-`, the scale set's code, `-` and 8 random
// base36 characters: always 19, within anycloud's 28
// (`workload-admission-checks.ts`).
export function runnerName(install: string, code: string): string {
  const suffix = Array.from({ length: 8 }, () => randomInt(36).toString(36));
  return `bm${install}-${code}-${suffix.join('')}`;
}

// Any backmesh runner's name, of any installation.
export const RUNNER_NAME = /^bm[0-9a-z]{5}-[0-9a-z]{2}-[0-9a-z]{8}$/;

// A restarted listener knows its runners only by name.
export function codeOf(install: string, name: string): string | undefined {
  const prefix = `bm${install}-`;
  return name.startsWith(prefix) && name.length === 19
    ? name.slice(prefix.length, prefix.length + 2)
    : undefined;
}
