#!/usr/bin/env node
// Renders the cut: node render.mjs [output.mp4]

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const [output = join(root, 'renders', 'launch.mp4')] = process.argv.slice(2);
const dir = join(root, 'hyperframes');
if (!existsSync(join(dir, 'assets/vendor/gsap.min.js'))) {
  throw new Error('assets are missing; run npm run fetch-assets first');
}
execFileSync(
  'npx',
  ['--yes', 'hyperframes@0.8.134', 'render', '-o', resolve(output)],
  { cwd: dir, stdio: 'inherit' },
);
