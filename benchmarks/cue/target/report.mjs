// The cue benchmark's target (benchmarks/cue/README.md): the report job,
// once every bench job is done, reads their times and writes them to
// results/<sha>.json on the results branch, where run.ts fetches them over
// git (its deploy key reads no API).
const {
  GH_TOKEN,
  GITHUB_API_URL,
  GITHUB_REPOSITORY,
  GITHUB_RUN_ID,
  GITHUB_RUN_ATTEMPT,
  GITHUB_SHA,
} = process.env;

async function api(path, init = {}) {
  const res = await fetch(
    `${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${GH_TOKEN}`,
        Accept: 'application/vnd.github+json',
      },
    },
  );
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

const { jobs } = await api(
  `/actions/runs/${GITHUB_RUN_ID}/attempts/${GITHUB_RUN_ATTEMPT}/jobs?per_page=100`,
);
const row = {
  sha: GITHUB_SHA,
  jobs: jobs
    .filter((j) => j.name.startsWith('bench'))
    .map((job) => ({
      name: job.name,
      createdAt: job.created_at,
      startedAt: job.started_at,
      completedAt: job.completed_at,
      runner: job.runner_name,
      steps: job.steps.map((s) => ({
        name: s.name,
        startedAt: s.started_at,
        conclusion: s.conclusion,
      })),
    })),
};
console.log(JSON.stringify(row, null, 2));
await api(`/contents/results/${GITHUB_SHA}.json`, {
  method: 'PUT',
  body: JSON.stringify({
    message: `Result for ${GITHUB_SHA}`,
    branch: 'results',
    content: Buffer.from(JSON.stringify(row)).toString('base64'),
  }),
});
