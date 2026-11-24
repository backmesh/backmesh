// Fails when the GPU page's price table or the GPU pricing post's worked
// month differs from what src/cost.ts gives. Node strips cost.ts's types.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  AWS_DISK_PER_HOUR,
  AWS_GPU_BOOT_S,
  GITHUB_T4_PER_MIN,
  GPU_PRICES,
  per1000,
} from '../src/cost.ts';

const doc = (path) =>
  readFileSync(new URL(`../src/content/docs/${path}`, import.meta.url), 'utf8');
const usd = (v) => `$${v.toFixed(2)}`;

// The page's table: each row's trimmed cells, by its first.
const table = new Map(
  doc('gpu.md')
    .split('\n')
    .filter((l) => l.startsWith('|'))
    .map((l) => {
      const cells = l
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim());
      return [cells[0], cells];
    }),
);
const github = 'GitHub `linux_4_core_gpu`';
assert.deepEqual(table.get(github), [
  github,
  (GITHUB_T4_PER_MIN * 60).toFixed(2),
  String(GITHUB_T4_PER_MIN),
  '1×',
]);
for (const { cloud, type, spot, onDemand } of GPU_PRICES) {
  for (const [kind, hourly] of [
    ['spot', spot],
    ['on demand', onDemand],
  ]) {
    const fallback = type === 'g4dn.2xlarge' ? ' (fallback)' : '';
    const name = `${cloud} \`${type}\`, ${kind}${fallback}`;
    assert.deepEqual(table.get(name), [
      name,
      String(hourly),
      (hourly / 60).toFixed(4),
      `${((GITHUB_T4_PER_MIN * 60) / hourly).toFixed(1)}×`,
    ]);
  }
}

// The post's month: 1,000 10-minute jobs.
const post = doc('blog/github-actions-gpu-pricing.md');
const [aws, , azure] = GPU_PRICES;
const MINUTES = 10_000;
const jobHours = MINUTES / 60;
const bootHours = (1_000 * AWS_GPU_BOOT_S) / 3600;
const disk = (jobHours + bootHours) * AWS_DISK_PER_HOUR;
const awsSpot = (jobHours + bootHours) * aws.spot + disk;
const controlPlane = per1000.find((p) => p.cloud === 'AWS').controlPlane;
const saved = GITHUB_T4_PER_MIN - awsSpot / MINUTES;
const breakEven = Math.round(controlPlane / saved / 100) * 100;
for (const figure of [
  `$${Math.round(MINUTES * GITHUB_T4_PER_MIN)}`,
  usd(jobHours * aws.spot),
  usd(bootHours * aws.spot),
  usd(disk),
  usd(awsSpot),
  usd((jobHours + bootHours) * aws.onDemand + disk),
  usd(jobHours * azure.spot),
  usd(jobHours * azure.onDemand),
  `$${controlPlane}`,
  usd(awsSpot + controlPlane),
  `$${(awsSpot / MINUTES).toFixed(4)}`,
  `$${saved.toFixed(4)}`,
  `about ${breakEven.toLocaleString('en-US')} GPU minutes a month`,
]) {
  assert(post.includes(figure), `the GPU pricing post lacks ${figure}`);
}
console.log('Checked the GPU figures against cost.ts.');
