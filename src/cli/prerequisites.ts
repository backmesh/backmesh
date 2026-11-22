// The prerequisites `install` and `upgrade` both check before they change
// anything: the pinned anycloud's features, the hosted API's
// version against the pin, the cloud CLIs' sign-ins, project and region, and a hosted API
// client that signs in again on a refused token. Each org's App is checked
// with `waitForApp` (`worker.ts`) once its install key is known.
import {
  anycloudApi,
  anycloudExec,
  apiTarget,
  type AnycloudApi,
  type AnycloudExec,
} from '../anycloud/client.js';
import {
  missingFeatures,
  newer,
  type Feature,
  type FeatureTable,
} from '../anycloud/features.js';
import type { Cloud, CloudTarget } from '../runners/classes.js';
import type { RunCommand } from '../runners/regions.js';
import { workerDeps, type WorkerDeps } from './worker.js';
import { UsageError } from './errors.js';
import { signInAgain, type SignInCheck } from './github-sign-in.js';

/** What both commands need of the pinned anycloud. */
const PINNED: Feature[] = [
  'release-1',
  'c26',
  'role-connections',
  'role-apply',
  // Each org's listener VM authenticates with one.
  'service-tokens',
];

export function checkPinned(version: string, features?: FeatureTable) {
  const missing = missingFeatures(version, PINNED, features);
  if (missing.length) {
    throw new Error(
      `This backmesh's control plane (${version}) lacks ${missing.join(', ')}, which backmesh needs.`,
    );
  }
}

/**
 * The hosted API against the pin. A newer one needs a newer backmesh; an
 * older one is `upgrade`'s to move, so install refuses it.
 */
export function checkHosted(
  hosted: string,
  pinned: string,
  command: 'install' | 'upgrade',
) {
  if (newer(hosted, pinned)) {
    throw new UsageError(
      'This control plane is ahead of this backmesh; install the latest backmesh release.',
    );
  }
  if (command === 'install' && newer(pinned, hosted)) {
    throw new UsageError(
      'This control plane is behind this backmesh; run `backmesh upgrade`, then install again.',
    );
  }
}

// The login each cloud needs, and the line that fixes a failed one. Azure's
// also selects the subscription, which a login with none fails.
// `api create` and the quota and region reads run through it, as the
// user.
export const LOGINS: Record<Cloud, [string[], string]> = {
  aws: [
    ['aws', 'sts', 'get-caller-identity', '--output', 'json'],
    "aws isn't signed in: run `aws sso login`.",
  ],
  gcp: [
    ['gcloud', 'auth', 'print-access-token'],
    "gcloud isn't signed in: run `gcloud auth login`.",
  ],
  azure: [
    ['az', 'account', 'show', '--output', 'json'],
    "az isn't signed in to a subscription: run `az login`.",
  ],
};

const CLI_NAME: Record<Cloud, string> = {
  aws: 'the AWS CLI',
  gcp: 'the Google Cloud CLI',
  azure: 'the Azure CLI',
};

export const NO_PROJECT =
  'gcloud has no project set: run `gcloud config set project <id>`.';

/** A cloud CLI's own error, indented under its line, with `--verbose` only. */
export const verboseDetail = (error: unknown, verbose = false) =>
  verbose
    ? `\n${(error instanceof Error ? error.message : String(error)).trim().replace(/^/gm, '  ')}`
    : '';

/**
 * The environment an AWS child runs with for a target: its region as
 * `AWS_REGION` unless the user set one there. anycloud's role connection
 * runs `aws cloudformation` with no `--region`, which an
 * AWS CLI without a default region refuses; the user's AWS config isn't
 * touched.
 */
export const regionEnv = (
  { cloud, region }: Pick<CloudTarget, 'cloud' | 'region'>,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv =>
  cloud === 'aws' && !env.AWS_REGION && !env.AWS_DEFAULT_REGION
    ? { AWS_REGION: region }
    : {};

// What a signed-in gcloud still needs: a project.
const noProject = (command: RunCommand) =>
  command(['gcloud', 'config', 'get-value', 'project']).then(
    (out) => (out.trim() ? undefined : NO_PROJECT),
    () => NO_PROJECT,
  );

/**
 * Each target cloud's CLI, before anything reads through it: on
 * PATH, signed in, and gcloud with its project set. `problems` adds one
 * line for each failure, and any is a usage error naming every fix.
 */
export async function checkClouds(
  targets: readonly Pick<CloudTarget, 'cloud' | 'region'>[],
  deps: { command: RunCommand; env: NodeJS.ProcessEnv; verbose?: boolean },
  problems: string[] = [],
): Promise<Map<Cloud, string>> {
  const identities = new Map<Cloud, string>();
  // Each cloud once, at its first target's region.
  const firsts = targets.filter(
    (t, i) => targets.findIndex((o) => o.cloud === t.cloud) === i,
  );
  for (const target of firsts) {
    const { cloud } = target;
    const [login, signIn] = LOGINS[cloud];
    const onPath = await deps.command(login, regionEnv(target, deps.env)).then(
      (out) => !!identities.set(cloud, out),
      (error: unknown) => {
        const missing = (error as { code?: unknown }).code === 'ENOENT';
        problems.push(
          (missing
            ? `${login[0]} isn't on PATH: install ${CLI_NAME[cloud]}.`
            : signIn) + verboseDetail(error, deps.verbose),
        );
        return !missing;
      },
    );
    const unset = onPath && cloud === 'gcp' && (await noProject(deps.command));
    if (unset) problems.push(unset);
  }
  if (problems.length) throw new UsageError(problems.join('\n'));
  return identities;
}

/**
 * The hosted API this machine targets, whose client signs in with GitHub
 * again when the API refuses its token.
 */
export async function hostedApi(
  deps: Pick<WorkerDeps, 'env' | 'wait'> & {
    run: (args: string[]) => Promise<string>;
    fetch?: typeof globalThis.fetch;
    api?: typeof anycloudApi;
    exec?: typeof anycloudExec;
    signInCheck?: SignInCheck;
  },
  print: (line: string) => void,
): Promise<{
  url: string;
  api: AnycloudApi;
  exec: AnycloudExec;
  // The same API with another release's client header.
  as: (clientVersion: string) => AnycloudApi;
}> {
  const { url, token, refresh } = await apiTarget(
    deps.env,
    deps.run,
    signInAgain(workerDeps(deps, print), deps.signInCheck),
  );
  const client = deps.api ?? anycloudApi;
  return {
    url,
    api: client(url, token, undefined, refresh),
    exec: (deps.exec ?? anycloudExec)(url, token, undefined, refresh),
    as: (clientVersion) =>
      client(url, token, undefined, refresh, clientVersion),
  };
}
