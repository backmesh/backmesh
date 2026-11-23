// The build benchmark (README.md): for each label, ROUNDS rounds of
// bench.yml in the target repo (bench-cache.yml for a `<label>/cache` arm), each on a new branch: a cold run, then, once
// its caches have uploaded, a warm run of the same commit's workflow. Writes
// every job's GitHub times, steps and backmesh start-up marks to
// results/<date>-<backmesh version>.json after each round.
//
//   GITHUB_TOKEN=… TARGET_REPO=backmesh/benchmarks \
//   LABELS='backmesh-4 ubuntu-latest' ROUNDS=5 \
//   BACKMESH_VERSION=0.5.5 ANYCLOUD_VERSION=0.1.80 \
//   INSTALLATION='backmesh org CI, AWS' node benchmarks/builds/run.ts
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { Octokit } from '@octokit/rest';

import type { Job, Results, Run } from './results.ts';

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const [owner, repo] = env('TARGET_REPO').split('/') as [string, string];
const labels = env('LABELS').split(/\s+/);
const rounds = Number(env('ROUNDS'));
const octokit = new Octokit({ auth: env('GITHUB_TOKEN') });
const RUN_WAIT_MS = 45 * 60_000;
// After the cold run, for its caches' uploads, which run after each job
// on its VM, to finish before the warm run's jobs restore.
const UPLOAD_WAIT_MS = 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const run = promisify(execFile);
const here = new URL('.', import.meta.url).pathname;
const date = new Date().toISOString().slice(0, 10);
// An experiment (EXPERIMENT=<name>) goes to results/experiments/, which
// neither the site nor report.ts's trend reads.
const experiment = process.env.EXPERIMENT;
const file = join(
  here,
  experiment ? 'results/experiments' : 'results',
  `${date}-${env('BACKMESH_VERSION')}${experiment ? `-${experiment}` : ''}.json`,
);
const commit = (
  await run('git', ['rev-parse', 'HEAD'], { cwd: here })
).stdout.trim();
const templates = {
  plain: await readFile(join(here, 'bench.yml'), 'utf8'),
  cache: await readFile(join(here, 'bench-cache.yml'), 'utf8'),
};

const results: Results = {
  date,
  backmesh: env('BACKMESH_VERSION'),
  anycloud: env('ANYCLOUD_VERSION'),
  installation: env('INSTALLATION'),
  repo: `${owner}/${repo}`,
  commit,
  labels: Object.fromEntries(labels.map((l) => [l, []])),
};
await mkdir(dirname(file), { recursive: true });
const save = () => writeFile(file, `${JSON.stringify(results, null, 2)}\n`);

// A git checkout of the target, for the round branches' commits.
async function checkout() {
  const dir = await mkdtemp(join(tmpdir(), 'builds-bench-'));
  const git = async (...args: string[]) =>
    (await run('git', args, { cwd: dir })).stdout.trim();
  // GitHub sometimes rejects a push (`fatal error in commit_refs_rules`) and
  // takes the same push a moment later.
  const push = async (...args: string[]) => {
    for (let attempt = 1; ; attempt++)
      try {
        return await git('push', '-q', 'origin', ...args);
      } catch (e) {
        if (attempt === 3) throw e;
        await sleep(10_000);
      }
  };
  await git('init', '-q');
  await git('config', 'user.name', 'backmesh build benchmark');
  await git('config', 'user.email', 'builds-bench@users.noreply.github.com');
  await git('remote', 'add', 'origin', `https://github.com/${owner}/${repo}`);
  return { dir, git, push };
}

// The run for a pushed commit, once it's completed.
async function completed(sha: string) {
  const deadline = Date.now() + RUN_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(15_000);
    const { data } = await octokit.actions.listWorkflowRunsForRepo({
      owner,
      repo,
      head_sha: sha,
    });
    const found = data.workflow_runs[0];
    if (found?.status === 'completed') return found;
  }
  throw new Error(`no completed run for ${sha} within 45 min`);
}

