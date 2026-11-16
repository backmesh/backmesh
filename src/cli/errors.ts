// The CLI's exit rule: 0 when the command
// did what was asked, its status warnings included; 2 with `usage`, or a
// narrower code, when the invocation can't go ahead as given and needs
// another one or the user's action first; 1 (`failed`) when something
// outside it failed, such as a cloud, the API, GitHub or the network, and a
// retry may help. `--json` prints the code as `error.code`.
export class UsageError extends Error {
  readonly code: string = 'usage';
}

/** `--plan-id` names another plan than the one computed now. */
export class PlanChanged extends UsageError {
  override readonly code = 'plan_changed';
}

/** A change needs consent, and there's no terminal or `--plan-id`. */
export class NeedsPlan extends UsageError {
  override readonly code = 'needs_plan';
}
