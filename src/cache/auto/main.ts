// The runner image's automatic caches, run by
// runner-job: `node auto-cache.mjs restore <token file> <state dir>` with
// the runner, and `save <token file> <state dir> <work dir>` after the job.
import { restore } from './restore.js';
import { save } from './save.js';

const [command, token, state, work] = process.argv.slice(2);
if (command === 'restore' && token && state) await restore(token, state);
else if (command === 'save' && token && state && work)
  await save(token, state, work);
else {
  console.error('Usage: auto-cache.mjs restore|save <token> <state> [<work>]');
  process.exitCode = 2;
}
