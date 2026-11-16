// Prints a release's compatibility.json, for package.json's version, from the
// built dist/ (run `yarn build` first).
//
//   node scripts/release-matrix.mjs <runner image@digest> <listener image@digest>
import { readFileSync } from 'node:fs';

import { releaseMatrix } from '../dist/release/compatibility.js';

const [runnerImage, listenerImage] = process.argv.slice(2);
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const matrix = releaseMatrix({ backmesh: version, runnerImage, listenerImage });
process.stdout.write(`${JSON.stringify(matrix, null, 2)}\n`);
