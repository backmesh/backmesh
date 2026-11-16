import { describe, expect, it } from 'vitest';

import {
  ownContainerId,
  ownImageRepoDigests,
  type DockerRunner,
} from '../../../test/e2e/own-image.ts';

const CONTAINER_ID =
  'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

describe('ownContainerId', () => {
  it("reads this container's id from /proc/self/mountinfo", () => {
    const mountinfo = [
      '123 456 0:1 / / rw,relatime shared:1 - overlay overlay rw',
      `124 123 8:1 /var/lib/docker/containers/${CONTAINER_ID}/hostname /etc/hostname rw,relatime - ext4 /dev/root rw`,
      `125 123 8:1 /var/lib/docker/containers/${CONTAINER_ID}/hosts /etc/hosts rw,relatime - ext4 /dev/root rw`,
    ].join('\n');
    expect(ownContainerId(mountinfo)).toBe(CONTAINER_ID);
  });

  it("throws when the container's id isn't in mountinfo", () => {
    expect(() =>
      ownContainerId('123 456 0:1 / / rw - overlay overlay rw'),
    ).toThrow("couldn't find this container's id");
  });
});

describe('ownImageRepoDigests', () => {
  const fakeDocker = (imageId: string, repoDigests: string[]): DockerRunner => {
    return (args) => {
      if (args[0] === 'inspect') return `${imageId}\n`;
      if (args[0] === 'image' && args[1] === 'inspect') {
        return JSON.stringify(repoDigests);
      }
      throw new Error(`unexpected docker args: ${args.join(' ')}`);
    };
  };

  it("returns the image's repo digests, for the caller to check membership of", () => {
    const docker = fakeDocker('sha256:imageid', [
      'ghcr.io/backmesh/backmesh-listener@sha256:aaaa',
      'ghcr.io/backmesh/backmesh-runner@sha256:bbbb',
    ]);
    expect(ownImageRepoDigests(docker, CONTAINER_ID)).toEqual([
      'ghcr.io/backmesh/backmesh-listener@sha256:aaaa',
      'ghcr.io/backmesh/backmesh-runner@sha256:bbbb',
    ]);
  });

  it("throws when RepoDigests isn't a string array", () => {
    const docker: DockerRunner = (args) =>
      args[0] === 'inspect' ? 'sha256:imageid\n' : 'null';
    expect(() => ownImageRepoDigests(docker, CONTAINER_ID)).toThrow(
      "isn't a string array",
    );
  });
});
