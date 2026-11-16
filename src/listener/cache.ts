// The cache's tokens: each runner's own
// Secret, `pending` at submit, `ready` with scoped tokens minted at
// JobStarted, renewed every 10 minutes until its Job ends or 10 minutes after
// JobCompleted (the upload after the job), then deleted.
import { ORPCError } from '@orpc/client';

import type { AnycloudApi } from '../anycloud/client.js';
import {
  bucketName,
  refPrefix,
  SECRET_KEY,
  secretName,
  type CacheFile,
  type RefLabel,
} from '../cache/format.js';
import type { Log } from '../github/retry.js';
import type { JobMessage } from '../github/types.js';
import type { RunFacts } from '../github/runs.js';
import type { Route } from './routes.js';
import { COMPLETED_GRACE_MS } from './scaler.js';
import { sweepBuckets, type SweptBucket } from './sweep.js';

const RENEW_MS = 10 * 60_000;
const RETRY_MS = 30_000;
// A Secret this old whose runner Job isn't listed is an orphan.
const ORPHAN_MS = 10 * 60_000;
const DAY = 24 * 3_600_000;

export type Refs = Partial<Record<RefLabel, string>>;

const PR_EVENTS = [
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
];
const EVENTS = new Set([
  ...PR_EVENTS,
  'push',
  'merge_group',
  'workflow_dispatch',
  'schedule',
]);

// Own, base and default, from GitHub's message and run, never the job's.
export function deriveRefs(
  job: Pick<
    JobMessage,
    'eventName' | 'jobWorkflowRef' | 'ownerName' | 'repositoryName'
  >,
  run: RunFacts,
): Refs {
  const refs: Refs = { default: `refs/heads/${run.defaultBranch}` };
  const repo = `${job.ownerName}/${job.repositoryName}`.toLowerCase();
  const [workflow = '', ref = ''] = job.jobWorkflowRef.split(/@(?=[^@]*$)/);
  const [owner, name, ...path] = workflow.split('/');
  const reusable = path.join('/') !== run.path;
  const pr = Number(/^refs\/pull\/(\d+)\/merge$/.exec(ref)?.[1]);
  const listed = run.pullRequests.find((p) => p.number === pr);
  const isPr = PR_EVENTS.includes(job.eventName);
  const queued =
    /^refs\/heads\/gh-readonly-queue\/(.+)\/pr-\d+-[0-9a-f]+$/.exec(ref);
  if (job.eventName === 'merge_group' && queued)
    refs.base = `refs/heads/${queued[1]}`;
  if (isPr && listed) refs.base = `refs/heads/${listed.baseRef}`;
  if (!EVENTS.has(job.eventName) || `${owner}/${name}`.toLowerCase() !== repo)
    return refs;
  // A fork's pull request reads only, in every repository: its writes could
  // evict the default branch's entries.
  const fork = run.headRepository?.toLowerCase() !== repo;
  if (isPr) {
    return pr && !fork && (!reusable || listed) ? { ...refs, own: ref } : refs;
  }
  const short = /^refs\/(heads|tags)\/(.+)$/.exec(ref)?.[2];
  const ok =
    short === run.headBranch &&
    run.headRepository?.toLowerCase() === repo &&
    !(reusable && ref.startsWith('refs/tags/'));
  return ok ? { ...refs, own: ref } : refs;
}

export interface CacheDeps {
  api: AnycloudApi;
  install: string;
  // Swept daily.
  buckets: readonly SweptBucket[];
  run(owner: string, repo: string, runId: number): Promise<RunFacts>;
  // Where a started runner's VM is.
  region(runner: string): Promise<string | null>;
  log: Log;
  now?: () => number;
}

interface Runner {
  name: string;
  savedAt: number;
  // `at`: when the listener heard JobStarted.
  job?: { route: Route; message: JobMessage; at: number };
  // Its first `ready` save is logged, with the time from JobStarted.
  ready?: true;
  grants?: { region: string; bucket: string; refs: Refs };
  next?: number;
  completedAt?: number;
  listed?: boolean;
  // Saves for one runner run one at a time, and none after its Job ended.
  chain: Promise<void>;
  busy?: boolean;
  ended?: boolean;
}

export class CacheTokens {
  private readonly runners = new Map<string, Runner>();
  // Default branches' ref prefixes, which the sweep keeps longest.
  private readonly defaults = new Set<string>();
  private sweptAt = -Infinity;

  constructor(private readonly deps: CacheDeps) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  private warn(msg: string, runner: string, error: unknown) {
    this.deps.log({ msg, runner, error: String(error) });
  }

  private save(runner: Runner, file: CacheFile): Promise<void> {
    const step = runner.chain.then(async () => {
      if (runner.ended) return;
      await this.deps.api.saveSecret({
        params: { name: secretName(runner.name) },
        body: { values: { [SECRET_KEY]: JSON.stringify(file) } },
      });
    });
    runner.chain = step.catch(() => undefined);
    return step;
  }

  // Before a runner's submit: its Secret, which the Job then names. Without
  // it the Job is submitted with none and its job uses GitHub's cache.
  async prepare(name: string): Promise<string[] | undefined> {
    const runner = { name, savedAt: this.now(), chain: Promise.resolve() };
    const saved = await this.save(runner, { v: 1, state: 'pending' }).then(
      () => this.runners.set(name, runner),
      (error: unknown) => this.warn('cache secret not saved', name, error),
    );
    return saved ? [secretName(name)] : undefined;
  }

