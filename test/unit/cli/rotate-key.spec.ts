import { describe, expect, it } from 'vitest';

import { anycloudControl } from '../../../src/app/anycloud.js';
import { WorkerUnreachable } from '../../../src/cli/worker.js';
import { rollListener } from '../../../src/cli/converge.js';
import { UsageError } from '../../../src/cli/errors.js';
import {
  reason,
  rotateKey,
  type RotateKeyDeps,
} from '../../../src/cli/rotate-key.js';
import { readListener } from '../../../src/cli/status.js';
import {
  fakeApi,
  fakeBinary,
  fakeExec,
  fakeWorker,
  listenerVm,
  githubOrg,
  INSTALL_KEY,
  DEVICE,
  GITHUB_TOKEN,
  NEXT_DEVICE,
  SIGNED_IN,
} from './fakes.js';

const HOSTED = 'https://c1.anycloud.sh';
const IMAGE = `ghcr.io/backmesh/backmesh-listener@sha256:${'b'.repeat(64)}`;
const RUNNER_IMAGE = `ghcr.io/backmesh/backmesh-runner@sha256:${'a'.repeat(64)}`;
const RUNNERS = JSON.stringify([
  {
    label: 'backmesh-4',
    cloud: 'aws',
    vmTypes: ['m7g.xlarge'],
    regions: ['us-east-2'],
  },
]);
const NEW_INSTALL = 'cd'.repeat(16);
const NEW_KEY = `bmk_${NEW_INSTALL}${'ef'.repeat(16)}`;
const NEWER_INSTALL = '12'.repeat(16);
const NEWER_KEY = `bmk_${NEWER_INSTALL}${'34'.repeat(16)}`;
const OLD_INSTALL = INSTALL_KEY.slice(4, 36);
const VM = 'bml-l8u5e-aaaaaa';
const GROUP = 'backmesh-l8u5e-k3j9x0';
const TOKEN = 'acapi_service';
// The values a roll's command writes, base64 in it (`rollCommand`).
const rolledValues = (command: string) => {
  const b64 = /printf %s '([^']*)' \| base64 -d/.exec(command)?.[1];
  if (b64 === undefined) return undefined;
  return Object.fromEntries(
    Buffer.from(b64, 'base64')
      .toString()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const i = line.indexOf('=');
        return [line.slice(0, i), line.slice(i + 1)];
      }),
  );
};

