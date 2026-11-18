// The control plane's AWS disks at gp3's baseline, 3,000 IOPS and 125 MiB/s
// (owner, 2026-11-18): its t3 VMs can't sustain more, and AWS bills
// provisioned IOPS and MiB/s monthly. anycloud 0.1.78 makes the management
// VM at 8,000 IOPS, and installs before it have `bm-control`'s Node at
// anycloud's `high` tier, 8,000 IOPS and 1,000 MiB/s: about $85 a month
// together. `install` and `upgrade` lower them in place through the user's
// AWS CLI, with no restart.
import type { RunAnycloud } from '../anycloud/binary.js';
import type { RunCommand } from '../runners/regions.js';
import { installConnection, type NodePool } from './installation.js';

const GP3_BASELINE_IOPS = 3_000;
const GP3_BASELINE_MIBPS = 125;

interface Instance {
  Tags?: { Key: string; Value: string }[];
  Root?: string;
  Devices?: { Name: string; Volume?: string }[];
}

interface Volume {
  VolumeId: string;
  VolumeType: string;
  Iops: number;
  Throughput: number;
}

interface LoweredDisk {
  volumeId: string;
  fromIops: number;
  fromThroughput: number;
  // Whether EC2 took the change; false when it refused it, such as within
  // 6 hours of the volume's last change.
  lowered: boolean;
}

/** The plan's line for an AWS control plane, which `upgrade` lowers last. */
export const LOWER_DISKS_PLAN_LINE = `On AWS, upgrade also lowers the control plane's disks to gp3's baseline, ${GP3_BASELINE_IOPS} IOPS and ${GP3_BASELINE_MIBPS} MiB/s, where they're faster.`;

/**
 * The AWS account of the control plane's connection, from its role ARN, so a
 * search that finds no VM can name the account to sign in to; undefined for
 * a key connection or a failed read.
 */
export async function controlPlaneAccount(
  run: RunAnycloud,
  clusterId: string,
): Promise<string | undefined> {
  const listed = await run(['credentials', 'list', '--json'])
    .then((out) => JSON.parse(out) as { name: string; roleArn?: string }[])
    .catch(() => []);
  return installConnection('aws', clusterId, listed)?.roleArn?.split(':')[4];
}

/**
 * Lowers the management VM's and `bm-control`'s gp3 root volumes to the
 * baseline, and leaves ones already there alone. anycloud tags both with
 * the cluster: the management VM is `anycloud-cluster-<id>` and a pool's
 * VMs carry its ID. A failed read or change is printed, and the command
 * goes on.
 */
export async function lowerControlDisks(
  clusterId: string,
  region: string,
  account: string | undefined,
  pool: NodePool | undefined,
  command: RunCommand,
  print: (line: string) => void,
): Promise<LoweredDisk[]> {
  const aws = async <T>(...args: string[]) =>
    JSON.parse(
      await command([
        'aws',
        'ec2',
        ...args,
        '--region',
        region,
        '--output',
        'json',
      ]),
    ) as T;
  let volumes: Volume[];
  try {
    const instances = await aws<Instance[]>(
      'describe-instances',
      '--filters',
      `Name=tag:anycloud_cluster,Values=${clusterId}`,
      'Name=instance-state-name,Values=pending,running,stopping,stopped',
      '--query',
      'Reservations[].Instances[].{Tags:Tags,Root:RootDeviceName,Devices:BlockDeviceMappings[].{Name:DeviceName,Volume:Ebs.VolumeId}}',
    );
    const tag = (instance: Instance, key: string) =>
      instance.Tags?.find((t) => t.Key === key)?.Value;
    const control = instances.filter(
      (instance) =>
        tag(instance, 'Name') === `anycloud-cluster-${clusterId}` ||
        (!!pool?.id && tag(instance, 'anycloud_resource') === pool.id),
    );
    // Signed in to another account or region, the search finds nothing.
    if (!control.length) {
      print(
        `Found no control-plane VM for ${clusterId} in this AWS account and ${region}, so its disks keep their speed; run \`backmesh upgrade\` signed in to ${account ? `AWS account ${account}` : "the control plane's AWS account"}.`,
      );
      return [];
    }
    const ids = control.flatMap((instance) =>
      (instance.Devices ?? [])
        .filter((device) => device.Name === instance.Root && device.Volume)
        .map((device) => device.Volume!),
    );
    volumes = ids.length
      ? await aws<Volume[]>(
          'describe-volumes',
          '--volume-ids',
          ...ids,
          '--query',
          'Volumes[].{VolumeId:VolumeId,VolumeType:VolumeType,Iops:Iops,Throughput:Throughput}',
        )
      : [];
  } catch {
    print(
      `Couldn't read the control plane's disks with the AWS CLI, so they keep their speed; run \`backmesh upgrade\` signed in to ${account ? `AWS account ${account}` : "the control plane's AWS account"} with ec2:DescribeInstances and ec2:DescribeVolumes.`,
    );
    return [];
  }
  const lowered: LoweredDisk[] = [];
  for (const volume of volumes) {
    if (
      volume.VolumeType !== 'gp3' ||
      (volume.Iops <= GP3_BASELINE_IOPS &&
        volume.Throughput <= GP3_BASELINE_MIBPS)
    ) {
      continue;
    }
    const was = `${volume.Iops} IOPS and ${volume.Throughput} MiB/s`;
    const ok = await aws(
      'modify-volume',
      '--volume-id',
      volume.VolumeId,
      '--iops',
      String(GP3_BASELINE_IOPS),
      '--throughput',
      String(GP3_BASELINE_MIBPS),
    ).then(
      () => true,
      () => {
        print(
          `Couldn't lower ${volume.VolumeId} from ${was}: EC2 refuses a change within 6 hours of a volume's last one, or without ec2:ModifyVolume. Run \`backmesh upgrade\` again later.`,
        );
        return false;
      },
    );
    if (ok) {
      print(
        `Lowered ${volume.VolumeId} from ${was} to ${GP3_BASELINE_IOPS} IOPS and ${GP3_BASELINE_MIBPS} MiB/s.`,
      );
    }
    lowered.push({
      volumeId: volume.VolumeId,
      fromIops: volume.Iops,
      fromThroughput: volume.Throughput,
      lowered: ok,
    });
  }
  return lowered;
}