  // After any save in flight, so a mint that lands late can't bring the
  // Secret back.
  private async end(runner: Runner): Promise<void> {
    runner.ended = true;
    this.runners.delete(runner.name);
    await runner.chain;
    await this.remove(runner.name);
  }

  started(route: Route, message: JobMessage): void {
    const runner = this.runners.get(message.runnerName);
    // Another listener's, one with no Secret, or a redelivery.
    if (!runner || runner.job) return;
    runner.job = { route, message, at: this.now() };
    void this.mint(runner);
  }

  completed(name: string): void {
    const runner = this.runners.get(name);
    if (runner) runner.completedAt ??= this.now();
  }

  // Each reconcile, with the listed runner Jobs' names: due renewals, ends
  // and the daily sweeps.
  async tick(listed: ReadonlySet<string>): Promise<void> {
    const now = this.now();
    for (const runner of [...this.runners.values()]) {
      if (listed.has(runner.name)) runner.listed = true;
      // Gone from the listing, or never listed (a refused or lost submit).
      else if (runner.listed || now - runner.savedAt > ORPHAN_MS) {
        await this.end(runner);
        continue;
      }
      const over = now - (runner.completedAt ?? now) >= COMPLETED_GRACE_MS;
      if (!over && runner.next !== undefined && runner.next <= now)
        void this.mint(runner);
    }
    if (now - this.sweptAt < DAY) return;
    this.sweptAt = now;
    void sweepBuckets(
      this.deps.api,
      this.deps.buckets,
      this.deps.log,
      undefined,
      undefined,
      this.defaults,
    );
    // This installation's Secrets whose runner Job is gone, past 10 minutes.
    const prefix = secretName(`bm${this.deps.install}-`);
    const secrets = await this.deps.api.listSecrets({}).catch(() => []);
    for (const { name, updatedAt } of secrets) {
      const runner = name.slice(secretName('').length);
      if (
        name.startsWith(prefix) &&
        !listed.has(runner) &&
        !this.runners.has(runner) &&
        now - updatedAt > ORPHAN_MS
      )
        await this.remove(runner);
    }
  }

  // A failure is retried by the daily sweep.
  private async remove(name: string): Promise<void> {
    await this.deps.api
      .deleteSecret({ params: { name: secretName(name) }, query: {} })
      .catch((error: unknown) =>
        this.warn('cache secret not deleted', name, error),
      );
  }

  private async grants({ name, job }: Runner) {
    const m = job!.message;
    const region = await this.deps.region(name);
    if (!region) throw new Error('no region yet');
    const run = await this.deps.run(
      m.ownerName,
      m.repositoryName,
      m.workflowRunId,
    );
    const refs = deriveRefs(m, run);
    for (const label of Object.keys(refs) as RefLabel[])
      refs[label] = refPrefix(run.repoId, refs[label]!);
    this.defaults.add(refs.default!);
    return { region, bucket: bucketName(this.deps.install, region), refs };
  }

  // A refused mint (a 4xx but a 401 or a version mismatch) turns the cache
  // off for this runner; anything else is retried in 30 seconds.
  private async mint(runner: Runner): Promise<void> {
    if (runner.busy) return;
    runner.busy = true;
    runner.next = undefined;
    try {
      const { region, bucket, refs } = (runner.grants ??=
        await this.grants(runner));
      // Own first; a prefix two refs share is granted once.
      const prefixes = [
        ...new Set(
          [refs.own, refs.base, refs.default].filter((p) => p !== undefined),
        ),
      ];
      const response = await this.deps.api.mintStorageTokens({
        params: { credentialName: runner.job!.route.credentials },
        query: { region },
        body: {
          lifetimeSeconds: 900,
          grants: prefixes.map((prefix) =>
            prefix === refs.own
              ? { bucket, prefix, mode: 'readwrite', noDelete: true }
              : { bucket, prefix, mode: 'read' },
          ),
        },
      });
      const tokens = response.tokens.map(
        ({ grants, expiresAt, credentials }) => ({
          prefixes: grants.map((i) => prefixes[i]!),
          expiresAt,
          credentials,
        }),
      );
      const m = runner.job!.message;
      await this.save(runner, {
        v: 1,
        state: 'ready',
        cloud: runner.job!.route.cloud,
        bucket,
        ...('region' in response && { region: response.region }),
        ...('accountUrl' in response && { accountUrl: response.accountUrl }),
        prefixes: refs,
        tokens,
        expiresAt: Math.min(...tokens.map((t) => t.expiresAt)),
        job: {
          workflow: m.jobWorkflowRef.replace(/@[^@]*$/, ''),
          name: m.jobDisplayName,
        },
      });
      runner.next = this.now() + RENEW_MS;
      if (!runner.ready) {
        runner.ready = true;
        // The runner's restores wait for this.
        this.deps.log({
          msg: 'cache token ready',
          runner: runner.name,
          ms: this.now() - runner.job!.at,
        });
      }
    } catch (error) {
      const refused =
        error instanceof ORPCError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 401 &&
        error.code !== 'CLIENT_VERSION_MISMATCH';
      const off = {
        v: 1 as const,
        state: 'off' as const,
        reason: String(refused && error.code),
      };
      if (refused) await this.save(runner, off).catch(() => undefined);
      else runner.next = this.now() + RETRY_MS;
      this.warn(
        refused ? 'cache token refused' : 'cache token retry',
        runner.name,
        error,
      );
    } finally {
      runner.busy = false;
    }
  }
}
