#!/usr/bin/env node
// Turns a render into the five web files a page plays:
//   node encode.mjs <version> [input.mp4]
// Writes renders/web/<version>/ with a SHA256SUMS file (see README.md,
// "Publish a cut").

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const [version, input = join(root, 'renders', 'launch.mp4')] =
  process.argv.slice(2);
if (!version || !/^[a-z0-9-]*\d{4}-\d{2}-v\d+$/.test(version)) {
  throw new Error(
    'usage: node encode.mjs <version like 2026-11-v1> [input.mp4]',
  );
}
const encoders = execFileSync('ffmpeg', ['-hide_banner', '-encoders'], {
  encoding: 'utf8',
});
for (const encoder of ['libaom-av1', 'libopus', 'libx264']) {
  if (!encoders.includes(encoder)) throw new Error(`FFmpeg needs ${encoder}`);
}

const out = join(root, 'renders', 'web', version);
mkdirSync(out, { recursive: true });
const source = resolve(input);
const small = ['-vf', 'scale=1280:720:flags=lanczos'];
const av1 = (crf) =>
  `-c:v libaom-av1 -crf ${crf} -b:v 0 -cpu-used 4 -row-mt 1 -tiles 2x2 -pix_fmt yuv420p`.split(
    ' ',
  );
const h264 = (crf) =>
  `-c:v libx264 -crf ${crf} -preset slow -pix_fmt yuv420p -profile:v high -movflags +faststart`.split(
    ' ',
  );
const files = {
  '1080.av1.webm': [...av1(34), '-c:a', 'libopus', '-b:a', '128k'],
  '720.av1.webm': [...small, ...av1(36), '-c:a', 'libopus', '-b:a', '96k'],
  '1080.h264.mp4': [...h264(24), '-c:a', 'aac', '-b:a', '128k'],
  '720.h264.mp4': [...small, ...h264(26), '-c:a', 'aac', '-b:a', '96k'],
  'poster.jpg': ['-frames:v', '1', '-vf', 'scale=1280:-1', '-q:v', '4'],
};
// The poster is the settled outro, the last 1.5 s hold; -ss goes before -i.
const seek = { 'poster.jpg': ['-sseof', '-1'] };
for (const [name, args] of Object.entries(files)) {
  execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-y',
      ...(seek[name] ?? []),
      '-i',
      source,
      ...args,
      join(out, name),
    ],
    { stdio: 'inherit' },
  );
}

const sums = Object.keys(files).map(
  (name) =>
    `${createHash('sha256')
      .update(readFileSync(join(out, name)))
      .digest('hex')}  ${name}`,
);
writeFileSync(join(out, 'SHA256SUMS'), `${sums.join('\n')}\n`);
console.log(`Encoded ${out}`);
console.log(sums.join('\n'));
