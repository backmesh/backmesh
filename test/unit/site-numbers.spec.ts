import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { format } from 'prettier';
import { describe, expect, it } from 'vitest';

import { byName } from '../../benchmarks/builds/results.ts';
import {
  newest,
  published,
  readme,
  README_BENCH,
} from '../../website/src/benchmarks.ts';
import { AWS_GPU_WAIT_S, per1000 } from '../../website/src/cost.ts';

const root = join(import.meta.dirname, '../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const dir = (path: string) =>
  readdirSync(join(root, path)).map((f) => join(path, f));
const results = (path: string) =>
  dir(path)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({
      name: f.split('/').at(-1)!.slice(0, -5),
      r: JSON.parse(read(f)),
    }));

// The site reads the newest results at build time (website/src/bench.ts);
// these check what it can't: the README, and figures written by hand.
describe('published benchmark figures', () => {
  it("README's headline and table are the newest results file's", async () => {
    const text = read('README.md');
    const p = published(
      ...newest(
        results('benchmarks/builds/results'),
        results('benchmarks/builds/results/experiments'),
      ),
    );
    expect(text).toBe(
      await format(text.replace(README_BENCH, readme(p)), {
        filepath: join(root, 'README.md'),
      }),
    );
  });

  it("cost.md's boot costs are cost.ts's", () => {
    const text = read('website/src/content/docs/cost.md').replace(/\s+/g, ' ');
    for (const p of per1000)
      expect(text).toContain(
        `$${p.bootLow.toFixed(2)}–$${p.bootHigh.toFixed(2)} on ${p.cloud}`,
      );
  });

  it('orders results by date, then version', () => {
    expect(
      ['2026-12-01-0.5.9.json', '2026-12-01-0.5.10.json'].sort(byName),
    ).toEqual(['2026-12-01-0.5.9.json', '2026-12-01-0.5.10.json']);
  });

  // Live pages, not blog posts: dated snapshots keep their figures.
  const pages = [
    'README.md',
    ...dir('website/src/content/docs').filter((f) => /\.mdx?$/.test(f)),
    ...dir('website/src/pages'),
    ...dir('website/src/components'),
  ];
  it.each(pages)('%s hard-codes no speed figure', (page) => {
    const text = read(page)
      .replace(README_BENCH, '')
      .replace(/\s+/g, ' ')
      .split(/(?<=[.!?])\s/);
    // A time with a word for a start, boot or wait, or a speed ratio.
    const time = /\b\d+(?:(?:–| to )\d+)? ?(?:s|seconds?)\b/;
    const about = /boot|start|wait|queu|cold|faster|slower|cued/i;
    // cost.ts's GPU wait, which website/scripts/check-gpu.mjs checks.
    const gpuWait = `${AWS_GPU_WAIT_S} seconds`;
    expect(
      text.filter(
        (s) =>
          !s.includes(gpuWait) &&
          ((time.test(s) && about.test(s)) || /\d× (?:faster|slower)/.test(s)),
      ),
    ).toEqual([
      ...(page === 'website/src/content/docs/security.md'
        ? [
            // Not benchmark figures: a cue's runner's idle limit and the
            // CLI's timeout.
            expect.stringContaining('removed after 180 seconds idle'),
            expect.stringContaining('gives up within 3 seconds'),
          ]
        : []),
    ]);
  });
});
