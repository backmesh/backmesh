import { describe, expect, it } from 'vitest';

import type { Message, Session } from '../../../src/github/types.js';
import {
  listenerRunnerGroup,
  runListener,
} from '../../../src/listener/listener.js';
import { fakeGitHub, json, octokitFor } from '../github/fake-github.js';
import { assigned, ROUTE, setup } from './fakes.js';

const GROUPS = 'https://api.github.com/orgs/acme/actions/runner-groups';

describe('runListener', () => {
  it('logs the scale set and session, acquires offered jobs, reconciles and acks', async () => {
    const { anycloud, scaler } = setup([]);
    const shutdown = new AbortController();
    const calls: string[] = [];
    const reconcile = scaler.reconcile.bind(scaler);
    scaler.reconcile = () => (calls.push('reconcile'), reconcile());
    const logs: unknown[] = [];
    const session: Session = {
      scaleSetId: 9,
      sessionId: 's',
      messageQueueUrl: 'https://queue.example',
      messageQueueAccessToken: 't',
      statistics: assigned(0),
    };
    const messages: Message[] = [
      {
        messageId: 1,
        statistics: assigned(2),
        jobs: (['JobAvailable', 'JobAvailable', 'JobAssigned'] as const).map(
          (messageType, i) => ({
            messageType,
            runnerRequestId: i + 10,
            repositoryName: 'app',
            ownerName: 'acme',
            jobId: `job-${i}`,
            jobDisplayName: '',
            jobWorkflowRef: '',
            workflowRunId: 7,
            eventName: 'push',
            requestLabels: null,
            queueTime: null,
            scaleSetAssignTime: null,
            runnerAssignTime: null,
            finishTime: null,
            runnerId: 0,
            runnerName: '',
            result: '',
          }),
        ),
      },
    ];

    await runListener(
      {
        actions: {
          ensureScaleSet: async (name, runnerGroupId) => ({
            id: 9,
            name,
            runnerGroupId,
          }),
          createSession: async () => session,
          deleteSession: async () => void calls.push('delete session'),
          getMessage: async (_session, last) => {
            calls.push(`poll after ${last}`);
            // The session's first reconcile is done by the message.
            await new Promise((resolve) => setTimeout(resolve, 10));
            const next = messages.shift();
            if (!next) shutdown.abort();
            return next;
          },
          acquireJobs: async (_session, ids) => {
            calls.push(`acquire ${ids.join(',')}`);
            return ids;
          },
          deleteMessage: async (_session, id) => void calls.push(`ack ${id}`),
          // Every label's scale set exists, so a start that looked one up
          // to delete it would show in `calls`.
          getScaleSet: async (groupId, label) => ({
            id: 7,
            name: label,
            runnerGroupId: groupId,
          }),
          deleteScaleSet: async (id) =>
            void calls.push(`delete scale set ${id}`),
        },
        runnerGroup: async () => 3,
        scaler,
        // Hears each job before the scaler counts it.
        gate: {
          observe: (route, job) =>
            void calls.push(`gate ${route.label} ${job.jobId}`),
        },
        routes: [ROUTE],
        owner: 'pod',
        log: (line) => void logs.push(line),
      },
      shutdown.signal,
    );

    expect(logs).toEqual([
      {
        msg: 'scale set ready',
        scaleSetId: 9,
        name: 'backmesh-ubuntu-2404-4vcpu',
        runnerGroupId: 3,
      },
      {
        msg: 'session opened',
        label: 'backmesh-ubuntu-2404-4vcpu',
        scaleSetId: 9,
      },
    ]);
    // The message's runners don't wait for its ack.
    expect(calls).toEqual([
      'reconcile',
      'poll after 0',
      'acquire 10,11',
      'gate backmesh-ubuntu-2404-4vcpu job-0',
      'gate backmesh-ubuntu-2404-4vcpu job-1',
      'gate backmesh-ubuntu-2404-4vcpu job-2',
      'reconcile',
      'ack 1',
      'poll after 1',
      'delete session',
    ]);
    expect(anycloud.submitted).toHaveLength(2);
  });

  it('drains a retiring scale set, takes no job on it, then deletes it', async () => {
    const retiring = { ...ROUTE, retiring: true };
    const { scaler } = setup([retiring]);
    const shutdown = new AbortController();
    const calls: string[] = [];
    const logs: unknown[] = [];
    // One job still runs when the session opens, and another is assigned
    // and not started: the scale set stays until GitHub counts neither.
    const busy = { ...assigned(2), totalRunningJobs: 1, totalBusyRunners: 1 };
    const messages: Message[] = [
      { messageId: 1, statistics: assigned(1), jobs: [] },
      { messageId: 2, statistics: assigned(0), jobs: [] },
    ];
    await runListener(
      {
        actions: {
          ensureScaleSet: async () => {
            throw new Error('a retiring scale set is never created');
          },
          createSession: async () => ({
            scaleSetId: 9,
            sessionId: 's',
            messageQueueUrl: 'https://queue.example',
            messageQueueAccessToken: 't',
            statistics: busy,
          }),
          deleteSession: async () => void calls.push('delete session'),
          getMessage: async (_session, last, capacity) => {
            calls.push(`poll after ${last} at capacity ${capacity}`);
            const next = messages.shift();
            if (!next) shutdown.abort();
            return next;
          },
          acquireJobs: async (_session, ids) => {
            calls.push(`acquire ${ids.join(',')}`);
            return ids;
          },
          deleteMessage: async (_session, id) => void calls.push(`ack ${id}`),
          getScaleSet: async (groupId, label) => ({
            id: 9,
            name: label,
            runnerGroupId: groupId,
          }),
          deleteScaleSet: async (id) =>
            void calls.push(`delete scale set ${id}`),
        },
        runnerGroup: async () => 3,
        scaler,
        routes: [retiring],
        owner: 'pod',
        log: (line) => void logs.push(line),
      },
      shutdown.signal,
    );
    expect(calls).toEqual([
      'poll after 0 at capacity 0',
      // Nothing offered is taken.
      'acquire ',
      'ack 1',
      'poll after 1 at capacity 0',
      'acquire ',
      'ack 2',
      'delete scale set 9',
      'delete session',
    ]);
    expect(logs).toContainEqual({
      msg: 'scale set retired',
      label: 'backmesh-ubuntu-2404-4vcpu',
      scaleSetId: 9,
    });
    expect(scaler.status().scaleSets).toEqual([]);
  });

  it('skips a retiring scale set already deleted, and never creates it', async () => {
    const retiring = { ...ROUTE, retiring: true };
    const { scaler } = setup([retiring]);
    const logs: unknown[] = [];
    await runListener(
      {
        actions: {
          ensureScaleSet: async () => {
            throw new Error('a retiring scale set is never created');
          },
          createSession: async () => {
            throw new Error('no session for a deleted scale set');
          },
          deleteSession: async () => {},
          getMessage: async () => undefined,
          acquireJobs: async () => [],
          deleteMessage: async () => {},
          getScaleSet: async () => undefined,
          deleteScaleSet: async () => {},
        },
        runnerGroup: async () => 3,
        scaler,
        routes: [retiring],
        owner: 'pod',
        log: (line) => void logs.push(line),
      },
      new AbortController().signal,
    );
    expect(logs).toEqual([
      { msg: 'retired scale set gone', label: 'backmesh-ubuntu-2404-4vcpu' },
    ]);
  });

  it("passes a renamed label's old one to ensureScaleSet", async () => {
    const renamed = { ...ROUTE, renamedFrom: 'backmesh-4' };
    const { scaler } = setup([renamed]);
    const shutdown = new AbortController();
    const asked: unknown[] = [];
    await runListener(
      {
        actions: {
          ensureScaleSet: async (name, runnerGroupId, renamedFrom) => {
            asked.push([name, runnerGroupId, renamedFrom]);
            return { id: 7, name, runnerGroupId };
          },
          createSession: async () => {
            shutdown.abort();
            throw new Error('shut down');
          },
          deleteSession: async () => {},
          getMessage: async () => undefined,
          acquireJobs: async () => [],
          deleteMessage: async () => {},
          getScaleSet: async () => undefined,
          deleteScaleSet: async () => {},
        },
        runnerGroup: async () => 3,
        scaler,
        routes: [renamed],
        owner: 'pod',
        log: () => {},
      },
      shutdown.signal,
    );
    expect(asked).toEqual([['backmesh-ubuntu-2404-4vcpu', 3, 'backmesh-4']]);
  });

  it('reconciles again at once after a tick that submitted its limit', async () => {
    const { anycloud, scaler } = setup([]);
    const shutdown = new AbortController();
    const session: Session = {
      scaleSetId: 9,
      sessionId: 's',
      messageQueueUrl: 'https://queue.example',
      messageQueueAccessToken: 't',
      statistics: assigned(120),
    };
    let ticks = 0;
    const reconcile = scaler.reconcile.bind(scaler);
    scaler.reconcile = async () => (ticks++, reconcile());

    await runListener(
      {
        actions: {
          ensureScaleSet: async (name, runnerGroupId) => ({
            id: 9,
            name,
            runnerGroupId,
          }),
          createSession: async () => session,
          deleteSession: async () => undefined,
          // No message: only the session's statistics start the ticks, and
          // the 50-second timer never fires within the test.
          getMessage: async () => {
            for (let i = 0; i < 100 && anycloud.submitted.length < 120; i++) {
              await new Promise((resolve) => setImmediate(resolve));
            }
            shutdown.abort();
            return undefined;
          },
          acquireJobs: async (_session, ids) => ids,
          deleteMessage: async () => undefined,
          getScaleSet: async () => undefined,
          deleteScaleSet: async () => undefined,
        },
        runnerGroup: async () => 3,
        scaler,
        routes: [ROUTE],
        owner: 'pod',
        log: () => undefined,
      },
      shutdown.signal,
    );

    expect(anycloud.submitted).toHaveLength(120);
    expect(ticks).toBe(3);
  });

  it("reconciles at the planner's next slot start or expiry", async () => {
    const { scaler } = setup([]);
    const shutdown = new AbortController();
    let ticks = 0;
    const reconcile = scaler.reconcile.bind(scaler);
    scaler.reconcile = async () => (ticks++, reconcile());
    // Two slot changes, 5 ms apart, then none.
    const due = [5, 5];
    scaler.nextDue = () => due.shift();

    await runListener(
      {
        actions: {
          ensureScaleSet: async (name, runnerGroupId) => ({
            id: 9,
            name,
            runnerGroupId,
          }),
          createSession: async () => ({
            scaleSetId: 9,
            sessionId: 's',
            messageQueueUrl: 'https://queue.example',
            messageQueueAccessToken: 't',
            statistics: assigned(0),
          }),
          deleteSession: async () => undefined,
          getMessage: async () => {
            await new Promise((resolve) => setTimeout(resolve, 100));
            shutdown.abort();
            return undefined;
          },
          acquireJobs: async (_session, ids) => ids,
          deleteMessage: async () => undefined,
          getScaleSet: async () => undefined,
          deleteScaleSet: async () => undefined,
        },
        runnerGroup: async () => 3,
        scaler,
        routes: [ROUTE],
        owner: 'pod',
        log: () => undefined,
        // A cue between messages, 50 ms in.
        reconciler: (fn) => void setTimeout(fn, 50),
      },
      shutdown.signal,
    );

    // The session's reconcile, one per due time, and the cue's.
    expect(ticks).toBe(4);
  });

  it('retries the runner group without exiting, then opens sessions', async () => {
    const { scaler } = setup([]);
    const shutdown = new AbortController();
    const waits: number[] = [];
    const groups = [new Error('403'), new Error('502'), 3];
    const groupIds: number[] = [];

    await runListener(
      {
        actions: {
          ensureScaleSet: async (name, runnerGroupId) => {
            groupIds.push(runnerGroupId);
            return { id: 9, name, runnerGroupId };
          },
          createSession: async () => {
            shutdown.abort();
            throw new Error('aborted');
          },
          deleteSession: async () => undefined,
          getMessage: async () => undefined,
          acquireJobs: async () => [],
          deleteMessage: async () => undefined,
          getScaleSet: async () => undefined,
          deleteScaleSet: async () => undefined,
        },
        runnerGroup: async () => {
          const next = groups.shift();
          if (next instanceof Error) throw next;
          return next!;
        },
        scaler,
        routes: [ROUTE],
        owner: 'pod',
        log: () => undefined,
        sleep: async (ms) => void waits.push(ms),
      },
      shutdown.signal,
    );

    expect(waits).toEqual([10_000, 20_000]);
    expect(groupIds).toEqual([3]);
    expect(scaler.sets.get('a4')?.scaleSetId).toBe(9);
  });
});

