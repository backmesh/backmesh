import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { FeatureTable } from '../../../src/anycloud/features.js';
import type { DrainStatus } from '../../../src/listener/drain.js';
import {
  leftoverIdentity,
  uninstall,
  type UninstallDeps,
  type UninstallOptions,
} from '../../../src/cli/uninstall.js';
import { connectionName } from '../../../src/cli/installation.js';
import {
  fakeApi,
  fakeBinary,
  fakeCloud,
  fakeOrg,
  fakeWorker,
  INSTALL_KEY,
} from './fakes.js';

const HOSTED = 'https://c1.anycloud.sh';
const DONE: DrainStatus = { state: 'done', runnerJobs: 0, error: null };
const LISTENER_IMAGE = `ghcr.io/backmesh/backmesh-listener@sha256:${'b'.repeat(64)}`;
const CLEANUP_ID = 'c'.repeat(64);
// Step 2b at the org's GitHub: two scale sets, two backmesh runners, then
// the runner group.
const githubDeletes = (org: string) =>
  GITHUB_DELETES.map((c) => c.replace('/orgs/acme/', `/orgs/${org}/`));
const GITHUB_DELETES = [
  'github DELETE /abc/_apis/runtime/runnerscalesets/1',
  'github DELETE /abc/_apis/runtime/runnerscalesets/2',
  'github DELETE /orgs/acme/actions/runners/100',
  'github DELETE /orgs/acme/actions/runners/101',
  'github DELETE /orgs/acme/actions/runner-groups/3',
];
const RELEASED: FeatureTable = {
  'release-1': '0.1.0',
  c26: '0.1.0',
  'role-connections': '0.1.0',
  'role-apply': '0.1.0',
  c28: '0.1.0',
  'vm-job-regions': undefined,
};
const DELETE_HOSTED = 'cluster delete c1 --delete-buckets --confirm c1 --json';

const pool = (id: string, name: string) => ({
  id,
  name,
  state: 'running',
  releasing: false,
  allowPrivilegedJobs: name !== 'bm-control',
});

