// e2e.yml's label job, assertion 1: the cloud and region this VM's instance
// metadata reports must match what the label promises.
//
//   EXPECTED_CLOUD=aws EXPECTED_REGIONS=us-east-2,us-east-1,us-west-2 \
//     node test/e2e/check-cloud-region.ts
import { detectCloudRegion, type MetadataFetch } from './cloud-metadata.ts';

function fail(message: string): never {
  console.error(`::error::${message}`);
  process.exit(1);
}

const expectedCloud = process.env.EXPECTED_CLOUD;
const expectedRegions = (process.env.EXPECTED_REGIONS ?? '')
  .split(',')
  .filter(Boolean);
if (!expectedCloud || expectedRegions.length === 0) {
  throw new Error('EXPECTED_CLOUD and EXPECTED_REGIONS are required');
}

const TIMEOUT_MS = 2000;
const fetchImpl: MetadataFetch = (url, init) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });

const { cloud, region } = await detectCloudRegion(fetchImpl);
console.log(`Instance metadata says ${cloud} ${region}`);
if (cloud !== expectedCloud) {
  fail(
    `the label promises ${expectedCloud}, but this VM's metadata says ${cloud}`,
  );
}
if (!expectedRegions.includes(region)) {
  fail(
    `the label promises one of ${expectedRegions.join(', ')}, but this VM is in ${region}`,
  );
}
