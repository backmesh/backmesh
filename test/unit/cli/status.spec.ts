import { describe, expect, it } from 'vitest';

import { ANYCLOUD_VERSION } from '../../../src/anycloud/contract.generated.js';
import { formatStatus, readStatus } from '../../../src/cli/status.js';
import {
  fakeApi,
  fakeExec,
  githubOrg,
  listenerVm,
  PUBLIC_REPOS,
  versionMismatch,
} from './fakes.js';
import { formatJobs } from '../../../src/listener/status.js';
import {
  installTag,
  AHEAD_CONTROL_PLANE,
  BEHIND_CONTROL_PLANE,
} from '../../../src/cli/installation.js';
import { planClasses } from '../../../src/runners/classes.js';
import { CATALOG, catalogs } from '../runners/fixtures.js';

const NOW = new Date('2026-11-05T12:00:00Z');

const RUNNER_IMAGE = 'ghcr.io/backmesh/backmesh-runner@sha256:aa';
// Install's classes for aws:us-east-2.
const RUNNERS = JSON.stringify(
  planClasses(
    [{ cloud: 'aws', region: 'us-east-2', credentials: 'bm-aws' }],
    catalogs({ aws: CATALOG.aws }),
    'aws',
  ).classes,
);
// Each org's listener VM, by its Secret's name.
const vmOf = (name: string) =>
  `bml-l8u5e-${name.slice(9).padEnd(6, '0').slice(0, 6)}`;
const LISTENER_IMAGE = 'ghcr.io/backmesh/backmesh-listener@sha256:bb';
// What the probe prints: `/status`'s code and body, and the environment.
const probed = (body: object, org = 'acme', env: object = {}) =>
  JSON.stringify({
    code: 200,
    body,
    env: {
      ORG: org,
      BACKMESH_RUNNER_IMAGE: RUNNER_IMAGE,
      BACKMESH_RUNNERS: RUNNERS,
      BACKMESH_LISTENER_IMAGE: LISTENER_IMAGE,
      BACKMESH_RUNNER_GROUP: 'backmesh-l8u5e-k3j9x0',
      ANYCLOUD_API_TOKEN: 'acsvc_secret',
      ...env,
    },
  });
const LISTENER = {
  org: 'acme',
  override: false,
  image: LISTENER_IMAGE,
  runnerGroup: 'backmesh-l8u5e-k3j9x0',
  runnerImage: RUNNER_IMAGE,
  status: {
    installed: true,
    broker: null,
    runners: 3,
    cap: 500,
    scaleSets: [
      {
        label: 'backmesh-ubuntu-2404-4vcpu',
        statistics: {
          totalAvailableJobs: 0,
          totalAcquiredJobs: 0,
          totalAssignedJobs: 5,
          totalRunningJobs: 2,
          totalRegisteredRunners: 3,
          totalBusyRunners: 1,
          totalIdleRunners: 0,
        },
        queued: 2,
        starting: 0,
        running: 1,
        oldestQueuedMs: 180_000,
        reasons: [{ reason: 'InsufficientInstanceCapacity', count: 2 }],
        capped: true,
        jobs: {
          day: {
            jobs: 42,
            startMs: { p50: 48_400, p95: 201_000 },
            runMs: { p50: 246_000, p95: 540_000 },
            dominant: { segment: 'vm', share: 0.62 },
            reclaims: 1,
            reruns: 0,
            retries: { onDemand: 0, spot: 0 },
            startupFailures: 0,
            since: null,
          },
          week: {
            jobs: 120,
            startMs: { p50: 31_000, p95: 174_000 },
            runMs: null,
            dominant: { segment: 'runner', share: 0.4 },
            reclaims: 3,
            reruns: 0,
            retries: { onDemand: 0, spot: 0 },
            startupFailures: 1,
            since: '2026-11-03T09:15:30.000Z',
          },
        },
        backoff: {
          failures: 5,
          lastEnd: 'exited: Exited with code 1',
          nextProbeAt: '2026-11-05T12:30:00.000Z',
        },
      },
    ],
  },
};

