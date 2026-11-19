// Our CI's hidden override: set only on anycloud's own
// CI installation, and absent from --help and the docs. Step 3 connects each
// cloud with `credentials new --generate` keys instead of a role. Everything
// else is the customer path. Install copies it into the org's Secret, so
// `status --json` reports it on any installation that sets it.
export const OVERRIDE_ENV = 'BACKMESH_UNSUPPORTED_CI_OVERRIDE';
const OVERRIDE_VALUE = 'anycloud-ci';
// The Secret's entry.
export const OVERRIDE = { [OVERRIDE_ENV]: OVERRIDE_VALUE };

export function readOverride(env: NodeJS.ProcessEnv) {
  const value = env[OVERRIDE_ENV];
  if (value === undefined || value === '') return undefined;
  if (value !== OVERRIDE_VALUE) {
    throw new Error(`${OVERRIDE_ENV} is set to an unknown value`);
  }
  return { env: OVERRIDE };
}
