// e2e.yml's label job, assertion 3: the VM's host Docker (`--host-docker`) must
// apply a container's CPU and memory limits, and a bind mount from the job's
// own /tmp and $HOME must be visible inside a sibling container the same way
// the runner Job's own binds are.
//
//   node test/e2e/check-docker-limits.ts
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { rmSync, writeFileSync } from 'node:fs';

function fail(message: string): never {
  console.error(`::error::${message}`);
  process.exit(1);
}

// The same mirror runner/Dockerfile pulls its base images from.
const IMAGE = 'mirror.gcr.io/library/busybox:1.36';
const MEMORY_LIMIT_FLAG = '256m';
const MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;

function run(args: string[]): string {
  return execFileSync('docker', ['run', '--rm', ...args], {
    encoding: 'utf8',
    timeout: 30_000,
  }).trim();
}

// cgroup v2's memory.max: "max", or a byte count.
const memoryMax = run([
  `--memory=${MEMORY_LIMIT_FLAG}`,
  IMAGE,
  'cat',
  '/sys/fs/cgroup/memory.max',
]);
if (memoryMax !== String(MEMORY_LIMIT_BYTES)) {
  fail(
    `--memory=${MEMORY_LIMIT_FLAG} wasn't applied: memory.max reads "${memoryMax}", not ${MEMORY_LIMIT_BYTES}`,
  );
}

// cgroup v2's cpu.max: "max", or "<quota> <period>" in microseconds; Docker's
// --cpus=N sets quota to N * period, by default "100000 100000" for one CPU.
// Checking the ratio, not just "isn't max", catches a host that applies some
// quota but not the one asked for.
const cpuMax = run(['--cpus=1', IMAGE, 'cat', '/sys/fs/cgroup/cpu.max']);
const [quota, period] = cpuMax.split(/\s+/);
const cpus =
  quota === 'max' || !period ? undefined : Number(quota) / Number(period);
if (cpus === undefined || !Number.isFinite(cpus) || Math.abs(cpus - 1) > 0.01) {
  fail(
    `--cpus=1 wasn't applied: cpu.max reads "${cpuMax}" (${cpus === undefined ? 'unlimited' : `${cpus} CPUs`})`,
  );
}

const tmpMarker = `/tmp/bm-e2e-tmp-marker-${process.pid}`;
const homeMarker = `${homedir()}/.bm-e2e-home-marker-${process.pid}`;
try {
  writeFileSync(tmpMarker, 'from-host-tmp\n');
  writeFileSync(homeMarker, 'from-host-home\n');

  const tmpSeen = run([
    '-v',
    `${tmpMarker}:/marker:ro`,
    IMAGE,
    'cat',
    '/marker',
  ]);
  if (tmpSeen !== 'from-host-tmp') {
    fail(
      `a bind mount from this job's /tmp isn't visible inside a sibling container (read "${tmpSeen}")`,
    );
  }

  const homeSeen = run([
    '-v',
    `${homeMarker}:/marker:ro`,
    IMAGE,
    'cat',
    '/marker',
  ]);
  if (homeSeen !== 'from-host-home') {
    fail(
      `a bind mount from this job's $HOME isn't visible inside a sibling container (read "${homeSeen}")`,
    );
  }
} finally {
  rmSync(tmpMarker, { force: true });
  rmSync(homeMarker, { force: true });
}

console.log(
  `Docker applies limits (memory.max=${memoryMax}, cpu.max=${cpuMax}) and /tmp and $HOME bind mounts are visible inside a sibling container`,
);
