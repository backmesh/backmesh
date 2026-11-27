// The Rust preinstall probe's figures (README.md): per cloud, each image's
// pull, the paired difference, Rust's first use, and queued to first step,
// measured on today's image and, for #160's, modelled as that plus the job's
// own pull difference. Markdown to stdout, every job's row to $OUT_FILE.
//
//   IN_DIR=<probe artifacts> OUT_FILE=… GITHUB_TOKEN=… GITHUB_REPOSITORY=… \
//   GITHUB_RUN_ID=… node benchmarks/rust-preinstall/report.ts
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { mannWhitney, median } from '../builds/results.ts';

interface Probe {
  cloud: string;
  index: number;
  order: string;
  today_ms: number;
  rust_ms: number;
  rust_first_use_ms: number;
  docker: string;
  marks: string;
}

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const dir = env('IN_DIR');
const probes: Probe[] = [];
for (const entry of await readdir(dir, { recursive: true })) {
  if (entry.endsWith('.json'))
    probes.push(JSON.parse(await readFile(join(dir, entry), 'utf8')));
}

// Each probe job's created_at to its Marker step's start, by its name.
const queuedToFirstStep = new Map<string, number>();
for (let page = 1; ; page++) {
  const res = await fetch(
    `https://api.github.com/repos/${env('GITHUB_REPOSITORY')}/actions/runs/${env('GITHUB_RUN_ID')}/jobs?per_page=100&page=${page}`,
    { headers: { authorization: `Bearer ${env('GITHUB_TOKEN')}` } },
  );
  if (!res.ok) throw new Error(`jobs: ${res.status} ${await res.text()}`);
  const { jobs } = (await res.json()) as {
    jobs: {
      name: string;
      created_at: string;
      steps?: { name: string; started_at: string | null }[];
    }[];
  };
  for (const job of jobs) {
    const marker = job.steps?.find((s) => s.name === 'Marker')?.started_at;
    if (marker)
      queuedToFirstStep.set(
        job.name,
        (Date.parse(marker) - Date.parse(job.created_at)) / 1000,
      );
  }
  if (jobs.length < 100) break;
}

// Nearest rank.
const p90 = (v: readonly number[]) =>
  [...v].sort((a, b) => a - b)[Math.ceil(0.9 * v.length) - 1] ?? null;
const s = (v: number | null) => (v === null ? '–' : `${v.toFixed(1)} s`);
const dist = (v: readonly number[]) => `${s(median(v))}, p90 ${s(p90(v))}`;

// Wilcoxon signed-rank test's two-sided p for paired differences: the normal
// approximation with tie and continuity corrections, zeros dropped.
function wilcoxon(d: readonly number[]) {
  const nz = d.filter((x) => x !== 0).sort((a, b) => Math.abs(a) - Math.abs(b));
  const n = nz.length;
  if (!n) return 1;
  let w = 0;
  let ties = 0;
  for (let i = 0; i < n;) {
    let j = i;
    while (j < n && Math.abs(nz[j]!) === Math.abs(nz[i]!)) j++;
    for (let k = i; k < j; k++) if (nz[k]! > 0) w += (i + j + 1) / 2;
    ties += (j - i) ** 3 - (j - i);
    i = j;
  }
  const sd = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24 - ties / 48);
  const z = Math.max(0, Math.abs(w - (n * (n + 1)) / 4) - 0.5) / sd;
  // The normal's upper tail (Abramowitz and Stegun 26.2.17).
  const t = 1 / (1 + 0.2316419 * z);
  const tail =
    0.3989423 *
    Math.exp((-z * z) / 2) *
    t *
    (0.3193815 +
      t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return Math.min(1, 2 * tail);
}
const p = (v: number) => (v < 0.001 ? v.toExponential(1) : v.toFixed(3));

// The runner's boot from its kernel's start to its container's first process:
// OS boot, Docker's install, the image's pull and start.
const boot = (marks: string) => {
  const at = Object.fromEntries(
    marks
      .split(';')
      .filter(Boolean)
      .map((line) => line.split(' ') as [string, string]),
  );
  return at.vm_booted && at.container_started
    ? (Number(at.container_started) - Number(at.vm_booted)) / 1e6
    : null;
};

const rows = probes.map((probe) => ({
  ...probe,
  queuedToFirstStep:
    queuedToFirstStep.get(`probe ${probe.cloud} ${probe.index}`) ?? null,
  boot: boot(probe.marks),
}));
await writeFile(env('OUT_FILE'), JSON.stringify(rows, null, 2) + '\n');

const out = [
  '| Figure | ' +
    [...new Set(rows.map((r) => r.cloud))].sort().join(' | ') +
    ' |',
];
const clouds = [...new Set(rows.map((r) => r.cloud))].sort();
out.push(`| --- | ${clouds.map(() => '---').join(' | ')} |`);
const line = (name: string, cell: (r: typeof rows) => string) =>
  out.push(
    `| ${name} | ${clouds.map((c) => cell(rows.filter((r) => r.cloud === c))).join(' | ')} |`,
  );
const sec = (r: typeof rows, f: (x: (typeof rows)[number]) => number | null) =>
  r.map(f).filter((x): x is number => x !== null);
line('Jobs', (r) => String(r.length));
line('Pull, today (v0.7.2)', (r) => dist(sec(r, (x) => x.today_ms / 1000)));
line('Pull, #160 (+Rust layer)', (r) => dist(sec(r, (x) => x.rust_ms / 1000)));
line('Pull difference, paired', (r) =>
  dist(sec(r, (x) => (x.rust_ms - x.today_ms) / 1000)),
);
line('Pull, Mann–Whitney p', (r) =>
  p(
    mannWhitney(
      sec(r, (x) => x.today_ms),
      sec(r, (x) => x.rust_ms),
    ),
  ),
);
line('Pull, Wilcoxon signed-rank p', (r) =>
  p(wilcoxon(sec(r, (x) => x.rust_ms - x.today_ms))),
);
line('Queued to first step, today (measured)', (r) =>
  dist(sec(r, (x) => x.queuedToFirstStep)),
);
const modelled = (x: (typeof rows)[number]) =>
  x.queuedToFirstStep === null
    ? null
    : x.queuedToFirstStep + (x.rust_ms - x.today_ms) / 1000;
line('Queued to first step, #160 (modelled)', (r) => dist(sec(r, modelled)));
line('Queued to first step, Mann–Whitney p', (r) =>
  p(
    mannWhitney(
      sec(r, (x) => x.queuedToFirstStep),
      sec(r, modelled),
    ),
  ),
);
line('Boot: kernel start to container start (today)', (r) =>
  dist(sec(r, (x) => x.boot)),
);
line("Rust's first use on today's image (`cargo --version`)", (r) =>
  dist(sec(r, (x) => x.rust_first_use_ms / 1000)),
);
line('Host Docker', (r) => [...new Set(r.map((x) => x.docker))].join(', '));
console.log(out.join('\n'));
