// `backmesh install`: an anycloud installation with the
// GitHub App and the org's listener on its own VM, whose runners are VM Jobs.
import { z } from 'zod';

import { StepFailed, type RunAnycloud } from '../anycloud/binary.js';
import {
  activeApiUrl,
  anycloudApi,
  anycloudExec,
  apiToken,
  type AnycloudApi,
} from '../anycloud/client.js';
import { ANYCLOUD_VERSION } from '../anycloud/contract.generated.js';
import { missingFeatures, type FeatureTable } from '../anycloud/features.js';
import { anycloudControl } from '../app/anycloud.js';
import {
  API_URL_ENV,
  GITHUB_APP_ID,
  GITHUB_APPS_FLAG,
  signInForKey,
  waitForApp,
  workerDeps,
} from './worker.js';
import {
  checkSignIn,
  saveSignIn,
  signInAgain,
  type SignInCheck,
} from './github-sign-in.js';
import { readApiVersion, readListener } from './status.js';
import { readOverride } from '../app/override.js';
import { parseRoutes } from '../listener/routes.js';
import { ensureCacheBuckets, withAllowedRegions } from './cache-buckets.js';
import {
  anycloudRunners,
  type RunnersAnycloud,
  type VmTypeDetails,
} from '../runners/anycloud.js';
import {
  CLOUDS,
  GPU_TYPES,
  planClasses,
  PUBLIC_VCPU_CAP,
  PUBLIC_VCPUS,
  where,
  type Cloud,
  type CloudTarget,
  type RunnerClass,
} from '../runners/classes.js';
import {
  formatGpuQuota,
  formatQuota,
  quotaCheck,
  quotaCode,
  quotaToRaise,
  readQuota,
  readQuotas,
  readServiceQuota,
  readUsage,
  skippedRegions,
  startsNoRunners,
  type QuotaLimits,
  type Usage,
} from '../runners/quota.js';
import { formatRate } from '../runners/rate.js';
import type { Compatibility } from '../release/compatibility.js';
import { planId, sameOwnerLine, type InstallPlan } from './plan.js';
import {
  changed,
  changeLines,
  fingerprint,
  reorderedOnlyLine,
  rollListener,
  routesJson,
  runnerChanges,
  answering,
  secretValues,
  targetsOf,
  type RunningListener,
} from './converge.js';
import { runnerGroupName } from '../github/runner-group.js';
import {
  createListenerVm,
  LISTENER_VM_MONTHLY_USD,
  LISTENER_VM_TYPES,
  listenerVmId,
} from './listener-vm.js';
import {
  checkClouds,
  checkHosted,
  checkPinned,
  hostedApi,
  LOGINS,
  NO_PROJECT,
  regionEnv,
  verboseDetail,
} from './prerequisites.js';
import { PlanChanged, UsageError } from './errors.js';
import {
  ALWAYS_ON_VCPUS,
  alwaysOnRegions,
  candidateRegions,
  noCapacity,
  type AlwaysOn,
  type AlwaysOnRegion,
} from './vm-sizes.js';
import { checkOwn, namedControlPlane } from './named-control-plane.js';
import {
  RUNNER_REGIONS,
  SUGGESTED_REGION,
  type RunCommand,
} from '../runners/regions.js';
import {
  clusterIdOf,
  connectionName,
  installConnection,
  installTag,
  listenerName,
  orgOfListener,
  readInstallation,
  readOrgId,
  readPublicRepos,
  publicReposWarning,
  controlPlaneOf,
  type Listener,
} from './installation.js';
import { lowerManagementDisk } from './control-disks.js';

export const CLUSTER = 'backmesh';

/**
 * Every class of `targets` from the pinned catalog of each runner region,
 * the JSON the listener routes from (`routes.ts`), and the catalogs it
 * read. Install and upgrade both plan this way; `regionsOf` gives each
 * target's runner regions (`planRegions`).
 */
export async function classesOf(
  targets: readonly CloudTarget[],
  anycloud: Pick<RunnersAnycloud, 'vmTypeDetails'>,
  regionsOf: RegionsOf,
  // The control plane's cloud, whose labels are plain.
  home: Cloud | undefined,
  // `--public-repos`: `backmesh-public-<n>` too.
  publicRepos = false,
) {
  const catalog = new Map<Cloud, Map<string, VmTypeDetails[]>>();
  for (const target of targets) {
    const { cloud, region } = target;
    // Only `regionsOf`'s regions — every one a `RUNNER_REGIONS` candidate
    // (`planRegions`) — ever become runner regions; `target.region` is
    // just where `--control-plane` put the management VM, which this
    // never forces into the runner catalog on its own (owner, 2026-11-13).
    // When it IS one of `regionsOf`'s regions, it still goes first, as
    // the home anchor.
    const regions = await regionsOf(target);
    const ordered = regions.includes(region)
      ? [region, ...regions.filter((r) => r !== region)]
      : regions;
    const entries = await Promise.all(
      ordered.map(
        async (r) => [r, await anycloud.vmTypeDetails(cloud, r)] as const,
      ),
    );
    catalog.set(cloud, new Map(entries));
  }
  const plan = planClasses(targets, catalog, home, publicRepos);
  return { ...plan, catalog, json: JSON.stringify(plan.classes) };
}

/** A target's runner regions. */
export type RegionsOf = (target: CloudTarget) => Promise<string[]> | string[];

/**
 * The runner regions install and upgrade plan: every one of
 * `RUNNER_REGIONS` (fixed in code, not discovered through a cloud CLI;
 * owner, 2026-11-13), or just the target's region alone while this control
 * plane can't take a region list yet. Account-allowed filtering
 * happens later, once there's a signed-in connection to check with
 * (`cache-buckets.ts`'s `allowedRegions`), since `--plan` reads no cloud
 * account.
 */
export const planRegions =
  (
    multiRegion: boolean,
    // Prints why a cloud keeps one region.
    report: { print: (line: string) => void },
  ): RegionsOf =>
  (target) => {
    if (multiRegion) return RUNNER_REGIONS[target.cloud];
    report.print(
      `${target.cloud}'s runners stay in ${target.region}: this control plane can't take a region list yet.`,
    );
    return [target.region];
  };

/** Whether `version`'s VM Jobs take a region list. */
export const takesRegions = (version: string, features?: FeatureTable) =>
  !missingFeatures(version, ['vm-job-regions'], features).length;

export const noKvmLine = ({ cloud }: CloudTarget, regions: readonly string[]) =>
  `${where(cloud, regions)} ${regions.length > 1 ? 'offer' : 'offers'} no KVM type with nested virtualization, so ${cloud} gets no KVM labels.`;

export const noGpuLine = (
  { cloud }: CloudTarget,
  regions: readonly string[],
) =>
  cloud === 'gcp'
    ? "gcp gets no GPU labels: anycloud can't launch a T4 VM on GCP yet."
    : `${where(cloud, regions)} ${regions.length > 1 ? 'offer' : 'offers'} no ${GPU_TYPES[cloud].join(' or ')}, so ${cloud} gets no GPU labels.`;

// The management VM: AWS's is backmesh's sizing; GCP's the nearest size
// _(inference)_. Azure's first is the size anycloud qualifies the
// management VM on; a region that doesn't offer it the subscription
// (`vm-sizes.ts`) takes the same 2 vCPUs and 8 GiB on AMD, or a generation
// back.
const MANAGEMENT_VMS: Record<Cloud, readonly string[]> = {
  aws: ['t3.large'],
  gcp: ['e2-standard-2'],
  azure: ['Standard_D2s_v5', 'Standard_D2as_v5', 'Standard_D2s_v4'],
};
// It, its disk and public address, $/month, Azure's at westus2's
// pay-as-you-go Linux price (Retail Prices API, 2026-11-21): with each org's
// listener VM (`LISTENER_VM_MONTHLY_USD`), the installation's whole floor,
// since runners have no VM while idle.
const MANAGEMENT_MONTHLY_USD: Record<string, number> = {
  't3.large': 69,
  'e2-standard-2': 59,
  Standard_D2s_v5: 79,
  Standard_D2as_v5: 72,
  Standard_D2s_v4: 79,
};

