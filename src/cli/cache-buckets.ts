// The cache's buckets: one per runner
// region, named for the installation, made by install and upgrade before the
// listener starts or rolls (it mints for every route region), and deleted by
// uninstall.
import { ORPCError } from '@orpc/client';

import type { AnycloudApi } from '../anycloud/client.js';
import { bucketName } from '../cache/format.js';
import { cacheBuckets } from '../listener/sweep.js';
import type { Route } from '../listener/routes.js';
import {
  CLOUDS,
  type Cloud,
  type CloudTarget,
  type RunnerClass,
} from '../runners/classes.js';
import { verboseDetail } from './prerequisites.js';

type Api = Pick<
  AnycloudApi,
  'createBucket' | 'deleteBucket' | 'listBuckets' | 'mintStorageTokens'
>;

// The credential's own buckets: `createBucket` adopts any it can reach.
async function owned(api: Api, credentialName: string): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.listBuckets({
      params: { credentialName },
      query: cursor ? { cursor } : {},
    });
    names.push(...page.buckets.map((b) => b.name));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return names;
}

// Thrown by `ensureBucket` when the bucket name is already taken by
// another account: deterministic, so `allowedRegions`' retry doesn't
// bother (it would just fail the same way again) and doesn't wrap this
// message, which is already specific, into a vaguer one.
class BucketOwnershipError extends Error {}

// One region's bucket: created if missing, confirmed the account's own,
// and minted for the cache to read. Shared by `ensureCacheBuckets`'s every
// route region and `allowedRegions`'s probe of each candidate, so a bucket
// either one creates is fully set up and the other finds it already there.
// `done` tracks completion (through the mint) per bucket name, seeded with
// whichever this credential already owned before this call so a
// pre-existing bucket still skips the mint entirely, as before
// ("creates and test-mints only missing buckets", `cache-buckets.spec.ts`).
// It's kept separate from `owned_`, which several buckets' calls can
// refresh concurrently (`allowedRegions`), so that a retry after this
// bucket's own partial failure (created, not minted) redoes only the
// mint, and isn't fooled by a sibling bucket's refresh of `owned_` into
// either redoing the creation or skipping the mint it still needs.
async function ensureBucket(
  api: Api,
  credentialName: string,
  bucket: string,
  region: string,
  owned_: Map<string, string[]>,
  done: Set<string>,
): Promise<void> {
  if (done.has(bucket)) return;
  if (!owned_.get(credentialName)!.includes(bucket)) {
    await api.createBucket({
      params: { credentialName, bucketName: bucket },
      query: { region },
    });
    const now = await owned(api, credentialName);
    owned_.set(credentialName, now);
    if (!now.includes(bucket))
      throw new BucketOwnershipError(
        `The cache bucket ${bucket} belongs to another account, so the cache can't use it. Delete it there, then run this again.`,
      );
  }
  await api.mintStorageTokens({
    params: { credentialName },
    query: { region },
    body: {
      lifetimeSeconds: 60,
      grants: [{ bucket, prefix: 'cache/', mode: 'read' }],
    },
  });
  done.add(bucket);
}

// Each missing bucket, checked to be the account's own and to mint, so a
// credential that can't fails here, not in every job.
export async function ensureCacheBuckets(
  api: Api,
  install: string,
  routes: readonly Route[],
  print: (line: string) => void,
): Promise<void> {
  const owned_ = new Map<string, string[]>();
  const done = new Map<string, Set<string>>();
  for (const { credentialName, bucket, region } of cacheBuckets(
    install,
    routes,
  )) {
    if (!owned_.has(credentialName)) {
      const now = await owned(api, credentialName);
      owned_.set(credentialName, now);
      done.set(credentialName, new Set(now));
    }
    const before = owned_.get(credentialName)!.includes(bucket);
    await ensureBucket(
      api,
      credentialName,
      bucket,
      region,
      owned_,
      done.get(credentialName)!,
    );
    if (!before) print(`Created the cache bucket ${bucket}.`);
  }
}

/**
 * Each of `candidates` this credential can use: its cache bucket created or
 * already there, checked concurrently. A region a cloud policy (an AWS
 * SCP, GCP's resource-locations org policy or Azure Policy) or a narrower
 * permission denies is skipped and named, with the underlying error under
 * `--verbose`, since anycloud's `createBucket` doesn't distinguish the two
 * — both are a 403 (owner, 2026-11-13). Any other failure (a network
 * error, a 429 or 5xx, a timeout) retries once rather than skipping the
 * region, which would wrongly treat a transient problem as a denial; a
 * second failure stops with a clear message instead of a raw error.
 * Refuses only when none of `candidates` is allowed; an empty list is
 * nothing to check.
 */
