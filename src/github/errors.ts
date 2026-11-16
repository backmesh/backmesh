import { z } from 'zod';

import { redact } from './retry.js';

// What a caller branches on. The Actions service names its refusals in the
// body's `typeName` (actions/scaleset `errors.go:200-279` at 258f2c7b):
// - `conflict`: a 409; on session create, another listener holds the
//   scale set's one session;
// - `job-still-running`: a 400 with `JobStillRunningException`, a runner
//   removal refused because the runner has a job (ARC checks both,
//   `ephemeralrunner_controller.go` at 0.13.0);
// - `runner-not-found`: `AgentNotFoundException`. A plain 404 isn't one: it
//   can come from a wrong URL as well as a removed runner.
export type ActionsErrorCode =
  'conflict' | 'job-still-running' | 'runner-not-found' | 'other';

export class ActionsServiceError extends Error {
  constructor(
    message: string,
    readonly code: ActionsErrorCode,
    readonly status: number,
    readonly activityId: string | undefined,
  ) {
    super(message);
    this.name = 'ActionsServiceError';
  }
}

export async function actionsError(
  method: string,
  url: string,
  response: Response,
): Promise<ActionsServiceError> {
  // text() decodes UTF-8 and drops the byte-order mark ARC trims by hand.
  const body = await response.text();
  const { typeName, message } = exception(body);
  const activityId = response.headers.get('activityid') ?? undefined;
  const text = `${method} ${redact(url)} failed (${response.status}${
    activityId ? `, activity ${activityId}` : ''
  }): ${[typeName, message ?? body].filter(Boolean).join(': ') || 'unknown error'}`;
  return new ActionsServiceError(
    text,
    errorCode(response.status, typeName ?? ''),
    response.status,
    activityId,
  );
}

// The service's `{ typeName, message }` body, when the error has one.
const exceptionSchema = z.object({
  typeName: z.string().nullish(),
  message: z.string().nullish(),
});

function exception(body: string): z.infer<typeof exceptionSchema> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {};
  }
  return exceptionSchema.safeParse(parsed).data ?? {};
}

function errorCode(status: number, typeName: string): ActionsErrorCode {
  if (status === 400 && typeName.includes('JobStillRunningException')) {
    return 'job-still-running';
  }
  if (typeName.includes('AgentNotFoundException')) return 'runner-not-found';
  if (status === 409) return 'conflict';
  return 'other';
}
