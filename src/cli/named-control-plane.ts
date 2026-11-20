// The control plane named `backmesh` that `cluster create` would resume,
// read before any sign-in through the user's own cloud CLI. anycloud finds
// it by its `anycloud_cluster_name` tag (`seed/*.ts`'s `findByName`): in the
// AWS account's region, Azure's whole subscription or GCP's whole project,
// so it can be another installation's, such as another GitHub owner's in
// the same account. Install resumes one only when this machine targets it
// or `--control-plane-id` names it.
import type { Cloud } from '../runners/classes.js';
import type { RunCommand } from '../runners/regions.js';
import { UsageError } from './errors.js';

export interface NamedControlPlane {
  id: string;
  // Where it runs; GCP's lookup doesn't say.
  region?: string;
  // GCP's: its service account, which the lookup finds it by.
  email?: string;
}

const LISTS: Record<Cloud, (name: string, region: string) => string[]> = {
  aws: (_, region) => [
    ...['aws', 'cloudformation', 'describe-stacks', '--region', region],
    ...['--query', "Stacks[?starts_with(StackName,'anycloud-')].Tags"],
    ...['--output', 'json'],
  ],
  azure: (name) => [
    ...['az', 'group', 'list', '--tag', `anycloud_cluster_name=${name}`],
    ...['--query', '[].{id:tags.anycloud_cluster,location:location}'],
    ...['--output', 'json'],
  ],
  gcp: () => [
    ...['gcloud', 'iam', 'service-accounts', 'list'],
    ...['--filter=email~^anycloud-', '--format=json'],
  ],
};

const SCOPE: Record<Cloud, (region: string) => string> = {
  aws: (region) => `AWS account's ${region}`,
  azure: () => 'Azure subscription',
  gcp: () => 'GCP project',
};

// Each cloud's answer, as the control planes named `name` it lists.
const PARSE: Record<
  Cloud,
  (out: string, name: string, region: string) => NamedControlPlane[]
> = {
  aws: (out, name, region) => {
    const stacks = JSON.parse(out) as { Key: string; Value: string }[][];
    const tag = (tags: { Key: string; Value: string }[], key: string) =>
      tags.find((t) => t.Key === key)?.Value;
    return stacks.flatMap((tags) => {
      const id = tag(tags, 'anycloud_cluster');
      return id && tag(tags, 'anycloud_cluster_name') === name
        ? [{ id, region }]
        : [];
    });
  },
  azure: (out) =>
    (JSON.parse(out) as { id: string; location: string }[]).map((g) => ({
      id: g.id,
      region: g.location,
    })),
  // The service account's description, `anycloud_cluster=<id>
  // anycloud_cluster_name=<name> ...`.
  gcp: (out, name) =>
    (JSON.parse(out) as { email?: string; description?: string }[]).flatMap(
      ({ email, description = '' }) => {
        const values = Object.fromEntries(
          description.split(' ').map((pair) => {
            const at = pair.indexOf('=');
            return [pair.slice(0, at), pair.slice(at + 1)];
          }),
        ) as Record<string, string | undefined>;
        const id = values.anycloud_cluster;
        return id && values.anycloud_cluster_name === name
          ? [{ id, ...(email && { email }) }]
          : [];
      },
    ),
};

/** The control plane named `name` that `cluster create` on `cloud` in `region` would resume, if one exists. Two of them stop install, as `cluster create` would. */
export async function namedControlPlane(
  name: string,
  cloud: Cloud,
  region: string,
  command: RunCommand,
): Promise<NamedControlPlane | undefined> {
  const scope = SCOPE[cloud](region);
  const out = await command(LISTS[cloud](name, region)).catch(
    (cause: unknown) => {
      throw new Error(
        `${cloud} couldn't list this ${scope}'s control planes, so install can't tell whether one named ${name} exists.`,
        { cause },
      );
    },
  );
  const found = [
    ...new Map(PARSE[cloud](out, name, region).map((c) => [c.id, c])).values(),
  ];
  if (found.length > 1) {
    throw new UsageError(
      `This ${scope} has ${found.length} control planes named ${name}: ${found.map((c) => (c.region ? `${c.id} in ${c.region}` : c.id)).join(', ')}. install can't tell which to resume: delete the ones you don't use, then run install again.`,
    );
  }
  return found[0];
}

