#!/usr/bin/env bash
# The runner's job-completed hook (ACTIONS_RUNNER_HOOK_JOB_COMPLETED): prints
# the job's resource summary into its own log.
exec /usr/local/bin/runner-job summary