export interface InstallOptions {
  org: string;
  // `--control-plane <cloud>:<region>`.
  controlPlane?: string;
  // `--control-plane-id`: the control plane named `backmesh` in the
  // account to resume, which this machine doesn't target.
  controlPlaneId?: string;
  // `--runners <cloud>`, repeatable: a cloud only.
  runners?: string[];
  yes: boolean;
  // `--plan`: print the plan and its ID, and change nothing.
  plan?: boolean;
  // `--plan-id`: the plan `--yes` agrees to, the same-owner check included.
  planId?: string;
  // `--cache-cap`: each repository's cache per region, in GB, set when the
  // listener is created.
  cacheCapGb?: number;
  // `--public-repos` or `--no-public-repos`: public repositories may use the
  // runners, their fork pull requests only `backmesh-public-<n>`. Without
  // either, a re-run keeps the listener's.
  publicRepos?: boolean;
}

// What `--public-repos` opens, and what it needs.
export const PUBLIC_REPOS_LINE = `Public repositories: the org's public repositories may use the runners. Their forks' pull requests run only on ${PUBLIC_VCPUS.map((n) => `backmesh-public-${n}`).join(' and ')}, with ${PUBLIC_VCPU_CAP} vCPUs at once; a fork run that asks for another label is cancelled. Set GitHub's "Require approval for all external contributors" for the org, and keep nothing else in the runners' cloud network: a job can reach the network's other instances.`;

/**
 * The labels a workflow's `runs-on` takes, exactly as the listener's scale
 * sets name them: the control plane's cloud's carry no cloud, so on an
 * Azure control plane it's `backmesh-gpu-t4`, and `backmesh-azure-gpu-t4`
 * waits at GitHub for a runner that never comes.
 */
export const labelsLine = (
  classes: readonly Pick<RunnerClass, 'label' | 'cloud'>[],
  home: Cloud,
) =>
  `Labels for runs-on: ${classes.map((c) => c.label).join(', ')}${classes.some((c) => c.cloud === home) ? ` (${home}'s carry no "${home}-": it runs the control plane)` : ''}.`;

export interface InstallUi {
  print(line: string): void;
  // Undefined without a TTY: install never prompts there.
  confirm?(question: string): Promise<boolean>;
  // The trimmed answer; an empty one takes the suggestion in brackets.
  ask?(question: string): Promise<string>;
}

export interface InstallDeps {
  env: NodeJS.ProcessEnv;
  run: RunAnycloud;
  // For `api create` and `credentials new --generate`, which run for
  // minutes.
  runLong: RunAnycloud;
  command: RunCommand;
  // The login of a sign-in's user (`signInCheck`).
  signInCheck: SignInCheck;
  release: () => Promise<Pick<Compatibility, 'runnerImage' | 'listenerImage'>>;
  ui: InstallUi;
  api?: typeof anycloudApi;
  exec?: typeof anycloudExec;
  features?: FeatureTable;
  // The Worker, and the wait of its device flow's polling and of a new
  // listener's start.
  fetch?: typeof globalThis.fetch;
  wait?: (ms: number) => Promise<void>;
  // `--verbose`: the cloud CLIs' own errors under install's lines.
  verbose?: boolean;
  // This checkout's `git`, for the org without `--org` (`pickOrg`).
  git?: (args: string[]) => Promise<string>;
}

const cloudOf = (value: string, flag: string, example: string): Cloud => {
  if (!CLOUDS.includes(value as Cloud)) {
    throw new UsageError(
      `${flag} ${value}: expected one of ${CLOUDS.join(', ')}, such as ${example}.`,
    );
  }
  return value as Cloud;
};

/** `--control-plane <cloud>:<region>`: where the management VM runs, and the listeners' VMs. */
export function parseControlPlane(value: string): CloudTarget {
  const [name = '', region, extra] = value.split(':');
  const example = '--control-plane aws:us-east-1';
  const cloud = cloudOf(name, '--control-plane', example);
  if (!region || extra !== undefined || region.includes(',')) {
    throw new UsageError(
      `--control-plane ${value}: expected <cloud>:<region>, such as ${example}.`,
    );
  }
  return { cloud, region, credentials: '' };
}

/**
 * `--runners <cloud>`, repeatable: the clouds the runners use, each with
 * its fixed candidate regions (`regions.ts`'s `RUNNER_REGIONS`, owner,
 * 2026-11-13) — never a region list on the command line. Without
 * `--runners`, the control plane's cloud alone.
 */
export function parseRunners(
  values: readonly string[],
  controlPlane: Pick<CloudTarget, 'cloud' | 'region'>,
): CloudTarget[] {
  const given = values.length ? values : [controlPlane.cloud];
  return runnerClouds(given).map((cloud) => ({
    cloud,
    region:
      cloud === controlPlane.cloud
        ? controlPlane.region
        : SUGGESTED_REGION[cloud],
    credentials: '',
  }));
}

/**
 * Each `--runners` value's cloud: a bare cloud only. A `cloud:region`
 * value, the syntax before fixed regions, is refused with a
 * clear message instead of silently picked apart.
 */
export function runnerClouds(values: readonly string[]): Cloud[] {
  const example = '--runners aws, or --runners gcp';
  const parsed = values.map((value) => {
    if (value.includes(':')) {
      throw new UsageError(
        `--runners ${value}: takes a cloud only, not a region; backmesh's runner regions are fixed, not chosen. Try ${example}.`,
      );
    }
    return cloudOf(value, '--runners', example);
  });
  const repeated = parsed.find((cloud, i) => parsed.indexOf(cloud) !== i);
  if (repeated) {
    throw new UsageError(`--runners ${repeated} is given twice.`);
  }
  return parsed;
}

// Step 1. The device sign-in proves org admin, and installing the App an org
// owner, so no `gh` login is needed (owner, 2026-11-05). A missing GitHub
// sign-in isn't a problem: install signs in below.
async function checkPrerequisites(
  targets: readonly CloudTarget[],
  deps: InstallDeps,
  // `--plan` signs in to nothing.
  signIn = true,
): Promise<{ identities: Map<Cloud, string>; signedIn: boolean }> {
  checkPinned(ANYCLOUD_VERSION, deps.features);
  const { signedIn, problems } = signIn
    ? await checkSignIn(deps.env, deps.signInCheck, deps.ui.print)
    : { signedIn: false, problems: [] };
  const identities = await checkClouds(targets, deps, problems);
  return { identities, signedIn };
}

// Our CI's generated identity for a connection: anycloud names it
// `anycloud-<connection>`.
export const generatedIdentity = (connection: string) =>
  `anycloud-${connection}`;

// What deletes it. anycloud grants it, on GCP, three project roles and,
// on Azure, Contributor on the subscription (`credential-bootstrap/gcp.ts:14-16`,
// `azure.ts:55-56` at v0.1.73), which outlive a deleted service account or
// app. Each command is one line, with no placeholder, so it pastes into any
// shell.
export const SIGNED_IN: Record<Cloud, string> = {
  aws: 'account',
  gcp: 'project',
  azure: 'subscription',
};
const GCP_ROLES =
  'roles/compute.instanceAdmin.v1 roles/compute.securityAdmin roles/storage.admin';

export function deleteIdentity(cloud: Cloud, connection: string): string {
  const name = generatedIdentity(connection);
  const command = (() => {
    if (cloud === 'aws') {
      return `for key in $(aws iam list-access-keys --user-name ${name} --query 'AccessKeyMetadata[].AccessKeyId' --output text); do aws iam delete-access-key --user-name ${name} --access-key-id "$key"; done; aws iam delete-user-policy --user-name ${name} --policy-name AnycloudAccess; aws iam delete-user --user-name ${name}`;
    }
    if (cloud === 'gcp') {
      return `PROJECT=$(gcloud config get-value project); SA=${name}@$PROJECT.iam.gserviceaccount.com; for role in ${GCP_ROLES}; do gcloud projects remove-iam-policy-binding "$PROJECT" --member "serviceAccount:$SA" --role "$role" --condition None --format none; done; gcloud iam service-accounts delete "$SA" --project "$PROJECT" --quiet`;
    }
    return `for app in $(az ad app list --display-name ${name} --query '[].appId' --output tsv); do az role assignment delete --assignee "$app" --scope "/subscriptions/$(az account show --query id --output tsv)"; az ad app delete --id "$app"; done`;
  })();
  return `  ${command}`;
}

// anycloud won't generate over an identity of the same name, and nothing in
// its CLI deletes or reuses one (`credential-bootstrap/aws.ts:227-231`,
// `azure.ts:428-433`; GCP's IAM API answers 409 to the create, `gcp.ts:355-370`
// and `gcp-transport.ts:95-144` at v0.1.73). Each control plane's
// identity is its own (`connectionName`), so only an earlier run on this
// control plane, stopped between the generate and the connection's save,
// leaves one: install stops at step 3 with the commands that delete it.
const GENERATED_EXISTS: Record<Cloud, RegExp> = {
  aws: /AWS user anycloud-\S+ already exists/,
  gcp: /HTTP 409, ALREADY_EXISTS/,
  azure: /Azure identity "anycloud-[^"]+" already exists/,
};