// `<ISO time> <text>` lines of the Marks step and the job log's
// `backmesh cache: auto` lines.
function parseLog(log: string) {
  const marks: Record<string, number> = {};
  const cache: string[] = [];
  let nproc: number | null = null;
  let cpu: string | null = null;
  const hits: Record<string, string> = {};
  let dockerCached = 0;
  let region: string | null = null;
  let vm: string | null = null;
  for (const line of log.split('\n')) {
    const text = line.replace(/^\S+Z /, '').trimEnd();
    const mark = /^([a-z_]+) (\d{13,})$/.exec(text);
    if (mark) marks[mark[1]!] = Number(mark[2]);
    const cpus = /^nproc (\d+)$/.exec(text);
    if (cpus) nproc = Number(cpus[1]);
    if (text.startsWith('cpu ')) cpu = text.slice(4);
    const hit = /^cache-hit (\S+) (\S*)$/.exec(text);
    if (hit) hits[hit[1]!] = hit[2]!;
    if (/^#\d+ CACHED$/.test(text)) dockerCached++;
    if (text.startsWith('region ')) region = text.slice(7);
    if (text.startsWith('vm ')) vm = text.slice(3);
    if (text.startsWith('backmesh cache: auto ')) cache.push(text);
  }
  return { marks, cache, nproc, cpu, region, vm, hits, dockerCached };
}

async function collect(runId: number): Promise<Run> {
  const { data } = await octokit.actions.listJobsForWorkflowRun({
    owner,
    repo,
    run_id: runId,
  });
  const jobs: Record<string, Job> = {};
  for (const j of data.jobs) {
    const { data: log } = await octokit.actions.downloadJobLogsForWorkflowRun({
      owner,
      repo,
      job_id: j.id,
    });
    jobs[j.name] = {
      id: j.id,
      url: j.html_url ?? '',
      conclusion: j.conclusion ?? null,
      runner: j.runner_name ?? null,
      createdAt: j.created_at,
      startedAt: j.started_at,
      completedAt: j.completed_at ?? null,
      steps: (j.steps ?? []).map((s) => ({
        name: s.name,
        startedAt: s.started_at ?? null,
        completedAt: s.completed_at ?? null,
      })),
      ...parseLog(String(log)),
    };
  }
  return {
    runId,
    url: `https://github.com/${owner}/${repo}/actions/runs/${runId}`,
    jobs,
  };
}

// `<label>` runs bench.yml on the label, `<label>/cache` bench-cache.yml.
async function benchmark(arm: string) {
  const [label, cache] = arm.split('/') as [string, string?];
  const { dir, git, push: pushRef } = await checkout();
  await mkdir(join(dir, '.github/workflows'), { recursive: true });
  await writeFile(
    join(dir, '.github/workflows/bench.yml'),
    templates[cache ? 'cache' : 'plain'].replaceAll('__LABEL__', label),
  );
  for (let round = 1; round <= rounds; round++) {
    // A new branch has no caches of its own, and the default branch none of
    // this workflow's, so its first run is cold.
    const branch = `builds/${arm}/${Date.now()}`;
    await git('checkout', '-q', '--orphan', branch);
    await git('add', '-A');
    const push = async (message: string) => {
      await git('commit', '-q', '--allow-empty', '-m', message);
      const sha = await git('rev-parse', 'HEAD');
      await pushRef(`HEAD:refs/heads/${branch}`);
      return completed(sha);
    };
    const cold = await push(`Build benchmark ${arm} round ${round}, cold`);
    await sleep(UPLOAD_WAIT_MS);
    const warm = await push(`Build benchmark ${arm} round ${round}, warm`);
    results.labels[arm]!.push({
      round,
      branch,
      cold: await collect(cold.id),
      warm: await collect(warm.id),
    });
    await save();
    console.log(`${arm} round ${round}: ${cold.html_url} ${warm.html_url}`);
    await pushRef(`:refs/heads/${branch}`);
  }
}

await Promise.all(labels.map(benchmark));
console.log(`wrote ${file}`);