describe('listenerRunnerGroup', () => {
  const name = 'backmesh-0a1b2-k3j9x0';
  const looked: string[] = [];
  const actions = {
    getRunnerGroupByName: async (group: string) => {
      looked.push(group);
      return { id: 30, name: group };
    },
  };

  it('creates the group on a fresh org with public repositories off', async () => {
    const github = fakeGitHub({
      [`GET ${GROUPS}`]: json(200, { total_count: 0, runner_groups: [] }),
      [`POST ${GROUPS}`]: json(201, { id: 3, name }),
    });
    const id = await listenerRunnerGroup(
      octokitFor(github.fetch),
      'acme',
      name,
      actions,
      false,
    );
    expect(id).toBe(30);
    expect(looked.at(-1)).toBe(name);
    expect(github.calls.at(-1)).toMatchObject({
      method: 'POST',
      body: {
        name,
        visibility: 'all',
        allows_public_repositories: false,
      },
    });
  });

  it('turns public repositories off again on each start', async () => {
    const github = fakeGitHub({
      [`GET ${GROUPS}`]: json(200, {
        total_count: 1,
        runner_groups: [{ id: 3, name, allows_public_repositories: true }],
      }),
      [`PATCH ${GROUPS}/3`]: json(200, { id: 3, name }),
    });
    await listenerRunnerGroup(
      octokitFor(github.fetch),
      'acme',
      name,
      actions,
      false,
    );
    expect(github.calls.at(-1)).toMatchObject({
      method: 'PATCH',
      body: { allows_public_repositories: false },
    });
  });
});
