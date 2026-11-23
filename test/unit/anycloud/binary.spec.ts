import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  fetchBinary,
  platformOf,
  StepFailed,
} from '../../../src/anycloud/binary.js';
import { ANYCLOUD_VERSION } from '../../../src/anycloud/contract.generated.js';

// A release tarball as anycloud-sh/releases has it: one `anycloud` file.
function tarball() {
  const dir = mkdtempSync(join(tmpdir(), 'backmesh-release-'));
  writeFileSync(join(dir, 'anycloud'), '#!/bin/sh\necho ok\n', { mode: 0o755 });
  execFileSync('tar', ['-czf', 'release.tar.gz', 'anycloud'], { cwd: dir });
  const body = readFileSync(join(dir, 'release.tar.gz'));
  return { body, sha: createHash('sha256').update(body).digest('hex') };
}

describe('the pinned binary', () => {
  it('is fetched for this platform and checked against the pinned digest', async () => {
    const { body, sha } = tarball();
    const urls: string[] = [];
    const fetch = (async (url: string) => {
      urls.push(url);
      return new Response(body);
    }) as typeof globalThis.fetch;
    const dir = mkdtempSync(join(tmpdir(), 'backmesh-bin-'));
    const path = join(dir, 'anycloud');

    await expect(
      fetchBinary(path, 'linux-x64', fetch, 'f'.repeat(64)),
    ).rejects.toThrow(`has the SHA-256 ${sha}, not the pinned ffff`);
    expect(readdirSync(dir)).toEqual([]);

    await fetchBinary(path, 'linux-x64', fetch, sha);
    expect(urls[0]).toBe(
      `https://github.com/anycloud-sh/releases/releases/download/v${ANYCLOUD_VERSION}/anycloud-linux-x64.tar.gz`,
    );
    expect(execFileSync(path, { encoding: 'utf8' })).toBe('ok\n');
    expect(statSync(path).mode & 0o111).not.toBe(0);
    expect(readdirSync(dir)).toEqual(['anycloud']);
  });

  it('refuses a download that fails', async () => {
    const fetch = (async () =>
      new Response('', { status: 404 })) as unknown as typeof globalThis.fetch;
    await expect(
      fetchBinary(join(tmpdir(), 'never'), 'linux-x64', fetch),
    ).rejects.toThrow('HTTP 404');
  });

  it('runs only on the platforms the release has', () => {
    expect(platformOf('darwin', 'arm64')).toBe('darwin-arm64');
    expect(() => platformOf('win32', 'x64')).toThrow(
      "backmesh doesn't run on win32-x64.",
    );
  });

  it('reports a failed step without the binary’s command line', () => {
    const error = new StepFailed(
      ['terminate', 'bml-l8u5e-abc123', '--json'],
      '{"ok":false}\n',
      'Error: workload bml-l8u5e-abc123 not found\n',
      { cause: new Error('Command failed: /home/u/.backmesh/bin/anycloud') },
    );
    expect(error.message).toBe(
      'terminate bml-l8u5e-abc123 failed: Error: workload bml-l8u5e-abc123 not found',
    );
    // `relayedAction` reads a relayed sign-in from stdout.
    expect(error.stdout).toBe('{"ok":false}\n');
    // `api create --json`'s failure: the error document on stdout,
    // progress on stderr.
    const create = new StepFailed(
      ['api', 'create', 'backmesh', '--json'],
      '{"error":{"code":"CLOUD_RIGHTS_MISSING","message":"The identity lacks ec2:RunInstances"}}\n',
      '[12:00:00] Using aws account 123456789012 as arn:aws:iam::123456789012:user/ops\n',
      { cause: new Error('Command failed') },
    );
    expect(create.message).toBe(
      'api create failed: The identity lacks ec2:RunInstances (CLOUD_RIGHTS_MISSING)',
    );
    // A binary that didn't start printed nothing; its cause says why.
    const unstarted = new StepFailed(['api', 'status'], '', '', {
      cause: new Error('spawn /home/u/.backmesh/bin/0.1.72/anycloud EACCES'),
    });
    expect(unstarted.message).toBe(
      'api status failed: spawn /home/u/.backmesh/bin/0.1.72/anycloud EACCES',
    );
  });
});
