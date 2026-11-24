// Fails when the GPU page, the GPU posts or docs/cost.md's GPU table differ
// from src/cost.ts's GPU figures, or when one of those pages' FAQ structured
// data differs from its visible FAQ. Node strips cost.ts's types.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  AWS_DISK_PER_HOUR,
  AWS_GPU_BOOT_S,
  AWS_GPU_WAIT_S,
  GITHUB_T4_PER_MIN,
  GPU_PRICES,
  per1000,
} from '../src/cost.ts';

const doc = (path) =>
  readFileSync(new URL(`../src/content/docs/${path}`, import.meta.url), 'utf8');
const usd = (v) => `$${v.toFixed(2)}`;
const perMin = (hourly) => `$${(hourly / 60).toFixed(4)}`;
const contains = (path, figures) => {
  const md = doc(path).replace(/\s+/g, ' ');
  for (const f of figures) assert(md.includes(f), `${path} lacks ${f}`);
};
// A Markdown table's rows, as trimmed cells.
const rows = (md) =>
  md
    .split('\n')
    .filter((l) => l.startsWith('|'))
    .map((l) =>
      l
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim()),
    );
const firsts = GPU_PRICES.filter((p) => !p.fallback);
const [aws, azure] = firsts;

// gpu.md's table: each type spot and on demand, against GitHub's.
const page = new Map(rows(doc('gpu.md')).map((r) => [r[0], r]));
const github = 'GitHub `linux_4_core_gpu`';
assert.deepEqual(page.get(github), [
  github,
  (GITHUB_T4_PER_MIN * 60).toFixed(2),
  String(GITHUB_T4_PER_MIN),
  '1×',
]);
for (const { cloud, type, spot, onDemand, fallback } of GPU_PRICES) {
  for (const [kind, hourly] of [
    ['spot', spot],
    ['on demand', onDemand],
  ]) {
    const name = `${cloud} \`${type}\`, ${kind}${fallback ? ' (fallback)' : ''}`;
    assert.deepEqual(page.get(name), [
      name,
      String(hourly),
      perMin(hourly).slice(1),
      `${((GITHUB_T4_PER_MIN * 60) / hourly).toFixed(1)}×`,
    ]);
  }
}

// cost.md's and the pricing post's tables: spot, on demand and a minute each.
const priced = (path, matches) => {
  const table = rows(doc(path));
  for (const p of GPU_PRICES.filter((p) => matches(p))) {
    const row = table.find((r) => r.some((c) => c.includes(`\`${p.type}\``)));
    assert(row, `${path} has no row for ${p.type}`);
    assert.deepEqual(row.slice(-4), [
      String(p.spot),
      String(p.onDemand),
      perMin(p.spot),
      perMin(p.onDemand),
    ]);
  }
};
priced('cost.md', () => true);
priced('blog/github-actions-gpu-pricing.md', (p) => !p.fallback);

// The prices and the wait in prose.
const githubHourly = (GITHUB_T4_PER_MIN * 60).toFixed(2);
const wait = `${AWS_GPU_WAIT_S} seconds`;
const waitRounded = `about ${Math.floor(AWS_GPU_WAIT_S / 60)} minutes ${Math.floor(AWS_GPU_WAIT_S % 60)} seconds`;
const [fallback] = GPU_PRICES.filter((p) => p.fallback);
contains('cost.md', [`$${GITHUB_T4_PER_MIN} a minute`]);
contains('gpu.md', [
  `$${GITHUB_T4_PER_MIN} a minute, $${githubHourly} an hour`,
  `$${aws.spot} an hour on AWS spot`,
  `$${azure.spot} on Azure spot`,
  `$${aws.onDemand} on demand on either`,
  wait,
  waitRounded,
]);
const minuteRange = `$${(Math.min(...firsts.map((p) => p.spot)) / 60).toFixed(4)} to $${(Math.max(...firsts.map((p) => p.onDemand)) / 60).toFixed(4)} a minute`;
contains('blog/run-cuda-tests-github-actions.md', [
  `$${GITHUB_T4_PER_MIN} a minute`,
  minuteRange,
]);
contains('blog/t4-gpu-quota-aws-azure.md', [waitRounded]);

// The pricing post's month: 1,000 10-minute jobs.
const MINUTES = 10_000;
const jobHours = MINUTES / 60;
const bootHours = (1_000 * AWS_GPU_BOOT_S) / 3600;
const disk = (jobHours + bootHours) * AWS_DISK_PER_HOUR;
const awsSpot = (jobHours + bootHours) * aws.spot + disk;
const controlPlane = per1000.find((p) => p.cloud === 'AWS').controlPlane;
const saved = GITHUB_T4_PER_MIN - awsSpot / MINUTES;
const breakEven = Math.round(controlPlane / saved / 100) * 100;
contains('blog/github-actions-gpu-pricing.md', [
  `$${GITHUB_T4_PER_MIN} a minute, $${githubHourly} an hour`,
  `$${fallback.spot} spot and $${fallback.onDemand} on demand`,
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
]);

// Each page's FAQPage structured data: its visible FAQ, without Markdown.
const plain = (t) =>
  t.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replaceAll('`', '');
for (const path of [
  'gpu.md',
  'blog/github-actions-gpu-pricing.md',
  'blog/run-cuda-tests-github-actions.md',
  'blog/t4-gpu-quota-aws-azure.md',
]) {
  const md = doc(path);
  const visible = md
    .slice(md.indexOf('\n## FAQ\n') + 8)
    .trim()
    .split('\n\n')
    .map((p) => p.replaceAll('\n', ' ').match(/^\*\*(.+?)\*\* (.*)$/s))
    .map(([, q, a]) => [plain(q), plain(a)]);
  const line = md.split('\n').find((l) => l.includes('"FAQPage"'));
  const data = JSON.parse(
    line.slice(line.indexOf("'") + 1, -1).replaceAll("''", "'"),
  );
  const { mainEntity } = (data['@graph'] ?? [data]).find(
    (d) => d['@type'] === 'FAQPage',
  );
  assert.deepEqual(
    mainEntity.map((e) => [e.name, e.acceptedAnswer.text]),
    visible,
    `${path}: the FAQ's structured data differs from its visible FAQ`,
  );
}
console.log('Checked the GPU figures against cost.ts, and the GPU FAQs.');
