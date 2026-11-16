// e2e.yml's label job, assertion 2: this job's own container must run the
// image the pinned release's compatibility.json names (src/release/
// compatibility.ts's `runnerImage`).
//
//   EXPECTED_IMAGE=ghcr.io/backmesh/backmesh-runner@sha256:... \
//     node test/e2e/check-image-digest.ts
import { execFileSync } from 'node:child_process';

import { ownContainerId, ownImageRepoDigests } from './own-image.ts';

function fail(message: string): never {
  console.error(`::error::${message}`);
  process.exit(1);
}

const expected = process.env.EXPECTED_IMAGE;
if (!expected) throw new Error('EXPECTED_IMAGE is required');
if (!expected.includes('@')) {
  throw new Error(`EXPECTED_IMAGE ${expected} isn't repo@digest`);
}

const docker = (args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf8', timeout: 10_000 });

const repoDigests = ownImageRepoDigests(docker, ownContainerId());
console.log(
  `This container's image repo digests: ${repoDigests.join(', ') || '(none)'}`,
);
if (!repoDigests.includes(expected)) {
  fail(`this runner's image doesn't match the pinned release's ${expected}`);
}
