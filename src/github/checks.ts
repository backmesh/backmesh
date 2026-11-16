import type { Octokit } from '@octokit/rest';

import type { Log } from './retry.js';

export interface WorkflowRun {
  owner: string;
  repo: string;
  runId: number;
}

export interface Note {
  // The check run's name after `backmesh: `: GitHub shows one check run per
  // name on a SHA, so a reclaim note names its run.
  name: string;
  title: string;
  summary: string;
}

// Posts a note as a `backmesh: <name>` check run on the run's head SHA:
// GitHub shows it on the run's commit. The App has Checks: write
// and Actions: write. Octokit's fetch
// retries (`retryingFetch`). A run that's gone or not visible to the App has
// nothing to annotate, so its 404 is logged, not thrown.
export function checkRunPoster(octokit: Octokit, log: Log) {
  return async (run: WorkflowRun, note: Note): Promise<void> => {
    const { owner, repo, runId } = run;
    let headSha: string;
    try {
      const { data } = await octokit.rest.actions.getWorkflowRun({
        owner,
        repo,
        run_id: runId,
      });
      headSha = data.head_sha;
    } catch (error) {
      if (error instanceof Error && 'status' in error && error.status === 404) {
        log({
          msg: 'run not found or not visible to the App; no check run',
          owner,
          repo,
          runId,
        });
        return;
      }
      throw error;
    }
    await octokit.rest.checks.create({
      owner,
      repo,
      name: `backmesh: ${note.name}`,
      head_sha: headSha,
      status: 'completed',
      conclusion: 'neutral',
      output: { title: note.title, summary: note.summary },
    });
  };
}