// A machine targeting the control plane at HOSTED, whose connections are
// aws's role and gcp's generated key, the listener on `bm-control` with one
// running job, and a drain that ends `drained`. Deletes change what the API
// lists next.
function setUp({
  url = HOSTED,
  listener = true,
  orgs = ['acme'],
  secrets = orgs,
  others = [],
  answers = true,
  drained = DONE,
  reads = [],
  tty,
  hostedList = true,
  worker = fakeWorker(),
  github = fakeOrg(),
  runners = [] as string[],
  cloud = fakeCloud(['anycloud-bm-gcp']),
}: {
  url?: string;
  listener?: boolean;
  // The orgs whose listeners run on `bm-control`.
  orgs?: string[];
  // The orgs whose `backmesh-<org>` Secret exists.
  secrets?: string[];
  // Other Deployments on `bm-control`, such as an older listener.
  others?: { name: string; managed: boolean }[];
  answers?: boolean;
  drained?: DrainStatus;
  // GET /drain's replies before `drained`: a failed exec, null from a
  // restarted listener, or a drain still running.
  reads?: (Error | null | DrainStatus)[];
  tty?: { confirm: boolean[]; typed: string };
  // Whether the hosted API's `credentials list` answers.
  hostedList?: boolean;
  // backmesh.com, for the cleanup's sign-in and step 6.
  worker?: ReturnType<typeof fakeWorker>;
  // The org's GitHub, for step 2b with the cleanup token.
  github?: ReturnType<typeof fakeOrg>;
  // Runner VM Jobs the drain left running: terminated, then released a
  // read later.
  runners?: string[];
  // The user's cloud CLIs, with our CI's generated identities.
  cloud?: ReturnType<typeof fakeCloud>;
} = {}) {
  const deleted = new Set<string>();
  const phases = new Map<string, number>();
  const { run: answer, calls } = fakeBinary({
    'api token': 't0ken',
    'cluster delete': JSON.stringify({ outcome: 'destroyed', remaining: [] }),
  });
  const run = async (args: string[]) => {
    const line = args.join(' ');
    if (line === 'api status --json') return JSON.stringify({ url });
    // A role connection lists its kind; a key may not.
    if (line === 'credentials list --json') {
      calls.push(line);
      if (!hostedList) {
        throw new Error('Command failed: anycloud credentials list --json');
      }
      return JSON.stringify([
        { name: 'bm-aws', kind: 'role' },
        { name: 'bm-gcp' },
        { name: 'mine', kind: 'key' },
      ]);
    }
    if (/^(deployment|node-pool) delete /.test(line)) deleted.add(args[2]!);
    if (/^secrets delete /.test(line)) deleted.add(`secret ${args[2]}`);
    if (line.includes('8080/status')) {
      calls.push(`exec ${args[1]} /status`);
      if (!listener) throw new Error('no such Deployment');
      return JSON.stringify({
        code: 200,
        env: {
          ORG: args[1]!.replace('backmesh-', ''),
          BACKMESH_INSTALL_KEY: INSTALL_KEY,
        },
        body: {
          installed: true,
          broker: null,
          runners: 1,
          cap: 500,
          scaleSets: [
            {
              label: 'backmesh-4',
              queued: 0,
              starting: 0,
              running: 1,
              oldestQueuedMs: null,
              reasons: [],
              capped: false,
              statistics: null,
              backoff: null,
            },
          ],
        },
      });
    }
    if (line.includes('8080/drain')) {
      const post = line.includes('"POST"');
      calls.push(`exec ${args[1]} ${post ? 'POST' : 'GET'} /drain`);
      const reply = post
        ? { ...DONE, state: 'running' }
        : reads.length
          ? reads.shift()
          : drained;
      if (reply instanceof Error) throw reply;
      return JSON.stringify({ code: 200, env: {}, body: reply });
    }
    if (
      line.startsWith('api access remove --service-account ') &&
      !(listener && orgs.includes(args.at(-1)!.replace('backmesh-', '')))
    ) {
      void calls.push(line);
      throw new Error('not a member');
    }
    return answer(args);
  };
  const { api } = fakeApi({
    'GET /v1/node-pools': () => ({
      nodePools: [pool('np-1', 'bm-control'), pool('np-2', 'bm-aws-spot')].map(
        (p) => (deleted.has(p.id) ? { ...p, state: 'terminated' } : p),
      ),
    }),
    'GET /v1/deployments': () => ({
      deployments: [
        ...(listener
          ? orgs.map((org) => ({ name: `backmesh-${org}`, managed: false }))
          : []),
        ...others,
      ].map((d) => ({
        ...d,
        nodePoolId: 'np-1',
        deletedAt: deleted.has(d.name) ? 1 : null,
        image: LISTENER_IMAGE,
      })),
    }),
    'GET /v1/workloads': () =>
      runners.flatMap((id) => {
        const phase = phases.get(id) ?? 0;
        if (phase === 1) phases.set(id, 2);
        return phase === 2
          ? []
          : [
              {
                id,
                session: 'bm-abc12',
                state: phase ? 'terminated' : 'running',
                vmCount: 1,
                cleanedAt: null,
              },
            ];
      }),
    ...Object.fromEntries(
      runners.map((id) => [
        `DELETE /v1/workloads/${id}`,
        () => (calls.push(`terminate ${id}`), phases.set(id, 1), {}),
      ]),
    ),
    'GET /v1/secrets': () =>
      secrets
        .filter((org) => !deleted.has(`secret backmesh-${org}`))
        .map((org) => ({
          name: `backmesh-${org}`,
          createdAt: 0,
          updatedAt: 0,
        })),
  });
  const lines: string[] = [];
  // Each backmesh.com call's Authorization header.
  const bearers: (string | null)[] = [];
  const questions: string[] = [];
  const refreshable: string[] = [];
  const confirms = [...(tty?.confirm ?? [])];
  const deps: UninstallDeps = {
    // No saved anycloud files, whatever this machine holds.
    env: { BACKMESH_ANYCLOUD_DIR: mkdtempSync(join(tmpdir(), 'backmesh-')) },
    run,
    runLong: run,
    // In `calls` too, to order it against the binary's steps.
    command: async (args) => {
      calls.push(`cloud ${args.join(' ')}`);
      return cloud.command(args);
    },
    ui: {
      print: (line) => lines.push(line),
      ...(tty && {
        confirm: async (question: string) => {
          questions.push(question);
          return confirms.shift() ?? false;
        },
        ask: async (question: string) => {
          questions.push(question);
          return tty.typed;
        },
      }),
    },
    api: (apiUrl, _token, _fetch, refresh) => {
      if (refresh) refreshable.push(apiUrl);
      return api;
    },
    fetch: async (url, init) => {
      const { host, pathname } = new URL(String(url));
      const method = init?.method ?? 'GET';
      if (host === 'api.backmesh.com') {
        // In `calls` too, to order the cleanup against the binary's steps.
        calls.push(`${method} ${pathname}`);
        bearers.push(new Headers(init?.headers).get('authorization'));
        return worker.fetch(url, init);
      }
      if (host !== 'c1.anycloud.sh') {
        if (method === 'DELETE') calls.push(`github DELETE ${pathname}`);
        // One GitHub org fake answers for every org.
        return github.fetch(
          String(url).replace(/\/orgs\/[^/]+\//, '/orgs/acme/'),
          init,
        );
      }
      return answers
        ? Response.json({ version: '0.1.73' })
        : Promise.reject(new TypeError('fetch failed'));
    },
    wait: async () => undefined,
    features: RELEASED,
    sleep: async () => undefined,
  };
  return {
    deps,
    calls,
    lines,
    questions,
    refreshable,
    worker,
    bearers,
    github,
  };
}

const scripted: UninstallOptions = {
  org: 'acme',
  yes: true,
  deleteCheckpointBucket: true,
  confirm: 'backmesh',
};

const changes = (calls: string[]) =>
  calls.filter((c) =>
    /^(exec backmesh-\w+ POST|POST \/v1\/installs\/cleanup|github DELETE|deployment (delete|upgrade)|api access|node-pool delete|cluster delete|credentials delete|secrets delete)/.test(
      c,
    ),
  );

describe('uninstall', () => {
  it('signs in, drains and deletes the listener, cleans up GitHub, deletes the cloud side, then removes the App', async () => {
    const { deps, calls, lines, refreshable, worker, bearers, github } =
      setUp();
    const result = await uninstall(scripted, deps);

    expect(changes(calls)).toEqual([
      // The sign-in, with the listener's install key, before any change.
      'POST /v1/installs/cleanup',
      'exec backmesh-acme POST /drain',
      'deployment delete backmesh-acme',
      'api access remove --service-account backmesh-acme',
      ...GITHUB_DELETES,
      'POST /v1/installs/cleanup/finish',
      'secrets delete backmesh-acme',
      'node-pool delete np-1',
      'node-pool delete np-2',
      // Through the hosted API, which deletes itself and its connections.
      DELETE_HOSTED,
    ]);
    expect(calls.some((c) => c.startsWith('api use'))).toBe(false);
    expect(result).toEqual({
      orgs: [{ org: 'acme', appRemoved: true }],
      apiUrl: HOSTED,
      clusterId: 'c1',
      checkpointBucket: 'deleted',
      cloud: 'deleted',
    });
    // The hosted API's saved token can go stale, so its client refreshes it.
    expect(refreshable).toEqual([HOSTED]);
    expect(worker.calls).toEqual([
      'POST /v1/installs/device',
      'POST /v1/installs/cleanup',
      'POST /v1/installs/cleanup/finish',
    ]);
    expect(worker.bodies).toEqual([
      { device_code: 'dev-3584e1', org: 'acme' },
      { cleanup_id: CLEANUP_ID },
    ]);
    // Its admin check keeps no token, so it asks only for read:org.
    expect(worker.devices).toEqual([{ control_plane: false }]);
    expect(bearers).toEqual([null, `Bearer ${INSTALL_KEY}`, null]);
    // Only backmesh's runners go.
    expect([...github.runners.values()]).toEqual(['build-box', 'bmaster-ci']);
    expect(lines).toContain(
      'Sign in with GitHub as an admin of acme, so backmesh removes itself from acme: open https://github.com/login/device and enter ABCD-1234.',
    );
    expect(lines).toContain('Removed the backmesh GitHub App from acme.');
    expect(lines.join('\n')).not.toContain('ghs_');
    expect(lines[0]).toMatch(/1 running job will fail/);
    // anycloud's delete keeps what install made in each cloud it connected:
    // a role connection's setup, which is printed, and our CI's generated
    // identity, here from before 0.4.1, which uninstall deletes once its
    // connection went with the control plane.
    expect(lines).toContain(
      "aws's role connection setup is left in the account it ran in. It trusts only this control plane, which is gone; delete it in aws's console.",
    );
    expect(lines).toContain(
      "Deleted gcp's identity anycloud-bm-gcp, which install generated, from the project gcp's CLI is signed in to.",
    );
    const deletes = calls.filter((c) =>
      /^cloud gcloud iam service-accounts delete|^cluster delete/.test(c),
    );
    expect(deletes).toEqual([
      DELETE_HOSTED,
      'cloud gcloud iam service-accounts delete anycloud-bm-gcp@p1.iam.gserviceaccount.com --project p1 --quiet',
    ]);
  });

  it.each([
    [
      { answers: false },
      "The control plane at https://c1.anycloud.sh doesn't answer",
      'backmesh-l8u5e-*',
    ],
    // Without the control plane's ID, any install's group.
    [
      { url: 'http://localhost:8080' },
      'This machine has no backmesh control plane configured',
      'backmesh-*-*',
    ],
  ])(
    'removes backmesh from GitHub only when the control plane is gone: %o',
    async (options, why, groups) => {
      const { deps, calls, lines, bearers, github } = setUp(options);
      const result = await uninstall(
        { org: 'acme', yes: true, deleteCheckpointBucket: false },
        deps,
      );

      expect(changes(calls)).toEqual([
        'POST /v1/installs/cleanup',
        ...GITHUB_DELETES,
        'POST /v1/installs/cleanup/finish',
      ]);
      // No install key to send.
      expect(bearers).toEqual([null, null, null]);
      expect(lines).toContain(
        `Removed backmesh's scale sets, runners and runner groups ${groups} from acme.`,
      );
      // The shared group from before per-install names stays.
      expect([...github.groups.values()]).toEqual(['Default', 'backmesh']);
      expect(result).toEqual({
        orgs: [{ org: 'acme', appRemoved: true }],
        cloud: 'skipped',
      });
      expect(lines).toContainEqual(
        expect.stringMatching(
          new RegExp(
            `^${why.replace(/[.]/g, '\\.')}, so nothing in your clouds was deleted\\. The control plane's VMs, the runners' VMs, the checkpoint bucket`,
          ),
        ),
      );
      // Every cloud's role setup, since no connection can be read.
      expect(
        lines.filter((l) => /role connection setup is left/.test(l)),
      ).toHaveLength(3);
    },
  );

  it('deletes a control plane that does not answer through the cloud CLI, given --control-plane', async () => {
    const { deps, calls, lines } = setUp({ answers: false });
    const result = await uninstall(
      { ...scripted, controlPlane: 'aws:us-east-2', confirm: 'c1' },
      deps,
    );
    expect(changes(calls)).toEqual([
      // The seed's guards first, deleting nothing, before any change.
      'cluster delete c1 --cloud aws --region us-east-2 --json',
      'POST /v1/installs/cleanup',
      ...GITHUB_DELETES,
      'POST /v1/installs/cleanup/finish',
      'cluster delete c1 --cloud aws --region us-east-2 --delete-vms --delete-buckets --confirm c1 --json',
    ]);
    expect(result).toEqual({
      orgs: [{ org: 'acme', appRemoved: true }],
      clusterId: 'c1',
      cloud: 'deleted',
      checkpointBucket: 'deleted',
    });
    expect(lines[0]).toBe(
      "Uninstalling backmesh from acme's GitHub. The control plane at https://c1.anycloud.sh doesn't answer, so its cloud side is deleted through your cloud CLI.",
    );

    // What anycloud couldn't delete is named, as `DeleteEntry` has it; a
    // kept bucket is a note, and a harmless entry isn't listed.
    const left = setUp({ answers: false });
    const run = left.deps.runLong;
    left.deps.runLong = async (args) =>
      args[1] === 'delete'
        ? (left.calls.push(args.join(' ')),
          JSON.stringify({
            remaining: [
              {
                kind: 'cloudResource',
                type: 'vm',
                id: 'i-0abc',
                selector: 'anycloud_cluster=c1',
                reason: 'failed',
              },
              {
                kind: 'cloudResource',
                type: 'identity',
                id: 'anycloud-c1-cfn',
              },
              {
                kind: 'cloudResource',
                type: 'firewall',
                id: 'fw-1',
                reason: 'harmless',
              },
              { kind: 'checkpointBucket', name: 'c1', reason: 'kept' },
              { kind: 'managementVm', id: 'i-0vm' },
              { kind: 'dnsRecord', name: 'c1.anycloud.sh' },
            ],
          }))
        : run(args);
    await uninstall(
      {
        org: 'acme',
        yes: true,
        deleteCheckpointBucket: false,
        controlPlane: 'aws:us-east-2',
      },
      left.deps,
    );
    expect(left.calls).toContain(
      'cluster delete c1 --cloud aws --region us-east-2 --delete-vms --confirm c1 --json',
    );
    expect(left.lines).toContain(
      'Still in your cloud, to delete in its console: vm anycloud_cluster=c1, identity anycloud-c1-cfn, control plane VM i-0vm.',
    );
    expect(left.lines).toContainEqual(
      expect.stringMatching(/^backmesh kept the DNS record c1\.anycloud\.sh/),
    );
    expect(left.lines).toContain(
      "The checkpoint bucket is kept, with the control plane's backups. Delete it in your cloud's console once you no longer need them.",
    );
  });

  it('says how to delete a control plane that does not answer, and refuses --control-plane for one that does', async () => {
    const gone = setUp({ answers: false });
    await uninstall(
      { org: 'acme', yes: true, deleteCheckpointBucket: false },
      gone.deps,
    );
    expect(gone.lines).toContainEqual(
      expect.stringContaining(
        'Run uninstall again with --control-plane <cloud>:<region> of its control plane to delete them through your cloud CLI.',
      ),
    );

    const answering = setUp();
    await expect(
      uninstall({ ...scripted, controlPlane: 'aws:us-east-2' }, answering.deps),
    ).rejects.toThrow("--control-plane is only for one that doesn't");
    expect(changes(answering.calls)).toEqual([]);

    // Refused by the seed's guards: nothing changes, GitHub included.
    const running = setUp({ answers: false });
    const run = running.deps.runLong;
    running.deps.runLong = async (args) => {
      if (args[1] === 'delete') {
        running.calls.push(args.join(' '));
        throw new Error(
          'cluster delete failed: The management VM i-0abc is running (MANAGEMENT_VM_RUNNING)',
        );
      }
      return run(args);
    };
    await expect(
      uninstall(
        { ...scripted, controlPlane: 'aws:us-east-2', confirm: 'c1' },
        running.deps,
      ),
    ).rejects.toThrow(
      "backmesh won't delete c1 through your cloud CLI, so nothing was deleted: cluster delete failed: The management VM i-0abc is running",
    );
    expect(changes(running.calls)).toEqual([
      'cluster delete c1 --cloud aws --region us-east-2 --json',
    ]);

    // A failed or mid-delete installation, such as an AWS stack whose VM is
    // gone, is refused only without --delete-vms: the delete goes on.
    for (const status of ['failed', 'in-progress']) {
      const failed = setUp({ answers: false });
      const failedRun = failed.deps.runLong;
      failed.deps.runLong = async (args) => {
        if (args[1] === 'delete' && !args.includes('--delete-vms')) {
          failed.calls.push(args.join(' '));
          throw new Error(
            `cluster delete failed: Cluster c1's installation is ${status} (management VM i-0abc is gone); delete it with --delete-vms once its API is gone (MANAGEMENT_VM_RUNNING)`,
          );
        }
        return failedRun(args);
      };
      await uninstall(
        { ...scripted, controlPlane: 'aws:us-east-2', confirm: 'c1' },
        failed.deps,
      );
      expect(changes(failed.calls).at(-1)).toBe(
        'cluster delete c1 --cloud aws --region us-east-2 --delete-vms --delete-buckets --confirm c1 --json',
      );
      if (status === 'failed') {
        const asked = setUp({
          answers: false,
          tty: { confirm: [true, false], typed: 'c1' },
        });
        asked.deps.runLong = failed.deps.runLong;
        const { questions } = asked;
        await expect(
          uninstall(
            {
              org: 'acme',
              yes: false,
              deleteCheckpointBucket: false,
              controlPlane: 'aws:us-east-2',
            },
            asked.deps,
          ),
        ).rejects.toThrow('cancelled');
        expect(questions.at(-1)).toContain(
          'backmesh says the installation is failed (management VM i-0abc is gone).',
        );
      }
    }

    // With no control plane targeted, --control-plane has no ID to delete.
    const none = setUp({ url: 'http://localhost:8080' });
    await expect(
      uninstall({ ...scripted, controlPlane: 'aws:us-east-2' }, none.deps),
    ).rejects.toThrow('--control-plane has no cluster ID to delete');
    expect(changes(none.calls)).toEqual([]);
  });

  it('hedges what may be left when the control plane is gone, and names our CI identities', async () => {
    const customer = setUp({ answers: false });
    const gone = { org: 'acme', yes: true, deleteCheckpointBucket: false };
    await uninstall(gone, customer.deps);
    expect(customer.lines).toContain(
      "aws's role connection setup is left in the account it ran in, if install connected it. It trusts only this control plane, which is gone; delete it in aws's console.",
    );

    const ci = setUp({ answers: false });
    ci.deps.env.BACKMESH_UNSUPPORTED_CI_OVERRIDE = 'anycloud-ci';
    await uninstall(gone, ci.deps);
    // Named for the control plane, and from before 0.4.1, and not deleted:
    // it may still answer.
    expect(
      ci.lines
        .filter((l) =>
          / is left in your cloud, if install generated it/.test(l),
        )
        .map((l) => l.split(' ')[2]),
    ).toEqual(
      (['aws', 'gcp', 'azure'] as const).flatMap((cloud) => [
        `anycloud-${connectionName(cloud, 'c1')}`,
        `anycloud-bm-${cloud}`,
      ]),
    );
    expect(ci.calls.some((c) => c.startsWith('cloud '))).toBe(false);

    // Without the control plane's ID, its name is unknown.
    const unknown = setUp({ url: 'http://localhost:8080' });
    unknown.deps.env.BACKMESH_UNSUPPORTED_CI_OVERRIDE = 'anycloud-ci';
    await uninstall(gone, unknown.deps);
    expect(unknown.lines).toContain(
      "aws's identity anycloud-bm-aws-<6 characters> is left in your cloud, if install generated it; delete it in aws's console.",
    );
  });

  it("deletes our CI's identities after deleting a control plane that does not answer through the cloud CLI", async () => {
    const names = (['aws', 'gcp', 'azure'] as const).map(
      (cloud) => `anycloud-${connectionName(cloud, 'c1')}`,
    );
    const cloud = fakeCloud(names);
    const { deps, calls, lines } = setUp({ answers: false, cloud });
    deps.env.BACKMESH_UNSUPPORTED_CI_OVERRIDE = 'anycloud-ci';
    await uninstall(
      { ...scripted, controlPlane: 'aws:us-east-2', confirm: 'c1' },
      deps,
    );
    expect(cloud.live.size).toBe(0);
    // One from before 0.4.1 is named, not deleted: it may be another's.
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^aws's identity anycloud-bm-aws is left in your cloud, if install generated it\. [^]*--user-name anycloud-bm-aws$/,
      ),
    );
    expect(
      calls.findIndex((c) => c.startsWith('cloud aws iam delete-user ')),
    ).toBeGreaterThan(calls.findIndex((c) => c.includes('--delete-vms')));
    expect(lines.filter((l) => l.startsWith('Deleted '))).toHaveLength(3);
  });

  it('asks before a GitHub-only uninstall at a terminal', async () => {
    const { deps, calls, questions } = setUp({
      answers: false,
      tty: { confirm: [false], typed: '' },
    });
    await expect(
      uninstall(
        { org: 'acme', yes: false, deleteCheckpointBucket: false },
        deps,
      ),
    ).rejects.toThrow(/cancelled; nothing was deleted/);
    expect(questions).toEqual([
      "The control plane at https://c1.anycloud.sh doesn't answer, so uninstall removes backmesh from acme's GitHub only and deletes nothing in your clouds. Continue?",
    ]);
    expect(changes(calls)).toEqual([]);
  });

  it('refuses an anycloud without the seed or C28, before any change', async () => {
    const { deps, calls } = setUp();
    deps.features = { ...RELEASED, c26: undefined, c28: '9.0.0' };
    await expect(uninstall(scripted, deps)).rejects.toThrow(
      'lacks c26, c28, which uninstall needs',
    );
    expect(changes(calls)).toEqual([]);
  });

  it('needs a matching --confirm to delete the bucket without a terminal', async () => {
    for (const [confirm, message] of [
      [undefined, /--confirm c1/],
      ['c2', /c2 is neither backmesh nor c1/],
    ] as const) {
      const { deps, calls } = setUp();
      await expect(uninstall({ ...scripted, confirm }, deps)).rejects.toThrow(
        message,
      );
      expect(changes(calls)).toEqual([]);
    }
    const { deps } = setUp();
    await expect(
      uninstall({ ...scripted, confirm: 'c1' }, deps),
    ).resolves.toMatchObject({
      checkpointBucket: 'deleted',
    });
  });

  it('keeps the bucket unless confirmed and forwards the ID', async () => {
    const kept = setUp();
    const result = await uninstall(
      { org: 'acme', yes: true, deleteCheckpointBucket: false },
      kept.deps,
    );
    expect(kept.calls).toContain('cluster delete c1 --json');
    expect(result.checkpointBucket).toBe('kept');
    expect(kept.lines).toContain(
      "The checkpoint bucket is kept, with the control plane's backups. Delete it in your cloud's console once you no longer need them.",
    );

    const gone = setUp();
    await uninstall(scripted, gone.deps);
    expect(gone.calls).toContain(DELETE_HOSTED);
  });

  it('asks at a terminal: the bucket, the typed value, then the uninstall', async () => {
    const { deps, calls, questions } = setUp({
      tty: { confirm: [true, true], typed: 'c1' },
    });
    await uninstall(
      { org: 'acme', yes: false, deleteCheckpointBucket: false },
      deps,
    );
    expect(questions).toEqual([
      expect.stringMatching(/^Delete the checkpoint bucket too\?/),
      expect.stringMatching(
        /^Type the installation's name \(backmesh\) or ID \(c1\)/,
      ),
      'Uninstall backmesh from acme and delete its control plane? 1 running job will fail.',
    ]);
    expect(calls).toContain(DELETE_HOSTED);
  });

  it('terminates runner VM Jobs the drain left and waits for their VMs before the cluster goes', async () => {
    const { deps, calls } = setUp({ runners: ['bmabc12-a4-00000001'] });
    await uninstall(scripted, deps);
    const at = (line: string) => calls.indexOf(line);
    expect(at('terminate bmabc12-a4-00000001')).toBeGreaterThan(-1);
    expect(at('terminate bmabc12-a4-00000001')).toBeLessThan(at(DELETE_HOSTED));
  });

  it('deletes nothing when the user says no at a terminal', async () => {
    const { deps, calls } = setUp({
      tty: { confirm: [true, false], typed: 'backmesh' },
    });
    await expect(
      uninstall(
        { org: 'acme', yes: false, deleteCheckpointBucket: false },
        deps,
      ),
    ).rejects.toThrow(/cancelled; nothing was deleted/);
    expect(changes(calls)).toEqual([]);
  });

  it('stops before step 1 when the drain fails', async () => {
    const { deps, calls } = setUp({
      drained: { ...DONE, state: 'failed', error: 'Error: API down' },
    });
    await expect(uninstall(scripted, deps)).rejects.toThrow(
      /couldn't drain its runners: Error: API down\. It has stopped taking jobs and stays stopped until uninstall runs again/,
    );
    expect(changes(calls)).toEqual([
      'POST /v1/installs/cleanup',
      'exec backmesh-acme POST /drain',
    ]);
  });

  it('stops before any change when the sign-in fails or is refused', async () => {
    for (const [worker, message, changed] of [
      [
        fakeWorker({
          cleanups: [
            Response.json(
              { error: 'GitHub sign-in failed: expired_token' },
              { status: 400 },
            ),
          ],
        }),
        'GitHub sign-in failed: expired_token',
        ['POST /v1/installs/cleanup'],
      ],
      [
        fakeWorker({
          cleanups: [
            Response.json(
              {
                error: 'Uninstalling backmesh from acme needs its admin role.',
              },
              { status: 403 },
            ),
          ],
        }),
        'needs its admin role',
        ['POST /v1/installs/cleanup'],
      ],
      [
        fakeWorker({ device: new TypeError('fetch failed') }),
        "Couldn't reach backmesh.com for the GitHub sign-in",
        [],
      ],
    ] as const) {
      const { deps, calls } = setUp({ worker });
      await expect(uninstall(scripted, deps)).rejects.toThrow(message);
      expect(changes(calls)).toEqual(changed);
    }
  });

  it('stops before the cloud side when GitHub still lists something', async () => {
    const { deps, calls } = setUp({ github: fakeOrg({ stickyRunner: true }) });
    await expect(uninstall(scripted, deps)).rejects.toThrow(
      "GitHub still lists runner bm0a1b2-a4-k3j9x0qz, runner group backmesh-l8u5e-k3j9x0 in acme. The cloud side wasn't deleted; run `backmesh uninstall --org acme` again.",
    );
    expect(changes(calls)).not.toContain('node-pool delete np-1');
    expect(changes(calls)).not.toContain('POST /v1/installs/cleanup/finish');
  });

  it("re-mints a token that won't last the GitHub cleanup, without a second sign-in", async () => {
    const worker = fakeWorker({
      cleanups: [
        Response.json({
          token: 'ghs_7',
          expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
          org: { id: 7, login: 'acme' },
          cleanup_id: CLEANUP_ID,
        }),
      ],
    });
    const { deps, github } = setUp({ worker });
    await uninstall(scripted, deps);
    expect(worker.calls).toEqual([
      'POST /v1/installs/device',
      'POST /v1/installs/cleanup',
      'POST /v1/installs/cleanup/token',
      'POST /v1/installs/cleanup/finish',
    ]);
    expect(
      new Set(
        github.calls
          .filter((c) => c.url.pathname.startsWith('/orgs/'))
          .map((c) => c.headers.get('authorization')),
      ),
    ).toEqual(new Set(['token ghs_8']));
  });

  it('goes on without a GitHub cleanup when the App was never installed', async () => {
    const worker = fakeWorker({
      cleanups: [
        Response.json({
          token: null,
          expires_at: null,
          org: { id: 7, login: 'acme' },
          cleanup_id: CLEANUP_ID,
        }),
      ],
    });
    const { deps, calls, lines } = setUp({ worker });
    await uninstall(scripted, deps);
    expect(changes(calls).filter((c) => c.startsWith('github'))).toEqual([]);
    expect(calls).toContain(DELETE_HOSTED);
    expect(lines).toContain(
      "The backmesh GitHub App isn't installed on acme, so backmesh can't reach its runners there. Check the org's Actions settings for runner groups backmesh-l8u5e-*.",
    );
  });

  it('reports an App another install keeps, and a failed removal', async () => {
    const kept = setUp({
      worker: fakeWorker({
        cleanups: [
          Response.json({ pending: true }, { status: 202 }),
          Response.json({
            token: 'ghs_7',
            expires_at: '2100-01-01T00:00:00Z',
            org: { id: 7, login: 'acme' },
            cleanup_id: CLEANUP_ID,
          }),
        ],
        finishes: [Response.json({ removed: false, still_used_by: ['i2'] })],
      }),
    });
    await expect(uninstall(scripted, kept.deps)).resolves.toMatchObject({
      orgs: [{ org: 'acme', appRemoved: false }],
    });
    expect(kept.lines).toContain(
      'The backmesh GitHub App stays on acme, which its installs i2 still use.',
    );

    const failed = setUp({
      worker: fakeWorker({
        finishes: [
          Response.json(
            { error: 'GitHub kept the installation: 500' },
            { status: 502 },
          ),
        ],
      }),
    });
    await expect(uninstall(scripted, failed.deps)).rejects.toThrow(
      /couldn't remove its GitHub App from acme: .*GitHub kept the installation: 500.*Run `backmesh uninstall --org acme` again/,
    );
    // The cloud side waits for every org's removal.
    expect(failed.calls).not.toContain(DELETE_HOSTED);
  });

  it('refuses an org the listener does not serve, before any change', async () => {
    const { deps, calls } = setUp();
    await expect(
      uninstall({ ...scripted, org: 'globex' }, deps),
    ).rejects.toThrow(
      `There's no backmesh for globex on ${HOSTED}. Its orgs are acme.`,
    );
    expect(changes(calls)).toEqual([]);
  });

  it('tolerates a few failed reads of the drain', async () => {
    const { deps, calls } = setUp({
      reads: [new Error('exec failed'), new Error('exec failed')],
    });
    await expect(uninstall(scripted, deps)).resolves.toMatchObject({});
    expect(calls).toContain(DELETE_HOSTED);

    // A good read restarts the count.
    const err = new Error('exec failed');
    const flaky = setUp({
      reads: [err, err, { ...DONE, state: 'running' }, err, err],
    });
    await expect(uninstall(scripted, flaky.deps)).resolves.toMatchObject({});

    const down = setUp({ reads: Array(3).fill(new Error('exec failed')) });
    await expect(uninstall(scripted, down.deps)).rejects.toThrow(
      /didn't answer 3 times in a row/,
    );
    expect(changes(down.calls)).toEqual([
      'POST /v1/installs/cleanup',
      'exec backmesh-acme POST /drain',
    ]);
  });

  it('says to rerun when the listener restarts mid-drain', async () => {
    const { deps, calls } = setUp({ reads: [null] });
    await expect(uninstall(scripted, deps)).rejects.toThrow(
      /restarted during the drain.*run uninstall again/,
    );
    expect(changes(calls)).toEqual([
      'POST /v1/installs/cleanup',
      'exec backmesh-acme POST /drain',
    ]);
  });

  it('resumes past step 1 when an earlier run removed the listener', async () => {
    const { deps, calls, bearers } = setUp({ listener: false });
    await uninstall(scripted, deps);
    expect(changes(calls)).toEqual([
      'POST /v1/installs/cleanup',
      'api access remove --service-account backmesh-acme',
      ...GITHUB_DELETES,
      'POST /v1/installs/cleanup/finish',
      'secrets delete backmesh-acme',
      'node-pool delete np-1',
      'node-pool delete np-2',
      DELETE_HOSTED,
    ]);
    // No listener, no key to send.
    expect(bearers[1]).toBeNull();
  });

  it('removes one org of several and keeps the control plane', async () => {
    const { deps, calls, lines } = setUp({ orgs: ['acme', 'beta'] });
    const result = await uninstall({ ...scripted, org: 'Beta' }, deps);

    expect(changes(calls)).toEqual([
      'POST /v1/installs/cleanup',
      'exec backmesh-beta POST /drain',
      'deployment delete backmesh-beta',
      'api access remove --service-account backmesh-beta',
      ...githubDeletes('beta'),
      'POST /v1/installs/cleanup/finish',
      'secrets delete backmesh-beta',
    ]);
    expect(calls).not.toContain('exec backmesh-acme /status');
    expect(result).toEqual({
      orgs: [{ org: 'beta', appRemoved: true }],
      apiUrl: HOSTED,
      clusterId: 'c1',
      cloud: 'kept',
    });
    expect(lines[0]).toBe(
      'Uninstalling backmesh from beta; the control plane stays. 1 running job will fail.',
    );
  });

  it('removes every org, one sign-in each, before the cloud side', async () => {
    const { deps, calls } = setUp({ orgs: ['acme', 'beta'] });
    const { org: _, ...whole } = scripted;
    await uninstall(whole, deps);

    const steps = changes(calls).filter((c) => !c.startsWith('github'));
    expect(steps).toEqual([
      'POST /v1/installs/cleanup',
      'exec backmesh-acme POST /drain',
      'deployment delete backmesh-acme',
      'api access remove --service-account backmesh-acme',
      'POST /v1/installs/cleanup/finish',
      'secrets delete backmesh-acme',
      'POST /v1/installs/cleanup',
      'exec backmesh-beta POST /drain',
      'deployment delete backmesh-beta',
      'api access remove --service-account backmesh-beta',
      'POST /v1/installs/cleanup/finish',
      'secrets delete backmesh-beta',
      'node-pool delete np-1',
      'node-pool delete np-2',
      DELETE_HOSTED,
    ]);
  });

  it("finishes an org's removal past its listener's delete", async () => {
    const { deps, calls, bearers } = setUp({ secrets: ['acme', 'beta'] });
    await uninstall({ ...scripted, org: 'beta' }, deps);
    // Nothing of acme's is touched, and beta's sign-in has no key.
    expect(changes(calls)).toEqual([
      'POST /v1/installs/cleanup',
      'api access remove --service-account backmesh-beta',
      ...githubDeletes('beta'),
      'POST /v1/installs/cleanup/finish',
      'secrets delete backmesh-beta',
    ]);
    expect(bearers[1]).toBeNull();
  });

  it('refuses an org that has no backmesh here, changing nothing', async () => {
    const typo = setUp({ orgs: ['acme', 'beta'], secrets: [] });
    await expect(
      uninstall({ ...scripted, org: 'acmee' }, typo.deps),
    ).rejects.toThrow(
      `There's no backmesh for acmee on ${HOSTED}. Its orgs are acme, beta.`,
    );
    expect(changes(typo.calls)).toEqual([]);
  });

  it('runs the whole path for --org when no listener runs, whatever is left', async () => {
    // A listener that crashed or was never per org: no backmesh-<org>
    // Deployment or Secret. Only the sign-in names the org.
    // An older listener runs as another Deployment on `bm-control`.
    const { deps, calls, bearers, lines } = setUp({
      listener: false,
      secrets: ['github-app'],
      others: [
        { name: 'backmesh', managed: false },
        { name: 'bm-job', managed: true },
      ],
    });
    await expect(
      uninstall({ ...scripted, org: 'acme' }, deps),
    ).resolves.toMatchObject({
      orgs: [{ org: 'acme', appRemoved: true }],
      cloud: 'deleted',
    });
    expect(changes(calls)).toEqual([
      'POST /v1/installs/cleanup',
      'api access remove --service-account backmesh-acme',
      // Stopped before the GitHub cleanup; anycloud's managed one stays.
      'deployment delete backmesh',
      ...GITHUB_DELETES,
      'POST /v1/installs/cleanup/finish',
      'node-pool delete np-1',
      'node-pool delete np-2',
      DELETE_HOSTED,
    ]);
    // No key to send.
    expect(bearers[1]).toBeNull();
    // With --org and no listener, a leftover Secret is only a note.
    expect(lines).toContain(
      'Secrets left: backmesh-github-app (deleted with the control plane).',
    );
  });

  it('needs --org when the control plane is gone, and says nothing is left without one', async () => {
    const gone = setUp({ answers: false });
    const { org: _, ...whole } = scripted;
    await expect(uninstall(whole, gone.deps)).rejects.toThrow(
      /can't read which orgs it served\. Nothing was deleted; pass --org <org>/,
    );
    expect(changes(gone.calls)).toEqual([]);

    // Every listener gone, as after an earlier run: the cloud side only.
    const rerun = setUp({ listener: false, secrets: [] });
    await expect(uninstall(whole, rerun.deps)).resolves.toMatchObject({
      orgs: [],
      cloud: 'deleted',
    });

    // No listener and no --org: a Secret left by a run that stopped after
    // its listener went fails the run.
    const orphan = setUp({ listener: false, secrets: ['beta'] });
    await expect(uninstall(whole, orphan.deps)).rejects.toThrow(
      'run `backmesh uninstall --org beta` to finish.',
    );

    // One org's Secret left by a run that stopped: named, and exits non-zero.
    const stopped = setUp({ orgs: ['acme'], secrets: ['acme', 'beta'] });
    await expect(uninstall(whole, stopped.deps)).rejects.toThrow(
      'An earlier uninstall may have stopped before it finished beta at GitHub. If that is an org, run `backmesh uninstall --org beta` to finish.',
    );
    expect(stopped.calls).toContain(DELETE_HOSTED);

    // Likewise with --org for the last listener, as CI runs it.
    const last = setUp({ orgs: ['acme'], secrets: ['acme', 'beta'] });
    await expect(uninstall(scripted, last.deps)).rejects.toThrow(
      'run `backmesh uninstall --org beta` to finish.',
    );
  });

  it('resumes an org whose GitHub cleanup failed after its listener went, with --org', async () => {
    const first = setUp({
      orgs: ['acme', 'beta'],
      github: fakeOrg({ stickyRunner: true }),
    });
    await expect(
      uninstall({ ...scripted, org: 'beta' }, first.deps),
    ).rejects.toThrow('run `backmesh uninstall --org beta` again');
    // The Secret stays as the mark for the rerun.
    expect(changes(first.calls)).not.toContain('secrets delete backmesh-beta');

    const rerun = setUp({ orgs: ['acme'], secrets: ['acme', 'beta'] });
    await expect(
      uninstall({ ...scripted, org: 'beta' }, rerun.deps),
    ).resolves.toMatchObject({ cloud: 'kept' });
    expect(changes(rerun.calls)).toContain('secrets delete backmesh-beta');
    expect(rerun.calls).not.toContain(DELETE_HOSTED);
  });

  it('matches --org whatever its case', async () => {
    const { deps, calls } = setUp({ orgs: ['acme', 'beta'] });
    await uninstall({ ...scripted, org: 'ACME' }, deps);
    expect(changes(calls)[1]).toBe('exec backmesh-acme POST /drain');
    expect(calls).not.toContain(DELETE_HOSTED);
  });

  it("prints every cloud's leftovers when the hosted API can't list its connections", async () => {
    const leftovers = async (env: NodeJS.ProcessEnv) => {
      const { deps, lines } = setUp({ hostedList: false });
      Object.assign(deps.env, env);
      await uninstall(scripted, deps);
      return lines.filter((l) => / is left in /.test(l));
    };
    // A customer's role setups; our CI's generated identities.
    expect((await leftovers({})).map((l) => l.split("'")[0])).toEqual([
      'aws',
      'gcp',
      'azure',
    ]);
    expect(
      (await leftovers({})).every((l) => /role connection setup/.test(l)),
    ).toBe(true);
    // Our CI's, named for the control plane, are deleted: here none is.
    const { deps, lines } = setUp({ hostedList: false });
    deps.env.BACKMESH_UNSUPPORTED_CI_OVERRIDE = 'anycloud-ci';
    await uninstall(scripted, deps);
    expect(lines.filter((l) => / isn't in the /.test(l))).toEqual(
      (['aws', 'gcp', 'azure'] as const).map((cloud) =>
        expect.stringMatching(
          `^${cloud}'s identity anycloud-${connectionName(cloud, 'c1')} isn't in the`,
        ),
      ),
    );
  });

  it("removes each identity's grants before the identity", () => {
    const gcp = leftoverIdentity('gcp', 'bm-gcp').split('\n').slice(1);
    expect(gcp).toHaveLength(1);
    expect(gcp[0]).toMatch(
      /SA=anycloud-bm-gcp@\$PROJECT\.iam\.gserviceaccount\.com; for role in roles\/compute\.instanceAdmin\.v1 roles\/compute\.securityAdmin roles\/storage\.admin; do gcloud projects remove-iam-policy-binding .*; done; gcloud iam service-accounts delete "\$SA"/,
    );
    const azure = leftoverIdentity('azure', 'bm-azure').split('\n').slice(1);
    expect(azure[0]).toMatch(
      /az ad app list --display-name anycloud-bm-azure --query .*; do az role assignment delete --assignee "\$app" --scope .*; az ad app delete --id "\$app"; done$/,
    );
    // One line each that parses, with nothing to fill in.
    for (const cloud of ['aws', 'gcp', 'azure'] as const) {
      const left = leftoverIdentity(cloud, connectionName(cloud, 'c1'));
      expect(left).not.toMatch(/<|>/);
      for (const line of left.split('\n').slice(1)) {
        expect(() =>
          execFileSync('bash', ['-n', '-c', line.trim()]),
        ).not.toThrow();
      }
    }
  });
});
