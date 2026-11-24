import { z } from 'zod';

// Wire shapes of the Actions service's scale-set API, after actions/scaleset
// `types.go` at 258f2c7b (ARC's client before it moved there:
// actions-runner-controller `github/actions/types.go` at
// gha-runner-scale-set-0.13.0). Go decodes a missing or `null` field as its
// zero value, so counts and job fields default the same way here.

const count = z
  .number()
  .int()
  .nullish()
  .transform((v) => v ?? 0);
const text = z
  .string()
  .nullish()
  .transform((v) => v ?? '');
// A job timestamp, as epoch ms. Missing, null or .NET's DateTime.MinValue
// (`0001-01-01T00:00:00`) is "not yet", null; nothing is guessed in its place.
// Anything else unparseable is null too, so it can't fail the batch and
// stall scaling.
const time = z
  .unknown()
  .optional()
  .transform((v) => {
    const ms = typeof v === 'string' ? Date.parse(v) : NaN;
    return ms > 0 ? ms : null;
  });

export const statisticsSchema = z.object({
  totalAvailableJobs: count,
  totalAcquiredJobs: count,
  // Every job assigned to the scale set, waiting or running
  // (actions/scaleset `README.md:42`): the listener's desired count.
  totalAssignedJobs: count,
  totalRunningJobs: count,
  totalRegisteredRunners: count,
  totalBusyRunners: count,
  totalIdleRunners: count,
});
export type Statistics = z.infer<typeof statisticsSchema>;

export const runnerGroupSchema = z.object({
  id: z.number().int(),
  name: z.string(),
});
export type RunnerGroup = z.infer<typeof runnerGroupSchema>;

export const scaleSetSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  runnerGroupId: z.number().int(),
  labels: z.array(z.object({ name: z.string() })).nullish(),
});
export type ScaleSet = z.infer<typeof scaleSetSchema>;

export const sessionSchema = z.object({
  sessionId: z.string(),
  messageQueueUrl: z.string(),
  messageQueueAccessToken: z.string(),
  statistics: statisticsSchema.nullish(),
});
// The client keeps the scale set's ID with its session, to renew the queue
// token.
export type Session = z.infer<typeof sessionSchema> & { scaleSetId: number };

export const JOB_KINDS = [
  'JobAvailable',
  'JobAssigned',
  'JobStarted',
  'JobCompleted',
] as const;

// One shape for the four kinds: only JobStarted and JobCompleted carry the
// runner, and only JobCompleted the result. Every kind carries the
// timestamps known so far (`JobMessageBase`).
export const jobMessageSchema = z.object({
  messageType: z.enum(JOB_KINDS),
  runnerRequestId: count,
  repositoryName: text,
  ownerName: text,
  jobId: text,
  jobDisplayName: text,
  // Such as `acme/web/.github/workflows/ci.yml@refs/heads/main`.
  jobWorkflowRef: text,
  workflowRunId: count,
  // Such as `pull_request`: ARC's `event_name` label.
  eventName: text,
  requestLabels: z.array(z.string()).nullish(),
  queueTime: time,
  scaleSetAssignTime: time,
  runnerAssignTime: time,
  finishTime: time,
  runnerId: count,
  runnerName: text,
  result: text,
});
export type JobMessage = z.infer<typeof jobMessageSchema>;

// The queue's envelope: `body` is a JSON string holding the batch of job
// messages (actions/scaleset `client.go:662-722`).
export const messageEnvelopeSchema = z.object({
  messageId: z.number().int(),
  messageType: z.string(),
  body: text,
  statistics: statisticsSchema.nullish(),
});

export interface Message {
  messageId: number;
  statistics: Statistics | undefined;
  jobs: JobMessage[];
}

export const runnerSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  runnerScaleSetId: count,
});
export type Runner = z.infer<typeof runnerSchema>;

export const jitConfigSchema = z.object({
  runner: runnerSchema,
  encodedJITConfig: z.string(),
});

export const listOf = <T extends z.ZodType>(item: T) =>
  z.object({
    count,
    value: z
      .array(item)
      .nullish()
      .transform((v) => v ?? []),
  });