// Shared, mutable state across one or more `rotateKey` calls, standing in
// for the control plane: the Secret (what a `PUT /v1/secrets` call wrote)
// and the listener's own environment (what a `/status` exec reads), which
// only moves to match once a roll's exec actually succeeds — never on a failed one, and never just because the Secret was
// saved (clearing the marker is a plain Secret save, no roll). This is what
// makes a true rerun (the same `deps` simply called again, no new fixture)
// meaningful to test.
function fixture({
  // 'down': the listener doesn't answer; 'no-key': no install key yet;
  // 'before-vm-jobs': no runner classes Secret.
  listener = 'ok' as 'ok' | 'down' | 'no-key' | 'before-vm-jobs',
  // Where it runs: its VM, a VM anycloud found gone, or still a
  // Deployment on `bm-control`.
  host = 'vm' as 'vm' | 'lost' | 'deployment',
  missing = false,
  revokes,
  installs,
  // A roll that reports success without the listener actually picking up
  // the new values — permanently, unless `catchUpAt` is also given.
  stuck = false,
  // 1-indexed, across every `/status` read this fixture ever makes
  // (including a later `rotateKey` call reusing it): from here on, the
  // listener's env reflects the Secret's current values regardless of
  // `stuck`, modelling an eventual restart a later rerun's own read
  // catches.
  catchUpAt,
  // 1-indexed, across every roll this fixture ever makes: which one fails.
  failRollAt,
  // Seeds the listener as already mid-rotation, as if an earlier process had
  // minted `newKey` and rolled it, recording `oldInstall` to revoke —
  // standing in for "a previous `rotateKey` run got this far".
  preRotating,
}: {
  listener?: 'ok' | 'down' | 'no-key' | 'before-vm-jobs';
  host?: 'vm' | 'lost' | 'deployment';
  missing?: boolean;
  revokes?: (Response | Error)[];
  installs?: (Response | Error)[];
  stuck?: boolean;
  catchUpAt?: number;
  failRollAt?: number;
  preRotating?: { newKey: string; oldInstall: string };
} = {}) {
  const calls: string[] = [];
  const lines: string[] = [];
  const order: string[] = [];
  let podKey: string | undefined =
    listener === 'no-key' ? undefined : (preRotating?.newKey ?? INSTALL_KEY);
  let podRotatingFrom: string | undefined = preRotating?.oldInstall;
  let secretKey = podKey;
  let secretRotatingFrom = podRotatingFrom;
  let execs = 0;
  let rolls = 0;
  const binary = fakeBinary({
    'api status --json': JSON.stringify({ url: HOSTED }),
    'api token': 't0ken',
  });
  const run = async (args: string[]) => {
    calls.push(args.join(' '));
    return binary.run(args);
  };
  const id = host === 'deployment' ? 'dep-acme' : VM;
  const { exec } = fakeExec((target, command) => {
    if (target !== id) return new Error('Workload or Deployment not found');
    const values = rolledValues(command);
    if (values) {
      rolls++;
      calls.push(`roll ${target}`);
      order.push(`roll#${rolls}`);
      if (failRollAt === rolls) {
        return { code: 1, stdout: '', stderr: `rollout #${rolls} failed\n` };
      }
      if (!stuck) {
        podKey = values.BACKMESH_INSTALL_KEY;
        podRotatingFrom = values.BACKMESH_ROTATING_FROM;
      }
      return '';
    }
    execs++;
    order.push(`exec#${execs}`);
    if (listener === 'down') return new Error('exec failed');
    if (catchUpAt !== undefined && execs >= catchUpAt) {
      podKey = secretKey;
      podRotatingFrom = secretRotatingFrom;
    }
    return JSON.stringify({
      code: 200,
      env: {
        ORG: 'acme',
        ORG_ID: '7',
        BACKMESH_RUNNER_IMAGE: RUNNER_IMAGE,
        BACKMESH_LISTENER_IMAGE: IMAGE,
        BACKMESH_RUNNER_GROUP: GROUP,
        ANYCLOUD_API_TOKEN: TOKEN,
        ...(podKey && { BACKMESH_INSTALL_KEY: podKey }),
        ...(listener !== 'before-vm-jobs' && { BACKMESH_RUNNERS: RUNNERS }),
        ...(podRotatingFrom && { BACKMESH_ROTATING_FROM: podRotatingFrom }),
      },
      body: {
        installed: true,
        broker: null,
        runners: 0,
        cap: 500,
        scaleSets: [],
      },
    });
  });
  const onPool = host === 'deployment' && !missing;
  const routes = {
    'GET /v1/node-pools': {
      nodePools: onPool
        ? [
            {
              id: 'np-1',
              name: 'bm-control',
              state: 'running',
              allowPrivilegedJobs: false,
              cloudProvider: 'AWS',
              region: 'us-east-2',
            },
          ]
        : [],
    },
    'GET /v1/deployments': {
      deployments: onPool
        ? [
            {
              id: 'dep-acme',
              name: 'backmesh-acme',
              managed: false,
              nodePoolId: 'np-1',
              deletedAt: null,
              image: IMAGE,
            },
          ]
        : [],
    },
    'GET /v1/workloads':
      missing || host === 'deployment'
        ? []
        : [
            listenerVm('acme', VM, {
              state: host === 'lost' ? 'failed' : 'running',
            }),
          ],
    'GET /v1/secrets': [{ name: 'backmesh-acme', createdAt: 1, updatedAt: 1 }],
    'PUT /v1/secrets/backmesh-acme': (body: string) => {
      order.push('secret');
      const { values } = JSON.parse(body) as {
        values: Record<string, string>;
      };
      secretKey = values.BACKMESH_INSTALL_KEY;
      secretRotatingFrom = values.BACKMESH_ROTATING_FROM;
      return {};
    },
  };
  const { api, requests } = fakeApi(routes);
  const worker = fakeWorker({
    installs: installs ?? [
      Response.json({
        org_id: 7,
        org: 'acme',
        install: NEW_INSTALL,
        key: NEW_KEY,
      }),
    ],
    // The first code expires before anyone enters it.
    codes: [Response.json(DEVICE), Response.json(NEXT_DEVICE)],
    polls: [Response.json({ error: 'expired_token' }), GITHUB_TOKEN],
    ...(revokes && { revokes }),
  });
  const deps: RotateKeyDeps = {
    env: {},
    run,
    runLong: run,
    print: (line) => lines.push(line),
    signInLogin: async () => 'octocat',
    api: () => api,
    exec: () => exec,
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/installs/revoke') order.push('revoke');
      return /^https:\/\/(api\.backmesh\.com|github\.com)\//.test(String(url))
        ? worker.fetch(url, init)
        : String(url).startsWith('https://api.github.com/')
          ? githubOrg(new URL(String(url)).pathname)
          : Response.json({ version: '0.1.73' });
    },
    wait: async () => {},
  };
  return {
    deps,
    calls,
    requests,
    lines,
    worker,
    order,
    api,
    exec,
    secretKey: () => secretKey,
    secretRotatingFrom: () => secretRotatingFrom,
    // What the listener's own environment (not just the Secret) shows —
    // the one place a rerun, or `upgrade`, actually reads from.
    podRotatingFrom: () => podRotatingFrom,
  };
}

