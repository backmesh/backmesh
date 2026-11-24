// Writes README.md's results, between its markers: the latest file in
// results/'s tables and runs, each file in results/experiments/'s, and a trend
// over results/. An experiment (run.ts's EXPERIMENT) isn't a release's
// figures, so neither the trend nor the site reads it.
//
//   node benchmarks/builds/report.ts
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { format } from 'prettier';

import {
  AWS_DISK_PER_HOUR,
  AWS_ON_DEMAND_XLARGE,
  AWS_SPOT_XLARGE,
  GITHUB_4_CORE_PER_MIN,
} from '../../website/src/cost.ts';
import {
  figures,
  mannWhitney,
  median,
  SEGMENTS,
  type Job,
  type Results,
  type Run,
} from './results.ts';

const here = new URL('.', import.meta.url).pathname;
const START = '<!-- results:start -->';
const END = '<!-- results:end -->';
const ARMS = ['cold', 'warm'] as const;

async function load(dir: string) {
  const files = (await readdir(join(here, dir)))
    .filter((f) => f.endsWith('.json'))
    .sort();
  return Promise.all(
    files.map(async (f) => ({
      name: f.slice(0, -5),
      r: JSON.parse(await readFile(join(here, dir, f), 'utf8')) as Results,
    })),
  );
}
const all = (await load('results')).map((f) => f.r);
const experiments = await load('results/experiments');
const latest = all.at(-1);
if (!latest) throw new Error('no results');

// Whole seconds: GitHub's times and the kernel's start are no finer.
const s = (v: number | null) => (v === null ? 'n/a' : `${Math.round(v)} s`);
const row = (cells: string[]) => `| ${cells.join(' | ')} |`;
const head = (cells: string[]) =>
  [row(cells), row(cells.map(() => '---'))].join('\n');

// Every succeeded job's figures in one arm of a label, optionally one build's.
function jobs(r: Results, label: string, arm: 'cold' | 'warm', build?: string) {
  return r.labels[label]!.flatMap((round) =>
    Object.entries((round[arm] as Run).jobs)
      .filter(([name]) => !build || name === build)
      .map(([, job]) => ({ job, f: figures(job) })),
  ).filter((j) => j.f !== null);
}
const med = (
  fs: ReturnType<typeof jobs>,
  pick: (f: NonNullable<ReturnType<typeof figures>>) => number | undefined,
) => median(fs.map((j) => pick(j.f!)).filter((v) => v !== undefined));

// Each label's speed against ubuntu-latest's, and a build's cost. A backmesh
// job costs its VM's spot price (cost.ts's `backmesh-4` price for the VM's
// family, times its vCPUs over 4; its on-demand price on a `-od-` label) from
// the kernel's start to the job's end,
// with its disk, each for at least a minute as AWS bills them; ubuntu-latest's,
// what a private repository pays for GitHub's 4-vCPU runner: its per-minute
// price, each job rounded up to a whole minute.
// A `<label>/cache` arm (bench-cache.yml) compares with ubuntu-latest's.
const BASE = 'ubuntu-latest';
const baseOf = (l: string) => (l.endsWith('/cache') ? `${BASE}/cache` : BASE);
// An experiment without its own ubuntu-latest compares with the one in the
// release file it ran alongside: the same date and backmesh version.
const withBase = (r: Results): Results => {
  const base = all.find((a) => a.date === r.date && a.backmesh === r.backmesh)
    ?.labels[BASE];
  return r.labels[BASE] || !base
    ? r
    : { ...r, labels: { ...r.labels, [BASE]: base } };
};
function cost(label: string, job: Job) {
  const end = Date.parse(job.completedAt!);
  if (label.startsWith(BASE))
    return (
      Math.ceil((end - Date.parse(job.startedAt)) / 60_000) *
      GITHUB_4_CORE_PER_MIN
    );
  const prices = label.includes('-od-')
    ? AWS_ON_DEMAND_XLARGE
    : AWS_SPOT_XLARGE;
  const price = prices[job.vm?.split('.')[0] ?? ''];
  const booted = job.marks.vm_booted;
  if (!price || !job.nproc || !booted) return undefined;
  const hours = Math.max(60_000, end - booted / 1000) / 3_600_000;
  return ((price * job.nproc) / 4 + AWS_DISK_PER_HOUR) * hours;
}
const usd = (v: number | null) => (v === null ? 'n/a' : `$${v.toFixed(4)}`);
const times = (v: number | null, base: number | null, p?: number) =>
  v && base
    ? `${s(v)}, ${(base / v).toFixed(1)}×${p === undefined ? '' : ` (p ${p < 0.001 ? '<0.001' : p.toFixed(3)})`}`
    : s(v);

