// The build benchmark (README.md): for each label, ROUNDS rounds of
// bench.yml in the target repo (bench-cache.yml for a `<label>/cache` arm,
// bench-sccache.yml for `<label>/sccache` and `<label>/rust`, bench-docker.yml
// for a `<label>/docker-<mode>` one), each on a new branch:
// a cold run, then, once its caches have uploaded, a warm run of the same
// commit's workflow, and for a Docker arm a run after a small source change.
// Every arm's run of a state is pushed together, in a random order. Writes
// every job's GitHub times, steps and backmesh start-up marks to
// results/<date>-<backmesh version>.json after each round.
//
//   GITHUB_TOKEN=… TARGET_REPO=backmesh/benchmarks \
//   LABELS='backmesh-ubuntu-2404-4vcpu ubuntu-latest' ROUNDS=5 \
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
// One poll a minute for all the arms' runs: the token may be shared.
const POLL_MS = 60_000;
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
  sccache: await readFile(join(here, 'bench-sccache.yml'), 'utf8'),
  docker: await readFile(join(here, 'bench-docker.yml'), 'utf8'),
};
const proxy = join(here, '../../experiments/sccache/dist/proxy.mjs');
const dockerCache = join(here, '../../experiments/docker-cache');

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

// The runs for pushed commits, once they're all completed.
async function completed(shas: string[], since: string) {
  const deadline = Date.now() + RUN_WAIT_MS;
  const found = new Map<string, { id: number; html_url: string }>();
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    // A token shared with other work can run out of its hourly requests:
    // poll on until the deadline.
    const data = await octokit.actions
      .listWorkflowRunsForRepo({
        owner,
        repo,
        event: 'push',
        created: `>=${since}`,
        per_page: 100,
      })
      .then((r) => r.data)
      .catch((e: unknown) => console.log(`polling: ${String(e)}`));
    for (const r of data?.workflow_runs ?? [])
      if (shas.includes(r.head_sha) && r.status === 'completed')
        found.set(r.head_sha, r);
    if (found.size === shas.length) return shas.map((sha) => found.get(sha)!);
  }
  throw new Error(`no completed runs for ${shas.join(' ')} within 45 min`);
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
  const sccache: Record<string, number> = {};
  let proxy: Record<string, unknown> | undefined;
  const docker: NonNullable<Job['docker']> = {};
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
    const stat = /^sccache-stat (\S+) (\d+)$/.exec(text);
    if (stat) sccache[stat[1]!] = Number(stat[2]);
    if (text.startsWith('sccache-proxy {')) proxy = JSON.parse(text.slice(14));
    const setup = /^docker-cache-setup (\d+) ms, ready (\w+)$/.exec(text);
    if (setup) docker.setupMs = Number(setup[1]);
    if (setup) docker.ready = setup[2] === 'yes';
    const bytes = /^image-bytes (\d+)$/.exec(text);
    if (bytes) docker.imageBytes = Number(bytes[1]);
    if (text.startsWith('docker server ')) docker.version = text.slice(7);
    if (text.startsWith('docker store ')) docker.store = text.slice(13);
    if (text.startsWith('docker-cache-proxy {'))
      docker.proxy = JSON.parse(text.slice(19)) as Record<string, unknown>;
  }
  return {
    marks,
    cache,
    nproc,
    cpu,
    region,
    vm,
    hits,
    dockerCached,
    docker,
    ...(proxy && { sccache, proxy }),
  };
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

type State = 'cold' | 'warm' | 'changed';
// `<label>` runs bench.yml on the label, `<label>/cache` bench-cache.yml,
// `<label>/sccache` and `<label>/rust` bench-sccache.yml with sccache on and
// off, `<label>/docker-<off|on|container>` bench-docker.yml in that mode.
async function arm(name: string) {
  const [label, kind = ''] = name.split('/') as [string, string?];
  const mode = /^docker-(off|on|container)$/.exec(kind)?.[1];
  const rust = kind === 'sccache' || kind === 'rust';
  const { dir, git, push } = await checkout();
  await mkdir(join(dir, '.github/workflows'), { recursive: true });
  await writeFile(
    join(dir, '.github/workflows/bench.yml'),
    templates[mode ? 'docker' : rust ? 'sccache' : kind ? 'cache' : 'plain']
      .replaceAll('__LABEL__', label)
      .replaceAll('__MODE__', mode ?? '')
      .replaceAll('__SCCACHE__', kind === 'sccache' ? 'on' : 'off'),
  );
  if (rust) {
    await mkdir(join(dir, 'sccache'));
    await writeFile(join(dir, 'sccache/proxy.mjs'), await readFile(proxy));
  }
  if (mode) {
    await mkdir(join(dir, 'docker-cache/dist'), { recursive: true });
    for (const f of ['setup.sh', 'docker', 'dist/proxy.mjs'])
      await writeFile(
        join(dir, 'docker-cache', f),
        await readFile(join(dockerCache, f)),
        { mode: 0o755 },
      );
  }
  let branch = '';
  return {
    name,
    states: (mode ? ['cold', 'warm', 'changed'] : ['cold', 'warm']) as State[],
    // A new branch has no caches of its own, and the default branch none of
    // this workflow's, so its first run is cold.
    async start() {
      branch = `builds/${name}/${Date.now()}`;
      await git('checkout', '-q', '--orphan', branch);
      await git('add', '-A');
      return branch;
    },
    async push(round: number, state: State) {
      if (state === 'changed') {
        await writeFile(join(dir, 'change'), `round ${round}\n`);
        await git('add', 'change');
      }
      const message = `Build benchmark ${name} round ${round}, ${state}`;
      await git('commit', '-q', '--allow-empty', '-m', message);
      await push(`HEAD:refs/heads/${branch}`);
      return git('rev-parse', 'HEAD');
    },
    end: () => push(`:refs/heads/${branch}`),
  };
}

const arms = await Promise.all(labels.map(arm));
for (let round = 1; round <= rounds; round++) {
  const branches = await Promise.all(arms.map((a) => a.start()));
  const runs: Partial<Record<State, Run>>[] = arms.map(() => ({}));
  for (const state of ['cold', 'warm', 'changed'] as const) {
    const now = arms
      .map((a, i) => ({ a, i, order: Math.random() }))
      .filter(({ a }) => a.states.includes(state))
      .sort((x, y) => x.order - y.order);
    if (!now.length) continue;
    if (state !== 'cold') await sleep(UPLOAD_WAIT_MS);
    const since = new Date(Date.now() - 60_000).toISOString();
    const shas: string[] = [];
    for (const { a } of now) shas.push(await a.push(round, state));
    const done = await completed(shas, since);
    for (const [k, { i }] of now.entries())
      runs[i]![state] = await collect(done[k]!.id);
  }
  for (const [i, a] of arms.entries()) {
    const r = runs[i]!;
    results.labels[a.name]!.push({
      round,
      branch: branches[i]!,
      cold: r.cold!,
      warm: r.warm!,
      ...(r.changed && { changed: r.changed }),
    });
    console.log(
      `${a.name} round ${round}: ${[r.cold, r.warm, r.changed]
        .filter(Boolean)
        .map((x) => x!.url)
        .join(' ')}`,
    );
    await a.end();
  }
  await save();
}
console.log(`wrote ${file}`);
