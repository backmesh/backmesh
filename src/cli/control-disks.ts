// The control plane's AWS disks at gp3's baseline, 3,000 IOPS and 125 MiB/s
// (owner, 2026-11-18): its t3 VMs can't sustain more, and AWS bills
// provisioned IOPS and MiB/s monthly. `bm-control` is created at that tier;
// anycloud 0.1.78 makes the management VM at 8,000 IOPS, about $25 a month
// more, so install lowers it in place through the user's AWS CLI, with no
// restart.
import type { RunCommand } from '../runners/regions.js';

const GP3_BASELINE_IOPS = 3_000;
const GP3_BASELINE_MIBPS = 125;

interface Volume {
  VolumeId: string;
  VolumeType: string;
  Iops: number;
  Throughput: number;
}

/**
 * Lowers the management VM's gp3 root volume, `anycloud-cluster-<id>`'s
 * `/dev/sda1` (anycloud's seed template), to the baseline, and leaves one
 * already there alone. A failed read or change is printed, and install goes
 * on.
 */
export async function lowerManagementDisk(
  clusterId: string,
  region: string,
  command: RunCommand,
  print: (line: string) => void,
): Promise<void> {
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
  const baseline = `to ${GP3_BASELINE_IOPS} IOPS and ${GP3_BASELINE_MIBPS} MiB/s`;
  let volumes: Volume[];
  try {
    const ids = await aws<string[]>(
      'describe-instances',
      '--filters',
      `Name=tag:Name,Values=anycloud-cluster-${clusterId}`,
      'Name=instance-state-name,Values=pending,running,stopping,stopped',
      '--query',
      'Reservations[].Instances[].BlockDeviceMappings[?DeviceName==`/dev/sda1`].Ebs.VolumeId[]',
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
      `Couldn't read the management VM's disk with the AWS CLI, so it keeps its speed; lower its root volume ${baseline} in the EC2 console.`,
    );
    return;
  }
  for (const volume of volumes) {
    if (
      volume.VolumeType !== 'gp3' ||
      (volume.Iops <= GP3_BASELINE_IOPS &&
        volume.Throughput <= GP3_BASELINE_MIBPS)
    ) {
      continue;
    }
    const was = `${volume.Iops} IOPS and ${volume.Throughput} MiB/s`;
    await aws(
      'modify-volume',
      '--volume-id',
      volume.VolumeId,
      '--iops',
      String(GP3_BASELINE_IOPS),
      '--throughput',
      String(GP3_BASELINE_MIBPS),
    ).then(
      () => print(`Lowered ${volume.VolumeId} from ${was} ${baseline}.`),
      () =>
        print(
          `Couldn't lower ${volume.VolumeId} from ${was}; lower it ${baseline} in the EC2 console.`,
        ),
    );
  }
}
