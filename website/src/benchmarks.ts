// The build benchmark's published figures, computed from the newest release's
// results file in benchmarks/builds/results/ and its on-demand experiment, so
// no page states its own: the site reads them at build time (bench.ts), and
// benchmarks/builds/report.ts writes the repository README's headline.
import {
  BASE,
  byName,
  cost,
  jobs,
  med,
  median,
  withBase,
  type Results,
} from '../../benchmarks/builds/results.ts';

// What each of bench.yml's jobs builds.
const BUILDS: Record<string, [workload: string, project: string]> = {
  docker: ['Docker build', 'grafana/k6 v0.54.0 image'],
  go: ['Go', 'cli/cli v2.62.0, go build and tests'],
  python: ['Python', 'pydantic v2.11.7, uv sync and tests'],
  rust: ['Rust', 'ripgrep 14.1.1, cargo build --release'],
  typescript: ['TypeScript', 'TypeScript v5.6.3, npm ci and hereby local'],
};
export const SPOT = 'backmesh-ubuntu-2404-4vcpu';
export const ON_DEMAND = 'backmesh-ubuntu-2404-od-4vcpu';
// Results files from before v0.7.0 record the labels' old names.
const OLD: Record<string, string> = {
  'backmesh-4': SPOT,
  'backmesh-od-4': ON_DEMAND,
};
const renamed = (r: Results): Results => ({
  ...r,
  labels: Object.fromEntries(
    Object.entries(r.labels).map(([l, rounds]) => [OLD[l] ?? l, rounds]),
  ),
});
export const GITHUB = BASE;

// One label's figures for one build: its time is the cold jobs' first step to
// done, its wait their queueing to first step, and its cost the median over
// its cold and warm jobs (results.ts's `cost`), as the build benchmark's
// README gives them.
function figuresOf(r: Results, label: string, build: string) {
  const cold = jobs(r, label, 'cold', build);
  return {
    secs: med(cold, (f) => f.build)!,
    wait: med(cold, (f) => f.wait)!,
    jobs: cold.length,
    cost: median(
      [...cold, ...jobs(r, label, 'warm', build)]
        .map((j) => cost(label, j.job))
        .filter((v) => v !== undefined),
    )!,
  };
}

// Each build on spot `backmesh-ubuntu-2404-4vcpu` (the release file) and
// on-demand `backmesh-ubuntu-2404-od-4vcpu` (its experiment, which ran alongside it) against
// ubuntu-latest, all 4 vCPUs.
export function published(recorded: Results, recordedOd: Results) {
  const release = renamed(recorded);
  const onDemand = renamed(recordedOd);
  const od = withBase(onDemand, [release]);
  const rows = Object.keys(release.labels[SPOT]![0]!.cold.jobs)
    .sort()
    .map((id) => {
      const github = figuresOf(release, GITHUB, id);
      const vs = (r: Results, label: string) => {
        const f = figuresOf(r, label, id);
        return {
          ...f,
          faster: github.secs / f.secs,
          cheaper: github.cost / f.cost,
        };
      };
      const [workload, project] = BUILDS[id] ?? [id, id];
      return {
        id,
        workload,
        project,
        github,
        spot: vs(release, SPOT),
        od: vs(od, ON_DEMAND),
      };
    });
  const range = (v: number[]) => [Math.min(...v), Math.max(...v)] as const;
  // The fastest builds, on whichever label ran its build fastest.
  const fastest = rows
    .flatMap((b) => [
      { id: b.id, label: SPOT, ...b.spot },
      { id: b.id, label: ON_DEMAND, ...b.od },
    ])
    .sort((a, b) => b.faster - a.faster);
  const top = fastest.filter((b) => b.label === fastest[0]!.label).slice(0, 2);
  const spotCheaper = range(rows.map((b) => b.spot.cheaper));
  return {
    date: release.date,
    version: release.backmesh,
    rounds: release.labels[SPOT]!.length,
    odRounds: onDemand.labels[ON_DEMAND]!.length,
    // The median wait over every build's cold jobs on spot.
    wait: med(jobs(release, SPOT, 'cold'), (f) => f.wait)!,
    rows,
    top,
    spotCheaper,
    odCheaper: range(rows.map((b) => b.od.cheaper)),
    // The VM families each label's jobs landed on, and how many jobs each.
    spotFamilies: families(release, SPOT),
    odFamilies: families(od, ON_DEMAND),
    runs: [
      [SPOT, release],
      [ON_DEMAND, onDemand],
      [GITHUB, release],
    ].map(([l, r]) => ({
      label: l as string,
      urls: (r as Results).labels[l as string]!.map((round) => round.cold.url),
    })),
    // Such as "Up to 2× faster builds, up to 10× cheaper": the largest
    // ratios, each rounded down to one significant figure.
    headline:
      round(fastest[0]!.faster) > 1
        ? `Up to ${round(fastest[0]!.faster)}× faster builds, up to ${round(spotCheaper[1])}× cheaper`
        : `Up to ${round(spotCheaper[1])}× cheaper builds`,
    spotFastest: Math.max(...rows.map((b) => b.spot.faster)),
  };
}
export type Published = ReturnType<typeof published>;