// A current limit in the control plane's quota status, keyed as anycloud
// keys it.
const current = (resourceKey: string, currentLimit: number) => ({
  cloud: 'AWS',
  kind: 'current',
  region: 'us-east-2',
  resourceKey,
  resourceName: resourceKey,
  status: 'CURRENT',
  currentLimit,
});

const QUOTA: object | Response = {
  entries: [
    current('aws:l-34b43a08', 640),
    current('aws:l-1216c47a', 128),
    current('aws:l-3819a6df', 0),
    current('aws:l-db2e81ba', 8),
  ],
};

function setUp({
  workloads = [] as object[],
  listener = probed(LISTENER.status) as string | Error,
  // Other orgs' listeners on the same control plane, by name.
  others = {},
  // Listeners whose VM anycloud found gone.
  lost = [] as string[],
  version = '0.1.72',
  org,
  // The control plane's quota status, or its refusal.
  quota = QUOTA,
}: {
  workloads?: object[];
  listener?: string | Error;
  others?: Record<string, string | Error>;
  lost?: string[];
  version?: string;
  org?: string;
  quota?: object | Response;
} = {}) {
  const listeners: Record<string, string | Error> = {
    'backmesh-acme': listener,
    ...others,
  };
  const vms = Object.keys(listeners).map((name) =>
    listenerVm(name.slice(9), vmOf(name), {
      state: lost.includes(name) ? 'failed' : 'running',
    }),
  );
  const { api, requests } = fakeApi(
    {
      'GET /v1/quota/status': quota,
      'GET /v1/workloads': [...workloads, ...vms],
      'GET /v1/secrets': Object.keys(listeners).map((name) => ({ name })),
      'GET /v1/workload-costs': {
        totalCost: 12.5,
        byProvider: { AWS: { cost: 12.5 } },
      },
    },
    (request) =>
      quota instanceof Response &&
      new URL(request.url).pathname === '/v1/quota/status'
        ? quota.clone()
        : undefined,
  );
  // `anycloud exec <VM> …` answers as that org's listener.
  const { exec, calls } = fakeExec((id) => {
    const name = Object.keys(listeners).find((n) => vmOf(n) === id)!;
    return listeners[name] ?? '';
  });
  return {
    requests,
    calls,
    read: () =>
      readStatus({
        api,
        apiUrl: 'https://c1.anycloud.sh',
        exec,
        fetch: (async (url: string) =>
          url.startsWith('https://api.github.com/')
            ? githubOrg(new URL(url).pathname)
            : Response.json({ version })) as unknown as typeof fetch,
        org,
        now: NOW,
        features: {
          'release-1': '0.1.72',
          c26: undefined,
          'role-connections': undefined,
          'vm-job-regions': undefined,
          'service-tokens': '0.1.0',
          'role-apply': undefined,
          c28: undefined,
          arm64: undefined,
        },
      }),
  };
}

