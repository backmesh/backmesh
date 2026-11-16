import { describe, expect, it } from 'vitest';

import {
  detectCloudRegion,
  type MetadataFetch,
} from '../../../test/e2e/cloud-metadata.ts';

// A fake instance metadata endpoint, answering only the URLs its cloud's VMs
// would.
const fakeMetadata = (
  answers: Record<string, string | undefined>,
): MetadataFetch => {
  return async (url) => {
    const text = answers[url];
    return {
      ok: text !== undefined,
      async text() {
        return text ?? '';
      },
    };
  };
};

describe('detectCloudRegion', () => {
  it('detects AWS from its IMDSv2 token and region endpoints', async () => {
    const fetchImpl = fakeMetadata({
      'http://169.254.169.254/latest/api/token': 'TOKEN123',
      'http://169.254.169.254/latest/meta-data/placement/region': 'us-east-2',
    });
    await expect(detectCloudRegion(fetchImpl)).resolves.toEqual({
      cloud: 'aws',
      region: 'us-east-2',
    });
  });

  it('detects GCP from its zone, stripping the zone letter', async () => {
    const fetchImpl = fakeMetadata({
      'http://metadata.google.internal/computeMetadata/v1/instance/zone':
        'projects/123456789/zones/us-central1-a',
    });
    await expect(detectCloudRegion(fetchImpl)).resolves.toEqual({
      cloud: 'gcp',
      region: 'us-central1',
    });
  });

  it('detects Azure from its IMDS location', async () => {
    // Like Azure IMDS: a leaf answers only with `format=text` (its JSON
    // default gets HTTP 400) and the `Metadata: true` header.
    const fetchImpl: MetadataFetch = async (url, init) => {
      const { origin, pathname, searchParams } = new URL(url);
      const ok =
        origin === 'http://169.254.169.254' &&
        pathname === '/metadata/instance/compute/location' &&
        searchParams.has('api-version') &&
        searchParams.get('format') === 'text' &&
        init?.headers?.Metadata === 'true';
      return {
        ok,
        async text() {
          return ok ? 'EastUS' : '';
        },
      };
    };
    await expect(detectCloudRegion(fetchImpl)).resolves.toEqual({
      cloud: 'azure',
      region: 'eastus',
    });
  });

  it('prefers AWS over GCP and Azure when, somehow, more than one answers', async () => {
    const fetchImpl = fakeMetadata({
      'http://169.254.169.254/latest/api/token': 'TOKEN123',
      'http://169.254.169.254/latest/meta-data/placement/region': 'us-east-2',
      'http://metadata.google.internal/computeMetadata/v1/instance/zone':
        'projects/123/zones/us-central1-a',
    });
    await expect(detectCloudRegion(fetchImpl)).resolves.toEqual({
      cloud: 'aws',
      region: 'us-east-2',
    });
  });

  it('throws when no cloud answers', async () => {
    await expect(detectCloudRegion(fakeMetadata({}))).rejects.toThrow(
      "none of AWS's, GCP's or Azure's",
    );
  });

  it('treats a thrown fetch (no network path) the same as not answering', async () => {
    const fetchImpl: MetadataFetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    await expect(detectCloudRegion(fetchImpl)).rejects.toThrow(
      "none of AWS's, GCP's or Azure's",
    );
  });
});
