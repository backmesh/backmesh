// Parses e2e.yml's `labels` input: one entry per label under test, each
// naming the cloud and runner regions its class promises,
// so the per-label job can check instance metadata against them without a
// live install to read `BACKMESH_RUNNERS` from. A label naming `-kvm-` also
// gets the `/dev/kvm` check (KVM classes), and one naming `-gpu-` the GPU
// check (GPU classes).

export type Cloud = 'aws' | 'gcp' | 'azure';

const CLOUDS: readonly Cloud[] = ['aws', 'gcp', 'azure'];

export interface LabelSpec {
  label: string;
  cloud: Cloud;
  regions: string[];
  kvm: boolean;
  gpu: boolean;
}

const isCloud = (value: string): value is Cloud =>
  (CLOUDS as readonly string[]).includes(value);

/**
 * Parses whitespace-separated `label=cloud:region[,region…]` entries, such as
 * `backmesh-4=aws:us-east-2,us-east-1,us-west-2 backmesh-kvm-4=aws:us-east-2`.
 */
export function parseLabels(spec: string): LabelSpec[] {
  const entries = spec.trim().split(/\s+/).filter(Boolean);
  if (entries.length === 0) throw new Error('labels is empty');
  const seen = new Set<string>();
  return entries.map((entry) => {
    const eq = entry.indexOf('=');
    const colon = entry.indexOf(':', eq + 1);
    if (eq < 1 || colon < 0) {
      throw new Error(`${entry} isn't label=cloud:region[,region…]`);
    }
    const label = entry.slice(0, eq);
    const cloud = entry.slice(eq + 1, colon);
    const regions = entry
      .slice(colon + 1)
      .split(',')
      .filter(Boolean);
    if (!/^[a-z0-9-]+$/.test(label)) {
      throw new Error(`${entry}'s label ${label} has unexpected characters`);
    }
    if (!isCloud(cloud)) {
      throw new Error(
        `${entry} names cloud ${cloud}, not one of ${CLOUDS.join(', ')}`,
      );
    }
    if (regions.length === 0) throw new Error(`${entry} names no region`);
    if (seen.has(label)) throw new Error(`${label} is listed more than once`);
    seen.add(label);
    return {
      label,
      cloud,
      regions,
      kvm: label.includes('-kvm-'),
      gpu: label.includes('-gpu-'),
    };
  });
}