// One results file's tables, VMs, cache hits and runs.
function report(r: Results) {
  const labels = Object.keys(r.labels);
  const columns = labels.flatMap((l) => ARMS.map((arm) => [l, arm] as const));
  const builds = [
    ...new Set(
      labels.flatMap((l) =>
        r.labels[l]!.flatMap((round) => Object.keys(round.cold.jobs)),
      ),
    ),
  ].sort();
  const rounds = Math.min(...labels.map((l) => r.labels[l]!.length));

  const timeTable = [
    head(['Build', ...columns.map(([l, arm]) => `${l}, ${arm}`)]),
    ...builds.map((b) =>
      row([
        b,
        ...columns.map(([l, arm]) => {
          const fs = jobs(r, l, arm, b);
          return `${s(med(fs, (f) => f.total))} (${s(med(fs, (f) => f.wait))} + ${s(med(fs, (f) => f.build))})`;
        }),
      ]),
    ),
  ].join('\n');

  const costTable = labels.every((l) => labels.includes(baseOf(l)))
    ? [
        head([
          'Build',
          'Label',
          ...ARMS.map((arm) => `First step to done, ${arm}`),
          ...ARMS.map((arm) => `Queued to done, ${arm}`),
          'Cost a build',
          'Price against ubuntu-latest',
        ]),
        ...builds.flatMap((b) => {
          const costs = (l: string) =>
            median(
              ARMS.flatMap((arm) => jobs(r, l, arm, b))
                .map((j) => cost(l, j.job))
                .filter((v) => v !== undefined),
            );
          return labels.map((l) => {
            const pair = (arm: 'cold' | 'warm', k: 'build' | 'total') => {
              const [v, base] = [l, baseOf(l)].map((x) =>
                jobs(r, x, arm, b).map((j) => j.f![k]),
              ) as [number[], number[]];
              return times(
                median(v),
                median(base),
                l === baseOf(l) || !v.length || !base.length
                  ? undefined
                  : mannWhitney(v, base),
              );
            };
            const c = costs(l);
            const base = costs(baseOf(l));
            return row([
              b,
              l,
              ...ARMS.map((arm) => pair(arm, 'build')),
              ...ARMS.map((arm) => pair(arm, 'total')),
              usd(c),
              c && base ? `1/${(base / c).toFixed(1)}` : 'n/a',
            ]);
          });
        }),
      ].join('\n')
    : '';

  const startTable = [
    head(['Piece', ...columns.map(([l, arm]) => `${l}, ${arm}`)]),
    ...SEGMENTS.map(([key, name]) =>
      row([
        name,
        ...columns.map(([l, arm]) =>
          s(med(jobs(r, l, arm), (f) => f.segments[key])),
        ),
      ]),
    ),
    row([
      '**Queued to first step**',
      ...columns.map(
        ([l, arm]) => `**${s(med(jobs(r, l, arm), (f) => f.wait))}**`,
      ),
    ]),
  ].join('\n');

  // Per label, the machines its jobs ran on: on AWS by type and region, and
  // by CPU and vCPUs where the results have them.
  const vms = labels
    .map((l) => {
      const count = new Map<string, number>();
      for (const { job } of ARMS.flatMap((arm) => jobs(r, l, arm))) {
        const at = [
          job.vm && `${job.vm} in ${job.region}`,
          job.cpu && `${job.cpu}, ${job.nproc} vCPUs`,
        ]
          .filter(Boolean)
          .join(', ');
        if (at) count.set(at, (count.get(at) ?? 0) + 1);
      }
      const list = [...count].map(([at, n]) => `${at} (${n})`).join(', ');
      return list && `\`${l}\` ran on ${list}.`;
    })
    .filter(Boolean);

  // Per cache arm, how many of each build's warm jobs hit their cache, and the
  // Docker build's median CACHED steps, cold and warm.
  const hits = labels
    .filter((l) => l.endsWith('/cache'))
    .map((l) => {
      const counts = builds.map((b) => {
        const warm = jobs(r, l, 'warm', b);
        if (b === 'docker') {
          const steps = (arm: 'cold' | 'warm') =>
            median(jobs(r, l, arm, b).map((j) => j.job.dockerCached ?? 0));
          return `docker's build ${steps('cold')} CACHED steps cold and ${steps('warm')} warm`;
        }
        const hit = warm.filter((j) => j.job.hits?.[b] === 'true');
        return `${b} ${hit.length} of ${warm.length}`;
      });
      return `Warm jobs on \`${l}\` whose cache hit: ${counts.join(', ')}.`;
    });

  // Per label, how many of each build's warm jobs restored an automatic cache.
  const restored = labels
    .filter((l) => jobs(r, l, 'warm').some((j) => j.job.cache.length))
    .map((l) => {
      const counts = builds.map((b) => {
        const warm = jobs(r, l, 'warm', b);
        const hit = warm.filter((j) =>
          j.job.cache.some((c) =>
            c.startsWith('backmesh cache: auto restored'),
          ),
        );
        return `${b} ${hit.length} of ${warm.length}`;
      });
      return `Warm jobs on \`${l}\` that restored an automatic cache: ${counts.join(', ')}.`;
    });

  const runs = labels
    .map(
      (l) =>
        `- \`${l}\`: ${r.labels[l]!.map((round) => `[cold](${round.cold.url}) and [warm](${round.warm.url})`).join(', ')}`,
    )
    .join('\n');

  return `backmesh ${r.backmesh} on anycloud ${r.anycloud}, ${r.installation};
${rounds} rounds on each label in [${r.repo}](https://github.com/${r.repo}),
from bench.yml at ${r.commit.slice(0, 7)}. Medians, in seconds.

**Queued to done** (queued to first step + first step to done):

${timeTable}

${
  costTable &&
  `**Speed and cost a build.** Each label's medians, and their speed against
${BASE}'s (its time over the label's), a \`/cache\` arm's against
\`${BASE}/cache\`'s, with a two-sided Mann-Whitney p. A backmesh job's cost is
its VM's spot price (on-demand on a \`-od-\` label) from the kernel's start to
the job's end, at [\`cost.ts\`](../../website/src/cost.ts)'s \`backmesh-4\`
price for the VM's family times its vCPUs over 4, plus its disk's $${AWS_DISK_PER_HOUR} an hour,
for at least a minute, as AWS bills both. ${BASE}'s is what GitHub charges for
its 4-vCPU runner, $${GITHUB_4_CORE_PER_MIN} a minute, each job rounded up to
a whole minute: a private repository pays it for a 4-core larger runner, while
a public one's \`${BASE}\`, as here, has 4 vCPUs and is free. A private
repository's \`${BASE}\` has 2 vCPUs at about $0.006 to $0.008 a minute,
which these runs don't measure. Costs are medians over the cold and warm jobs.

${costTable}

`
}**Queued to the first step, by piece.** Each piece's median, over every
build's jobs; the pieces' medians needn't add up to the total's.

