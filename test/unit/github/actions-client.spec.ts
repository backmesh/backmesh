import { describe, expect, it } from 'vitest';

import { ActionsClient } from '../../../src/github/actions-client.js';
import type { Session } from '../../../src/github/types.js';
import {
  adminJwt,
  adminRoutes,
  empty,
  fakeGitHub,
  json,
  octokitFor,
  SERVICE,
  type Call,
} from './fake-github.js';

const SCALE_SETS = `${SERVICE}/_apis/runtime/runnerscalesets`;
const SESSIONS = `${SCALE_SETS}/7/sessions`;
const RUNNERS = `${SERVICE}/_apis/distributedtask/pools/0/agents`;
const QUEUE = 'https://broker.actions.example/message';
const SESSION_ID = '6c0d1b3e-0000-4000-8000-000000000001';
const REGISTRATION = 'https://api.github.com/actions/runner-registration';

const statistics = {
  totalAvailableJobs: 1,
  totalAcquiredJobs: 0,
  totalAssignedJobs: 3,
  totalRunningJobs: 2,
  totalRegisteredRunners: 2,
  totalBusyRunners: 2,
  totalIdleRunners: 0,
};

const sessionBody = (token: string) => ({
  sessionId: SESSION_ID,
  ownerName: 'backmesh',
  messageQueueUrl: QUEUE,
  messageQueueAccessToken: token,
  statistics,
});

const labels = [
  { name: 'backmesh-ubuntu-2404-4vcpu', type: 'System' },
  { name: 'backmesh-noretry', type: 'System' },
];
const scaleSet = {
  id: 7,
  name: 'backmesh-ubuntu-2404-4vcpu',
  runnerGroupId: 3,
  labels,
  RunnerSetting: { ephemeral: true, disableUpdate: true },
  statistics,
};
const parsedScaleSet = {
  id: 7,
  name: 'backmesh-ubuntu-2404-4vcpu',
  runnerGroupId: 3,
  labels: labels.map(({ name }) => ({ name })),
};
const listed = (...value: unknown[]) =>
  json(200, { count: value.length, value });

const job = {
  runnerRequestId: 1001,
  repositoryName: 'web',
  ownerName: 'acme',
  jobId: 'j1',
  jobDisplayName: 'test',
  jobWorkflowRef: 'acme/web/.github/workflows/ci.yml@refs/heads/main',
  workflowRunId: 555,
  eventName: 'pull_request',
  requestLabels: ['backmesh-ubuntu-2404-4vcpu'],
  // The service's .NET timestamps: 7 fractional digits, and DateTime.MinValue
  // for "not yet"; finishTime is left out.
  queueTime: '2026-11-05T12:00:00.1234567Z',
  scaleSetAssignTime: '2026-11-05T12:00:01.5Z',
  runnerAssignTime: '0001-01-01T00:00:00',
};
// Go's zero values for the fields only JobStarted and JobCompleted carry,
// and timestamps as epoch ms or null.
const parsedJob = {
  ...job,
  queueTime: Date.UTC(2026, 10, 5, 12, 0, 0, 123),
  scaleSetAssignTime: Date.UTC(2026, 10, 5, 12, 0, 1, 500),
  runnerAssignTime: null,
  finishTime: null,
  runnerId: 0,
  runnerName: '',
  result: '',
};
const ran = { result: 'succeeded', runnerId: 9, runnerName: 'bmabcde-04-x' };
const envelope = (messageType: string, body: unknown[], stats?: unknown) =>
  json(200, {
    messageId: 13,
    messageType,
    body: JSON.stringify(body),
    statistics: stats,
  });

const conflict = json(409, {
  typeName: 'TaskAgentSessionConflictException',
  message: 'The session for this scale set already exists.',
});
const exception = (status: number, typeName: string) =>
  json(status, { typeName: `GitHub.DistributedTask.WebApi.${typeName}` });

interface Seen {
  calls: Call[];
  waits: number[];
  logs: Record<string, unknown>[];
  session: Session;
}

