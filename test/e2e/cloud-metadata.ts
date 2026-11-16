// Detects the VM's cloud and region from its own instance metadata endpoint,
// so the per-label job can check it against what the label promises. Each
// cloud's endpoint only answers on its own VMs, so trying them in turn and
// taking the first that answers identifies the cloud too.
import type { Cloud } from './labels.ts';

export interface CloudRegion {
  cloud: Cloud;
  region: string;
}

/** The parts of `fetch` this module uses, so tests can fake it without a
 * network. */
export type MetadataFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{ ok: boolean; text(): Promise<string> }>;

async function get(
  fetchImpl: MetadataFetch,
  url: string,
  headers?: Record<string, string>,
  method = 'GET',
): Promise<string | undefined> {
  let response;
  try {
    response = await fetchImpl(url, { method, headers });
  } catch {
    return undefined; // unreachable: not this cloud, or no network path
  }
  if (!response.ok) return undefined;
  return (await response.text()).trim();
}

/** AWS's IMDSv2 region, GCP's zone (its region is the zone less its letter
 * suffix) or Azure's IMDS location, whichever endpoint answers. */
export async function detectCloudRegion(
  fetchImpl: MetadataFetch,
): Promise<CloudRegion> {
  const token = await get(
    fetchImpl,
    'http://169.254.169.254/latest/api/token',
    { 'X-aws-ec2-metadata-token-ttl-seconds': '60' },
    'PUT',
  );
  if (token !== undefined) {
    const region = await get(
      fetchImpl,
      'http://169.254.169.254/latest/meta-data/placement/region',
      { 'X-aws-ec2-metadata-token': token },
    );
    if (region) return { cloud: 'aws', region };
  }

  const zone = await get(
    fetchImpl,
    'http://metadata.google.internal/computeMetadata/v1/instance/zone',
    { 'Metadata-Flavor': 'Google' },
  );
  if (zone) {
    // "projects/<id>/zones/us-central1-a"
    const name = zone.split('/').pop() ?? '';
    const region = name.replace(/-[a-z]$/, '');
    if (region) return { cloud: 'gcp', region };
  }

  // IMDS answers a leaf such as `location` only as text; its JSON default
  // gets HTTP 400 there.
  const location = await get(
    fetchImpl,
    'http://169.254.169.254/metadata/instance/compute/location?api-version=2021-02-01&format=text',
    { Metadata: 'true' },
  );
  // Azure region names ignore case, and IMDS may answer `CanadaCentral`.
  if (location) return { cloud: 'azure', region: location.toLowerCase() };

  throw new Error(
    "none of AWS's, GCP's or Azure's instance metadata endpoints answered",
  );
}
