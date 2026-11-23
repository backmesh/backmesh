// Our CI's generated identity, after uninstall deleted its connection with
// the control plane: deleted through the user's own cloud CLI when it
// carries anycloud's `--generate` marks, else left with the commands that
// delete it.
import type { Cloud } from '../runners/classes.js';
import type { RunCommand } from '../runners/regions.js';
import {
  deleteIdentity,
  GCP_NETWORK_ROLE,
  generatedIdentity,
  SIGNED_IN,
} from './install.js';

// What anycloud's `--generate` marks its identity with: AWS's user tag, GCP's
// service account description, and Azure's app tags
// (`credential-bootstrap/aws.ts:29,242`, `gcp.ts:18-19`, `azure.ts:30-31,172-176`).
const AWS_TAG = 'anycloud:generation-id';
const GCP_DESCRIPTION = 'AnyCloud credential generation ';
const AZURE_TAGS = (connection: string) => [
  'AnycloudManaged',
  `AnycloudCredentialName:${connection}`,
];
const GCP_ROLES = [
  'roles/compute.instanceAdmin.v1',
  'roles/compute.securityAdmin',
  'roles/storage.admin',
];

// What the cloud CLI answers for an identity that doesn't exist; Azure's
// list is empty instead.
const ABSENT: Partial<Record<Cloud, RegExp>> = {
  aws: /NoSuchEntity/,
  gcp: /NOT_FOUND|does not exist/,
};

type Found = 'deleted' | 'absent' | 'unmarked';

const json = async (command: RunCommand, args: string[]) =>
  JSON.parse(await command(args)) as unknown;

async function removeAws(name: string, command: RunCommand): Promise<Found> {
  const iam = (verb: string, ...args: string[]) =>
    command(['aws', 'iam', verb, '--user-name', name, ...args]);
  const read = async <T>(verb: string) =>
    JSON.parse(await iam(verb, '--output', 'json')) as T;
  const { Tags } = await read<{ Tags: { Key: string }[] }>('list-user-tags');
  if (!Tags.some(({ Key }) => Key === AWS_TAG)) return 'unmarked';
  const { AccessKeyMetadata } = await read<{
    AccessKeyMetadata: { AccessKeyId: string }[];
  }>('list-access-keys');
  for (const { AccessKeyId } of AccessKeyMetadata) {
    await iam('delete-access-key', '--access-key-id', AccessKeyId);
  }
  const { PolicyNames } = await read<{ PolicyNames: string[] }>(
    'list-user-policies',
  );
  for (const policy of PolicyNames) {
    await iam('delete-user-policy', '--policy-name', policy);
  }
  const { AttachedPolicies } = await read<{
    AttachedPolicies: { PolicyArn: string }[];
  }>('list-attached-user-policies');
  for (const { PolicyArn } of AttachedPolicies) {
    await iam('detach-user-policy', '--policy-arn', PolicyArn);
  }
  await iam('delete-user');
  return 'deleted';
}

// The project bindings go before the service account, which takes its keys
// with it: a deleted account's bindings would stay as `deleted:` members.
async function removeGcp(name: string, command: RunCommand): Promise<Found> {
  const project = (
    await command(['gcloud', 'config', 'get-value', 'project'])
  ).trim();
  const account = `${name}@${project}.iam.gserviceaccount.com`;
  const { description = '' } = (await json(command, [
    ...['gcloud', 'iam', 'service-accounts', 'describe', account],
    ...['--project', project, '--format', 'json'],
  ])) as { description?: string };
  if (!description.startsWith(GCP_DESCRIPTION)) return 'unmarked';
  for (const role of [
    ...GCP_ROLES,
    `projects/${project}/roles/${GCP_NETWORK_ROLE}`,
  ]) {
    await command([
      ...['gcloud', 'projects', 'remove-iam-policy-binding', project],
      ...['--member', `serviceAccount:${account}`, '--role', role],
      ...['--condition', 'None', '--format', 'none'],
    ]).catch((error: unknown) => {
      // A binding already removed.
      if (!/not found/i.test(String(error))) throw error;
    });
  }
  await command([
    ...['gcloud', 'iam', 'service-accounts', 'delete', account],
    ...['--project', project, '--quiet'],
  ]);
  return 'deleted';
}

// Deleting the app deletes its service principal; its role assignment
// goes first, while the principal still resolves.
async function removeAzure(
  name: string,
  connection: string,
  command: RunCommand,
): Promise<Found> {
  const apps = (await json(command, [
    ...['az', 'ad', 'app', 'list', '--display-name', name],
    ...['--output', 'json'],
  ])) as { appId: string; tags?: string[] }[];
  if (!apps.length) return 'absent';
  const marked = apps.filter(({ tags = [] }) =>
    AZURE_TAGS(connection).every((tag) => tags.includes(tag)),
  );
  if (!marked.length) return 'unmarked';
  const subscription = (
    await command(['az', 'account', 'show', '--query', 'id', '--output', 'tsv'])
  ).trim();
  for (const { appId } of marked) {
    await command([
      ...['az', 'role', 'assignment', 'delete', '--assignee', appId],
      ...['--scope', `/subscriptions/${subscription}`],
    ]);
    await command(['az', 'ad', 'app', 'delete', '--id', appId]);
  }
  return 'deleted';
}

/**
 * Deletes `connection`'s generated identity in the account `cloud`'s CLI is
 * signed in to, and says what happened. Idempotent: an identity already
 * gone is reported, not an error. An identity without anycloud's marks is
 * left alone, and a refused or failed delete prints the commands instead
 * of failing the uninstall.
 */
export async function removeIdentity(
  cloud: Cloud,
  connection: string,
  command: RunCommand,
): Promise<string> {
  const name = generatedIdentity(connection);
  const where = `the ${SIGNED_IN[cloud]} ${cloud}'s CLI is signed in to`;
  const found = await (
    cloud === 'aws'
      ? removeAws(name, command)
      : cloud === 'gcp'
        ? removeGcp(name, command)
        : removeAzure(name, connection, command)
  ).catch((error: unknown) => {
    if (ABSENT[cloud]?.test(String(error))) return 'absent' as const;
    return error;
  });
  if (found === 'deleted') {
    return `Deleted ${cloud}'s identity ${name}, which install generated, from ${where}.`;
  }
  if (found === 'absent') {
    return `${cloud}'s identity ${name} isn't in ${where}. If install generated it in another, delete it there with:\n${deleteIdentity(cloud, connection)}`;
  }
  if (found === 'unmarked') {
    return `${cloud}'s identity ${name} in ${where} wasn't generated by anycloud, so uninstall left it.`;
  }
  const reason = String(found).split('\n').filter(Boolean).at(-1);
  return `${cloud}'s identity ${name} wasn't deleted (${reason}). Delete it, signed in to the ${SIGNED_IN[cloud]} install used, with:\n${deleteIdentity(cloud, connection)}`;
}
