// Checks the public-repos live run (README.md) from GitHub's records: run
// conclusions, backmesh's check runs and job times. Usage:
//   GH_TOKEN=… node benchmarks/public-repos/check.ts <owner/repo> <fork PR> <same-repo PR>
// Prints each case and exits 1 if any failed.
const [repo, forkPr, samePr] = process.argv.slice(2);
if (!repo || !forkPr || !samePr) {
  throw new Error('usage: check.ts <owner/repo> <fork PR> <same-repo PR>');
}

interface Job {
  name: string;
  labels: string[];
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  runner_name: string | null;
}
interface Run {
  id: number;
  name: string;
  conclusion: string | null;
  head_sha: string;
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    headers: {
      authorization: `Bearer ${process.env.GH_TOKEN}`,
      accept: 'application/vnd.github+json',
    },
  });
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return (await response.json()) as T;
}

// The PR's latest run of each workflow.
async function runsOf(pr: string): Promise<Map<string, Run>> {
  const { head } = await get<{ head: { sha: string } }>(`/pulls/${pr}`);
  const { workflow_runs } = await get<{ workflow_runs: Run[] }>(
    `/actions/runs?head_sha=${head.sha}&event=pull_request`,
  );
  return new Map([...workflow_runs].reverse().map((run) => [run.name, run]));
}

const jobsOf = async (run: Run) =>
  (await get<{ jobs: Job[] }>(`/actions/runs/${run.id}/jobs?per_page=100`))
    .jobs;
const checkRuns = async (sha: string) =>
  (
    await get<{ check_runs: { name: string }[] }>(
      `/commits/${sha}/check-runs?per_page=100`,
    )
  ).check_runs.map((c) => c.name);
const seconds = (job: Job) =>
  job.started_at && job.completed_at
    ? (Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1000
    : 0;

const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail = '') =>
  results.push([name, ok, detail]);

const fork = await runsOf(forkPr);
const same = await runsOf(samePr);

const forkPrivate = fork.get('private-labels');
check(
  "fork run on labels that aren't public is cancelled",
  forkPrivate?.conclusion === 'cancelled',
  String(forkPrivate?.conclusion),
);
if (forkPrivate) {
  const notes = await checkRuns(forkPrivate.head_sha);
  check(
    'with its note',
    notes.includes(`backmesh: fork run ${forkPrivate.id}`),
    notes.join(', '),
  );
  // One that took an idle runner was ended within 60 s.
  const started = (await jobsOf(forkPrivate)).filter((j) => j.runner_name);
  check(
    'a fork job that started was ended within 60 s',
    started.every((job) => seconds(job) <= 60),
    started.map((j) => `${j.name} ${seconds(j)} s`).join(', '),
  );
}
const samePrivate = same.get('private-labels');
check(
  'same-repo run on the same labels succeeds',
  samePrivate?.conclusion === 'success',
  String(samePrivate?.conclusion),
);

const forkPublic = fork.get('public-labels');
if (!forkPublic) {
  check('fork run on the public labels', false, 'no run');
} else {
  const jobs = await jobsOf(forkPublic);
  // The most vCPUs the run's public jobs held at once, from their start and
  // end times: `backmesh-ubuntu-2404-public-<n>vcpu` holds n.
  const vcpus = (j: Job) =>
    Number(
      j.labels
        .map((l) => /^backmesh-public-(\d+)$/.exec(l)?.[1])
        .find(Boolean) ?? 0,
    );
  const edges = jobs
    .filter((j) => vcpus(j) && j.started_at)
    .flatMap((j) => [
      [Date.parse(j.started_at!), vcpus(j)],
      [Date.parse(j.completed_at ?? new Date().toISOString()), -vcpus(j)],
    ])
    .sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!);
  let held = 0;
  let most = 0;
  for (const [, step] of edges) most = Math.max(most, (held += step!));
  // The 10 cap jobs alone would hold 40.
  check('at most 32 public vCPUs at once', most > 0 && most <= 32, `${most}`);
  const limit = jobs.find((j) => j.name === 'limit');
  const minutes = limit ? seconds(limit) / 60 : 0;
  check(
    'the limit job is cancelled at 60 minutes',
    limit?.conclusion === 'cancelled' && minutes >= 60 && minutes < 66,
    `${limit?.conclusion} after ${minutes.toFixed(1)} min`,
  );
  const notes = await checkRuns(forkPublic.head_sha);
  check(
    'with its note',
    notes.includes(`backmesh: runtime limit in run ${forkPublic.id}`),
    notes.join(', '),
  );
  const cache = jobs.find((j) => j.name === 'cache');
  check(
    "the cache job reads main's entry and gets no write",
    cache?.conclusion === 'success',
    String(cache?.conclusion),
  );
}

for (const [name, ok, detail] of results) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
}
if (results.some(([, ok]) => !ok)) process.exitCode = 1;
