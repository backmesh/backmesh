// The stop member's CLI entry: wires
// stop-member.ts's polling logic to the real `gh` CLI (this job's own
// `GH_TOKEN`, repository-scoped: workflow dispatch and run reads) so it can
// dispatch lost-runner-check.yml and ci-install.yml and read their results
// back, the same way a person reproducing it would. Not unit
// tested: it only wires subprocess calls; stop-member.ts and gh-workflows.ts
// carry the logic that is.
//
//   LABEL=backmesh-ubuntu-2404-4vcpu ORG=backmesh node test/e2e/run-stop-member.ts
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import {
  anyRunActive,
  ciInstallRunsArgs,
  diagnoseWithRetry,
  dispatchAndFind,
  jobLogsArgs,
  parseDiagnosis,
  parseTerminatedAt,
  type WorkflowRun,
} from './gh-workflows.ts';
import { runStopMember, type StopMemberDeps } from './stop-member.ts';

const execFileAsync = promisify(execFile);
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const repo = process.env.GITHUB_REPOSITORY;
const label = process.env.LABEL;
const org = process.env.ORG;
if (!repo || !label || !org) {
  throw new Error('GITHUB_REPOSITORY, LABEL and ORG are required');
}

async function gh(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('gh', args, {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

async function listRuns(workflow: string): Promise<WorkflowRun[]> {
  const out = await gh([
    'run',
    'list',
    '--repo',
    repo!,
    '--workflow',
    workflow,
    '--event',
    'workflow_dispatch',
    '--branch',
    'main',
    '--limit',
    '20',
    '--json',
    'databaseId,createdAt,displayTitle',
  ]);
  const runs: unknown = JSON.parse(out);
  if (!Array.isArray(runs))
    throw new Error(`gh run list --json gave non-array output: ${out}`);
  return (
    runs as { databaseId: number; createdAt: string; displayTitle: string }[]
  ).map((r) => ({
    id: r.databaseId,
    createdAt: r.createdAt,
    displayTitle: r.displayTitle,
  }));
}

async function dispatch(
  workflow: string,
  inputs: Record<string, string>,
): Promise<void> {
  const fields = Object.entries(inputs).flatMap(([k, v]) => [
    '-f',
    `${k}=${v}`,
  ]);
  await gh([
    'workflow',
    'run',
    workflow,
    '--repo',
    repo!,
    '--ref',
    'main',
    ...fields,
  ]);
}

// Waits for `runId` to finish, then throws a clear error if it ended
// cancelled (someone else's `gh run cancel`, say), rather than letting the
// caller try to parse a log that may never have been written.
async function waitForCompletion(
  runId: number,
  context: string,
): Promise<void> {
  for (;;) {
    const out = await gh([
      'run',
      'view',
      String(runId),
      '--repo',
      repo!,
      '--json',
      'status,conclusion',
    ]);
    const { status, conclusion } = JSON.parse(out) as {
      status: string;
      conclusion: string | null;
    };
    if (status === 'completed') {
      if (conclusion === 'cancelled') {
        throw new Error(
          `ci-install.yml run ${runId} (${context}) was cancelled before it finished`,
        );
      }
      return;
    }
    await sleep(3000);
  }
}

async function jobLog(runId: number): Promise<string> {
  const jobsOut = await gh(['api', `repos/${repo}/actions/runs/${runId}/jobs`]);
  const { jobs } = JSON.parse(jobsOut) as { jobs: { id: number }[] };
  const job = jobs[0];
  if (!job) throw new Error(`run ${runId} has no job`);
  return gh(jobLogsArgs(repo!, job.id));
}

// ci-install.yml's `concurrency: group: ci-install` lets GitHub keep only
// one pending run of it at a time; a dispatch into a busy group can cancel
// whatever's already queued or running there, which could be the owner's
// own pending install/upgrade/uninstall, not just another e2e dispatch.
// e2e.yml's `stop` jobs already run one label at a time (max-parallel 1), so
// this only guards against something outside this run using ci-install.yml
// at the same moment; it refuses rather than waiting, since a wait here
// would just as happily queue behind, and risk racing, that other run.
async function ciInstallBusy(): Promise<boolean> {
  const out = await gh(ciInstallRunsArgs(repo!));
  const { workflow_runs: runs } = JSON.parse(out) as {
    workflow_runs: { status: string }[];
  };
  return anyRunActive(runs);
}

async function refuseIfCiInstallBusy(action: string): Promise<void> {
  if (await ciInstallBusy()) {
    throw new Error(
      `ci-install.yml already has a run in flight; refusing to dispatch ${action} to avoid interfering with it`,
    );
  }
}

// ci-install.yml's own run-name, so a dispatch here can be matched the same
// way lost-runner-check.yml's is, instead of assuming "newest new run" (round
// 2's finding C): `mode` plus whichever of `runner`/`ids` that mode uses is
// already unique enough in practice (a runner Job id, or the one id being
// diagnosed), without adding a nonce input to this already-sensitive
// production workflow.
const ciInstallTitle = (mode: string, runner: string, ids: string): string =>
  `CI install ${mode} ${runner}${ids}`;

const deps: StopMemberDeps = {
  async dispatchLostRunnerCheck(labelName) {
    // Fail fast, before booting a VM for nothing: if ci-install.yml is
    // already busy, the stop-runner dispatch a few steps from now will
    // refuse anyway.
    await refuseIfCiInstallBusy('lost-runner-check (checked ahead of time)');
    const nonce = randomUUID();
    const displayTitle = `Lost-runner check ${labelName} ${nonce}`;
    return dispatchAndFind(
      dispatch,
      listRuns,
      sleep,
      'lost-runner-check.yml',
      { label: labelName, step: 'docker', nonce },
      { match: (run) => run.displayTitle === displayTitle },
    );
  },

  async getJob(runId) {
    const out = await gh(['api', `repos/${repo}/actions/runs/${runId}/jobs`]);
    const { jobs } = JSON.parse(out) as {
      jobs: {
        status: 'queued' | 'in_progress' | 'completed';
        conclusion: string | null;
        runner_name: string | null;
        completed_at: string | null;
        labels: string[];
      }[];
    };
    const job = jobs[0];
    if (!job) {
      // The run is listed before GitHub has attached its one job to it yet;
      // read as still queued so the poll above keeps waiting instead of
      // throwing (round 2's finding B).
      return {
        status: 'queued',
        conclusion: null,
        runnerName: null,
        completedAt: null,
      };
    }
    if (!job.labels.includes(label)) {
      // Defense in depth, on top of the nonce-matched dispatch above: a job
      // whose labels don't include ours can't be the run this dispatch
      // created.
      throw new Error(
        `run ${runId}'s job has labels [${job.labels.join(', ')}], not ${label}`,
      );
    }
    return {
      status: job.status,
      conclusion: job.conclusion,
      runnerName: job.runner_name,
      completedAt: job.completed_at,
    };
  },

  async cancelRun(runId) {
    await gh(['run', 'cancel', String(runId), '--repo', repo!]);
  },

  async terminateRunner(runnerId) {
    await refuseIfCiInstallBusy('stop-runner');
    const displayTitle = ciInstallTitle('stop-runner', runnerId, '');
    const runId = await dispatchAndFind(
      dispatch,
      listRuns,
      sleep,
      'ci-install.yml',
      { mode: 'stop-runner', runner: runnerId, org },
      { match: (run) => run.displayTitle === displayTitle },
    );
    await waitForCompletion(runId, 'stop-runner');
    const log = await jobLog(runId);
    return parseTerminatedAt(log, runnerId);
  },

  async diagnoseRunner(runnerId) {
    return diagnoseWithRetry(async () => {
      await refuseIfCiInstallBusy('diagnose');
      const displayTitle = ciInstallTitle('diagnose', '', runnerId);
      const runId = await dispatchAndFind(
        dispatch,
        listRuns,
        sleep,
        'ci-install.yml',
        { mode: 'diagnose', ids: runnerId, org },
        { match: (run) => run.displayTitle === displayTitle },
      );
      await waitForCompletion(runId, 'diagnose');
      const log = await jobLog(runId);
      return parseDiagnosis(log, runnerId);
    }, sleep);
  },

  sleep,
};

const result = await runStopMember(deps, label);
console.log(JSON.stringify(result, null, 2));