const identityLeft = (cloud: Cloud, connection: string) =>
  `${cloud}'s identity ${generatedIdentity(connection)} is left from an earlier install on this control plane that stopped before saving its connection, and backmesh won't generate over it. Delete it, signed in to this ${SIGNED_IN[cloud]}, then run install again:\n${deleteIdentity(cloud, connection)}`;

// Without a TTY, anycloud generates only from a named operator: an AWS
// profile, or a gcloud account and project (`acquisition.ts:677-680,1241-1244`
// at v0.1.72).
async function operatorArgs(
  cloud: Cloud,
  identities: Map<Cloud, string>,
  deps: InstallDeps,
): Promise<string[]> {
  if (cloud === 'aws') {
    const { Account } = JSON.parse(identities.get(cloud) ?? '{}') as {
      Account?: string;
    };
    return [
      ...['--profile', deps.env.AWS_PROFILE || 'default'],
      ...(Account ? ['--account-id', Account] : []),
    ];
  }
  if (cloud === 'gcp') {
    const config = async (key: string) =>
      (await deps.command(['gcloud', 'config', 'get-value', key])).trim();
    return [
      ...['--gcloud-account', await config('account')],
      ...['--project-id', await config('project')],
    ];
  }
  return [];
}

// Each cloud's account flag for `credentials new --role --apply`, so the
// role is made where the plan said: GCP's project and Azure's subscription
// by ID. AWS takes none: anycloud's aws inherits this environment, so it
// resolves the account the plan read (a `--profile` would outrank exported
// keys and could pick another). The result's `account` is checked anyway.
const accountArgs = (cloud: Cloud, account: string): string[] => {
  if (cloud === 'gcp') return ['--project-id', account];
  if (cloud === 'azure') return ['--subscription-id', account];
  return [];
};

// What a role setup makes in the cloud, for the user to
// delete when it went to the wrong account. AWS's stack is named as
// anycloud's `awsRoleStackName` names it, from the control plane's host.
const roleLeft = (cloud: Cloud, apiUrl: string) =>
  ({
    aws: `the CloudFormation stack ${`anycloud-role-${new URL(apiUrl).hostname.replace(/[^A-Za-z0-9-]/g, '-')}`.slice(0, 128)}`,
    gcp: 'the custom role anycloud, the service account anycloud-role, the workload identity pool anycloud and its provider anycloud-api, and their IAM bindings',
    azure:
      'the anycloud-role deployment and resource group, the custom role, and its role assignment',
  })[cloud];

type Listed = {
  name: string;
  kind?: string;
  roleArn?: string;
  serviceAccountEmail?: string;
  subscriptionId?: string;
};

// A saved role connection's account, as `credentials list --json` shows
// its identifiers; undefined for a key connection (our CI's override).
const listedAccount = (cloud: Cloud, entry: Listed) => {
  if (entry.kind !== 'role') return undefined;
  if (cloud === 'aws') return entry.roleArn?.split(':')[4];
  if (cloud === 'gcp') {
    return /@([^.]+)\.iam\.gserviceaccount\.com$/.exec(
      entry.serviceAccountEmail ?? '',
    )?.[1];
  }
  return entry.subscriptionId;
};

// `--apply --json`'s refusals: a signed-out cloud CLI's `actionRequired`
// names the login command.
const signInRequired = (error: unknown) => {
  if (!(error instanceof StepFailed)) return undefined;
  try {
    const { actionRequired } = JSON.parse(
      error.stdout.trim().split('\n').at(-1) ?? '',
    ) as { actionRequired?: { command?: string } };
    return actionRequired?.command;
  } catch {
    return undefined;
  }
};

// GCP refuses a token at a workload identity provider it made seconds before
// (`invalid_target`) until the provider propagates, which takes up to about
// two minutes. A re-run of `--apply` adopts the provider it made, so the step
// runs again after each wait.
const INVALID_TARGET = /\binvalid_target\b/;
const PROPAGATION_WAITS_MS = [10_000, 20_000, 30_000, 60_000];

// Step 3, on the hosted API after step 5: each cloud's role connection,
// whose trust names the hosted API's issuer, so it can't come before
// `api create`. anycloud's `credentials new --role --apply` makes the
// role's cloud side through the user's own cloud CLI, in the plan's
// account, and saves it, with no prompt. An existing
// connection is reused, and a re-run converges on the cloud side. Our CI's
// override generates keys instead.
export async function connectClouds(
  targets: readonly CloudTarget[],
  accounts: InstallPlan['clouds'],
  identities: Map<Cloud, string>,
  deps: InstallDeps,
  generate: boolean,
  apiUrl: string,
  // The hosted API's `credentials list --json`.
  listed: readonly Listed[],
) {
  for (const target of targets) {
    const { cloud, credentials } = target;
    // anycloud runs the cloud side through the user's CLI, in this region
    // unless the user set one.
    const env = regionEnv(target, deps.env);
    // Where the AWS stack goes, for the user to find it.
    const awsRegion =
      cloud === 'aws' &&
      (env.AWS_REGION || deps.env.AWS_REGION || deps.env.AWS_DEFAULT_REGION);
    const account = accounts.find((a) => a.cloud === cloud)!.account;
    // A role in another account than the plan's, made now or by a run cut
    // short: the connection goes, so a re-run makes it again, and the user
    // learns what was left there. The delete runs first, so a failure to
    // delete still says why.
    const wrongAccount = async (made: string | undefined) => {
      const where = `${SIGNED_IN[cloud]} ${made ?? 'unknown'}`;
      const why = `${cloud}'s CLI made the role in ${where}, not ${account}, which install read and the plan names.`;
      await deps.run(['credentials', 'delete', credentials]).catch((error) => {
        throw new Error(
          `${why} Removing the connection ${credentials} failed, so run install again to remove it.`,
          { cause: error },
        );
      });
      throw new Error(
        `${why} The connection is removed. Delete ${roleLeft(cloud, apiUrl)} it left in ${where}${awsRegion ? ` (${awsRegion})` : ''}, sign ${LOGINS[cloud][0][0]} in to ${account}, and run install again.`,
      );
    };
    const existing = listed.find((entry) => entry.name === credentials);
    if (existing) {
      const made = listedAccount(cloud, existing);
      if (!generate && made !== undefined && made !== account) {
        await wrongAccount(made);
      }
      continue;
    }
    const args = ['credentials', 'new', credentials, '--provider', cloud];
    if (generate) {
      await deps
        .runLong(
          [
            ...args,
            ...(await operatorArgs(cloud, identities, deps)),
            '--generate',
          ],
          env,
        )
        .catch((error: unknown) => {
          if (!GENERATED_EXISTS[cloud].test(String(error))) throw error;
          throw new Error(identityLeft(cloud, credentials), { cause: error });
        });
      continue;
    }
    deps.ui.print(
      `Connecting ${cloud} with a role connection in ${SIGNED_IN[cloud]} ${account}, through your ${LOGINS[cloud][0][0]} CLI.`,
    );
    const apply = async (): Promise<string> => {
      for (let i = 0; ; i++) {
        try {
          return await deps.runLong(
            [
              ...args,
              '--role',
              '--apply',
              ...accountArgs(cloud, account),
              '--json',
            ],
            env,
          );
        } catch (error) {
          if (cloud !== 'gcp' || !INVALID_TARGET.test(String(error)))
            throw error;
          const ms = PROPAGATION_WAITS_MS[i];
          if (ms === undefined) {
            throw new Error(
              `GCP still refused the new role's token after ${PROPAGATION_WAITS_MS.reduce((a, b) => a + b) / 60_000} minutes: ${(error as Error).message}`,
              { cause: error },
            );
          }
          deps.ui.print(
            `GCP doesn't take the new role's token yet, as a new workload identity provider takes a minute or two to propagate; trying again in ${ms / 1000}s.`,
          );
          await (deps.wait ?? ((t) => new Promise((r) => setTimeout(r, t))))(
            ms,
          );
        }
      }
    };
    const out = await apply().catch((error: unknown) => {
      const login = signInRequired(error);
      const again = 'Run install again; the control plane stays and is reused.';
      throw new Error(
        login
          ? `${cloud}'s CLI needs a sign-in: run \`${login}\`. ${again}`
          : `${cloud}'s role connection wasn't made: ${error instanceof Error ? error.message : String(error)}. ${again}`,
        { cause: error },
      );
    });
    const saved = JSON.parse(out.trim().split('\n').at(-1) ?? '{}') as {
      account?: string;
    };
    if (saved.account !== account) await wrongAccount(saved.account);
  }
}

