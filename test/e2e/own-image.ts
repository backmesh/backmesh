// Finds the repo digest of the image this job's own container runs, through
// the VM's Docker (`--host-docker`), so the per-label
// job can check it against the pinned release's compatibility.json
// (`runnerImage`, src/release/compatibility.ts).
import { readFileSync } from 'node:fs';

/** Runs a Docker CLI command and resolves with its stdout, so tests can fake
 * it without a socket. */
export type DockerRunner = (args: string[]) => string;

/**
 * This container's id, read from `/proc/self/mountinfo`: Docker bind-mounts
 * `/var/lib/docker/containers/<id>/...` files (`hostname`, `hosts`,
 * `resolv.conf`) into every container at the same id, regardless of the
 * cgroup driver, so it's there under cgroup v1 and v2 alike.
 */
export function ownContainerId(
  mountinfo = readFileSync('/proc/self/mountinfo', 'utf8'),
): string {
  const match = /\/containers\/([0-9a-f]{64})\//.exec(mountinfo);
  if (!match) {
    throw new Error(
      "couldn't find this container's id in /proc/self/mountinfo; is this running in a Docker container?",
    );
  }
  return match[1]!;
}

/**
 * The repo digests (`repo@sha256:...` strings) of the image reported by the
 * host's own Docker for the container `containerId`. Each holds the exact
 * `repo@digest` the image was pulled by, so the pinned release's
 * `repo@digest` must appear in this array exactly (`.includes`), not merely
 * share a repo with some entry here.
 */
export function ownImageRepoDigests(
  docker: DockerRunner,
  containerId: string,
): string[] {
  const imageId = docker([
    'inspect',
    containerId,
    '--format',
    '{{.Image}}',
  ]).trim();
  const raw = docker([
    'image',
    'inspect',
    imageId,
    '--format',
    '{{json .RepoDigests}}',
  ]);
  const repoDigests: unknown = JSON.parse(raw);
  if (
    !Array.isArray(repoDigests) ||
    !repoDigests.every((d) => typeof d === 'string')
  ) {
    throw new Error(`${imageId}'s RepoDigests isn't a string array: ${raw}`);
  }
  return repoDigests as string[];
}
