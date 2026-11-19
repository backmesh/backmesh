// e2e.yml's `test-org` sweeps: the names an installation's AWS and Azure
// sides go by, from its cluster ID (`clusterIdOf`), so a sweep finds only
// this run's installation in an account others share. anycloud's seed stack
// and owner tag (`seedStackName`, `hostedApiIdentity` at v0.1.78), backmesh's
// generated IAM user and Azure app
// (`generatedIdentity(connectionName(cloud, id))`) and the org's cache
// buckets (`bucketName(installTag(id, orgId), region)`).
//
//   CLUSTER_ID=<id> ORG_ID=<the org's numeric ID> \
//     node test/e2e/sweep-names.ts  # prints KEY=value lines
import { createHash } from 'node:crypto';

const sha256 = (...parts: string[]) => {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
};

const base36 = (digest: Buffer, length: number) =>
  (digest.readUInt32BE(0) % 36 ** length).toString(36).padStart(length, '0');

export function sweepNames(clusterId: string, orgId: number) {
  const connection = (cloud: string) =>
    `anycloud-bm-${cloud}-${base36(sha256(clusterId), 6)}`;
  return {
    STACK: `anycloud-${clusterId}`,
    OWNER_API: sha256('anycloud-hosted-api\0', clusterId)
      .toString('hex')
      .slice(0, 32),
    IAM_USER: connection('aws'),
    AZURE_APP: connection('azure'),
    CACHE_PREFIX: `bm-cache-${base36(sha256(`${clusterId}/${orgId}`), 5)}-`,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { CLUSTER_ID: id, ORG_ID: org } = process.env;
  if (!id || !/^[a-z0-9-]+$/.test(id) || !org || !/^\d+$/.test(org)) {
    throw new Error('CLUSTER_ID and ORG_ID are required');
  }
  for (const [key, value] of Object.entries(sweepNames(id, Number(org)))) {
    console.log(`${key}=${value}`);
  }
}
