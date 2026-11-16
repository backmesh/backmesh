#!/usr/bin/env bash
# The runner's job-started hook (ACTIONS_RUNNER_HOOK_JOB_STARTED): prints the
# runner's start-up timings into the job's own log.
exec /usr/local/bin/runner-job timings
