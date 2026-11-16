// e2e.yml's `plan` job: turns the `labels` input and the pinned release's
// compatibility.json into the per-label matrix the `label` and `stop` jobs
// run over.
//
//   LABELS=<e2e.yml's labels input> COMPAT_PATH=<path to compatibility.json> \
//     node test/e2e/plan.ts
import { readFileSync } from 'node:fs';

import { parseLabels } from './labels.ts';

const labelsEnv = process.env.LABELS;
const compatPath = process.env.COMPAT_PATH;
if (!labelsEnv || !compatPath) {
  throw new Error('LABELS and COMPAT_PATH are required');
}

const specs = parseLabels(labelsEnv);
const compat: unknown = JSON.parse(readFileSync(compatPath, 'utf8'));
if (
  typeof compat !== 'object' ||
  compat === null ||
  typeof (compat as { runnerImage?: unknown }).runnerImage !== 'string'
) {
  throw new Error(`${compatPath} has no string runnerImage`);
}
const { runnerImage } = compat as { runnerImage: string };

process.stdout.write(
  JSON.stringify({ include: specs.map((spec) => ({ ...spec, runnerImage })) }),
);
