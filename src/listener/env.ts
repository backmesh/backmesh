// The names of the listener's settings that install and upgrade write to its
// VM (`cli/listener-vm.ts`), beside ORG, ORG_ID and the ones their own
// modules name.

// The listener's own image, so the VM's start and every roll read it from
// the same place.
export const LISTENER_IMAGE_ENV = 'BACKMESH_LISTENER_IMAGE';
// The org's runner group (`runnerGroupName`), fixed at install so a VM
// `upgrade` creates again keeps its scale sets.
export const RUNNER_GROUP_ENV = 'BACKMESH_RUNNER_GROUP';
// The listener's anycloud service token and the API it's for.
export const API_URL_ENV = 'ANYCLOUD_API_URL';
export const API_TOKEN_ENV = 'ANYCLOUD_API_TOKEN';