${startTable}

${[...vms, ...restored, ...hits].join(' ')}

The runs, a cold and a warm one a round:

${runs}`;
}

const trend = [
  head([
    'Date',
    'backmesh',
    'anycloud',
    'Label',
    'Jobs',
    'Wait, cold',
    'Wait, warm',
    'Total, cold',
    'Total, warm',
  ]),
  ...all.flatMap((r) =>
    Object.keys(r.labels).map((l) =>
      row([
        r.date,
        r.backmesh,
        r.anycloud,
        l,
        String(jobs(r, l, 'cold').length + jobs(r, l, 'warm').length),
        ...(['wait', 'total'] as const).flatMap((k) =>
          ARMS.map((arm) => s(med(jobs(r, l, arm), (f) => f[k]))),
        ),
      ]),
    ),
  ),
].join('\n');

const section = `${START}

Generated by [\`report.ts\`](report.ts) from [\`results/\`](results/); don't edit by hand.

### Latest: ${latest.date}, backmesh ${latest.backmesh}

${report(latest)}

${experiments
  .map(
    ({ name, r }) => `### Experiment: \`experiments/${name}.json\`

${r.labels[BASE] ? '' : `Its \`${BASE}\` is the release file's, run alongside it.\n\n`}${report(withBase(r))}

`,
  )
  .join('')}### By version

Medians over every build's jobs, so they mix the builds: compare a label
across versions only while bench.yml's builds are the same.

${trend}

${END}`;

const readme = join(here, 'README.md');
const text = await readFile(readme, 'utf8');
const [before, rest] = text.split(START);
const after = rest?.split(END)[1];
if (before === undefined || after === undefined)
  throw new Error(`README.md lacks ${START} … ${END}`);
await writeFile(
  readme,
  await format(before + section + after, { filepath: readme }),
);
