import { describe, expect, it } from 'vitest';

import { bucketName } from '../../../src/cache/format.js';
import { installTag } from '../../../src/cli/installation.js';
import { sweepNames } from '../../e2e/sweep-names.ts';

describe('sweepNames', () => {
  it("names the cache buckets as install does, and anycloud's seed stack, owner tag and AWS role connection stack", () => {
    expect(sweepNames('k3x9q2', 7)).toEqual({
      STACK: 'anycloud-k3x9q2',
      // anycloud v0.1.78 `hostedApiIdentity('k3x9q2')`.
      OWNER_API: 'e304b862e42fae86c367148fe8147c06',
      // anycloud v0.1.79 `awsRoleStackName('https://k3x9q2.anycloud.sh')`.
      ROLE_STACK: 'anycloud-role-k3x9q2-anycloud-sh',
      CACHE_PREFIX: bucketName(installTag('k3x9q2', 7), ''),
    });
  });
});
