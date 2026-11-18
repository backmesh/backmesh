// The control plane's AWS disks at gp3's baseline, 3,000 IOPS and 125 MiB/s
// (owner, 2026-11-18): its t3 VMs can't sustain more, and AWS bills
// provisioned IOPS and MiB/s monthly. Installs before it have the
// management VM at 8,000 IOPS and `bm-control`'s Node at anycloud's `high`
// tier, 8,000 IOPS and 1,000 MiB/s, about $85 a month together. `upgrade`
// lowers them in place through the user's AWS CLI, with no restart.
import type { RunCommand } from '../runners/regions.js';
import type { NodePool } from './installation.js';

export const GP3_BASELINE_IOPS = 3_000;
export const GP3_BASELINE_MIBPS = 125;

interface Instance {
  Tags?: { Key: string; Value: string }[];
  Volumes?: string[];
}

interface Volume {
  VolumeId: string;
  VolumeType: string;
  Iops: number;
  Throughput: number;
}

export interface LoweredDisk {
  volumeId: string;
  iops: number;
  throughput: number;
  // Whether EC2 took the change; false when it refused it, such as within
  // 6 hours of the volume's last change.
  lowered: boolean;
}

/**
 * Lowers the management VM's and `bm-control`'s gp3 root volumes to the
 * baseline, and leaves ones already there alone. anycloud tags both with
 * the cluster: the management VM is `anycloud-cluster-<id>` and a pool's
 * VMs carry its ID. A failed read or change is printed, and upgrade goes on.
 */
export async function lowerControlDisks(
  clusterId: string,
  region: string,
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
      'Reservations[].Instances[].{Tags:Tags,Volumes:BlockDeviceMappings[].Ebs.VolumeId}',
    );
    const tag = (instance: Instance, key: string) =>
      instance.Tags?.find((t) => t.Key === key)?.Value;
    const ids = instances
      .filter(
        (instance) =>
          tag(instance, 'Name') === `anycloud-cluster-${clusterId}` ||
          (!!pool && tag(instance, 'anycloud_resource') === pool.id),
      )
      .flatMap((instance) => instance.Volumes ?? []);
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
      `Couldn't read the control plane's disks with the AWS CLI, so they keep their speed; run \`backmesh upgrade\` again once \`aws\` is signed in to its account.`,
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
      iops: volume.Iops,
      throughput: volume.Throughput,
      lowered: ok,
    });
  }
  return lowered;
}
