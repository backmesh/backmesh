// Feature detection: each anycloud feature backmesh checks for,
// mapped to the first anycloud version that has it, or undefined until its
// release names a version.
export const FEATURES = {
  // RFC 0049 release 1: C29, C3, C4, C15, C19, C27 and C30.
  'release-1': '0.1.72',
  // RFC 0049 C26 (e): `cluster create` through the user's cloud CLI, with
  // no Docker or local API, and a hosted API that keeps its own cluster
  // record and deletes itself.
  c26: '0.1.74',
  // RFC 0047: keyless role connections, `credentials new --role`.
  'role-connections': '0.1.74',
  // `credentials new --role --apply --json`: the role's cloud side made
  // through the user's own cloud CLI, with no prompt (owner,
  // 2026-11-08: in 0.1.74).
  'role-apply': '0.1.74',
  // `cluster delete` keeps the managed checkpoint bucket unless given
  // `--delete-buckets --confirm <id>`.
  c28: '0.1.74',
  // A VM Job's `cloudConfig.regions`, an allow-list the optimizer
  // places and fails over within (anycloud 0.1.74; owner, 2026-11-09: in
  // rc.5).
  'vm-job-regions': '0.1.74',
  // Owner-issued service tokens, `api access add|remove --service` and
  // `api token rotate --service` (anycloud phase 2a): each org's listener
  // VM authenticates with one. Its release names the version.
  'service-tokens': undefined,
} satisfies Record<string, string | undefined>;

export type Feature = keyof typeof FEATURES;
export type FeatureTable = Record<Feature, string | undefined>;

const parts = (version: string) => version.split('.').map(Number);

/** Whether version `a` is later than `b`. */
export const newer = (a: string, b: string) => {
  const [x, y] = [parts(a), parts(b)];
  const i = x.findIndex((part, j) => part !== y[j]);
  return i >= 0 && x[i]! > (y[i] ?? 0);
};

function atLeast(version: string, first: string): boolean {
  const [a, b] = [parts(version), parts(first)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return true;
}

export function missingFeatures(
  version: string,
  wanted: readonly Feature[],
  table: FeatureTable = FEATURES,
): Feature[] {
  return wanted.filter((feature) => {
    const first = table[feature];
    return first === undefined || !atLeast(version, first);
  });
}
