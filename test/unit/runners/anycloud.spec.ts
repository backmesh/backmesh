import { describe, expect, it, vi } from 'vitest';

import { anycloudRunners } from '../../../src/runners/anycloud.js';
import { CATALOG } from './fixtures.js';

// Records CLI arguments and prints `stdout` as JSON.
function fakeAnycloud(stdout: unknown) {
  const exec = vi.fn(async (_args: string[]) => JSON.stringify(stdout));
  return { exec, anycloud: anycloudRunners(exec) };
}

describe('anycloud calls', () => {
  it('reads one region of the catalog through the CLI', async () => {
    const { exec, anycloud } = fakeAnycloud(CATALOG.gcp);
    expect(await anycloud.vmTypeDetails('gcp', 'us-central1')).toEqual(
      CATALOG.gcp,
    );
    expect(exec.mock.calls[0]?.[0]?.join(' ')).toBe(
      'vm-types gcp us-central1 --details --json',
    );
  });

  it('names the command whose output is no JSON list', async () => {
    const { anycloud } = fakeAnycloud(null);
    await expect(anycloud.vmTypeDetails('aws', 'us-east-2')).rejects.toThrow(
      'vm-types aws us-east-2 --details --json printed no JSON list',
    );
  });
});
