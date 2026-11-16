// e2e.yml's label job, assertion 4, KVM labels only: /dev/kvm must be usable
// (the runner gets the VM's /dev/kvm, root:kvm 0660, through the kvm group
// anycloud adds to its container, with no chmod).
//
//   node test/e2e/check-kvm.ts
import { accessSync, closeSync, constants, openSync } from 'node:fs';

const KVM_PATH = '/dev/kvm';

try {
  accessSync(KVM_PATH, constants.R_OK | constants.W_OK);
  closeSync(openSync(KVM_PATH, 'r+'));
} catch (error) {
  console.error(
    `::error::${KVM_PATH} isn't usable: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
console.log(`${KVM_PATH} is present and opens read-write`);
