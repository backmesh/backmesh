import { describe, expect, it } from 'vitest';

import { bucketName } from '../../../src/cache/format.js';
import { connectionName, installTag } from '../../../src/cli/installation.js';
import { generatedIdentity } from '../../../src/cli/install.js';
import { sweepNames } from '../../e2e/sweep-names.ts';

describe('sweepNames', () => {
  it("names the generated AWS and Azure identities and cache buckets as install does, and anycloud's seed stack and owner tag", () => {
    expect(sweepNames('k3x9q2', 7)).toEqual({
      STACK: 'anycloud-k3x9q2',
      // anycloud v0.1.78 `hostedApiIdentity('k3x9q2')`.
      OWNER_API: 'e304b862e42fae86c367148fe8147c06',
      IAM_USER: generatedIdentity(connectionName('aws', 'k3x9q2')),
      AZURE_APP: generatedIdentity(connectionName('azure', 'k3x9q2')),
      CACHE_PREFIX: bucketName(installTag('k3x9q2', 7), ''),
    });
  });
});