// The newest release file, by name (`<date>-<version>`, without `.json`), and
// the on-demand experiment (`<date>-<version>-od`) that ran alongside it.
type File = { name: string; r: Results };
export function newest(
  releases: File[],
  experiments: File[],
): [Results, Results] {
  const release = [...releases].sort((a, b) => byName(a.name, b.name)).at(-1)!;
  const od = experiments.find((e) => e.name === `${release.name}-od`);
  if (!od) throw new Error(`no on-demand experiment for ${release.name}`);
  return [release.r, od.r];
}

function families(r: Results, label: string) {
  const count = new Map<string, number>();
  for (const arm of ['cold', 'warm'] as const)
    for (const { job } of jobs(r, label, arm)) {
      const family = job.vm?.split('.')[0];
      if (family) count.set(family, (count.get(family) ?? 0) + 1);
    }
  return [...count].sort((a, b) => b[1] - a[1]);
}

// Rounds a ratio down: to a half under 10, such as 1.9 to 1.5, and to one
// significant figure from 10, such as 11.8 to 10, so it never overstates.
const round = (v: number) => {
  if (v < 10) return Math.floor(v * 2) / 2;
  const unit = 10 ** Math.floor(Math.log10(v));
  return Math.floor(v / unit) * unit;
};

// The headline's conditions, a short line under it on the landing page, in
// the README and /llms.txt; `link` makes the benchmarks page's link. The
// wait is rounded to 10 s.
export const brief = (
  p: Published,
  link = (text: string) => `[${text}](https://backmesh.com/benchmarks/)`,
) =>
  `Build steps vs GitHub's 4-core runner, same vCPU count. Jobs still wait ~${Math.round(p.wait / 10) * 10}\u00a0s for a VM. ${link('How we measured →')}`;

// The conditions in full, a sentence each, for the benchmarks page's method;
// `code` marks a label or VM type up.
export const conditions = (p: Published, code = (c: string) => `\`${c}\``) => [
  `We time builds' own steps, first step to done, on AWS VMs with the 4 vCPUs of GitHub's 4-core runner; an ${code('m8a')} VM's vCPUs are full cores.`,
  `On ${p.top[0]!.label === ON_DEMAND ? `an on-demand ${code(ON_DEMAND)} (${p.odFamilies.map(([f]) => code(f)).join(', ')})` : `a spot ${code(SPOT)}`}, ${p.top.map((b, i) => `${b.id}'s build ran ${times(b.faster)}${i ? '' : ' faster'} (${b.jobs} jobs)`).join(' and ')}.`,
  `Each job still waits a median ${seconds(p.wait)} for its VM.`,
  `Spot ${code(SPOT)} builds cost ${ratios(p.spotCheaper)} less than on GitHub's 4-core runner, on-demand ones ${ratios(p.odCheaper)}; backmesh's always-on VMs are extra.`,
  ...(p.top[0]!.label === SPOT
    ? []
    : [
        `No one label gets both: the speed is on demand's and the price spot's, whose fastest build ran ${times(p.spotFastest)} faster, while on demand's cheapest cost ${times(p.odCheaper[1])} less.`,
      ]),
];

// The repository README's headline, which report.ts writes between README.md's
// bench markers.
export const README_BENCH = /<!-- bench:start -->(.*?)<!-- bench:end -->/s;
export const readme = (p: Published) =>
  `**${p.headline}**, in our build benchmarks on ${p.date}, backmesh ${p.version}. ${brief(p)}`;

// A cued job's median queued to first real step, in the cue benchmark's
// 2026-11-23 run against GitHub-hosted (benchmarks/cue/README.md).
export const CUED_WAIT = 13.25;

export const seconds = (v: number) => `${Math.round(v)} s`;
export const dollars = (v: number) => `$${v.toPrecision(2)}`;
// A ratio, such as "1.4× faster" or "1.5× slower".
export const speed = (faster: number) =>
  Math.max(faster, 1 / faster) < 1.1
    ? 'as fast'
    : faster < 1
      ? `${times(1 / faster)} slower`
      : `${times(faster)} faster`;
// A ratio as "1.4×", to one decimal, as the build benchmark's README gives it.
export const times = (v: number) => `${v.toFixed(1)}×`;
// A range of ratios, such as "7.0–11.8×".
const ratios = ([low, high]: readonly [number, number]) =>
  `${low.toFixed(1)}–${times(high)}`;
