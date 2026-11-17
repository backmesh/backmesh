#!/usr/bin/env node
// Downloads the binary assets listed in assets.txt into the cut's git-ignored
// assets/ folder, verifying every SHA-256, then copies the website's brand
// files: the light and dark lockups and the monochrome cloud logos,
// recoloured to the ink colour because an <img> does not inherit
// currentColor.

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const INK = '#15171a';

let base = '';
for (const line of readFileSync(join(root, 'assets.txt'), 'utf8').split('\n')) {
  const fields = line.trim().split(/\s+/);
  if (!fields[0] || fields[0].startsWith('#')) continue;
  if (fields[0] === 'base') {
    base = fields[1];
    continue;
  }
  const [hash, source, ...destinations] = fields;
  const targets = destinations.map((destination) =>
    join(root, destination.endsWith('/') ? destination + source : destination),
  );
  if (
    targets.every(
      (target) => existsSync(target) && sha256(readFileSync(target)) === hash,
    )
  ) {
    continue;
  }
  const url = base + source;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = sha256(bytes);
  if (actual !== hash) {
    throw new Error(`${url}: SHA-256 ${actual} does not match ${hash}`);
  }
  for (const target of targets) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  console.log(`fetched ${source}`);
}

const website = join(root, '../../website');
const brand = join(root, 'hyperframes/assets/brand');
mkdirSync(brand, { recursive: true });
for (const lockup of ['lockup-light.svg', 'lockup-dark.svg']) {
  copyFileSync(join(website, 'public/brand', lockup), join(brand, lockup));
}
for (const cloud of ['aws', 'gcp', 'azure']) {
  const svg = readFileSync(
    join(website, `src/assets/clouds/${cloud}.svg`),
    'utf8',
  );
  writeFileSync(
    join(brand, `${cloud}.svg`),
    svg.replaceAll('currentColor', INK),
  );
}
console.log('assets ready');