// Its management VM, `anycloud-cluster-<id>` in its stack or resource
// group (anycloud `seed/types.ts`), as a JSON list: empty for an install
// that stopped before the VM ran, or after it was deleted.
const VMS: Record<
  Cloud,
  (found: NamedControlPlane, region: string) => string[]
> = {
  aws: ({ id }, region) => [
    ...['aws', 'ec2', 'describe-instances', '--region', region, '--filters'],
    `Name=tag:Name,Values=anycloud-cluster-${id}`,
    'Name=instance-state-name,Values=pending,running,stopping,stopped',
    ...['--query', 'Reservations[].Instances[].InstanceId'],
    ...['--output', 'json'],
  ],
  azure: ({ id }) => [
    ...['az', 'vm', 'list', '--resource-group', `anycloud-${id}`],
    ...['--query', '[].name', '--output', 'json'],
  ],
  gcp: ({ id }) => [
    ...['gcloud', 'compute', 'instances', 'list'],
    ...[`--filter=name=anycloud-cluster-${id}`, '--format=json(name)'],
  ],
};

// What deletes one with no VM, through the user's own cloud CLI: AWS's
// stack, Azure's resource group, or what GCP's create makes before its VM
// (anycloud `seed/gcp.ts`): the service account that names it, two
// firewall rules, and the checkpoint bucket named for it.
const DELETE: Record<
  Cloud,
  (found: NamedControlPlane, region: string) => string
> = {
  aws: ({ id }, region) =>
    `delete it with \`aws cloudformation delete-stack --stack-name anycloud-${id} --region ${region}\``,
  azure: ({ id }) => `delete it with \`az group delete --name anycloud-${id}\``,
  gcp: ({ id, email }) =>
    `delete what it left with \`gcloud iam service-accounts delete ${email}\` and \`gcloud compute firewall-rules delete anycloud-cluster-${id}-k8s anycloud-cluster-${id}-api\`, and its checkpoint bucket, if any, with \`gcloud storage rm --recursive gs://${id}\``,
};

/**
 * Refuses a control plane named `name` that this machine's target
 * (`targeted`) and `--control-plane-id` (`given`) don't name, before any
 * sign-in: it may be another installation's, and resuming it fails only
 * after the sign-in, at its DNS record. `given` must name the one found,
 * or this machine's own. One that holds no VM gets its delete command.
 */
export async function checkOwn({
  name,
  cloud,
  region,
  found,
  targeted,
  given,
  command,
}: {
  name: string;
  cloud: Cloud;
  region: string;
  found: NamedControlPlane | undefined;
  targeted: string | undefined;
  given: string | undefined;
  command: RunCommand;
}) {
  const scope = SCOPE[cloud](region);
  if (given && given !== found?.id && given !== targeted) {
    throw new UsageError(
      `--control-plane-id ${given}: this ${scope} has ${found ? `${found.id}` : 'no control plane'} named ${name}, not that one.`,
    );
  }
  if (!found || found.id === targeted || found.id === given) return;
  const elsewhere =
    cloud === 'aws'
      ? `pass --control-plane aws:<another region> to create a separate one`
      : `use another ${cloud === 'azure' ? 'subscription' : 'project'} to create a separate one, as ${name} names one control plane per ${cloud === 'azure' ? 'subscription' : 'project'}`;
  const exists = `A control plane named ${name} already exists in this ${scope}: ${found.id}${found.region && cloud !== 'aws' ? ` in ${found.region}` : ''}.`;
  // A failed read takes it to hold one.
  const vms = await command(VMS[cloud](found, region))
    .then((out) => JSON.parse(out) as unknown[])
    .catch(() => undefined);
  if (vms?.length === 0 && (cloud !== 'gcp' || found.email)) {
    throw new UsageError(
      `${exists} It holds no VM, so it's from an install that stopped, and this machine doesn't use it. If you don't need it, ${DELETE[cloud](found, region)}, then run install again; to resume it, pass --control-plane-id ${found.id}. If it isn't yours, ${elsewhere}.`,
    );
  }
  throw new UsageError(
    `${exists} This machine doesn't use it, so it may be another installation's. If it isn't yours, ${elsewhere}. If it's yours, such as from another machine or an install that stopped, pass --control-plane-id ${found.id} to resume it.`,
  );
}
