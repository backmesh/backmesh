// The newest build benchmark results' figures, read at build time: the newest
// release file and the on-demand experiment that ran alongside it.
import { type Results } from '../../benchmarks/builds/results.ts';
import { newest, published } from './benchmarks.ts';

const glob = (files: Record<string, Results>) =>
  Object.entries(files).map(([path, r]) => ({
    name: path.split('/').at(-1)!.slice(0, -5),
    r,
  }));
export const bench = published(
  ...newest(
    glob(
      import.meta.glob<Results>('../../benchmarks/builds/results/*.json', {
        eager: true,
        import: 'default',
      }),
    ),
    glob(
      import.meta.glob<Results>(
        '../../benchmarks/builds/results/experiments/*-od.json',
        { eager: true, import: 'default' },
      ),
    ),
  ),
);
