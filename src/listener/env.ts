// The names of the listener's settings that install and upgrade write to its
// VM (`cli/listener-vm.ts`), beside ORG, ORG_ID and the ones their own
// modules name.

// The listener's own image, so the VM's start and every roll read it from
// the same place.
export const LISTENER_IMAGE_ENV = 'BACKMESH_LISTENER_IMAGE';
// The org's runner group (`runnerGroupName`), fixed at install so a VM
// `upgrade` creates again, or one moved from a Deployment, keeps its scale
// sets.
export const RUNNER_GROUP_ENV = 'BACKMESH_RUNNER_GROUP';
// Set while `upgrade` moves a listener off `bm-control`: the new one checks
// its settings and token, answers `/status` and takes no jobs until it's
// restarted without it, so the old one can run until then.
export const STANDBY_ENV = 'BACKMESH_STANDBY';
// The listener's anycloud service token and the API it's for.
export const API_URL_ENV = 'ANYCLOUD_API_URL';
export const API_TOKEN_ENV = 'ANYCLOUD_API_TOKEN';
