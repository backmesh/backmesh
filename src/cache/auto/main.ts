// The runner image's automatic caches, run by
// runner-job: `node auto-cache.mjs restore <token file> <state dir>` with
// the runner, and `save <token file> <state dir> <work dir>` after the job.
import { restore } from './restore.js';
import { save } from './save.js';

const [command, token, state, work] = process.argv.slice(2);
if (command === 'restore' && token && state) {
  // runner-job's TERM after the job: the restores stop and remove their
  // staging directories, within a few seconds, before the save.
  const stop = new AbortController();
  process.once('SIGTERM', () => {
    stop.abort();
    setTimeout(() => process.exit(143), 5000).unref();
  });
  await restore(token, state, process.env, undefined, undefined, stop.signal);
} else if (command === 'save' && token && state && work)
  await save(token, state, work);
else {
  console.error('Usage: auto-cache.mjs restore|save <token> <state> [<work>]');
  process.exitCode = 2;
}