const rolled = (calls: string[]) => calls.includes(`roll ${VM}`);
// No raw install IDs (32 hex characters) in any user-visible line.
const noInstallIds = (lines: string[]) =>
  lines.every((l) => !/[0-9a-f]{32}/.test(l));
// Each sign-in's purpose: one followed by `POST /v1/installs` mints a key;
// a plain sign-in doesn't.
const purposes = ({
  calls,
  signedIn,
}: Pick<ReturnType<typeof fakeWorker>, 'calls' | 'signedIn'>) => {
  const out: string[] = [];
  let pending = false;
  calls.forEach((call, i) => {
    if (signedIn.includes(i)) {
      if (pending) out.push('sign-in');
      pending = true;
    }
    if (call === 'POST /v1/installs' && pending) {
      out.push('install');
      pending = false;
    }
  });
  if (pending) out.push('sign-in');
  return out;
};
// The fixture's sign-in: the first code expires, and a fresh one follows.
const SIGN_IN_LINES = [
  expect.stringMatching(
    /^Sign in with GitHub as an owner of acme, to replace its install key: open https:\/\/github\.com\/login\/device and enter ABCD-1234 \(it expires at \d\d:\d\d UTC\)\.$/,
  ),
  expect.stringContaining('enter WXYZ-5678 (it expires at '),
];
const mints = (worker: Parameters<typeof purposes>[0]) =>
  purposes(worker).filter((p) => p === 'install').length;

describe('reason', () => {
  it('lowercases an ordinary sentence-initial capital and drops one trailing period', () => {
    expect(reason(new Error('The sign-in code expired.'), 'acme')).toBe(
      'the sign-in code expired',
    );
  });

  it('lowercases a lone capitalized word (not a 2-letter-or-more acronym)', () => {
    expect(reason(new Error('A sign-in failed'), 'acme')).toBe(
      'a sign-in failed',
    );
  });

  it('never doubles a period that was never there', () => {
    expect(reason(new Error('backmesh refused: unknown key'), 'acme')).toBe(
      'backmesh refused: unknown key',
    );
  });

  it('keeps a proper noun with an internal capital unchanged (GitHub)', () => {
    expect(
      reason(new Error('GitHub refused the sign-in: bad credentials'), 'acme'),
    ).toBe('GitHub refused the sign-in: bad credentials');
  });

  it('keeps a 2-or-more-letter all-caps acronym unchanged', () => {
    expect(reason(new Error('URL missing a scheme'), 'acme')).toBe(
      'URL missing a scheme',
    );
  });

  it('keeps a domain or path-like token (a dot) unchanged', () => {
    expect(reason(new Error('api.backmesh.com answered 500'), 'acme')).toBe(
      'api.backmesh.com answered 500',
    );
  });

  it("keeps the org's own name unchanged, in its own case, even though it's only one capital letter", () => {
    expect(
      reason(new Error("Acme's listener's roll to the image failed."), 'Acme'),
    ).toBe("Acme's listener's roll to the image failed");
  });

  it("reads the bare cause of an unreachable Worker, not reaching()'s own retry sentence", () => {
    const cause = new WorkerUnreachable('api.backmesh.com answered 500');
    const wrapped = new Error(
      "Couldn't reach backmesh.com for revoking the old install key (api.backmesh.com answered 500). Retry when backmesh.com is reachable.",
      { cause },
    );

    expect(reason(wrapped, 'acme')).toBe('api.backmesh.com answered 500');
  });

  it('stringifies a non-Error value', () => {
    expect(reason('oops', 'acme')).toBe('oops');
  });
});

