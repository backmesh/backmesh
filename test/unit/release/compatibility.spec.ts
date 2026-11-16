import { describe, expect, it } from 'vitest';

import { ANYCLOUD_VERSION } from '../../../src/anycloud/contract.generated.js';
import {
  readCompatibility,
  releaseMatrix,
} from '../../../src/release/compatibility.js';

const digest = `sha256:${'a'.repeat(64)}`;
const images = {
  runnerImage: `ghcr.io/backmesh/backmesh-runner@${digest}`,
  listenerImage: `ghcr.io/backmesh/backmesh-listener@${digest}`,
};

describe('the compatibility matrix', () => {
  it('pins the generated client’s anycloud version', () => {
    expect(releaseMatrix({ backmesh: '1.2.3', ...images })).toEqual({
      backmesh: '1.2.3',
      anycloud: ANYCLOUD_VERSION,
      ...images,
    });
  });

  it.each([
    ['a tag', { runnerImage: 'ghcr.io/backmesh/backmesh-runner:v1.2.3' }],
    ['the other image', { runnerImage: images.listenerImage }],
    ['a prerelease', { backmesh: '1.2.3-rc.1' }],
  ])('refuses %s', (_, change) => {
    expect(() =>
      releaseMatrix({ backmesh: '1.2.3', ...images, ...change }),
    ).toThrow();
  });
});

describe('reading the release’s matrix', () => {
  const pinned = { backmesh: '1.2.3', anycloud: ANYCLOUD_VERSION, ...images };
  const matrix = (body: object) => JSON.stringify(body);

  it('reads both digests for the pinned anycloud', () => {
    expect(readCompatibility(matrix(pinned))).toEqual(pinned);
  });

  it('refuses another anycloud, a tag and a build without a matrix', () => {
    const other = matrix({ ...pinned, anycloud: '0.0.1' });
    expect(() => readCompatibility(other)).toThrow("doesn't match");
    const tagged = matrix({
      ...pinned,
      runnerImage: 'ghcr.io/backmesh/backmesh-runner:latest',
    });
    expect(() => readCompatibility(tagged)).toThrow("doesn't match");
    // Only a release binary embeds one.
    expect(() => readCompatibility()).toThrow('Install a released backmesh');
  });
});