describe('status', () => {
  it('reports the runners, the queue, the month’s cost and no warnings', async () => {
    const { read, requests, calls } = setUp();
    const report = await read();
    expect(report).toMatchObject({
      api: { version: '0.1.72', missingFeatures: [] },
      orgs: [
        {
          org: 'acme',
          listener: {
            runners: [
              'aws us-east-2, 42 labels; quota: 640 spot vCPUs (160 backmesh-ubuntu-2404-4vcpu jobs at once), 128 on-demand vCPUs (32 backmesh-ubuntu-2404-4vcpu jobs at once); GPU quota: 0 spot vCPUs (0 backmesh-ubuntu-2404-gpu-t4 jobs at once), 8 on-demand vCPUs (2 backmesh-ubuntu-2404-gpu-od-t4 jobs at once); raise EC2 "All G and VT Spot Instance Requests" (L-3819A6DF) in us-east-2 to run backmesh-ubuntu-2404-gpu-t4',
            ],
          },
          vm: 'bml-l8u5e-acme00',
          lost: false,
          runnerGroup: 'backmesh-l8u5e-k3j9x0',
          session: expect.stringMatching(/^bm-[a-z0-9]{5}$/),
          cost: {
            since: '2026-11-01T00:00:00.000Z',
            totalUsd: 12.5,
            byCloud: { AWS: 12.5 },
          },
        },
      ],
      warnings: [],
    });
    expect(requests).toContain(
      `GET /v1/workload-costs?session=${report.orgs[0]!.session}&sessionExact=true&sinceMs=${Date.UTC(2026, 10, 1)}`,
    );
    expect(calls[0]![0]).toBe('bml-l8u5e-acme00');
    expect(calls[0]![1]).toMatch(
      /^docker exec backmesh-listener node -e .*http:\/\/127\.0\.0\.1:8080\/status/,
    );
    // The service token and install key stay out of the report.
    expect(JSON.stringify(report)).not.toContain('acsvc_secret');

    const text = formatStatus(report);
    expect(text).toContain(
      'backmesh-ubuntu-2404-4vcpu: 5 assigned, 2 running; runners 2 queued, 0 starting, 1 running',
    );
    expect(text).toContain(
      [
        '    oldest queued 3 min',
        '    2 queued: InsufficientInstanceCapacity',
        "    held back by the control plane's 500-runner cap",
        '    42 jobs today · start 48 s typical, 3.4 min slowest',
        '    1 job reclaimed',
        '    backing off after 5 startup failures',
      ].join('\n'),
    );
    const [set] = LISTENER.status.scaleSets;
    const { day } = set!.jobs;
    // Nothing in 24 hours, or an older listener: no lines.
    const quiet = { ...day, jobs: 0, reclaims: 0, startupFailures: 0 };
    expect(formatJobs({ ...set!, jobs: { day: quiet, week: day } })).toEqual(
      [],
    );
    expect(formatJobs({ ...set!, jobs: undefined })).toEqual([]);
    // Startup failures and reruns, only when there are any.
    expect(
      formatJobs({
        ...set!,
        jobs: { day: { ...day, reruns: 1, startupFailures: 2 }, week: day },
      }).slice(1),
    ).toEqual([
      '    1 job reclaimed, 1 run rerun',
      '    2 runners failed to start',
    ]);
    // Split by what the runners were started for, once a cue or a
    // prediction started one that took a job.
    const startedFor = (cue: number) => ({
      cue: { jobs: cue, startMs: cue ? { p50: 6_000, p95: 12_000 } : null },
      predicted: { jobs: 0, startMs: null },
      reactive: { jobs: 41, startMs: { p50: 48_400, p95: 201_000 } },
    });
    const split = (cue: number) =>
      formatJobs({
        ...set!,
        jobs: { day: { ...day, startedFor: startedFor(cue) }, week: day },
      }).slice(1, 3);
    expect(split(1)).toEqual([
      '      cue: 1 job, start 6 s typical, 12 s slowest',
      '      reactive: 41 jobs, start 48 s typical, 3.4 min slowest',
    ]);
    expect(split(0)).toEqual(['    1 job reclaimed']);
    // A rerun today of a run reclaimed earlier.
    expect(
      formatJobs({
        ...set!,
        jobs: { day: { ...day, reclaims: 0, reruns: 1 }, week: day },
      }).slice(1),
    ).toEqual(['    1 run rerun']);
    // A quota warning only at 3 runners refused for quota with a 2-minute
    // p95 wait, counting runners, not launches, and naming the quota each
    // cloud's refusal says to raise.
    const warn = (
      cloud: 'aws' | 'gcp' | 'azure',
      refusedFor: Record<string, number>,
      runners = 9,
      p95 = 1_001_000,
    ) =>
      formatJobs({
        ...set!,
        cloud,
        jobs: {
          day: {
            ...day,
            reclaims: 0,
            refusedIn: { 'us-east4': 15 },
            refusedFor,
            quotaRefused: {
              runners,
              regions: ['us-east4'],
              waitMs: { p50: 150_000, p95 },
            },
          },
          week: day,
        },
      }).slice(1);
    expect(warn('gcp', { 'quota-exhausted-account': 15 })).toEqual([
      '    ⚠ 9 runners waited for GCP quota in us-east4, up to 16.7 min.',
      '      Raise CPUS_ALL_REGIONS above its default 32 to start them right away.',
    ]);
    const spot = 'account-regional-spot-quota-exhausted';
    for (const [cloud, diagnosis, quota] of [
      [
        'gcp',
        'quota-exhausted-region',
        'CPUS, C4D_CPUS, C3D_CPUS, N2D_CPUS and N2_CPUS in us-east4',
      ],
      ['aws', 'quota-exhausted-region', 'L-1216C47A in us-east4'],
      ['aws', spot, 'L-34B43A08 in us-east4'],
      [
        'azure',
        'quota-exhausted-region',
        "the VM family's vCPU quota in us-east4",
      ],
      ['azure', spot, '"Total Regional Low-priority vCPUs" in us-east4'],
    ] as const) {
      expect(warn(cloud, { [diagnosis]: 3 }, 3)).toEqual([
        '    ⚠ 3 runners waited for ' +
          { gcp: 'GCP', aws: 'AWS', azure: 'Azure' }[cloud] +
          ' quota in us-east4, up to 16.7 min.',
        `      Raise ${quota} to start them right away.`,
      ]);
    }
    // Below the threshold, even with many launches refused, or capacity
    // only: no warning.
    expect(warn('gcp', { 'quota-exhausted-account': 3 }, 3, 120_000)).toEqual([
      '    ⚠ 3 runners waited for GCP quota in us-east4, up to 2.0 min.',
      '      Raise CPUS_ALL_REGIONS above its default 32 to start them right away.',
    ]);
    expect(warn('gcp', { 'quota-exhausted-account': 15 }, 2)).toEqual([]);
    expect(warn('gcp', { 'quota-exhausted-account': 15 }, 9, 119_000)).toEqual(
      [],
    );
    expect(warn('gcp', { 'capacity-exhausted': 15 }, 0)).toEqual([]);
    // `--json` keeps both windows' every percentile and segment.
    expect(report.orgs[0]!.listener).toMatchObject({
      status: { scaleSets: [{ jobs: LISTENER.status.scaleSets[0]!.jobs }] },
    });
    expect(text).toContain(
      'backing off after 5 startup failures (last exited: Exited with code 1), next probe 2026-11-05T12:30:00.000Z',
    );
    expect(text).toContain('Cost since 2026-11-01: $12.50, AWS $12.50');
    expect(text).toContain(
      [
        'Runners: each job gets its own VM; the job controls that VM’s Docker.',
        '',
        `acme, session ${report.orgs[0]!.session}, runner group backmesh-l8u5e-k3j9x0:`,
        'Listener VM: bml-l8u5e-acme00',
      ].join('\n'),
    );
    expect(text).toContain(`Runner image: ${RUNNER_IMAGE}`);
    expect(text).toContain(
      'Runner VMs: aws us-east-2, 42 labels; quota: 640 spot vCPUs (160 backmesh-ubuntu-2404-4vcpu jobs at once), 128 on-demand vCPUs (32 backmesh-ubuntu-2404-4vcpu jobs at once); GPU quota: 0 spot vCPUs (0 backmesh-ubuntu-2404-gpu-t4 jobs at once), 8 on-demand vCPUs (2 backmesh-ubuntu-2404-gpu-od-t4 jobs at once); raise EC2 "All G and VT Spot Instance Requests" (L-3819A6DF) in us-east-2 to run backmesh-ubuntu-2404-gpu-t4',
    );
    expect(text).toContain('No warnings.');
    expect(text).not.toContain('\n\n\n');
  });

  it("reads the quotas through the control plane with the cloud's credential", async () => {
    const { read, requests } = setUp();
    await read();
    expect(
      requests.filter((r) => r.startsWith('GET /v1/quota/status')),
    ).toEqual([
      'GET /v1/quota/status?cloud=AWS&credentialName=bm-aws&region=us-east-2',
    ]);
  });

  it("leaves the quotas unread with the control plane's why", async () => {
    // A refused request: the credential isn't there.
    const { read } = setUp({
      quota: Response.json(
        {
          defined: true,
          code: 'QUOTA_STATUS_INVALID',
          status: 400,
          message: 'Credential "bm-aws" not found',
        },
        { status: 400 },
      ),
    });
    expect(formatStatus(await read())).toContain(
      'Runner VMs: aws us-east-2, 42 labels; quota: unread (Credential "bm-aws" not found)',
    );
    // A read the control plane made and the cloud refused.
    const { read: refused } = setUp({
      quota: {
        entries: [
          {
            cloud: 'AWS',
            kind: 'unavailable',
            region: 'us-east-2',
            resourceKey: 'aws:l-34b43a08',
            resourceName: 'spot',
            status: 'UNAVAILABLE',
            message: 'AccessDeniedException',
          },
        ],
      },
    });
    expect(formatStatus(await refused())).toContain(
      'quota: unread (AccessDeniedException)',
    );
  });

  it("says a listener that can't reach the control plane, without blaming its token", async () => {
    const report = await setUp({
      listener: probed({
        ...LISTENER.status,
        anycloud: {
          since: '2026-11-05T11:00:00.000Z',
          error: 'TypeError: fetch failed',
        },
      }),
    }).read();
    expect(report.warnings).toEqual([
      "acme: the listener hasn't reached the control plane since 2026-11-05 11:00Z: TypeError: fetch failed.",
    ]);
  });

  it('says a lost listener VM needs `backmesh upgrade`', async () => {
    const report = await setUp({ lost: ['backmesh-acme'] }).read();
    expect(report.warnings).toEqual([
      "acme's listener didn't answer: its VM bml-l8u5e-acme00 is gone, and anycloud doesn't replace it; run `backmesh upgrade` to create another, or `backmesh uninstall --org acme` to finish removing it",
    ]);
    expect(formatStatus(report)).toContain(
      'Listener VM: bml-l8u5e-acme00 (gone)',
    );
  });

  it('says to reissue a service token the control plane refuses', async () => {
    const report = await setUp({
      listener: probed({
        ...LISTENER.status,
        anycloud: { since: '2026-11-05T11:00:00.000Z', error: 'HTTP 401: {}' },
      }),
    }).read();
    expect(report.warnings).toEqual([
      "acme: the control plane has refused the listener's service token since 2026-11-05 11:00Z, so it can't start runners; a restore from a backup older than the token does this. Run `backmesh upgrade` to issue it a new one.",
    ]);
  });

  // A runner group without public classes refuses public repositories,
  // whose jobs then wait at GitHub with no word to the listener.
  it("says which public repositories can't use runners without the public labels", async () => {
    PUBLIC_REPOS.acme = ['acme/site', 'acme/docs', 'acme/old-archived'];
    try {
      expect((await setUp().read()).warnings).toEqual([
        "acme: 2 public repositories (such as acme/site) can't use these runners, and their jobs wait at GitHub. `backmesh upgrade --public-repos` adds backmesh-ubuntu-2404-public-2vcpu and backmesh-ubuntu-2404-public-4vcpu for them to use.",
      ]);
      const withPublic = JSON.stringify(
        planClasses(
          [{ cloud: 'aws', region: 'us-east-2', credentials: 'bm-aws' }],
          catalogs({ aws: CATALOG.aws }),
          'aws',
          true,
        ).classes,
      );
      const listener = probed(LISTENER.status, 'acme', {
        BACKMESH_RUNNERS: withPublic,
      });
      expect((await setUp({ listener }).read()).warnings).toEqual([]);
      // Classes that don't parse say nothing of public repositories.
      const unparsed = probed(LISTENER.status, 'acme', {
        BACKMESH_RUNNERS: 'not json',
      });
      expect((await setUp({ listener: unparsed }).read()).warnings).toEqual([]);
      // A full page of them is 100 or more.
      PUBLIC_REPOS.acme = Array.from({ length: 100 }, (_, i) => `acme/r${i}`);
      expect((await setUp().read()).warnings).toEqual([
        expect.stringMatching(
          /^acme: 100\+ public repositories \(such as acme\/r0\)/,
        ),
      ]);
    } finally {
      delete PUBLIC_REPOS.acme;
    }
  });

  it('warns about a silent listener and an API before release 1', async () => {
    const { read } = setUp({
      listener: new Error('no ready replica'),
      version: '0.1.70',
    });
    const report = await read();
    expect(report.warnings).toEqual([
      "acme's listener didn't answer: no ready replica",
      expect.stringContaining(
        'The control plane (0.1.70) is too old for this backmesh',
      ),
    ]);
    expect(formatStatus(report)).toContain('Warnings:');
  });

  // The listener's token asks for Actions read only (owner, 2026-11-19):
  // the Worker reruns for it.
  // The installation's Actions permission, which backmesh.com's reruns and
  // cancels need at write (the listener's own token reads only).
  it('asks for Actions: write until the installation grants it, quiet for an older listener', async () => {
    for (const [actionsPermission, warned] of [
      ['read', true],
      ['none', true],
      ['write', false],
      [null, false],
      [undefined, false],
    ] as const) {
      const { read } = setUp({
        listener: probed({ ...LISTENER.status, actionsPermission }),
      });
      const { warnings } = await read();
      expect(warnings).toEqual(
        warned
          ? [
              expect.stringContaining(
                `The backmesh App has Actions: ${actionsPermission} on ${LISTENER.org ?? 'acme'}; backmesh.com needs Actions: write there to rerun reclaimed jobs and cancel fork runs.`,
              ),
            ]
          : [],
      );
    }
  });

  it.each([
    ['sends that work', {}, []],
    [
      'an unreachable Worker',
      { lastError: 'fetch failed' },
      [
        "Telemetry: backmesh.com didn't answer (fetch failed); 3 events to send. Jobs aren't affected.",
      ],
    ],
    [
      'a refusal',
      { lastError: 'x answered 403', lastStatus: 403, pending: 1 },
      [
        "Telemetry: backmesh.com refused (x answered 403); 1 event to send. Jobs aren't affected.",
      ],
    ],
    [
      'a refused install key',
      { lastError: '/v1/events answered 401', lastStatus: 401 },
      [
        "Telemetry: backmesh.com refused this install's sign-in; run backmesh upgrade to sign in with GitHub again.",
      ],
    ],
  ])('shows telemetry with %s, and no warning', async (_, fields, lines) => {
    const telemetry = {
      lastError: null,
      lastStatus: null,
      pending: 3,
      ...fields,
    };
    const report = await setUp({
      listener: probed({ ...LISTENER.status, telemetry }),
    }).read();

    const text = formatStatus(report);
    for (const line of lines) expect(text).toContain(line);
    if (!lines.length) expect(text).not.toContain('Telemetry:');
    expect(report.warnings).toEqual([]);
    expect(report.orgs[0]!.listener).toMatchObject({ status: { telemetry } });
  });

  it("shows the planner's runners under their scale set and its line", async () => {
    const [set] = LISTENER.status.scaleSets;
    const report = await setUp({
      listener: probed({
        ...LISTENER.status,
        scaleSets: [{ ...set, speculative: 2 }],
        planner: { keys: 3, guarded: 1, off: false },
      }),
    }).read();
    const lines = formatStatus(report).split('\n');
    const at = lines.indexOf('    2 started ahead of predicted jobs');
    const reason = lines.indexOf('    2 queued: InsufficientInstanceCapacity');
    expect(reason).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(reason);
    expect(lines).toContain(
      'Planner: 3 workflows learned, 1 reactive (predictions under 60 % right)',
    );
  });

  it('warns when every runner region of a scale set is skipped for its quota', async () => {
    const [set] = LISTENER.status.scaleSets;
    const skipped = {
      cloud: 'aws',
      spot: true,
      vcpus: 4,
      all: true,
      regions: [{ region: 'us-west-1', limit: 3 }],
    };
    const report = await setUp({
      listener: probed({
        ...LISTENER.status,
        scaleSets: [{ ...set, backoff: null, skipped }],
      }),
    }).read();
    expect(report.warnings).toEqual([
      "acme: backmesh-ubuntu-2404-4vcpu starts no runners: every runner region's spot quota is under one 4-vCPU runner (us-west-1 3 vCPU). Its jobs wait at GitHub until L-34B43A08 is raised; nothing to reinstall.",
    ]);
    expect(formatStatus(report)).toContain(
      '    us-west-1: spot quota 3 vCPU, under one 4-vCPU runner, skipped; raise L-34B43A08 to use it',
    );
  });

  it('warns when every region a spot scale set fits is avoided for slow boots', async () => {
    const [set] = LISTENER.status.scaleSets;
    const report = await setUp({
      listener: probed({
        ...LISTENER.status,
        scaleSets: [
          {
            ...set,
            backoff: null,
            avoiding: {
              regions: ['us-east-2'],
              until: '2026-11-09T14:30:00.000Z',
            },
            skipped: {
              cloud: 'aws',
              spot: true,
              vcpus: 4,
              all: false,
              regions: [{ region: 'us-west-1', limit: 3 }],
            },
          },
        ],
      }),
    }).read();
    expect(report.warnings).toEqual([
      'acme: backmesh-ubuntu-2404-4vcpu starts no runners until 14:30Z: runners in us-east-2 missed the 3-minute start deadline, and its other regions are skipped for quota. Its jobs wait at GitHub meanwhile.',
    ]);
  });

  it('says when a spot scale set starts its runners on demand while every spot region is avoided', async () => {
    const [set] = LISTENER.status.scaleSets;
    const report = await setUp({
      listener: probed({
        ...LISTENER.status,
        scaleSets: [
          {
            ...set,
            backoff: null,
            avoiding: {
              regions: ['us-east-2'],
              until: '2026-11-09T14:30:00.000Z',
              onDemand: true,
            },
          },
        ],
      }),
    }).read();
    expect(report.warnings).toEqual([
      'acme: backmesh-ubuntu-2404-4vcpu starts its runners on demand until 14:30Z: spot runners in us-east-2 missed the start deadline, so its jobs bill at the on-demand rate until then.',
    ]);
  });

  it('warns while the listener waits for the App installation', async () => {
    const { read } = setUp({
      listener: probed({
        installed: false,
        broker: null,
        runners: 0,
        cap: 500,
        scaleSets: [],
      }),
    });
    const report = await read();
    expect(report.warnings).toEqual([
      expect.stringContaining("The backmesh App isn't installed on acme"),
    ]);
    expect(formatStatus(report)).toContain(
      "Listener: waiting for the App's installation on acme",
    );
  });

  it('warns while the token broker is unreachable', async () => {
    const broker = { since: '2026-11-06T11:40:00.000Z', error: 'Error: 503' };
    const report = await setUp({
      listener: probed({ ...LISTENER.status, broker }),
    }).read();
    expect(report.warnings).toEqual([
      expect.stringContaining(
        'acme: the token broker has failed since 2026-11-06 11:40Z: Error: 503.',
      ),
    ]);
  });

  it('warns when the App installation is removed after the listener started', async () => {
    const notInstalled = {
      since: '2026-11-06T18:54:00.000Z',
      installUrl: 'https://github.com/apps/backmesh/installations/new',
    };
    const report = await setUp({
      listener: probed({ ...LISTENER.status, notInstalled }),
    }).read();
    expect(report.warnings).toEqual([
      expect.stringContaining(
        "The backmesh App's installation on acme is gone since 2026-11-06 18:54Z",
      ),
    ]);
    expect(report.warnings[0]).toContain(notInstalled.installUrl);
  });

  it('shows the control plane once and a section per org; --org narrows it', async () => {
    const beta = probed({ ...LISTENER.status, runners: 1 }, 'Beta');
    const all = await setUp({
      others: { 'backmesh-beta': beta },
    }).read();
    expect(all.orgs.map(({ org }) => org)).toEqual(['acme', 'Beta']);
    // Each org's runners have their own session.
    expect(all.orgs[0]!.session).not.toBe(all.orgs[1]!.session);
    const text = formatStatus(all);
    expect(text.match(/^Control plane /gm)).toHaveLength(1);
    expect(text.match(/^Runners: /gm)).toHaveLength(1);
    // Each install's own runner group, from its Secret.
    const acme = all.orgs[0]!;
    expect(acme.runnerGroup).toBe('backmesh-l8u5e-k3j9x0');
    expect(text).toContain(
      `acme, session ${acme.session}, runner group ${acme.runnerGroup}:`,
    );
    expect(text).toContain(
      `Beta, session ${all.orgs[1]!.session}, runner group ${all.orgs[1]!.runnerGroup}:`,
    );
    expect(all.orgs[1]).toMatchObject({ vm: 'bml-l8u5e-beta00' });
    expect(text).toContain(
      "Queue (1 runners; the control plane's cap is 500):",
    );

    const { read, calls } = setUp({
      others: { 'backmesh-beta': beta },
      org: 'BETA',
    });
    const one = await read();
    expect(one.orgs.map(({ org }) => org)).toEqual(['Beta']);
    expect(calls.every(([id]) => id === 'bml-l8u5e-beta00')).toBe(true);
    await expect(setUp({ org: 'gamma' }).read()).rejects.toThrow(
      "There's no listener for gamma on https://c1.anycloud.sh.",
    );
  });

  it("keeps the other orgs' sections when one org can't be read", async () => {
    // zeta's listener is down and GitHub has no org by that name.
    const report = await setUp({
      others: { 'backmesh-zeta': new Error('no ready replica') },
    }).read();
    expect(report.orgs.map(({ org, cost }) => [org, cost?.totalUsd])).toEqual([
      ['acme', 12.5],
      ['zeta', undefined],
    ]);
    expect(report.warnings).toEqual([
      "zeta's runner cost couldn't be read: GitHub has no org named zeta.",
      "zeta's listener didn't answer: no ready replica",
    ]);
    expect(formatStatus(report)).toContain('\nzeta:\n');
  });

  it("takes the tag's org ID from the listener when it has one", async () => {
    const env = { ORG: 'zeta', ORG_ID: '9', BACKMESH_LISTENER_IMAGE: 'i' };
    const { read, requests } = setUp({
      others: {
        'backmesh-zeta': JSON.stringify({
          code: 200,
          body: LISTENER.status,
          env,
        }),
      },
    });
    const report = await read();
    expect(report.orgs[1]).toMatchObject({
      org: 'zeta',
      session: `bm-${installTag('c1', 9)}`,
    });
    expect(requests).toContain(
      `GET /v1/workload-costs?session=bm-${installTag('c1', 9)}&sessionExact=true&sinceMs=${Date.UTC(2026, 10, 1)}`,
    );
  });

  it('says to upgrade when a control plane on another anycloud refuses this release', async () => {
    // Behind: a plane a release before the pin; an unreadable refusal too.
    const behind = (message?: string) =>
      fakeApi({}, () =>
        message
          ? Response.json(
              {
                defined: true,
                code: 'CLIENT_VERSION_MISMATCH',
                status: 400,
                message,
              },
              { status: 400 },
            )
          : versionMismatch(ANYCLOUD_VERSION, '0.1.60'),
      ).api;
    const api = behind();
    await expect(
      readStatus({
        api,
        apiUrl: 'https://c1.anycloud.sh',
        exec: fakeExec(() => '').exec,
        fetch: async () => Response.json({ version: '0.1.73' }),
      }),
    ).rejects.toThrow(BEHIND_CONTROL_PLANE);
    await expect(
      readStatus({
        api: behind('Client/API version mismatch.'),
        apiUrl: 'https://c1.anycloud.sh',
        exec: fakeExec(() => '').exec,
        fetch: async () => Response.json({ version: '0.1.60' }),
      }),
    ).rejects.toThrow(BEHIND_CONTROL_PLANE);
    const { api: ahead } = fakeApi({}, () =>
      versionMismatch(ANYCLOUD_VERSION, '9.0.0'),
    );
    await expect(
      readStatus({
        api: ahead,
        apiUrl: 'https://c1.anycloud.sh',
        exec: fakeExec(() => '').exec,
        fetch: async () => Response.json({ version: '0.1.80' }),
      }),
    ).rejects.toThrow(AHEAD_CONTROL_PLANE);
  });

  it('refuses a local API, which has no installation', async () => {
    const { api } = fakeApi({});
    await expect(
      readStatus({
        api,
        apiUrl: 'http://localhost:8080',
        exec: fakeExec(() => '').exec,
      }),
    ).rejects.toThrow('has no backmesh installation');
  });
});