// Step 5: the hosted API on the `--control-plane`, created through the user's
// cloud CLI with nothing stored here (anycloud 0.1.74's seed). Re-running
// `api create` with the same name and region resumes it from the cloud's
// own tags (`docs/reference/cli/api-utilities.md`). A new cluster Azure refuses
// for capacity or quota, by the ID its progress names (`[<time>] Creating cluster
// <name> (ID: <id>)`, never `Resuming`), is deleted: its resource group and
// checkpoint bucket, not the subscription's shared `anycloud-storage`. It's
// then tried in the plan's next region (`alwaysOnRegions`), at its size
// there.
async function bootstrapCluster(
  controlPlane: CloudTarget,
  regions: readonly { region: string; size: string }[],
  deps: InstallDeps,
) {
  const { cloud } = controlPlane;
  for (let i = 0; ; i++) {
    const { region, size } = regions[i]!;
    let out: string;
    try {
      out = await deps.runLong([
        'api',
        'create',
        CLUSTER,
        '--cloud',
        cloud,
        '--region',
        region,
        '--vm-type',
        size,
        GITHUB_APPS_FLAG,
        GITHUB_APP_ID,
        '--json',
      ]);
    } catch (error) {
      const [, started, id] =
        (error instanceof StepFailed &&
          /\] (Creating|Resuming) cluster \S+ \(ID: ([^)\s]+)\)/.exec(
            error.stderr,
          )) ||
        [];
      if (
        cloud !== 'azure' ||
        !noCapacity(error) ||
        started !== 'Creating' ||
        !id
      ) {
        // Nothing on this machine names it until it runs (`checkOwn`).
        if (id && error instanceof Error) {
          error.message += `\nTo resume it, run install again with --control-plane-id ${id}.`;
        }
        throw error;
      }
      // `api delete` looks for the cluster's API first, and with this
      // machine's local target and no local API it exits there; its own
      // never answers, so delete goes on without it (`api-utilities.md`,
      // "Delete with the hosted API gone").
      await deps
        .runLong(
          [
            'api',
            'delete',
            id,
            '--cloud',
            cloud,
            '--region',
            region,
            '--delete-vms',
            '--delete-buckets',
            '--confirm',
            id,
            '--json',
          ],
          { API_URL: `https://${id}.anycloud.sh` },
        )
        .catch((cause: unknown) => {
          throw new Error(
            `Azure has no capacity or quota for the control plane's VM (${size}) in ${region}, and deleting what install started there failed: delete the resource group anycloud-${id}, then run install again.`,
            { cause },
          );
        });
      const next = regions[i + 1]?.region;
      if (!next) {
        throw new Error(
          `Azure has no capacity or quota for the control plane's VM in ${regions.map((r) => `${r.region} (${r.size})`).join(', ')} now. Install deleted what it started; run it again later.`,
          { cause: error },
        );
      }
      deps.ui.print(
        `Azure has no capacity or quota for the control plane's VM (${size}) in ${region} now: install deleted what it started there, and tries ${next}.`,
      );
      continue;
    }
    const cluster = JSON.parse(out) as {
      state: string;
      managementApiUrl: string | null;
    };
    if (cluster.state !== 'running' || !cluster.managementApiUrl) {
      throw new Error(
        `The control plane is ${cluster.state}. Run install again to resume it.`,
      );
    }
    return { url: cluster.managementApiUrl, region };
  }
}

const connectApi = (deps: InstallDeps) => hostedApi(deps, deps.ui.print);

// One listener VM per org: two contend for its runner group.
async function checkInstallation(api: AnycloudApi) {
  const control = await readInstallation(api);
  if (control.problems.length) {
    throw new Error(
      `Each org must have one listener VM:\n- ${control.problems.join('\n- ')}`,
    );
  }
  return control;
}

// Another org's listener means this run adds an org to the control plane:
// only with the user's word that every org has the same
// owner, which the plan carries. A control plane the plan didn't know
// of (`api create` resumed one this machine had no target for) needs a
// new plan, or the question at a terminal.
async function checkAddedOrg(
  options: InstallOptions,
  plan: InstallPlan,
  listeners: readonly Listener[],
  deps: InstallDeps,
) {
  const name = listenerName(options.org);
  // A re-run for an org already on it asks nothing.
  if (listeners.some((listener) => listener.name === name)) return;
  const others = listeners.map((listener) => orgOfListener(listener.name)!);
  if (!others.length) return;
  // The plan carries the agreement only when someone agreed to it: by
  // --plan-id, or at the terminal's question. Our CI's override with --yes
  // alone agreed to no plan.
  const agreed = !!options.planId || !options.yes;
  if (agreed && others.join() === plan.controlPlane.sharedWith.join()) {
    deps.ui.print(
      `Adding ${options.org} to ${others.join(', ')}'s control plane: the plan says they have one owner.`,
    );
    return;
  }
  const unplanned = agreed
    ? `This control plane runs backmesh for ${others.join(', ')}, which the plan didn't show.`
    : `This control plane runs backmesh for ${others.join(', ')}.`;
  if (options.planId || !deps.ui.confirm) {
    throw new PlanChanged(
      `${unplanned} Show the new plan with \`backmesh install --plan\` and agree to it again; separate owners use separate installations.`,
    );
  }
  if (
    !(await deps.ui.confirm(`${sameOwnerLine(options.org, others)} Do they?`))
  ) {
    throw new UsageError(
      `${options.org} wasn't added: separate owners use separate installations.`,
    );
  }
}

// The control plane this machine already targets, read with no sign-in:
// none when the target isn't a hosted API. One that doesn't answer stops
// the plan, which would otherwise show a new control plane. Step 5 reuses
// one found here instead of running `api create` again.
async function existingControlPlane(deps: InstallDeps) {
  const url = await activeApiUrl(deps.run);
  try {
    clusterIdOf(url);
  } catch {
    return undefined;
  }
  const hosted = await readApiVersion(
    url,
    deps.fetch ?? globalThis.fetch,
  ).catch((cause: unknown) => {
    throw new Error(
      `The control plane at ${url} didn't answer; retry, or run \`backmesh status\`.`,
      { cause },
    );
  });
  checkHosted(hosted, ANYCLOUD_VERSION, 'install');
  try {
    const token = await apiToken(deps.env, deps.run);
    const api = (deps.api ?? anycloudApi)(url, token);
    const control = await readInstallation(api);
    return {
      ...control,
      url,
      exec: (deps.exec ?? anycloudExec)(url, token),
      location: await controlPlaneOf(deps.run, url),
    };
  } catch (cause) {
    throw new Error(
      `Couldn't read the control plane this machine uses, ${url}. Run \`backmesh status\`, which signs in again if it must, then retry.`,
      { cause },
    );
  }
}

// Each cloud's billed account, as its CLI is signed in now: the plan
// names them, and install reads them again before billing.
async function accountsOf(targets: readonly CloudTarget[], deps: InstallDeps) {
  const read = async (target: CloudTarget) => {
    const { cloud } = target;
    if (cloud === 'gcp') {
      const project = (
        await deps.command(['gcloud', 'config', 'get-value', 'project'])
      ).trim();
      if (!project) throw new Error(NO_PROJECT);
      return project;
    }
    const out = await deps.command(
      LOGINS[cloud][0],
      regionEnv(target, deps.env),
    );
    const parsed = JSON.parse(out) as { Account?: string; id?: string };
    const account = cloud === 'aws' ? parsed.Account : parsed.id;
    if (!account) {
      throw new Error(`${LOGINS[cloud][0].join(' ')} named no account.`);
    }
    return account;
  };
  return Promise.all(
    targets.map(async (target) => ({
      cloud: target.cloud,
      region: target.region,
      account: await read(target),
    })),
  );
}