interface Case {
  name: string;
  routes: Parameters<typeof fakeGitHub>[0];
  run: (
    actions: ActionsClient,
    session: Session,
    clock: { now: Date },
  ) => Promise<unknown>;
  result?: unknown;
  error?: Record<string, unknown>;
  check?: (seen: Seen) => void;
  exp?: number;
  signal?: AbortSignal;
}

const to = (calls: Call[], suffix: string) =>
  calls.filter((c) => c.url.pathname.endsWith(suffix));

let canceled = false;
const aborted = AbortSignal.abort();

const cancelable = (status: number) => () =>
  new Response(new ReadableStream({ cancel: () => void (canceled = true) }), {
    status,
  });

const cases: Case[] = [
  {
    name: 'exchanges a registration token for the service URL and admin token',
    routes: { [`GET ${SCALE_SETS}`]: listed(scaleSet) },
    run: (a) => a.getScaleSet(3, 'backmesh-ubuntu-2404-4vcpu'),
    result: parsedScaleSet,
    check: ({ calls: [registration, exchange, call] }) => {
      expect(registration?.headers.get('authorization')).toBe(
        'token ghs_installation',
      );
      expect(exchange?.headers.get('authorization')).toBe('RemoteAuth REG');
      expect(exchange?.body).toEqual({
        url: 'https://github.com/acme',
        runner_event: 'register',
      });
      expect(call?.url.searchParams.get('name')).toBe(
        'backmesh-ubuntu-2404-4vcpu',
      );
      expect(call?.url.searchParams.get('api-version')).toBe('6.0-preview');
      expect(call?.headers.get('authorization')).toBe(
        `Bearer ${adminJwt(4_102_444_800)}`,
      );
    },
  },
  {
    name: 'reconnects a minute before the admin token expires',
    exp: 600,
    routes: { [`GET ${SCALE_SETS}`]: listed(scaleSet) },
    run: async (a, _, clock) => {
      for (const ms of [0, 500_000, 541_000]) {
        clock.now = new Date(ms);
        await a.getScaleSet(3, 'backmesh-ubuntu-2404-4vcpu');
      }
    },
    check: ({ calls }) =>
      expect(to(calls, '/registration-token')).toHaveLength(2),
  },
  {
    name: 'retries the exchange while GitHub still refuses a new token',
    routes: {
      [`POST ${REGISTRATION}`]: [
        json(401, { message: 'Bad credentials' }),
        adminRoutes()[`POST ${REGISTRATION}`],
      ],
      [`GET ${SCALE_SETS}`]: listed(scaleSet),
    },
    run: (a) => a.getScaleSet(3, 'backmesh-ubuntu-2404-4vcpu'),
    result: parsedScaleSet,
    check: ({ calls, waits }) => {
      expect(to(calls, '/runner-registration')).toHaveLength(2);
      expect(waits).toEqual([1_000]);
    },
  },
  {
    name: 'stops retrying the exchange on abort',
    signal: aborted,
    routes: {
      [`POST ${REGISTRATION}`]: json(401, { message: 'Bad credentials' }),
    },
    run: (a) => a.getScaleSet(3, 'backmesh-ubuntu-2404-4vcpu'),
    error: { name: 'AbortError' },
    check: ({ waits }) => expect(waits).toEqual([]),
  },
  {
    name: 'creates an ephemeral scale set labelled with its name and the opt-out',
    routes: {
      [`GET ${SCALE_SETS}`]: listed(),
      [`POST ${SCALE_SETS}`]: json(200, scaleSet),
    },
    run: (a) => a.ensureScaleSet('backmesh-ubuntu-2404-4vcpu', 3),
    result: parsedScaleSet,
    check: ({ calls }) =>
      expect(calls.at(-1)?.body).toEqual({
        name: 'backmesh-ubuntu-2404-4vcpu',
        runnerGroupId: 3,
        labels,
        RunnerSetting: { ephemeral: true, disableUpdate: true },
      }),
  },
  {
    name: 'finds an existing scale set instead of creating one',
    routes: { [`GET ${SCALE_SETS}`]: listed(scaleSet) },
    run: (a) => a.ensureScaleSet('backmesh-ubuntu-2404-4vcpu', 3),
    result: parsedScaleSet,
    check: ({ calls }) =>
      expect(
        calls.some(
          (c) => c.method === 'POST' && c.url.href.startsWith(SCALE_SETS),
        ),
      ).toBe(false),
  },
  {
    name: 'replaces the scale set of a renamed label: a PATCH keeps its old labels',
    routes: {
      [`GET ${SCALE_SETS}`]: [
        listed(),
        listed({ ...scaleSet, name: 'backmesh-4' }),
      ],
      [`DELETE ${SCALE_SETS}/7`]: empty(204),
      [`POST ${SCALE_SETS}`]: json(200, scaleSet),
    },
    run: (a) => a.ensureScaleSet('backmesh-ubuntu-2404-4vcpu', 3, 'backmesh-4'),
    result: parsedScaleSet,
    check: ({ calls }) => {
      expect(calls.at(-3)?.url.searchParams.get('name')).toBe('backmesh-4');
      expect(calls.at(-2)?.method).toBe('DELETE');
      expect(calls.at(-1)?.body).toEqual({
        name: 'backmesh-ubuntu-2404-4vcpu',
        runnerGroupId: 3,
        labels,
        RunnerSetting: { ephemeral: true, disableUpdate: true },
      });
    },
  },
  {
    name: 'replaces a scale set renamed in place, which kept its old labels',
    routes: {
      [`GET ${SCALE_SETS}`]: listed({
        ...scaleSet,
        labels: [{ name: 'backmesh-4', type: 'System' }],
      }),
      [`DELETE ${SCALE_SETS}/7`]: empty(204),
      [`POST ${SCALE_SETS}`]: json(200, scaleSet),
    },
    run: (a) => a.ensureScaleSet('backmesh-ubuntu-2404-4vcpu', 3),
    result: parsedScaleSet,
    check: ({ calls }) =>
      expect(calls.slice(-2).map((c) => c.method)).toEqual(['DELETE', 'POST']),
  },
  {
    name: 'creates the scale set of a renamed label whose old one is gone',
    routes: {
      [`GET ${SCALE_SETS}`]: [listed(), listed()],
      [`POST ${SCALE_SETS}`]: json(200, scaleSet),
    },
    run: (a) => a.ensureScaleSet('backmesh-ubuntu-2404-4vcpu', 3, 'backmesh-4'),
    result: parsedScaleSet,
  },
  {
    name: 'treats a missing scale set as deleted',
    routes: { [`DELETE ${SCALE_SETS}/7`]: json(404, { typeName: 'NotFound' }) },
    run: (a) => a.deleteScaleSet(7),
  },
  {
    name: 'looks up the runner group by name',
    routes: {
      [`GET ${SERVICE}/_apis/runtime/runnergroups/`]: listed({
        id: 3,
        name: 'backmesh',
        isDefaultGroup: false,
      }),
    },
    run: (a) => a.getRunnerGroupByName('backmesh'),
    result: { id: 3, name: 'backmesh' },
  },
  {
    name: 'waits 30 s while another listener holds the session',
    routes: {
      [`POST ${SESSIONS}`]: [conflict, conflict, json(200, sessionBody('T1'))],
    },
    run: (a) => a.createSession(7, 'backmesh'),
    result: {
      scaleSetId: 7,
      sessionId: SESSION_ID,
      messageQueueUrl: QUEUE,
      messageQueueAccessToken: 'T1',
      statistics,
    },
    check: ({ calls, waits, logs }) => {
      expect(calls.at(-1)?.body).toEqual({ ownerName: 'backmesh' });
      expect(waits).toEqual([30_000, 30_000]);
      expect(logs).toHaveLength(2);
    },
  },
  {
    name: 'stops waiting for the session on abort',
    routes: { [`POST ${SESSIONS}`]: conflict },
    run: (a) => a.createSession(7, 'backmesh', aborted),
    error: { name: 'AbortError' },
    check: ({ waits }) => expect(waits).toEqual([]),
  },
  {
    name: 'gives up after 10 session conflicts',
    routes: { [`POST ${SESSIONS}`]: conflict },
    run: (a) => a.createSession(7, 'backmesh'),
    error: {
      code: 'conflict',
      message: expect.stringContaining('TaskAgentSessionConflictException'),
    },
    check: ({ waits }) => expect(waits).toHaveLength(9),
  },
  {
    name: "doesn't wait on other session errors",
    routes: { [`POST ${SESSIONS}`]: json(404, { typeName: 'NotFound' }) },
    run: (a) => a.createSession(7, 'backmesh'),
    error: { status: 404, code: 'other' },
    check: ({ waits }) => expect(waits).toEqual([]),
  },
  {
    name: 'deletes the session, or finds it gone',
    routes: {
      [`DELETE ${SESSIONS}/${SESSION_ID}`]: [
        empty(204),
        json(404, { typeName: 'NotFound' }),
      ],
    },
    run: async (a, session) => {
      await a.deleteSession(session);
      await a.deleteSession(session);
    },
  },
  {
    name: 'returns nothing when the long poll times out empty',
    routes: { [`GET ${QUEUE}`]: cancelable(202) },
    run: (a, session) => a.getMessage(session, 12, 500),
    check: ({ calls }) => {
      const poll = calls.at(-1);
      expect(poll?.url.searchParams.get('lastMessageId')).toBe('12');
      expect(poll?.headers.get('x-scalesetmaxcapacity')).toBe('500');
      expect(poll?.headers.get('authorization')).toBe('Bearer T1');
      expect(canceled).toBe(true);
    },
  },
  {
    name: 'parses a batch of job messages, defaulting missing fields',
    routes: {
      [`GET ${QUEUE}`]: envelope(
        'RunnerScaleSetJobMessages',
        [
          { messageType: 'JobAvailable', acquireJobUrl: 'https://x', ...job },
          { messageType: 'JobStarted', ...job },
          { messageType: 'JobCompleted', ...job, ...ran },
          { messageType: 'SomethingNew', ...job },
        ],
        statistics,
      ),
    },
    run: (a, session) => a.getMessage(session, 12, 500),
    result: {
      messageId: 13,
      statistics,
      jobs: [
        { messageType: 'JobAvailable', ...parsedJob },
        { messageType: 'JobStarted', ...parsedJob },
        { messageType: 'JobCompleted', ...parsedJob, ...ran },
      ],
    },
  },
  {
    name: 'reads null fields as Go does, as zero values',
    routes: {
      [`GET ${QUEUE}`]: () =>
        new Response(
          JSON.stringify({
            messageId: 13,
            messageType: 'RunnerScaleSetJobMessages',
            body: JSON.stringify([
              {
                messageType: 'JobAvailable',
                ...job,
                jobDisplayName: null,
                workflowRunId: null,
                eventName: null,
                runnerName: null,
                queueTime: null,
                // Malformed timestamps are null, not a failed batch.
                scaleSetAssignTime: 'not a time',
                finishTime: 1793880000,
              },
            ]),
            statistics: { ...statistics, totalAssignedJobs: null },
          }),
          { status: 200 },
        ),
    },
    run: (a, session) => a.getMessage(session, 12, 500),
    result: {
      messageId: 13,
      statistics: { ...statistics, totalAssignedJobs: 0 },
      jobs: [
        {
          messageType: 'JobAvailable',
          ...parsedJob,
          jobDisplayName: '',
          workflowRunId: 0,
          eventName: '',
          queueTime: null,
          scaleSetAssignTime: null,
        },
      ],
    },
  },
  {
    name: 'reads a null envelope body as no jobs',
    routes: {
      [`GET ${QUEUE}`]: json(200, {
        messageId: 13,
        messageType: 'RunnerScaleSetJobMessages',
        body: null,
      }),
    },
    run: (a, session) => a.getMessage(session, 12, 500),
    result: { messageId: 13, statistics: undefined, jobs: [] },
  },
  {
    name: 'reads a null list count and value as empty',
    routes: {
      [`POST ${SCALE_SETS}/7/acquirejobs`]: json(200, {
        count: null,
        value: null,
      }),
    },
    run: (a, session) => a.acquireJobs(session, [1001]),
    result: [],
  },
  {
    name: 'returns a message of unknown type with no jobs, to be acked',
    routes: { [`GET ${QUEUE}`]: envelope('SomethingElse', [job]) },
    run: (a, session) => a.getMessage(session, 12, 500),
    result: { messageId: 13, statistics: undefined, jobs: [] },
    check: ({ logs }) =>
      expect(logs).toEqual([
        expect.objectContaining({ messageType: 'SomethingElse' }),
      ]),
  },
  {
    name: 'renews the queue token once and retries',
    routes: {
      [`PATCH ${SESSIONS}/${SESSION_ID}`]: json(200, sessionBody('T2')),
      [`GET ${QUEUE}`]: [
        () => new Response('expired', { status: 401 }),
        empty(202),
      ],
    },
    run: (a, session) => a.getMessage(session, 0, 500),
    check: ({ calls, session }) => {
      const polls = calls.filter((c) => c.url.href.startsWith(QUEUE));
      expect(polls.map((c) => c.headers.get('authorization'))).toEqual([
        'Bearer T1',
        'Bearer T2',
      ]);
      expect(session.messageQueueAccessToken).toBe('T2');
    },
  },
  {
    name: 'retries at the queue URL the renewed session names',
    routes: {
      [`PATCH ${SESSIONS}/${SESSION_ID}`]: json(200, {
        ...sessionBody('T2'),
        messageQueueUrl: `${QUEUE}2`,
      }),
      [`GET ${QUEUE}`]: () => new Response('expired', { status: 401 }),
      [`GET ${QUEUE}2`]: empty(202),
      [`DELETE ${QUEUE}/13`]: () => new Response('expired', { status: 401 }),
      [`DELETE ${QUEUE}2/13`]: empty(204),
    },
    run: async (a, session) => {
      await a.getMessage(session, 12, 500);
      session.messageQueueUrl = QUEUE;
      await a.deleteMessage(session, 13);
    },
    check: ({ calls }) =>
      expect(
        calls
          .filter((c) => c.url.href.startsWith(`${QUEUE}2`))
          .map((c) => c.url.href),
      ).toEqual([`${QUEUE}2?lastMessageId=12`, `${QUEUE}2/13`]),
  },
  {
    name: 'fails when the renewed queue token is refused too',
    routes: {
      [`PATCH ${SESSIONS}/${SESSION_ID}`]: json(200, sessionBody('T2')),
      [`GET ${QUEUE}`]: () => new Response('expired', { status: 401 }),
    },
    run: (a, session) => a.getMessage(session, 0, 500),
    error: { status: 401 },
  },
  {
    name: 'acks a message by deleting it',
    routes: { [`DELETE ${QUEUE}/13`]: empty(204) },
    run: (a, session) => a.deleteMessage(session, 13),
    check: ({ calls }) =>
      expect(calls.at(-1)?.headers.get('authorization')).toBe('Bearer T1'),
  },
  {
    name: 'acquires jobs with the queue token',
    routes: { [`POST ${SCALE_SETS}/7/acquirejobs`]: listed(1001) },
    run: (a, session) => a.acquireJobs(session, [1001, 1002]),
    result: [1001],
    check: ({ calls }) => {
      const call = calls.at(-1);
      expect(call?.body).toEqual([1001, 1002]);
      expect(call?.headers.get('authorization')).toBe('Bearer T1');
      expect(call?.url.searchParams.get('api-version')).toBe('6.0-preview');
    },
  },
  {
    name: 'acquires nothing without a call',
    routes: {},
    run: (a, session) => a.acquireJobs(session, []),
    result: [],
    check: ({ calls }) => expect(calls).toEqual([]),
  },
  {
    name: 'fails on a success without the expected body',
    routes: { [`POST ${SCALE_SETS}/7/acquirejobs`]: empty(204) },
    run: (a, session) => a.acquireJobs(session, [1001]),
    error: { status: 204 },
  },
  {
    name: 'mints a JIT config for a named runner',
    routes: {
      [`POST ${SCALE_SETS}/7/generatejitconfig`]: json(200, {
        runner: { id: 9, name: 'bmabcde-04-x', runnerScaleSetId: 7 },
        encodedJITConfig: 'ENCODED',
      }),
    },
    run: (a) => a.generateJitConfig(7, 'bmabcde-04-x'),
    result: {
      runner: { id: 9, name: 'bmabcde-04-x', runnerScaleSetId: 7 },
      encodedJitConfig: 'ENCODED',
    },
    check: ({ calls }) =>
      expect(calls.at(-1)?.body).toEqual({
        name: 'bmabcde-04-x',
        workFolder: '_work',
      }),
  },
  {
    name: 'finds a runner by name',
    routes: {
      [`GET ${RUNNERS}`]: listed({ id: 9, name: 'bmabcde-04-x' }),
    },
    run: (a) => a.getRunnerByName('bmabcde-04-x'),
    result: { id: 9, name: 'bmabcde-04-x', runnerScaleSetId: 0 },
  },
  {
    name: 'removes an idle runner',
    routes: { [`DELETE ${RUNNERS}/9`]: empty(204) },
    run: (a) => a.removeRunner(9),
    result: 'removed',
  },
  {
    name: 'reports a runner with a job as busy',
    routes: {
      [`DELETE ${RUNNERS}/9`]: exception(400, 'JobStillRunningException'),
    },
    run: (a) => a.removeRunner(9),
    result: 'busy',
  },
  {
    name: 'reads a busy runner whose exception has a null message',
    routes: {
      [`DELETE ${RUNNERS}/9`]: json(400, {
        typeName: 'GitHub.DistributedTask.WebApi.JobStillRunningException',
        message: null,
      }),
    },
    run: (a) => a.removeRunner(9),
    result: 'busy',
  },
  {
    name: 'needs a 400 to read JobStillRunningException as busy',
    routes: {
      [`DELETE ${RUNNERS}/9`]: exception(500, 'JobStillRunningException'),
    },
    run: (a) => a.removeRunner(9),
    error: { status: 500, code: 'other' },
  },
  {
    name: 'counts a runner GitHub already removed as removed',
    routes: {
      [`DELETE ${RUNNERS}/9`]: exception(404, 'AgentNotFoundException'),
    },
    run: (a) => a.removeRunner(9),
    result: 'removed',
  },
  {
    name: 'throws other removal failures, a plain 404 among them',
    routes: { [`DELETE ${RUNNERS}/9`]: empty(404) },
    run: (a) => a.removeRunner(9),
    error: { status: 404, code: 'other' },
  },
];

describe('ActionsClient', () => {
  it.each(cases)('$name', async (c) => {
    canceled = false;
    const github = fakeGitHub({ ...adminRoutes(c.exp), ...c.routes });
    const clock = { now: new Date(0) };
    const seen: Seen = {
      calls: github.calls,
      waits: [],
      logs: [],
      session: { ...sessionBody('T1'), scaleSetId: 7, statistics: undefined },
    };
    const actions = new ActionsClient({
      org: 'acme',
      octokit: octokitFor(github.fetch),
      fetch: github.fetch,
      now: () => clock.now,
      sleep: async (ms, signal) => {
        signal?.throwIfAborted();
        seen.waits.push(ms);
      },
      signal: c.signal,
      log: (entry) => void seen.logs.push(entry),
    });
    const outcome = c.run(actions, seen.session, clock);
    if (c.error) await expect(outcome).rejects.toMatchObject(c.error);
    else expect(await outcome).toEqual(c.result);
    c.check?.(seen);
  });
});
