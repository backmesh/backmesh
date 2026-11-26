// e2e.yml's `burst` input: a burst of `jobs` jobs at once across the leg's
// labels on the test org, to load its control plane as a busy org's push
// does, and the burst's runner-start figures. run-test-org-labels.ts pushes
// burstWorkflow's burst.yml to a burst/<nonce> branch, which labels.yml's
// run/** filter skips. Each job's one step, `Marker`, is its first real
// step; burst.yml's report job reads the jobs' times with its own token and
// pushes them back as result.json, as labels.yml does.

// v7.0.1, as labels.yml's.
const CHECKOUT = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1';

/** burst.yml, as JSON (which YAML reads): `jobs` jobs, round-robin over `labels`. */
export function burstWorkflow(labels: readonly string[], jobs: number) {
  const include = Array.from({ length: jobs }, (_, i) => ({
    i,
    label: labels[i % labels.length]!,
  }));
  const jq =
    '.jobs[] | select(.name | startswith("burst ")) | {name, runner_name, conclusion, created_at, started_at, completed_at, marker: ([.steps[] | select(.name == "Marker") | .started_at][0])}';
  return `${JSON.stringify(
    {
      name: 'burst',
      'run-name': 'burst ${{ github.ref_name }}',
      on: { push: { branches: ['burst/**'] } },
      permissions: {},
      jobs: {
        burst: {
          name: 'burst ${{ matrix.i }} ${{ matrix.label }}',
          strategy: { 'fail-fast': false, matrix: { include } },
          'runs-on': '${{ matrix.label }}',
          'timeout-minutes': 10,
          steps: [{ name: 'Marker', run: 'sleep 30' }],
        },
        report: {
          needs: 'burst',
          if: '${{ always() }}',
          'runs-on': 'ubuntu-24.04',
          'timeout-minutes': 5,
          permissions: { actions: 'read', contents: 'write' },
          steps: [
            { uses: CHECKOUT },
            {
              env: {
                GH_TOKEN: '${{ github.token }}',
                URL: '${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}',
              },
              run: [
                `gh api --paginate "repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/attempts/$GITHUB_RUN_ATTEMPT/jobs?per_page=100" --jq '${jq}' \\`,
                `  | jq -s --arg url "$URL" '{conclusion: "success", $url, jobs: .}' >result.json`,
                'git add result.json',
                'git -c user.name=github-actions -c user.email=github-actions@users.noreply.github.com commit -qm result',
                'git push --force-with-lease="$GITHUB_REF:$GITHUB_SHA" origin HEAD:"$GITHUB_REF"',
              ].join('\n'),
            },
          ],
        },
      },
    },
    null,
    2,
  )}\n`;
}

export interface BurstJob {
  name: string;
  runner_name: string | null;
  conclusion: string | null;
  created_at: string;
  started_at: string | null;
  marker: string | null;
}

// Nearest rank.
const percentile = (sorted: readonly number[], p: number) =>
  sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];

const seconds = (from: string, to: string | null) =>
  to === null ? undefined : (Date.parse(to) - Date.parse(from)) / 1000;

const figure = (values: (number | undefined)[]) => {
  const sorted = values
    .filter((v): v is number => v !== undefined)
    .sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    max: sorted.at(-1),
  };
};

/** Per label and in all: jobs, failed, and queued to assigned and to the first real step, in s. */
export function burstStats(jobs: readonly BurstJob[]) {
  const labelOf = (job: BurstJob) => job.name.split(' ')[2]!;
  const of = (some: readonly BurstJob[]) => ({
    jobs: some.length,
    failed: some.filter((j) => j.conclusion !== 'success').length,
    queuedToAssigned: figure(
      some.map((j) => seconds(j.created_at, j.started_at)),
    ),
    queuedToFirstStep: figure(some.map((j) => seconds(j.created_at, j.marker))),
  });
  const labels = [...new Set(jobs.map(labelOf))].sort();
  return {
    all: of(jobs),
    labels: Object.fromEntries(
      labels.map((l) => [l, of(jobs.filter((j) => labelOf(j) === l))]),
    ),
  };
}

/** The job summary's table. */
export function burstSummary(stats: ReturnType<typeof burstStats>) {
  const row = (name: string, s: ReturnType<typeof burstStats>['all']) =>
    `| ${name} | ${s.jobs} | ${s.failed} | ${s.queuedToAssigned.p50} / ${s.queuedToAssigned.p90} | ${s.queuedToFirstStep.p50} / ${s.queuedToFirstStep.p90} / ${s.queuedToFirstStep.max} |`;
  return [
    '| Label | Jobs | Failed | Queued to assigned p50 / p90 (s) | Queued to first step p50 / p90 / max (s) |',
    '| --- | --- | --- | --- | --- |',
    ...Object.entries(stats.labels).map(([l, s]) => row(`\`${l}\``, s)),
    row('All', stats.all),
  ].join('\n');
}