export async function allowedRegions(
  api: Api,
  install: string,
  credentialName: string,
  candidates: readonly string[],
  print: (line: string) => void,
  verbose = false,
): Promise<string[]> {
  if (!candidates.length) return [];
  const initial = await owned(api, credentialName);
  const owned_ = new Map<string, string[]>([[credentialName, initial]]);
  const done = new Set(initial);
  const results = await Promise.all(
    candidates.map(async (region) => {
      const bucket = bucketName(install, region);
      // Two attempts, classified the same way each time: a 403 on
      // either one skips and names the region (the retry can turn up a
      // 403 too, after a first failure that wasn't one), the deterministic
      // ownership conflict never retries, and anything else gets one
      // retry before stopping with a clear message. `done` (shared with
      // `ensureBucket`) only gets this bucket once the mint after it
      // succeeds, so the retry redoes only whichever of creating,
      // confirming or minting didn't finish — and, since `done` is never
      // touched by another region's own concurrent attempt, isn't fooled
      // by one of theirs refreshing `owned_` in the meantime.
      let last: unknown;
      for (let tries = 0; tries < 2; tries++) {
        try {
          await ensureBucket(api, credentialName, bucket, region, owned_, done);
          return region;
        } catch (error) {
          if (error instanceof ORPCError && error.status === 403) {
            print(
              `Skipping ${region}: your organization's policy denies it, or the credential lacks permission there.${verboseDetail(error, verbose)}`,
            );
            return undefined;
          }
          // Deterministic: a retry would just fail the same way, wrapping
          // this already-specific message in a vaguer one.
          if (error instanceof BucketOwnershipError) throw error;
          last = error;
        }
      }
      throw new Error(
        `Couldn't check whether ${credentialName} can use ${region}: ${last instanceof Error ? last.message : String(last)}. Run this again.`,
        { cause: last },
      );
    }),
  );
  const allowed = results.filter((region): region is string => !!region);
  if (!allowed.length) {
    throw new Error(
      `${credentialName} isn't allowed to use any of its runner regions (${candidates.join(', ')}). Check its permissions, then run this again.`,
    );
  }
  return allowed;
}

/**
 * `classes`, narrowed to the regions `allowedRegions` confirms for each of
 * `targets`' clouds. A label `live` already runs that this would leave
 * with no region — unexpected, since every `RUNNER_REGIONS` candidate
 * offers every type (`classes.ts`), so this can only mean its cloud's
 * allowed set shrank to exclude exactly its regions while leaving others
 * for the same cloud — stops install or upgrade rather than silently
 * queuing that label's jobs forever; one that doesn't exist yet is just
 * dropped and named (owner, 2026-11-13).
 */
export async function withAllowedRegions(
  api: Api,
  install: string,
  targets: readonly CloudTarget[],
  classes: readonly RunnerClass[],
  live: ReadonlySet<string>,
  print: (line: string) => void,
  verbose = false,
): Promise<RunnerClass[]> {
  // Each target's a different cloud with its own credential, so their
  // checks run concurrently, same as the regions within each one.
  const allowedByCloud = new Map<Cloud, string[]>(
    await Promise.all(
      targets.map(async (target) => {
        const candidates = [
          ...new Set(
            classes
              .filter((c) => c.cloud === target.cloud)
              .flatMap((c) => c.regions),
          ),
        ];
        const allowed = await allowedRegions(
          api,
          install,
          target.credentials,
          candidates,
          print,
          verbose,
        );
        return [target.cloud, allowed] as const;
      }),
    ),
  );
  return classes.flatMap((c) => {
    const regions = c.regions.filter((r) =>
      (allowedByCloud.get(c.cloud) ?? []).includes(r),
    );
    if (regions.length) return [{ ...c, regions }];
    if (live.has(c.label)) {
      throw new Error(
        `${c.label} would start no runners: every region it offers is denied, though ${c.cloud} has others allowed. Nothing changed; check your organization's policy, then run this again.`,
      );
    }
    print(
      `${c.label} would start no runners: every region it offers is denied.`,
    );
    return [];
  });
}

// Uninstall, after the drain: every cache bucket of this installation, through
// each cloud's `bm-<cloud>` connection still there; a failure is named and
// uninstall goes on.
export async function deleteCacheBuckets(
  api: Api,
  install: string,
  print: (line: string) => void,
): Promise<void> {
  const prefix = bucketName(install, '');
  for (const cloud of CLOUDS) {
    const credentialName = `bm-${cloud}`;
    try {
      for (const bucket of (await owned(api, credentialName)).filter((b) =>
        b.startsWith(prefix),
      )) {
        await api.deleteBucket({
          params: { credentialName, bucketName: bucket },
          query: { region: bucket.slice(prefix.length) },
        });
        print(`Deleted the cache bucket ${bucket}.`);
      }
    } catch (error) {
      if (error instanceof ORPCError && error.status === 404) continue;
      print(
        `Couldn't remove the cache buckets through ${credentialName} (${error instanceof Error ? error.message : String(error)}). Delete any bucket named ${prefix}<region> in ${cloud} by hand; it holds only cache entries.`,
      );
    }
  }
}