// Where install puts the control plane and the runners: the control plane
// this machine targets, else the flags; at a terminal, the answers to its
// questions; or with `--plan` or `--yes`, the defaults, which the plan shows
// (owner, 2026-11-08): the control plane on the signed-in cloud CLI's
// cloud, the first of AWS, GCP and Azure when several are, in its US East
// region, and the runners on its cloud. `--yes --plan-id` runs the printed
// command, which names both. `connections` are the clouds install connects,
// the control plane's first.
async function placementOf(
  options: InstallOptions,
  deps: InstallDeps,
  // The control plane this machine targets, and where it runs when that's
  // known: a re-run keeps it.
  targeted:
    { url: string; location?: { cloud: Cloud; region: string } } | undefined,
  // The org's runners when its listener runs there: a re-run keeps them
  // unless told otherwise.
  kept?: CloudTarget[],
  // This machine's control plane is reused with a listener on it:
  // `connections` then excludes its cloud unless it's also a runner cloud.
  reuse = false,
) {
  const { ui } = deps;
  // At a terminal, for a run that will ask before creating anything, each
  // missing choice is asked with its default filled in (owner, 2026-11-08);
  // `--plan` and `--yes` never prompt.
  const ask =
    ui.ask && !options.plan && !options.yes
      ? async (question: string, suggested: string) =>
          (await ui.ask!(`${question} [${suggested}]`)) || suggested
      : undefined;
  let controlPlane: CloudTarget;
  const named = options.controlPlane
    ? parseControlPlane(options.controlPlane)
    : undefined;
  const there = targeted?.location && {
    ...targeted.location,
    credentials: '',
  };
  // Never a default for a control plane install can't place: `api
  // create` resumes only in its own region.
  if (targeted && !there && !named) {
    throw new UsageError(
      `This machine targets the control plane at ${targeted.url}, and install can't read where it runs: pass --control-plane <cloud>:<region> as it was created.`,
    );
  }
  if (there) {
    if (
      named &&
      (named.cloud !== there.cloud || named.region !== there.region)
    ) {
      throw new UsageError(
        `This machine's control plane is on ${there.cloud} ${there.region}, and it can't move: pass --control-plane ${there.cloud}:${there.region}, or uninstall it first.`,
      );
    }
    controlPlane = there;
  } else if (named) {
    controlPlane = named;
  } else {
    if (!options.plan && !ui.confirm) {
      throw new UsageError(
        'Pass --control-plane <cloud>:<region>, such as --control-plane aws:us-east-1. `backmesh install --plan` shows where install would put it.',
      );
    }
    const signedIn: Cloud[] = [];
    for (const cloud of CLOUDS) {
      const login = LOGINS[cloud][0];
      if (
        await deps.command(login).then(
          () => true,
          () => false,
        )
      ) {
        signedIn.push(cloud);
      }
    }
    const [first] = signedIn;
    if (!first) {
      throw new UsageError(
        'No cloud CLI is signed in: sign in to aws, gcloud or az, or pass --control-plane <cloud>:<region>.',
      );
    }
    if (ask) {
      // Each answer is checked as its flag is, before the next question.
      const cloud =
        signedIn.length > 1
          ? cloudOf(
              await ask(`Control plane cloud (${signedIn.join(', ')})?`, first),
              '--control-plane',
              '--control-plane aws:us-east-1',
            )
          : first;
      const region = await ask(
        `Control plane region on ${cloud}?`,
        SUGGESTED_REGION[cloud],
      );
      controlPlane = parseControlPlane(`${cloud}:${region}`);
    } else {
      const region = SUGGESTED_REGION[first];
      controlPlane = { cloud: first, region, credentials: '' };
      ui.print(
        `The control plane goes on ${first} ${region}, near GitHub's US East${signedIn.length > 1 ? `, the first signed-in of ${signedIn.join(', ')}` : ''}; pass --control-plane <cloud>:<region> to choose another.`,
      );
    }
  }
  let given = options.runners ?? [];
  if (!given.length && kept) {
    return {
      controlPlane,
      runners: kept,
      connections: connectionsOf(controlPlane, kept, reuse),
    };
  }
  if (!given.length && ask) {
    given = runnerClouds(
      (await ask('Runner clouds?', controlPlane.cloud))
        .split(',')
        .map((c) => c.trim()),
    );
  }
  const runners = parseRunners(given, controlPlane);
  return {
    controlPlane,
    runners,
    connections: connectionsOf(controlPlane, runners, reuse),
  };
}

// The clouds install connects: the control plane's, for the listener's VM,
// then each other runner cloud. A reused control plane with a listener
// already on it (`reuse`) needs no connection or sign-in check of its own,
// so its cloud counts only when it's also a runner cloud: adding or
// changing runners on another cloud then needs just that cloud's CLI and
// rights (owner, 2026-11-10), and the new listener goes on the first runner
// cloud (`listenerPlace`). One reused without a listener, a first install
// stopped before step 7, still needs its cloud's connection.
const connectionsOf = (
  controlPlane: CloudTarget,
  runners: readonly CloudTarget[],
  reuse: boolean,
) =>
  reuse
    ? runners
    : [controlPlane, ...runners.filter((r) => r.cloud !== controlPlane.cloud)];

// Where a new listener's VM goes: the control plane's cloud and region when
// install connects it, else the first runner cloud's (`connectionsOf`).
const listenerPlace = (
  controlPlane: CloudTarget,
  connections: readonly CloudTarget[],
) =>
  connections.find((c) => c.cloud === controlPlane.cloud) ??
  connections[0] ??
  controlPlane;

// The org's listener on this machine's control plane, read before the plan
// so a re-run shows what it changes. It must run this backmesh's release:
// moving releases is `upgrade`'s.
async function currentListener(
  org: string,
  targeted: Awaited<ReturnType<typeof existingControlPlane>>,
  release: Pick<Compatibility, 'runnerImage' | 'listenerImage'>,
) {
  const name = listenerName(org);
  const found = targeted?.orgs.find((l) => l.name === name);
  if (!found) return undefined;
  const running = await readListener(targeted!.exec, found).catch(
    (cause: unknown) => {
      throw new Error(
        `${org}'s listener didn't answer, so install can't tell what it would change. Run \`backmesh status\`, then install again.`,
        { cause },
      );
    },
  );
  if (
    running.image !== release.listenerImage ||
    running.runnerImage !== release.runnerImage
  ) {
    throw new UsageError(
      `${org}'s listener runs another backmesh release than this one: run \`backmesh upgrade\` first, then install again.`,
    );
  }
  const routes = running.runners ? parseRoutes(running.runners) : [];
  if (!routes.length) {
    throw new UsageError(
      `${org}'s listener has no labels, so it's from before VM Jobs. Run \`backmesh uninstall\`, then \`backmesh install\`.`,
    );
  }
  // Its ID is GitHub's, which install reads anyway, and its tag with it.
  const listener: Omit<RunningListener, 'orgId' | 'identity'> = {
    name,
    org: running.org,
    vm: found.vm.id,
    image: running.image,
    runnerImage: running.runnerImage,
    runners: running.runners,
  };
  const identity = {
    runnerGroup: z.string().parse(running.runnerGroup),
    apiToken: z.string().parse(running.apiToken),
  };
  const live = new Set(running.status.scaleSets.map((set) => set.label));
  return {
    listener,
    identity,
    installKey: running.installKey,
    // Carried through to a re-run's roll so install never silently drops
    // an unfinished `rotate-key` rotation; install itself never
    // sets or clears it.
    rotatingFrom: running.rotatingFrom,
    cacheCapGb: running.cacheCapGb,
    routes,
    live,
  };
}

