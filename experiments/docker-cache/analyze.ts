// The spike's A/B tables from a build benchmark results file with the
// `<label>/docker-<off|on|container>` arms (run.ts): for each build and cache
// state, the Build step's and queued to done's median, p90 (nearest rank)
// and range per arm, the exact two-sided Mann-Whitney p against `off`, and
// the cache arm's setup, bytes and objects written.
//
//   node experiments/docker-cache/analyze.ts <results file>
import { readFile } from 'node:fs/promises';

import type { Job, Results } from '../../benchmarks/builds/results.ts';

const r = JSON.parse(await readFile(process.argv[2]!, 'utf8')) as Results;
const STATES = ['cold', 'warm', 'changed'] as const;
const arms = Object.keys(r.labels);
const arm = (mode: string) => arms.find((a) => a.endsWith(`/docker-${mode}`));

const secs = (a: string | null | undefined, b: string | null | undefined) =>
  a && b ? (Date.parse(b) - Date.parse(a)) / 1000 : undefined;
const figures = (j: Job) => {
  const build = j.steps.find((s) => s.name === 'Build');
  return {
    build: secs(build?.startedAt, build?.completedAt),
    total: secs(j.createdAt, j.completedAt),
    setup: (() => {
      const s = j.steps.find((x) => x.name === 'Docker cache setup');
      return secs(s?.startedAt, s?.completedAt);
    })(),
  };
};
// Built: the job passed, or its Build step did, which left the image (the
// 2026-11-27 run's `on` arm failed only its Report step).
const ok = (j: Job) => j.conclusion === 'success' || !!j.docker?.imageBytes;
function jobs(
  a: string | undefined,
  state: (typeof STATES)[number],
  name: string,
) {
  if (!a) return [];
  return r.labels[a]!.flatMap((round) => {
    const j = round[state]?.jobs[name];
    return j && ok(j) ? [j] : [];
  });
}
const sorted = (v: number[]) => [...v].sort((x, y) => x - y);
const median = (v: number[]) => {
  const s = sorted(v);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const p90 = (v: number[]) => sorted(v)[Math.ceil(0.9 * v.length) - 1]!;
const show = (v: number[]) =>
  v.length
    ? `${median(v)} s (p90 ${p90(v)}, ${Math.min(...v)}–${Math.max(...v)})`
    : 'n/a';

// Exact two-sided Mann-Whitney p over every split of the pooled midranks.
function exactP(x: number[], y: number[]) {
  const all = sorted([...x, ...y]);
  const rank = (v: number) => {
    const first = all.indexOf(v);
    return first + (all.lastIndexOf(v) - first) / 2 + 1;
  };
  const ranks = all.map(rank);
  const observed = x.reduce((s, v) => s + rank(v), 0);
  const mean = (x.length * (all.length + 1)) / 2;
  let extreme = 0;
  let total = 0;
  const walk = (i: number, left: number, sum: number) => {
    if (!left) {
      total++;
      if (Math.abs(sum - mean) >= Math.abs(observed - mean) - 1e-9) extreme++;
      return;
    }
    for (let k = i; k <= ranks.length - left; k++)
      walk(k + 1, left - 1, sum + ranks[k]!);
  };
  walk(0, x.length, 0);
  return extreme / total;
}
const p = (x: number[], y: number[]) =>
  x.length && y.length ? exactP(x, y).toPrecision(2) : 'n/a';

const builds = [
  ...new Set(
    arms.flatMap((a) => r.labels[a]!.flatMap((x) => Object.keys(x.cold.jobs))),
  ),
];
for (const name of builds) {
  console.log(`\n## ${name}\n`);
  for (const k of ['build', 'total'] as const) {
    console.log(
      `\n| ${k === 'build' ? 'Build step' : 'Queued to done'} | off | cache | p vs off | cache, docker-container builder | p vs off |\n| --- | --- | --- | --- | --- | --- |`,
    );
    for (const state of STATES) {
      const v = (mode: string) =>
        jobs(arm(mode), state, name)
          .map((j) => figures(j)[k])
          .filter((x) => x !== undefined);
      // `off` has no cache, so its every run is a cold one.
      const off = v('off');
      console.log(
        `| ${state} | ${show(off)} | ${show(v('on'))} | ${p(v('on'), off)} | ${show(v('container'))} | ${p(v('container'), off)} |`,
      );
    }
  }
  const proxy = (j: Job) => (j.docker?.proxy ?? {}) as Record<string, number>;
  console.log('');
  for (const mode of ['on', 'container'])
    for (const state of STATES) {
      const js = jobs(arm(mode), state, name);
      const m = (f: (j: Job) => number) =>
        js.length ? median(js.map(f)) : 'n/a';
      const failed = (r.labels[arm(mode) ?? ''] ?? []).filter(
        (x) => !ok(x[state]!.jobs[name]!),
      ).length;
      console.log(
        `- ${mode}, ${state}: setup step ${m((j) => figures(j).setup ?? 0)} s (setup.sh ${m((j) => (j.docker?.setupMs ?? 0) / 1000)} s), written ${m((j) => Math.round(proxy(j).bytesWritten! / 1e6))} MB in ${m((j) => proxy(j).writes!)} objects, read ${m((j) => Math.round(proxy(j).bytesRead! / 1e6))} MB, hits ${m((j) => proxy(j).hits!)}, misses ${m((j) => proxy(j).misses!)}, token wait ${m((j) => proxy(j).tokenWaitMs! / 1000)} s, proxy errors ${js.reduce((s, j) => s + ((j.docker?.proxy?.errors as unknown[] | undefined)?.length ?? 0), 0)}, failed jobs ${failed}`,
      );
    }
}
