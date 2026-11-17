#!/usr/bin/env node
// Renders one cut: node render.mjs <hyperframes|brag> [output.mp4]

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const [cut, output = join(root, 'renders', `${cut}.mp4`)] =
  process.argv.slice(2);
if (cut !== 'hyperframes' && cut !== 'brag') {
  throw new Error('usage: node render.mjs <hyperframes|brag> [output.mp4]');
}
const dir = join(root, cut);
if (!existsSync(join(dir, 'assets/vendor/gsap.min.js'))) {
  throw new Error('assets are missing; run npm run fetch-assets first');
}
execFileSync(
  'npx',
  ['--yes', 'hyperframes@0.8.134', 'render', '-o', resolve(output)],
  { cwd: dir, stdio: 'inherit' },
);