export async function install(options: InstallOptions, deps: InstallDeps) {
  const { ui } = deps;
  const multiRegion = takesRegions(ANYCLOUD_VERSION, deps.features);
  const override = readOverride(deps.env);
  if (!options.plan) {
    if (!options.yes && !ui.confirm) {
      throw new UsageError(
        'install creates billed cloud resources: show the plan with --plan, then pass --yes --plan-id <id> to run it without a terminal.',
      );
    }
    // `--yes` agrees to one plan; only our CI's override runs without one.
    if (options.yes && !options.planId && !override) {
      throw new UsageError(
        'Pass --plan-id with --yes: run install with --plan, show the plan, and pass the ID it prints.',
      );
    }
  }
  const release = await deps.release();
  const targeted = await existingControlPlane(deps);
  // Reusable: found answering, its location known, and recognizably
  // this installation's own control plane — a listener is there, or its
  // cluster record is named `backmesh` — not some other anycloud cluster
  // this machine happens to target. Anything else keeps today's path:
  // placement still follows `targeted.location` when it's known, but
  // `api create` and every connection run as before.
  const reused =
    targeted?.location &&
    (targeted.orgs.length || targeted.location.name === CLUSTER)
      ? targeted
      : undefined;
  const current = await currentListener(options.org, targeted, release);
  const placement = await placementOf(
    options,
    deps,
    targeted,
    current && targetsOf(current.routes),
    !!reused?.orgs.length,
  );
  const { runners } = placement;
  const { identities, signedIn } = await checkPrerequisites(
    placement.connections,
    deps,
    !options.plan,
  );
  // The org's numeric ID, for its tag.
  const orgId = await readOrgId(options.org, deps.fetch, deps.env);

  // The plan, before any sign-in or anything billed. The catalogs are the
  // pinned CLI's, and the quotas are read through the user's own cloud CLI.
  // Why a read fell back prints with the plan, so a run that fails first
  // shows none.
  const notes: string[] = [];
  const note = { print: (line: string) => void notes.push(line) };
  const publicRepos =
    options.publicRepos ??
    !!current?.routes.some((r) => r.public && !r.retiring);
  const classPlan = await classesOf(
    runners,
    anycloudRunners(deps.run),
    planRegions(multiRegion, note),
    placement.controlPlane.cloud,
    publicRepos,
  );
  const regionsOf = (cloud: Cloud) => [
    ...(classPlan.catalog.get(cloud)?.keys() ?? []),
  ];
  const problems = [...classPlan.problems];
  // The public labels are the control plane's cloud's.
  if (publicRepos && !classPlan.classes.some((c) => c.public)) {
    problems.push(
      `--public-repos needs runners on the control plane's cloud, ${placement.controlPlane.cloud}: backmesh-public-2 and -4 run there.`,
    );
  }
  const quotas = [];
  // Labels whose every region's quota is under one runner: shown in the
  // plan, and asked about at a terminal.
  const noRunners: string[] = [];
  // Every such label, GPU ones too, which install's end never suggests.
  const blocked = new Set<string>();
  // Each runner cloud's limits, and each region's Azure usage, read once
  // for the runners and the always-on VMs.
  const read = new Map<Cloud, Map<string, QuotaLimits>>();
  const usages = new Map<string, Promise<Usage[]>>();
  const usage = (region: string) => {
    if (!usages.has(region))
      usages.set(region, readUsage(region, deps.command));
    return usages.get(region)!;
  };
  for (const { cloud } of runners) {
    const regions = regionsOf(cloud);
    // A refused read, such as a role without servicequotas:GetServiceQuota,
    // shows the quotas as unread and install goes on (owner, 2026-11-09).
    let refused = false;
    const limits = await readQuotas(regions, (region) =>
      readQuota(cloud, region, deps.command, usage),
    ).catch((error: unknown) => {
      refused = true;
      note.print(
        `${cloud}'s quotas couldn't be read, so the plan shows them as unread.${verboseDetail(error, deps.verbose)}`,
      );
      return new Map<string, QuotaLimits>();
    });
    read.set(cloud, limits);
    const checks = [true, false].map((spot) => {
      const check = quotaCheck(cloud, regions, limits, spot);
      if (check.problem && !refused) problems.push(check.problem);
      return formatQuota(check, spot);
    });
    quotas.push(`${where(cloud, regions)} quota: ${checks.join(', ')}`);
    const mine = classPlan.classes.filter((c) => c.cloud === cloud);
    if (cloud !== 'gcp' && mine.some((c) => c.gpu)) {
      quotas.push(
        `${where(cloud, regions)} ${formatGpuQuota(
          cloud,
          limits,
          mine.filter((c) => c.gpu),
        )}`,
      );
    }
    // A GPU label's quota is usually 0 on a new account: shown, not asked
    // about.
    quotas.push(...startsNoRunners(cloud, limits, mine));
    noRunners.push(
      ...startsNoRunners(
        cloud,
        limits,
        mine.filter((c) => !c.gpu),
      ),
    );
    quotas.push(...skippedRegions(cloud, limits, mine));
    for (const c of mine) {
      if (startsNoRunners(cloud, limits, [c]).length) blocked.add(c.label);
    }
  }
  if (problems.length) {
    throw new Error(`Can't run the runners:\n- ${problems.join('\n- ')}`);
  }
  const listeners = targeted?.orgs;
  // A new listener's VM; a re-run's stays where it runs. With a new
  // control plane, it's the control plane's cloud and region.
  const placed = listenerPlace(placement.controlPlane, placement.connections);
  // The always-on VMs this run creates there: on Azure, in the first region
  // that offers this subscription every size, and on a capacity refusal the
  // next (`vm-sizes.ts`).
  const controlVm: AlwaysOn | undefined = listeners
    ? undefined
    : { what: "the control plane's VM", sizes: MANAGEMENT_VMS[placed.cloud] };
  const listenerVm: AlwaysOn | undefined = current
    ? undefined
    : {
        what: `${options.org}'s listener VM`,
        sizes: LISTENER_VM_TYPES[placed.cloud],
      };
  const alwaysOn = [controlVm, listenerVm].filter((vm) => !!vm);
  // `vm`'s size in `r`: the one the plan read there on Azure.
  const sizeIn = (r: AlwaysOnRegion | undefined, vm: AlwaysOn) =>
    r?.sizes[alwaysOn.indexOf(vm)] ?? vm.sizes[0]!;
  // The control plane named `backmesh` that `api create` would
  // resume: this machine's own, or the one `--control-plane-id` names, and
  // on Azure in its own region.
  const { cloud, region } = placement.controlPlane;
  const found = reused
    ? undefined
    : await namedControlPlane(CLUSTER, cloud, region, deps.command);
  await checkOwn({
    name: CLUSTER,
    cloud,
    region,
    found,
    targeted: targeted && clusterIdOf(targeted.url),
    given: options.controlPlaneId,
    command: deps.command,
  });
  const started = !listeners && cloud === 'azure' ? found?.region : undefined;
  if (found) {
    note.print(
      `Install resumes the control plane ${found.id}${started ? ` in azure ${started}` : ''}.`,
    );
  }
  const regions =
    placed.cloud === 'azure' && alwaysOn.length
      ? await alwaysOnRegions(
          started ? [started] : candidateRegions(placed.region),
          alwaysOn,
          {
            fallback: !listeners && !started,
            ...(!started && { usage }),
            advice: started
              ? `Delete the control plane named ${CLUSTER} in ${started}, or use another subscription.`
              : listeners
                ? 'Use another subscription.'
                : 'Pass --control-plane azure:<region> with a region that does, or use another subscription.',
          },
          deps.command,
          note,
        )
      : undefined;
  if (regions && regions.length > 1) {
    const [first, ...rest] = regions;
    const monthly = (vm: AlwaysOn) =>
      vm === controlVm ? MANAGEMENT_MONTHLY_USD : LISTENER_VM_MONTHLY_USD;
    // A later region's sizes where they aren't the first's.
    const other = (r: AlwaysOnRegion) => {
      const sizes = alwaysOn.flatMap((vm) => {
        const size = sizeIn(r, vm);
        return size === sizeIn(first, vm)
          ? []
          : [`${vm.what} ${size}, about $${monthly(vm)[size]} a month`];
      });
      return sizes.length ? `${r.region} (${sizes.join('; ')})` : r.region;
    };
    note.print(
      `If Azure has no capacity or quota for the control plane's VM in ${first!.region} when install creates it, install tries ${rest.map(other).join(', ')}, in turn.`,
    );
  }
  // AWS's always-on VMs count against the region's standard on-demand
  // vCPUs, which a new account may have under them. The plan compares the
  // limit, not the free vCPUs: Service Quotas reads no usage. GCP's e2
  // types count against the region's CPUS, which no project has under 8
  // _(inference)_, and the plan reads no GCP quota.
  if (placed.cloud === 'aws' && alwaysOn.length) {
    const code = quotaCode('aws', 'onDemand');
    const known = read.get('aws')?.get(placed.region);
    const limit = known
      ? known.onDemand
      : await readServiceQuota(code, placed.region, deps.command).catch(
          () => undefined,
        );
    const vcpus = alwaysOn.length * ALWAYS_ON_VCPUS;
    if (limit === undefined || !Number.isFinite(limit)) {
      note.print(
        `AWS's ${code} quota couldn't be read in ${placed.region}, so the plan takes it to have room for ${alwaysOn.map((vm) => vm.what).join(' and ')}.`,
      );
    } else if (limit < vcpus) {
      throw new UsageError(
        `AWS allows ${limit} on-demand vCPUs in ${placed.region}, under the ${vcpus} for ${alwaysOn.map((vm) => `${vm.what} (${vm.sizes[0]})`).join(' and ')}: raise ${quotaToRaise('aws', [placed.region], 'onDemand')}.`,
      );
    }
  }
  let place = regions ? { ...placed, region: regions[0]!.region } : placed;
  const controlPlane = listeners ? placement.controlPlane : place;
  const { connections } = placement;
  // A re-run for an org already on it agrees to nothing new.
  const orgs = (listeners ?? []).map((l) => orgOfListener(l.name)!);
  const sharedWith = orgs.includes(options.org.toLowerCase()) ? [] : orgs;
  const managementVm = controlVm && sizeIn(regions?.[0], controlVm);
  const listenerType = listenerVm && sizeIn(regions?.[0], listenerVm);
  const plan: InstallPlan = {
    org: options.org.toLowerCase(),
    orgId,
    anycloud: ANYCLOUD_VERSION,
    images: { runner: release.runnerImage, listener: release.listenerImage },
    clouds: await accountsOf(connections, deps),
    controlPlane: {
      cloud: controlPlane.cloud,
      region: controlPlane.region,
      ...(managementVm && {
        managementVm,
        monthlyUsd: MANAGEMENT_MONTHLY_USD[managementVm]!,
      }),
      exists: !!listeners,
      sharedWith,
    },
    listener: !listenerType
      ? null
      : {
          cloud: place.cloud,
          region: place.region,
          vmType: listenerType,
          monthlyUsd: LISTENER_VM_MONTHLY_USD[listenerType]!,
        },
    alwaysOnRegions: regions?.map((r) => ({
      region: r.region,
      ...(controlVm && { managementVm: sizeIn(r, controlVm) }),
      ...(listenerVm && { listenerVm: sizeIn(r, listenerVm) }),
    })),
    runners: runners.map((target) => ({
      cloud: target.cloud,
      regions: regionsOf(target.cloud),
    })),
    classes: classPlan.classes.map(
      ({ label, cloud, region, vcpus, spot, kvm, vmTypes, regions, gpu }) => ({
        label,
        cloud,
        region,
        vcpus,
        spot,
        kvm,
        vmTypes,
        regions,
        ...(gpu && { gpu }),
      }),
    ),
    rates: runners.flatMap(({ cloud, region }) =>
      formatRate(
        classPlan.classes.filter((c) => c.cloud === cloud),
        classPlan.catalog.get(cloud)?.get(region) ?? [],
      ),
    ),
    noKvm: classPlan.noKvm.map((target) =>
      noKvmLine(target, regionsOf(target.cloud)),
    ),
    noGpu: classPlan.noGpu.map((target) =>
      noGpuLine(target, regionsOf(target.cloud)),
    ),
    sameOwner: sharedWith.length
      ? sameOwnerLine(options.org, sharedWith)
      : null,
    current: fingerprint(current?.listener),
    // A re-run keeps the listener's unless --cache-cap names another.
    cacheCapGb: options.cacheCapGb ?? current?.cacheCapGb,
    changes: current ? runnerChanges(current.routes, classPlan.classes) : null,
    quotas,
  };
  const id = planId(plan);
  [...notes, ...plan.rates, ...quotas, ...plan.noKvm, ...plan.noGpu].forEach(
    (line) => ui.print(line),
  );
  ui.print(labelsLine(plan.classes, placement.controlPlane.cloud));
  if (!plan.controlPlane.exists) {
    ui.print(
      `Always on: the control plane's VM (${plan.controlPlane.managementVm}) on ${controlPlane.cloud} ${controlPlane.region}, about $${plan.controlPlane.monthlyUsd} a month with its disk and address.`,
    );
  }
  if (plan.listener) {
    ui.print(
      `Always on: ${options.org}'s listener VM (${plan.listener.vmType}) on ${plan.listener.cloud} ${plan.listener.region}, about $${plan.listener.monthlyUsd} a month with its disk and address.`,
    );
  }
  if (plan.sameOwner) ui.print(plan.sameOwner);
  if (plan.cacheCapGb !== current?.cacheCapGb)
    ui.print(
      `Cache: each repository keeps up to ${plan.cacheCapGb ?? 10} GB in each region.`,
    );
  if (publicRepos) ui.print(PUBLIC_REPOS_LINE);
  else {
    const repos = await readPublicRepos(options.org, deps.fetch, deps.env);
    if (repos?.names.length) {
      ui.print(
        publicReposWarning(
          options.org,
          repos,
          `backmesh install --org ${options.org} --public-repos`,
        ),
      );
    }
  }
  if (plan.changes) {
    // Optimistic: whether a reorder alone also rolls depends on the
    // account-allowed narrowing below, which needs a signed-in connection
    // `--plan` doesn't have; the real "VM type order updated" message,
    // and the roll decision, use the narrowed `finalRunners` instead,
    // once it's known. `current` is always set here, since `plan.changes`
    // is only ever set from `current ? runnerChanges(...) : null` above.
    const optimisticRunners = routesJson(
      classPlan.classes,
      current!.routes,
      current!.live,
    );
    const noChangesLine = `No changes: ${options.org}'s listener already runs this plan.`;
    const reorderLine = reorderedOnlyLine(
      undefined,
      plan.changes,
      optimisticRunners,
      current?.listener.runners,
    );
    for (const line of changeLines(
      options.org,
      plan.changes,
      classPlan.classes,
    )) {
      if (line === noChangesLine && reorderLine) {
        // `--plan` ends here (below), so this is its only chance to say a
        // reorder is happening instead of this misleading line — still
        // optimistic, since the account-allowed narrowing below could yet
        // turn this into a true no-op. A real run says nothing here
        // instead, and prints the same line once, for certain, at the
        // narrowed check below, rather than print it here too.
        if (options.plan) ui.print(reorderLine);
        continue;
      }
      ui.print(line);
    }
  }
  if (options.plan) return { planId: id, ...plan };
  if (options.planId && options.planId !== id) {
    throw new PlanChanged(
      `The plan changed since ${options.planId}; it's ${id} now. Show it with \`backmesh install --plan\` and agree to it again.`,
    );
  }
  // A plan agreed with --yes --plan-id was shown with these lines; at a
  // terminal they get their own question, answered no unless yes.
  if (
    noRunners.length &&
    !options.yes &&
    !(await ui.confirm?.(
      `${noRunners.length === 1 ? 'A label' : `${noRunners.length} labels`} would start no runners until a quota is raised. Install anyway?`,
    ))
  ) {
    throw new UsageError(
      'Install cancelled before anything billed was created. Raise the quotas named above, then run install again.',
    );
  }
  if (
    !options.yes &&
    // A re-run with nothing to change asks nothing.
    !(
      plan.changes &&
      !changed(plan.changes) &&
      !plan.sameOwner &&
      plan.cacheCapGb === current?.cacheCapGb
    ) &&
    !(await ui.confirm?.(
      plan.sameOwner
        ? 'Do they all have the same owner, and should install create these resources in your clouds?'
        : 'Proceed?',
    ))
  ) {
    throw new UsageError(
      'Install cancelled before anything billed was created.',
    );
  }

  // The org admin's one sign-in for the key, through GitHub's device flow;
  // `waitForApp` then prints the App's install link if it's missing. A
  // re-run over this org's answering listener keeps that listener, so it
  // keeps its key too: replacing it would revoke the running listener's. The same sign-in's token is the control
  // plane's, unless one is saved or GITHUB_TOKEN gives one.
  const worker = workerDeps(deps, ui.print);
  const name = listenerName(options.org);
  let installKey = current?.installKey;
  if (installKey) {
    if (!signedIn) await signInAgain(worker, deps.signInCheck)();
  } else {
    const signed = await signInForKey(options.org, worker);
    installKey = signed.key;
    if (!signedIn) {
      await saveSignIn(deps.env, signed.token, deps.signInCheck);
    }
  }
  // Step 4, before anything is billed: backmesh's App on the org.
  await waitForApp(options.org, installKey, worker);
  // The human's wait can be long: bill only the accounts the plan named.
  const now = await accountsOf(connections, deps);
  if (JSON.stringify(now) !== JSON.stringify(plan.clouds)) {
    throw new PlanChanged(
      'A cloud CLI was signed in to another account while install waited. Show the new plan with `backmesh install --plan` and agree to it again.',
    );
  }

  // Step 5. `reused` already found this machine's own control plane
  // answering (`existingControlPlane`, before any sign-in): a re-run
  // reuses it as-is and skips `api create`, so once it runs,
  // its cloud is read for nothing here and adding another cloud's runners
  // needs only that cloud's CLI and rights (owner, 2026-11-10). With no saved API, one that
  // didn't answer, or one install can't recognize as its own, `api
  // create` resumes or creates it, as it always has for clusters tagged
  // since anycloud 0.1.74's CloudFormation seed (an older untagged cluster
  // instead starts a new one).
  let url: string;
  if (reused) {
    url = reused.url;
    ui.print(
      `Using the control plane on ${controlPlane.cloud} ${controlPlane.region}.`,
    );
  } else {
    ui.print(
      `Creating the control plane on ${controlPlane.cloud} ${controlPlane.region}.`,
    );
    const created = await bootstrapCluster(
      controlPlane,
      (!plan.controlPlane.exists &&
        plan.alwaysOnRegions?.map((r) => ({
          region: r.region,
          size: r.managementVm!,
        }))) || [
        {
          region: controlPlane.region,
          size:
            plan.controlPlane.managementVm ??
            MANAGEMENT_VMS[controlPlane.cloud][0]!,
        },
      ],
      deps,
    );
    url = created.url;
    // The listener goes with a new control plane.
    if (!plan.controlPlane.exists) place = { ...place, region: created.region };
    // The management VM's disk at gp3's baseline until anycloud's template
    // makes it so (control-disks.ts). A resumed `api create` lowers it
    // too.
    if (controlPlane.cloud === 'aws') {
      await lowerManagementDisk(
        clusterIdOf(url),
        created.region,
        now.find((target) => target.cloud === 'aws')?.account,
        deps.command,
        ui.print,
      );
    }
  }
  await deps.run(['api', 'use', url]);
  // `api create` may have resumed a control plane on another release,
  // or the reused one may have moved since `targeted` read it.
  checkHosted(
    await readApiVersion(url, deps.fetch ?? globalThis.fetch),
    ANYCLOUD_VERSION,
    'install',
  );
  const { api, exec } = await connectApi(deps);
  // Before step 6: the cluster may predate this run.
  const existing = await checkInstallation(api);
  await checkAddedOrg(options, plan, existing.orgs, deps);
  // Each cloud's connection, now that the control plane is known: the one
  // the org's listener records, else the one install made there, else a
  // new one named for it.
  const listed = JSON.parse(
    await deps.run(['credentials', 'list', '--json']),
  ) as Listed[];
  const clusterId = clusterIdOf(url);
  const named = <T extends CloudTarget>(target: T): T => ({
    ...target,
    credentials:
      target.credentials ||
      (installConnection(target.cloud, clusterId, listed)?.name ??
        connectionName(target.cloud, clusterId)),
  });
  // Step 3, now that the hosted API runs.
  await connectClouds(
    connections.map(named),
    plan.clouds,
    identities,
    deps,
    !!override,
    url,
    listed,
  );
  const control = anycloudControl(api, deps.run);

  // The listener's configuration is the org's Secret, which its VM gets at
  // create and `upgrade` changes.
  const tag = installTag(clusterId, orgId);
  // `RUNNER_REGIONS`, narrowed to the ones this account can actually use:
  // a region a cloud policy or a narrower permission denies drops out
  // here, named, with no other change (owner, 2026-11-13). `--plan` can't
  // check this, with no signed-in connection yet, so the plan above is
  // optimistic.
  const finalClasses = await withAllowedRegions(
    api,
    tag,
    runners.map(named),
    classPlan.classes.map(named),
    new Set(
      current?.routes.filter((r) => !r.retiring).map((r) => r.label) ?? [],
    ),
    ui.print,
    deps.verbose,
  );
  const finalRunners = current
    ? routesJson(finalClasses, current.routes, current.live)
    : JSON.stringify(finalClasses);
  // The listener mints for every route region, so their cache buckets come
  // first; already created or confirmed
  // above, so this only double-checks.
  await ensureCacheBuckets(api, tag, parseRoutes(finalRunners), ui.print);
  if (existing.orgs.some((listener) => listener.name === name)) {
    // A re-run applies the plan's changes: the Secret, then a roll. The
    // plan named the listener it read, so one that appeared since is
    // another plan.
    if (!current) {
      throw new PlanChanged(
        `${options.org}'s listener already runs on this control plane, which the plan didn't show. Its install key was just replaced, so run \`backmesh upgrade\` from this machine to restart it with the new one, then \`backmesh install --plan\` to see what install would change.`,
      );
    }
    // `changed()` only gates consent (a VM type or region reorder alone
    // needs none, converge.ts); whether to roll compares the routes
    // themselves (the account-allowed `finalRunners`, not the optimistic
    // plan), as upgrade.ts does, so a reorder still reaches the
    // listener's Secret.
    if (
      finalRunners !== current.listener.runners ||
      plan.cacheCapGb !== current.cacheCapGb
    ) {
      const line = reorderedOnlyLine(
        undefined,
        plan.changes!,
        finalRunners,
        current.listener.runners,
      );
      if (line) ui.print(line);
      ui.print(`Rolling ${options.org}'s listener with the new settings.`);
      await rollListener(
        {
          ...current.listener,
          orgId,
          identity: {
            ...current.identity,
            install: tag,
            apiUrl: url,
            override: override?.env,
          },
        },
        {
          image: release.listenerImage,
          runnerImage: release.runnerImage,
          runners: finalRunners,
          installKey,
          rotatingFrom: current.rotatingFrom,
          cacheCapGb: plan.cacheCapGb,
          workerUrl: deps.env[API_URL_ENV],
        },
        { control, exec, again: 'install', wait: deps.wait },
      );
    }
  } else {
    // Step 6: the listener's identity, a service token only it holds, and
    // its runner group, named for its VM (`runnerGroupName`).
    const vm = listenerVmId(tag);
    const values = secretValues({
      org: options.org,
      orgId,
      identity: {
        install: tag,
        runnerGroup: runnerGroupName(tag, vm),
        apiUrl: url,
        apiToken: await control.issueServiceToken(name),
        override: override?.env,
      },
      image: release.listenerImage,
      runnerImage: release.runnerImage,
      installKey,
      runners: finalRunners,
      cacheCapGb: plan.cacheCapGb,
      workerUrl: deps.env[API_URL_ENV],
    });
    await control.saveSecret(name, values);
    // Step 7: its VM.
    ui.print(
      `Creating ${options.org}'s listener VM on ${place.cloud} ${place.region}.`,
    );
    // The size the plan read in its region.
    const vmType =
      plan.alwaysOnRegions?.find((r) => r.region === place.region)
        ?.listenerVm ?? plan.listener!.vmType;
    await createListenerVm(
      options.org,
      vm,
      { ...place, credentials: named(place).credentials, vmType },
      { exec, runLong: deps.runLong },
    );
    await answering(exec, { org: options.org, vm }, deps.wait);
  }

  // Step 9: the largest spot label up to the default 4 vCPUs that the
  // quotas start a runner for.
  const label = classPlan.classes
    .filter(
      (c) =>
        c.spot &&
        !c.kvm &&
        !c.gpu &&
        !c.public &&
        c.vcpus <= 4 &&
        !blocked.has(c.label),
    )
    .reduce<RunnerClass | undefined>(
      (best, c) => (best && best.vcpus >= c.vcpus ? best : c),
      undefined,
    );
  ui.print(labelsLine(classPlan.classes, placement.controlPlane.cloud));
  ui.print(
    label
      ? `Done. Use \`runs-on: ${label.label}\` (a ${label.vcpus}-vCPU spot VM) in a workflow; other sizes: https://backmesh.com/labels/`
      : 'Done, but no spot label up to 4 vCPUs starts a runner until a quota the plan named is raised. Sizes: https://backmesh.com/labels/',
  );
  return {
    apiUrl: url,
    org: options.org,
    install: tag,
    labels: classPlan.classes.map((c) => c.label),
  };
}