describe('rotateKey', () => {
  it('signs in with the App’s device flow, on a fresh code once the first expires', async () => {
    const { deps, worker, lines } = fixture();

    const result = await rotateKey(deps, { org: 'acme' });

    expect(result).toEqual({ org: 'acme' });
    expect(worker.signIns()).toHaveLength(2);
    expect(lines.filter((l) => l.startsWith('Sign in'))).toEqual(SIGN_IN_LINES);
    expect(worker.bodies[0]).toEqual({ org: 'acme', github_token: SIGNED_IN });
  });

  it('signs in, mints, rolls, confirms, revokes the old install and clears the marker with a real roll, in that order, with no install IDs in any line', async () => {
    const {
      deps,
      calls,
      worker,
      lines,
      order,
      secretKey,
      secretRotatingFrom,
      podRotatingFrom,
    } = fixture();

    const result = await rotateKey(deps, { org: 'acme' });

    expect(result).toEqual({ org: 'acme' });
    expect(rolled(calls)).toBe(true);
    expect(purposes(worker)).toEqual(['install']);
    expect(worker.revoked).toEqual([
      { key: NEW_KEY, install: OLD_INSTALL, token: SIGNED_IN },
    ]);
    const secretIndex = order.indexOf('secret');
    const confirmIndex = order.indexOf('exec#3');
    const revokeIndex = order.indexOf('revoke');
    expect(secretIndex).toBeLessThan(confirmIndex);
    expect(confirmIndex).toBeLessThan(revokeIndex);
    // The marker is cleared only after the revoke.
    expect(secretKey()).toBe(NEW_KEY);
    expect(secretRotatingFrom()).toBeUndefined();
    // The listener's own environment is clean too (a real roll, not just a
    // Secret save), so a later rerun or `upgrade` never finds it stale.
    expect(podRotatingFrom()).toBeUndefined();
    // Two rolls on its VM: the mint's, then the marker-clearing one, each
    // after its Secret's save.
    expect(order.filter((e) => /^(roll|secret)/.test(e))).toEqual([
      'secret',
      'roll#1',
      'secret',
      'roll#2',
    ]);
    expect(calls.filter((c) => c.startsWith('roll'))).toEqual([
      `roll ${VM}`,
      `roll ${VM}`,
    ]);
    expect(noInstallIds(lines)).toBe(true);
    expect(lines).toEqual([
      `Signing in as an owner of acme to mint a new install key.`,
      ...SIGN_IN_LINES,
      `Rolling acme's listener onto the new key.`,
      `acme's listener runs on the new key; revoking the old install.`,
    ]);
  });

  it('succeeds silently when the clearing roll itself fails (the rotation is already complete)', async () => {
    const { deps, worker, lines, secretRotatingFrom, podRotatingFrom } =
      fixture({
        // The 2nd roll is the marker-clearing one.
        failRollAt: 2,
      });

    const result = await rotateKey(deps, { org: 'acme' });

    expect(result).toEqual({ org: 'acme' });
    expect(worker.revoked).toEqual([
      { key: NEW_KEY, install: OLD_INSTALL, token: SIGNED_IN },
    ]);
    // The rotation already succeeded (the revoke above did), and a stale
    // marker left by this failure is the `already` path's job on a later
    // run, so this failure gets no line of its own: the same progress
    // lines as the happy path, nothing more.
    expect(lines).toEqual([
      `Signing in as an owner of acme to mint a new install key.`,
      ...SIGN_IN_LINES,
      `Rolling acme's listener onto the new key.`,
      `acme's listener runs on the new key; revoking the old install.`,
    ]);
    // The clearing roll's own first save still landed (the restart is
    // what failed), so the Secret is clean; the listener's own env is what's
    // left stale, which is harmless: a later run finds the old install
    // already revoked and starts fresh (the "resuming" tests above cover
    // that path).
    expect(secretRotatingFrom()).toBeUndefined();
    expect(podRotatingFrom()).toBe(OLD_INSTALL);
  });

  it('wraps a sign-in failure as "rotation didn\'t finish", naming the old key as still working', async () => {
    const { deps } = fixture({ installs: [new Response('', { status: 500 })] });

    await expect(rotateKey(deps, { org: 'acme' })).rejects.toThrow(
      /^Rotation didn't finish: .*\. acme's old key still works; run `backmesh rotate-key --org acme` again\.$/s,
    );
  });

  it('wraps a roll failure the same way, naming no duplicate image, lowercased and with no double period', async () => {
    const { deps, secretKey, secretRotatingFrom } = fixture({
      failRollAt: 1,
    });

    const error = (await rotateKey(deps, { org: 'acme' }).catch(
      (e: unknown) => e,
    )) as Error;

    // rollListener's own message: no restore is attempted (retrying the
    // identical roll, same image, would only repeat the same failure), so
    // it just reports the failure, embedded with its own trailing period
    // dropped rather than doubled (`reason`'s capitalization handling is
    // covered on its own below, since this message happens to start
    // lowercase already).
    expect(error.message).toBe(
      "Rotation didn't finish: acme's listener's roll to " +
        IMAGE +
        " failed. acme's old key still works; run `backmesh rotate-key --org acme` again.",
    );
    // The image isn't named twice (rotate-key always rolls to the image
    // it's already on).
    expect(error.message.match(/ghcr\.io/g)).toHaveLength(1);
    expect(error.message).not.toMatch(/\.\./);
    expect(secretKey()).toBe(NEW_KEY);
    expect(secretRotatingFrom()).toBe(OLD_INSTALL);
  });

  it('wraps the listener never coming up on the new key the same way, with no install IDs', async () => {
    const { deps, worker, lines } = fixture({ stuck: true });

    await expect(rotateKey(deps, { org: 'acme' })).rejects.toThrow(
      "Rotation didn't finish: the listener didn't come up on the new key. acme's old key still works; run `backmesh rotate-key --org acme` again.",
    );

    expect(worker.revoked).toEqual([]);
    expect(noInstallIds(lines)).toBe(true);
  });

  it('retries a 429 revoke, then succeeds and clears the marker', async () => {
    const { deps, worker, secretRotatingFrom } = fixture({
      revokes: [
        Response.json(
          { error: 'Too many requests; retry later.' },
          { status: 429 },
        ),
        Response.json({ revoked: true }),
      ],
    });

    const result = await rotateKey(deps, { org: 'acme' });

    expect(result).toEqual({ org: 'acme' });
    expect(
      worker.calls.filter((c) => c === 'POST /v1/installs/revoke'),
    ).toHaveLength(2);
    expect(secretRotatingFrom()).toBeUndefined();
  });

  it('gives up on a revoke that keeps failing, naming the new-key state and no install IDs, leaving the marker set', async () => {
    const { deps, lines, secretRotatingFrom } = fixture({
      revokes: [new Response('', { status: 500 })],
    });

    await expect(rotateKey(deps, { org: 'acme' })).rejects.toThrow(
      /^acme's listener is on the new key, but the old key wasn't revoked: .*\. Run `backmesh rotate-key --org acme` again to finish\.$/s,
    );

    expect(noInstallIds(lines)).toBe(true);
    expect(secretRotatingFrom()).toBe(OLD_INSTALL);
  });

  describe('resuming an unfinished rotation', () => {
    it('picks up a marker already on the listener (as if a prior run minted and rolled it), mints nothing new, and revokes the recorded old install', async () => {
      const { deps, worker, secretRotatingFrom } = fixture({
        preRotating: { newKey: NEW_KEY, oldInstall: OLD_INSTALL },
      });

      const result = await rotateKey(deps, { org: 'acme' });

      expect(result).toEqual({ org: 'acme' });
      // A plain sign-in, never an install sign-in (which would mint).
      expect(purposes(worker)).toEqual(['sign-in']);
      expect(worker.revoked).toEqual([
        { key: NEW_KEY, install: OLD_INSTALL, token: SIGNED_IN },
      ]);
      expect(secretRotatingFrom()).toBeUndefined();
    });

    it('finishes the SAME rotation on a rerun after the revoke failed, minting only the one key across both runs', async () => {
      // The first run's 3 retries exhaust the three 500s; the rerun's
      // first attempt then gets the success left at the end.
      const first = fixture({
        revokes: [
          new Response('', { status: 500 }),
          new Response('', { status: 500 }),
          new Response('', { status: 500 }),
          Response.json({ revoked: true }),
        ],
      });

      await expect(rotateKey(first.deps, { org: 'acme' })).rejects.toThrow(
        /old key wasn't revoked/,
      );
      // The failed run minted exactly one key.
      expect(mints(first.worker)).toBe(1);
      expect(first.secretRotatingFrom()).toBe(OLD_INSTALL);

      // The same process state (Secret and Pod), rerun: a fresh `rotateKey`
      // call reusing the exact same `deps`, as a real rerun would reuse
      // the exact same listener and Secret.
      first.worker.revoked.length = 0;
      const result = await rotateKey(first.deps, { org: 'acme' });

      expect(result).toEqual({ org: 'acme' });
      // No second mint: only ever one 'install' sign-in, across both runs.
      expect(mints(first.worker)).toBe(1);
      // Revokes the ORIGINAL old install, not some intermediate one.
      expect(first.worker.revoked).toEqual([
        { key: NEW_KEY, install: OLD_INSTALL, token: SIGNED_IN },
      ]);
      expect(first.secretRotatingFrom()).toBeUndefined();
    });

    it("finishes the SAME rotation on a rerun after the listener didn't confirm in time, once it later catches up", async () => {
      // Stuck through the first run's start read and 3 confirm reads
      // (exec#2-5); caught up by exec#6, the rerun's own first read.
      const first = fixture({ stuck: true, catchUpAt: 6 });

      await expect(rotateKey(first.deps, { org: 'acme' })).rejects.toThrow(
        /didn't come up on the new key/,
      );
      expect(mints(first.worker)).toBe(1);
      expect(first.worker.revoked).toEqual([]);

      const result = await rotateKey(first.deps, { org: 'acme' });

      expect(result).toEqual({ org: 'acme' });
      // The rerun resumed: no second mint.
      expect(mints(first.worker)).toBe(1);
      expect(first.worker.revoked).toEqual([
        { key: NEW_KEY, install: OLD_INSTALL, token: SIGNED_IN },
      ]);
      expect(first.secretRotatingFrom()).toBeUndefined();
    });

    it('starts a fresh rotation instead of declaring success when a resumed revoke finds the old install already revoked (a stale marker)', async () => {
      // The Pod's env still shows the first rotation's marker (it hasn't
      // restarted since that rotation's own run cleared the Secret's
      // copy), so this run takes the resume branch; the Worker answers
      // `already: true`, and it must mint and roll a second time rather
      // than report success having rotated nothing — revoking the key the
      // stale resume attempt found already current (NEW_INSTALL), not the
      // original OLD_INSTALL a second time.
      const { deps, worker, secretKey, secretRotatingFrom } = fixture({
        preRotating: { newKey: NEW_KEY, oldInstall: OLD_INSTALL },
        installs: [
          Response.json({
            org_id: 7,
            org: 'acme',
            install: NEWER_INSTALL,
            key: NEWER_KEY,
            github_token: SIGNED_IN,
          }),
        ],
        revokes: [
          Response.json({ revoked: true, already: true }),
          Response.json({ revoked: true }),
        ],
      });

      const result = await rotateKey(deps, { org: 'acme' });

      expect(result).toEqual({ org: 'acme' });
      expect(purposes(worker)).toEqual(['sign-in', 'install']);
      expect(worker.revoked).toEqual([
        { key: NEW_KEY, install: OLD_INSTALL, token: SIGNED_IN },
        { key: NEWER_KEY, install: NEW_INSTALL, token: SIGNED_IN },
      ]);
      expect(secretKey()).toBe(NEWER_KEY);
      expect(secretRotatingFrom()).toBeUndefined();
    });

    it('signs in exactly once per rotation across rotate-key, an intervening upgrade roll, and rotate-key again, since the clearing roll leaves nothing for upgrade to carry through', async () => {
      const f = fixture({
        installs: [
          Response.json({
            org_id: 7,
            org: 'acme',
            install: NEW_INSTALL,
            key: NEW_KEY,
            github_token: SIGNED_IN,
          }),
          Response.json({
            org_id: 7,
            org: 'acme',
            install: NEWER_INSTALL,
            key: NEWER_KEY,
            github_token: SIGNED_IN,
          }),
        ],
      });

      const first = await rotateKey(f.deps, { org: 'acme' });
      expect(first).toEqual({ org: 'acme' });
      expect(mints(f.worker)).toBe(1);
      // The clearing roll (fix A) leaves the listener's own environment
      // clean, not just the Secret.
      expect(f.podRotatingFrom()).toBeUndefined();

      // upgrade.ts's own roll (upgrade.ts:396-421): reads the listener,
      // then rolls with `rotatingFrom: running.rotatingFrom` carried
      // through unexamined — the exact call this fix depends on, so a
      // clean marker here means upgrade carries through nothing.
      const name = 'backmesh-acme';
      const running = await readListener(f.exec, {
        vm: {
          id: VM,
          name,
          org: 'acme',
          cloud: 'aws',
          region: 'us-east-1',
          lost: false,
          others: [],
        },
      });
      const control = anycloudControl(f.api, f.deps.run);
      const base = {
        name,
        org: 'acme',
        orgId: 7,
        vm: VM,
        identity: {
          install: 'l8u5e',
          runnerGroup: GROUP,
          apiUrl: HOSTED,
          apiToken: TOKEN,
        },
        image: IMAGE,
        runnerImage: RUNNER_IMAGE,
        runners: RUNNERS,
      };
      await rollListener(
        base,
        {
          ...base,
          installKey: running.installKey!,
          rotatingFrom: running.rotatingFrom,
        },
        { control, exec: f.exec, again: 'upgrade', wait: async () => {} },
      );
      expect(f.podRotatingFrom()).toBeUndefined();

      const second = await rotateKey(f.deps, { org: 'acme' });

      expect(second).toEqual({ org: 'acme' });
      // One more mint for the second rotation: no stale-marker resume, no
      // double sign-in.
      expect(mints(f.worker)).toBe(2);
      expect(purposes(f.worker)).not.toContain('sign-in');
    });
  });

  it("refuses when there's no listener for the org", async () => {
    const { deps } = fixture({ missing: true });

    await expect(rotateKey(deps, { org: 'acme' })).rejects.toThrow(UsageError);
  });

  it('refuses a listener whose VM is gone, or still on bm-control: upgrade first', async () => {
    for (const host of ['lost', 'deployment'] as const) {
      const { deps, worker, calls } = fixture({ host });
      const error = await rotateKey(deps, { org: 'acme' }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(UsageError);
      expect((error as Error).message).toBe(
        `acme's listener ${host === 'lost' ? 'VM is gone' : 'still runs on bm-control'}; run \`backmesh upgrade\` first, then rotate-key.`,
      );
      expect(worker.calls).toEqual([]);
      expect(rolled(calls)).toBe(false);
    }
  });

  it("refuses when the listener doesn't answer", async () => {
    const { deps, worker } = fixture({ listener: 'down' });

    await expect(rotateKey(deps, { org: 'acme' })).rejects.toThrow(
      /didn't answer/,
    );
    expect(worker.calls).toEqual([]);
  });

  it('refuses a listener with no install key yet', async () => {
    const { deps, worker } = fixture({ listener: 'no-key' });

    await expect(rotateKey(deps, { org: 'acme' })).rejects.toThrow(UsageError);
    expect(worker.calls).toEqual([]);
  });

  it('refuses a listener from before VM Jobs', async () => {
    const { deps, worker } = fixture({ listener: 'before-vm-jobs' });

    await expect(rotateKey(deps, { org: 'acme' })).rejects.toThrow(UsageError);
    expect(worker.calls).toEqual([]);
  });
});
