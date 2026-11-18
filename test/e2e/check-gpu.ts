// e2e.yml's label job, GPU labels only: the job sees its VM's GPU as on
// GitHub's GPU runner. `nvidia-smi` works in the job, `docker run --gpus all`
// works on the VM's Docker through the NVIDIA container toolkit, and a CUDA
// kernel runs there. Prints each step's time, and the runner's start, submit
// to this step, for the PR's live-check evidence.
//
//   node test/e2e/check-gpu.ts
import { execFileSync } from 'node:child_process';

function fail(message: string): never {
  console.error(`::error::${message}`);
  process.exit(1);
}

// NVIDIA's own images: CUDA's base image, whose nvidia-smi comes from the
// host's driver, and the CUDA vectorAdd sample the GPU Operator's docs run.
const CUDA = 'nvidia/cuda:12.4.1-base-ubuntu22.04';
const VECTOR_ADD = 'nvcr.io/nvidia/k8s/cuda-sample:vectoradd-cuda12.5.0';

function timed(name: string, command: string, args: string[]): string {
  const started = performance.now();
  let out: string;
  try {
    out = execFileSync(command, args, { encoding: 'utf8', timeout: 300_000 });
  } catch (error) {
    fail(
      `${name} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(`::group::${name} (${seconds} s)`);
  console.log(out);
  console.log('::endgroup::');
  console.log(`${name}: ${seconds} s`);
  return out;
}

const submitted = Number(process.env.BACKMESH_SUBMITTED_AT);
if (Number.isFinite(submitted) && submitted > 0) {
  console.log(
    `runner submit to this step: ${((Date.now() - submitted) / 1000).toFixed(1)} s`,
  );
}

const smi = timed('nvidia-smi in the job', 'nvidia-smi', []);
if (!/Tesla T4/.test(smi)) fail('nvidia-smi names no Tesla T4');
const query = timed('GPU name, memory and driver', 'nvidia-smi', [
  '--query-gpu=name,memory.total,driver_version',
  '--format=csv,noheader',
]);
console.log(query.trim());

const docker = timed('docker run --gpus all nvidia-smi', 'docker', [
  ...['run', '--rm', '--gpus', 'all', CUDA, 'nvidia-smi'],
]);
if (!/Tesla T4/.test(docker)) {
  fail(`docker run --gpus all ${CUDA} nvidia-smi names no Tesla T4`);
}

const vectorAdd = timed('CUDA vectorAdd', 'docker', [
  ...['run', '--rm', '--gpus', 'all', VECTOR_ADD],
]);
if (!/Test PASSED/.test(vectorAdd)) fail('CUDA vectorAdd did not pass');
console.log(
  'The GPU works in the job, through docker --gpus all, and runs CUDA',
);
